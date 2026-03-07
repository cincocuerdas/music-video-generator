#!/usr/bin/env python3
"""
Train a style-specific SDXL LoRA from positive user feedback.

Usage:
  python train_style_lora.py <style_name>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import queue
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from idempotency_utils import load_receipt, save_receipt
from result_json import make_emit_result
from stage_deadline import make_stage_deadline_checker
from db_utils import get_db_connection
from env_utils import parse_positive_int_env


current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, '.env')
load_dotenv(dotenv_path)


emit_result = make_emit_result("train_lora")
ensure_stage_deadline = make_stage_deadline_checker("train_lora")


def existing_train_result(job_id: Optional[str]) -> Optional[Dict[str, Any]]:
    receipt = load_receipt("train_lora", job_id)
    if not receipt:
        return None
    lora_path = receipt.get("loraPath")
    if not isinstance(lora_path, str) or not lora_path or not os.path.exists(lora_path):
        return None
    reused = dict(receipt)
    reused["idempotentReuse"] = True
    return reused

def normalize_style(style: str) -> str:
    style = (style or "").strip().lower()
    style = re.sub(r"[^a-z0-9_\- ]+", "", style)
    style = re.sub(r"\s+", "_", style)
    return style or "unknown"


def to_local_path(url_or_path: Optional[str]) -> Optional[str]:
    if not url_or_path:
        return None
    if os.path.isabs(url_or_path):
        return url_or_path
    if url_or_path.startswith('/'):
        return os.path.join(root_dir, url_or_path.lstrip('/').replace('/', os.sep))
    return os.path.join(root_dir, url_or_path.replace('/', os.sep))


def fetch_positive_feedback(style: str) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            '''
            SELECT
              gf."id",
              gf."projectId",
              gf."prompt",
              gf."frameTime",
              gf."createdAt",
              p."analysisResult"
            FROM "GenerationFeedback" gf
            INNER JOIN "Project" p ON p."id" = gf."projectId"
            WHERE gf."score" > 0
              AND LOWER(COALESCE(gf."style", '')) = LOWER(%s)
            ORDER BY gf."createdAt" ASC
            ''',
            (style,),
        )

        rows = []
        for row in cur.fetchall():
            analysis = row[5] if row[5] else {}
            if isinstance(analysis, str):
                try:
                    analysis = json.loads(analysis)
                except Exception:
                    analysis = {}
            rows.append(
                {
                    "feedbackId": str(row[0]),
                    "projectId": str(row[1]),
                    "prompt": row[2] or "",
                    "frameTime": float(row[3]) if row[3] is not None else None,
                    "createdAt": row[4].isoformat() if row[4] else None,
                    "analysis": analysis if isinstance(analysis, dict) else {},
                }
            )
        return rows
    finally:
        conn.close()


def find_scene_index_from_time(frame_time: Optional[float], scenes: List[Dict[str, Any]]) -> Optional[int]:
    if frame_time is None or not scenes:
        return None

    for idx, scene in enumerate(scenes):
        start = float(scene.get("startTime", 0) or 0)
        duration = float(scene.get("duration", 0) or 0)
        end = float(scene.get("endTime", start + duration if duration > 0 else start + 4.0) or start + 4.0)
        if start <= frame_time <= (end + 0.2):
            return idx
    return None


def find_scene_index_by_prompt(prompt: str, generated_images: List[Dict[str, Any]]) -> Optional[int]:
    if not prompt or not generated_images:
        return None

    needle = prompt.lower().strip()
    if len(needle) > 160:
        needle = needle[:160]

    for item in generated_images:
        candidate = str(item.get("prompt", "")).lower().strip()
        if candidate and (needle in candidate or candidate in needle):
            scene_index = item.get("sceneIndex")
            if isinstance(scene_index, int):
                return scene_index
    return None


def resolve_scene_image(project_id: str, scene_index: int, generated_images: List[Dict[str, Any]]) -> Optional[str]:
    for ext in ("png", "jpg", "jpeg", "webp"):
        candidate = os.path.join(
            root_dir,
            "output",
            "images",
            "cache",
            f"project_{project_id}_scene_{scene_index}.{ext}",
        )
        if os.path.exists(candidate):
            return candidate

    for item in generated_images:
        if item.get("sceneIndex") != scene_index:
            continue
        local = to_local_path(item.get("imageUrl"))
        if local and os.path.exists(local):
            return local

    return None


def build_training_samples(feedback_rows: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    samples: List[Dict[str, str]] = []
    used_images = set()

    for row in feedback_rows:
        analysis = row.get("analysis", {}) or {}
        scenes = analysis.get("scenes", []) or []
        generated_images = analysis.get("generatedImages", []) or []
        project_id = row["projectId"]

        scene_index = find_scene_index_from_time(row.get("frameTime"), scenes)
        if scene_index is None:
            scene_index = find_scene_index_by_prompt(row.get("prompt", ""), generated_images)

        image_path = None
        if scene_index is not None:
            image_path = resolve_scene_image(project_id, scene_index, generated_images)

        if not image_path:
            for item in generated_images:
                local = to_local_path(item.get("imageUrl"))
                if local and os.path.exists(local):
                    image_path = local
                    break

        if not image_path or not os.path.exists(image_path):
            continue

        if image_path in used_images:
            continue

        prompt = (row.get("prompt") or "").strip()
        if not prompt:
            continue

        used_images.add(image_path)
        samples.append({"imagePath": image_path, "prompt": prompt})

    return samples


def choose_epochs(image_count: int) -> int:
    if image_count < 80:
        return 20
    if image_count < 180:
        return 15
    return 10


def prepare_dataset(samples: List[Dict[str, str]], style_name: str) -> Dict[str, str]:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dataset_root = os.path.join(root_dir, "output", "lora_datasets", f"{style_name}_{timestamp}")
    concept_dir = os.path.join(dataset_root, f"10_{style_name}")
    os.makedirs(concept_dir, exist_ok=True)

    trigger_token = f"style_{style_name}"
    for idx, sample in enumerate(samples, start=1):
        ext = os.path.splitext(sample["imagePath"])[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp"):
            ext = ".png"
        base_name = f"{idx:05d}"
        image_dst = os.path.join(concept_dir, f"{base_name}{ext}")
        caption_dst = os.path.join(concept_dir, f"{base_name}.txt")

        shutil.copy2(sample["imagePath"], image_dst)
        caption = f"{trigger_token}, {sample['prompt']}"
        with open(caption_dst, "w", encoding="utf-8") as f:
            f.write(caption)

    return {"datasetRoot": dataset_root, "conceptDir": concept_dir}


def resolve_trained_lora(output_dir: str, output_name: str) -> Optional[str]:
    exact = os.path.join(output_dir, f"{output_name}.safetensors")
    if os.path.exists(exact):
        return exact

    candidates = []
    for filename in os.listdir(output_dir):
        if filename.startswith(output_name) and filename.endswith(".safetensors"):
            full_path = os.path.join(output_dir, filename)
            candidates.append((os.path.getmtime(full_path), full_path))

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def run_kohya_training(
    style_name: str,
    dataset_root: str,
    epochs: int,
    deadline_ts: Optional[float] = None,
) -> Dict[str, Any]:
    lora_output_dir = os.path.join(root_dir, "ComfyUI", "models", "loras")
    os.makedirs(lora_output_dir, exist_ok=True)

    kohya_dir = os.getenv("KOHYA_SCRIPTS_DIR", os.path.join(root_dir, "kohya_ss", "sd-scripts"))
    train_script = os.path.join(kohya_dir, "sdxl_train_network.py")
    if not os.path.exists(train_script):
        raise Exception(
            f"Kohya sd-scripts not found at {train_script}. Set KOHYA_SCRIPTS_DIR in .env"
        )

    default_model = os.path.join(
        root_dir, "ComfyUI", "models", "checkpoints", "sd_xl_base_1.0.safetensors"
    )
    pretrained_model = (
        os.getenv("SDXL_BASE_MODEL_PATH")
        or os.getenv("SDXL_BASE_MODEL")
        or default_model
    )

    output_name = f"style_{style_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    python_exec = sys.executable or os.getenv("PYTHON_PATH", "python")
    timeout_sec = parse_positive_int_env("TRAIN_LORA_STAGE_TIMEOUT_SEC", 14_400)

    cmd = [
        python_exec,
        train_script,
        "--pretrained_model_name_or_path", pretrained_model,
        "--train_data_dir", dataset_root,
        "--resolution", "1024,1024",
        "--output_dir", lora_output_dir,
        "--output_name", output_name,
        "--network_module", "networks.lora",
        "--network_dim", "32",
        "--network_alpha", "16",
        "--learning_rate", "1e-4",
        "--max_train_epochs", str(epochs),
        "--train_batch_size", "1",
        "--mixed_precision", "fp16",
        "--save_precision", "fp16",
        "--optimizer_type", "AdamW8bit",
        "--cache_latents",
        "--caption_extension", ".txt",
        "--max_data_loader_n_workers", "0",
        "--save_every_n_epochs", str(max(1, min(5, epochs))),
        "--xformers",
    ]

    print(f"[train_style_lora] Running: {' '.join(cmd)}", file=sys.stderr)

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=kohya_dir,
    )
    started_at = time.time()

    line_queue: queue.Queue[str] = queue.Queue()

    def _reader_thread() -> None:
        if not process.stdout:
            return
        try:
            for line in process.stdout:
                line_queue.put(line)
        finally:
            try:
                process.stdout.close()
            except Exception:
                pass

    reader = threading.Thread(target=_reader_thread, daemon=True)
    reader.start()

    while True:
        ensure_stage_deadline(deadline_ts, "run_kohya_training")
        elapsed = time.time() - started_at
        if elapsed > timeout_sec:
            process.kill()
            try:
                process.wait(timeout=5)
            except Exception:
                pass
            raise TimeoutError(f"Kohya training timed out after {timeout_sec}s")

        drained = False
        while True:
            try:
                line = line_queue.get_nowait()
            except queue.Empty:
                break
            drained = True
            if line:
                print(line.rstrip(), file=sys.stderr)

        return_code = process.poll()
        if return_code is not None and line_queue.empty() and (drained or not reader.is_alive()):
            break

        time.sleep(0.1)

    return_code = process.wait()
    if return_code != 0:
        raise Exception(f"Kohya training failed with exit code {return_code}")

    trained_lora = resolve_trained_lora(lora_output_dir, output_name)
    if not trained_lora:
        raise Exception("Training finished but no .safetensors file was found")

    return {
        "loraOutputDir": lora_output_dir,
        "loraPath": trained_lora,
        "loraFilename": os.path.basename(trained_lora),
        "outputName": output_name,
    }


def main():
    try:
        stage_timeout_sec = parse_positive_int_env("TRAIN_LORA_TOTAL_TIMEOUT_SEC", 18_000)
        deadline_ts = (
            time.time() + stage_timeout_sec if stage_timeout_sec > 0 else None
        )

        if len(sys.argv) < 2:
            emit_result({
                "status": "failed",
                "success": False,
                "degraded": False,
                "degradedReasons": [],
                "errorCode": "train_lora.missing_style_argument",
                "error": "Style argument required",
            })
            return

        style_raw = sys.argv[1]
        job_id = sys.argv[2] if len(sys.argv) >= 3 and sys.argv[2] else None
        style_name = normalize_style(style_raw)
        reusable = existing_train_result(job_id)
        if reusable:
            emit_result(reusable)
            return

        ensure_stage_deadline(deadline_ts, "fetch_positive_feedback")
        feedback_rows = fetch_positive_feedback(style_raw)
        likes_count = len(feedback_rows)
        if likes_count == 0:
            emit_result(
                {
                    "status": "degraded",
                    "success": True,
                    "degraded": True,
                    "reasonCode": "insufficient_data",
                    "style": style_name,
                    "likesCount": 0,
                    "imagesUsed": 0,
                    "message": "No positive feedback found for style",
                },
            )
            return

        ensure_stage_deadline(deadline_ts, "build_training_samples")
        samples = build_training_samples(feedback_rows)
        if len(samples) < 20:
            emit_result(
                {
                    "status": "degraded",
                    "success": True,
                    "degraded": True,
                    "reasonCode": "insufficient_data",
                    "style": style_name,
                    "likesCount": likes_count,
                    "imagesUsed": len(samples),
                    "message": "Not enough resolved local images to train LoRA",
                },
            )
            return

        ensure_stage_deadline(deadline_ts, "prepare_dataset")
        dataset_info = prepare_dataset(samples, style_name)
        epochs = choose_epochs(len(samples))
        ensure_stage_deadline(deadline_ts, "run_kohya_training")
        training_result = run_kohya_training(
            style_name,
            dataset_info["datasetRoot"],
            epochs,
            deadline_ts=deadline_ts,
        )

        result = {
            "status": "success",
            "success": True,
            "degraded": False,
            "style": style_name,
            "likesCount": likes_count,
            "imagesUsed": len(samples),
            "epochs": epochs,
            "resolution": "1024x1024",
            "datasetDir": dataset_info["datasetRoot"],
            "loraFilename": training_result["loraFilename"],
            "loraPath": training_result["loraPath"],
            "networkDim": 32,
            "networkAlpha": 16,
            "learningRate": 1e-4,
        }
        save_receipt("train_lora", job_id, result)
        emit_result(result)
    except Exception as exc:
        emit_result({
            "status": "failed",
            "success": False,
            "degraded": False,
            "degradedReasons": [],
            "errorCode": "train_lora.exception",
            "error": str(exc),
            "type": type(exc).__name__,
        })
        return


if __name__ == "__main__":
    main()
