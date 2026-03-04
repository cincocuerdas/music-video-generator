#!/usr/bin/env python3
"""
Render Video Script
Downloads generated images and creates a video using FFmpeg.
Adds transitions, Ken Burns effect, and syncs with audio if available.
"""
import sys
import json
import os
import subprocess
import time
import urllib.request
import tempfile
import shutil
from dotenv import load_dotenv
from result_json import emit_result as shared_emit_result
from env_utils import parse_positive_int_env
from db_utils import get_db_connection
from ffmpeg_utils import resolve_ffmpeg_path
from runtime_config import build_placeholder_image_url, is_placeholder_url

# Load configuration
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)

# Output directories
OUTPUT_DIR = os.path.join(root_dir, 'output')
VIDEOS_DIR = os.path.join(OUTPUT_DIR, 'videos')
TEMP_DIR = os.path.join(OUTPUT_DIR, 'temp')

# FFmpeg path - shared resolver
FFMPEG_PATH = resolve_ffmpeg_path(root_dir)
RENDER_VIDEO_STAGE_TIMEOUT_SEC = parse_positive_int_env("RENDER_VIDEO_STAGE_TIMEOUT_SEC", 1800)


def emit_result(payload):
    return shared_emit_result(payload, default_error_code="render_video")


def ensure_stage_deadline(deadline_ts: float | None, phase: str) -> None:
    if deadline_ts is None:
        return
    if time.time() > deadline_ts:
        raise TimeoutError(f"render timeout during {phase}")

def get_project_data(project_id: str) -> dict:
    """Fetch project data including analysis result with images"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''SELECT id, title, "analysisResult", "audioUrl", "aspectRatio", "thumbnailUrl"
               FROM "Project" WHERE id = %s''',
            (project_id,)
        )
        row = cur.fetchone()
        if not row:
            raise Exception(f"Project {project_id} not found")

        analysis = row[2] if row[2] else {}
        if isinstance(analysis, str):
            analysis = json.loads(analysis)

        return {
            "id": row[0],
            "title": row[1],
            "analysis": analysis,
            "audioUrl": row[3],
            "aspectRatio": row[4] or "16:9",
            "thumbnailUrl": row[5]
        }
    finally:
        conn.close()

def save_video_url(project_id: str, video_url: str):
    """Save video URL to database"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''UPDATE "Project" SET "videoUrl" = %s WHERE id = %s''',
            (video_url, project_id)
        )
        conn.commit()
    finally:
        conn.close()

def safe_save_video_url(project_id: str, video_url: str) -> str:
    """Best-effort DB save. Returns warning text on failure."""
    try:
        save_video_url(project_id, video_url)
        return ""
    except Exception as e:
        return str(e)

def build_safe_render_result(
    project_id: str,
    mode: str = "mock",
    degraded: bool = True,
    useful_output: bool = False,
    message: str = "",
    output_path: str = "",
    duration: float = 0,
    resolution: str = "1920x1080",
    frames_used: int = 0,
    file_size: int = 0,
    warning: str = "",
    error_code: str = "",
    degraded_reasons=None,
) -> dict:
    output_filename = f"{project_id}.mp4" if project_id else "fallback.mp4"
    video_url = f"/output/videos/{output_filename}"
    if not useful_output:
        status = "failed"
    else:
        status = "degraded" if degraded else "success"
    result = {
        "status": status,
        "success": status != "failed",
        "mode": mode,
        "degraded": degraded,
        "degradedReasons": degraded_reasons if isinstance(degraded_reasons, list) else ([] if not degraded else ([error_code] if error_code else [])),
        "message": message,
        "videoUrl": video_url,
        "outputPath": output_path or "(fallback/no-file)",
        "duration": duration,
        "resolution": resolution,
        "fileSize": file_size,
        "framesUsed": frames_used,
    }
    if status == "failed":
        result["errorCode"] = error_code or "render_video.failed"
    if warning:
        result["warning"] = warning
    return result
def get_local_path(url_or_path: str) -> str:
    """Resolve a URL or path to a local filesystem path"""
    if not url_or_path:
        return None
        
    # Check if it's already a local absolute path
    if os.path.isabs(url_or_path) or url_or_path.startswith('C:') or url_or_path.startswith('c:'):
        return url_or_path
        
    # Check for relative web path
    if url_or_path.startswith('/output/'):
        # Convert web path to filesystem path
        return os.path.join(root_dir, url_or_path.lstrip('/').replace('/', os.sep))
        
    # Assume it might be relative to root
    return os.path.join(root_dir, url_or_path.lstrip('/').replace('/', os.sep))

def get_image_files(project_id):
    """
    Finds generated images for a specific project in the output cache.
    Returns a dictionary mapping scene_index -> local_path.
    """
    # Use root_dir established at top of script
    cache_dir = os.path.join(root_dir, "output", "images", "cache")
    
    if not os.path.exists(cache_dir):
        print(f"⚠️ Cache directory not found: {cache_dir}", file=sys.stderr)
        return {}

    mapping = {}
    prefix = f"project_{project_id}_scene_"
    
    for f in os.listdir(cache_dir):
        if f.startswith(prefix) and f.endswith(".png"):
            try:
                # project_ID_scene_INDEX.png -> INDEX
                scene_idx = int(f.replace(prefix, "").replace(".png", ""))
                mapping[scene_idx] = os.path.join(cache_dir, f)
            except (ValueError, IndexError):
                continue
    
    if mapping:
        print(f"🔍 Found {len(mapping)} images in cache for project {project_id}", file=sys.stderr)
    return mapping

def download_image(url_or_path: str, output_path: str, use_ffmpeg: bool = True, max_retries: int = 3) -> bool:
    """Download image from URL or copy from local path to output location"""
    try:
        # Resolve local path
        local_src = get_local_path(url_or_path)
        
        if local_src and os.path.exists(local_src):
            shutil.copy2(local_src, output_path)
            return True
        elif local_src and not url_or_path.startswith('http'):
            print(f"Warning: Local file not found: {local_src}", file=sys.stderr)
            return False

        url = url_or_path

        # Handle placeholder URLs
        if is_placeholder_url(url):
            if use_ffmpeg:
                # Create a simple placeholder using FFmpeg
                subprocess.run([
                    FFMPEG_PATH, '-y', '-f', 'lavfi',
                    '-i', 'color=c=0x1a1a2e:s=1920x1080:d=1',
                    '-frames:v', '1',
                    output_path
                ], capture_output=True, check=True)
                return True
            else:
                # In mock mode, just return True (no actual file needed)
                return True

        # Download real image with retries
        timeout = 60  # Images should already be generated/cached

        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                })
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    with open(output_path, 'wb') as f:
                        f.write(response.read())
                return True
            except Exception as e:
                if attempt < max_retries - 1:
                    print(f"Retry {attempt + 1}/{max_retries} for {url[:80]}...", file=sys.stderr)
                    import time
                    time.sleep(2)
                else:
                    raise e

        return False
    except Exception as e:
        print(f"Warning: Failed to get image {str(url_or_path)[:100]}...: {e}", file=sys.stderr)
        return False

def check_ffmpeg() -> bool:
    """Check if FFmpeg is available"""
    try:
        result = subprocess.run([FFMPEG_PATH, '-version'], capture_output=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False

def get_aspect_dimensions(aspect_ratio: str) -> tuple:
    """Get width and height from aspect ratio"""
    ratios = {
        "16:9": (1920, 1080),
        "9:16": (1080, 1920),
        "1:1": (1080, 1080),
        "4:3": (1440, 1080),
    }
    return ratios.get(aspect_ratio, (1920, 1080))

def read_unexposed_fallback_threshold() -> float:
    """Read ratio threshold to relax exposed=false filtering when too many frames are blocked."""
    raw_value = os.getenv("RENDER_UNEXPOSED_FALLBACK_THRESHOLD", "0.4")
    try:
        threshold = float(raw_value)
    except (TypeError, ValueError):
        threshold = 0.4
    return max(0.0, min(1.0, threshold))

def render_video(project_id: str, song_path: str = None, analysis_data: dict = None):
    """
    Main function to render video from generated images.

    Args:
        project_id: Project ID for output naming and DB lookup
        song_path: Optional path to audio file (overrides DB audioUrl)
        analysis_data: Optional analysis dict (overrides DB analysisResult)

    Supports two modes:
        1. DB Mode: Only project_id, fetches everything from database
        2. Manual Mode: project_id + song_path + analysis_data for testing
    """
    stage_deadline = (
        time.time() + RENDER_VIDEO_STAGE_TIMEOUT_SEC
        if RENDER_VIDEO_STAGE_TIMEOUT_SEC > 0
        else None
    )
    try:
        ensure_stage_deadline(stage_deadline, "preflight")
        # Check FFmpeg
        ffmpeg_available = check_ffmpeg()
        if not ffmpeg_available:
            print(json.dumps({
                "warning": "FFmpeg not found. Running in mock mode.",
                "status": "degraded"
            }), file=sys.stderr)

        # Fetch project data (or use provided data)
        if analysis_data:
            # Manual mode - use provided data
            print(f"📂 Using manual analysis data ({len(analysis_data.get('scenes', []))} scenes)", file=sys.stderr)
            project = {
                "id": project_id,
                "title": f"Manual Render {project_id}",
                "analysis": analysis_data,
                "audioUrl": song_path,
                "aspectRatio": analysis_data.get("aspectRatio", "16:9"),
                "thumbnailUrl": analysis_data.get("thumbnailUrl")
            }
            analysis = analysis_data
        else:
            # DB mode - fetch from database
            ensure_stage_deadline(stage_deadline, "load_project")
            project = get_project_data(project_id)
            analysis = project.get("analysis", {})
        generated_images = analysis.get("generatedImages", [])
        scenes = analysis.get("scenes", [])

        if not generated_images:
            print("Warning: No generated images found. Injecting placeholder frame.", file=sys.stderr)
            generated_images = [{
                "sceneIndex": 0,
                "imageUrl": build_placeholder_image_url("Fallback Frame"),
                "status": "success",
                "provider": "mock",
                "exposed": True
            }]

        # Create directories
        os.makedirs(VIDEOS_DIR, exist_ok=True)
        os.makedirs(TEMP_DIR, exist_ok=True)

        # Get dimensions
        width, height = get_aspect_dimensions(project.get("aspectRatio", "16:9"))

        # Create temp directory for this render
        render_temp = tempfile.mkdtemp(dir=TEMP_DIR)

        try:
            ensure_stage_deadline(stage_deadline, "prepare_timeline")
            # Download images
            image_files = []
            image_index = 0
            
            # Calculate intro duration (thumbnail display time until FIRST REAL VERSE starts)
            # Skip hooks like "one two", "whoa", "yeah", etc. to find actual verses
            intro_duration = 5  # Default minimum
            
            def is_real_verse(text: str) -> bool:
                """Check if text is a real verse, not just a hook/vocalization"""
                if not text:
                    return False
                # Clean and split
                words = text.lower().strip().split()
                # Too short = probably a hook
                if len(words) < 4:
                    return False
                # Common hooks/vocalizations to skip
                hook_patterns = ['whoa', 'yeah', 'oh', 'la', 'na', 'da', 'ooh', 'ahh', 'uuu', 'mmm', 'hey', 'uh',
                               'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
                # If most words are hook words, it's not a real verse
                hook_word_count = sum(1 for w in words if any(h in w for h in hook_patterns))
                if hook_word_count > len(words) * 0.5:
                    return False
                return True
            
            first_real_verse_idx = 0  # Track which scene index is the first real verse

            if scenes and len(scenes) > 0:
                # Find first REAL verse (not a hook)
                first_real_verse_start = None
                for idx, scene in enumerate(scenes):
                    verse_text = scene.get("verseText", "")
                    if is_real_verse(verse_text):
                        first_real_verse_start = scene.get("startTime", 0)
                        first_real_verse_idx = idx
                        print(f"First real verse found at scene {idx}: '{verse_text[:30]}...' starts at {first_real_verse_start}s", file=sys.stderr)
                        break

                if first_real_verse_start is not None and first_real_verse_start > 0:
                    intro_duration = first_real_verse_start
                    print(f"Thumbnail intro duration set to: {intro_duration}s (until first verse at scene {first_real_verse_idx})", file=sys.stderr)
                else:
                    # Fallback: use first scene's startTime
                    first_scene = scenes[0]
                    if "startTime" in first_scene and first_scene["startTime"] > 0:
                        intro_duration = first_scene["startTime"]
                        print(f"Thumbnail intro duration (fallback to first scene): {intro_duration}s", file=sys.stderr)
                    else:
                        intro_duration = 10  # Default intro if no timing info
                        print(f"Thumbnail intro duration (default): {intro_duration}s", file=sys.stderr)
            else:
                print(f"No scenes found, using default intro duration: {intro_duration}s", file=sys.stderr)
            
            # Add YouTube thumbnail as first image if available
            thumbnail_url = project.get("thumbnailUrl")
            thumbnail_path_source = get_local_path(thumbnail_url)
            
            if thumbnail_path_source and os.path.exists(thumbnail_path_source):
                thumbnail_path = os.path.join(render_temp, f"image_{image_index:03d}.png")
                if download_image(thumbnail_path_source, thumbnail_path, use_ffmpeg=ffmpeg_available):
                    image_files.append({
                        "path": thumbnail_path,
                        "duration": intro_duration,
                        "index": image_index
                    })
                    image_index += 1
                    print(f"Added thumbnail with duration {intro_duration}s", file=sys.stderr)
            else:
                print(f"Warning: Thumbnail not found: {thumbnail_url} -> {thumbnail_path_source}", file=sys.stderr)
            
            # Get local cache mapping for this project
            cache_mapping = get_image_files(project_id)
            total_scene_count = max(len(scenes), len(generated_images))
            post_verse_scene_count = max(total_scene_count - first_real_verse_idx, 0)
            unexposed_scene_count = 0
            unexposed_ratio_threshold = read_unexposed_fallback_threshold()

            # Fallback strategy:
            # If ALL post-verse scenes were marked exposed=false, render successful scenes anyway.
            # Also relax the gate when exposed=false dominates the timeline (prevents "frozen" videos).
            # This avoids videos made entirely from continuity fills when casting gate is too strict.
            has_exposed_post_verse = False
            for idx, img_data in enumerate(generated_images):
                if idx < first_real_verse_idx:
                    continue
                if img_data.get("exposed") is False:
                    unexposed_scene_count += 1
                    continue
                if img_data.get("status") == "success" or idx in cache_mapping:
                    has_exposed_post_verse = True
                    break

            unexposed_ratio = (
                (unexposed_scene_count / post_verse_scene_count)
                if post_verse_scene_count > 0
                else 0.0
            )
            allow_unexposed_fallback = (
                (not has_exposed_post_verse)
                or (unexposed_ratio >= unexposed_ratio_threshold)
            )
            if allow_unexposed_fallback:
                if not has_exposed_post_verse:
                    print(
                        "No exposed scenes after first verse. Enabling fallback render for successful unexposed scenes.",
                        file=sys.stderr
                    )
                else:
                    print(
                        (
                            "High unexposed ratio detected "
                            f"({unexposed_scene_count}/{post_verse_scene_count}={unexposed_ratio:.0%}, "
                            f"threshold={unexposed_ratio_threshold:.0%}). "
                            "Enabling fallback render for successful unexposed scenes."
                        ),
                        file=sys.stderr
                    )
            
            # Download/Collect scene images.
            # Keep full timeline length: if a scene is not renderable, duplicate the last valid frame.
            skipped_count = first_real_verse_idx
            skipped_quality_count = 0
            skipped_missing_count = 0
            diversity_fill_count = 0
            continuity_fill_count = 0
            last_valid_frame_path = image_files[-1]["path"] if image_files else None
            fallback_pool_paths = []
            fallback_pool_cursor = 0
            last_fallback_source = None

            for _, cached_path in sorted(cache_mapping.items(), key=lambda kv: kv[0]):
                if cached_path and os.path.exists(cached_path) and cached_path not in fallback_pool_paths:
                    fallback_pool_paths.append(cached_path)

            def pick_fallback_source():
                nonlocal fallback_pool_cursor, last_fallback_source
                if not fallback_pool_paths:
                    return None
                pool_len = len(fallback_pool_paths)
                for _ in range(pool_len):
                    candidate = fallback_pool_paths[fallback_pool_cursor % pool_len]
                    fallback_pool_cursor += 1
                    if pool_len == 1 or candidate != last_fallback_source:
                        last_fallback_source = candidate
                        return candidate
                candidate = fallback_pool_paths[fallback_pool_cursor % pool_len]
                fallback_pool_cursor += 1
                last_fallback_source = candidate
                return candidate

            for i in range(first_real_verse_idx, total_scene_count):
                ensure_stage_deadline(stage_deadline, "download_images")
                img_data = generated_images[i] if i < len(generated_images) else {}

                # Get duration from scene data
                duration = 5
                if i < len(scenes):
                    duration = scenes[i].get("duration", 5)

                # Try to render actual scene image first
                can_use_image = True
                if img_data.get("exposed") is False and not allow_unexposed_fallback:
                    can_use_image = False
                    skipped_quality_count += 1
                elif img_data and img_data.get("status") != "success" and i not in cache_mapping:
                    can_use_image = False
                    skipped_missing_count += 1

                rendered_scene = False
                if can_use_image:
                    image_url = img_data.get("imageUrl")
                    local_cache_path = cache_mapping.get(i)
                    source_path = local_cache_path if local_cache_path else image_url

                    if source_path:
                        image_path = os.path.join(render_temp, f"image_{image_index:03d}.png")
                        if download_image(source_path, image_path, use_ffmpeg=ffmpeg_available):
                            image_files.append({
                                "path": image_path,
                                "duration": duration,
                                "index": image_index
                            })
                            last_valid_frame_path = image_path
                            if image_path not in fallback_pool_paths:
                                fallback_pool_paths.append(image_path)
                            image_index += 1
                            rendered_scene = True
                    else:
                        skipped_missing_count += 1

                # Diversity fallback: preserve duration using rotating valid frames.
                # If pool is unavailable, fallback to last valid frame as final guard.
                if not rendered_scene:
                    fill_source = pick_fallback_source()
                    if not fill_source or not os.path.exists(fill_source):
                        fill_source = last_valid_frame_path

                    if not fill_source or not os.path.exists(fill_source):
                        continue

                    used_continuity_source = (
                        last_valid_frame_path is not None and fill_source == last_valid_frame_path
                    )
                    fill_path = os.path.join(render_temp, f"image_{image_index:03d}.png")
                    shutil.copy(fill_source, fill_path)
                    image_files.append({
                        "path": fill_path,
                        "duration": duration,
                        "index": image_index
                    })
                    last_valid_frame_path = fill_path
                    image_index += 1
                    if used_continuity_source:
                        continuity_fill_count += 1
                    else:
                        diversity_fill_count += 1

            if skipped_count > 0:
                print(f"Skipped {skipped_count} pre-verse images (covered by thumbnail intro)", file=sys.stderr)
            if skipped_quality_count > 0:
                print(f"Skipped {skipped_quality_count} low-quality images (exposed=false)", file=sys.stderr)
            if skipped_missing_count > 0:
                print(f"Skipped {skipped_missing_count} missing/failed scene images", file=sys.stderr)
            if diversity_fill_count > 0:
                print(f"Filled {diversity_fill_count} scene slots with diversity fallback frames", file=sys.stderr)
            if continuity_fill_count > 0:
                print(f"Filled {continuity_fill_count} scene slots with continuity frames", file=sys.stderr)

            render_metrics = {
                "totalSceneCount": total_scene_count,
                "postVerseSceneCount": post_verse_scene_count,
                "allowUnexposedFallback": allow_unexposed_fallback,
                "unexposedSceneCount": unexposed_scene_count,
                "unexposedRatio": round(unexposed_ratio, 4),
                "skippedPreVerseCount": skipped_count,
                "skippedQualityCount": skipped_quality_count,
                "skippedMissingCount": skipped_missing_count,
                "diversityFillCount": diversity_fill_count,
                "continuityFillCount": continuity_fill_count,
            }

            if not image_files:
                fallback = build_safe_render_result(
                    project_id=project_id,
                    mode="mock",
                    degraded=True,
                    useful_output=False,
                    message="No images could be downloaded. Returning safe fallback result.",
                    resolution=f"{width}x{height}",
                    frames_used=0,
                    duration=0,
                    error_code="render_video.no_images",
                )
                fallback["renderMetrics"] = render_metrics
                emit_result(fallback)
                return fallback

            # Create video using FFmpeg
            ensure_stage_deadline(stage_deadline, "prepare_ffmpeg")
            output_filename = f"{project_id}.mp4"
            output_path = os.path.join(VIDEOS_DIR, output_filename)

            # Calculate video info
            total_duration = sum(img["duration"] for img in image_files)

            if not ffmpeg_available:
                # Mock mode - just save metadata without rendering
                video_url = f"/output/videos/{output_filename}"
                save_warning = safe_save_video_url(project_id, video_url)
                result = build_safe_render_result(
                    project_id=project_id,
                    mode="mock",
                    degraded=True,
                    useful_output=False,
                    message="FFmpeg not available. Returned mock render metadata.",
                    output_path="(mock - no file created)",
                    duration=total_duration,
                    resolution=f"{width}x{height}",
                    frames_used=len(image_files),
                    file_size=0,
                    warning=save_warning,
                    error_code="render_video.ffmpeg_unavailable",
                )
                result["renderMetrics"] = render_metrics
                emit_result(result)
                return result

            # Build FFmpeg filter for slideshow
            # Ken Burns effect can be disabled with KEN_BURNS=false env var
            use_ken_burns = os.getenv("KEN_BURNS", "true").lower() != "false"

            filter_parts = []
            inputs = []

            if use_ken_burns:
                print(f"🎬 Ken Burns effect ENABLED", file=sys.stderr)
                # Ken Burns patterns: zoom in, zoom out, pan left, pan right
                ken_burns_patterns = [
                    # Slow zoom in (1.0 -> 1.15)
                    lambda d, w, h: f"scale={int(w*1.2)}:{int(h*1.2)},zoompan=z='min(zoom+0.0005,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(d*30)}:s={w}x{h}:fps=30",
                    # Slow zoom out (1.15 -> 1.0)
                    lambda d, w, h: f"scale={int(w*1.2)}:{int(h*1.2)},zoompan=z='if(eq(on,1),1.15,max(zoom-0.0005,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(d*30)}:s={w}x{h}:fps=30",
                    # Pan left to right
                    lambda d, w, h: f"scale={int(w*1.3)}:-1,zoompan=z='1.1':x='if(eq(on,1),0,min(x+2,iw-iw/zoom))':y='ih/2-(ih/zoom/2)':d={int(d*30)}:s={w}x{h}:fps=30",
                    # Pan right to left
                    lambda d, w, h: f"scale={int(w*1.3)}:-1,zoompan=z='1.1':x='if(eq(on,1),iw-iw/zoom,max(x-2,0))':y='ih/2-(ih/zoom/2)':d={int(d*30)}:s={w}x{h}:fps=30",
                ]

                for i, img in enumerate(image_files):
                    duration = img["duration"]
                    inputs.extend(['-loop', '1', '-t', str(duration + 0.5), '-i', img["path"]])

                    # Apply Ken Burns effect (cycle through patterns)
                    kb_pattern = ken_burns_patterns[i % len(ken_burns_patterns)]
                    kb_filter = kb_pattern(duration, width, height)

                    filter_parts.append(
                        f"[{i}:v]{kb_filter},"
                        f"setsar=1,trim=duration={duration}[v{i}]"
                    )
            else:
                print(f"🎬 Ken Burns effect DISABLED (simple slideshow)", file=sys.stderr)
                # Simple mode: scale and pad only
                for i, img in enumerate(image_files):
                    duration = img["duration"]
                    inputs.extend(['-loop', '1', '-t', str(duration), '-i', img["path"]])
                    filter_parts.append(
                        f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
                        f"setsar=1[v{i}]"
                    )

            # Concatenate all videos
            concat_inputs = ''.join([f"[v{i}]" for i in range(len(image_files))])
            filter_parts.append(f"{concat_inputs}concat=n={len(image_files)}:v=1:a=0[outv]")

            filter_complex = ';'.join(filter_parts)

            # Build FFmpeg command
            ffmpeg_cmd = [FFMPEG_PATH, '-y']
            ffmpeg_cmd.extend(inputs)
            
            # Add audio input if available
            audio_url = project.get("audioUrl")
            audio_input_index = len(image_files)  # Audio will be the last input
            has_audio = False
            
            # Convert web URL path to filesystem path if needed
            audio_path = get_local_path(audio_url)
            
            if audio_path and os.path.exists(audio_path):
                ffmpeg_cmd.extend(['-i', audio_path])
                has_audio = True
                print(f"Audio file found: {audio_path}", file=sys.stderr)
            else:
                print(f"Warning: Audio file not found: {audio_url} -> {audio_path}", file=sys.stderr)
            
            ffmpeg_cmd.extend([
                '-filter_complex', filter_complex,
                '-map', '[outv]',
            ])
            
            # Map audio if available and trim to video duration
            if has_audio:
                ffmpeg_cmd.extend([
                    '-map', f'{audio_input_index}:a',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest',  # Cut audio to match video length
                ])
            
            ffmpeg_cmd.extend([
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                output_path
            ])

            # Run FFmpeg
            ffmpeg_timeout_sec = parse_positive_int_env("RENDER_VIDEO_FFMPEG_TIMEOUT_SEC", 900)
            try:
                ensure_stage_deadline(stage_deadline, "run_ffmpeg")
                ffmpeg_result = subprocess.run(
                    ffmpeg_cmd,
                    capture_output=True,
                    text=True,
                    timeout=ffmpeg_timeout_sec if ffmpeg_timeout_sec > 0 else None,
                )
            except subprocess.TimeoutExpired:
                result = build_safe_render_result(
                    project_id=project_id,
                    mode="mock",
                    degraded=True,
                    useful_output=False,
                    message="FFmpeg timed out; returning fallback metadata result.",
                    output_path="(ffmpeg-timeout/no-file)",
                    duration=total_duration,
                    resolution=f"{width}x{height}",
                    frames_used=len(image_files),
                    file_size=0,
                    warning=f"FFmpeg timed out after {ffmpeg_timeout_sec}s",
                    error_code="render_video.ffmpeg_timeout",
                )
                result["renderMetrics"] = render_metrics
                emit_result(result)
                return result

            if ffmpeg_result.returncode != 0:
                # Show LAST 1000 chars of stderr (actual error is at the end, not the version info)
                error_tail = ffmpeg_result.stderr[-1000:] if len(ffmpeg_result.stderr) > 1000 else ffmpeg_result.stderr
                result = build_safe_render_result(
                    project_id=project_id,
                    mode="mock",
                    degraded=True,
                    useful_output=False,
                    message="FFmpeg failed; returning fallback metadata result.",
                    output_path="(ffmpeg-failed/no-file)",
                    duration=total_duration,
                    resolution=f"{width}x{height}",
                    frames_used=len(image_files),
                    file_size=0,
                    warning=f"FFmpeg failed: {error_tail[:800]}",
                    error_code="render_video.ffmpeg_failed",
                )
                result["renderMetrics"] = render_metrics
                emit_result(result)
                return result

            # Get file size
            file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

            # Save to database
            ensure_stage_deadline(stage_deadline, "save_video")
            video_url = f"/output/videos/{output_filename}"
            save_warning = safe_save_video_url(project_id, video_url)

            # Output result
            degraded = bool(save_warning)
            useful_output = file_size > 0 and os.path.exists(output_path)
            result = {
                "status": ("failed" if not useful_output else ("degraded" if degraded else "success")),
                "success": useful_output,
                "mode": "ffmpeg",
                "videoUrl": video_url,
                "outputPath": output_path,
                "duration": total_duration,
                "resolution": f"{width}x{height}",
                "fileSize": file_size,
                "framesUsed": len(image_files),
                "degraded": degraded,
                "degradedReasons": ["render_video.db_save_warning"] if degraded else [],
                "warning": save_warning if save_warning else None,
                "renderMetrics": render_metrics,
            }
            if not useful_output:
                result["errorCode"] = "render_video.no_output_file"

            emit_result(result)
            return result

        finally:
            # Cleanup temp directory
            shutil.rmtree(render_temp, ignore_errors=True)

    except Exception as e:
        if isinstance(e, TimeoutError):
            fallback = build_safe_render_result(
                project_id=project_id if project_id else "unknown",
                mode="mock",
                degraded=True,
                useful_output=False,
                message="Render stage timeout. Returning safe fallback metadata.",
                warning=str(e),
                error_code="render_video.stage_timeout",
            )
            emit_result(fallback)
            return fallback
        fallback = build_safe_render_result(
            project_id=project_id if project_id else "unknown",
            mode="mock",
            degraded=True,
            useful_output=False,
            message="Unhandled render exception; returning safe fallback metadata.",
            warning=f"{type(e).__name__}: {str(e)}",
            error_code="render_video.exception",
        )
        emit_result(fallback)
        return fallback

if __name__ == "__main__":
    if len(sys.argv) < 2:
        emit_result(
            build_safe_render_result(
                project_id="unknown",
                mode="mock",
                degraded=True,
                useful_output=False,
                message="Missing arguments. Returning safe fallback output.",
                warning="Usage: python render_video.py <project_id> [audio_path] [json_file_or_string]",
                error_code="render_video.missing_arguments",
            ),
        )
        sys.exit(0)

    project_id = sys.argv[1]

    if len(sys.argv) >= 4:
        song_path = sys.argv[2]
        json_arg = sys.argv[3]

        if not os.path.isfile(song_path):
            print(f"Warning: Audio file not found: {song_path}. Continuing without audio.", file=sys.stderr)
            song_path = None

        if os.path.isfile(json_arg) and json_arg.endswith('.json'):
            try:
                with open(json_arg, 'r', encoding='utf-8') as f:
                    analysis_data = json.load(f)
                print(f"Loading analysis from file: {json_arg}", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Failed to read JSON file: {str(e)}. Using empty analysis.", file=sys.stderr)
                analysis_data = {}
        else:
            try:
                analysis_data = json.loads(json_arg)
                print("Parsing JSON string argument", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Failed to parse JSON string: {str(e)}. Using empty analysis.", file=sys.stderr)
                analysis_data = {}

        render_video(project_id, song_path, analysis_data)
    else:
        print(f"Fetching project {project_id} from database", file=sys.stderr)
        render_video(project_id)
