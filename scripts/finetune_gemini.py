#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fine-tune Gemini for lyric analysis using liked feedback.

Flow:
1. Export training pairs from DB (lyrics -> liked prompt).
2. Write JSONL dataset.
3. Call Gemini Tuning API (generativelanguage.googleapis.com).
4. Save tuned model id/config to storage file.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv
from result_json import make_emit_result
from stage_deadline import bounded_timeout_seconds, make_stage_deadline_checker
from db_utils import get_db_connection
from env_utils import parse_float_env, parse_positive_int_env


current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)

DATASET_OUTPUT_DIR = os.path.join(root_dir, "output", "datasets")
TUNED_CONFIG_PATH = os.getenv(
    "GEMINI_TUNED_MODEL_CONFIG_PATH",
    os.path.join(root_dir, "storage", "gemini-tuned-model.json"),
)
GEMINI_TUNING_HTTP_TIMEOUT_SEC = parse_positive_int_env("GEMINI_TUNING_HTTP_TIMEOUT_SEC", 60)
GEMINI_TUNING_POLL_INTERVAL_SEC = parse_positive_int_env("GEMINI_TUNING_POLL_INTERVAL_SEC", 10)
GEMINI_TUNING_POLL_TIMEOUT_SEC = parse_positive_int_env("GEMINI_TUNING_POLL_TIMEOUT_SEC", 3600)
FINETUNE_GEMINI_STAGE_TIMEOUT_SEC = parse_positive_int_env("FINETUNE_GEMINI_STAGE_TIMEOUT_SEC", 7200)
GEMINI_TUNING_REQUEST_DELAY_SEC = max(0.0, parse_float_env("GEMINI_TUNING_REQUEST_DELAY_SEC", 0.0))


emit_result = make_emit_result("finetune_gemini")
ensure_stage_deadline = make_stage_deadline_checker("finetune")

def normalize_text(text: str, max_len: int) -> str:
    value = re.sub(r"\s+", " ", (text or "").strip())
    if len(value) > max_len:
        return value[:max_len].rstrip()
    return value


def export_liked_training_pairs(max_examples: int, max_input_len: int, max_output_len: int) -> List[Dict[str, str]]:
    """
    Export pairs:
    - input: Project.lyrics
    - output: GenerationFeedback.prompt
    Only score > 0
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''
            SELECT
              gf."id",
              gf."projectId",
              gf."prompt",
              p."lyrics"
            FROM "GenerationFeedback" gf
            INNER JOIN "Project" p ON p."id" = gf."projectId"
            WHERE gf."score" > 0
              AND COALESCE(TRIM(gf."prompt"), '') <> ''
              AND COALESCE(TRIM(p."lyrics"), '') <> ''
            ORDER BY gf."createdAt" DESC
            '''
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    examples: List[Dict[str, str]] = []
    dedupe = set()

    for row in rows:
        prompt = normalize_text(str(row[2] or ""), max_output_len)
        lyrics = normalize_text(str(row[3] or ""), max_input_len)
        if not prompt or not lyrics:
            continue

        key = (lyrics, prompt)
        if key in dedupe:
            continue
        dedupe.add(key)

        examples.append({
            "input": lyrics,
            "output": prompt,
        })
        if len(examples) >= max_examples:
            break

    return examples


def write_jsonl_dataset(examples: List[Dict[str, str]]) -> str:
    os.makedirs(DATASET_OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_path = os.path.join(DATASET_OUTPUT_DIR, f"gemini_tuning_{timestamp}.jsonl")

    with open(file_path, "w", encoding="utf-8") as f:
        for example in examples:
            # JSONL pair format requested for tuning export.
            f.write(
                json.dumps(
                    {"input": example["input"], "output": example["output"]},
                    ensure_ascii=False,
                ) + "\n"
            )

    return file_path


def api_request(
    method: str,
    url: str,
    api_key: str,
    payload: Dict = None,
    timeout: Optional[int] = None,
    deadline_ts: Optional[float] = None,
) -> Dict:
    ensure_stage_deadline(deadline_ts, f"api_request:{method}")
    headers = {"Content-Type": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        effective_timeout = bounded_timeout_seconds(
            deadline_ts,
            timeout or GEMINI_TUNING_HTTP_TIMEOUT_SEC,
            phase=f"api_request:{method}",
            scope="finetune",
        )
        with urllib.request.urlopen(req, timeout=effective_timeout) as response:
            raw = response.read().decode("utf-8")
            if GEMINI_TUNING_REQUEST_DELAY_SEC > 0:
                time.sleep(GEMINI_TUNING_REQUEST_DELAY_SEC)
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"HTTP {e.code} - {body}")


def discover_tuning_base_model(api_key: str, deadline_ts: Optional[float] = None) -> Tuple[str, List[str]]:
    """
    Try to discover a model that supports createTunedModel.
    Fallback to env/default if none found.
    """
    fallback_model = os.getenv("GEMINI_TUNING_BASE_MODEL", "models/gemini-1.5-flash-001-tuning")
    discovered_candidates: List[str] = []

    list_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        data = api_request("GET", list_url, api_key, payload=None, timeout=30, deadline_ts=deadline_ts)
        for model in data.get("models", []):
            name = model.get("name")
            methods = model.get("supportedGenerationMethods", []) or []
            if not name:
                continue
            if "createTunedModel" in methods:
                discovered_candidates.append(name)
            elif name.endswith("-tuning"):
                discovered_candidates.append(name)
    except Exception as e:
        print(f"Warning: Could not list Gemini models for tuning discovery: {e}", file=sys.stderr)

    preferred = None
    for candidate in discovered_candidates:
        if "flash" in candidate:
            preferred = candidate
            break
    if not preferred and discovered_candidates:
        preferred = discovered_candidates[0]

    return (preferred or fallback_model, discovered_candidates)


def make_tuned_model_id(prefix: str = "lyrics-prompts") -> str:
    timestamp = datetime.now().strftime("%y%m%d%H%M%S")
    raw = f"{prefix}-{timestamp}".lower()
    raw = re.sub(r"[^a-z0-9-]", "-", raw)
    raw = re.sub(r"-+", "-", raw).strip("-")
    if not raw or not raw[0].isalpha():
        raw = f"m-{raw}"
    return raw[:40]


def create_tuned_model(
    api_key: str,
    base_model: str,
    examples: List[Dict[str, str]],
    tuned_model_id: str,
    epoch_count: int,
    batch_size: int,
    learning_rate: float,
    deadline_ts: Optional[float] = None,
) -> Dict:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/tunedModels"
        f"?key={urllib.parse.quote(api_key)}"
        f"&tunedModelId={urllib.parse.quote(tuned_model_id)}"
    )

    api_examples = [
        {
            "textInput": ex["input"],
            "output": ex["output"],
        }
        for ex in examples
    ]

    payload = {
        "displayName": f"Lyrics Prompt Tuning {datetime.now().strftime('%Y-%m-%d')}",
        "description": "Auto-tuned model from liked image-generation feedback",
        "baseModel": base_model,
        "tuningTask": {
            "trainingData": {
                "examples": {
                    "examples": api_examples
                }
            },
            "hyperparameters": {
                "epochCount": epoch_count,
                "batchSize": batch_size,
                "learningRate": learning_rate,
            },
        },
    }

    return api_request("POST", url, api_key, payload=payload, timeout=120, deadline_ts=deadline_ts)


def extract_tuned_model_name(operation_obj: Dict) -> str:
    response = operation_obj.get("response", {}) or {}
    if isinstance(response, dict):
        if isinstance(response.get("name"), str) and response["name"].startswith("tunedModels/"):
            return response["name"]
        if isinstance(response.get("tunedModel"), str) and response["tunedModel"].startswith("tunedModels/"):
            return response["tunedModel"]

    metadata = operation_obj.get("metadata", {}) or {}
    if isinstance(metadata, dict):
        if isinstance(metadata.get("name"), str) and metadata["name"].startswith("tunedModels/"):
            return metadata["name"]
        if isinstance(metadata.get("tunedModel"), str) and metadata["tunedModel"].startswith("tunedModels/"):
            return metadata["tunedModel"]

    return ""


def wait_for_tuning_operation(
    api_key: str,
    operation_name: str,
    poll_interval: Optional[int] = None,
    timeout_sec: Optional[int] = None,
    deadline_ts: Optional[float] = None,
) -> Dict:
    resolved_poll_interval = poll_interval if poll_interval is not None else GEMINI_TUNING_POLL_INTERVAL_SEC
    resolved_timeout_sec = timeout_sec if timeout_sec is not None else GEMINI_TUNING_POLL_TIMEOUT_SEC
    start = time.time()
    encoded_name = urllib.parse.quote(operation_name, safe="/")
    url = f"https://generativelanguage.googleapis.com/v1beta/{encoded_name}?key={urllib.parse.quote(api_key)}"

    while True:
        ensure_stage_deadline(deadline_ts, "wait_operation")
        if time.time() - start > resolved_timeout_sec:
            raise TimeoutError(f"Tuning operation timed out after {resolved_timeout_sec}s")

        operation_obj = api_request("GET", url, api_key, payload=None, timeout=60, deadline_ts=deadline_ts)
        if operation_obj.get("done"):
            if "error" in operation_obj:
                raise Exception(f"Tuning operation failed: {json.dumps(operation_obj['error'])}")
            return operation_obj

        time.sleep(resolved_poll_interval)


def save_tuned_model_config(config_path: str, payload: Dict):
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Fine-tune Gemini with liked feedback.")
    parser.add_argument("--max-examples", type=int, default=int(os.getenv("GEMINI_TUNING_MAX_EXAMPLES", "200")))
    parser.add_argument("--min-examples", type=int, default=int(os.getenv("GEMINI_TUNING_MIN_EXAMPLES", "20")))
    parser.add_argument("--epoch-count", type=int, default=int(os.getenv("GEMINI_TUNING_EPOCH_COUNT", "5")))
    parser.add_argument("--batch-size", type=int, default=int(os.getenv("GEMINI_TUNING_BATCH_SIZE", "8")))
    parser.add_argument("--learning-rate", type=float, default=float(os.getenv("GEMINI_TUNING_LEARNING_RATE", "0.001")))
    parser.add_argument("--max-input-len", type=int, default=int(os.getenv("GEMINI_TUNING_MAX_INPUT_LEN", "8000")))
    parser.add_argument("--max-output-len", type=int, default=int(os.getenv("GEMINI_TUNING_MAX_OUTPUT_LEN", "4000")))
    parser.add_argument("--tuned-model-id", type=str, default="")
    parser.add_argument("--skip-wait", action="store_true", help="Do not wait for operation completion.")
    args = parser.parse_args()

    try:
        deadline_ts = time.time() + FINETUNE_GEMINI_STAGE_TIMEOUT_SEC
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise Exception("GEMINI_API_KEY not found in .env")

        ensure_stage_deadline(deadline_ts, "export_examples")
        examples = export_liked_training_pairs(
            max_examples=args.max_examples,
            max_input_len=args.max_input_len,
            max_output_len=args.max_output_len,
        )

        if len(examples) < args.min_examples:
            result = {
                "status": "degraded",
                "success": True,
                "degraded": True,
                "reasonCode": "insufficient_data",
                "examplesCount": len(examples),
                "minExamplesRequired": args.min_examples,
                "message": "Not enough liked feedback examples for tuning.",
            }
            emit_result(result)
            return

        ensure_stage_deadline(deadline_ts, "write_jsonl")
        jsonl_path = write_jsonl_dataset(examples)
        base_model, discovered_candidates = discover_tuning_base_model(api_key, deadline_ts=deadline_ts)
        tuned_model_id = args.tuned_model_id or make_tuned_model_id()

        ensure_stage_deadline(deadline_ts, "create_tuned_model")
        create_op = create_tuned_model(
            api_key=api_key,
            base_model=base_model,
            examples=examples,
            tuned_model_id=tuned_model_id,
            epoch_count=args.epoch_count,
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            deadline_ts=deadline_ts,
        )

        operation_name = create_op.get("name", "")
        if not operation_name:
            raise Exception(f"Create tuned model did not return operation name: {create_op}")

        tuned_model_name = extract_tuned_model_name(create_op)
        final_operation = create_op

        if not args.skip_wait:
            ensure_stage_deadline(deadline_ts, "wait_for_operation")
            final_operation = wait_for_tuning_operation(
                api_key,
                operation_name,
                deadline_ts=deadline_ts,
            )
            final_name = extract_tuned_model_name(final_operation)
            if final_name:
                tuned_model_name = final_name

        config_payload = {
            "tunedModel": tuned_model_name or f"tunedModels/{tuned_model_id}",
            "baseModel": base_model,
            "operationName": operation_name,
            "createdAt": datetime.utcnow().isoformat() + "Z",
            "status": "active" if final_operation.get("done") and "error" not in final_operation else "creating",
            "datasetPath": jsonl_path,
            "examplesCount": len(examples),
            "discoveredTunableModels": discovered_candidates,
        }
        save_tuned_model_config(TUNED_CONFIG_PATH, config_payload)

        result = {
            "status": "success",
            "success": True,
            "degraded": False,
            "datasetPath": jsonl_path,
            "examplesCount": len(examples),
            "baseModel": base_model,
            "operationName": operation_name,
            "tunedModel": config_payload["tunedModel"],
            "configPath": TUNED_CONFIG_PATH,
        }
        emit_result(result)

    except TimeoutError as e:
        emit_result({
            "status": "degraded",
            "success": True,
            "degraded": True,
            "reasonCode": "finetune.timeout",
            "error": str(e),
            "type": type(e).__name__,
        })
    except Exception as e:
        emit_result({
            "status": "failed",
            "success": False,
            "error": str(e),
            "type": type(e).__name__,
        })
        sys.exit(1)


if __name__ == "__main__":
    main()
