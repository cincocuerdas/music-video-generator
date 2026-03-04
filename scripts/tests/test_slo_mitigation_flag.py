#!/usr/bin/env python3
"""
Unit tests for SLO mitigation flag behavior in generate_images.py.

Covers:
1) Redis flag parsing (`mvg:slo_mitigation`)
2) Early-failover forcing gemini -> pollinations
3) Early-failover preventing smart-routing to Gemini from base providers
"""

import os
import sys
import unittest
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


class _FakeRedisClient:
    def __init__(self, raw_payload):
        self._raw_payload = raw_payload
        self.closed = False

    def get(self, key):
        if key != "mvg:slo_mitigation":
            return None
        return self._raw_payload

    def close(self):
        self.closed = True


class TestSloMitigationFlag(unittest.TestCase):
    def setUp(self):
        import generate_images

        self.gi = generate_images
        self._runtime_before = self.gi.get_slo_mitigation_runtime()
        self.gi.set_slo_mitigation_runtime(
            {"active": False, "earlyFailover": False, "maxConcurrency": None, "reason": None}
        )

    def tearDown(self):
        self.gi.set_slo_mitigation_runtime(self._runtime_before)

    def test_read_slo_mitigation_flag_parses_payload(self):
        payload = (
            b'{"active": true, "earlyFailover": true, '
            b'"maxConcurrency": 1, "reason": "critical p95"}'
        )
        fake_client = _FakeRedisClient(payload)

        with mock.patch.object(self.gi, "REDIS_UTILS_AVAILABLE", True), mock.patch.object(
            self.gi, "create_redis_client", return_value=fake_client
        ):
            result = self.gi.read_slo_mitigation_flag()

        self.assertTrue(result["active"])
        self.assertTrue(result["earlyFailover"])
        self.assertEqual(result["maxConcurrency"], 1)
        self.assertEqual(result["reason"], "critical p95")
        self.assertTrue(fake_client.closed)

    def test_generate_scene_asset_forces_gemini_to_pollinations_when_mitigation_active(self):
        self.gi.set_slo_mitigation_runtime(
            {"active": True, "earlyFailover": True, "maxConcurrency": 1, "reason": "critical"}
        )

        with mock.patch.object(
            self.gi, "generate_with_pollinations", return_value="https://img/pollinations.png"
        ) as pollinations_mock, mock.patch.object(
            self.gi,
            "generate_with_gemini_image",
            side_effect=AssertionError("Gemini should not be called under early failover"),
        ):
            result = self.gi.generate_scene_asset(
                provider="gemini",
                prompt="group of people in action with visible text",
                visual_style="cinematic",
                api_token="",
                img_width=1280,
                img_height=720,
                scene_index=0,
                project_id="project-test",
                scene_verse_type="NARRATIVE",
                ai_optimization={},
            )

        self.assertEqual(result["usedProvider"], "pollinations")
        self.assertIsNone(result["sceneGenerationError"])
        self.assertTrue(pollinations_mock.called)

    def test_generate_scene_asset_blocks_smart_routing_to_gemini_when_mitigation_active(self):
        self.gi.set_slo_mitigation_runtime(
            {"active": True, "earlyFailover": True, "maxConcurrency": 1, "reason": "critical"}
        )

        with mock.patch.object(self.gi, "should_route_to_gemini", return_value=(True, "multi_person,text")), mock.patch.object(
            self.gi, "generate_with_pollinations", return_value="https://img/base-provider.png"
        ) as pollinations_mock, mock.patch.object(
            self.gi,
            "generate_with_gemini_image",
            side_effect=AssertionError("Gemini should not be called when mitigation blocks routing"),
        ):
            result = self.gi.generate_scene_asset(
                provider="pollinations",
                prompt="busy crowd with products and signs",
                visual_style="cinematic",
                api_token="",
                img_width=1280,
                img_height=720,
                scene_index=1,
                project_id="project-test",
                scene_verse_type="NARRATIVE",
                ai_optimization={},
            )

        self.assertEqual(result["usedProvider"], "pollinations")
        self.assertIsNone(result["sceneGenerationError"])
        self.assertTrue(pollinations_mock.called)


if __name__ == "__main__":
    unittest.main()

