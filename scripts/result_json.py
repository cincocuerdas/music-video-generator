#!/usr/bin/env python3
"""Shared RESULT_JSON emitter for pipeline scripts."""

from __future__ import annotations

import io
import json
import os
import sys
from typing import Any, Dict, List


def _ensure_utf8_stdio() -> None:
    """Force UTF-8 encoding on stdout/stderr for Windows compatibility."""
    if os.name == "nt":
        for stream_name in ("stdout", "stderr"):
            stream = getattr(sys, stream_name)
            if hasattr(stream, "reconfigure"):
                try:
                    stream.reconfigure(encoding="utf-8", errors="replace")
                except Exception:
                    pass
            elif hasattr(stream, "buffer"):
                try:
                    replacement = io.TextIOWrapper(
                        stream.buffer, encoding="utf-8", errors="replace",
                        line_buffering=stream.line_buffering,
                    )
                    setattr(sys, stream_name, replacement)
                except Exception:
                    pass


_ensure_utf8_stdio()


def _normalize_reason_list(value: Any) -> List[str]:
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


def _normalize_payload(payload: Any, default_error_code: str) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {
            "status": "failed",
            "success": False,
            "degraded": False,
            "degradedReasons": [f"{default_error_code}.invalid_payload"],
            "errorCode": f"{default_error_code}.invalid_payload",
            "message": "Invalid result payload",
        }

    normalized: Dict[str, Any] = dict(payload)
    raw_status = str(normalized.get("status") or "").strip().lower()
    if raw_status not in {"success", "degraded", "failed"}:
        if isinstance(normalized.get("success"), bool):
            raw_status = "success" if normalized["success"] else "failed"
        else:
            raw_status = "success"
        normalized["status"] = raw_status

    if not isinstance(normalized.get("success"), bool):
        normalized["success"] = raw_status != "failed"
    if not isinstance(normalized.get("degraded"), bool):
        normalized["degraded"] = raw_status == "degraded"

    degraded_reasons = _normalize_reason_list(normalized.get("degradedReasons"))
    reason_code = str(normalized.get("reasonCode") or "").strip()
    fallback_reason = str(normalized.get("_fallbackReason") or "").strip()
    if reason_code and reason_code not in degraded_reasons:
        degraded_reasons.append(reason_code)
    if fallback_reason and fallback_reason not in degraded_reasons:
        degraded_reasons.append(fallback_reason)

    if normalized["degraded"] and not degraded_reasons:
        degraded_reasons = [f"{default_error_code}.degraded"]
    normalized["degradedReasons"] = degraded_reasons

    if (raw_status == "failed" or normalized["success"] is False) and not str(
        normalized.get("errorCode") or ""
    ).strip():
        normalized["errorCode"] = f"{default_error_code}.failed"

    return normalized


def emit_result(payload: Any, *, default_error_code: str = "pipeline") -> Dict[str, Any]:
    normalized = _normalize_payload(payload, default_error_code)
    output = json.dumps(normalized, ensure_ascii=False)
    print(output)
    print(f"RESULT_JSON:{output}", file=sys.stderr)
    return normalized

