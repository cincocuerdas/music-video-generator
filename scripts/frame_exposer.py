#!/usr/bin/env python3
"""
Frame Exposure Decision System

Decides if a generated image is good enough to be exposed to the user.
Acts as a cinematographic editor - only quality frames get shown.

NOT indulgent. NOT optimizing for speed. Thinking like a real video editor.
"""

import json
import os
import sys
import urllib.request
import urllib.error
from dotenv import load_dotenv

# Load .env
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_dotenv(os.path.join(root_dir, '.env'))


def _parse_int_env(name: str, fallback: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return fallback
    try:
        return int(raw)
    except Exception:
        return fallback

EXPOSER_SYSTEM_PROMPT = """Rol del modelo

Actuás como editor cinematográfico.
Tu tarea es decidir si una imagen generada para un verso es lo suficientemente buena para ser expuesta al usuario como parte del videoclip.

No generás imágenes.
No sugerís cambios.
Solo decidís: ¿se muestra o no?

Reglas obligatorias

No seas indulgente
No optimices por velocidad
No pienses como IA
Pensá como editor de videoclip profesional

Criterios de aprobación (TODOS deben cumplirse)

Un frame se expone solo si:

1. El protagonista es reconocible y consistente
2. La imagen refleja el verso sin literalidad burda
3. No hay artefactos evidentes (manos deformes, caras duplicadas, texto ilegible)
4. La emoción es legible
5. La imagen aporta algo nuevo al relato
6. Podría existir en un videoclip real

Si uno falla, no se expone.

Output esperado (FORMATO FIJO JSON)
{
  "expose": true | false,
  "reason": "breve razón objetiva",
  "failed_criteria": [] // lista de criterios que fallaron (si expose=false)
}

Sin texto adicional. Solo JSON."""


def decide_exposure(
    verse_text: str,
    verse_type: str,
    image_prompt: str,
    image_metadata: dict = None,
    protagonist_description: str = None,
    previous_frames_count: int = 0
) -> dict:
    """
    Decide if a generated image should be exposed to the user.

    Args:
        verse_text: Original verse lyrics
        verse_type: Classification (INTROSPECTIVE, NARRATIVE, etc.)
        image_prompt: The prompt used to generate the image
        image_metadata: Optional metadata about the generated image
        protagonist_description: Description of the protagonist for consistency check
        previous_frames_count: Number of frames already exposed

    Returns:
        dict with keys: expose (bool), reason (str), failed_criteria (list)
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        # No API key - default to expose (can't quality check)
        return {
            "expose": True,
            "reason": "No API key for quality check, defaulting to expose",
            "failed_criteria": []
        }

    # Build context for evaluation
    context = f"""
Verse: "{verse_text}"
Verse Type: {verse_type}
Image Prompt: "{image_prompt}"
Frame Number: {previous_frames_count + 1}
"""

    if protagonist_description:
        context += f"Protagonist: {protagonist_description}\n"

    if image_metadata:
        context += f"Image Metadata: {json.dumps(image_metadata)}\n"

    full_prompt = f"{EXPOSER_SYSTEM_PROMPT}\n\n{context}"

    try:
        model = "models/gemini-1.5-flash"
        generate_url = f"https://generativelanguage.googleapis.com/v1beta/{model}:generateContent?key={api_key}"

        headers = {'Content-Type': 'application/json'}
        data = {
            "contents": [{"parts": [{"text": full_prompt}]}],
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": 200
            }
        }
        json_data = json.dumps(data).encode('utf-8')

        req = urllib.request.Request(generate_url, data=json_data, headers=headers, method='POST')

        with urllib.request.urlopen(req, timeout=10) as response:
            response_body = response.read().decode('utf-8')
            response_json = json.loads(response_body)

            ai_text = response_json['candidates'][0]['content']['parts'][0]['text']
            clean_json = ai_text.replace('```json', '').replace('```', '').strip()

            try:
                result = json.loads(clean_json)
            except json.JSONDecodeError:
                start = clean_json.find('{')
                end = clean_json.rfind('}') + 1
                result = json.loads(clean_json[start:end])

            # Ensure required fields
            if "expose" not in result:
                result["expose"] = True
            if "reason" not in result:
                result["reason"] = "Decision made"
            if "failed_criteria" not in result:
                result["failed_criteria"] = []

            return result

    except Exception as e:
        print(f"Exposure decision error: {e}", file=sys.stderr)
        # On error, default to expose (don't block pipeline)
        return {
            "expose": True,
            "reason": f"Decision error, defaulting to expose: {str(e)[:50]}",
            "failed_criteria": []
        }


def is_plural_verse(verse_text: str) -> bool:
    """
    Heuristic: detect if verse describes plural subject/action.
    Supports common English and Spanish markers.
    """
    if not verse_text:
        return False

    verse_lower = verse_text.lower()
    tokens = {
        token.strip(".,;:!?()[]{}\"'") for token in verse_lower.split()
        if token.strip(".,;:!?()[]{}\"'")
    }

    plural_words = {
        "we", "us", "our", "ours", "they", "them", "their", "theirs",
        "friends", "people", "crowd", "group", "couple", "duo", "both", "two",
        "nosotros", "nosotras", "nos", "nuestro", "nuestra", "nuestros", "nuestras",
        "ellos", "ellas", "ustedes", "vosotros", "vosotras",
        "amigos", "amigas", "gente", "todos", "todas", "ambos", "ambas", "dos",
        "juntos", "juntas"
    }
    if any(word in tokens for word in plural_words):
        return True

    plural_phrases = [
        "all of us", "each other", "one another", "group of", "with friends",
        "con amigos", "con amigas", "entre nosotros", "entre nosotras"
    ]
    return any(phrase in verse_lower for phrase in plural_phrases)


def decide_exposure_fast(
    image_prompt: str,
    verse_type: str,
    verse_text: str = ""
) -> dict:
    """
    Fast heuristic-based exposure decision (no LLM call).
    Uses scoring system for nuanced decisions.

    Scoring:
        +2  clear protagonist (solo, 1girl, 1boy, portrait)
        +1  plural verse with coherent multi-person scene
        +2  verse type match
        +1  clean aesthetic (no artifacts keywords)
        +1  readable emotion (emotional keywords present)
        -2  visible text (text on clothing, words, letters)
        -2  multiple focus points when plural is NOT required
        -1  plural verse but prompt does not show multiple people
        -1  visual noise (busy, chaotic, cluttered)

    expose = score >= 3

    Returns:
        dict with keys: expose (bool), reason (str), score (int), breakdown (dict)
    """
    prompt_lower = image_prompt.lower()
    verse_plural = is_plural_verse(verse_text)
    score = 0
    breakdown = {}

    # Detect multi-person intent in prompt
    multi_keywords = [
        "multiple people", "two people", "three people", "crowd", "group of",
        "group", "friends", "couple", "duo", "team", "together", "both"
    ]
    has_multi = any(kw in prompt_lower for kw in multi_keywords)

    # ═══════════════════════════════════════════════════════════════════════════
    # POSITIVE SIGNALS
    # ═══════════════════════════════════════════════════════════════════════════

    # +2: Clear protagonist
    protagonist_keywords = ["solo", "1girl", "1boy", "1man", "1woman",
                           "single person", "portrait", "one person",
                           "protagonist", "the man", "the woman"]
    has_protagonist = any(kw in prompt_lower for kw in protagonist_keywords)
    if has_protagonist:
        score += 2
        breakdown["protagonist"] = "+2"
    elif verse_plural and has_multi:
        score += 1
        breakdown["protagonist"] = "+1 (plural verse with coherent group)"
    else:
        breakdown["protagonist"] = "0 (no clear protagonist marker)"

    # +2: Verse type match (MOST IMPORTANT)
    verse_type_match = False

    if verse_type == "INTROSPECTIVE":
        # Should have emotional/internal keywords
        introspective_match = ["alone", "thinking", "feeling", "reflection",
                              "contemplative", "quiet", "solitude", "memory"]
        if any(kw in prompt_lower for kw in introspective_match):
            verse_type_match = True
        # Surreal is ALLOWED for introspective
        if "surreal" in prompt_lower or "dreamlike" in prompt_lower:
            verse_type_match = True

    elif verse_type == "NARRATIVE":
        # Should have action/situation keywords
        narrative_match = ["walking", "standing", "looking", "holding",
                          "sitting", "running", "street", "room", "scene"]
        if any(kw in prompt_lower for kw in narrative_match):
            verse_type_match = True
        # Surreal is PENALIZED for narrative
        if "surreal" in prompt_lower or "abstract" in prompt_lower:
            score -= 1
            breakdown["surreal_penalty"] = "-1 (surreal in NARRATIVE)"

    elif verse_type == "LITERAL":
        # Should have concrete object/place keywords
        literal_match = ["car", "phone", "door", "window", "object",
                        "specific", "concrete", "detail", "close-up"]
        if any(kw in prompt_lower for kw in literal_match):
            verse_type_match = True
        # Surreal is PENALIZED for literal
        if "surreal" in prompt_lower or "abstract" in prompt_lower:
            score -= 1
            breakdown["surreal_penalty"] = "-1 (surreal in LITERAL)"

    elif verse_type == "RHYTHMIC":
        # Can be abstract, movement-focused
        rhythmic_match = ["motion", "blur", "movement", "dancing", "rhythm",
                         "energy", "dynamic", "abstract", "flowing"]
        if any(kw in prompt_lower for kw in rhythmic_match):
            verse_type_match = True
        # Abstract is IDEAL for rhythmic
        if "abstract" in prompt_lower or "motion blur" in prompt_lower:
            score += 1
            breakdown["abstract_bonus"] = "+1 (abstract in RHYTHMIC)"

    elif verse_type == "TRANSITION":
        # Environment focused, protagonist optional
        transition_match = ["landscape", "sky", "environment", "atmosphere",
                           "wide shot", "establishing", "empty", "silhouette"]
        if any(kw in prompt_lower for kw in transition_match):
            verse_type_match = True
        # Surreal is IDEAL for transition
        if "surreal" in prompt_lower or "atmospheric" in prompt_lower:
            score += 1
            breakdown["surreal_bonus"] = "+1 (surreal in TRANSITION)"

    elif verse_type == "REPETITION":
        # Should maintain consistency, any scene works
        verse_type_match = True  # Repetition is flexible

    if verse_type_match:
        score += 2
        breakdown["verse_match"] = f"+2 ({verse_type} matched)"
    else:
        breakdown["verse_match"] = f"0 ({verse_type} not matched)"

    # +1: Clean aesthetic
    noise_keywords = ["busy", "chaotic", "cluttered", "messy", "noisy"]
    if not any(kw in prompt_lower for kw in noise_keywords):
        score += 1
        breakdown["aesthetic"] = "+1 (clean)"
    else:
        score -= 1
        breakdown["aesthetic"] = "-1 (visual noise)"

    # +1: Readable emotion
    emotion_keywords = ["emotional", "expression", "feeling", "mood",
                       "intense", "peaceful", "sad", "happy", "melancholic",
                       "dramatic", "cinematic"]
    if any(kw in prompt_lower for kw in emotion_keywords):
        score += 1
        breakdown["emotion"] = "+1 (readable)"
    else:
        breakdown["emotion"] = "0 (neutral)"

    # ═══════════════════════════════════════════════════════════════════════════
    # NEGATIVE SIGNALS
    # ═══════════════════════════════════════════════════════════════════════════

    # -2: Visible text
    text_keywords = ["text on", "words on", "letters on", "writing on",
                    "sign saying", "text visible", "words visible"]
    if any(kw in prompt_lower for kw in text_keywords):
        score -= 2
        breakdown["text"] = "-2 (visible text)"

    # Plural coherence check (lyrics vs prompt subject count)
    if verse_plural and has_multi:
        score += 1
        breakdown["plural_match"] = "+1 (plural verse with multiple people)"
    elif verse_plural and not has_multi:
        score -= 1
        breakdown["plural_match"] = "-1 (plural verse but no multi-person cue)"

    # Multiple focus points (nuanced check)
    if has_multi:
        # Check if there's still a clear focus despite multiple people
        focus_keywords = ["focused on", "main subject", "in focus",
                         "foreground", "protagonist in"]
        has_clear_focus = any(kw in prompt_lower for kw in focus_keywords)

        if verse_plural:
            if has_clear_focus:
                breakdown["multi_focus"] = "0 (plural verse, clear group focus)"
            else:
                score -= 1
                breakdown["multi_focus"] = "-1 (plural verse, multiple people but no clear focus)"
        else:
            if has_clear_focus:
                # Multiple people but clear focus = minor penalty
                score -= 1
                breakdown["multi_focus"] = "-1 (multiple people, but clear focus)"
            else:
                # Multiple people without clear focus = major penalty
                score -= 2
                breakdown["multi_focus"] = "-2 (multiple people, no clear focus)"

    # ═══════════════════════════════════════════════════════════════════════════
    # DECISION
    # ═══════════════════════════════════════════════════════════════════════════

    expose = score >= 3
    reason_parts = [f"{k}: {v}" for k, v in breakdown.items()]

    return {
        "expose": expose,
        "reason": f"Score {score}/7 - {'EXPOSED' if expose else 'SKIPPED'}",
        "score": score,
        "breakdown": breakdown,
        "failed_criteria": [] if expose else [r for r in reason_parts if "-" in r]
    }


def check_protagonist_consistency(
    protagonist_base: str,
    image_prompt: str,
    verse_text: str,
    previous_prompts: list[str] = None
) -> dict:
    """
    Protagonist Consistency Guard - Script supervisor cinematográfico.

    Evalúa si la imagen mantiene continuidad con el protagonista establecido.

    Rules:
        - La ropa puede variar
        - El ángulo puede variar
        - La iluminación puede variar
        - La ESENCIA no puede variar

    Questions to answer:
        - ¿Podría ser la misma persona 10 segundos después?
        - ¿Rompe la ilusión de continuidad?
        - ¿El espectador dudaría?

    Args:
        protagonist_base: Description of the established protagonist
        image_prompt: The prompt for the current image
        verse_text: Current verse lyrics
        previous_prompts: List of previous image prompts for context

    Returns:
        dict with keys: consistent (bool), reason (str)
    """
    if not protagonist_base:
        return {
            "consistent": True,
            "reason": "No protagonist base established"
        }

    prompt_lower = image_prompt.lower()
    base_lower = protagonist_base.lower()

    # ═══════════════════════════════════════════════════════════════════════════
    # EXTRACT CORE IDENTITY MARKERS FROM BASE
    # ═══════════════════════════════════════════════════════════════════════════

    # Gender markers
    male_markers = ["man", "boy", "male", "he", "his", "guy", "1boy", "1man"]
    female_markers = ["woman", "girl", "female", "she", "her", "1girl", "1woman"]

    base_is_male = any(m in base_lower for m in male_markers)
    base_is_female = any(m in base_lower for m in female_markers)
    prompt_is_male = any(m in prompt_lower for m in male_markers)
    prompt_is_female = any(m in prompt_lower for m in female_markers)

    # Age markers
    young_markers = ["young", "teenage", "youth", "20s", "twenties"]
    old_markers = ["old", "elderly", "aged", "60s", "gray hair", "wrinkled"]

    base_is_young = any(m in base_lower for m in young_markers)
    base_is_old = any(m in base_lower for m in old_markers)
    prompt_is_young = any(m in prompt_lower for m in young_markers)
    prompt_is_old = any(m in prompt_lower for m in old_markers)

    # Distinctive features (things that shouldn't change)
    distinctive_features = []
    feature_keywords = ["tattoo", "scar", "beard", "glasses", "bald", "long hair",
                       "short hair", "curly", "straight hair", "freckles", "piercing"]

    for feature in feature_keywords:
        if feature in base_lower:
            distinctive_features.append(feature)

    # ═══════════════════════════════════════════════════════════════════════════
    # CONSISTENCY CHECKS
    # ═══════════════════════════════════════════════════════════════════════════

    issues = []

    # Gender consistency (CRITICAL)
    if base_is_male and prompt_is_female:
        issues.append("Gender mismatch: base is male, prompt has female")
    if base_is_female and prompt_is_male:
        issues.append("Gender mismatch: base is female, prompt has male")

    # Age consistency (IMPORTANT)
    if base_is_young and prompt_is_old:
        issues.append("Age mismatch: base is young, prompt is old")
    if base_is_old and prompt_is_young:
        issues.append("Age mismatch: base is old, prompt is young")

    # Distinctive features (if established, should persist)
    for feature in distinctive_features:
        # We don't require the feature to be mentioned every time,
        # but if the opposite is mentioned, that's a problem
        opposite_features = {
            "beard": ["clean shaven", "no beard", "beardless"],
            "bald": ["long hair", "full hair", "hair flowing"],
            "glasses": ["no glasses", "without glasses"],
            "long hair": ["bald", "short hair", "shaved head"],
            "short hair": ["long hair", "hair flowing"],
        }

        if feature in opposite_features:
            for opposite in opposite_features[feature]:
                if opposite in prompt_lower:
                    issues.append(f"Feature conflict: base has {feature}, prompt has {opposite}")

    # ═══════════════════════════════════════════════════════════════════════════
    # DECISION
    # ═══════════════════════════════════════════════════════════════════════════

    if issues:
        return {
            "consistent": False,
            "reason": issues[0],  # Return first issue
            "all_issues": issues
        }

    return {
        "consistent": True,
        "reason": "Protagonist identity maintained"
    }


def full_exposure_check(
    image_prompt: str,
    verse_type: str,
    protagonist_base: str = None,
    verse_text: str = None,
    previous_prompts: list[str] = None
) -> dict:
    """
    Complete exposure check pipeline with CASTING MODE:

    Flow:
        1. SCORING FAST (quality check)
        2. ANCHOR CHECK:
           - NO protagonist_base → CASTING MODE (score >= 6 required)
           - SI protagonist_base → CONTINUITY GUARD

    CASTING MODE:
        - No usamos Frame 1 automáticamente como base
        - El primer frame con "score perfecto" (>= 6) se convierte en ANCHOR
        - Frames con score < 6 se descartan hasta encontrar el anchor

    Returns:
        dict with keys:
            - expose (bool): Should frame be shown
            - reason (str): Explanation
            - set_as_anchor (bool): Should this frame become protagonist base
            - checks (dict): Detailed check results
    """
    # ═══════════════════════════════════════════════════════════════════════════
    # STEP 1: SCORING FAST (Quality Check)
    # ═══════════════════════════════════════════════════════════════════════════
    quality_result = decide_exposure_fast(image_prompt, verse_type, verse_text or "")
    score = quality_result.get("score", 0)
    verse_plural = is_plural_verse(verse_text or "")

    # ═══════════════════════════════════════════════════════════════════════════
    # STEP 2: ANCHOR CHECK
    # ═══════════════════════════════════════════════════════════════════════════

    # ┌─────────────────────────────────────────────────────────────────────────┐
    # │ CASO A: NO HAY PROTAGONIST_BASE → CASTING MODE                          │
    # │ Buscamos el frame perfecto para establecer el anchor                    │
    # └─────────────────────────────────────────────────────────────────────────┘
    if not protagonist_base:
        # Plural verses do not require a single-person anchor.
        if verse_plural:
            if quality_result["expose"]:
                return {
                    "expose": True,
                    "set_as_anchor": False,
                    "reason": f"CASTING: plural verse approved (score {score}/7, no solo anchor needed)",
                    "checks": {
                        "quality": quality_result,
                        "consistency": None,
                        "mode": "CASTING_PLURAL"
                    }
                }
            return {
                "expose": False,
                "set_as_anchor": False,
                "reason": f"CASTING: plural verse failed quality check ({score}/7)",
                "checks": {
                    "quality": quality_result,
                    "consistency": None,
                    "mode": "CASTING_PLURAL"
                }
            }

        # CASTING MODE: Need score >= threshold to become anchor.
        # Default relaxed to 5 to avoid frozen timelines from over-strict gating.
        CASTING_THRESHOLD = max(1, _parse_int_env("FRAME_EXPOSER_CASTING_THRESHOLD", 5))

        if score >= CASTING_THRESHOLD:
            # ¡FOUND THE ANCHOR! Este frame establece al protagonista
            return {
                "expose": True,
                "set_as_anchor": True,
                "reason": f"🎬 CASTING: Score {score}/7 - ANCHOR ESTABLISHED",
                "checks": {
                    "quality": quality_result,
                    "consistency": None,
                    "mode": "CASTING"
                }
            }
        else:
            # Not good enough to be the anchor - SKIP
            return {
                "expose": False,
                "set_as_anchor": False,
                "reason": f"⏳ CASTING: Score {score}/7 < {CASTING_THRESHOLD} - Waiting for perfect frame",
                "checks": {
                    "quality": quality_result,
                    "consistency": None,
                    "mode": "CASTING"
                }
            }

    # ┌─────────────────────────────────────────────────────────────────────────┐
    # │ CASO B: HAY PROTAGONIST_BASE → CONTINUITY GUARD                         │
    # │ Ya tenemos anchor, verificamos consistencia                             │
    # └─────────────────────────────────────────────────────────────────────────┘

    # First check if quality passes basic threshold
    if not quality_result["expose"]:
        return {
            "expose": False,
            "set_as_anchor": False,
            "reason": f"Quality check failed: {quality_result['reason']}",
            "checks": {
                "quality": quality_result,
                "consistency": None,
                "mode": "CONTINUITY_GUARD"
            }
        }

    # Plural verses can validly switch to multi-person composition.
    # Keep quality gate, relax single-protagonist consistency gate.
    if verse_plural:
        return {
            "expose": True,
            "set_as_anchor": False,
            "reason": f"CONTINUITY: plural verse approved by quality check (score {score}/7)",
            "checks": {
                "quality": quality_result,
                "consistency": None,
                "mode": "CONTINUITY_GUARD_PLURAL"
            }
        }

    # Then check protagonist consistency
    consistency_result = check_protagonist_consistency(
        protagonist_base,
        image_prompt,
        verse_text or "",
        previous_prompts
    )

    if not consistency_result["consistent"]:
        return {
            "expose": False,
            "set_as_anchor": False,
            "reason": f"Consistency check failed: {consistency_result['reason']}",
            "checks": {
                "quality": quality_result,
                "consistency": consistency_result,
                "mode": "CONTINUITY_GUARD"
            }
        }

    # Both passed - expose with existing anchor
    return {
        "expose": True,
        "set_as_anchor": False,
        "reason": f"✓ CONTINUITY: Score {score}/7, Consistency OK",
        "checks": {
            "quality": quality_result,
            "consistency": consistency_result,
            "mode": "CONTINUITY_GUARD"
        }
    }


# CLI interface
if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python frame_exposer.py <verse> <verse_type> <image_prompt>")
        sys.exit(1)

    verse = sys.argv[1]
    verse_type = sys.argv[2]
    prompt = sys.argv[3]

    result = decide_exposure(verse, verse_type, prompt)
    print(json.dumps(result, indent=2))
