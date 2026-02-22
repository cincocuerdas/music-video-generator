#!/usr/bin/env python3
"""
Regenerate scenes in HYPER-REALISTIC style (uses RealVis automatically)
"""
import sys
import os
from dotenv import load_dotenv

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

from generate_images import generate_with_comfyui

# Visual prompts - HYPER-REALISTIC style with DIVERSE faces
SCENES = [
    {"index": 0, "title": "Niños Jugando",
     "prompt": "three diverse children of different ages playing in a sunny street, one boy one girl, different hairstyles, unique individual faces, laughing, natural candid photography"},
    
    {"index": 1, "title": "Trabajo Infantil",
     "prompt": "single sad young child working alone in a dusty factory, tired expression, unique detailed face, dramatic lighting, documentary photography"},
    
    {"index": 2, "title": "Protesta",
     "prompt": "massive street protest against corruption and war, angry crowd with raised fists, banners with peace symbols, burning tires, dramatic sky, photojournalism, latin american city, powerful emotional scene"},
    
    {"index": 3, "title": "Barrio",
     "prompt": "colorful latin american neighborhood street with painted houses, warm sunset light, empty street, vibrant architecture, no people"},
    
    {"index": 4, "title": "Familia",
     "prompt": "poor mother and child sitting at an empty wooden table, no food on table, two unique individual faces with sad hungry expressions, dramatic window lighting, poverty"}
]

def regenerate_realistic():
    print("=" * 60)
    print("📷 REGENERATING ALL SCENES (HYPER-REALISTIC)")
    print("   Auto-selecting: RealVis Lightning")
    print("   Resolution: 1024x1024")
    print("=" * 60)
    
    negative = "cartoon, anime, painting, artistic, illustration, deformed, ugly, bad anatomy, extra limbs, text, watermark, food, plates, dishes"

    for scene in SCENES:
        print(f"\nGenerando Escena {scene['index']}: {scene['title']}...")
        try:
            image_path = generate_with_comfyui(
                prompt=scene['prompt'],
                style="photorealistic, hyper-realistic, 8k, detailed",  # This triggers RealVis auto-selection
                width=1024, 
                height=1024,
                scene_index=scene['index'],
                checkpoint=None,  # Let auto-selection work
                negative_prompt=negative
            )
            
            cache_dir = os.path.dirname(image_path)
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

        except Exception as e:
            print(f"❌ Error: {e}")

if __name__ == "__main__":
    regenerate_realistic()
