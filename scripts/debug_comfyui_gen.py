#!/usr/bin/env python3
"""
Single-image ComfyUI debug generation.
"""

from __future__ import annotations

import os
import time

from generate_images import generate_with_comfyui
from runtime_config import get_comfyui_url, load_project_env
from script_logging import fail, info, ok, section


load_project_env()


def test_single_generation() -> None:
    section("COMFYUI DEBUG GENERATION")
    info(f"ComfyUI URL: {get_comfyui_url()}")
    prompt = "A beautiful sunset over the Eiffel Tower in Paris, full body visible person standing"
    style = "cinematic photorealistic"
    info(f"Prompt: {prompt}")

    try:
        start_time = time.time()
        output_path = generate_with_comfyui(
            prompt=prompt,
            style=style,
            width=1024,
            height=576,
            scene_index=99,
            checkpoint=os.getenv("COMFYUI_CHECKPOINT"),
        )
        elapsed = time.time() - start_time
        ok(f"Image generated: {output_path}")
        info(f"Elapsed: {elapsed:.1f}s")
    except Exception as exc:
        fail(f"Generation failed: {exc}")


if __name__ == "__main__":
    test_single_generation()

