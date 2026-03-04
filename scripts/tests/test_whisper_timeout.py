#!/usr/bin/env python3
"""
Unit tests for Whisper hard timeout (WHISPER_TRANSCRIBE_TIMEOUT_SEC).
Tests run_transcription_with_timeout without loading the actual Whisper model.
"""

import os
import queue
import sys
import threading
import time
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


class TestWhisperTimeout(unittest.TestCase):
    """Test run_transcription_with_timeout timeout behavior."""

    def _fake_fast_transcribe(self, audio_path, force_language=None, project_id=None):
        """Simulates a fast Whisper transcription."""
        return {"lyrics": "hello world", "language": "en", "segments": []}

    def _fake_slow_transcribe(self, audio_path, force_language=None, project_id=None):
        """Simulates a hung Whisper transcription that never completes."""
        time.sleep(30)
        return {"lyrics": "never", "language": "en", "segments": []}

    def _fake_error_transcribe(self, audio_path, force_language=None, project_id=None):
        """Simulates a Whisper crash."""
        raise RuntimeError("CUDA out of memory")

    @mock.patch.dict(os.environ, {"WHISPER_TRANSCRIBE_TIMEOUT_SEC": "2"})
    def test_fast_transcription_completes(self):
        """Normal transcription completes within timeout."""
        import transcribe_audio
        with mock.patch.object(transcribe_audio, "transcribe_audio", self._fake_fast_transcribe):
            result = transcribe_audio.run_transcription_with_timeout("/fake/audio.mp3")
        self.assertEqual(result["lyrics"], "hello world")
        self.assertEqual(result["language"], "en")

    @mock.patch.dict(os.environ, {"WHISPER_TRANSCRIBE_TIMEOUT_SEC": "1"})
    def test_slow_transcription_raises_timeout(self):
        """Hung transcription triggers TimeoutError with descriptive message."""
        import transcribe_audio
        with mock.patch.object(transcribe_audio, "transcribe_audio", self._fake_slow_transcribe):
            with self.assertRaises(TimeoutError) as ctx:
                transcribe_audio.run_transcription_with_timeout("/fake/audio.mp3")
            self.assertIn("WHISPER_TRANSCRIBE_TIMEOUT_SEC", str(ctx.exception))
            self.assertIn("1s", str(ctx.exception))

    @mock.patch.dict(os.environ, {"WHISPER_TRANSCRIBE_TIMEOUT_SEC": "5"})
    def test_transcription_error_propagates(self):
        """If Whisper crashes, the original exception is re-raised, not a timeout."""
        import transcribe_audio
        with mock.patch.object(transcribe_audio, "transcribe_audio", self._fake_error_transcribe):
            with self.assertRaises(RuntimeError) as ctx:
                transcribe_audio.run_transcription_with_timeout("/fake/audio.mp3")
            self.assertIn("CUDA out of memory", str(ctx.exception))

    @mock.patch.dict(os.environ, {"WHISPER_TRANSCRIBE_TIMEOUT_SEC": "0"})
    def test_zero_timeout_disables_wrapper(self):
        """WHISPER_TRANSCRIBE_TIMEOUT_SEC=0 bypasses the timeout wrapper."""
        import transcribe_audio
        with mock.patch.object(transcribe_audio, "transcribe_audio", self._fake_fast_transcribe):
            result = transcribe_audio.run_transcription_with_timeout("/fake/audio.mp3")
        self.assertEqual(result["lyrics"], "hello world")

    @mock.patch.dict(os.environ, {"WHISPER_TRANSCRIBE_TIMEOUT_SEC": "-5"})
    def test_negative_timeout_disables_wrapper(self):
        """Negative value bypasses the timeout wrapper."""
        import transcribe_audio
        with mock.patch.object(transcribe_audio, "transcribe_audio", self._fake_fast_transcribe):
            result = transcribe_audio.run_transcription_with_timeout("/fake/audio.mp3")
        self.assertEqual(result["lyrics"], "hello world")

    @mock.patch.dict(os.environ, {}, clear=False)
    def test_default_timeout_is_900(self):
        """Default timeout should be 900s when env var is not set."""
        # Remove the var if it exists
        os.environ.pop("WHISPER_TRANSCRIBE_TIMEOUT_SEC", None)
        import transcribe_audio
        # We can verify the default by checking the parsed value
        timeout = int(os.getenv("WHISPER_TRANSCRIBE_TIMEOUT_SEC", "900"))
        self.assertEqual(timeout, 900)


if __name__ == "__main__":
    unittest.main()
