#!/usr/bin/env python3
"""
Render test video using robust Multi-Pass approach
"""
import subprocess
import os
import sys
import shutil
from ffmpeg_utils import resolve_ffmpeg_path

# Paths
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_PATH = os.path.join(ROOT_DIR, "output", "audio", "La Construccion.mp3")
OUTPUT_PATH = os.path.join(ROOT_DIR, "output", "videos", "La_Construccion_test.mp4")
CACHE_DIR = os.path.join(ROOT_DIR, "output", "images", "cache")
TEMP_DIR = os.path.join(ROOT_DIR, "output", "temp_render")

# FFmpeg path
FFMPEG_PATH = resolve_ffmpeg_path(ROOT_DIR)

# Images generated from the pipeline test
IMAGES = [
    os.path.join(CACHE_DIR, "youtube_thumbnail.jpg"),  # Intro
    os.path.join(CACHE_DIR, "comfyui_0_comfyui_scene_0_00002_.png"),
    os.path.join(CACHE_DIR, "comfyui_1_comfyui_scene_1_00001_.png"),
    os.path.join(CACHE_DIR, "comfyui_2_comfyui_scene_2_00001_.png"),
    os.path.join(CACHE_DIR, "comfyui_3_comfyui_scene_3_00001_.png"),
    os.path.join(CACHE_DIR, "comfyui_4_comfyui_scene_4_00001_.png"),
]

# Timings
DURATIONS = [25, 6, 8, 14, 3, 11]
TOTAL_VIDEO_DURATION = sum(DURATIONS)

def create_srt(path):
    # Lyrics timestamps are:
    # 0:25 Intro ends
    # 0:25 - 0:31: Quiero ver niños... (6s)
    # 0:31 - 0:39: No quiero verlos... (8s)
    # 0:39 - 0:53: Cuánta violencia... (14s)
    # 0:53 - 0:56: El bienestar... (3s)
    # 0:56 - 1:07: Cuántas familias... (11s)
    
    subs = [
        (0, 25, "La Construcción"), # Intro Title
        (25, 31, "Quiero ver niños en las calles jugando"),
        (31, 39, "No quiero verlos más trabajando"),
        (39, 53, "Cuánta violencia, cuánta corrupción,\nno a la guerra, sí a la educación"),
        (53, 56, "El bienestar de mi pueblo quiero ver"),
        (56, 67, "Cuántas familias no tienen para comer")
    ]
    
    with open(path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(subs):
            # Format time: 00:00:00,000
            start_time = f"00:00:{start:02d},000"
            end_time = f"00:00:{end:02d},000"
            f.write(f"{i+1}\n")
            f.write(f"{start_time} --> {end_time}\n")
            f.write(f"{text}\n\n")

def render_clip(index, image_path, duration):
    output_clip = os.path.join(TEMP_DIR, f"clip_{index:03d}.mp4")
    print(f"   Rendering clip {index+1}/{len(IMAGES)}: {os.path.basename(image_path)} ({duration}s)...")
    
    # Calculate frames for zoompan
    frames = int(duration * 25)
    
    # Create individual clip with zoom effect
    # We force format to yuv420p and explicit framerate
    cmd = [
        FFMPEG_PATH, '-y',
        '-loop', '1',
        '-i', image_path,
        '-vf', 
        f"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='min(zoom+0.0005,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps=25,setsar=1",
        '-c:v', 'libx264',
        '-t', str(duration),
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast', # Fast for testing
        output_clip
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"❌ Error rendering clip {index}: {result.stderr[:500]}")
        return None
    return output_clip

def render_video():
    print("=" * 60)
    print("🎬 RENDERING VIDEO (MULTI-PASS METHOD)")
    print("=" * 60)
    
    # Verify files
    if not os.path.exists(AUDIO_PATH):
        print(f"❌ Audio not found: {AUDIO_PATH}")
        return False
        
    for img in IMAGES:
        if not os.path.exists(img):
            print(f"❌ Image not found: {img}")
            return False

    # Prepare temp dir
    if os.path.exists(TEMP_DIR):
        shutil.rmtree(TEMP_DIR)
    os.makedirs(TEMP_DIR)
    
    # Create SRT file for subtitles
    srt_path = os.path.join(TEMP_DIR, "subtitles.srt")
    create_srt(srt_path)
    print(f"📝 Subtitles created: {srt_path}")

    try:
        # 1. Render individual clips
        clip_files = []
        for i, (img, duration) in enumerate(zip(IMAGES, DURATIONS)):
            clip_path = render_clip(i, img, duration)
            if clip_path:
                clip_files.append(clip_path)
            else:
                return False
        
        # 2. Create concat list file
        concat_list_path = os.path.join(TEMP_DIR, "mylist.txt")
        # Use absolute paths with forward slashes to avoid FFmpeg issues
        with open(concat_list_path, "w") as f:
            for clip in clip_files:
                path = clip.replace("\\", "/")
                f.write(f"file '{path}'\n")
        
        print("\n🔄 Concatenating clips with audio and subtitles...")
        
        # 3. Concatenate and Burn Subtitles
        # Note: 'subtitles' filter requires the path to be escaped properly on Windows
        # A simple way is to use forward slashes.
        srt_path_ffmpeg = srt_path.replace("\\", "/").replace(":", "\\:")
        
        cmd = [
            FFMPEG_PATH, '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concat_list_path,
            '-i', AUDIO_PATH,
            '-filter_complex', f"[0:v]subtitles='{srt_path_ffmpeg}':force_style='Fontname=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1'[v]",
            '-map', '[v]',
            '-map', '1:a',
            '-c:v', 'libx264', # Must re-encode to burn subtitles
            '-c:a', 'aac',
            '-b:a', '192k',
            '-t', str(TOTAL_VIDEO_DURATION), # Limit to video duration
            '-movflags', '+faststart',
            OUTPUT_PATH
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"❌ Merge error: {result.stderr[:1000]}")
            # Fallback without subtitles if filter fails
            print("⚠️  Trying without subtitles...")
            cmd_fallback = [
                FFMPEG_PATH, '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concat_list_path, '-i', AUDIO_PATH,
                '-c:v', 'copy', '-c:a', 'aac', '-map', '0:v', '-map', '1:a',
                OUTPUT_PATH
            ]
            subprocess.run(cmd_fallback)
            
        print(f"\n✅ SUCCESS! Video saved to:\n   {OUTPUT_PATH}")
        return True
        
    finally:
        # Cleanup temp
        if os.path.exists(TEMP_DIR):
            try:
                shutil.rmtree(TEMP_DIR)
            except OSError:
                pass  # Ignore cleanup errors

if __name__ == "__main__":
    success = render_video()
    sys.exit(0 if success else 1)
