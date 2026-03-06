#!/usr/bin/env python3
"""
FULL AUTOMATIC PIPELINE: YouTube URL → Video with Images
1. Download audio from YouTube (yt-dlp)
2. Transcribe lyrics with Whisper
3. Analyze lyrics with Gemini (literal interpretation)
4. Generate images with ComfyUI
5. Render video with FFmpeg

Usage: python auto_generate_video.py "https://youtu.be/VIDEO_ID"
"""
import sys
import os
import json
import subprocess
import urllib.request
import time
from dotenv import load_dotenv
from ffmpeg_utils import resolve_ffmpeg_path

# Setup paths
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

OUTPUT_DIR = os.path.join(root_dir, "output")
AUDIO_DIR = os.path.join(OUTPUT_DIR, "audio")
CACHE_DIR = os.path.join(OUTPUT_DIR, "images", "cache")
VIDEO_DIR = os.path.join(OUTPUT_DIR, "videos")

# Ensure directories exist
for d in [AUDIO_DIR, CACHE_DIR, VIDEO_DIR]:
    os.makedirs(d, exist_ok=True)

def download_audio(youtube_url: str) -> str:
    """Download audio from YouTube using yt-dlp"""
    print("\n📥 Step 1: Downloading audio from YouTube...")
    
    # Extract video ID for filename
    video_id = youtube_url.split("v=")[-1].split("&")[0].split("?")[0]
    if "youtu.be/" in youtube_url:
        video_id = youtube_url.split("youtu.be/")[-1].split("?")[0]
    
    output_path = os.path.join(AUDIO_DIR, f"{video_id}.mp3")
    
    if os.path.exists(output_path):
        print(f"   ✅ Audio already exists: {output_path}")
        return output_path
    
    try:
        cmd = [
            "yt-dlp",
            "-x", "--audio-format", "mp3",
            "-o", output_path.replace(".mp3", ".%(ext)s"),
            youtube_url
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"   ✅ Downloaded: {output_path}")
        return output_path
    except FileNotFoundError:
        print("   ❌ yt-dlp not found. Install with: pip install yt-dlp")
        return None
    except subprocess.CalledProcessError as e:
        print(f"   ❌ Download failed: {e}")
        return None

def download_thumbnail(youtube_url: str) -> str:
    """Download YouTube thumbnail"""
    print("\n🖼️ Downloading thumbnail...")
    
    # Extract video ID
    if "youtu.be/" in youtube_url:
        video_id = youtube_url.split("youtu.be/")[-1].split("?")[0]
    else:
        video_id = youtube_url.split("v=")[-1].split("&")[0]
    
    thumbnail_path = os.path.join(CACHE_DIR, f"thumbnail_{video_id}.jpg")
    
    if os.path.exists(thumbnail_path):
        print(f"   ✅ Thumbnail exists: {thumbnail_path}")
        return thumbnail_path
    
    # Try different quality thumbnails
    urls = [
        f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
        f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
        f"https://img.youtube.com/vi/{video_id}/0.jpg"
    ]
    
    for url in urls:
        try:
            urllib.request.urlretrieve(url, thumbnail_path)
            # Check if it's a valid image (not placeholder)
            if os.path.getsize(thumbnail_path) > 1000:
                print(f"   ✅ Downloaded: {thumbnail_path}")
                return thumbnail_path
        except (urllib.error.URLError, OSError):
            continue
    
    print("   ⚠️ Could not download thumbnail")
    return None

def transcribe_audio(audio_path: str) -> dict:
    """Transcribe audio using Whisper, returns text and timestamps"""
    print("\n🎤 Step 2: Transcribing with Whisper...")
    
    try:
        import whisper
    except ImportError:
        print("   ❌ Whisper not installed. Installing...")
        subprocess.run([sys.executable, "-m", "pip", "install", "openai-whisper"], check=True)
        import whisper
    
    print("   Loading Whisper model (medium - better accuracy)...")
    model = whisper.load_model("medium")  # Options: tiny, base, small, medium, large
    
    print("   Transcribing (this may take a few minutes)...")
    result = model.transcribe(audio_path)
    
    lyrics = result["text"]
    language = result.get("language", "unknown")
    segments = result.get("segments", [])
    
    # Extract timestamps for each segment
    timed_segments = []
    for seg in segments:
        timed_segments.append({
            "text": seg.get("text", "").strip(),
            "start": seg.get("start", 0),
            "end": seg.get("end", 0)
        })
    
    print(f"   ✅ Transcribed! Language: {language}, Segments: {len(timed_segments)}")
    print(f"   Preview: {lyrics[:200]}...")
    
    # Find intro duration (time before first lyrics)
    intro_duration = timed_segments[0]["start"] if timed_segments else 0
    print(f"   Intro duration: {intro_duration:.1f}s")
    
    return {
        "text": lyrics,
        "language": language,
        "segments": timed_segments,
        "intro_duration": intro_duration
    }

def analyze_lyrics(lyrics: str) -> dict:
    """Analyze lyrics using Gemini API"""
    print("\nStep 3: Analyzing lyrics with Gemini...")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("   Warning: GEMINI_API_KEY not found in .env, using fallback analysis")
        return {
            "sentiment": "nostalgic",
            "mood": "fallback analysis",
            "keywords": [],
            "colorSuggestions": ["#4ECDC4", "#355070", "#FFD166"],
            "scenes": [{
                "verseText": lyrics[:120] if lyrics else "instrumental moment",
                "visualPrompt": "a cinematic portrait, casual clothes, high quality, dramatic lighting",
                "duration": 5,
            }],
            "totalScenes": 1,
            "_model": "fallback-local",
            "degraded": True,
        }

    from analyze_lyrics import analyze_with_gemini

    try:
        analysis = analyze_with_gemini(lyrics, "photorealistic, dramatic lighting", api_key)
    except Exception as e:
        print(f"   Warning: Gemini analysis failed, using fallback: {e}")
        analysis = {
            "sentiment": "nostalgic",
            "mood": "fallback analysis",
            "keywords": [],
            "colorSuggestions": ["#4ECDC4", "#355070", "#FFD166"],
            "scenes": [{
                "verseText": lyrics[:120] if lyrics else "instrumental moment",
                "visualPrompt": "a cinematic portrait, casual clothes, high quality, dramatic lighting",
                "duration": 5,
            }],
            "totalScenes": 1,
            "_model": "fallback-local",
            "degraded": True,
        }

    print(f"   Analysis complete! {analysis.get('totalScenes', 0)} scenes generated")
    print(f"   Sentiment: {analysis.get('sentiment')}")
    print(f"   Mood: {analysis.get('mood')}")

    return analysis
def generate_images(analysis: dict) -> list:
    """Generate images for each scene using ComfyUI"""
    print("\n🎨 Step 4: Generating images with ComfyUI...")
    
    from generate_images import generate_with_comfyui
    
    scenes = analysis.get("scenes", [])
    image_paths = []
    
    for i, scene in enumerate(scenes[:6]):  # Limit to 6 scenes for testing
        print(f"\n   Scene {i+1}/{min(len(scenes), 6)}: {scene.get('verseText', '')[:50]}...")
        
        try:
            image_path = generate_with_comfyui(
                prompt=scene.get("visualPrompt", ""),
                style="photorealistic, cinematic",
                width=1024,
                height=1024,
                scene_index=i
            )
            image_paths.append({
                "path": image_path,
                "duration": scene.get("duration", 5),
                "verse": scene.get("verseText", "")
            })
            print(f"   ✅ Generated: {os.path.basename(image_path)}")
        except Exception as e:
            print(f"   ❌ Error: {e}")
    
    return image_paths

def render_video(audio_path: str, images: list, output_name: str) -> str:
    """Render final video using FFmpeg"""
    print("\n🎬 Step 5: Rendering video...")
    
    import shutil
    
    # FFmpeg path
    FFMPEG_PATH = resolve_ffmpeg_path(root_dir)
    
    TEMP_DIR = os.path.join(OUTPUT_DIR, "temp_render")
    output_path = os.path.join(VIDEO_DIR, f"{output_name}.mp4")
    
    # Prepare temp dir
    if os.path.exists(TEMP_DIR):
        shutil.rmtree(TEMP_DIR)
    os.makedirs(TEMP_DIR)
    
    try:
        # Render individual clips
        clip_files = []
        for i, img_data in enumerate(images):
            img_path = img_data["path"]
            duration = img_data.get("duration", 5)
            
            if not os.path.exists(img_path):
                print(f"   ⚠️ Image not found: {img_path}")
                continue
            
            clip_path = os.path.join(TEMP_DIR, f"clip_{i:03d}.mp4")
            frames = int(duration * 25)
            
            cmd = [
                FFMPEG_PATH, '-y',
                '-loop', '1',
                '-i', img_path,
                '-vf', f"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='min(zoom+0.0005,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps=25,setsar=1",
                '-c:v', 'libx264',
                '-t', str(duration),
                '-pix_fmt', 'yuv420p',
                '-preset', 'fast',
                clip_path
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                clip_files.append(clip_path)
                print(f"   ✅ Clip {i+1}/{len(images)}")
            else:
                print(f"   ❌ Error rendering clip {i}")
        
        if not clip_files:
            print("   ❌ No clips to concatenate")
            return None
        
        # Create concat list
        concat_list = os.path.join(TEMP_DIR, "mylist.txt")
        with open(concat_list, "w") as f:
            for clip in clip_files:
                f.write(f"file '{clip.replace(chr(92), '/')}'\n")
        
        if audio_path and os.path.exists(audio_path):
            print("   🔄 Concatenating clips with audio...")
            cmd = [
                FFMPEG_PATH, '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concat_list,
                '-i', audio_path,
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '192k',
                '-map', '0:v', '-map', '1:a',
                '-shortest',
                '-movflags', '+faststart',
                output_path
            ]
        else:
            print("   🔄 Concatenating clips without audio (fallback mode)...")
            cmd = [
                FFMPEG_PATH, '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concat_list,
                '-c:v', 'copy',
                '-an',
                '-movflags', '+faststart',
                output_path
            ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"   ❌ Concatenation failed: {result.stderr[:500]}")
            return None
        
        print(f"   ✅ Video saved: {output_path}")
        return output_path
        
    finally:
        # Cleanup temp
        if os.path.exists(TEMP_DIR):
            try:
                shutil.rmtree(TEMP_DIR)
            except OSError:
                pass  # Ignore cleanup errors

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Automatic Video Generation from YouTube")
    parser.add_argument("url", help="YouTube URL")
    parser.add_argument("--lyrics", "-l", help="Path to lyrics file (skip Whisper transcription)")
    args = parser.parse_args()
    
    youtube_url = args.url
    lyrics_file = args.lyrics
    
    print("=" * 60)
    print("🎥 AUTOMATIC VIDEO GENERATION PIPELINE")
    print("=" * 60)
    print(f"Source: {youtube_url}")
    if lyrics_file:
        print(f"Lyrics: {lyrics_file} (manual)")
    degraded_reasons = []
    
    # Step 1a: Download audio
    audio_path = download_audio(youtube_url)
    if not audio_path:
        degraded_reasons.append("audio_download_failed")
    
    # Step 1b: Download thumbnail for intro
    thumbnail_path = download_thumbnail(youtube_url)
    
    # Step 2: Get lyrics (from file or Whisper)
    lyrics_text = ""
    intro_duration = 3.0
    segments = []
    if lyrics_file:
        # Manual lyrics from file
        print(f"\n📄 Step 2: Loading lyrics from file...")
        try:
            with open(lyrics_file, "r", encoding="utf-8") as f:
                lyrics_text = f.read()
            print(f"   ✅ Loaded {len(lyrics_text)} characters")
            intro_duration = 3.0  # Default intro for manual lyrics
        except Exception as e:
            print(f"   ⚠️ Error reading lyrics file: {e}")
            degraded_reasons.append("lyrics_file_read_failed")
            lyrics_text = "instrumental moment"
    else:
        # Automatic transcription with Whisper
        transcription = transcribe_audio(audio_path) if audio_path else None
        if not transcription:
            degraded_reasons.append("transcription_failed")
            lyrics_text = "instrumental moment"
        else:
            lyrics_text = transcription["text"]
            intro_duration = transcription.get("intro_duration", 0)
            segments = transcription.get("segments", [])
    
    # Step 3: Analyze
    analysis = analyze_lyrics(lyrics_text)
    if not analysis:
        degraded_reasons.append("analysis_failed")
        analysis = {
            "sentiment": "nostalgic",
            "mood": "fallback analysis",
            "keywords": [],
            "colorSuggestions": ["#4ECDC4", "#355070", "#FFD166"],
            "scenes": [{
                "verseText": lyrics_text[:120] if lyrics_text else "instrumental moment",
                "visualPrompt": "a cinematic portrait, casual clothes, high quality, dramatic lighting",
                "duration": 5,
            }],
            "totalScenes": 1,
            "_model": "fallback-local",
            "degraded": True,
        }
    
    # Enhance analysis scenes with timestamps from Whisper
    scenes = analysis.get("scenes", [])
    for i, scene in enumerate(scenes):
        if i < len(segments):
            seg = segments[i] if i < len(segments) else {}
            scene["start_time"] = seg.get("start", i * 5)
            scene["end_time"] = seg.get("end", (i + 1) * 5)
            scene["duration"] = scene["end_time"] - scene["start_time"]
    
    # Save analysis for debugging
    analysis_path = os.path.join(OUTPUT_DIR, "last_analysis.json")
    try:
        with open(analysis_path, "w", encoding="utf-8") as f:
            json.dump(analysis, f, indent=2, ensure_ascii=False)
        print(f"\n📄 Analysis saved to: {analysis_path}")
    except Exception as e:
        degraded_reasons.append("analysis_save_failed")
        print(f"\n⚠️ Could not save analysis file: {e}")
    
    # Step 4: Generate images
    images = generate_images(analysis) or []
    if not images:
        degraded_reasons.append("image_generation_empty")
    
    # Add thumbnail as first image (intro) - minimum 3 seconds
    if thumbnail_path and os.path.exists(thumbnail_path):
        thumb_duration = max(intro_duration, 3.0)  # At least 3 seconds
        images.insert(0, {
            "path": thumbnail_path,
            "duration": thumb_duration,
            "verse": "Intro"
        })
        print(f"\n🖼️ Added thumbnail as intro ({thumb_duration:.1f}s)")
    
    # Step 5: Render video
    # Extract video ID properly
    if "youtu.be/" in youtube_url:
        video_id = youtube_url.split("youtu.be/")[-1].split("?")[0][:11]
    else:
        video_id = youtube_url.split("v=")[-1].split("&")[0][:11]
    
    output_path = render_video(audio_path, images, f"auto_{video_id}")
    if not output_path:
        degraded_reasons.append("video_render_failed")
    
    print("\n" + "=" * 60)
    print("✅ PIPELINE COMPLETE!")
    print("=" * 60)
    useful_video = bool(output_path and os.path.exists(output_path))
    degraded = len(degraded_reasons) > 0
    status = "failed" if not useful_video else ("degraded" if degraded else "success")
    result = {
        "status": status,
        "degraded": degraded,
        "degradedReasons": degraded_reasons,
        "lyricsLength": len(lyrics_text or ""),
        "scenesAnalyzed": analysis.get("totalScenes", 0),
        "imagesGenerated": len(images),
        "videoPath": output_path,
        "analysisModel": analysis.get("_model", "unknown"),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result

if __name__ == "__main__":
    main()

