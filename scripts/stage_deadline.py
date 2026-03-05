#!/usr/bin/env python3
"""Shared stage deadline helpers for pipeline scripts."""

from __future__ import annotations

import time
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
