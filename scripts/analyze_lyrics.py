#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analyze Lyrics Script
Reads project lyrics from PostgreSQL and analyzes them using Gemini AI.
Saves the analysis result back to the database.
"""
import sys
import json
import os
import re
import time
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional
import random
from result_json import make_emit_result
from stage_deadline import bounded_timeout_seconds, hard_stage_deadline, make_stage_deadline_checker
from env_utils import parse_int_env, parse_positive_int_env
from gemini_semaphore import (
    backoff_with_jitter,
    call_with_gemini_guard,
    GEMINI_COOLDOWN,
    is_gemini_rate_limit_error_generic,
)
try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args, **_kwargs):
        return False

# Import verse classifier
try:
    from verse_classifier import classify_verse, classify_verse_fallback
    CLASSIFIER_AVAILABLE = True
except ImportError:
    CLASSIFIER_AVAILABLE = False

# Load configuration
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)
TUNED_MODEL_CONFIG_PATH = os.getenv(
    "GEMINI_TUNED_MODEL_CONFIG_PATH",
    os.path.join(root_dir, "storage", "gemini-tuned-model.json")
)
MAX_ANALYSIS_SCENES = parse_positive_int_env("ANALYSIS_MAX_SCENES", 15)
ANALYSIS_PROMPT_TEMPLATE_PATH = os.path.join(current_dir, "templates", "analyze_lyrics_prompt.txt")
_PROMPT_TEMPLATE_CACHE = None
ANALYZE_LYRICS_STAGE_TIMEOUT_SEC = parse_positive_int_env("ANALYZE_LYRICS_STAGE_TIMEOUT_SEC", 240)
MULTILINGUAL_HIGH_CONTEXT_LANGUAGES = {"ko", "ja", "zh"}


def get_db_connection():
    from db_utils import get_db_connection as _get_db_connection
    return _get_db_connection()


emit_result = make_emit_result("analysis")


from runtime_config import get_gemini_api_base_url


def load_analysis_prompt_template() -> str:
    global _PROMPT_TEMPLATE_CACHE
    if _PROMPT_TEMPLATE_CACHE is None:
        with open(ANALYSIS_PROMPT_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            _PROMPT_TEMPLATE_CACHE = f.read()
    return _PROMPT_TEMPLATE_CACHE


def build_analysis_prompt(style_hint: str, title_hint: str, lyrics_content: str) -> str:
    template = load_analysis_prompt_template()
    return (
        template.replace("{{STYLE_HINT}}", style_hint)
        .replace("{{TITLE_HINT}}", title_hint)
        .replace("{{LYRICS_CONTENT}}", lyrics_content)
    )


def detect_primary_language(text: str) -> str:
    sample = (text or "").strip()
    if not sample:
        return "unknown"

    # Script-based fast path.
    if re.search(r"[\uac00-\ud7af]", sample):
        return "ko"
    if re.search(r"[\u3040-\u30ff]", sample):
        return "ja"
    if re.search(r"[\u4e00-\u9fff]", sample):
        return "zh"

    tokens = re.findall(r"[A-Za-zÀ-ÿ']+", sample.lower())
    if not tokens:
        return "unknown"

    lang_stopwords = {
        "en": {"the", "and", "you", "that", "with", "for", "are", "this", "your", "from"},
        "es": {"que", "con", "para", "como", "pero", "una", "las", "los", "por", "del"},
        "pt": {"que", "com", "para", "como", "uma", "dos", "das", "por", "não", "você"},
    }

    scores = {lang: 0 for lang in lang_stopwords}
    for token in tokens:
        for lang, stopwords in lang_stopwords.items():
            if token in stopwords:
                scores[lang] += 1

    top_lang = max(scores, key=scores.get)
    if scores[top_lang] <= 0:
        return "unknown"
    return top_lang


def build_language_hint(language: str) -> str:
    normalized = (language or "unknown").strip().lower()
    hints = {
        "ko": (
            "LANGUAGE ROUTE: Korean lyrics. Keep semantic meaning and emotional intent from Korean text. "
            "Do NOT invent unrelated western metaphors. Produce visual prompts in ENGLISH."
        ),
        "ja": (
            "LANGUAGE ROUTE: Japanese lyrics. Preserve context and concrete nouns from Japanese text. "
            "Avoid generic scenes; keep imagery literal. Produce visual prompts in ENGLISH."
        ),
        "zh": (
            "LANGUAGE ROUTE: Chinese lyrics. Preserve literal meaning and narrative continuity. "
            "Avoid abstract substitutions. Produce visual prompts in ENGLISH."
        ),
        "es": (
            "LANGUAGE ROUTE: Spanish lyrics. Keep colloquial and regional meaning while remaining literal. "
            "Produce visual prompts in ENGLISH."
        ),
        "pt": (
            "LANGUAGE ROUTE: Portuguese lyrics. Keep literal scene meaning and action verbs explicit. "
            "Produce visual prompts in ENGLISH."
        ),
        "en": "LANGUAGE ROUTE: English lyrics.",
    }
    return hints.get(normalized, "LANGUAGE ROUTE: Unknown language; preserve literal meaning and avoid hallucinations.")


def to_reason_list(value: Any) -> List[str]:
    if isinstance(value, list):
        normalized: List[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                normalized.append(text)
        return normalized
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    return []


ensure_stage_deadline = make_stage_deadline_checker("analysis")

def with_result_status(analysis: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(analysis) if isinstance(analysis, dict) else {}
    fallback_reason = str(payload.get("_fallbackReason") or "").strip()
    model_name = str(payload.get("_model") or "").strip().lower()
    degraded_reasons = to_reason_list(payload.get("degradedReasons"))
    if fallback_reason and fallback_reason not in degraded_reasons:
        degraded_reasons.append(fallback_reason)
    if model_name.startswith("fallback") and not degraded_reasons:
        degraded_reasons.append("analysis.model_fallback")

    degraded = len(degraded_reasons) > 0
    payload["status"] = "degraded" if degraded else "success"
    payload["success"] = True
    payload["degraded"] = degraded
    payload["degradedReasons"] = degraded_reasons
    return payload

def get_project_lyrics(project_id: str) -> dict:
    """Fetch project data including lyrics and transcription segments from database"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        # Get project basic info
        cur.execute(
            '''SELECT id, title, lyrics, "visualStyle", "colorPalette"
               FROM "Project" WHERE id = %s''',
            (project_id,)
        )
        row = cur.fetchone()
        if not row:
            raise Exception(f"Project {project_id} not found")
            
        data = {
            "id": row[0],
            "title": row[1],
            "lyrics": row[2],
            "visualStyle": row[3],
            "colorPalette": row[4] if row[4] else [],
            "segments": []
        }
        
        # Fetch segments from the latest successful TRANSCRIPTION job
        try:
            cur.execute(
                '''SELECT "outputData" FROM "Job" 
                   WHERE "projectId" = %s::uuid AND type = 'TRANSCRIPTION' AND status = 'COMPLETED'
                   ORDER BY "createdAt" DESC LIMIT 1''',
                (project_id,)
            )
            job_row = cur.fetchone()
            if job_row and job_row[0]:
                output_data = job_row[0]
                if isinstance(output_data, str):
                    output_data = json.loads(output_data)
                
                # Check if segments exist in output data
                if "segments" in output_data:
                    data["segments"] = output_data["segments"]
        except Exception as e:
            print(f"Warning: Could not fetch transcription segments: {e}", file=sys.stderr)

        return data
    finally:
        conn.close()

def save_analysis_result(project_id: str, analysis: dict):
    """Save analysis result to database"""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''UPDATE "Project" SET "analysisResult" = %s WHERE id = %s''',
            (json.dumps(analysis), project_id)
        )
        conn.commit()
    finally:
        conn.close()

def get_gemini_model(api_key: str, deadline_ts: Optional[float] = None) -> str:
    """Find available Gemini model"""
    base_url = get_gemini_api_base_url()
    list_url = f"{base_url}/v1beta/models?key={api_key}"
    chosen_model = "models/gemini-1.5-flash"
    list_timeout_sec = parse_positive_int_env("GEMINI_MODELS_TIMEOUT_SEC", 10)

    try:
        effective_timeout = bounded_timeout_seconds(
            deadline_ts,
            list_timeout_sec,
            phase="gemini_models_list",
            scope="analysis",
        )
        with urllib.request.urlopen(list_url, timeout=effective_timeout) as response:
            data = json.loads(response.read().decode('utf-8'))
            for model in data.get('models', []):
                if 'generateContent' in model.get('supportedGenerationMethods', []):
                    chosen_model = model['name']
                    if 'flash' in chosen_model:
                        break
    except Exception:
        pass  # Fallback to default model on any error

    return chosen_model

def get_tuned_gemini_model() -> str:
    """Get tuned Gemini model id from env or config file."""
    env_model = (os.getenv("GEMINI_TUNED_MODEL") or "").strip()
    if env_model:
        return env_model

    if not os.path.exists(TUNED_MODEL_CONFIG_PATH):
        return ""

    try:
        with open(TUNED_MODEL_CONFIG_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
        tuned_model = (payload.get("tunedModel") or "").strip()
        return tuned_model
    except Exception as e:
        print(f"Warning: could not read tuned model config: {e}", file=sys.stderr)
        return ""

def request_gemini_generate(
    model: str,
    api_key: str,
    prompt_text: str,
    deadline_ts: Optional[float] = None,
) -> dict:
    """Call Gemini generateContent for a specific model."""
    base_url = get_gemini_api_base_url()
    generate_url = f"{base_url}/v1beta/{model}:generateContent?key={api_key}"

    headers = {'Content-Type': 'application/json'}
    data = {"contents": [{"parts": [{"text": prompt_text}]}]}
    json_data = json.dumps(data).encode('utf-8')
    timeout_sec = parse_positive_int_env("GEMINI_REQUEST_TIMEOUT_SEC", 45)
    retries = max(0, parse_int_env("GEMINI_REQUEST_RETRIES", 2))

    last_error = None
    for attempt in range(retries + 1):
        request_phase = f"gemini_request:{model}:attempt_{attempt + 1}"
        ensure_stage_deadline(deadline_ts, request_phase)
        effective_timeout = bounded_timeout_seconds(
            deadline_ts,
            timeout_sec,
            phase=request_phase,
            scope="analysis",
        )
        req = urllib.request.Request(generate_url, data=json_data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=effective_timeout) as response:
                response_body = response.read().decode('utf-8')
                return json.loads(response_body)
        except urllib.error.HTTPError as e:
            error_msg = e.read().decode('utf-8', errors='replace')
            last_error = Exception(f"HTTP {e.code} calling model '{model}': {error_msg}")
            # Retry only transient API errors.
            if e.code not in (408, 429, 500, 502, 503, 504) or attempt >= retries:
                raise last_error
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = Exception(f"Network error calling model '{model}': {e}")
            if attempt >= retries:
                raise last_error

        raw_backoff = min(2 ** attempt, 8)
        sleep_for = backoff_with_jitter(raw_backoff)
        ensure_stage_deadline(deadline_ts, f"gemini_backoff:{model}:attempt_{attempt + 1}")
        # Activate cross-process cooldown on 429 so generate_images.py knows
        if isinstance(last_error, Exception) and '429' in str(last_error):
            GEMINI_COOLDOWN.activate(max(sleep_for, 30))
        time.sleep(sleep_for)

    if last_error:
        raise last_error
    raise Exception(f"Unknown error calling model '{model}'")

def build_candidate_models(
    api_key: str,
    primary_language: str = "unknown",
    deadline_ts: Optional[float] = None,
) -> list:
    """Use tuned model first, language-aware candidates, then discovered model."""
    base_model = get_gemini_model(api_key, deadline_ts=deadline_ts)
    tuned_model = get_tuned_gemini_model()
    multilingual_route = primary_language in MULTILINGUAL_HIGH_CONTEXT_LANGUAGES
    candidate_env_key = (
        "ANALYSIS_GEMINI_MODEL_CANDIDATES_MULTILINGUAL"
        if multilingual_route
        else "ANALYSIS_GEMINI_MODEL_CANDIDATES"
    )
    default_candidates = (
        "models/gemini-2.5-pro,models/gemini-2.5-flash,models/gemini-2.0-flash,models/gemini-1.5-flash"
        if multilingual_route
        else "models/gemini-2.5-flash,models/gemini-2.5-flash-lite,models/gemini-2.0-flash,models/gemini-1.5-flash"
    )
    raw_candidates = os.getenv(candidate_env_key, default_candidates)
    configured_models = [token.strip() for token in raw_candidates.split(",") if token.strip()]
    models = []

    if tuned_model:
        models.append(tuned_model)
    for candidate in configured_models:
        if candidate and candidate not in models:
            models.append(candidate)
    if base_model and base_model not in models:
        models.append(base_model)

    return models

def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

def infer_sentiment(text: str) -> str:
    low = (text or "").lower()
    happy_words = ("love", "joy", "fiesta", "baila", "dance", "happy", "smile")
    sad_words = ("sad", "cry", "llorar", "alone", "pain", "triste", "dark")
    energetic_words = ("run", "jump", "fight", "energia", "party", "beat", "drum")

    if any(w in low for w in energetic_words):
        return "energetic"
    if any(w in low for w in sad_words):
        return "sad"
    if any(w in low for w in happy_words):
        return "happy"
    return "nostalgic"

def infer_colors(sentiment: str) -> List[str]:
    mapping = {
        "happy": ["#FFD166", "#06D6A0", "#4ECDC4"],
        "energetic": ["#FF6B35", "#F94144", "#F9C74F"],
        "sad": ["#355070", "#6D597A", "#264653"],
        "dark": ["#1B1B1E", "#2D3142", "#4F5D75"],
        "nostalgic": ["#D9A05B", "#8D6A9F", "#7B8C6B"],
        "romantic": ["#FF758F", "#FF8FA3", "#FFC2D1"],
        "rebellious": ["#D90429", "#2B2D42", "#8D99AE"],
    }
    return mapping.get(sentiment, ["#4ECDC4", "#355070", "#FFD166"])

def extract_keywords(text: str, limit: int = 8) -> List[str]:
    tokens = re.findall(r"[A-Za-zÀ-ÿ]{4,}", text or "")
    counts: Dict[str, int] = {}
    stop = {
        "this", "that", "with", "para", "pero", "como", "cuando", "where", "your",
        "have", "from", "will", "just", "into", "about", "porque", "todos", "todas",
        "the", "and", "for", "are", "you", "una", "que", "del", "con", "por", "las",
        "los", "sus", "our", "they", "them", "their", "esta", "este", "como",
    }
    for t in tokens:
        key = t.lower()
        if key in stop:
            continue
        counts[key] = counts.get(key, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [k for k, _ in ranked[:limit]]

def make_visual_prompt(verse_text: str, visual_style: str) -> str:
    verse = (verse_text or "a cinematic portrait scene").strip()
    style = (visual_style or "photorealistic").strip()
    return (
        f"{verse}, dressed in casual clothes, natural pose, face focus, {style}, "
        "high quality, dramatic lighting, cinematic"
    )

def build_fallback_scenes(
    lyrics: str,
    segments: List[Dict[str, Any]] = None,
    visual_style: str = "",
    max_scenes: int = MAX_ANALYSIS_SCENES,
) -> List[Dict[str, Any]]:
    scenes: List[Dict[str, Any]] = []
    safe_segments = segments or []

    for seg in safe_segments:
        if len(scenes) >= max_scenes:
            break
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = safe_float(seg.get("start"), 0.0)
        end = safe_float(seg.get("end"), start + 5.0)
        if end <= start:
            end = start + 5.0
        scenes.append({
            "verseText": text,
            "startTime": start,
            "endTime": end,
            "visualPrompt": make_visual_prompt(text, visual_style),
            "duration": round(end - start, 3),
            "transitionType": "cut",
        })

    if scenes:
        return scenes

    lines = [ln.strip() for ln in (lyrics or "").splitlines() if ln.strip()]
    if not lines:
        lines = ["instrumental moment, emotive cinematic atmosphere"]

    for idx, line in enumerate(lines[:max_scenes]):
        start = float(idx * 5)
        end = start + 5.0
        scenes.append({
            "verseText": line,
            "startTime": start,
            "endTime": end,
            "visualPrompt": make_visual_prompt(line, visual_style),
            "duration": 5.0,
            "transitionType": "cut",
        })

    return scenes

def build_fallback_analysis(
    lyrics: str,
    visual_style: str,
    segments: List[Dict[str, Any]] = None,
    song_title: str = "",
    reason: str = "",
) -> Dict[str, Any]:
    source_text = lyrics or " ".join([(s.get("text") or "") for s in (segments or [])])
    sentiment = infer_sentiment(source_text)
    scenes = build_fallback_scenes(lyrics, segments, visual_style, MAX_ANALYSIS_SCENES)
    analysis = {
        "sentiment": sentiment,
        "mood": f"fallback analysis for {song_title or 'song'}".strip(),
        "keywords": extract_keywords(source_text),
        "colorSuggestions": infer_colors(sentiment),
        "scenes": scenes,
        "totalScenes": len(scenes),
        "_model": "fallback-local",
    }
    if reason:
        analysis["_fallbackReason"] = reason
    return analysis

def sanitize_analysis_payload(
    analysis: Dict[str, Any],
    lyrics: str,
    visual_style: str,
    segments: List[Dict[str, Any]] = None,
    song_title: str = "",
) -> Dict[str, Any]:
    if not isinstance(analysis, dict):
        return build_fallback_analysis(lyrics, visual_style, segments, song_title, "invalid-analysis-object")

    if not isinstance(analysis.get("scenes"), list) or not analysis.get("scenes"):
        analysis["scenes"] = build_fallback_scenes(lyrics, segments, visual_style, MAX_ANALYSIS_SCENES)

    sanitized_scenes: List[Dict[str, Any]] = []
    for i, scene in enumerate(analysis["scenes"][:MAX_ANALYSIS_SCENES]):
        if not isinstance(scene, dict):
            continue
        verse = (scene.get("verseText") or "").strip() or f"scene {i + 1}"
        start = safe_float(scene.get("startTime"), float(i * 5))
        end = safe_float(scene.get("endTime"), start + max(safe_float(scene.get("duration"), 5.0), 1.0))
        if end <= start:
            end = start + 5.0
        duration = end - start
        prompt = (scene.get("visualPrompt") or "").strip() or make_visual_prompt(verse, visual_style)
        transition = (scene.get("transitionType") or "cut").strip()
        if transition not in ("fade", "cut", "dissolve"):
            transition = "cut"

        sanitized_scenes.append({
            "verseText": verse,
            "startTime": round(start, 3),
            "endTime": round(end, 3),
            "visualPrompt": prompt,
            "duration": round(duration, 3),
            "transitionType": transition,
        })

    if not sanitized_scenes:
        sanitized_scenes = build_fallback_scenes(lyrics, segments, visual_style, MAX_ANALYSIS_SCENES)

    source_text = lyrics or " ".join([(s.get("text") or "") for s in (segments or [])])
    sentiment = (analysis.get("sentiment") or "").strip() or infer_sentiment(source_text)
    mood = (analysis.get("mood") or "").strip() or "fallback mood"
    keywords = analysis.get("keywords")
    if not isinstance(keywords, list):
        keywords = extract_keywords(source_text)
    color_suggestions = analysis.get("colorSuggestions")
    if not isinstance(color_suggestions, list) or not color_suggestions:
        color_suggestions = infer_colors(sentiment)

    analysis["sentiment"] = sentiment
    analysis["mood"] = mood
    analysis["keywords"] = [str(k) for k in keywords[:10]]
    analysis["colorSuggestions"] = [str(c) for c in color_suggestions[:5]]
    analysis["scenes"] = sanitized_scenes
    analysis["totalScenes"] = len(sanitized_scenes)
    analysis["_model"] = analysis.get("_model") or "unknown"
    return analysis

def normalize_text(text: str) -> str:
    """Normalize text for comparison"""
    return "".join(c.lower() for c in text if c.isalnum())

def align_scenes_with_segments(scenes: list, segments: list) -> list:
    """
    Align scenes with actual transcription segments to fix timestamp hallucinations.
    """
    if not segments or not scenes:
        return scenes

    print(f"Aligning {len(scenes)} scenes with {len(segments)} segments...", file=sys.stderr)

    # DEBUG: Show first 3 segments to verify transcription timing
    print(f"  📍 First segments from transcription:", file=sys.stderr)
    for i, seg in enumerate(segments[:3]):
        print(f"     [{i}] {seg.get('start', 0):.2f}s-{seg.get('end', 0):.2f}s: '{seg.get('text', '')[:30]}...'", file=sys.stderr)

    # DEBUG: Show first 3 scenes from Gemini
    print(f"  🎬 First scenes from Gemini:", file=sys.stderr)
    for i, scene in enumerate(scenes[:3]):
        print(f"     [{i}] {scene.get('startTime', 0):.2f}s: '{scene.get('verseText', '')[:30]}...'", file=sys.stderr)

    # Create a look-up for segments
    # We will try to map each scene to a range of segments
    
    current_segment_idx = 0
    aligned_scenes = []
    
    for i, scene in enumerate(scenes):
        verse_text = normalize_text(scene.get("verseText", ""))
        if not verse_text:
            continue
            
        # Find start segment
        best_match_idx = -1
        
        # Look ahead from current position
        for j in range(current_segment_idx, min(len(segments), current_segment_idx + 25)):
            seg_text = normalize_text(segments[j].get("text", ""))
            if seg_text and (seg_text in verse_text or verse_text in seg_text):
                best_match_idx = j
                break
        
        if best_match_idx != -1:
            real_start_time = segments[best_match_idx]["start"]
            scene["startTime"] = real_start_time
            # Assumption: scene ends at the start of the next matching segment or +5s
            scene["endTime"] = segments[best_match_idx]["end"] 
            
            aligned_scenes.append(scene)
            current_segment_idx = best_match_idx + 1
        else:
            # Fallback for unmatched scenes
            if aligned_scenes:
                prev_end = aligned_scenes[-1].get("endTime", aligned_scenes[-1]["startTime"] + 5)
                scene["startTime"] = prev_end
                scene["endTime"] = prev_end + 5
            else:
                # FIRST SCENE: Use first segment's start time, NOT Gemini's hallucinated time
                first_segment_start = segments[0]["start"] if segments else 0
                scene["startTime"] = first_segment_start
                scene["endTime"] = first_segment_start + 5
                print(f"  ⚠️ First scene unmatched - forcing start to first segment: {first_segment_start:.2f}s", file=sys.stderr)

            aligned_scenes.append(scene)

    # CRITICAL: Ensure first scene starts at or before first segment (no gap at beginning)
    if aligned_scenes and segments:
        first_segment_start = segments[0]["start"]
        if aligned_scenes[0]["startTime"] > first_segment_start + 2:  # Allow 2s tolerance
            print(f"  ⚠️ Fixing gap: First scene was at {aligned_scenes[0]['startTime']:.2f}s, moving to {first_segment_start:.2f}s", file=sys.stderr)
            aligned_scenes[0]["startTime"] = first_segment_start

    # Secondary pass: set endTime to the startTime of the next scene to avoid gaps
    for i in range(len(aligned_scenes) - 1):
        aligned_scenes[i]["endTime"] = aligned_scenes[i+1]["startTime"]
        aligned_scenes[i]["duration"] = aligned_scenes[i]["endTime"] - aligned_scenes[i]["startTime"]

    # Final scene duration
    if aligned_scenes:
        last = aligned_scenes[-1]
        # If we have transcription segments, use the end of the last segment if possible
        if segments:
            last["endTime"] = max(last["startTime"] + 5, segments[-1]["end"])
        else:
            last["endTime"] = last["startTime"] + 5
        last["duration"] = last["endTime"] - last["startTime"]

    # DEBUG: Show final aligned scenes
    print(f"  ✅ Aligned scenes result:", file=sys.stderr)
    for i, scene in enumerate(aligned_scenes[:3]):
        print(f"     [{i}] {scene.get('startTime', 0):.2f}s-{scene.get('endTime', 0):.2f}s: '{scene.get('verseText', '')[:30]}...'", file=sys.stderr)

    return aligned_scenes

def split_long_scenes(scenes: list) -> list:
    """
    Split scenes longer than 10 seconds into sub-scenes to add dynamism.
    """
    if not scenes:
        return scenes
        
    print(f"Checking {len(scenes)} scenes for duration split...")
    new_scenes = []
    
    for scene in scenes:
        start = scene.get("startTime", 0)
        end = scene.get("endTime", 0)
        duration = end - start
        
        # Threshold: if scene is longer than 10 seconds, split it
        if duration > 10:
            # Determine number of parts (approx 5-8s each)
            # e.g. 15s -> 2 parts (7.5s)
            # e.g. 22s -> 3 parts (7.3s)
            num_parts = int(duration / 7) + 1
            # CAP at 4 parts maximum per scene to avoid excessive splitting
            num_parts = min(num_parts, 4)
            part_duration = duration / num_parts
            
            print(f"  Splitting scene '{scene.get('verseText')[:20]}...' ({duration:.1f}s) into {num_parts} parts")
            
            base_prompt = scene.get("visualPrompt", "")
            # Remove quality keywords to append them later or keep them? 
            # Usually prompt ends with quality keywords. Let's assume we can just append variations.
            
            variations = [
                "", # First part: original
                ", different angle, side view",
                ", close up shot, detailed",
                ", wide angle, establishing shot",
                ", dynamic angle, cinematic composition"
            ]
            
            for i in range(num_parts):
                new_scene = scene.copy()
                new_scene["startTime"] = start + (i * part_duration)
                new_scene["endTime"] = start + ((i + 1) * part_duration)
                new_scene["duration"] = part_duration
                
                # Vary the prompt
                variation = variations[i % len(variations)]
                new_scene["visualPrompt"] = f"{base_prompt}{variation}"
                
                new_scenes.append(new_scene)
        else:
            new_scenes.append(scene)
            
    return new_scenes

def analyze_with_gemini(
    lyrics: str,
    visual_style: str,
    api_key: str,
    segments: list = None,
    song_title: str = "",
    primary_language: str = "unknown",
    deadline_ts: Optional[float] = None,
) -> dict:
    """Analyze lyrics using Gemini AI"""
    if not api_key:
        return build_fallback_analysis(
            lyrics=lyrics or "",
            visual_style=visual_style or "",
            segments=segments or [],
            song_title=song_title or "",
            reason="missing-gemini-api-key",
        )

    candidate_models = build_candidate_models(
        api_key,
        primary_language=primary_language,
        deadline_ts=deadline_ts,
    )

    language_hint = build_language_hint(primary_language)
    style_hint_base = f"The visual style should be: {visual_style}" if visual_style else ""
    style_hint = f"{style_hint_base}\n{language_hint}".strip()
    title_hint = f"SONG TITLE: {song_title}" if song_title else "SONG TITLE: Unknown"

    # Construct lyrics text with segments
    lyrics_content = ""
    if segments:
        lyrics_content = "Lyrics with timestamps (Format: [start-end] text):\n"
        # Find the first vocal segment to skip long silent intros if needed, 
        # but the user wants 60s total, so let's take a window of 60s of vocal activity
        total_vocal_duration = 0
        for seg in segments:
            start = seg.get('start', 0)
            end = seg.get('end', 0)
            lyrics_content += f"[{start:.2f}-{end:.2f}] {seg.get('text', '').strip()}\n"
            
            # Count duration of content
            if start > 0:
                # If we have more than 60s of *audio time* OR more than 40 segments, stop
                # (40 segments roughly equals ~1-2 mins of lyrics)
                if start > 60: break 
    else:
        lyrics_content = lyrics

    prompt_text = build_analysis_prompt(
        style_hint if style_hint else "Use realistic photographic style with dramatic lighting",
        title_hint,
        lyrics_content,
    )

    if not candidate_models:
        return build_fallback_analysis(
            lyrics=lyrics or "",
            visual_style=visual_style or "",
            segments=segments or [],
            song_title=song_title or "",
            reason="no-gemini-model-available",
        )

    last_error = None
    for index, model in enumerate(candidate_models):
        try:
            ensure_stage_deadline(deadline_ts, f"model_attempt:{model}")
            response_json = request_gemini_generate(model, api_key, prompt_text, deadline_ts=deadline_ts)
            candidates = response_json.get("candidates") or []
            if not candidates:
                raise Exception(f"Empty candidates response from model '{model}'")
            content = candidates[0].get("content") or {}
            parts = content.get("parts") or []
            if not parts:
                raise Exception(f"Missing response parts from model '{model}'")
            ai_text = parts[0].get("text") or ""
            if not ai_text.strip():
                raise Exception(f"Empty text response from model '{model}'")
            clean_json = ai_text.replace('```json', '').replace('```', '').strip()

            try:
                result = json.loads(clean_json)
            except json.JSONDecodeError:
                start = clean_json.find('{')
                end = clean_json.rfind('}') + 1
                result = json.loads(clean_json[start:end])

            result['_model'] = model
            result['_languageDetected'] = primary_language
            return sanitize_analysis_payload(
                analysis=result,
                lyrics=lyrics or "",
                visual_style=visual_style or "",
                segments=segments or [],
                song_title=song_title or "",
            )
        except Exception as e:
            last_error = e
            if index < len(candidate_models) - 1:
                print(f"Warning: model '{model}' failed. Falling back to next model. Error: {e}", file=sys.stderr)
                continue
            break

    reason = f"gemini-failed: {last_error}" if last_error else "gemini-failed-unknown"
    return build_fallback_analysis(
        lyrics=lyrics or "",
        visual_style=visual_style or "",
        segments=segments or [],
        song_title=song_title or "",
        reason=reason,
    )

def analyze_lyrics():
    """Main function to analyze lyrics for a project"""
    project = {
        "id": "",
        "title": "",
        "lyrics": "",
        "visualStyle": "",
        "colorPalette": [],
        "segments": []
    }
    project_id = ""

    try:
        deadline_ts = time.time() + ANALYZE_LYRICS_STAGE_TIMEOUT_SEC
        if len(sys.argv) >= 2:
            project_id = sys.argv[1]
            project["id"] = project_id
        else:
            print("Warning: Project ID not provided, using local fallback analysis.", file=sys.stderr)

        if project_id:
            try:
                ensure_stage_deadline(deadline_ts, "project_load")
                project = get_project_lyrics(project_id)
            except Exception as e:
                print(f"Warning: DB fetch failed, continuing with local fallback. Error: {e}", file=sys.stderr)
                project["id"] = project_id

        if project.get("segments"):
            original_count = len(project["segments"])
            project["segments"] = [s for s in project["segments"] if safe_float(s.get("start"), 0) < 60]
            if len(project["segments"]) < original_count:
                print(
                    f"  [TEST LIMIT] Capped transcription segments to first 60s ({len(project['segments'])} segments)",
                    file=sys.stderr,
                )

        api_key = os.getenv("GEMINI_API_KEY", "")
        segment_text = " ".join([(seg.get("text") or "").strip() for seg in project.get("segments", [])]).strip()
        language_source = (project.get("lyrics", "") or "").strip()
        if not language_source and segment_text:
            language_source = segment_text
        detected_language = detect_primary_language(language_source)
        print(f"Language route detected: {detected_language}", file=sys.stderr)

        if not project.get("lyrics") and not project.get("segments"):
            analysis = build_fallback_analysis(
                lyrics="",
                visual_style=project.get("visualStyle", ""),
                segments=[],
                song_title=project.get("title", ""),
                reason="no-lyrics-or-segments",
            )
        else:
            ensure_stage_deadline(deadline_ts, "gemini_analysis")
            analysis = analyze_with_gemini(
                project.get("lyrics", ""),
                project.get("visualStyle", ""),
                api_key,
                segments=project.get("segments", []),
                song_title=project.get("title", ""),
                primary_language=detected_language,
                deadline_ts=deadline_ts,
            )

        analysis = sanitize_analysis_payload(
            analysis=analysis,
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
        )
        if detected_language and not analysis.get("_languageDetected"):
            analysis["_languageDetected"] = detected_language

        if project.get("segments"):
            try:
                ensure_stage_deadline(deadline_ts, "scene_alignment")
                analysis["scenes"] = align_scenes_with_segments(analysis["scenes"], project["segments"])
                analysis["scenes"] = split_long_scenes(analysis["scenes"])
                if len(analysis["scenes"]) > MAX_ANALYSIS_SCENES:
                    print(
                        f"Capping scenes from {len(analysis['scenes'])} to {MAX_ANALYSIS_SCENES}",
                        file=sys.stderr,
                    )
                    analysis["scenes"] = analysis["scenes"][:MAX_ANALYSIS_SCENES]
                analysis["totalScenes"] = len(analysis["scenes"])
                analysis = sanitize_analysis_payload(
                    analysis=analysis,
                    lyrics=project.get("lyrics", ""),
                    visual_style=project.get("visualStyle", ""),
                    segments=project.get("segments", []),
                    song_title=project.get("title", ""),
                )
            except Exception as e:
                print(f"Warning: Scene alignment/split failed, keeping sanitized scenes. Error: {e}", file=sys.stderr)

        try:
            if "scenes" in analysis and CLASSIFIER_AVAILABLE:
                ensure_stage_deadline(deadline_ts, "verse_classification")
                print(f"Classifying {len(analysis['scenes'])} verses...", file=sys.stderr)
                previous_verses = []
                for scene in analysis["scenes"]:
                    verse_text = scene.get("verseText", "")
                    if verse_text:
                        try:
                            classification = classify_verse(verse_text, previous_verses)
                            scene["verseType"] = classification.get("type", "NARRATIVE")
                            scene["verseTypeReason"] = classification.get("reason", "")
                        except Exception:
                            classification = classify_verse_fallback(verse_text, previous_verses)
                            scene["verseType"] = classification.get("type", "NARRATIVE")
                        previous_verses.append(verse_text)
                    else:
                        scene["verseType"] = "NARRATIVE"
            elif "scenes" in analysis:
                for scene in analysis["scenes"]:
                    scene["verseType"] = "NARRATIVE"
        except Exception as e:
            print(f"Warning: Verse classification failed: {e}", file=sys.stderr)
            if "scenes" in analysis:
                for scene in analysis["scenes"]:
                    scene["verseType"] = scene.get("verseType", "NARRATIVE")

        if project_id:
            try:
                ensure_stage_deadline(deadline_ts, "save_analysis")
                save_analysis_result(project_id, analysis)
            except Exception as e:
                print(f"Warning: Could not save analysis to DB: {e}", file=sys.stderr)

        result_payload = with_result_status(analysis)
        emit_result(result_payload)
        return result_payload

    except TimeoutError as e:
        fallback = build_fallback_analysis(
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
            reason=f"analysis.timeout: {e}",
        )
        fallback = sanitize_analysis_payload(
            analysis=fallback,
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
        )
        result_payload = with_result_status(fallback)
        emit_result(result_payload)
        return result_payload
    except Exception as e:
        fallback = build_fallback_analysis(
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
            reason=f"unhandled-error: {e}",
        )
        fallback = sanitize_analysis_payload(
            analysis=fallback,
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
        )
        result_payload = with_result_status(fallback)
        emit_result(result_payload)
        return result_payload

if __name__ == "__main__":
    with hard_stage_deadline(ANALYZE_LYRICS_STAGE_TIMEOUT_SEC, "analysis"):
        analyze_lyrics()

