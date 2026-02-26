#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate Images Script
Reads analysis result from database and generates images.
Supports multiple providers: Pollinations (free), Replicate (paid).
"""
import sys
import json
import os
import time
import re
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args, **_kwargs):
        return False
from runtime_config import build_placeholder_image_url, get_comfyui_url

# Import frame exposure decision system
try:
    from frame_exposer import full_exposure_check
    EXPOSER_AVAILABLE = True
except ImportError:
    EXPOSER_AVAILABLE = False

# Import Redis events publisher
try:
    from redis_events import (
        emit_image_generated,
        emit_frame_skipped,
        emit_progress,
        emit_pipeline_complete,
        emit_steering_applied
    )
    REDIS_EVENTS_AVAILABLE = True
except ImportError:
    REDIS_EVENTS_AVAILABLE = False

# Import Live Steering module (Just-in-Time direction)
try:
    from live_steering import check_and_apply_steering, LiveSteeringManager
    STEERING_AVAILABLE = True
except ImportError:
    STEERING_AVAILABLE = False
    print("Warning: live_steering module not available. Live direction disabled.", file=sys.stderr)

# Fix Windows console encoding issues
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Load configuration
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)


def get_db_connection():
    from db_utils import get_db_connection as _get_db_connection
    return _get_db_connection()


def emit_result(payload):
    output = json.dumps(payload, ensure_ascii=False)
    print(output)
    print(f"RESULT_JSON:{output}", file=sys.stderr)

# Output directory for generated images
OUTPUT_DIR = os.path.join(root_dir, 'output', 'images')
LORAS_DIR = os.path.join(root_dir, "ComfyUI", "models", "loras")
_STYLE_LORA_CACHE = {}

def normalize_style_name(style: str) -> str:
    value = (style or "").strip().lower()
    value = re.sub(r"[^a-z0-9_\- ]+", "", value)
    return re.sub(r"\s+", "_", value)

def _safe_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

def _extract_lora_datetime(filename: str, prefix: str):
    base_name = os.path.splitext(filename)[0]
    if not base_name.startswith(prefix):
        return None

    suffix = base_name[len(prefix):]
    match = re.search(r"(\d{8}(?:[_-]?\d{6})?)", suffix)
    if not match:
        return None

    token = match.group(1)
    candidates = [token]
    if "-" in token:
        candidates.append(token.replace("-", "_"))
    if "_" in token:
        candidates.append(token.replace("_", ""))

    from datetime import datetime
    formats = ("%Y%m%d_%H%M%S", "%Y%m%d%H%M%S", "%Y%m%d")
    for candidate in candidates:
        for fmt in formats:
            try:
                return datetime.strptime(candidate, fmt)
            except ValueError:
                continue

    return None

def get_style_lora_config(style: str) -> dict:
    style_key = normalize_style_name(style)
    if not style_key:
        return {}

    if style_key in _STYLE_LORA_CACHE:
        return _STYLE_LORA_CACHE[style_key]

    if not os.path.isdir(LORAS_DIR):
        _STYLE_LORA_CACHE[style_key] = {}
        return {}

    prefix = f"style_{style_key}_"
    candidates = []
    for filename in os.listdir(LORAS_DIR):
        if not filename.lower().endswith(".safetensors"):
            continue
        if not filename.startswith(prefix):
            continue
        dt = _extract_lora_datetime(filename, prefix)
        full_path = os.path.join(LORAS_DIR, filename)
        candidates.append((dt, filename, full_path))

    if not candidates:
        _STYLE_LORA_CACHE[style_key] = {}
        return {}

    dated = [item for item in candidates if item[0] is not None]
    if dated:
        dated.sort(key=lambda item: (item[0], item[1]), reverse=True)
        _, latest_filename, latest_path = dated[0]
    else:
        candidates.sort(key=lambda item: item[1], reverse=True)
        _, latest_filename, latest_path = candidates[0]

    default_strength = _safe_float(os.getenv("COMFYUI_STYLE_LORA_STRENGTH", "0.7"), 0.7)
    strength_model = _safe_float(
        os.getenv("COMFYUI_STYLE_LORA_STRENGTH_MODEL", default_strength),
        default_strength,
    )
    strength_clip = _safe_float(
        os.getenv("COMFYUI_STYLE_LORA_STRENGTH_CLIP", strength_model),
        strength_model,
    )

    result = {
        "loraFilename": latest_filename,
        "loraPath": latest_path,
        "strengthModel": strength_model,
        "strengthClip": strength_clip,
    }
    _STYLE_LORA_CACHE[style_key] = result
    return result

def to_web_url(abs_path):
    """Convert absolute filesystem path to relative web URL"""
    if not abs_path:
        return abs_path
    
    # Normalize path separators
    normalized_path = abs_path.replace("\\", "/")
    normalized_root = root_dir.replace("\\", "/")
    
    # On Windows, path casing can be inconsistent (C: vs c:)
    if normalized_path.lower().startswith(normalized_root.lower()):
        rel_path = normalized_path[len(normalized_root):]
        return rel_path if rel_path.startswith("/") else "/" + rel_path
    return abs_path

def get_project_analysis(project_id: str) -> dict:
    """Fetch project analysis result from database"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''SELECT id, title, "analysisResult", "visualStyle", "aspectRatio"
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
            "visualStyle": row[3],
            "aspectRatio": row[4] or "16:9"
        }
    finally:
        conn.close()

def save_generated_images(project_id: str, images: list):
    """Save generated image URLs to database"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        # Get current analysis and add images
        cur.execute(
            '''SELECT "analysisResult" FROM "Project" WHERE id = %s''',
            (project_id,)
        )
        row = cur.fetchone()
        analysis = row[0] if row and row[0] else {}
        if isinstance(analysis, str):
            analysis = json.loads(analysis)

        analysis['generatedImages'] = images

        cur.execute(
            '''UPDATE "Project" SET "analysisResult" = %s WHERE id = %s''',
            (json.dumps(analysis), project_id)
        )
        conn.commit()
    finally:
        conn.close()

def generate_with_replicate(prompt: str, style: str = None, api_token: str = None) -> str:
    """Generate image using Replicate API (FLUX model)"""
    if not api_token:
        raise Exception("REPLICATE_API_TOKEN not provided")

    # FLUX Schnell model - fast and high quality
    model_version = "black-forest-labs/flux-schnell"

    # Enhance prompt with style
    full_prompt = prompt
    if style:
        full_prompt = f"{prompt}, {style} style, high quality, detailed"

    # Create prediction
    create_url = "https://api.replicate.com/v1/predictions"
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json"
    }

    payload = {
        "version": "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
        "input": {
            "prompt": full_prompt,
            "num_outputs": 1,
            "aspect_ratio": "16:9",
            "output_format": "webp",
            "output_quality": 90
        }
    }

    json_data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(create_url, data=json_data, headers=headers, method='POST')

    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode('utf-8'))
        prediction_id = result.get('id')

    # Poll for completion
    get_url = f"https://api.replicate.com/v1/predictions/{prediction_id}"
    max_attempts = 60  # Max 2 minutes per image

    for attempt in range(max_attempts):
        req = urllib.request.Request(get_url, headers=headers)
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode('utf-8'))
            status = result.get('status')

            if status == 'succeeded':
                output = result.get('output')
                if output:
                    return output[0] if isinstance(output, list) else output
                raise Exception("No output in successful prediction")

            elif status == 'failed':
                error = result.get('error', 'Unknown error')
                raise Exception(f"Prediction failed: {error}")

            elif status in ['starting', 'processing']:
                time.sleep(2)
            else:
                raise Exception(f"Unknown status: {status}")

    raise Exception("Prediction timed out")

def generate_with_pollinations(prompt: str, style: str = None, width: int = 1024, height: int = 1024, scene_index: int = 0) -> str:
    """
    Generate image using Pollinations.ai (FREE, no API key needed)
    Downloads and caches the image locally to ensure it's ready for video render.
    """
    # Enhance prompt with style
    full_prompt = prompt
    if style:
        full_prompt = f"{prompt}, {style} style, high quality, detailed, cinematic"

    # Truncate prompt if too long (URLs have limits)
    if len(full_prompt) > 500:
        full_prompt = full_prompt[:500]

    # URL encode the prompt
    encoded_prompt = urllib.parse.quote(full_prompt)

    # Pollinations.ai direct URL - generates image on access
    # Using flux model for better quality
    image_url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width={width}&height={height}&model=flux&nologo=true"

    # Create local cache directory
    cache_dir = os.path.join(OUTPUT_DIR, 'cache')
    os.makedirs(cache_dir, exist_ok=True)

    # Generate a unique filename based on prompt hash
    import hashlib
    prompt_hash = hashlib.md5(full_prompt.encode()).hexdigest()[:12]
    local_path = os.path.join(cache_dir, f"pollinations_{scene_index}_{prompt_hash}.jpg")

    # If already cached, return the local path
    if os.path.exists(local_path) and os.path.getsize(local_path) > 1000:
        print(f"  Using cached image for scene {scene_index}", file=sys.stderr)
        return local_path

    # Download and cache the image (this triggers generation)
    print(f"  Generating image for scene {scene_index} with Pollinations AI...", file=sys.stderr)

    max_retries = 3
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(image_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            # Long timeout - Pollinations can take up to 2 minutes to generate
            with urllib.request.urlopen(req, timeout=180) as response:
                image_data = response.read()

                # Verify we got actual image data (not an error page)
                if len(image_data) < 1000:
                    raise Exception("Received invalid image data (too small)")

                # Save to cache
                with open(local_path, 'wb') as f:
                    f.write(image_data)

                print(f"  ✓ Scene {scene_index} generated ({len(image_data) // 1024} KB)", file=sys.stderr)
                return local_path

        except Exception as e:
            if attempt < max_retries - 1:
                print(f"  Retry {attempt + 1}/{max_retries} for scene {scene_index}: {str(e)[:50]}", file=sys.stderr)
                time.sleep(5)  # Wait before retry
            else:
                raise Exception(f"Failed to generate image after {max_retries} attempts: {e}")

    raise Exception("Failed to generate image")

def generate_with_picsum(width: int = 1920, height: int = 1080, seed: int = None) -> str:
    """Get a random photo from Picsum (Lorem Picsum) - FREE"""
    # Picsum provides beautiful random photos
    if seed is not None:
        return f"https://picsum.photos/seed/{seed}/{width}/{height}"
    return f"https://picsum.photos/{width}/{height}"

def generate_with_artic(search_term: str = None, index: int = 0) -> str:
    """Get artwork from Art Institute of Chicago API - FREE"""
    try:
        # Search for artwork related to the prompt keywords
        search_url = "https://api.artic.edu/api/v1/artworks/search"

        # Use generic art terms if no search term
        terms = search_term if search_term else "landscape nature"
        # Extract first few words for search
        query = ' '.join(terms.split()[:3])

        params = urllib.parse.urlencode({
            'q': query,
            'limit': 10,
            'fields': 'id,title,image_id'
        })

        req = urllib.request.Request(f"{search_url}?{params}")
        req.add_header('User-Agent', 'MusicVideoGenerator/1.0')

        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            artworks = data.get('data', [])

            if artworks:
                # Pick artwork based on index
                artwork = artworks[index % len(artworks)]
                image_id = artwork.get('image_id')
                if image_id:
                    # IIIF image URL from Art Institute
                    return f"https://www.artic.edu/iiif/2/{image_id}/full/1920,/0/default.jpg"
    except Exception as e:
        pass

    # Fallback to picsum if artic fails
    return generate_with_picsum(1920, 1080, index)

def check_comfyui_queue_status(comfyui_url: str):
    """
    Checks if the ComfyUI server is idle or busy.
    Returns: 'idle', 'working', 'pending', or 'down'
    """
    try:
        req = urllib.request.Request(f"{comfyui_url}/queue")
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            
            running = data.get('queue_running', [])
            pending = data.get('queue_pending', [])
            
            if running:
                return f"busy_working ({len(running)} jobs executing)"
            elif pending:
                return f"busy_pending ({len(pending)} jobs waiting)"
            else:
                return "idle"
    except Exception:
        return "down"

def generate_with_comfyui(prompt: str, style: str = None, width: int = 1280, height: int = 720, scene_index: int = 0, checkpoint: str = None, negative_prompt: str = None, project_id: str = None, verse_type: str = None, has_protagonist: bool = True, ai_optimization: dict = None) -> str:
    """
    Generate image using local ComfyUI server.
    Requires ComfyUI running at COMFYUI_URL.

    Args:
        prompt: The main image description
        style: Optional style keywords to append (also used for auto model selection)
        width: Image width (default 1920)
        height: Image height (default 1080)
        scene_index: Scene number for filename
        checkpoint: Model checkpoint name (defaults to auto-selection or COMFYUI_CHECKPOINT env var)
        negative_prompt: Custom negative prompt (defaults to standard quality negatives)
        project_id: Project ID for consistent protagonist (same project = same base seed)
        verse_type: Pre-classified verse type (INTROSPECTIVE, NARRATIVE, LITERAL, RHYTHMIC, TRANSITION, REPETITION)
        has_protagonist: Whether the verse features protagonist (affects model selection)
        ai_optimization: Dict with qualityBoost, negativeBoost from user feedback learning
    """
    import uuid
    import hashlib

    comfyui_url = get_comfyui_url()

    # PROTAGONIST CONSISTENCY: Fixed base seed per project
    # Same project_id = same base_seed = consistent character appearance
    if project_id:
        # Hash project_id to get a stable integer seed
        base_seed = int(hashlib.md5(project_id.encode()).hexdigest()[:8], 16) % 1000000
    else:
        base_seed = 42  # Fallback default

    # Seed formula: base_seed + (verse_index * 111)
    # This ensures consistent protagonist while allowing variation per scene
    scene_seed = base_seed + (scene_index * 111)
    print(f"  Seed: {scene_seed} (base: {base_seed}, scene: {scene_index})", file=sys.stderr)

    # ═══════════════════════════════════════════════════════════════════════════
    # VERSE CLASSIFICATION → MODEL SELECTION
    # verse_type comes pre-classified from LLM, or fallback to keyword detection
    # ═══════════════════════════════════════════════════════════════════════════

    if checkpoint is None:
        prompt_lower = prompt.lower()

        # Face/emotion focus detection (CRITICAL: never use LCM for faces)
        has_face_focus = any(kw in prompt_lower for kw in
                            ["face", "eyes", "portrait", "close-up", "closeup",
                             "expression", "tears", "crying", "emotional", "intense"])

        # If verse_type not provided, detect from prompt keywords (fallback)
        if verse_type is None:
            introspective_kw = ["introspective", "contemplative", "thinking", "feeling",
                              "alone", "solitude", "reflection", "memory", "dream"]
            literal_kw = ["car", "phone", "door", "hands", "eyes", "face", "close-up"]
            rhythmic_kw = ["dancing", "moving", "rhythm", "beat", "energy", "blur"]
            atmosphere_kw = ["landscape", "sky", "sunset", "rain", "fog", "silhouette",
                            "empty", "horizon", "panoramic", "wide shot"]

            if any(kw in prompt_lower for kw in introspective_kw):
                verse_type = "INTROSPECTIVE"
            elif any(kw in prompt_lower for kw in rhythmic_kw):
                verse_type = "RHYTHMIC"
            elif any(kw in prompt_lower for kw in atmosphere_kw) and not has_protagonist:
                verse_type = "TRANSITION"
            elif any(kw in prompt_lower for kw in literal_kw):
                verse_type = "LITERAL"
            else:
                verse_type = "NARRATIVE"  # Default fallback

        # ─── DECISION TABLE V6: EpicRealism Default ───
        # Aesthetic Restoration: EpicRealism for photo-like natural look
        # Only RHYTHMIC uses LCM for motion blur effect
        # ⚡ CRITICAL: Lightning/LCM NEVER on emotional close-ups

        if has_face_focus:
            # FACE FOCUS → EpicRealism for natural skin, soft lighting
            model_checkpoint = "epicrealismXL_vxviiCrystalclear.safetensors"
            steps = 30
            cfg = 5.0
            sampler = "dpmpp_2m"
            print(f"  Type: {verse_type} [FACE] → EpicRealism (CFG 5.0)", file=sys.stderr)

        elif verse_type == "INTROSPECTIVE" and has_protagonist:
            # Emotional, contemplative → EpicRealism soft aesthetic
            model_checkpoint = "epicrealismXL_vxviiCrystalclear.safetensors"
            steps = 30
            cfg = 5.0
            sampler = "dpmpp_2m"
            print(f"  Type: INTROSPECTIVE → EpicRealism (CFG 5.0)", file=sys.stderr)

        elif verse_type == "RHYTHMIC" and not has_face_focus:
            # Motion, rhythm, energy → Lightning/LCM for fast generation
            # Try Photon LCM first, fallback to RealVis Lightning if not installed
            if os.path.exists(os.path.join(root_dir, "ComfyUI", "models", "checkpoints", "photonLCM_v10.safetensors")):
                model_checkpoint = "photonLCM_v10.safetensors"
                print(f"  Type: RHYTHMIC → Photon LCM (CFG 2.0)", file=sys.stderr)
            else:
                model_checkpoint = "realvisxlV50_v50LightningBakedvae.safetensors"
                print(f"  Type: RHYTHMIC → RealVis Lightning (CFG 2.0) [fallback]", file=sys.stderr)
            steps = 8
            cfg = 2.0
            sampler = "dpmpp_sde"

        elif verse_type == "LITERAL" and has_protagonist:
            # Concrete objects/actions → EpicRealism natural look
            model_checkpoint = "epicrealismXL_vxviiCrystalclear.safetensors"
            steps = 30
            cfg = 5.0
            sampler = "dpmpp_2m"
            print(f"  Type: LITERAL → EpicRealism (CFG 5.0)", file=sys.stderr)

        elif verse_type == "NARRATIVE" and has_protagonist:
            # Story scenes → JuggernautXL for superior cinematic composition
            model_checkpoint = "juggernautXL_ragnarokBy.safetensors"
            steps = 30
            cfg = 4.5
            sampler = "dpmpp_2m"
            print(f"  Type: NARRATIVE → JuggernautXL Ragnarok (CFG 4.5)", file=sys.stderr)

        elif verse_type == "TRANSITION" and not has_protagonist:
            # Atmosphere, environment → JuggernautXL for detailed landscapes
            model_checkpoint = "juggernautXL_ragnarokBy.safetensors"
            steps = 30
            cfg = 4.5
            sampler = "dpmpp_2m"
            print(f"  Type: TRANSITION → JuggernautXL Ragnarok (CFG 4.5)", file=sys.stderr)

        elif verse_type == "REPETITION" and has_protagonist:
            # Repeated verse, new angle → JuggernautXL for distinct visual style
            model_checkpoint = "juggernautXL_ragnarokBy.safetensors"
            steps = 30
            cfg = 4.5
            sampler = "dpmpp_2m"
            print(f"  Type: REPETITION → JuggernautXL Ragnarok (CFG 4.5)", file=sys.stderr)

        else:
            # DEFAULT → EpicRealism (photo-like aesthetic)
            model_checkpoint = "epicrealismXL_vxviiCrystalclear.safetensors"
            steps = 30
            cfg = 5.0
            sampler = "dpmpp_2m"
            print(f"  Type: {verse_type} (default) → EpicRealism (CFG 5.0)", file=sys.stderr)
    else:
        model_checkpoint = checkpoint
        steps = 30
        cfg = 7.0
        sampler = "dpmpp_2m"

    # ═══════════════════════════════════════════════════════════════════════════
    # SAFETY CLAMP: Lightning/Turbo models burn at high CFG
    # These models are trained for 4-8 steps; high CFG causes oversaturation
    # ═══════════════════════════════════════════════════════════════════════════
    is_lightning_model = "lightning" in model_checkpoint.lower() or "turbo" in model_checkpoint.lower() or "lcm" in model_checkpoint.lower()

    if is_lightning_model:
        old_cfg = cfg
        cfg = min(cfg, 2.0)  # Hard cap at 2.0 for distilled models
        steps = max(steps, 8)  # Ensure at least 8 steps for stability
        if old_cfg != cfg:
            print(f"  ⚡ Lightning/Turbo/LCM detected: Clamping CFG {old_cfg} -> {cfg}", file=sys.stderr)

    # Enhance prompt with style and quality keywords
    full_prompt = prompt
    
    # ═══════════════════════════════════════════════════════════════════════════
    # STYLE HANDLING V9: Artistic Override (Contrast Strategy)
    # ═══════════════════════════════════════════════════════════════════════════
    full_prompt = prompt
    quality_suffix = ""
    
    # Normalize style strings
    style_norm = style.lower().replace("-", " ") if style else ""

    # Base Negative Prompt (Safety + Structure + Physics + Anatomy)
    neg_base = (
        "nsfw, naked, text, watermark, clones, twins, decapitated, headless, blurry, "
        "floating objects, disconnected hands, "
        # Hand anatomy fixes
        "extra fingers, mutated hands, poorly drawn hands, missing fingers, four fingers, 4 fingers, "
        "fused fingers, too many fingers, bad hands, malformed hands, "
        # Limb/body duplication fixes
        "extra limbs, extra arms, multiple arms, three arms, 3 arms, extra legs, malformed limbs, "
        "bad anatomy, wrong anatomy, deformed body, disfigured body, "
        # Face/mouth deformation fixes
        "duplicate face, double face, two faces, fused face, malformed face, "
        "extra mouth, duplicate mouth, double mouth, two mouths, malformed mouth, asymmetrical mouth, "
        "double lips, fused lips, distorted jaw, deformed teeth, "
        # Eye anatomy fixes
        "cross-eyed, crossed eyes, strabismus, lazy eye, uneven eyes, asymmetric eyes, wonky eyes, "
        "wall-eyed, cockeyed, squinting, deformed iris, deformed pupils"
    )

    if style_norm == 'hyper realistic' or style_norm == 'realistic':
        quality_suffix = ", photorealistic, high detail, masterpiece"
        negative_prompt = f"{neg_base}, (anime:1.2), (illustration:1.2), (drawing:1.2), (cartoon:1.2)"
    elif style_norm == 'ui design' or style_norm == 'stitch':
        full_prompt = f"minimalist UI design, google stitch aesthetic, {prompt}, clean wireframe, figma workspace, user interface components, cyan and white color palette, flat vector art, mobile app prototyping, digital interface, high-end tech-demo"
        negative_prompt = f"{neg_base}, (photograph:1.5), realistic, complex textures, messy, handheld, shadows, 3d render, organic"
    elif style_norm == 'anime':
        full_prompt = f"2D illustration, japanese anime style, {prompt}, flat color, bold lines, high-quality anime"
        negative_prompt = f"{neg_base}, (photorealistic:1.4), (photograph:1.4), (realism:1.4), (realistic skin:1.4), 3d render"
    elif style_norm == 'cyberpunk':
        quality_suffix = ", neon lighting, synthwave aesthetic, futuristic city, glowing lights"
        negative_prompt = f"{neg_base}, (daylight:1.2), natural lighting, bright sun"
    elif style_norm == 'fantasy':
        quality_suffix = ", magical atmosphere, ethereal lighting, fantasy world, ornate details"
        negative_prompt = f"{neg_base}, (modern:1.2), (tech:1.2), machinery"
    elif style_norm == 'film noir' or style_norm == 'noir':
        quality_suffix = ", monochrome, black and white, dramatic high contrast, 1940s film still, smoky atmosphere"
        negative_prompt = f"{neg_base}, (color:1.4), chromatic, vivid"
    elif style_norm == 'cinematic':
        quality_suffix = ", cinematic film still, soft natural lighting, shallow depth of field, masterpiece"
        negative_prompt = f"{neg_base}, (saturated:1.2), neon, cartoon"
    elif style_norm == 'cinematographer' or style_norm == 'vintage film':
        # 🎞️ THE CINEMATOGRAPHER STYLE - 1895 Lumière Brothers aesthetic
        quality_suffix = ", vintage film look, daguerreotype style, scratched film texture, heavy film grain, flickering projector light, sepia tone, vignette effect, antique photograph, 1890s aesthetic"
        negative_prompt = f"{neg_base}, (modern:1.4), (digital:1.3), (clean:1.2), (sharp:1.1), vibrant colors, neon, contemporary"
    else:
        # Default / No Style
        quality_suffix = ", photorealistic"
        negative_prompt = neg_base
    
    # Add minimal quality anchor (only if not a creative style)
    if style_norm not in ['anime', 'ui design']:
        quality_suffix += ", natural skin texture"

    # ═══════════════════════════════════════════════════════════════════════════
    # 🧠 AI LEARNING INTEGRATION - Apply user feedback optimization
    # Adds learned quality boosters and avoids problematic patterns
    # ═══════════════════════════════════════════════════════════════════════════
    if ai_optimization and ai_optimization.get("confidence", 0) > 0:
        confidence = ai_optimization.get("confidence", 0)

        # A. QUALITY BOOST - Add winning patterns to prompt
        quality_boost = ai_optimization.get("qualityBoost", "")
        if quality_boost:
            # Scale intensity by confidence (higher confidence = stronger boost)
            if confidence > 0.7:
                quality_suffix += f", ({quality_boost}:1.2)"
            elif confidence > 0.4:
                quality_suffix += f", ({quality_boost}:1.1)"
            else:
                quality_suffix += f", {quality_boost}"
            print(f"  🧠 AI Quality Boost: {quality_boost} (conf: {int(confidence*100)}%)", file=sys.stderr)

        # B. NEGATIVE BOOST - Avoid patterns users disliked
        negative_boost = ai_optimization.get("negativeBoost", "")
        if negative_boost:
            negative_prompt += f", {negative_boost}"
            print(f"  🧠 AI Negative Boost: {negative_boost}", file=sys.stderr)

    # Detect scenes with multiple people and add stronger anatomical guidance.
    # Group scenes are statistically more prone to eye/face/hand artifacts.
    people_text = f"{prompt} {full_prompt}".lower()
    multi_person_keywords = [
        "crowd", "group", "group of", "multiple people", "many people",
        "two people", "three people", "friends", "family", "couple",
        "children", "kids", "people cheering", "protest"
    ]
    is_multi_person_scene = any(kw in people_text for kw in multi_person_keywords)

    if is_multi_person_scene and style_norm not in ['anime', 'ui design', 'stitch']:
        # Keep composition manageable for realism (unless explicitly massive event).
        full_prompt = re.sub(r"\bmassive crowd\b", "small group of people", full_prompt, flags=re.IGNORECASE)
        full_prompt = re.sub(r"\bhuge crowd\b", "small group of people", full_prompt, flags=re.IGNORECASE)

        quality_suffix += (
            ", small group composition, 2 to 4 people maximum, all foreground faces visible and sharp, "
            "realistic eyes, natural facial symmetry, hands naturally positioned according to the action, "
            "no staged hand pose, no hand close-up unless the lyric explicitly requires it"
        )
        negative_prompt += (
            ", giant crowd, tiny distant faces, face blur, deformed face, malformed face, asymmetrical face, "
            "distorted eyes, fused fingers, joined fingers, hand merged with arm, arm merged with torso, "
            "overlapping limbs, tangled limbs, extra digits, posed hands, palms facing camera, "
            "hand close-up, hands dominating foreground, hand fused with cheek, hand fused with face, "
            "palm stuck to face, all people touching face"
        )

        if not is_lightning_model:
            old_steps = steps
            old_cfg = cfg
            steps = max(steps, 34)
            cfg = max(cfg, 5.2)
            if steps != old_steps or cfg != old_cfg:
                print(f"  👥 Multi-person boost: steps {old_steps}->{steps}, cfg {old_cfg}->{cfg}", file=sys.stderr)

    max_steps_env = os.getenv("COMFYUI_MAX_STEPS")
    if max_steps_env:
        try:
            max_steps = int(max_steps_env)
            if max_steps > 0 and steps > max_steps:
                old_steps = steps
                steps = max_steps
                print(f"  ⚙️ COMFYUI_MAX_STEPS active: {old_steps}->{steps}", file=sys.stderr)
        except ValueError:
            pass

    full_prompt = full_prompt + quality_suffix
    print(f"  🎨 Style Override V9: {style_norm if style_norm else 'None'} (Contrast Active)", file=sys.stderr)

    
    # Create unique client ID for this request
    client_id = str(uuid.uuid4())

    # ═══════════════════════════════════════════════════════════════════════════
    # VAE Selection: Use explicit SDXL VAE to prevent "deep fried" look
    # Baked VAEs in some checkpoints cause saturation issues
    # ═══════════════════════════════════════════════════════════════════════════
    vae_path = os.path.join(root_dir, "ComfyUI", "models", "vae", "sdxl_vae.safetensors")
    use_explicit_vae = os.path.exists(vae_path)
    if use_explicit_vae:
        print(f"  Using explicit SDXL VAE (anti-fry)", file=sys.stderr)
    else:
        print(f"  ⚠️ Explicit VAE DISABLED - using checkpoint VAE for testing", file=sys.stderr)

    # ═══════════════════════════════════════════════════════════════════════════
    # LO-RA ANATOMICAL ENGINE - Hand improvement LoRA
    # Only one working SDXL LoRA: hand_fine_tuning_sdxl.safetensors
    # ═══════════════════════════════════════════════════════════════════════════
    lora_filename = "hand_fine_tuning_sdxl.safetensors"
    lora_path = os.path.join(root_dir, "ComfyUI", "models", "loras", lora_filename)

    # Enable LoRA only when hand quality risk is relevant:
    # - multi-person scenes (more anatomy complexity)
    # - explicit hand-object actions in the verse prompt
    hand_action_keywords = [
        "hand gripping", "hands gripping", "fingers wrapped", "palm holding",
        "holding", "gripping", "clenched fist", "hands covering", "arms raised",
        "microphone", "glass", "fork", "cigarette", "praying", "drum", "guitar"
    ]
    lora_context = f"{prompt} {full_prompt}".lower()
    is_hand_action_scene = any(kw in lora_context for kw in hand_action_keywords)
    style_supports_lora = style_norm in ['realistic', 'cinematic', 'hyper', 'hyper realistic', 'photorealistic', '']
    force_disable_hand_lora = os.getenv("COMFYUI_DISABLE_HAND_LORA", "false").lower() == "true"
    use_hand_lora = (
        (not force_disable_hand_lora) and
        os.path.exists(lora_path) and
        style_supports_lora and
        (is_multi_person_scene or is_hand_action_scene)
    )

    lora_strength_model = 0.75
    lora_strength_clip = 0.45
    if is_hand_action_scene:
        lora_strength_model = 1.05
        lora_strength_clip = 0.85

    if use_hand_lora:
        context_tag = "HAND_ACTION" if is_hand_action_scene else "MULTI_PERSON"
        print(
            f"  🖐️ Hand LoRA Active: {lora_filename} ({context_tag}, "
            f"model={lora_strength_model}, clip={lora_strength_clip})",
            file=sys.stderr
        )
    else:
        if not os.path.exists(lora_path):
            print(f"  ⚠️ Hand LoRA not found: {lora_filename}", file=sys.stderr)
        elif not style_supports_lora:
            print(f"  ⚠️ Hand LoRA disabled for style: {style_norm}", file=sys.stderr)
        else:
            print("  ℹ️ Hand LoRA skipped (scene does not require hand-focused correction)", file=sys.stderr)

    style_lora_cfg = get_style_lora_config(style_norm)
    style_lora_filename = style_lora_cfg.get("loraFilename")
    style_lora_path = style_lora_cfg.get("loraPath")
    style_lora_strength_model = style_lora_cfg.get("strengthModel", 0.7)
    style_lora_strength_clip = style_lora_cfg.get("strengthClip", 0.7)
    use_style_lora = bool(style_lora_filename and style_lora_path and os.path.exists(style_lora_path))

    if use_style_lora:
        print(
            f"  [Style LoRA] Active: {style_lora_filename} "
            f"(model={style_lora_strength_model}, clip={style_lora_strength_clip})",
            file=sys.stderr
        )
    elif style_norm:
        print(f"  [Style LoRA] No trained LoRA configured for: {style_norm}", file=sys.stderr)

    disable_face_detailer = os.getenv("COMFYUI_DISABLE_FACE_DETAILER", "false").lower() == "true"
    use_face_detailer = not disable_face_detailer
    face_detailer_guide_size = 384
    face_detailer_steps = 6
    face_detailer_cfg = 1.5
    face_detailer_denoise = 0.25

    if is_multi_person_scene:
        # Stronger face refinement for group scenes.
        face_detailer_guide_size = 576
        face_detailer_steps = 12
        face_detailer_cfg = 2.8
        face_detailer_denoise = 0.35

    # Model source chain: checkpoint -> optional style LoRA -> optional hand LoRA
    base_model_source = ["4", 0]
    base_clip_source = ["4", 1]

    if use_style_lora:
        base_model_source = ["13", 0]
        base_clip_source = ["13", 1]

    model_source = base_model_source
    clip_source = base_clip_source

    if use_hand_lora:
        model_source = ["12", 0]
        clip_source = ["12", 1]

    # Image source: FaceDetailer output or direct from VAEDecode
    if use_face_detailer:
        image_output_source = ["11", 0]  # From FaceDetailer
        print(f"  Using FaceDetailer for face enhancement", file=sys.stderr)
    else:
        image_output_source = ["8", 0]   # Direct from VAEDecode (bypass FaceDetailer)
        print(f"  ⚠️ FaceDetailer DISABLED for isolation test", file=sys.stderr)

    # Basic text-to-image workflow
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "cfg": cfg,
                "denoise": 1,
                "latent_image": ["5", 0],
                "model": model_source,  # Checkpoint or LoRA chain source
                "negative": ["7", 0],
                "positive": ["6", 0],
                "sampler_name": sampler,
                "scheduler": "karras",
                "seed": scene_seed,  # Consistent protagonist seed
                "steps": steps
            }
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {
                "ckpt_name": model_checkpoint if model_checkpoint else "put_your_model_here.safetensors"
            }
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "batch_size": 1,
                "height": height,
                "width": width
            }
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": clip_source,  # Checkpoint or LoRA chain source
                "text": full_prompt
            }
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": clip_source,  # Checkpoint or LoRA chain source
                "text": negative_prompt
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["3", 0],
                "vae": ["14", 0] if use_explicit_vae else ["4", 2]  # Use explicit VAE if available
            }
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                # Include project_id for absolute traceability
                "filename_prefix": f"project_{project_id}_scene_{scene_index}",
                "images": image_output_source  # FaceDetailer or direct VAEDecode based on flag
            }
        }
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # VAELoader Node: Add only when explicit VAE is available
    # This prevents "deep fried" look from baked VAEs in some checkpoints
    # ═══════════════════════════════════════════════════════════════════════════
    if use_explicit_vae:
        workflow["14"] = {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": "sdxl_vae.safetensors"
            }
        }

    if use_style_lora:
        workflow["13"] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": style_lora_filename,
                "strength_model": style_lora_strength_model,
                "strength_clip": style_lora_strength_clip,
                "model": ["4", 0],
                "clip": ["4", 1]
            }
        }

    # ═══════════════════════════════════════════════════════════════════════════
    # LoRA Loader Node: Add only when use_hand_lora is True
    # CURRENTLY DISABLED: "hand 5.5" is likely SD1.5 LoRA incompatible with SDXL
    # ═══════════════════════════════════════════════════════════════════════════
    if use_hand_lora:
        workflow["12"] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": lora_filename,
                "strength_model": lora_strength_model,
                "strength_clip": lora_strength_clip,
                "model": base_model_source,
                "clip": base_clip_source
            }
        }

    # ═══════════════════════════════════════════════════════════════════════════
    # FaceDetailer Nodes: Add only when use_face_detailer is True
    # CURRENTLY DISABLED: Testing if FaceDetailer causes green tint artifacts
    # ═══════════════════════════════════════════════════════════════════════════
    if use_face_detailer:
        # Face detection using YOLO
        workflow["10"] = {
            "class_type": "UltralyticsDetectorProvider",
            "inputs": {
                "model_name": "bbox/face_yolov8m.pt"
            }
        }
        # FaceDetailer to fix faces
        workflow["11"] = {
            "class_type": "FaceDetailer",
            "inputs": {
                "image": ["8", 0],
                "model": model_source,
                "clip": clip_source,
                "vae": ["14", 0] if use_explicit_vae else ["4", 2],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "bbox_detector": ["10", 0],
                "sam_model_opt": None,
                "segm_detector_opt": None,
                "detailer_hook": None,
                "guide_size": face_detailer_guide_size,
                "guide_size_for": True,
                "max_size": 1024,
                "seed": scene_seed,
                "steps": face_detailer_steps,
                "cfg": face_detailer_cfg,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": face_detailer_denoise,
                "feather": 5,
                "noise_mask": True,
                "force_inpaint": True,
                "bbox_threshold": 0.5,
                "bbox_dilation": 10,
                "bbox_crop_factor": 3.0,
                "sam_detection_hint": "center-1",
                "sam_dilation": 0,
                "sam_threshold": 0.93,
                "sam_bbox_expansion": 0,
                "sam_mask_hint_threshold": 0.7,
                "sam_mask_hint_use_negative": "False",
                "drop_size": 10,
                "wildcard": "",
                "cycle": 1
            }
        }
    
    # Queue the prompt
    prompt_data = {
        "prompt": workflow,
        "client_id": client_id
    }
    
    try:
        # Send prompt to ComfyUI
        req = urllib.request.Request(
            f"{comfyui_url}/prompt",
            data=json.dumps(prompt_data).encode('utf-8'),
            headers={"Content-Type": "application/json"},
            method='POST'
        )
        
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode('utf-8'))
            prompt_id = result.get('prompt_id')
        
        if not prompt_id:
            raise Exception("No prompt_id returned from ComfyUI")
        
        print(f"  ComfyUI: Queued prompt {prompt_id} for scene {scene_index}", file=sys.stderr)
        
        # Poll for completion (max 10 minutes)
        max_wait = 600
        start_time = time.time()
        
        while time.time() - start_time < max_wait:
            elapsed = int(time.time() - start_time)
            # Emit periodic polling event so user sees script is alive
            # Emit periodic polling event with server status
            if elapsed % 10 == 0:
                server_status = check_comfyui_queue_status(comfyui_url)
                message = f"ComfyUI: {server_status} | Scene {scene_index+1} ({elapsed}s elapsed)"
                
                poll_event = {
                    "type": "progress",
                    "data": {
                        "progress": int((scene_index / 10) * 100),
                        "message": message
                    }
                }
                print(f"PROGRESS:{json.dumps(poll_event)}")
                sys.stdout.flush()
                print(f"  ... {message}", file=sys.stderr)

            # Check history for completion
            history_url = f"{comfyui_url}/history/{prompt_id}"
            req = urllib.request.Request(history_url)

            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    response_text = response.read().decode('utf-8')
                    if not response_text or response_text == '{}':
                        time.sleep(2)
                        continue

                    history = json.loads(response_text)

                    if prompt_id in history:
                        prompt_data = history[prompt_id]
                        status = prompt_data.get('status', {})

                        # Check if job failed
                        if status.get('status_str') == 'error':
                            error_msgs = status.get('messages', [])
                            raise Exception(f"ComfyUI workflow error: {error_msgs}")

                        # Check if job completed
                        if status.get('completed', False) or status.get('status_str') == 'success':
                            outputs = prompt_data.get('outputs', {})
                            # Find the SaveImage output
                            for node_id, output in outputs.items():
                                if 'images' in output:
                                    for img in output['images']:
                                        filename = img.get('filename')
                                        subfolder = img.get('subfolder', '')

                                        # Download the image
                                        img_url = f"{comfyui_url}/view?filename={filename}&subfolder={subfolder}&type=output"

                                        # Save locally with a clean, predictable name
                                        cache_dir = os.path.join(OUTPUT_DIR, 'cache')
                                        os.makedirs(cache_dir, exist_ok=True)
                                        local_path = os.path.join(cache_dir, f"project_{project_id}_scene_{scene_index}.png")

                                        img_req = urllib.request.Request(img_url)
                                        with urllib.request.urlopen(img_req, timeout=30) as img_response:
                                            with open(local_path, 'wb') as f:
                                                f.write(img_response.read())

                                        print(f"  ✓ Scene {scene_index} generated with ComfyUI", file=sys.stderr)
                                        return local_path

                            # If completed but no images found
                            print(f"  Warning: Job completed but no images in outputs", file=sys.stderr)

            except urllib.error.HTTPError as e:
                print(f"  HTTP error polling history: {e.code}", file=sys.stderr)
            except urllib.error.URLError as e:
                print(f"  URL error polling history: {e}", file=sys.stderr)
            except json.JSONDecodeError as e:
                print(f"  JSON error polling history: {e}", file=sys.stderr)
            except Exception as e:
                print(f"  Error polling history: {e}", file=sys.stderr)

            time.sleep(2)
        
        raise Exception(f"ComfyUI generation timed out after {max_wait}s")
        
    except urllib.error.URLError as e:
        raise Exception(f"Cannot connect to ComfyUI at {comfyui_url}. Is it running? Error: {e}")

def generate_mock_image(prompt: str, index: int) -> str:
    """Generate a mock placeholder image URL for testing"""
    _ = prompt  # prompt kept for signature compatibility
    return build_placeholder_image_url(f"Scene {index + 1}")

def build_fallback_image_data(scene_index: int, prompt: str, reason: str = "") -> dict:
    safe_prompt = (prompt or f"fallback scene {scene_index + 1}")[:200]
    fallback_url = generate_mock_image(safe_prompt, scene_index)
    return {
        "sceneIndex": scene_index,
        "prompt": safe_prompt,
        "imageUrl": to_web_url(fallback_url),
        "status": "success",
        "provider": "mock",
        "exposed": True,
        "exposureReason": f"fallback:{reason[:120]}" if reason else "fallback",
        "steeringApplied": False,
        "steeringMessage": None,
        "isFallback": True,
    }

def compute_status(degraded: bool, useful_output: bool) -> str:
    if not useful_output:
        return "failed"
    return "degraded" if degraded else "success"

def resolve_generation_concurrency(provider: str, total_scenes: int) -> int:
    """Resolve safe max worker count for concurrent image generation."""
    default_by_provider = {
        "comfyui": 4,
        "pollinations": 4,
        "replicate": 3,
        "artic": 4,
        "picsum": 6,
        "mock": 8,
    }
    default_workers = default_by_provider.get(provider, 4)
    env_value = os.getenv("IMAGE_GENERATION_CONCURRENCY")
    if env_value:
        try:
            default_workers = int(env_value)
        except ValueError:
            pass

    capped = max(1, min(default_workers, 8))
    if total_scenes > 0:
        return min(capped, total_scenes)
    return 1

def generate_scene_asset(
    provider: str,
    prompt: str,
    visual_style: str,
    api_token: str,
    img_width: int,
    img_height: int,
    scene_index: int,
    project_id: str,
    scene_verse_type: str,
    ai_optimization: dict,
) -> dict:
    """Generate one scene image (thread-safe worker function)."""
    actual_provider = provider
    scene_generation_error = None

    try:
        if provider == "mock":
            image_url = generate_mock_image(prompt, scene_index)
        elif provider == "replicate":
            image_url = generate_with_replicate(prompt, visual_style, api_token)
        elif provider == "picsum":
            image_url = generate_with_picsum(img_width, img_height, seed=scene_index)
        elif provider == "artic":
            image_url = generate_with_artic(prompt, scene_index)
        elif provider == "comfyui":
            image_url = generate_with_comfyui(
                prompt, visual_style,
                scene_index=scene_index,
                width=img_width,
                height=img_height,
                project_id=project_id,
                verse_type=scene_verse_type,
                ai_optimization=ai_optimization
            )
            actual_provider = "comfyui"
        else:
            image_url = generate_with_pollinations(
                prompt,
                visual_style,
                width=img_width,
                height=img_height,
                scene_index=scene_index
            )
            actual_provider = provider

        web_image_url = to_web_url(image_url)
    except Exception as scene_err:
        scene_generation_error = scene_err
        print(
            f"  Warning: scene {scene_index} generation failed, using fallback placeholder. "
            f"Error: {scene_err}",
            file=sys.stderr
        )
        web_image_url = build_fallback_image_data(scene_index, prompt, str(scene_err))["imageUrl"]
        actual_provider = "mock"

    return {
        "sceneIndex": scene_index,
        "prompt": prompt,
        "webImageUrl": web_image_url,
        "usedProvider": actual_provider,
        "sceneGenerationError": scene_generation_error,
    }

def generate_images():
    """Main function to generate images for a project"""
    try:
        # Get project ID from command line args
        if len(sys.argv) < 2:
            degraded = True
            useful_output = True
            fallback = {
                "status": compute_status(degraded, useful_output),
                "mode": "mock",
                "degraded": degraded,
                "message": "Project ID missing. Generated safe fallback output.",
                "totalScenes": 1,
                "generatedCount": 1,
                "failedCount": 0,
                "images": [build_fallback_image_data(0, "missing project id", "missing-project-id")]
            }
            emit_result(fallback)
            return fallback

        project_id = sys.argv[1]

        # 🧠 AI LEARNING: Parse optimization from NestJS (arg 3)
        ai_optimization = {"qualityBoost": "", "negativeBoost": "", "confidence": 0}
        if len(sys.argv) >= 4:
            try:
                ai_optimization = json.loads(sys.argv[3])
                if ai_optimization.get("confidence", 0) > 0:
                    print(f"🧠 AI Learning active (confidence: {int(ai_optimization['confidence'] * 100)}%)", file=sys.stderr)
                    if ai_optimization.get("qualityBoost"):
                        print(f"  ✨ Quality boost: {ai_optimization['qualityBoost']}", file=sys.stderr)
                    if ai_optimization.get("negativeBoost"):
                        print(f"  🚫 Negative boost: {ai_optimization['negativeBoost']}", file=sys.stderr)
            except (json.JSONDecodeError, IndexError):
                pass  # Use defaults if parsing fails

        # Determine which provider to use
        # Available providers:
        #   - replicate: AI-generated images (paid, needs REPLICATE_API_TOKEN)
        #   - pollinations: AI-generated images (free, uses Pollinations.ai)
        #   - picsum: Random beautiful photos (free, Lorem Picsum)
        #   - artic: Artwork from Art Institute of Chicago (free)
        #   - mock: Simple placeholder images for testing
        api_token = os.getenv("REPLICATE_API_TOKEN")
        image_provider = os.getenv("IMAGE_PROVIDER", "pollinations").lower()

        # Map provider names
        valid_providers = ["replicate", "pollinations", "picsum", "artic", "comfyui", "mock"]
        if image_provider == "replicate" and api_token:
            provider = "replicate"
        elif image_provider in valid_providers:
            provider = image_provider
        else:
            provider = "pollinations"  # Default: free AI-generated images

        print(json.dumps({
            "info": f"Using image provider: {provider}",
            "status": "starting"
        }), file=sys.stderr)

        # Fetch project analysis
        try:
            project = get_project_analysis(project_id)
            analysis = project.get("analysis", {})
            scenes = analysis.get("scenes", [])
            visual_style = project.get("visualStyle", "")
            aspect_ratio = project.get("aspectRatio", "16:9")
        except Exception as project_err:
            print(f"Warning: Could not fetch project analysis. Using fallback scene. Error: {project_err}", file=sys.stderr)
            project = {
                "id": project_id,
                "title": "",
                "analysis": {},
                "visualStyle": "",
                "aspectRatio": "16:9",
            }
            analysis = project.get("analysis", {})
            scenes = [{
                "verseText": "fallback scene",
                "visualPrompt": "a neutral cinematic portrait, casual clothes, high quality",
                "duration": 5
            }]
            visual_style = project.get("visualStyle", "")
            aspect_ratio = project.get("aspectRatio", "16:9")
        
        # Calculate dimensions based on aspect ratio
        # SDXL native resolution is 1024x1024 (~1 megapixel)
        # Using native res prevents "twin/clone" artifacts from model filling excess latent space
        aspect_dimensions = {
            "16:9": (1280, 720),   # Standard HD (0.92MP) - Perfect for SDXL
            "9:16": (720, 1280),   # Vertical HD
            "1:1": (1024, 1024),   # Square (1.05MP)
            "4:3": (1152, 896),    # Optimal SDXL 4:3
        }
        img_width, img_height = aspect_dimensions.get(aspect_ratio, (1280, 720))
        print(f"Using aspect ratio {aspect_ratio}: {img_width}x{img_height}", file=sys.stderr)

        if not scenes:
            scenes = [{
                "verseText": "fallback scene",
                "visualPrompt": "a neutral cinematic portrait, casual clothes, high quality",
                "duration": 5
            }]
            print("Warning: No scenes found in analysis. Injected fallback scene.", file=sys.stderr)

        # Ensure output directory exists
        os.makedirs(OUTPUT_DIR, exist_ok=True)

        generated_images = []

        # ═══════════════════════════════════════════════════════════════════════════
        # CASTING MODE: protagonist_base starts as None
        # First frame with score >= 6 becomes the ANCHOR
        # ═══════════════════════════════════════════════════════════════════════════
        protagonist_base = None  # Will be set by first perfect frame
        total_scenes = len(scenes)
        max_workers = resolve_generation_concurrency(provider, total_scenes)
        print(
            f"Parallel generation enabled: workers={max_workers}, provider={provider}, scenes={total_scenes}",
            file=sys.stderr
        )

        # Emit initial progress event IMMEDIATELY so user sees something
        initial_event = {
            "type": "progress",
            "data": {
                "progress": 0,
                "message": (
                    f"Starting generation of {total_scenes} images... "
                    f"(CASTING MODE: looking for anchor, workers={max_workers})"
                )
            }
        }
        print(f"PROGRESS:{json.dumps(initial_event)}")
        sys.stdout.flush()

        def finalize_scene(scene_payload: dict):
            nonlocal protagonist_base
            i = scene_payload["sceneIndex"]
            scene = scene_payload["scene"]
            prompt = scene_payload["prompt"]
            web_image_url = scene_payload["webImageUrl"]
            used_provider = scene_payload["usedProvider"]
            scene_generation_error = scene_payload["sceneGenerationError"]
            steering_applied = scene_payload["steeringApplied"]
            steering_message = scene_payload["steeringMessage"]

            # ═══════════════════════════════════════════════════════════════════════
            # FRAME EXPOSURE DECISION - CASTING MODE + CONTINUITY GUARD
            # ═══════════════════════════════════════════════════════════════════════
            should_expose = True
            exposure_reason = "No quality check"
            set_as_anchor = False

            if EXPOSER_AVAILABLE and provider == "comfyui":
                verse_type = scene.get("verseType", "NARRATIVE")
                verse_text = scene.get("verseText", "")

                exposure_result = full_exposure_check(
                    image_prompt=prompt,
                    verse_type=verse_type,
                    protagonist_base=protagonist_base,
                    verse_text=verse_text
                )
                should_expose = exposure_result.get("expose", True)
                exposure_reason = exposure_result.get("reason", "")
                set_as_anchor = exposure_result.get("set_as_anchor", False)
                mode = exposure_result.get("checks", {}).get("mode", "UNKNOWN")

                if set_as_anchor and protagonist_base is None:
                    protagonist_base = prompt
                    print(f"  🎬 ANCHOR ESTABLISHED! Frame {i} becomes protagonist base", file=sys.stderr)
                    print(f"     Base: {prompt[:80]}...", file=sys.stderr)

                if not should_expose:
                    print(f"  ⚠️ [{mode}] Frame NOT exposed: {exposure_reason}", file=sys.stderr)
                else:
                    print(f"  ✓ [{mode}] Frame exposed: {exposure_reason}", file=sys.stderr)

            image_data = {
                "sceneIndex": i,
                "prompt": prompt[:200],
                "imageUrl": web_image_url,
                "status": "success",
                "provider": used_provider,
                "exposed": should_expose,
                "exposureReason": exposure_reason,
                "steeringApplied": steering_applied,
                "steeringMessage": steering_message if steering_applied else None,
                "isFallback": scene_generation_error is not None
            }
            generated_images.append(image_data)

            # Emit real-time progress event for WebSocket + Redis
            progress_percent = int(((i + 1) / total_scenes) * 100)
            scene_verse_type = scene.get("verseType", "NARRATIVE")

            if should_expose:
                if REDIS_EVENTS_AVAILABLE:
                    emit_image_generated(
                        project_id=project_id,
                        scene_index=i,
                        total_scenes=total_scenes,
                        image_url=web_image_url,
                        prompt=prompt[:100],
                        exposed=True,
                        verse_type=scene_verse_type
                    )
                else:
                    progress_event = {
                        "type": "image_generated",
                        "data": {
                            "sceneIndex": i,
                            "totalScenes": total_scenes,
                            "imageUrl": web_image_url,
                            "prompt": prompt[:100],
                            "exposed": True
                        }
                    }
                    print(f"PROGRESS:{json.dumps(progress_event)}")
            else:
                if REDIS_EVENTS_AVAILABLE:
                    emit_frame_skipped(
                        project_id=project_id,
                        scene_index=i,
                        total_scenes=total_scenes,
                        reason=exposure_reason
                    )
                else:
                    skip_event = {
                        "type": "frame_skipped",
                        "data": {
                            "sceneIndex": i,
                            "totalScenes": total_scenes,
                            "reason": exposure_reason
                        }
                    }
                    print(f"PROGRESS:{json.dumps(skip_event)}")

            if REDIS_EVENTS_AVAILABLE:
                emit_progress(
                    project_id=project_id,
                    progress=progress_percent,
                    message=f"Generated image {i+1}/{total_scenes}"
                )
            else:
                db_progress_event = {
                    "type": "progress",
                    "data": {
                        "progress": progress_percent,
                        "message": f"Generated image {i+1}/{total_scenes}"
                    }
                }
                print(f"PROGRESS:{json.dumps(db_progress_event)}")
            sys.stdout.flush()
            print(f"DEBUG: Emitted progress for scene {i} ({progress_percent}%)", file=sys.stderr)

        pending_futures = {}
        completed_scene_payloads = {}
        next_scene_to_schedule = 0
        next_scene_to_finalize = 0

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            while next_scene_to_schedule < total_scenes or pending_futures:
                # Fill worker queue
                while next_scene_to_schedule < total_scenes and len(pending_futures) < max_workers:
                    i = next_scene_to_schedule
                    next_scene_to_schedule += 1

                    scene = scenes[i]
                    prompt = scene.get("visualPrompt", scene.get("description", ""))
                    scene_verse_type = scene.get("verseType", None)
                    if not prompt:
                        continue

                    casting_status = "CASTING" if protagonist_base is None else "CONTINUITY"
                    starting_event = {
                        "type": "progress",
                        "data": {
                            "progress": int((i / total_scenes) * 100),
                            "message": f"[{casting_status}] Generating image {i+1} of {total_scenes}..."
                        }
                    }
                    print(f"PROGRESS:{json.dumps(starting_event)}")
                    sys.stdout.flush()
                    print(f"  [{casting_status}] Starting scene {i+1}/{total_scenes}: {prompt[:60]}...", file=sys.stderr)

                    steering_applied = False
                    steering_message = ""
                    if STEERING_AVAILABLE and provider == "comfyui":
                        base_cfg = 5.0
                        base_seed = int(__import__('hashlib').md5(project_id.encode()).hexdigest()[:8], 16) % 1000000
                        base_seed = base_seed + (i * 111)

                        steering_result = check_and_apply_steering(
                            project_id=project_id,
                            scene_index=i,
                            prompt=prompt,
                            negative_prompt="",
                            cfg=base_cfg,
                            seed=base_seed,
                            verse_type=scene_verse_type or "NARRATIVE"
                        )

                        if steering_result.get("was_modified", False):
                            steering_applied = True
                            steering_message = steering_result.get("message", "")
                            prompt = steering_result["prompt"]
                            steering_cfg_override = steering_result.get("cfg", base_cfg)
                            steering_seed_override = steering_result.get("seed", base_seed)

                            print(f"  🎬 STEERING: {steering_message}", file=sys.stderr)
                            if REDIS_EVENTS_AVAILABLE:
                                emit_steering_applied(
                                    project_id=project_id,
                                    signal_type=steering_result.get("signal_type", "unknown"),
                                    scene_index=i,
                                    message=steering_message,
                                    modifications={
                                        "cfg": steering_cfg_override,
                                        "seed": steering_seed_override,
                                        "prompt_modified": True
                                    }
                                )

                    scene_task = {
                        "sceneIndex": i,
                        "scene": scene,
                        "prompt": prompt,
                        "sceneVerseType": scene_verse_type,
                        "steeringApplied": steering_applied,
                        "steeringMessage": steering_message,
                    }

                    future = executor.submit(
                        generate_scene_asset,
                        provider,
                        prompt,
                        visual_style,
                        api_token,
                        img_width,
                        img_height,
                        i,
                        project_id,
                        scene_verse_type,
                        ai_optimization,
                    )
                    pending_futures[future] = scene_task

                if not pending_futures:
                    continue

                done, _ = wait(list(pending_futures.keys()), return_when=FIRST_COMPLETED)
                for future in done:
                    task = pending_futures.pop(future)
                    i = task["sceneIndex"]
                    try:
                        worker_result = future.result()
                    except Exception as worker_err:
                        worker_result = {
                            "sceneIndex": i,
                            "prompt": task["prompt"],
                            "webImageUrl": build_fallback_image_data(i, task["prompt"], str(worker_err))["imageUrl"],
                            "usedProvider": "mock",
                            "sceneGenerationError": worker_err,
                        }
                    completed_scene_payloads[i] = {
                        **task,
                        **worker_result,
                    }

                # Finalize strictly in timeline order to preserve continuity logic.
                while next_scene_to_finalize < total_scenes:
                    scene = scenes[next_scene_to_finalize]
                    scene_prompt = scene.get("visualPrompt", scene.get("description", ""))
                    if not scene_prompt:
                        next_scene_to_finalize += 1
                        continue
                    payload = completed_scene_payloads.pop(next_scene_to_finalize, None)
                    if payload is None:
                        break
                    finalize_scene(payload)
                    next_scene_to_finalize += 1

        # Save to database
        db_save_warning = None
        try:
            save_generated_images(project_id, generated_images)
        except Exception as save_err:
            db_save_warning = str(save_err)
            print(f"Warning: Could not persist generated images in DB: {save_err}", file=sys.stderr)

        # Output result
        generated_count = len([img for img in generated_images if img["status"] == "success"])
        failed_count = len([img for img in generated_images if img["status"] == "failed"])
        degraded = any(img.get("isFallback") for img in generated_images) or bool(db_save_warning)
        useful_output = generated_count > 0
        result = {
            "status": compute_status(degraded, useful_output),
            "success": useful_output,
            "totalScenes": len(scenes),
            "generatedCount": generated_count,
            "failedCount": failed_count,
            "images": generated_images,
            "mode": provider,
            "degraded": degraded,
            "dbSaveWarning": db_save_warning,
        }

        emit_result(result)
        return result

    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8', errors='replace')
        degraded = True
        useful_output = True
        fallback = {
            "status": compute_status(degraded, useful_output),
            "success": useful_output,
            "mode": "mock",
            "degraded": degraded,
            "message": "HTTP error in generation pipeline; returning fallback output.",
            "error": f"HTTP {e.code}",
            "details": error_msg[:800],
            "totalScenes": 1,
            "generatedCount": 1,
            "failedCount": 0,
            "images": [build_fallback_image_data(0, "http failure fallback", f"http-{e.code}")],
        }
        emit_result(fallback)
        return fallback
    except Exception as e:
        degraded = True
        useful_output = True
        fallback = {
            "status": compute_status(degraded, useful_output),
            "success": useful_output,
            "mode": "mock",
            "degraded": degraded,
            "message": "Unhandled error in generation pipeline; returning fallback output.",
            "error": str(e),
            "type": type(e).__name__,
            "totalScenes": 1,
            "generatedCount": 1,
            "failedCount": 0,
            "images": [build_fallback_image_data(0, "unhandled failure fallback", str(e))],
        }
        emit_result(fallback)
        return fallback

if __name__ == "__main__":
    generate_images()

