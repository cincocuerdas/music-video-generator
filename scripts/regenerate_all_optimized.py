#!/usr/bin/env python3
"""
Regenerate ALL scenes with OPTIMIZED settings for quality.
Fixes: "Floating heads" and distorted faces by using native SDXL resolution.
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

# Visual prompts derived from lyrics (Digital Oil Painting Style)
SCENES = [
    {"index": 0, "title": "Niños Jugando",
     "prompt": "digital oil painting of happy children playing in a sunny street, laughing, detailed expressive faces, brushstrokes, vibrant colors, artistic masterpiece, golden hour lighting"},
    
    {"index": 1, "title": "Trabajo Infantil",
     "prompt": "digital oil painting of sad children working in a factory, emotional, dramatic lighting, visible brush texture, somber mood, classic art style, detailed faces"},
    
    {"index": 2, "title": "Protesta",
     "prompt": "oil painting of a crowd protesting in a city, people raising fists, demanding justice, energetic atmosphere, dramatic chiaroscuro lighting, abstract background, no text"},
    
    {"index": 3, "title": "Barrio",
     "prompt": "beautiful oil painting of a latin american neighborhood street, colorful houses, community life, warm sunset light, thick brushstrokes, impressionist style"},
    
    {"index": 4, "title": "Familia",
     "prompt": "oil painting of a bare empty wooden table with absolutely no food on it. A sad mother and child sitting next to the empty table. Poverty, misery, hunger, dramatic shadows, melancholic art"}
]

def regenerate_all(checkpoint=None):
    # Get checkpoint from arg or env
    model = checkpoint if checkpoint else os.getenv("COMFYUI_CHECKPOINT", "sd_xl_base_1.0.safetensors")
    
    print("=" * 60)
    print("🎨 REGENERATING ALL SCENES (OIL PAINTING STYLE)")
    print(f"   Model: {model}")
    print("   Resolution: 1024x1024 (Native SDXL)")
    print("=" * 60)
    
    # Common Negative Prompt - very aggressive
    negative = "photorealistic, photograph, anime, cartoon, 3d render, food, plates, dishes, banquet, eating, meal, dinner, lunch, distorted faces, bad anatomy, blurry, deformed, ugly"

    for scene in SCENES:
        print(f"\nGenerando Escena {scene['index']}: {scene['title']}...")
        try:
            # We use 1024x1024 which is the EXACT native resolution for SDXL
            image_path = generate_with_comfyui(
                prompt=scene['prompt'],
                style="oil painting, artistic masterpiece, detailed",
                width=1024, 
                height=1024,
                scene_index=scene['index'],
                checkpoint=model,
                negative_prompt=negative
            )
            
            # Helper to rename to the file expected by render script
            cache_dir = os.path.dirname(image_path)
            # Format expected: comfyui_{index}_comfyui_scene_{index}_00001_.png
            # Note: The generation might return a different filename (incremented)
            # We must force it to what render script expects:
            # comfyui_0_comfyui_scene_0_00002_.png (for index 0)
            # comfyui_1_comfyui_scene_1_00001_.png (for index 1)
            # ...
            
            # To be safe, let's map exactly to what render_test_video.py uses:
            target_names = {
                0: "comfyui_0_comfyui_scene_0_00002_.png",
                1: "comfyui_1_comfyui_scene_1_00001_.png",
                2: "comfyui_2_comfyui_scene_2_00001_.png",
                3: "comfyui_3_comfyui_scene_3_00001_.png",
                4: "comfyui_4_comfyui_scene_4_00001_.png"
            }
            
            target_filename = target_names.get(scene['index'])
            if target_filename:
                target_path = os.path.join(cache_dir, target_filename)
                if os.path.exists(target_path):
                    os.remove(target_path)
                os.rename(image_path, target_path)
                print(f"✅ Saved to: {target_filename}")
            else:
                print(f"✅ Generated: {image_path}")

        except Exception as e:
            print(f"❌ Error: {e}")

if __name__ == "__main__":
    # Optional: pass model name as argument
    # Usage: python regenerate_all_optimized.py juggernautXL_v9.safetensors
    model_arg = sys.argv[1] if len(sys.argv) > 1 else None
    regenerate_all(checkpoint=model_arg)
