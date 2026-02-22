import os
import subprocess
import sys

def download_lora(name, url, dest_folder):
    dest_path = os.path.join(dest_folder, name)
    if os.path.exists(dest_path):
        print(f"✅ {name} already exists. Skipping.")
        return

    print(f"🚀 Downloading {name}...")
    # Using --ssl-no-revoke to bypass the specific schannel error on some Windows systems
    cmd = ["curl", "-L", "--ssl-no-revoke", "-o", dest_path, url]
    try:
        subprocess.run(cmd, check=True)
        print(f"✨ Successfully downloaded {name}")
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to download {name}: {e}")

def main():
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lora_dir = os.path.join(root_dir, "ComfyUI", "models", "loras")
    
    os.makedirs(lora_dir, exist_ok=True)

    models = [
        {
            "name": "hand_fine_tuning_sdxl.safetensors",
            "url": "https://civitai.com/api/download/models/278497"
        },
        {
            "name": "ai_hands_xl.safetensors",
            "url": "https://civitai.com/api/download/models/151531"
        },
        {
            "name": "hands_sdxl_beta.safetensors",
            "url": "https://civitai.com/api/download/models/217036"
        }
    ]

    for model in models:
        download_lora(model["name"], model["url"], lora_dir)

if __name__ == "__main__":
    main()
