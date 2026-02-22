#!/usr/bin/env python3
"""
Shared runtime configuration helpers for Python pipeline scripts.
"""

from __future__ import annotations

import os
from urllib.parse import quote_plus, urlparse
from dotenv import load_dotenv

DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188"
DEFAULT_PLACEHOLDER_BASE_URL = "https://placehold.co"
DEFAULT_API_BASE_URL = "http://127.0.0.1:3000/api/v1"


def is_production() -> bool:
    return (os.getenv("NODE_ENV") or "development").strip().lower() == "production"


def get_project_root() -> str:
    current_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(current_dir)


def load_project_env() -> None:
    dotenv_path = os.path.join(get_project_root(), ".env")
    load_dotenv(dotenv_path)


def get_comfyui_url() -> str:
    configured = (os.getenv("COMFYUI_URL") or "").strip()
    if configured:
        return configured.rstrip("/")
    if is_production():
        raise RuntimeError(
            "COMFYUI_URL is required in production (no implicit local default).",
        )
    return DEFAULT_COMFYUI_URL


def get_placeholder_base_url() -> str:
    configured = (os.getenv("PLACEHOLDER_IMAGE_BASE_URL") or "").strip()
    if configured:
        return configured.rstrip("/")
    return DEFAULT_PLACEHOLDER_BASE_URL


def get_api_base_url() -> str:
    configured = (os.getenv("API_BASE_URL") or "").strip()
    if configured:
        return configured.rstrip("/")
    if is_production():
        raise RuntimeError(
            "API_BASE_URL is required in production (no implicit local default).",
        )
    return DEFAULT_API_BASE_URL


def build_placeholder_image_url(
    text: str,
    width: int = 1920,
    height: int = 1080,
    background_hex: str = "1a1a2e",
    foreground_hex: str = "00ff88",
) -> str:
    safe_text = quote_plus((text or "Placeholder").strip())
    bg = (background_hex or "1a1a2e").lstrip("#")
    fg = (foreground_hex or "00ff88").lstrip("#")
    base = get_placeholder_base_url()
    return f"{base}/{width}x{height}/{bg}/{fg}?text={safe_text}"


def is_placeholder_url(url: str) -> bool:
    if not url:
        return False
    lowered = url.lower()
    if "placeholder" in lowered or "placehold.co" in lowered:
        return True

    base = get_placeholder_base_url()
    try:
        parsed_base = urlparse(base)
        parsed_url = urlparse(url)
        if parsed_base.netloc and parsed_url.netloc:
            return parsed_base.netloc.lower() == parsed_url.netloc.lower()
    except Exception:
        return False

    return False
