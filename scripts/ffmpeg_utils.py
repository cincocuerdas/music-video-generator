#!/usr/bin/env python3
"""
Shared FFmpeg path helpers for pipeline scripts.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import List


def _is_working_ffmpeg(candidate: str) -> bool:
    try:
        result = subprocess.run(
            [candidate, "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def _candidate_paths(root_dir: str) -> List[str]:
    ffmpeg_env = os.getenv("FFMPEG_PATH")
    extra_paths_raw = os.getenv("FFMPEG_EXTRA_PATHS", "")
    extra_paths = [p.strip() for p in extra_paths_raw.split(os.pathsep) if p.strip()]

    candidates: List[str] = []
    if ffmpeg_env:
        candidates.append(ffmpeg_env)

    candidates.extend(
        [
            *extra_paths,
            os.path.join(root_dir, "scripts", "ffmpeg.exe"),
            os.path.join(root_dir, "ffmpeg.exe"),
            "/usr/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "ffmpeg",
        ]
    )
    return candidates


def resolve_ffmpeg_path(root_dir: str) -> str:
    """
    Resolve FFmpeg binary from env, extra paths, local project paths, and system PATH.
    Returns "ffmpeg" fallback if not found.
    """
    for candidate in _candidate_paths(root_dir):
        if _is_working_ffmpeg(candidate):
            return candidate
    return "ffmpeg"


def ensure_ffmpeg_on_path(root_dir: str) -> str:
    """
    Ensure FFmpeg is reachable through PATH and return resolved executable path.
    """
    ffmpeg_path = resolve_ffmpeg_path(root_dir)

    explicit_bin = os.getenv("FFMPEG_BIN")
    if explicit_bin and os.path.isdir(explicit_bin):
        os.environ["PATH"] = explicit_bin + os.pathsep + os.environ.get("PATH", "")
        return ffmpeg_path

    if os.path.isabs(ffmpeg_path):
        ffmpeg_dir = os.path.dirname(ffmpeg_path)
        if ffmpeg_dir and os.path.isdir(ffmpeg_dir):
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

    # Fallbacks for scripts using default PATH resolution
    if sys.platform == "win32":
        local_scripts = os.path.join(root_dir, "scripts")
        if os.path.isdir(local_scripts):
            os.environ["PATH"] = local_scripts + os.pathsep + os.environ.get("PATH", "")

    return ffmpeg_path

