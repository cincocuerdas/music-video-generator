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
from typing import Any, Dict, List
from dotenv import load_dotenv
from db_utils import get_db_connection

# Import verse classifier
try:
    from verse_classifier import classify_verse, classify_verse_fallback
    CLASSIFIER_AVAILABLE = True
except ImportError:
    CLASSIFIER_AVAILABLE = False

# Fix Windows console encoding issues
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Load configuration
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)
TUNED_MODEL_CONFIG_PATH = os.getenv(
    "GEMINI_TUNED_MODEL_CONFIG_PATH",
    os.path.join(root_dir, "storage", "gemini-tuned-model.json")
)
MAX_ANALYSIS_SCENES = int(os.getenv("ANALYSIS_MAX_SCENES", "15"))


def get_gemini_api_base_url() -> str:
    value = (os.getenv("GEMINI_API_BASE_URL") or "").strip()
    if not value:
        return "https://generativelanguage.googleapis.com"
    return value.rstrip("/")


def emit_result(payload):
    output = json.dumps(payload, ensure_ascii=False)
    print(output)
    print(f"RESULT_JSON:{output}", file=sys.stderr)

def with_result_status(analysis: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(analysis) if isinstance(analysis, dict) else {}
    fallback_reason = str(payload.get("_fallbackReason") or "").strip()
    model_name = str(payload.get("_model") or "").strip().lower()
    degraded = bool(fallback_reason) or model_name.startswith("fallback")
    payload["status"] = "degraded" if degraded else "success"
    payload["success"] = True
    payload["degraded"] = degraded
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

def get_gemini_model(api_key: str) -> str:
    """Find available Gemini model"""
    base_url = get_gemini_api_base_url()
    list_url = f"{base_url}/v1beta/models?key={api_key}"
    chosen_model = "models/gemini-1.5-flash"
    list_timeout_sec = int(os.getenv("GEMINI_MODELS_TIMEOUT_SEC", "10"))

    try:
        with urllib.request.urlopen(list_url, timeout=list_timeout_sec) as response:
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

def request_gemini_generate(model: str, api_key: str, prompt_text: str) -> dict:
    """Call Gemini generateContent for a specific model."""
    base_url = get_gemini_api_base_url()
    generate_url = f"{base_url}/v1beta/{model}:generateContent?key={api_key}"

    headers = {'Content-Type': 'application/json'}
    data = {"contents": [{"parts": [{"text": prompt_text}]}]}
    json_data = json.dumps(data).encode('utf-8')
    timeout_sec = int(os.getenv("GEMINI_REQUEST_TIMEOUT_SEC", "45"))
    retries = int(os.getenv("GEMINI_REQUEST_RETRIES", "2"))

    last_error = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(generate_url, data=json_data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as response:
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

        sleep_for = min(2 ** attempt, 8)
        time.sleep(sleep_for)

    if last_error:
        raise last_error
    raise Exception(f"Unknown error calling model '{model}'")

def build_candidate_models(api_key: str) -> list:
    """Use tuned model first, then base model fallback."""
    base_model = get_gemini_model(api_key)
    tuned_model = get_tuned_gemini_model()
    models = []

    if tuned_model:
        models.append(tuned_model)
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

def analyze_with_gemini(lyrics: str, visual_style: str, api_key: str, segments: list = None, song_title: str = "") -> dict:
    """Analyze lyrics using Gemini AI"""
    if not api_key:
        return build_fallback_analysis(
            lyrics=lyrics or "",
            visual_style=visual_style or "",
            segments=segments or [],
            song_title=song_title or "",
            reason="missing-gemini-api-key",
        )

    candidate_models = build_candidate_models(api_key)

    style_hint = f"The visual style should be: {visual_style}" if visual_style else ""
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

    prompt_text = f"""
    You are an expert music video director. Your job is to create visual prompts for AI image generation based on song lyrics.
    
    LANGUAGE: The lyrics may be in ANY language. Understand the meaning and create prompts in ENGLISH.

    ===== CRITICAL RULES - FOLLOW EXACTLY =====
    
    RULE 1 - EXTREME LITERALISM (MOST IMPORTANT):
    Every visual prompt MUST show EXACTLY what the lyrics describe. NO metaphors, NO abstractions.
    - If lyrics say "beat that drum" → show a person PLAYING A DRUM
    - If lyrics say "walking in the rain" → show a person WALKING IN RAIN
    - If lyrics say "dancing" → show a person DANCING
    - NEVER use generic "person gazing into distance" - that's LAZY and WRONG

    RULE 2 - EACH SCENE MUST BE UNIQUE:
    EVERY scene must have a DIFFERENT visual prompt. Never repeat the same description.
    If the lyrics repeat, show the same concept from a DIFFERENT ANGLE or with DIFFERENT DETAILS.

    RULE 3 - MATCH THE MOOD:
    If the song is ENERGETIC → show DYNAMIC poses, movement, action
    If the song is SAD → show melancholic expressions, rain, dark colors
    If the song is HAPPY → show smiling faces, bright colors, celebration

    RULE 4 - INCLUDE SPECIFIC OBJECTS FROM LYRICS:
    If the song mentions: drum, guitar, car, phone, rain, sun, etc.
    That object MUST appear in the scene. Don't ignore concrete nouns.
    
    RULE 5 - NO TEXT IN IMAGES:
    Never ask for text, signs, letters, or words.

    RULE 6 - QUALITY KEYWORDS:
    Always end prompts with: "wearing casual clothes, portrait shot, face focus, detailed face, high quality, dramatic lighting, cinematic"

    RULE 7 - PERSON COUNT MUST MATCH THE LYRICS (CRITICAL):
    The number of people in each scene MUST follow the verse meaning.
    - If the verse is SINGULAR (I, me, my, he, she, one person), show EXACTLY ONE person.
      Use tags like "solo, 1girl" or "solo, 1boy".
    - If the verse is PLURAL (we, us, our, they, friends, people, crowd, couple, two), show MULTIPLE people.
      Use tags like "two people", "group of friends", "crowd", or "couple" when the lyrics require it.
    - For plural scenes, prefer SMALL COHERENT GROUPS (2 to 6 people) unless lyrics explicitly require a massive crowd/protest.
    - In multi-person scenes, require clear foreground faces and natural hands (five fingers per hand), but DO NOT force hand close-ups.
    - NEVER force "solo" when the lyrics clearly describe plural actions.
    - Keep one clear main action and composition focus even in plural scenes.

    RULE 8 - MANDATORY CLOTHING (CRITICAL):
    ALL people in scenes MUST be FULLY CLOTHED. Always specify clothing:
    - "wearing a t-shirt and jeans"
    - "dressed in casual clothes"
    - "wearing a hoodie"
    - "in formal attire"
    NEVER create prompts with nude, shirtless, or underdressed people.

    RULE 9 - NATURE KEYWORDS REQUIRE NATURE SCENES:
    If lyrics mention: "nature", "forest", "ocean", "sea", "tree", "mountain", "sky", "sun", "mystic"
    Then the prompt MUST show NATURAL landscapes. NO cities, NO streets, NO buildings.

    RULE 10 - MANDATORY LOCATION INCLUSION (CRITICAL):
    BEFORE creating any prompts, identify if the song mentions ANY location (city, country, landmark).
    If the song title, lyrics, or theme includes a location like "Paris", "London", "Jamaica", etc.:
    - EVERY SINGLE PROMPT must include that location's iconic elements
    - The location MUST be clearly visible in EVERY scene
    - Example for "Paris": EVERY prompt must include "in Paris, Eiffel Tower visible in background, Parisian architecture, French cafe, Seine river"
    - Example for "Jamaica": EVERY prompt must include "in Jamaica, Caribbean beach, palm trees, reggae culture, tropical setting"

    THIS IS NON-NEGOTIABLE. If the song is about Paris, EVERY image must show Paris.

    RULE 11 - SCENE COMPOSITION:
    Each prompt should describe:
    1. LOCATION (from Rule 10 - mandatory if song has one)
    2. SUBJECT (person in casual clothes, object, or scene element from lyrics)
    3. ACTION (what is happening - use RULE 12 for action verbs!)
    4. STYLE (cinematic, dramatic lighting)

    Example good prompt (singular): "solo, 1girl, a joyful woman in Paris, Eiffel Tower in background, wearing casual blue dress, portrait shot, face focus, golden sunset lighting, cinematic, photorealistic"
    Example good prompt (plural): "two friends walking together in Paris near the Seine, both wearing casual clothes, medium shot, cinematic golden sunset lighting, photorealistic"
    Example bad prompt: "A woman smiling" (no specific action, no clothing, no composition guidance)
    Example bad prompt: "solo, 1girl" when the verse clearly says "we dance together"

    RULE 12 - ACTION VERB TRANSFORMATION (CRITICAL FOR DYNAMIC SCENES):
    AI image generators struggle with action verbs. You MUST:
    1. Transform actions into EXPLICIT PHYSICAL DESCRIPTIONS
    2. ONLY describe hand-object grip when the action explicitly requires object interaction
    3. NEVER force hands to be prominently shown if the lyric does not mention them

    DRINKING → "fingers wrapped around wine glass stem, glass rim touching lips, head tilted back, eyes closed enjoying the drink"
    EATING → "hand gripping fork, fork raised to open mouth, food visible on fork"
    RUNNING → "mid-stride with one leg extended forward, arms pumping, hair flowing"
    DANCING → "arms raised above head, hips twisted, mid-spin motion"
    SINGING → "hand gripping microphone, microphone pressed against lips, mouth wide open singing"
    CRYING → "tears streaming down cheeks, eyes red and wet, hands covering face"
    LAUGHING → "head thrown back, mouth wide open showing teeth, eyes squinting with joy"
    FIGHTING → "fist clenched tight, arm extended forward mid-punch, knuckles visible"
    WALKING → "one foot lifted mid-step, body leaning forward slightly"
    JUMPING → "both feet off ground, knees bent, arms reaching upward"
    SMOKING → "fingers holding cigarette, cigarette between lips, smoke rising from tip"
    PRAYING → "palms pressed flat together at chest level, fingers interlocked, head bowed"
    KISSING (singular) → "puckered lips, eyes closed, leaning forward"
    KISSING (plural) → "two people kissing, faces close, eyes closed, hands touching"

    CRITICAL FOR HAND-OBJECT SCENES:
    - For object interactions, mention physical connection (example: "fingers wrapped around", "hand gripping")
    - Mention where object touches body only when relevant (example: "glass rim touching lips")
    - NEVER leave objects floating - they must be connected to hands or body
    - For non-object actions, keep hands natural and secondary to the main action
    - Avoid staged hand poses or hand-dominant framing unless lyrics explicitly require it
    - Avoid cliché "head resting on hand" compositions unless lyrics explicitly describe that gesture
    - In group scenes, do NOT make all characters touch their faces/hands at once

    The key is: keep the scene action-first; hand detail is contextual, not mandatory.

    RULE 13 - METAPHOR AND SIMILE HANDLING (CRITICAL):
    When lyrics use comparisons like "like X" or "as X", focus on the ACTION, not the comparison object:

    "drink wine LIKE WATER" → Focus on DRINKING WINE casually. Do NOT show multiple glasses or water.
    "run LIKE THE WIND" → Focus on RUNNING fast. Do NOT show wind or air.
    "cry LIKE A BABY" → Focus on CRYING intensely. Do NOT show a baby.
    "fight LIKE A LION" → Focus on FIGHTING fiercely. Do NOT show a lion.
    "sweet LIKE HONEY" → Focus on the sweet expression/moment. Do NOT show honey.

    The comparison is FIGURATIVE - it describes HOW the action is done, not WHAT to show.
    NEVER add extra objects based on the comparison. Keep one coherent action and one coherent scene.
    Person count must still match the verse (singular vs plural).

    RULE 14 - MINIMUM SCENE DENSITY (CRITICAL):
    You MUST generate AT LEAST one scene per 5 seconds of lyrics content.
    - If lyrics cover 60 seconds → generate AT LEAST 12 scenes
    - If lyrics cover 30 seconds → generate AT LEAST 6 scenes
    - NEVER skip verses or combine too many verses into one scene
    - Each meaningful verse line should have its own scene
    - The visual STYLE does NOT affect scene count - Film Noir should have the SAME number of scenes as Cinematic

    ===== STYLE =====
    {style_hint if style_hint else "Use realistic photographic style with dramatic lighting"}

    ===== SONG INFO =====
    {title_hint}

    ===== LYRICS TO ANALYZE =====
    {lyrics_content}

    ===== OUTPUT FORMAT (JSON ONLY) =====
    {{
        "sentiment": "happy|sad|dark|energetic|romantic|nostalgic|rebellious",
        "mood": "brief description",
        "keywords": ["keyword1", "keyword2", "keyword3"],
        "colorSuggestions": ["#hex1", "#hex2", "#hex3"],
        "scenes": [
            {{
                "verseText": "the actual lyrics for this scene",
                "startTime": 0.0,  # Start time in seconds (from provided timestamps)
                "endTime": 5.0,    # End time in seconds
                "visualPrompt": "LITERAL visual description following rules above, ending with quality keywords",
                "duration": 5,
                "transitionType": "fade|cut|dissolve"
            }}
        ],
        "totalScenes": number
    }}

    SCENE GENERATION REQUIREMENTS:
    - Create one scene per meaningful verse line or short verse block (2-3 lines max)
    - Generate AT LEAST one scene every 5 seconds of audio content
    - Use the provided timestamps to set "startTime" and "endTime" for each scene
    - The visual style DOES NOT reduce scene count - all styles need the same scene density

    Respond with ONLY valid JSON.
    """

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
            response_json = request_gemini_generate(model, api_key, prompt_text)
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
        if len(sys.argv) >= 2:
            project_id = sys.argv[1]
            project["id"] = project_id
        else:
            print("Warning: Project ID not provided, using local fallback analysis.", file=sys.stderr)

        if project_id:
            try:
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

        if not project.get("lyrics") and not project.get("segments"):
            analysis = build_fallback_analysis(
                lyrics="",
                visual_style=project.get("visualStyle", ""),
                segments=[],
                song_title=project.get("title", ""),
                reason="no-lyrics-or-segments",
            )
        else:
            analysis = analyze_with_gemini(
                project.get("lyrics", ""),
                project.get("visualStyle", ""),
                api_key,
                segments=project.get("segments", []),
                song_title=project.get("title", "")
            )

        analysis = sanitize_analysis_payload(
            analysis=analysis,
            lyrics=project.get("lyrics", ""),
            visual_style=project.get("visualStyle", ""),
            segments=project.get("segments", []),
            song_title=project.get("title", ""),
        )

        if project.get("segments"):
            try:
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
                save_analysis_result(project_id, analysis)
            except Exception as e:
                print(f"Warning: Could not save analysis to DB: {e}", file=sys.stderr)

        result_payload = with_result_status(analysis)
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
    analyze_lyrics()

