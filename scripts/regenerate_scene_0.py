#!/usr/bin/env python3
"""
Regenerate specific scene with better quality settings
"""
import sys
import os
import time
from dotenv import load_dotenv

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

from generate_images import generate_with_comfyui

def regenerate_children_scene():
    print("🎨 Regenerating children scene with improved settings...")
    
    # Improved prompts to avoid bad faces
    prompt = "close up shot of happy children playing in the street, detailed faces, joyful expressions, sharp focus, cinematic lighting, 8k, photorealistic"
    style = "cinematic, high quality"
    
    # More aggressive negative prompt is handled inside the function, 
    # but let's rely on the resolution and close-up to help.
    
    try:
        image_path = generate_with_comfyui(
            prompt=prompt,
            style=style,
            width=1024, # Use native resolution first
            height=1024, # SDXL works best at 1024x1024, then we assume downstream scaling
            scene_index=0
        )
        print(f"✅ Generated: {image_path}")
        
        # Overwrite the specific file expected by render_test_video.py
        # Target: comfyui_0_comfyui_scene_0_00002_.png
        cache_dir = os.path.dirname(image_path)
        target_filename = "comfyui_0_comfyui_scene_0_00002_.png"
        target_path = os.path.join(cache_dir, target_filename)
        
        if os.path.exists(target_path):
            try:
                os.remove(target_path)
                print(f"   Removed old file: {target_filename}")
            except Exception as e:
                print(f"⚠️  Could not remove old file: {e}")

        try:
            os.rename(image_path, target_path)
            print(f"✅ Updated target file for video: {target_filename}")
        except Exception as e:
            print(f"❌ Could not rename file: {e}")
            print(f"   Please manually check output/images/cache/")
        
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    regenerate_children_scene()
