#!/usr/bin/env python3
"""
Download YouTube Thumbnail for Intro
"""
import sys
import os
import urllib.request

def download_thumbnail():
    print("🖼️  Downloading YouTube Thumbnail...")
    
    video_id = "FQVwaPtiNCk"
    url = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
    
    # Output path matches what render script expects roughly, 
    # but let's save it clearly
    output_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output", "images", "cache")
    output_path = os.path.join(output_dir, "youtube_thumbnail.jpg")
    
    try:
        # User-Agent is sometimes needed
        opener = urllib.request.build_opener()
        opener.addheaders = [('User-Agent', 'Mozilla/5.0')]
        urllib.request.install_opener(opener)
        
        urllib.request.urlretrieve(url, output_path)
        print(f"✅ Thumbnail saved to: {output_path}")
        return output_path
    except Exception as e:
        print(f"❌ Error downloading thumbnail: {e}")
        # Fallback to hqdefault if maxres doesn't exist
        try:
            url = f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
            print(f"🔄 Trying fallback URL: {url}")
            urllib.request.urlretrieve(url, output_path)
            print(f"✅ Thumbnail saved to: {output_path}")
            return output_path
        except Exception as e2:
             print(f"❌ Error with fallback: {e2}")
             return None

if __name__ == "__main__":
    download_thumbnail()
