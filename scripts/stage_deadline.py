#!/usr/bin/env python3
"""Shared stage deadline helpers for pipeline scripts."""

from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import contextmanager
from typing import Callable, Optional


def ensure_stage_deadline(deadline_ts: Optional[float], phase: str, scope: str) -> None:
    if deadline_ts is None:
        return
    if time.time() > deadline_ts:
        raise TimeoutError(f"{scope} timeout during {phase}")


def make_stage_deadline_checker(scope: str) -> Callable[[Optional[float], str], None]:
    def _check(deadline_ts: Optional[float], phase: str) -> None:
        ensure_stage_deadline(deadline_ts, phase, scope)

    return _check


def bounded_timeout_seconds(
    deadline_ts: Optional[float],
    fallback_seconds: int,
    *,
    phase: str,
    scope: str,
    minimum_seconds: int = 1,
) -> int:
    """Return timeout bounded by global stage deadline."""
    fallback = max(minimum_seconds, int(fallback_seconds))
    if deadline_ts is None:
        return fallback

    ensure_stage_deadline(deadline_ts, phase, scope)
    remaining = int(deadline_ts - time.time())
    if remaining <= 0:
        raise TimeoutError(f"{scope} timeout during {phase}")
    return max(minimum_seconds, min(fallback, remaining))


@contextmanager
def hard_stage_deadline(timeout_seconds: int, scope: str):
    """Context manager that kills the process if the deadline is exceeded.

    Installs a daemon ``threading.Timer`` that calls ``os._exit(99)`` as a
    hard backstop.  Cooperative ``ensure_stage_deadline`` checks should still
    be used for graceful error reporting — this is the last-resort safety net.
    """

    if timeout_seconds <= 0:
        yield
        return

    def _force_exit():
        msg = f"HARD DEADLINE: {scope} exceeded {timeout_seconds}s — forcing exit.\n"
        try:
            sys.stderr.write(msg)
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(99)

    timer = threading.Timer(timeout_seconds, _force_exit)
    timer.daemon = True
    timer.start()
    try:
        yield
    finally:
        timer.cancel()
