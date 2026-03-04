#!/usr/bin/env python3
"""
Unit tests for ComfyUI workflow template loading and schema validation.
Tests: load_comfyui_workflow_template, workflow node key integrity,
and fail-fast on missing/corrupt template files.
"""

import copy
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

# Ensure scripts/ is on sys.path so we can import generate_images helpers.
SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


# Required node IDs that the workflow manipulation code depends on.
# If any of these are missing from the template, image generation will crash at runtime.
REQUIRED_NODE_IDS = {"3", "4", "5", "6", "7", "8", "9"}

# Optional nodes that may be removed at runtime but must be present in the template.
OPTIONAL_NODE_IDS = {"10", "11", "12", "13", "14"}

# Nodes that must have an "inputs" key.
ALL_NODE_IDS = REQUIRED_NODE_IDS | OPTIONAL_NODE_IDS

WORKFLOW_TEMPLATE_PATH = os.path.join(SCRIPTS_DIR, "workflows", "comfyui_sdxl_base_workflow.json")


class TestWorkflowFileExists(unittest.TestCase):
    """Verify the workflow template file exists and is valid JSON."""

    def test_workflow_file_exists(self):
        self.assertTrue(
            os.path.isfile(WORKFLOW_TEMPLATE_PATH),
            f"Workflow template not found at {WORKFLOW_TEMPLATE_PATH}",
        )

    def test_workflow_is_valid_json(self):
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIsInstance(data, dict, "Workflow template must be a JSON object")

    def test_workflow_is_not_empty(self):
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertGreater(len(data), 0, "Workflow template must not be empty")


class TestWorkflowSchemaIntegrity(unittest.TestCase):
    """Validate that all required node keys and sub-keys exist in the template."""

    @classmethod
    def setUpClass(cls):
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            cls.workflow = json.load(f)

    def test_required_node_ids_present(self):
        for node_id in REQUIRED_NODE_IDS:
            self.assertIn(
                node_id, self.workflow,
                f"Required node '{node_id}' missing from workflow template",
            )

    def test_optional_node_ids_present(self):
        for node_id in OPTIONAL_NODE_IDS:
            self.assertIn(
                node_id, self.workflow,
                f"Optional node '{node_id}' missing from workflow template (needed at startup)",
            )

    def test_all_nodes_have_inputs(self):
        for node_id in ALL_NODE_IDS:
            node = self.workflow.get(node_id)
            if node is None:
                continue
            self.assertIn(
                "inputs", node,
                f"Node '{node_id}' missing 'inputs' key",
            )
            self.assertIsInstance(node["inputs"], dict, f"Node '{node_id}'.inputs must be a dict")

    def test_all_nodes_have_class_type(self):
        for node_id in ALL_NODE_IDS:
            node = self.workflow.get(node_id)
            if node is None:
                continue
            self.assertIn(
                "class_type", node,
                f"Node '{node_id}' missing 'class_type' key",
            )

    def test_ksampler_required_inputs(self):
        """Node 3 (KSampler) must have cfg, seed, steps, sampler_name."""
        inputs = self.workflow["3"]["inputs"]
        for key in ("cfg", "seed", "steps", "sampler_name", "model", "positive", "negative"):
            self.assertIn(key, inputs, f"KSampler node missing required input '{key}'")

    def test_checkpoint_loader_has_ckpt_name(self):
        """Node 4 (CheckpointLoaderSimple) must have ckpt_name."""
        self.assertIn("ckpt_name", self.workflow["4"]["inputs"])

    def test_empty_latent_has_dimensions(self):
        """Node 5 (EmptyLatentImage) must have width/height."""
        inputs = self.workflow["5"]["inputs"]
        self.assertIn("width", inputs)
        self.assertIn("height", inputs)

    def test_clip_text_encode_nodes(self):
        """Nodes 6 and 7 must have text and clip inputs."""
        for node_id in ("6", "7"):
            inputs = self.workflow[node_id]["inputs"]
            self.assertIn("text", inputs, f"CLIPTextEncode node {node_id} missing 'text'")
            self.assertIn("clip", inputs, f"CLIPTextEncode node {node_id} missing 'clip'")

    def test_save_image_node(self):
        """Node 9 must have filename_prefix and images."""
        inputs = self.workflow["9"]["inputs"]
        self.assertIn("filename_prefix", inputs)
        self.assertIn("images", inputs)

    def test_face_detailer_node(self):
        """Node 11 (FaceDetailer) must have guide_size, steps, cfg, denoise."""
        inputs = self.workflow["11"]["inputs"]
        for key in ("guide_size", "steps", "cfg", "denoise", "seed", "model", "clip"):
            self.assertIn(key, inputs, f"FaceDetailer node missing '{key}'")


class TestLoadComfyuiWorkflowTemplate(unittest.TestCase):
    """Test the load_comfyui_workflow_template function."""

    def test_returns_dict(self):
        import generate_images
        # Reset cache
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        result = generate_images.load_comfyui_workflow_template()
        self.assertIsInstance(result, dict)

    def test_returns_deep_copy(self):
        """Each call must return a deep copy so mutations don't affect the cache."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        result1 = generate_images.load_comfyui_workflow_template()
        result2 = generate_images.load_comfyui_workflow_template()
        # Mutate result1
        result1["3"]["inputs"]["cfg"] = 999
        # result2 must not be affected
        self.assertNotEqual(result2["3"]["inputs"]["cfg"], 999)

    def test_caches_after_first_load(self):
        """After first load, _WORKFLOW_TEMPLATE_CACHE should not be None."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        generate_images.load_comfyui_workflow_template()
        self.assertIsNotNone(generate_images._WORKFLOW_TEMPLATE_CACHE)

    def test_raises_on_missing_file(self):
        """If the template file doesn't exist, loading must raise."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        original_path = generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH
        try:
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = "/nonexistent/workflow.json"
            with self.assertRaises(FileNotFoundError):
                generate_images.load_comfyui_workflow_template()
        finally:
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = original_path
            generate_images._WORKFLOW_TEMPLATE_CACHE = None

    def test_raises_on_invalid_json(self):
        """If the template has invalid JSON, loading must raise."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        original_path = generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
                tmp.write("NOT_VALID_JSON{{{")
                tmp_path = tmp.name
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = tmp_path
            with self.assertRaises(json.JSONDecodeError):
                generate_images.load_comfyui_workflow_template()
        finally:
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = original_path
            generate_images._WORKFLOW_TEMPLATE_CACHE = None
            os.unlink(tmp_path)

    def test_raises_on_non_dict_json(self):
        """If the JSON is valid but not a dict, loading must raise ValueError."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        original_path = generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
                json.dump([1, 2, 3], tmp)
                tmp_path = tmp.name
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = tmp_path
            with self.assertRaises(ValueError):
                generate_images.load_comfyui_workflow_template()
        finally:
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = original_path
            generate_images._WORKFLOW_TEMPLATE_CACHE = None
            os.unlink(tmp_path)


class TestWorkflowSchemaValidation(unittest.TestCase):
    """Test _validate_workflow_schema fail-fast behavior."""

    def test_valid_template_has_no_issues(self):
        import generate_images
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            workflow = json.load(f)
        issues = generate_images._validate_workflow_schema(workflow)
        self.assertEqual(issues, [], f"Real template should be valid but got: {issues}")

    def test_missing_required_node_detected(self):
        import generate_images
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            workflow = json.load(f)
        del workflow["3"]  # Remove KSampler
        issues = generate_images._validate_workflow_schema(workflow)
        self.assertTrue(any("'3'" in i for i in issues), f"Should report node 3 missing: {issues}")

    def test_missing_input_key_detected(self):
        import generate_images
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            workflow = json.load(f)
        del workflow["4"]["inputs"]["ckpt_name"]
        issues = generate_images._validate_workflow_schema(workflow)
        self.assertTrue(
            any("ckpt_name" in i for i in issues),
            f"Should report ckpt_name missing: {issues}",
        )

    def test_missing_inputs_dict_detected(self):
        import generate_images
        with open(WORKFLOW_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            workflow = json.load(f)
        workflow["5"]["inputs"] = "not a dict"
        issues = generate_images._validate_workflow_schema(workflow)
        self.assertTrue(
            any("'5'" in i and "inputs" in i for i in issues),
            f"Should report node 5 inputs invalid: {issues}",
        )

    def test_loading_with_broken_schema_raises(self):
        """load_comfyui_workflow_template should raise ValueError for schema issues."""
        import generate_images
        generate_images._WORKFLOW_TEMPLATE_CACHE = None
        original_path = generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH
        try:
            # Create a minimal JSON that is a dict but missing required nodes
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
                json.dump({"99": {"class_type": "Dummy", "inputs": {}}}, tmp)
                tmp_path = tmp.name
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = tmp_path
            with self.assertRaises(ValueError) as ctx:
                generate_images.load_comfyui_workflow_template()
            self.assertIn("schema invalid", str(ctx.exception))
        finally:
            generate_images.COMFYUI_WORKFLOW_TEMPLATE_PATH = original_path
            generate_images._WORKFLOW_TEMPLATE_CACHE = None
            os.unlink(tmp_path)


if __name__ == "__main__":
    unittest.main()
