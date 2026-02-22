#!/usr/bin/env python3
"""
Transcription Script for NestJS integration.
Transcribes audio using Whisper and saves to database.
"""
import sys
import os
import json
from dotenv import load_dotenv
from ffmpeg_utils import ensure_ffmpeg_on_path

# Setup paths
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

# Ensure ffmpeg can be resolved by Whisper
ensure_ffmpeg_on_path(root_dir)

# Database connection
from db_utils import get_db_connection

try:
    from redis_events import emit_progress as emit_redis_progress
    REDIS_EVENTS_AVAILABLE = True
except ImportError:
    REDIS_EVENTS_AVAILABLE = False


def emit_result(payload):
    output = json.dumps(payload)
    print(output)
    print(f"RESULT_JSON:{output}", file=sys.stderr)


def emit_progress(project_id: str | None, progress: int, message: str):
    payload = {
        "type": "progress",
        "data": {
            "progress": progress,
            "message": message,
            "jobType": "TRANSCRIPTION",
        },
    }
    print(f"PROGRESS_JSON:{json.dumps(payload, ensure_ascii=False)}", file=sys.stderr)
    if (os.getenv("PYTHON_LEGACY_PROGRESS_STDERR", "false").strip().lower() == "true"):
        print(f"PROGRESS: {message}", file=sys.stderr)
    if not project_id or not REDIS_EVENTS_AVAILABLE:
        return
    try:
        emit_redis_progress(project_id, progress, message, job_type="TRANSCRIPTION")
    except Exception as error:
        print(f"Warning: failed to publish transcription progress to Redis: {error}", file=sys.stderr)

def transcribe_audio(audio_path: str, force_language: str = None, project_id: str = None) -> dict:
    """Transcribe audio using faster-whisper (CPU mode)"""
    from faster_whisper import WhisperModel

    # Model selection: use WHISPER_MODEL env var or default to "large-v3"
    # Options: "tiny", "base", "small", "medium", "large-v2", "large-v3"
    # large-v3 is most accurate for detecting soft vocals/backing vocals in music
    # Set WHISPER_MODEL=medium for faster (but less accurate) transcription
    whisper_model = os.getenv("WHISPER_MODEL", "large-v3")

    # Force CPU mode for stability - ctranslate2 + CUDA on Windows caused crash (exit code 3221226505)
    emit_progress(project_id, 20, f"Loading faster-whisper model ({whisper_model}, CPU)...")
    model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
    emit_progress(project_id, 30, "Transcribing audio...")

    # Note: initial_prompt can cause hallucinations when vocals are soft/mixed with music
    # Only use it when explicitly requested via WHISPER_INITIAL_PROMPT env var
    initial_prompt = os.getenv("WHISPER_INITIAL_PROMPT")
    if initial_prompt:
        print(f"Using initial_prompt: '{initial_prompt[:50]}...'", file=sys.stderr)

    # Use forced language or auto-detect
    # Very low thresholds to catch softer vocals, backing vocals, and ad-libs
    transcribe_options = {
        "beam_size": 5,
        "word_timestamps": True,  # More precise timing
        "vad_filter": False,  # Don't skip quiet sections - important for detecting soft vocals
        "no_speech_threshold": 0.1,  # Very low to detect backing vocals (default 0.6)
        "log_prob_threshold": -1.5,  # Lower to accept less confident transcriptions (default -1.0)
    }

    # Only add initial_prompt if explicitly set
    if initial_prompt:
        transcribe_options["initial_prompt"] = initial_prompt
    if force_language:
        transcribe_options["language"] = force_language
        emit_progress(project_id, 35, f"Forcing language: {force_language}")
    else:
        # First, detect language
        _, detect_info = model.transcribe(audio_path, beam_size=1)
        detected_lang = detect_info.language
        detected_prob = detect_info.language_probability
        emit_progress(project_id, 35, f"Auto-detected language: {detected_lang} (prob: {detected_prob:.2f})")

        # If detection confidence is low OR detected non-Latin language for what's likely music,
        # default to English (most songs with vocals are in English)
        if detected_prob < 0.7 or detected_lang in ['ja', 'ko', 'zh', 'ar', 'he', 'th']:
            emit_progress(project_id, 38, "Low confidence or non-Latin detected, forcing English")
            transcribe_options["language"] = "en"
        else:
            transcribe_options["language"] = detected_lang

    segments, info = model.transcribe(audio_path, **transcribe_options)
    
    # Collect segments
    timed_segments = []
    lyrics_parts = []
    
    for seg in segments:
        lyrics_parts.append(seg.text.strip())
        timed_segments.append({
            "text": seg.text.strip(),
            "start": seg.start,
            "end": seg.end
        })
        if len(lyrics_parts) % 5 == 0:
            rolling = min(92, 40 + len(lyrics_parts))
            emit_progress(project_id, rolling, f"Transcribed {len(lyrics_parts)} segments...")
    
    lyrics = " ".join(lyrics_parts)
    
    emit_progress(project_id, 95, f"Detected language: {info.language} (probability: {info.language_probability:.2f})")
    
    return {
        "lyrics": lyrics,
        "language": info.language,
        "segments": timed_segments
    }

def try_youtube_subtitles(youtube_url: str) -> dict | None:
    """Try to get subtitles from YouTube as alternative to Whisper transcription.
    Returns dict with lyrics/segments or None if not available."""
    import subprocess
    import tempfile
    import re

    if not youtube_url:
        return None

    # Extract video ID from various YouTube URL formats
    video_id = None
    patterns = [
        r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'(?:embed/)([a-zA-Z0-9_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, youtube_url)
        if match:
            video_id = match.group(1)
            break

    if not video_id:
        print(f"Could not extract video ID from: {youtube_url}", file=sys.stderr)
        return None

    print(f"Checking YouTube subtitles for video: {video_id}...", file=sys.stderr)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            # Try to download auto-generated or manual subtitles
            sub_file = os.path.join(tmpdir, "subs")
            result = subprocess.run([
                "yt-dlp",
                "--write-auto-sub",  # Auto-generated subs
                "--write-sub",       # Manual subs (prefer these)
                "--sub-lang", "en,es,pt",  # Common languages
                "--sub-format", "vtt",
                "--skip-download",   # Don't download video
                "-o", sub_file,
                f"https://www.youtube.com/watch?v={video_id}"
            ], capture_output=True, text=True, timeout=30)

            # Look for downloaded subtitle files
            vtt_files = [f for f in os.listdir(tmpdir) if f.endswith('.vtt')]
            if not vtt_files:
                print("No YouTube subtitles available", file=sys.stderr)
                return None

            # Parse first available VTT file
            vtt_path = os.path.join(tmpdir, vtt_files[0])
            print(f"Found YouTube subtitles: {vtt_files[0]}", file=sys.stderr)

            segments = []
            lyrics_parts = []

            with open(vtt_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Parse VTT format: timestamp lines followed by text
            # Format: 00:00:16.000 --> 00:00:20.000
            time_pattern = r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})'
            lines = content.split('\n')
            i = 0
            while i < len(lines):
                time_match = re.match(time_pattern, lines[i])
                if time_match:
                    # Parse start time
                    start_h, start_m, start_s, start_ms = map(int, time_match.groups()[:4])
                    start = start_h * 3600 + start_m * 60 + start_s + start_ms / 1000
                    # Parse end time
                    end_h, end_m, end_s, end_ms = map(int, time_match.groups()[4:])
                    end = end_h * 3600 + end_m * 60 + end_s + end_ms / 1000

                    # Get text lines until next timestamp or empty line
                    i += 1
                    text_lines = []
                    while i < len(lines) and lines[i].strip() and not re.match(time_pattern, lines[i]):
                        # Remove VTT formatting tags like <c> </c>
                        clean_line = re.sub(r'<[^>]+>', '', lines[i]).strip()
                        if clean_line:
                            text_lines.append(clean_line)
                        i += 1

                    if text_lines:
                        text = ' '.join(text_lines)
                        # Skip duplicate lines (YouTube auto-subs often repeat)
                        if not segments or segments[-1]['text'] != text:
                            segments.append({
                                "text": text,
                                "start": start,
                                "end": end
                            })
                            lyrics_parts.append(text)
                else:
                    i += 1

            if segments:
                print(f"Parsed {len(segments)} segments from YouTube subtitles", file=sys.stderr)
                return {
                    "lyrics": ' '.join(lyrics_parts),
                    "language": "en",  # Assume English for now
                    "segments": segments,
                    "source": "youtube_subtitles"
                }

    except subprocess.TimeoutExpired:
        print("YouTube subtitle download timed out", file=sys.stderr)
    except Exception as e:
        print(f"Error getting YouTube subtitles: {e}", file=sys.stderr)

    return None


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
        emit_progress(project_id, 5, "Initializing transcription module...")

        # Get project from database
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT "audioUrl", lyrics, "youtubeUrl" FROM "Project" WHERE id = %s', (project_id,))
        row = cur.fetchone()

        if not row:
            result = {
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "error": "Project not found",
            }
            emit_result(result)
            return result

        audio_url, existing_lyrics, youtube_url = row

        # Check if already has lyrics (manual input)
        if existing_lyrics and len(existing_lyrics.strip()) > 0:
            emit_progress(project_id, 100, "Lyrics already provided manually.")
            result = {
                "status": "success",
                "success": True,
                "degraded": False,
                "degradedReasons": [],
                "lyrics": existing_lyrics,
                "source": "manual"
            }
            emit_result(result)
            return result

        # Try YouTube subtitles first (often more accurate for music videos)
        # Can be disabled with SKIP_YOUTUBE_SUBS=true
        if not os.getenv("SKIP_YOUTUBE_SUBS") and youtube_url:
            emit_progress(project_id, 10, "Checking YouTube subtitles...")
            yt_result = try_youtube_subtitles(youtube_url)
            if yt_result and len(yt_result.get("segments", [])) > 5:
                # YouTube subs found and have enough content
                cur.execute(
                    'UPDATE "Project" SET lyrics = %s WHERE id = %s',
                    (yt_result["lyrics"], project_id)
                )
                conn.commit()

                emit_progress(project_id, 100, "Transcription completed from YouTube subtitles.")
                result = {
                    "status": "success",
                    "success": True,
                    "degraded": False,
                    "degradedReasons": [],
                    "lyrics": yt_result["lyrics"],
                    "language": yt_result["language"],
                    "segmentCount": len(yt_result["segments"]),
                    "segments": yt_result["segments"],
                    "source": "youtube_subtitles"
                }
                emit_result(result)
                return result

            degraded_reasons.append("youtube_subtitles_unavailable")
            emit_progress(project_id, 15, "YouTube subtitles unavailable, falling back to Whisper.")

        if not audio_url:
            result = {
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "error": "No audio file found for project",
            }
            emit_result(result)
            return result

        # Convert web URL path to actual filesystem path
        # audioUrl can be:
        # - Absolute Windows path: C:\PROJECT\output\audio\xxx.webm
        # - Relative web path: /output/audio/xxx.mp3
        if audio_url.startswith('/output/'):
            # Convert web path to filesystem path
            audio_path = os.path.join(root_dir, audio_url.lstrip('/').replace('/', os.sep))
        elif audio_url.startswith('C:') or audio_url.startswith('c:'):
            # Already absolute Windows path
            audio_path = audio_url
        else:
            # Assume it's relative to root
            audio_path = os.path.join(root_dir, audio_url)

        if not os.path.exists(audio_path):
            result = {
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "error": f"Audio file not found: {audio_path}",
            }
            emit_result(result)
            return result

        # Transcribe with Whisper (using large-v3 model by default for best vocal detection)
        transcription = transcribe_audio(audio_path, project_id=project_id)

        # Save lyrics to database
        cur.execute(
            'UPDATE "Project" SET lyrics = %s WHERE id = %s',
            (transcription["lyrics"], project_id)
        )
        conn.commit()

        degraded = len(degraded_reasons) > 0
        emit_progress(project_id, 100, "Transcription complete.")
        result = {
            "status": "degraded" if degraded else "success",
            "success": True,
            "degraded": degraded,
            "degradedReasons": degraded_reasons,
            "lyrics": transcription["lyrics"],
            "language": transcription["language"],
            "segmentCount": len(transcription["segments"]),
            "segments": transcription["segments"],
            "source": "whisper"
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
