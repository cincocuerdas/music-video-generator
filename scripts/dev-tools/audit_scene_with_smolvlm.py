#!/usr/bin/env python3
"""
Optional visual QA helper using HuggingFaceTB/SmolVLM2-500M-Video-Instruct.

This script is intentionally isolated from the main pipeline:
- no required dependency is added to requirements.txt
- heavy imports happen lazily
- output is a JSON audit artifact suitable for manual review or future gates
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_ID = "HuggingFaceTB/SmolVLM2-500M-Video-Instruct"
DEFAULT_OUTPUT_DIR = ROOT / "output" / "audit" / "smolvlm"

ARTIFACT_KEYWORDS = {
    "face_distortion": ["deformed face", "distorted face", "warped face", "melted face"],
    "mouth_distortion": ["extra mouth", "distorted mouth", "duplicated teeth", "double mouth"],
    "eye_distortion": ["extra eye", "three eyes", "distorted eye", "duplicated eye"],
    "hand_distortion": ["extra fingers", "distorted hand", "mangled hand", "deformed hand"],
    "limb_distortion": ["extra arm", "extra leg", "distorted limb", "deformed limb"],
    "background_face_distortion": ["background faces", "blurred faces", "repeated faces"],
    "clothing_artifact": ["broken clothing", "melted clothes", "distorted jacket"],
    "object_artifact": ["broken object", "warped object", "artifact"],
    "text_render_failure": ["illegible text", "gibberish text", "unreadable sign"],
    "crowd_composition_failure": ["cloned crowd", "repeated people", "crowd artifact"],
    "action_pose_failure": ["impossible pose", "awkward pose", "broken pose"],
    "environment_incoherence": ["incoherent background", "broken environment", "impossible scene"],
    "identity_drift": ["different face", "identity drift", "does not match previous"],
}

FAILURE_TAGS = [
    "prompt_under_specified",
    "prompt_over_complex",
    "prompt_conflicting_intent",
    "prompt_missing_negative_guidance",
    "prompt_text_not_explicit",
    "prompt_action_not_explicit",
    "routing_wrong_provider",
    "routing_missed_trait",
    "routing_failed_over_too_early",
    "routing_stayed_too_long",
    "provider_limit_text_render",
    "provider_limit_multi_person",
    "provider_limit_action_pose",
    "provider_limit_anatomy",
    "provider_limit_background_faces",
    "provider_rate_limit_side_effect",
    "face_distortion",
    "mouth_distortion",
    "eye_distortion",
    "hand_distortion",
    "limb_distortion",
    "background_face_distortion",
    "clothing_artifact",
    "object_artifact",
    "text_render_failure",
    "crowd_composition_failure",
    "action_pose_failure",
    "environment_incoherence",
    "identity_drift",
    "quality_gate_missed_bad_output",
    "fallback_overuse",
    "degraded_hidden_cost",
    "exposure_bad_anchor_choice",
    "continuity_break",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit a generated image/video against the expected scene intent using SmolVLM2.",
    )
    parser.add_argument("input", help="Path to an image or video file.")
    parser.add_argument(
        "--expected-prompt",
        required=True,
        help="Expected prompt or scene description to compare against the media.",
    )
    parser.add_argument(
        "--scene-class",
        default="unknown",
        help="Optional scene class/archetype for reporting (e.g. NARRATIVE, INTROSPECTIVE, crowd, animal).",
    )
    parser.add_argument(
        "--provider",
        default="unknown",
        help="Optional provider/model label for downstream tracking.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MODEL_ID,
        help=f"Hugging Face model id. Default: {DEFAULT_MODEL_ID}",
    )
    parser.add_argument(
        "--media-type",
        choices=["auto", "image", "video"],
        default="auto",
        help="Force image or video mode. Default: auto by extension.",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="Preferred execution device. Default: auto.",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=320,
        help="Generation budget for the QA response.",
    )
    parser.add_argument(
        "--out",
        help="Optional explicit output JSON path. Default: output/audit/smolvlm/<input>_<timestamp>.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip model loading/inference and only emit the constructed audit prompt + metadata.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def detect_media_type(path: Path, explicit: str) -> str:
    if explicit in {"image", "video"}:
        return explicit
    image_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    video_exts = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
    ext = path.suffix.lower()
    if ext in image_exts:
        return "image"
    if ext in video_exts:
        return "video"
    raise ValueError(f"Unsupported file extension for auto media type detection: {path.suffix}")


def resolve_input_path(raw_input: str) -> Path:
    candidate = Path(raw_input)
    if candidate.exists():
        return candidate

    repo_candidate = ROOT / candidate
    if repo_candidate.exists():
        return repo_candidate

    parent = candidate.parent if candidate.parent != Path("") else Path(".")
    stem = candidate.stem
    suffix = candidate.suffix.lower()
    search_root = ROOT / parent if not parent.is_absolute() else parent
    if search_root.exists():
        matches = sorted(
            search_root.glob(f"*{stem}{suffix}"),
            key=lambda path: len(path.name),
        )
        if len(matches) == 1:
            return matches[0]
        if matches:
            preferred = [path for path in matches if path.name == f"{stem}{suffix}"]
            return preferred[0] if preferred else matches[0]

    return repo_candidate


def build_audit_instruction(expected_prompt: str, scene_class: str) -> str:
    tags = ", ".join(FAILURE_TAGS)
    return f"""Audit this media against the expected scene intent.

Expected scene intent: {expected_prompt}
Scene class: {scene_class}

Reply with ONLY these 8 lines, in this exact key:value format.
Do not include markdown, explanations, or repeated instructions.

primarySubject: <short phrase>
sceneMatch: match|partial|mismatch
peopleEstimate: 0|1|2|3+|crowd
textLegibility: none|illegible|partial|clear
artifactFlags: comma-separated tags or none
recommendedFailureTags: comma-separated tags from [{tags}] or none
confidence: low|medium|high
notes: 1-2 short factual sentences

Rules:
- Judge whether the media matches the expected scene intent, not whether it merely looks good.
- Use match only if the main subject and action are both substantially correct.
- If the media has multiple moments, focus on the dominant moment most relevant to the expected scene intent.
- If text/signage matters and is not readable, include text_render_failure.
- Keep notes short and concrete.
"""


def default_output_path(input_path: Path) -> Path:
    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", input_path.stem)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return DEFAULT_OUTPUT_DIR / f"{safe_stem}_{timestamp}.json"


def ensure_dependencies(media_type: str) -> Tuple[Any, Any, Any]:
    try:
        import torch  # type: ignore
        from transformers import AutoModelForImageTextToText, AutoProcessor  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Missing optional dependencies. Install with:\n"
            "  pip install -r scripts/dev-tools/requirements-smolvlm.txt\n"
            f"Original import error: {exc}"
        ) from exc

    if media_type == "video":
        try:
            import decord  # noqa: F401  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "Video mode requires decord. Install optional dependencies with:\n"
                "  pip install -r scripts/dev-tools/requirements-smolvlm.txt\n"
                f"Original import error: {exc}"
            ) from exc

    return torch, AutoProcessor, AutoModelForImageTextToText


def resolve_device(torch_module: Any, requested: str) -> Tuple[str, Any, str]:
    if requested == "cuda":
        if not torch_module.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available.")
        return "cuda", torch_module.float16, "sdpa"
    if requested == "cpu":
        return "cpu", torch_module.float32, "eager"

    if torch_module.cuda.is_available():
        return "cuda", torch_module.float16, "sdpa"
    return "cpu", torch_module.float32, "eager"


def load_model_and_processor(
    model_id: str,
    torch_module: Any,
    AutoProcessor: Any,
    AutoModelForImageTextToText: Any,
    device: str,
    dtype: Any,
    attn_impl: str,
) -> Tuple[Any, Any]:
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForImageTextToText.from_pretrained(
        model_id,
        dtype=dtype,
        _attn_implementation=attn_impl,
    )
    model = model.to(device)
    model.eval()
    return processor, model


def run_inference(
    *,
    input_path: Path,
    media_type: str,
    expected_prompt: str,
    scene_class: str,
    model_id: str,
    requested_device: str,
    max_new_tokens: int,
) -> Dict[str, Any]:
    torch_module, AutoProcessor, AutoModelForImageTextToText = ensure_dependencies(media_type)
    device, dtype, attn_impl = resolve_device(torch_module, requested_device)
    processor, model = load_model_and_processor(
        model_id,
        torch_module,
        AutoProcessor,
        AutoModelForImageTextToText,
        device,
        dtype,
        attn_impl,
    )

    prompt_text = build_audit_instruction(expected_prompt, scene_class)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": media_type, "path": str(input_path)},
                {"type": "text", "text": prompt_text},
            ],
        }
    ]

    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = {k: v.to(model.device) if hasattr(v, "to") else v for k, v in inputs.items()}

    generated_ids = model.generate(**inputs, max_new_tokens=max_new_tokens)
    prompt_length = inputs["input_ids"].shape[1]
    completion_ids = generated_ids[:, prompt_length:]
    raw_text = processor.batch_decode(completion_ids, skip_special_tokens=True)[0].strip()

    return {
        "device": device,
        "dtype": str(dtype).replace("torch.", ""),
        "attnImplementation": attn_impl,
        "rawResponse": raw_text,
    }


def extract_first_json_object(text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not text:
        return None, "empty_response"
    start = text.find("{")
    if start == -1:
        return None, "no_json_object_found"
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(text[start:], start=start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : index + 1]
                try:
                    return json.loads(candidate), None
                except json.JSONDecodeError as exc:
                    return None, f"json_decode_error: {exc}"
    return None, "unterminated_json_object"


def extract_key_value_audit(text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not text:
        return None, "empty_response"

    parsed: Dict[str, Any] = {}
    key_map = {
        "primarysubject": "primarySubject",
        "scenematch": "sceneMatch",
        "peopleestimate": "peopleEstimate",
        "textlegibility": "textLegibility",
        "artifactflags": "artifactFlags",
        "recommendedfailuretags": "recommendedFailureTags",
        "confidence": "confidence",
        "notes": "notes",
    }

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized_key = re.sub(r"[^a-zA-Z]", "", key).lower()
        mapped_key = key_map.get(normalized_key)
        if not mapped_key:
            continue
        value = value.strip()
        if mapped_key in {"artifactFlags", "recommendedFailureTags"}:
            if value.lower() in {"none", "", "n/a"}:
                parsed[mapped_key] = []
            else:
                parsed[mapped_key] = [item.strip() for item in value.split(",") if item.strip()]
        else:
            parsed[mapped_key] = value

    required = {"primarySubject", "sceneMatch", "peopleEstimate", "textLegibility", "confidence"}
    if required.issubset(parsed.keys()):
        parsed.setdefault("artifactFlags", [])
        parsed.setdefault("recommendedFailureTags", [])
        parsed.setdefault("notes", "")
        return parsed, None
    return None, "no_key_value_audit_found"


def tokenize_keywords(text: str) -> List[str]:
    return re.findall(r"[a-zA-Z][a-zA-Z0-9_-]+", text.lower())


def infer_people_estimate(raw_text: str, expected_prompt: str) -> str:
    blob = f"{raw_text.lower()} {expected_prompt.lower()}"
    if any(token in blob for token in ["crowd", "group of people", "many people", "dozens", "audience"]):
        return "crowd"
    if any(token in blob for token in ["two ", "couple", "pair"]):
        return "2"
    if any(token in blob for token in ["three ", "trio"]):
        return "3+"
    if any(token in blob for token in ["group", "people"]):
        return "3+"
    if any(token in blob for token in ["man", "woman", "person", "wolf", "dragon", "child"]):
        return "1"
    return "0"


def infer_text_legibility(raw_text: str, expected_prompt: str) -> str:
    raw = raw_text.lower()
    expected = expected_prompt.lower()
    text_related = any(token in expected for token in ["sign", "banner", "poster", "text", "graffiti", "title"])
    if not text_related:
        return "none"
    if any(token in raw for token in ["banner reading", 'reads "', "sign reading", "text reads"]):
        return "clear"
    if any(token in raw for token in ["banner", "sign", "poster", "text"]):
        return "partial"
    return "illegible"


def infer_primary_subject(raw_text: str, expected_prompt: str) -> str:
    raw = raw_text.lower()
    expected_tokens = tokenize_keywords(expected_prompt)
    for token in expected_tokens:
        if token in raw and token not in {"the", "and", "with", "past", "into", "from", "a"}:
            return token
    for noun in ["crowd", "wolf", "dragon", "wizard", "hunter", "hands", "man", "woman", "child", "people", "group"]:
        if noun in raw:
            return noun
    return "unknown"


def infer_scene_match(raw_text: str, expected_prompt: str) -> str:
    raw_tokens = set(tokenize_keywords(raw_text))
    expected_tokens = [
        token
        for token in tokenize_keywords(expected_prompt)
        if token not in {"the", "and", "with", "past", "into", "from", "a"}
    ]
    if not expected_tokens:
        return "partial"
    overlap = sum(1 for token in expected_tokens if token in raw_tokens)
    ratio = overlap / max(len(expected_tokens), 1)
    if ratio >= 0.5:
        return "match"
    if ratio >= 0.2:
        return "partial"
    return "mismatch"


def infer_artifact_flags(raw_text: str, expected_prompt: str) -> List[str]:
    raw = raw_text.lower()
    expected = expected_prompt.lower()
    flags: List[str] = []
    for tag, hints in ARTIFACT_KEYWORDS.items():
        if any(hint in raw for hint in hints):
            flags.append(tag)
    if any(token in expected for token in ["sign", "banner", "poster", "text"]) and "text" not in raw:
        if "text_render_failure" not in flags and infer_text_legibility(raw_text, expected_prompt) == "illegible":
            flags.append("text_render_failure")
    return flags


def infer_failure_tags(raw_text: str, expected_prompt: str, artifact_flags: List[str], scene_match: str) -> List[str]:
    expected = expected_prompt.lower()
    tags: List[str] = []
    if scene_match != "match":
        tags.append("quality_gate_missed_bad_output")
        tags.append("prompt_conflicting_intent")
    if any(token in expected for token in ["sign", "banner", "poster", "text"]) and infer_text_legibility(raw_text, expected_prompt) != "clear":
        tags.append("prompt_text_not_explicit")
    if any(token in expected for token in ["running", "jumping", "fighting", "surging", "howling", "lightning"]) and scene_match == "mismatch":
        tags.append("prompt_action_not_explicit")
    tags.extend(artifact_flags)
    deduped: List[str] = []
    for tag in tags:
        if tag in FAILURE_TAGS and tag not in deduped:
            deduped.append(tag)
    return deduped[:6]


def build_fallback_audit(raw_text: str, expected_prompt: str, scene_class: str, media_type: str) -> Dict[str, Any]:
    scene_match = infer_scene_match(raw_text, expected_prompt)
    artifact_flags = infer_artifact_flags(raw_text, expected_prompt)
    notes = raw_text.strip().replace("\n", " ")
    if len(notes) > 260:
        notes = notes[:257].rstrip() + "..."
    notes = (
        f"Fallback parse from prose response for {media_type}. {notes}"
        if notes
        else f"Fallback parse from prose response for {media_type}."
    )
    return {
        "primarySubject": infer_primary_subject(raw_text, expected_prompt),
        "sceneMatch": scene_match,
        "peopleEstimate": infer_people_estimate(raw_text, expected_prompt),
        "textLegibility": infer_text_legibility(raw_text, expected_prompt),
        "artifactFlags": artifact_flags,
        "recommendedFailureTags": infer_failure_tags(raw_text, expected_prompt, artifact_flags, scene_match),
        "confidence": "low",
        "notes": notes,
    }


def normalize_list_strings(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    result: List[str] = []
    for value in values:
        text = str(value).strip()
        if text:
            result.append(text)
    return result


def normalize_audit_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    allowed_scene_match = {"match", "partial", "mismatch"}
    allowed_people_estimate = {"0", "1", "2", "3+", "crowd"}
    allowed_text_legibility = {"none", "illegible", "partial", "clear"}
    allowed_confidence = {"low", "medium", "high"}

    normalized = dict(payload)
    scene_match = str(payload.get("sceneMatch") or "").strip().lower()
    people_estimate = str(payload.get("peopleEstimate") or "").strip().lower()
    text_legibility = str(payload.get("textLegibility") or "").strip().lower()
    confidence = str(payload.get("confidence") or "").strip().lower()

    normalized["primarySubject"] = str(payload.get("primarySubject") or "").strip()
    normalized["sceneMatch"] = scene_match if scene_match in allowed_scene_match else "partial"
    normalized["peopleEstimate"] = (
        people_estimate if people_estimate in allowed_people_estimate else "3+"
    )
    normalized["textLegibility"] = (
        text_legibility if text_legibility in allowed_text_legibility else "none"
    )
    normalized["artifactFlags"] = normalize_list_strings(payload.get("artifactFlags"))
    normalized["recommendedFailureTags"] = normalize_list_strings(payload.get("recommendedFailureTags"))
    normalized["confidence"] = confidence if confidence in allowed_confidence else "medium"
    normalized["notes"] = str(payload.get("notes") or "").strip()
    return normalized


def main() -> int:
    args = parse_args()
    input_path = resolve_input_path(args.input)
    if not input_path.exists():
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": f"Input file not found: {input_path}",
                }
            )
        )
        return 1

    media_type = detect_media_type(input_path, args.media_type)
    out_path = Path(args.out) if args.out else default_output_path(input_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    prompt_text = build_audit_instruction(args.expected_prompt, args.scene_class)
    base_result: Dict[str, Any] = {
        "status": "success",
        "tool": "smolvlm_scene_audit",
        "generatedAt": utc_now_iso(),
        "input": {
            "path": str(input_path),
            "mediaType": media_type,
            "expectedPrompt": args.expected_prompt,
            "sceneClass": args.scene_class,
            "provider": args.provider,
        },
        "model": {
            "id": args.model_id,
            "requestedDevice": args.device,
        },
        "auditPrompt": prompt_text,
    }

    if args.dry_run:
        base_result["status"] = "dry_run"
        out_path.write_text(json.dumps(base_result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(base_result, ensure_ascii=False))
        return 0

    try:
        inference = run_inference(
            input_path=input_path,
            media_type=media_type,
            expected_prompt=args.expected_prompt,
            scene_class=args.scene_class,
            model_id=args.model_id,
            requested_device=args.device,
            max_new_tokens=args.max_new_tokens,
        )
        parsed_payload, parse_error = extract_first_json_object(inference["rawResponse"])
        if parsed_payload is None:
            parsed_payload, kv_error = extract_key_value_audit(inference["rawResponse"])
            if parsed_payload is not None:
                parse_error = None
            elif parse_error:
                parse_error = f"{parse_error}; {kv_error}"
            else:
                parse_error = kv_error

        base_result["runtime"] = {
            "device": inference["device"],
            "dtype": inference["dtype"],
            "attnImplementation": inference["attnImplementation"],
            "maxNewTokens": args.max_new_tokens,
        }
        base_result["rawResponse"] = inference["rawResponse"]
        base_result["parseError"] = parse_error
        if parsed_payload is not None:
            base_result["audit"] = normalize_audit_payload(parsed_payload)
        else:
            base_result["status"] = "degraded"
            base_result["audit"] = normalize_audit_payload(
                build_fallback_audit(
                    inference["rawResponse"],
                    args.expected_prompt,
                    args.scene_class,
                    media_type,
                )
            )
            base_result["error"] = "Model response did not contain valid JSON; used prose fallback parser."

        out_path.write_text(json.dumps(base_result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(base_result, ensure_ascii=False))
        return 0 if base_result["status"] in {"success", "degraded"} else 2
    except Exception as exc:
        base_result["status"] = "failed"
        base_result["error"] = str(exc)
        out_path.write_text(json.dumps(base_result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(base_result, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
