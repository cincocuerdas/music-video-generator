#!/usr/bin/env python3
"""
Optional binary scene QA helper using HuggingFaceTB/SmolVLM2-500M-Video-Instruct.

Use this when you need a small number of yes/no/unclear checks on a single image
or short clip, which tends to be more reliable than full structured auditing on
small VLMs.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_ID = "HuggingFaceTB/SmolVLM2-500M-Video-Instruct"
DEFAULT_OUTPUT_DIR = ROOT / "output" / "audit" / "smolvlm"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ask binary yes/no/unclear questions about a scene image or short clip using SmolVLM2.",
    )
    parser.add_argument("input", help="Path to an image or video file.")
    parser.add_argument(
        "--question",
        action="append",
        required=True,
        help="Binary question to ask. Repeat this flag for multiple questions.",
    )
    parser.add_argument(
        "--media-type",
        choices=["auto", "image", "video"],
        default="auto",
        help="Force image or video mode. Default: auto by extension.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MODEL_ID,
        help=f"Hugging Face model id. Default: {DEFAULT_MODEL_ID}",
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
        default=220,
        help="Generation budget for the QA response.",
    )
    parser.add_argument(
        "--out",
        help="Optional explicit output JSON path. Default: output/audit/smolvlm/<input>_binary_<timestamp>.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip model loading/inference and only emit prompt + metadata.",
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
        matches = sorted(search_root.glob(f"*{stem}{suffix}"), key=lambda path: len(path.name))
        if len(matches) == 1:
            return matches[0]
        if matches:
            preferred = [path for path in matches if path.name == f"{stem}{suffix}"]
            return preferred[0] if preferred else matches[0]
    return repo_candidate


def default_output_path(input_path: Path) -> Path:
    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", input_path.stem)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return DEFAULT_OUTPUT_DIR / f"{safe_stem}_binary_{timestamp}.json"


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


def build_prompt(questions: List[str]) -> str:
    lines = [
        "Answer the binary scene QA questions below.",
        "Reply ONLY with answer lines, not question lines.",
        "Use this exact format:",
        "A1: yes|no|unclear | low|medium|high | short evidence",
        "A2: yes|no|unclear | low|medium|high | short evidence",
        "Example:",
        "A1: yes | high | a wolf is clearly visible",
        "A2: no | high | no human is visible",
        "Keep evidence very short and concrete.",
        "",
    ]
    for index, question in enumerate(questions, start=1):
        lines.append(f"Q{index}: {question}")
    return "\n".join(lines)


def run_inference(
    *,
    input_path: Path,
    media_type: str,
    model_id: str,
    requested_device: str,
    questions: List[str],
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

    prompt_text = build_prompt(questions)
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
        "promptText": prompt_text,
    }


def parse_binary_lines(raw_text: str, questions: List[str]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    answers: List[Dict[str, Any]] = []
    found = 0
    for line in raw_text.splitlines():
        match = re.match(r"^\s*A(\d+)\s*:\s*(yes|no|unclear)\s*\|\s*(low|medium|high)\s*\|\s*(.+?)\s*$", line, re.IGNORECASE)
        compact_match = re.match(r"^\s*A(\d+)\s*:\s*(yes|no|unclear)\s*$", line, re.IGNORECASE)
        if not match:
            if not compact_match:
                continue
            idx = int(compact_match.group(1))
            if idx < 1 or idx > len(questions):
                continue
            answers.append(
                {
                    "index": idx,
                    "question": questions[idx - 1],
                    "answer": compact_match.group(2).lower(),
                    "confidence": "low",
                    "evidence": "No evidence text returned by model.",
                }
            )
            found += 1
            continue
        idx = int(match.group(1))
        if idx < 1 or idx > len(questions):
            continue
        answers.append(
            {
                "index": idx,
                "question": questions[idx - 1],
                "answer": match.group(2).lower(),
                "confidence": match.group(3).lower(),
                "evidence": match.group(4).strip(),
            }
        )
        found += 1

    if found == len(questions):
        answers.sort(key=lambda item: item["index"])
        return answers, None
    return answers, "incomplete_binary_response"


def build_prose_fallback(raw_text: str, questions: List[str]) -> List[Dict[str, Any]]:
    text = raw_text.lower()
    results: List[Dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        answer = "unclear"
        q = question.lower()
        if any(token in q for token in ["wolf", "dragon", "wizard", "human", "crowd", "text", "sign", "banner"]):
            if any(token in text for token in ["wolf", "dragon", "wizard", "crowd", "banner", "sign", "text"]):
                answer = "yes"
        evidence = raw_text.strip().replace("\n", " ")
        if len(evidence) > 120:
            evidence = evidence[:117].rstrip() + "..."
        results.append(
            {
                "index": index,
                "question": question,
                "answer": answer,
                "confidence": "low",
                "evidence": evidence or "No structured answer returned.",
            }
        )
    return results


def main() -> int:
    args = parse_args()
    input_path = resolve_input_path(args.input)
    if not input_path.exists():
        print(json.dumps({"status": "failed", "error": f"Input file not found: {input_path}"}))
        return 1

    media_type = detect_media_type(input_path, args.media_type)
    out_path = Path(args.out) if args.out else default_output_path(input_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    base_result: Dict[str, Any] = {
        "status": "success",
        "tool": "smolvlm_binary_scene_audit",
        "generatedAt": utc_now_iso(),
        "input": {
            "path": str(input_path),
            "mediaType": media_type,
        },
        "model": {
            "id": args.model_id,
            "requestedDevice": args.device,
        },
        "questions": args.question,
    }

    if args.dry_run:
        base_result["status"] = "dry_run"
        base_result["prompt"] = build_prompt(args.question)
        out_path.write_text(json.dumps(base_result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(base_result, ensure_ascii=False))
        return 0

    try:
        inference = run_inference(
            input_path=input_path,
            media_type=media_type,
            model_id=args.model_id,
            requested_device=args.device,
            questions=args.question,
            max_new_tokens=args.max_new_tokens,
        )
        base_result["runtime"] = {
            "device": inference["device"],
            "dtype": inference["dtype"],
            "attnImplementation": inference["attnImplementation"],
            "maxNewTokens": args.max_new_tokens,
        }
        base_result["prompt"] = inference["promptText"]
        base_result["rawResponse"] = inference["rawResponse"]

        answers, parse_error = parse_binary_lines(inference["rawResponse"], args.question)
        if parse_error is None:
            base_result["answers"] = answers
        else:
            base_result["status"] = "degraded"
            base_result["parseError"] = parse_error
            base_result["answers"] = build_prose_fallback(inference["rawResponse"], args.question)
            base_result["error"] = "Model response did not follow binary line format; used prose fallback parser."

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
