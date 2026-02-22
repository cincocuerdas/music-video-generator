#!/usr/bin/env python3
"""
Verse Classifier - Semantic analysis for cinematic video generation.
Classifies song verses into strict types for visual decision-making.

NOT creative. NOT poetic. Just infrastructure.
"""

import json
import os
import sys
import urllib.request
import urllib.error
from typing import Optional, Literal
from dotenv import load_dotenv

# Load .env
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

# Verse types enum
VerseType = Literal[
    "INTROSPECTIVE",
    "NARRATIVE",
    "LITERAL",
    "RHYTHMIC",
    "TRANSITION",
    "REPETITION"
]

CLASSIFIER_SYSTEM_PROMPT = """Rol del modelo

Actuás como un analista semántico estricto para videoclips cinematográficos.
Tu tarea NO es interpretar libremente ni ser poético.
Tu tarea es clasificar versos de canciones de forma consistente y repetible, para activar decisiones visuales automáticas.

Instrucciones globales (OBLIGATORIAS)

No inventes significado
No agregues emoción que no esté presente
No seas creativo
No sugieras imágenes
No hagas metáforas
No expliques literatura

👉 Solo clasificás. Nada más.

Salida esperada (FORMATO FIJO)

Respondé solo con un objeto JSON, sin texto adicional:

{
  "verse": "<texto original>",
  "type": "<VERSE_TYPE>",
  "reason": "<razón breve y objetiva>"
}

Tipos de verso permitidos (ENUM — NO INVENTAR OTROS)

Elegí UNO y solo uno:

INTROSPECTIVE
→ Estado interno, percepción, sentimiento contenido

NARRATIVE
→ Acción, situación, evento, avance de historia

LITERAL
→ Objeto concreto, hecho específico, causa directa

RHYTHMIC
→ Groove, repetición sonora, frase musical más que significado

TRANSITION
→ Conecta partes, cambia energía, prepara algo

REPETITION
→ Verso idéntico o casi idéntico a uno anterior con intención expresiva

Reglas de decisión (CRÍTICAS)

Si el verso describe una acción o situación → NARRATIVE
Si el verso expresa un estado interno → INTROSPECTIVE
Si el verso menciona un objeto o hecho específico → LITERAL
Si el verso funciona por ritmo más que significado → RHYTHMIC
Si el verso no aporta contenido nuevo pero cambia flujo → TRANSITION
Si el verso ya apareció antes → REPETITION

Casos límite (OBLIGATORIOS)

"oh", "ah", "yeah", "rub-a-dub" → RHYTHMIC
Versos de una sola palabra → clasificar por función, no longitud
Versos repetidos NO generan nueva semántica
No fuerces INTROSPECTIVE si no hay emoción explícita"""


def classify_verse(
    verse: str,
    previous_verses: list[str] = None,
    language: str = "auto"
) -> dict:
    """
    Classify a verse into one of the defined types using Gemini.

    Args:
        verse: The verse text to classify
        previous_verses: List of previous verses for repetition detection
        language: Original language of the verse

    Returns:
        dict with keys: verse, type, reason
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY not found, using fallback", file=sys.stderr)
        return classify_verse_fallback(verse, previous_verses)

    # Check for exact repetition first (fast path - no API call needed)
    if previous_verses:
        if verse.strip().lower() in [v.strip().lower() for v in previous_verses]:
            return {
                "verse": verse,
                "type": "REPETITION",
                "reason": "Exact or near-exact match with previous verse"
            }

    # Build context
    context_parts = [f'Verse: "{verse}"']
    if language != "auto":
        context_parts.append(f"Language: {language}")
    if previous_verses:
        context_parts.append(f"Previous verses: {previous_verses[-3:]}")  # Last 3 for context

    user_message = "\n".join(context_parts)
    full_prompt = f"{CLASSIFIER_SYSTEM_PROMPT}\n\n{user_message}"

    try:
        # Use Gemini Flash for fast classification
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
            # Clean JSON from markdown
            clean_json = ai_text.replace('```json', '').replace('```', '').strip()

            # Parse JSON
            try:
                result = json.loads(clean_json)
            except json.JSONDecodeError:
                start = clean_json.find('{')
                end = clean_json.rfind('}') + 1
                result = json.loads(clean_json[start:end])

            # Validate type
            valid_types = ["INTROSPECTIVE", "NARRATIVE", "LITERAL", "RHYTHMIC", "TRANSITION", "REPETITION"]
            if result.get("type") not in valid_types:
                result["type"] = "NARRATIVE"
                result["reason"] = "Invalid type returned, defaulting to NARRATIVE"

            return result

    except Exception as e:
        print(f"Gemini classification error: {e}", file=sys.stderr)
        return classify_verse_fallback(verse, previous_verses)


def classify_verse_fallback(verse: str, previous_verses: list[str] = None) -> dict:
    """
    Fallback classification using simple keyword heuristics.
    Used when LLM is unavailable.
    """
    verse_lower = verse.lower().strip()

    # Check repetition first
    if previous_verses:
        if verse_lower in [v.lower().strip() for v in previous_verses]:
            return {"verse": verse, "type": "REPETITION", "reason": "Exact match with previous verse"}

    # RHYTHMIC: minimal semantic content
    rhythmic_patterns = ["oh", "ah", "yeah", "uh", "la la", "na na", "rub-a-dub", "hey", "woo"]
    if any(verse_lower == p or verse_lower.startswith(p + " ") for p in rhythmic_patterns):
        return {"verse": verse, "type": "RHYTHMIC", "reason": "Minimal semantic content, rhythmic function"}

    if len(verse_lower.split()) <= 2:
        return {"verse": verse, "type": "RHYTHMIC", "reason": "Very short verse, likely rhythmic"}

    # INTROSPECTIVE: internal states
    introspective_kw = ["feel", "think", "wonder", "remember", "miss", "love", "hate",
                        "want", "need", "wish", "dream", "hope", "fear", "siento", "pienso"]
    if any(kw in verse_lower for kw in introspective_kw):
        return {"verse": verse, "type": "INTROSPECTIVE", "reason": "Contains internal state keywords"}

    # LITERAL: concrete objects/facts
    literal_kw = ["car", "phone", "door", "window", "hand", "eye", "street", "money",
                  "gun", "knife", "bottle", "glass", "clock", "card"]
    if any(kw in verse_lower for kw in literal_kw):
        return {"verse": verse, "type": "LITERAL", "reason": "Contains concrete object keywords"}

    # NARRATIVE: actions
    narrative_kw = ["walk", "run", "go", "come", "leave", "stay", "stand", "sit",
                   "look", "see", "watch", "hear", "say", "tell", "ask"]
    if any(kw in verse_lower for kw in narrative_kw):
        return {"verse": verse, "type": "NARRATIVE", "reason": "Contains action keywords"}

    # Default to NARRATIVE
    return {"verse": verse, "type": "NARRATIVE", "reason": "Default classification"}


def classify_all_verses(verses: list[str], language: str = "auto") -> list[dict]:
    """
    Classify all verses in a song, tracking previous verses for repetition detection.

    Args:
        verses: List of all verse texts
        language: Original language

    Returns:
        List of classification dicts
    """
    results = []
    previous_verses = []

    for verse in verses:
        classification = classify_verse(verse, previous_verses, language)
        results.append(classification)
        previous_verses.append(verse)

    return results


# CLI interface
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python verse_classifier.py <verse> [previous_verse1] [previous_verse2] ...")
        sys.exit(1)

    verse = sys.argv[1]
    previous = sys.argv[2:] if len(sys.argv) > 2 else None

    result = classify_verse(verse, previous)
    print(json.dumps(result, indent=2))
