#!/usr/bin/env python3
"""
Convenience wrapper around PipelineTester for a configurable song/style.
"""

from __future__ import annotations

import os
import sys

from script_logging import fail, info, section
from test_pipeline_agent import PipelineTester


def main() -> None:
    tester = PipelineTester()
    youtube_url = os.getenv("TEST_YOUTUBE_URL", "https://music.youtube.com/watch?v=SKu9P0hOzIQ")
    visual_style = os.getenv("TEST_VISUAL_STYLE", "hyper-realistic")

    section("NEW SONG PIPELINE TEST", width=50)
    info(f"YouTube URL: {youtube_url}")
    info(f"Visual style: {visual_style}")

    if not tester.test_health():
        fail("Backend not available. Aborting.")
        sys.exit(1)

    if not tester.test_create_project(youtube_url, visual_style):
        fail("Could not create project. Aborting.")
        sys.exit(1)

    info("Waiting for pipeline to complete (max 40 min)")
    tester.test_wait_for_completion()
    tester.test_video_accessible()
    success = tester.print_summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

