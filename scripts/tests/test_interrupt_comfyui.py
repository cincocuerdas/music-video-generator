#!/usr/bin/env python3
"""
Unit tests for interrupt_comfyui_prompt fallback/abort behavior.
Verifies that the function:
  - Silently swallows HTTP errors (best-effort)
  - Sends POST /interrupt to ComfyUI
  - Sends POST /queue with delete payload when prompt_id provided
  - Does not crash when ComfyUI is unreachable
"""

import json
import os
import sys
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from unittest import mock

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


class _RequestLog:
    """Thread-safe collector of HTTP requests received by the test server."""
    def __init__(self):
        self.requests: list[dict] = []

    def log(self, method: str, path: str, body: bytes):
        self.requests.append({"method": method, "path": path, "body": body})


class _FakeComfyUIHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that records requests."""
    request_log: _RequestLog = None
    force_error: bool = False

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""
        self.server._request_log.log("POST", self.path, body)
        if self.server._force_error:
            self.send_error(500, "Simulated ComfyUI error")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

    def log_message(self, format, *args):
        pass  # Suppress test noise


class TestInterruptComfyuiPrompt(unittest.TestCase):
    """Test interrupt_comfyui_prompt function."""

    @classmethod
    def setUpClass(cls):
        cls.request_log = _RequestLog()
        cls.server = HTTPServer(("127.0.0.1", 0), _FakeComfyUIHandler)
        cls.server._request_log = cls.request_log
        cls.server._force_error = False
        cls.port = cls.server.server_address[1]
        cls.comfyui_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.request_log.requests.clear()
        self.server._force_error = False

    def _import_fn(self):
        from generate_images import interrupt_comfyui_prompt
        return interrupt_comfyui_prompt

    def test_sends_interrupt_without_prompt_id(self):
        """Without prompt_id, only /interrupt is called."""
        fn = self._import_fn()
        fn(self.comfyui_url)

        interrupt_reqs = [r for r in self.request_log.requests if r["path"] == "/interrupt"]
        queue_reqs = [r for r in self.request_log.requests if r["path"] == "/queue"]
        self.assertEqual(len(interrupt_reqs), 1, "Should call /interrupt exactly once")
        self.assertEqual(len(queue_reqs), 0, "Should NOT call /queue without prompt_id")

    def test_sends_interrupt_and_queue_delete_with_prompt_id(self):
        """With prompt_id, calls /interrupt then /queue with delete payload."""
        fn = self._import_fn()
        fn(self.comfyui_url, prompt_id="test-prompt-123")

        interrupt_reqs = [r for r in self.request_log.requests if r["path"] == "/interrupt"]
        queue_reqs = [r for r in self.request_log.requests if r["path"] == "/queue"]

        self.assertEqual(len(interrupt_reqs), 1)
        self.assertEqual(len(queue_reqs), 1)

        queue_body = json.loads(queue_reqs[0]["body"])
        self.assertIn("delete", queue_body)
        self.assertIn("test-prompt-123", queue_body["delete"])

    def test_swallows_server_500_error(self):
        """If ComfyUI returns 500, interrupt must NOT raise."""
        self.server._force_error = True
        fn = self._import_fn()
        # Should not raise
        fn(self.comfyui_url, prompt_id="failing-prompt")

    def test_swallows_connection_refused(self):
        """If ComfyUI is unreachable, interrupt must NOT raise."""
        fn = self._import_fn()
        # Port 1 is almost certainly not running ComfyUI
        fn("http://127.0.0.1:1", prompt_id="unreachable-prompt")

    def test_empty_prompt_id_skips_queue_delete(self):
        """Empty string prompt_id should skip the queue delete call."""
        fn = self._import_fn()
        fn(self.comfyui_url, prompt_id="")

        queue_reqs = [r for r in self.request_log.requests if r["path"] == "/queue"]
        self.assertEqual(len(queue_reqs), 0, "Empty prompt_id should skip /queue call")


if __name__ == "__main__":
    unittest.main()
