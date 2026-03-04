#!/usr/bin/env python3
"""Shared environment parsing helpers for Python scripts."""

from __future__ import annotations

from typing import List
import os


def parse_bool_env(name: str, default: bool = False) -> bool:
    value = (os.getenv(name) or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def parse_int_env(name: str, fallback: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return fallback
    try:
        return int(raw)
    except Exception:
        return fallback


def parse_positive_int_env(name: str, fallback: int) -> int:
    parsed = parse_int_env(name, fallback)
    return parsed if parsed > 0 else fallback


def parse_float_env(name: str, fallback: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return fallback
    try:
        return float(raw)
    except Exception:
        return fallback


def parse_csv_env(name: str, fallback: str = "") -> List[str]:
    raw = (os.getenv(name) or "").strip()
    source = raw if raw else fallback
    if not source:
        return []
    values = [token.strip().lower() for token in source.split(",")]
    return [token for token in values if token]

