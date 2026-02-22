#!/usr/bin/env python3
"""
Validation smoke test for project creation endpoint.
"""

from __future__ import annotations

import sys

import requests

from runtime_config import get_api_base_url, load_project_env
from script_logging import fail, info, ok, section


load_project_env()
API_URL = f"{get_api_base_url()}/projects"
INVALID_URL = "1401d430-d439-4f4c-879b-c353489d5ae3"  # UUID - should fail URL validation
VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def test_validation() -> None:
    section("YOUTUBE URL VALIDATION", width=50)

    info(f"Invalid URL test: {INVALID_URL}")
    try:
        response = requests.post(
            API_URL,
            json={"title": "Validation Test - Invalid", "youtubeUrl": INVALID_URL},
            timeout=20,
        )
        if response.status_code == 400:
            ok("Server rejected invalid YouTube URL as expected")
            info(f"Error message: {response.json().get('message')}")
        else:
            fail(f"Expected 400, got {response.status_code}: {response.text}")
            sys.exit(1)
    except Exception as exc:
        fail(f"Connection failed: {exc}")
        sys.exit(1)

    info(f"Valid URL test: {VALID_URL}")
    try:
        response = requests.post(
            API_URL,
            json={"title": "Validation Test - Valid", "youtubeUrl": VALID_URL},
            timeout=20,
        )
        if response.status_code == 201:
            ok("Server accepted valid YouTube URL")
            info(f"Project ID: {response.json().get('id')}")
        else:
            fail(f"Expected 201, got {response.status_code}: {response.text}")
            sys.exit(1)
    except Exception as exc:
        fail(f"Connection failed: {exc}")
        sys.exit(1)

    ok("Validation logic verified")


if __name__ == "__main__":
    test_validation()

