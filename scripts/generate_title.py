#!/usr/bin/env python3
"""
Generate Title Card for Intro
"""
import sys
import os
from dotenv import load_dotenv

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

from generate_images import generate_with_comfyui

def generate_title_card():
    print("🎨 Generating Title Card...")
    
    # Prompt for a title card background
    prompt = "dark cinematic background, abstract construction elements, blueprint style, subtle lighting, space for text, high quality, 4k"
    style = "cinematic, minimal"
    
    try:
        # Generate with a specific index (e.g., 999) to avoid overwriting scenes
        image_path = generate_with_comfyui(
            prompt=prompt,
            style=style,
            width=1920,
            height=1080,
            scene_index=999
        )
        print(f"✅ Title Card generated: {image_path}")
        return image_path
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

if __name__ == "__main__":
    generate_title_card()
