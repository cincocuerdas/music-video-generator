#!/usr/bin/env python3
"""
Helpers for per-job idempotency receipts.
"""

import json
import os
from typing import Any, Optional


current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
RECEIPTS_DIR = os.path.join(root_dir, "output", "job_receipts")


def get_receipt_path(stage: str, job_id: Optional[str]) -> Optional[str]:
    if not stage or not job_id:
        return None
    safe_stage = "".join(ch for ch in stage if ch.isalnum() or ch in ("_", "-")).strip("_-")
    safe_job_id = "".join(ch for ch in str(job_id) if ch.isalnum() or ch in ("_", "-")).strip("_-")
    if not safe_stage or not safe_job_id:
        return None
    return os.path.join(RECEIPTS_DIR, f"{safe_stage}_{safe_job_id}.json")


def load_receipt(stage: str, job_id: Optional[str]) -> Optional[dict[str, Any]]:
    path = get_receipt_path(stage, job_id)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def save_receipt(stage: str, job_id: Optional[str], payload: dict[str, Any]) -> None:
    path = get_receipt_path(stage, job_id)
    if not path:
        return
    os.makedirs(RECEIPTS_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
