#!/usr/bin/env python3
"""
Cross-process Gemini concurrency limiter.

Uses a file-lock based semaphore so that `analyze_lyrics.py` and
`generate_images.py` (which run as separate BullMQ workers) never
exceed GEMINI_GLOBAL_CONCURRENCY simultaneous Gemini API calls.

Additionally provides a shared jitter helper and a cross-process
cooldown gate backed by a small JSON file.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import threading
from contextlib import contextmanager
from typing import Callable, TypeVar

from env_utils import parse_float_env, parse_int_env

T = TypeVar("T")

# ---------------------------------------------------------------------------
# Shared constants / paths
# ---------------------------------------------------------------------------

_LOCK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".gemini_locks")
_COOLDOWN_FILE = os.path.join(_LOCK_DIR, "cooldown.json")


def _ensure_lock_dir() -> None:
    os.makedirs(_LOCK_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# 1. Backoff with jitter  (shared helper)
# ---------------------------------------------------------------------------

def backoff_with_jitter(
    base_seconds: float,
    jitter_ratio: float | None = None,
) -> float:
    """
    Return *base_seconds* ± jitter_ratio (default 25 %).
    Jitter avoids thundering-herd retries.
    """
    if base_seconds <= 0:
        return 0.0
    if jitter_ratio is None:
        jitter_ratio = max(0.0, parse_float_env("GEMINI_BACKOFF_JITTER_RATIO", 0.25))
    if jitter_ratio == 0:
        return base_seconds
    low = max(0.0, 1.0 - jitter_ratio)
    high = 1.0 + jitter_ratio
    return max(0.0, base_seconds * random.uniform(low, high))


# ---------------------------------------------------------------------------
# 2. Cross-process cooldown gate
# ---------------------------------------------------------------------------

class CrossProcessCooldown:
    """
    Persist cooldown-until timestamp in a JSON file so that *all*
    Python pipeline scripts respect it — even if they are separate
    OS processes launched by different BullMQ workers.
    """

    def __init__(self, path: str = _COOLDOWN_FILE) -> None:
        self._path = path
        self._lock = threading.Lock()

    # -- read --
    def remaining(self) -> float:
        """Seconds of cooldown remaining (0 if expired or file missing)."""
        with self._lock:
            try:
                with open(self._path, "r") as fh:
                    data = json.load(fh)
                return max(0.0, float(data.get("until", 0)) - time.time())
            except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError):
                return 0.0

    # -- write --
    def activate(self, seconds: float) -> None:
        """Set cooldown for *seconds* from now (only extends, never shortens)."""
        if seconds <= 0:
            return
        _ensure_lock_dir()
        with self._lock:
            until = time.time() + seconds
            # Read existing — only push further
            try:
                with open(self._path, "r") as fh:
                    existing = float(json.load(fh).get("until", 0))
                if existing >= until:
                    return
            except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError):
                pass
            with open(self._path, "w") as fh:
                json.dump({"until": until}, fh)

    def wait_if_active(self, label: str = "") -> None:
        """Block until cooldown expires (if active)."""
        rem = self.remaining()
        if rem > 0:
            tag = f" ({label})" if label else ""
            print(
                f"  ⏳ Gemini cross-process cooldown{tag}: waiting {rem:.1f}s",
                file=sys.stderr,
            )
            time.sleep(rem)


GEMINI_COOLDOWN = CrossProcessCooldown()


# ---------------------------------------------------------------------------
# 3. File-lock based global concurrency semaphore
# ---------------------------------------------------------------------------

if sys.platform == "win32":
    import msvcrt

    def _lock_file(fh):  # type: ignore[no-untyped-def]
        msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)

    def _unlock_file(fh):  # type: ignore[no-untyped-def]
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _lock_file(fh):  # type: ignore[no-untyped-def]
        fcntl.flock(fh, fcntl.LOCK_EX)

    def _unlock_file(fh):  # type: ignore[no-untyped-def]
        fcntl.flock(fh, fcntl.LOCK_UN)


@contextmanager
def gemini_global_slot(slot_label: str = ""):
    """
    Acquire one of N global concurrency slots before calling Gemini.

    *N* = env GEMINI_GLOBAL_CONCURRENCY (default 1 — fully serial).

    Usage::

        with gemini_global_slot("scene-3"):
            result = call_gemini(...)
    """
    max_slots = max(1, parse_int_env("GEMINI_GLOBAL_CONCURRENCY", 1))
    _ensure_lock_dir()

    acquired_fh = None
    tag = f" ({slot_label})" if slot_label else ""

    while acquired_fh is None:
        for slot_idx in range(max_slots):
            lock_path = os.path.join(_LOCK_DIR, f"slot_{slot_idx}.lock")
            try:
                fh = open(lock_path, "w")
                # Non-blocking attempt on Windows is tricky; we use
                # blocking per-slot with a short spin.  Since max_slots
                # is usually 1-2 this is fine.
                _lock_file(fh)
                acquired_fh = fh
                break
            except (OSError, IOError):
                try:
                    fh.close()
                except Exception:
                    pass
                continue

        if acquired_fh is None:
            # All slots occupied — brief sleep then retry
            time.sleep(0.25)

    try:
        yield
    finally:
        _unlock_file(acquired_fh)
        acquired_fh.close()


def call_with_gemini_guard(
    fn: Callable[[], T],
    *,
    label: str = "",
    respect_cooldown: bool = True,
    min_interval: float | None = None,
) -> T:
    """
    High-level wrapper: cooldown gate → semaphore slot → min-interval → call fn().

    Parameters
    ----------
    fn : callable
        Zero-arg callable that makes the actual Gemini API request.
    label : str
        Descriptive label for log messages.
    respect_cooldown : bool
        If True (default), block until cross-process cooldown expires.
    min_interval : float | None
        Minimum seconds between consecutive Gemini calls (default from env
        ``GEMINI_MIN_INTERVAL_SECONDS``, fallback 6).
    """
    if min_interval is None:
        min_interval = max(0.0, parse_float_env("GEMINI_MIN_INTERVAL_SECONDS", 6.0))

    # 1️⃣  Respect cooldown
    if respect_cooldown:
        GEMINI_COOLDOWN.wait_if_active(label)

    # 2️⃣  Acquire global slot
    with gemini_global_slot(label):
        # 3️⃣  Enforce min-interval inside the slot
        if min_interval > 0:
            with _MIN_INTERVAL_LOCK:
                elapsed = time.time() - _LAST_CALL_TS["v"]
                if elapsed < min_interval:
                    gap = min_interval - elapsed
                    print(
                        f"  ⏳ Gemini pacing wait {gap:.1f}s",
                        file=sys.stderr,
                    )
                    time.sleep(gap)
            # Note: we update _LAST_CALL_TS in the finally below.

        try:
            return fn()
        finally:
            with _MIN_INTERVAL_LOCK:
                _LAST_CALL_TS["v"] = time.time()


_MIN_INTERVAL_LOCK = threading.Lock()
_LAST_CALL_TS = {"v": 0.0}


# ---------------------------------------------------------------------------
# 4. Generic 429 detection  (usable from any script)
# ---------------------------------------------------------------------------

def is_gemini_rate_limit_error_generic(error: Exception) -> bool:
    """Return True if the error looks like a Gemini 429 / rate-limit response."""
    import urllib.error as _ue

    if isinstance(error, _ue.HTTPError):
        return getattr(error, "code", None) == 429
    message = str(error).lower()
    return "429" in message and "too many requests" in message
