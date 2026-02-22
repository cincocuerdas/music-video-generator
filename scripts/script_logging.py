#!/usr/bin/env python3
"""
Shared lightweight logging helpers for local Python scripts.
"""

from __future__ import annotations


def _emit(level: str, message: str) -> None:
    print(f"[{level}] {message}")


def info(message: str) -> None:
    _emit("INFO", message)


def ok(message: str) -> None:
    _emit("OK", message)


def warn(message: str) -> None:
    _emit("WARN", message)


def fail(message: str) -> None:
    _emit("FAIL", message)


def section(title: str, width: int = 60) -> None:
    print("\n" + "=" * width)
    print(title)
    print("=" * width)

