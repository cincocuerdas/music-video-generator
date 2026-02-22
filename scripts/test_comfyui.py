#!/usr/bin/env python3
"""
Quick test for ComfyUI integration.
"""

from __future__ import annotations

import os
import sys

from generate_images import generate_with_comfyui
from runtime_config import get_comfyui_url, load_project_env
from script_logging import fail, info, ok, section


load_project_env()


def test_comfyui() -> bool:
    section("COMFYUI INTEGRATION TEST")
    info(f"ComfyUI URL: {get_comfyui_url()}")
    info(f"Model: {os.getenv('COMFYUI_CHECKPOINT', 'not set')}")

    test_prompt = "a beautiful sunset over the ocean, golden hour, dramatic clouds"
    style = "cinematic"
    info(f"Prompt: {test_prompt}")
    info(f"Style: {style}")
    info("Generating image (this may take 30-60 seconds)")

    try:
        result = generate_with_comfyui(
            prompt=test_prompt,
            style=style,
            width=1024,
            height=1024,
            scene_index=0,
        )
        ok(f"Image generated: {result}")
        return True
    except Exception as exc:
        fail(f"Generation failed: {exc}")
        return False


if __name__ == "__main__":
    sys.exit(0 if test_comfyui() else 1)

