#!/usr/bin/env python3
"""
YouTube download script for NestJS integration.
Downloads audio and thumbnail from YouTube URL stored in project.
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

from dotenv import load_dotenv
from db_utils import get_db_connection


# Setup paths
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)
load_dotenv(os.path.join(ROOT_DIR, ".env"))


def emit_result(payload):
    output = json.dumps(payload)
    print(output)
    print(f"RESULT_JSON:{output}", file=sys.stderr)

def _available_js_runtimes():
    runtimes = []
    if shutil.which("node"):
        runtimes.append("node")
    if shutil.which("deno"):
        runtimes.append("deno")
    if shutil.which("bun"):
        runtimes.append("bun")
    return runtimes


def _run_yt_dlp(command):
    return subprocess.run(command, check=True, capture_output=True, text=True)


def download_audio(youtube_url: str, output_dir: str, video_id: str) -> str:
    """Download audio from YouTube (keep original audio container when possible)."""
    for ext in ["mp3", "webm", "m4a", "opus", "ogg"]:
        existing_path = os.path.join(output_dir, f"{video_id}.{ext}")
        if os.path.exists(existing_path):
            return existing_path

    output_template = os.path.join(output_dir, f"{video_id}.%(ext)s")

    # Convert music.youtube.com to standard youtube.com for yt-dlp compatibility.
    download_url = youtube_url
    if "music.youtube.com" in youtube_url:
        download_url = youtube_url.replace("music.youtube.com", "www.youtube.com")

    js_runtimes = _available_js_runtimes()
    if not js_runtimes:
        raise Exception(
            "yt-dlp requires a JS runtime for YouTube extraction. "
            "Install Node.js (recommended) or Deno and retry."
        )

    base_cmd = [
        "yt-dlp",
        "--no-playlist",
        "--js-runtimes",
        ",".join(js_runtimes),
        "--remote-components",
        "ejs:github",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "best",
        "-o",
        output_template,
    ]

    # Strategy 1: direct download (fast path).
    direct_cmd = base_cmd + [download_url]
    try:
        _run_yt_dlp(direct_cmd)
    except subprocess.CalledProcessError as direct_error:
        direct_message = direct_error.stderr or direct_error.stdout or "Unknown error"
        print(f"Direct yt-dlp failed: {direct_message[:300]}", file=sys.stderr)

        # Strategy 2: browser cookies fallback.
        cookie_browsers = ["brave", "edge", "chrome", "firefox"]
        cookie_errors = []
        success = False

        for browser in cookie_browsers:
            print(f"Trying yt-dlp with {browser} cookies...", file=sys.stderr)
            cookie_cmd = base_cmd + ["--cookies-from-browser", browser, download_url]
            try:
                _run_yt_dlp(cookie_cmd)
                success = True
                break
            except subprocess.CalledProcessError as cookie_error:
                cookie_message = cookie_error.stderr or cookie_error.stdout or "Unknown error"
                cookie_errors.append((browser, cookie_message))

        if not success:
            # If cookie DB is locked, give clear action.
            for browser, cookie_error in cookie_errors:
                lowered = cookie_error.lower()
                if "could not copy" in lowered or "database is locked" in lowered:
                    raise Exception(
                        f"Close {browser.upper()} and retry. "
                        "yt-dlp cannot read browser cookies while the browser is open."
                    )

            summarized = " | ".join(
                f"{browser}: {error.replace(chr(10), ' ')[:180]}"
                for browser, error in cookie_errors
            )
            raise Exception(
                "yt-dlp failed with direct download and cookie fallbacks. "
                f"Direct error: {direct_message[:260]} | Cookie errors: {summarized}"
            )

    for ext in ["webm", "m4a", "opus", "ogg", "mp3"]:
        output_path = os.path.join(output_dir, f"{video_id}.{ext}")
        if os.path.exists(output_path):
            return output_path

    raise Exception(f"Audio download failed - no file found for {video_id}")


def download_thumbnail(youtube_url: str, output_dir: str, video_id: str) -> str:
    """Download YouTube thumbnail."""
    thumbnail_path = os.path.join(output_dir, f"thumbnail_{video_id}.jpg")

    if os.path.exists(thumbnail_path):
        return thumbnail_path

    urls = [
        f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
        f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
    ]

    for url in urls:
        try:
            urllib.request.urlretrieve(url, thumbnail_path)
            if os.path.getsize(thumbnail_path) > 1000:
                return thumbnail_path
        except (urllib.error.URLError, OSError):
            continue

    return None


def extract_video_id(url: str) -> str:
    """Extract video ID from YouTube URL."""
    if "music.youtube.com" in url:
        url = url.replace("music.youtube.com", "www.youtube.com")

    if "youtu.be/" in url:
        return url.split("youtu.be/")[-1].split("?")[0][:11]

    if "v=" in url:
        return url.split("v=")[-1].split("&")[0][:11]

    import re

    match = re.search(r"[a-zA-Z0-9_-]{11}", url)
    return match.group(0) if match else url[:11]


def main():
    conn = None
    cur = None
    degraded_reasons = []

    try:
        if len(sys.argv) < 2:
            result = {
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "error": "Missing projectId",
            }
            emit_result(result)
            return result

        project_id = sys.argv[1]
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute('SELECT "youtubeUrl" FROM "Project" WHERE id = %s', (project_id,))
        row = cur.fetchone()

        if not row or not row[0]:
            result = {
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "error": "No YouTube URL found for project",
            }
            emit_result(result)
            return result

        youtube_url = row[0]
        video_id = extract_video_id(youtube_url)

        output_dir = os.path.join(ROOT_DIR, "output", "audio")
        cache_dir = os.path.join(ROOT_DIR, "output", "images", "cache")
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(cache_dir, exist_ok=True)

        audio_path = download_audio(youtube_url, output_dir, video_id)
        thumbnail_path = download_thumbnail(youtube_url, cache_dir, video_id)
        if thumbnail_path is None:
            degraded_reasons.append("thumbnail_download_failed")

        def to_web_url(abs_path):
            if abs_path and ROOT_DIR in abs_path:
                rel_path = abs_path.replace(ROOT_DIR, "").replace("\\", "/")
                return rel_path if rel_path.startswith("/") else "/" + rel_path
            return abs_path

        audio_url = to_web_url(audio_path)
        thumbnail_url = to_web_url(thumbnail_path) if thumbnail_path else None

        cur.execute(
            'UPDATE "Project" SET "audioUrl" = %s, "thumbnailUrl" = %s WHERE id = %s',
            (audio_url, thumbnail_url, project_id),
        )
        conn.commit()

        degraded = len(degraded_reasons) > 0
        result = {
            "status": "degraded" if degraded else "success",
            "success": True,
            "degraded": degraded,
            "degradedReasons": degraded_reasons,
            "audioPath": audio_path,
            "thumbnailPath": thumbnail_path,
            "videoId": video_id,
        }
        emit_result(result)
        return result

    except Exception as error:
        result = {
            "status": "failed",
            "success": False,
            "degraded": False,
            "degradedReasons": [],
            "error": str(error),
        }
        emit_result(result)
        return result
    finally:
        try:
            if cur:
                cur.close()
        finally:
            if conn:
                conn.close()


if __name__ == "__main__":
    main()
