#!/usr/bin/env python3
"""
Test script for render_video.py

Tests the video rendering pipeline with placeholder images and silent audio.
Run this to verify FFmpeg is installed and working correctly.

Usage: python test_render.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)

from ffmpeg_utils import resolve_ffmpeg_path
from script_logging import fail, info, ok, section


def check_ffmpeg():
    """Check if FFmpeg is installed and callable."""
    ffmpeg_path = resolve_ffmpeg_path(root_dir)
    try:
        result = subprocess.run(
            [ffmpeg_path, "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            ok(f"FFmpeg found: {ffmpeg_path}")
            return True
    except Exception:
        pass

    fail("FFmpeg not found")
    info("Install with:")
    info("- Ubuntu: sudo apt install ffmpeg")
    info("- macOS: brew install ffmpeg")
    info("- Windows: Download from https://ffmpeg.org/download.html")
    return False


def test_render():
    """Test the video rendering pipeline."""
    section("Testing Video Render Pipeline", width=60)

    # Check FFmpeg
    info("[1/3] Checking FFmpeg installation...")
    if not check_ffmpeg():
        return

    # Check ffmpeg-python
    info("[2/3] Checking ffmpeg-python...")
    try:
        import ffmpeg  # noqa: F401

        ok("ffmpeg-python installed")
    except ImportError:
        fail("ffmpeg-python not installed")
        info("Run: pip install ffmpeg-python")
        return

    # Check requests
    try:
        import requests  # noqa: F401

        ok("requests installed")
    except ImportError:
        fail("requests not installed")
        info("Run: pip install requests")
        return

    # Import render module
    info("[3/3] Testing render_video module...")
    try:
        from render_video import render_video
    except ImportError as e:
        fail(f"Import error: {e}")
        info("Make sure you're running from the scripts directory")
        return

    # Test data - simulates output from image generation
    test_data = {
        "images": [
            {
                "verseIndex": 0,
                "imageUrl": "",  # Empty URL will create placeholder
                "originalText": "Camino solo bajo la lluvia",
            },
            {
                "verseIndex": 1,
                "imageUrl": "",
                "originalText": "La ciudad duerme en silencio",
            },
            {
                "verseIndex": 2,
                "imageUrl": "",
                "originalText": "Las luces parpadean a lo lejos",
            },
        ],
        "audioUrl": "",  # Empty URL will create silence
        "verseDurations": [5, 5, 5],  # 5 seconds each for quick test
        "projectId": "test-render-001",
    }

    section("Starting render test (15 second video)...", width=60)

    try:
        result = render_video(
            images=test_data["images"],
            audio_url=test_data["audioUrl"],
            verse_durations=test_data["verseDurations"],
            project_id=test_data["projectId"],
        )

        section("Render test successful", width=60)

        info(f"Video saved to: {result.get('videoPath')}")
        info(f"Duration: {result.get('duration')} seconds")
        info(f"Resolution: {result.get('resolution')}")
        info(f"Segments: {result.get('totalSegments')}")

        info("Segment effects:")
        for seg in result.get("segments", []):
            info(f"  [{seg['segmentIndex']}] {seg['effect']} ({seg['duration']}s)")

        output_file = "test_render_result.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        info(f"Full result saved to: {output_file}")

        video_path = Path(result.get("videoPath", ""))
        if video_path.exists():
            size_mb = video_path.stat().st_size / (1024 * 1024)
            info(f"Video file size: {size_mb:.2f} MB")

    except Exception as e:
        fail(f"Render test failed: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    test_render()
