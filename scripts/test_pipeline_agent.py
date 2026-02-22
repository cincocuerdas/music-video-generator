#!/usr/bin/env python3
"""
Automated Pipeline Test Agent
Tests the full video generation pipeline end-to-end.
"""

from __future__ import annotations

import os
import re
import sys
import time

import requests

from runtime_config import get_api_base_url, load_project_env
from script_logging import fail, info, ok, section, warn


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_project_env()
API_BASE = get_api_base_url()
TEST_YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


class PipelineTester:
    def __init__(self):
        self.results: list[dict[str, str]] = []
        self.project_id: str | None = None
        self.completed_steps: set[str] = set()

    def log(self, step: str, status: str, message: str) -> None:
        if status == "pass":
            ok(f"{step}: {message}")
        elif status == "fail":
            fail(f"{step}: {message}")
        else:
            info(f"{step}: {message}")
        self.results.append({"step": step, "status": status, "message": message})

    def test_health(self) -> bool:
        try:
            response = requests.get(f"{API_BASE}/health", timeout=5)
            if response.status_code == 200:
                self.log("Health Check", "pass", "Backend is running")
                return True
            self.log("Health Check", "fail", f"Status {response.status_code}")
            return False
        except Exception as exc:
            self.log("Health Check", "fail", f"Cannot connect: {exc}")
            return False

    def test_create_project(self, youtube_url: str | None = None, visual_style: str | None = None) -> bool:
        url = youtube_url or TEST_YOUTUBE_URL
        style = visual_style or "cinematic"
        payload = {
            "title": f"Auto Test {int(time.time())}",
            "youtubeUrl": url,
            "visualStyle": style,
            "aspectRatio": "16:9",
        }

        try:
            response = requests.post(f"{API_BASE}/projects", json=payload, timeout=30)
            if response.status_code not in [200, 201]:
                self.log("Create Project", "fail", f"Status {response.status_code}: {response.text}")
                return False

            data = response.json()
            self.project_id = data.get("id")
            self.log("Create Project", "pass", f"Project created: {self.project_id} ({style})")

            self.log("Start Pipeline", "progress", "Starting generation pipeline")
            start_response = requests.post(
                f"{API_BASE}/projects/{self.project_id}/generate",
                json={"youtubeUrl": url, "visualStyle": style},
                timeout=30,
            )
            if start_response.status_code in [200, 201]:
                self.log("Start Pipeline", "pass", "Generation started")
                return True

            self.log(
                "Start Pipeline",
                "fail",
                f"Status {start_response.status_code}: {start_response.text}",
            )
            return False
        except Exception as exc:
            self.log("Create Project", "fail", str(exc))
            return False

    def test_wait_for_completion(self, max_wait: int = 2400) -> bool:
        if not self.project_id:
            self.log("Pipeline", "fail", "No project ID")
            return False

        start = time.time()
        last_status = None

        while time.time() - start < max_wait:
            try:
                response = requests.get(f"{API_BASE}/projects/{self.project_id}", timeout=10)
                if response.status_code != 200:
                    time.sleep(5)
                    continue

                data = response.json()
                status = data.get("status", "unknown")
                jobs = data.get("jobs", [])
                gen_job = next((job for job in jobs if job["type"] == "GENERATE_IMAGES"), None)
                progress_suffix = ""
                if gen_job and gen_job.get("status") == "PROCESSING":
                    progress_suffix = (
                        f" ({gen_job.get('progress', 0)}% - {gen_job.get('currentStep', '')})"
                    )

                print(f"[INFO] Status: {status}{progress_suffix}      ", end="\r")
                if status != last_status:
                    print("")
                    info(f"New status: {status}")
                    last_status = status

                if data.get("audioUrl") and "audio" not in self.completed_steps:
                    self.log("Audio Download", "pass", "Audio downloaded")
                    self.completed_steps.add("audio")

                if data.get("transcription") and "transcription" not in self.completed_steps:
                    self.log("Transcription", "pass", "Transcription complete")
                    self.completed_steps.add("transcription")

                if data.get("analysisResult") and "analysis" not in self.completed_steps:
                    scenes = data["analysisResult"].get("scenes", [])
                    self.log("Analysis", "pass", f"{len(scenes)} scenes generated")
                    self.completed_steps.add("analysis")

                if status.lower() == "completed":
                    if data.get("videoUrl"):
                        self.log("Video Render", "pass", f"Video: {data['videoUrl']}")
                        return True
                    self.log("Video Render", "fail", "No video URL")
                    return False

                if status.lower() == "failed":
                    self.log("Pipeline", "fail", "Pipeline failed")
                    return False

                time.sleep(10)
            except Exception as exc:
                text = str(exc)
                if "10061" in text or "reconnect" in text.lower() or "max retries exceeded" in text.lower():
                    warn("Backend restarting... retrying in 5s")
                else:
                    warn(f"Error checking status: {text[:120]}")
                time.sleep(5)

        self.log("Pipeline", "fail", "Timeout waiting for completion")
        return False

    def test_video_accessible(self) -> bool:
        if not self.project_id:
            return False

        try:
            response = requests.get(f"{API_BASE}/projects/{self.project_id}", timeout=10)
            data = response.json()
            video_url = data.get("videoUrl")
            if not video_url:
                self.log("Video File", "fail", "No video URL")
                return False

            if video_url.startswith("/output"):
                file_path = os.path.join(ROOT_DIR, video_url.lstrip("/").replace("/", os.sep))
                if os.path.exists(file_path):
                    size_mb = os.path.getsize(file_path) / (1024 * 1024)
                    self.log("Video File", "pass", f"File exists ({size_mb:.1f} MB)")
                    return True
                self.log("Video File", "fail", f"File not found: {file_path}")
                return False

            self.log("Video File", "pass", f"Remote URL available: {video_url}")
            return True
        except Exception as exc:
            self.log("Video File", "fail", str(exc))
            return False

    def print_summary(self) -> bool:
        section("TEST SUMMARY", width=50)
        passed = sum(1 for result in self.results if result["status"] == "pass")
        failed_count = sum(1 for result in self.results if result["status"] == "fail")

        for result in self.results:
            label = "[OK]" if result["status"] == "pass" else "[FAIL]" if result["status"] == "fail" else "[INFO]"
            print(f"  {label} {result['step']}")

        info(f"Total: {passed} passed, {failed_count} failed")
        if failed_count == 0:
            ok("All tests passed")
            return True
        fail("Some tests failed")
        return False

    def attach_and_monitor(self, project_id: str) -> bool:
        section(f"ATTACH MODE: {project_id}", width=50)

        if not self.test_health():
            fail("Backend not available. Aborting.")
            return False

        try:
            response = requests.get(f"{API_BASE}/projects/{project_id}", timeout=10)
            if response.status_code != 200:
                self.log("Attach Project", "fail", f"Project not found (status {response.status_code})")
                return False

            data = response.json()
            self.project_id = project_id
            status = data.get("status", "unknown")
            self.log("Attach Project", "pass", f"Found project (status: {status})")
            info(f"YouTube URL: {data.get('youtubeUrl', 'N/A')}")

            if status.lower() == "completed":
                self.log("Pipeline", "pass", "Project already completed")
                if data.get("videoUrl"):
                    self.log("Video", "pass", f"Video: {data['videoUrl']}")
                return self.print_summary()

            if status.lower() == "failed":
                self.log("Pipeline", "fail", "Project previously failed")
                return self.print_summary()
        except Exception as exc:
            self.log("Attach Project", "fail", str(exc))
            return False

        info("Monitoring pipeline progress (max 40 min)")
        self.test_wait_for_completion()
        self.test_video_accessible()
        return self.print_summary()

    def run_full_test(self, youtube_url: str | None = None) -> bool:
        section("AUTOMATED PIPELINE TEST", width=50)

        if not self.test_health():
            fail("Backend not available. Aborting.")
            return False

        if not self.test_create_project(youtube_url):
            fail("Could not create project. Aborting.")
            return False

        info("Waiting for pipeline to complete (max 40 min)")
        self.test_wait_for_completion()
        self.test_video_accessible()
        return self.print_summary()


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    tester = PipelineTester()

    uuid_pattern = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    if arg and re.match(uuid_pattern, arg, re.IGNORECASE):
        info("UUID detected - attach mode")
        success = tester.attach_and_monitor(arg)
    else:
        success = tester.run_full_test(arg)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

