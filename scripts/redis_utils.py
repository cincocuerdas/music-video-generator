#!/usr/bin/env python3
"""
Redis helpers shared by pipeline scripts.
"""

from __future__ import annotations

import os
import sys
from typing import Optional
from urllib.parse import urlparse

from runtime_config import is_production

def _is_loopback_host(hostname: str) -> bool:
    normalized = (hostname or "").strip().lower()
    return normalized in {"localhost", "127.0.0.1", "::1"}


def build_redis_url() -> str:
    """
    Resolve Redis URL from environment.

    Priority:
    1. REDIS_URL
    2. REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
    """
    redis_url = (os.getenv("REDIS_URL") or "").strip()
    if redis_url:
        if is_production():
            try:
                parsed = urlparse(redis_url)
                if _is_loopback_host(parsed.hostname or ""):
                    raise RuntimeError(
                        "REDIS_URL cannot point to loopback host in production.",
                    )
            except RuntimeError:
                raise
            except Exception as exc:
                raise RuntimeError(f"Invalid REDIS_URL: {exc}") from exc
        return redis_url

    redis_host = (os.getenv("REDIS_HOST") or "").strip()
    redis_port = os.getenv("REDIS_PORT", "6379")
    redis_password = os.getenv("REDIS_PASSWORD")

    if is_production() and not redis_host:
        raise RuntimeError(
            "REDIS_URL or REDIS_HOST/REDIS_PORT is required in production.",
        )

    if not redis_host:
        redis_host = "127.0.0.1"
    elif is_production() and _is_loopback_host(redis_host):
        raise RuntimeError(
            "REDIS_HOST cannot be loopback in production.",
        )

    if redis_password:
        return f"redis://:{redis_password}@{redis_host}:{redis_port}"
    return f"redis://{redis_host}:{redis_port}"


def get_redis_client(log_prefix: str = "Redis", ping: bool = True):
    """
    Create Redis client if dependency and server are available.
    Returns None on failure.
    """
    try:
        import redis
    except ImportError:
        print(
            f"Warning: redis package not installed. [{log_prefix}] features disabled.",
            file=sys.stderr,
        )
        return None

    try:
        client = redis.from_url(build_redis_url())
        if ping:
            client.ping()
        return client
    except Exception as exc:
        print(f"Warning: [{log_prefix}] Redis unavailable: {exc}", file=sys.stderr)
        return None
