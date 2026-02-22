#!/usr/bin/env python3
"""
End-to-end image generation smoke test for "La Construccion" prompts.
"""

from __future__ import annotations

import json
import os
import sys
import time

from generate_images import generate_with_comfyui
from runtime_config import get_comfyui_url, load_project_env
from script_logging import fail, info, ok, section, warn


current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_project_env()


SCENES = [
    {"lyric": "Quiero ver ninos en las calles jugando", "prompt": "children playing happily in the streets, sunny day, urban neighborhood, joyful atmosphere"},
    {"lyric": "No quiero verlos mas trabajando", "prompt": "sad children working, child labor, factory or farm, somber mood, documentary style"},
    {"lyric": "Cuanta violencia, cuanta corrupcion", "prompt": "protest signs against corruption, urban street, people demanding justice, Latin American city"},
    {"lyric": "El bienestar de mi pueblo quiero ver", "prompt": "happy community, people together, neighborhood, Latin American town, unity"},
    {"lyric": "Cuantas familias no tienen para comer", "prompt": "poor family struggling, empty table, humble home, emotional, documentary"},
    {"lyric": "Politicos corruptos no paran de robar", "prompt": "corrupt politicians, money bags, government building, satirical, political"},
    {"lyric": "Un pueblo que se educa", "prompt": "students in a classroom, education, books, knowledge, hopeful atmosphere"},
    {"lyric": "Podra esperar manana un futuro diferente", "prompt": "sunrise over a city, new dawn, hope, bright future, optimistic"},
    {"lyric": "Exige que te escuchen", "prompt": "person speaking at a microphone, crowd listening, public speech, empowerment"},
    {"lyric": "Hagamos entre todos, la construccion", "prompt": "people building together, construction, community work, teamwork, unity"},
]


def run_pipeline_test() -> bool:
    section("LA CONSTRUCCION PIPELINE TEST")
    audio_path = os.path.join(root_dir, "output", "audio", "La Construccion.mp3")
    if not os.path.exists(audio_path):
        fail(f"Audio file not found: {audio_path}")
        return False
    ok(f"Audio file found: {audio_path}")

    comfyui_url = get_comfyui_url()
    checkpoint = os.getenv("COMFYUI_CHECKPOINT", "")
    info(f"ComfyUI URL: {comfyui_url}")
    info(f"Checkpoint: {checkpoint or '(not set)'}")

    test_scenes = SCENES[:5]
    info(f"Generating {len(test_scenes)} images for smoke test")

    generated_images = []
    style = "cinematic, photorealistic, documentary style"

    for index, scene in enumerate(test_scenes):
        info(f"[{index + 1}/{len(test_scenes)}] {scene['lyric'][:45]}...")
        try:
            start_time = time.time()
            image_path = generate_with_comfyui(
                prompt=scene["prompt"],
                style=style,
                width=1920,
                height=1080,
                scene_index=index,
            )
            elapsed = time.time() - start_time
            ok(f"Generated in {elapsed:.1f}s: {os.path.basename(image_path)}")
            generated_images.append(
                {
                    "index": index,
                    "lyric": scene["lyric"],
                    "prompt": scene["prompt"],
                    "image": image_path,
                    "time": elapsed,
                }
            )
        except Exception as exc:
            warn(f"Generation failed for scene {index}: {exc}")
            generated_images.append(
                {
                    "index": index,
                    "lyric": scene["lyric"],
                    "error": str(exc),
                }
            )

    section("RESULTS")
    success_count = len([img for img in generated_images if "image" in img])
    total_time = sum([img.get("time", 0) for img in generated_images])
    info(f"Generated: {success_count}/{len(test_scenes)}")
    info(f"Total time: {total_time:.1f}s")
    if success_count:
        info(f"Average: {total_time / success_count:.1f}s/image")

    results_path = os.path.join(root_dir, "output", "test_pipeline_results.json")
    with open(results_path, "w", encoding="utf-8") as file:
        json.dump({"audio": audio_path, "images": generated_images, "total_time": total_time}, file, indent=2)
    info(f"Results saved to: {results_path}")

    if success_count == len(test_scenes):
        ok("Pipeline smoke test completed successfully")
        return True

    warn("Pipeline smoke test completed with partial failures")
    return False


if __name__ == "__main__":
    success = run_pipeline_test()
    sys.exit(0 if success else 1)

