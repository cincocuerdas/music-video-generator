
import os
import requests
import sys

# Configuration
MODEL_URL = "https://civitai.com/api/download/models/1920523"
MODEL_FILENAME = "epiCRealismXL_v5.safetensors"
DEST_DIR = os.path.join("ComfyUI", "models", "checkpoints")
DEST_PATH = os.path.join(DEST_DIR, MODEL_FILENAME)

def download_file():
    if os.path.exists(DEST_PATH):
        print(f"✅ File already exists: {DEST_PATH}")
        return

    print(f"⬇️ Downloading {MODEL_FILENAME} from Civitai...")
    print(f"   URL: {MODEL_URL}")
    print(f"   Dest: {DEST_PATH}")
    
    os.makedirs(DEST_DIR, exist_ok=True)
    
    try:
        response = requests.get(MODEL_URL, stream=True)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        block_size = 8192
        downloaded = 0
        
        with open(DEST_PATH, 'wb') as f:
            for chunk in response.iter_content(chunk_size=block_size):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        print(f"   Progress: {percent:.1f}% ({downloaded // (1024*1024)} MB)", end='\r')
        
        print("\n✅ Download complete!")
        
    except Exception as e:
        print(f"\n❌ Download failed: {e}")
        if os.path.exists(DEST_PATH):
            os.remove(DEST_PATH)
        sys.exit(1)

if __name__ == "__main__":
    download_file()
