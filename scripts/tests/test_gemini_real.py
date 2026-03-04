#!/usr/bin/env python3
"""
Real test: try multiple Gemini image models to find which ones work on the current API key/tier.
Then run the actual generate_with_gemini function from generate_images.py.
"""
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

# Setup paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
SCRIPTS_DIR = os.path.dirname(SCRIPT_DIR)

# Load .env
env_path = os.path.join(PROJECT_ROOT, ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

# Ensure scripts/ is importable
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
BASE_URL = (os.getenv("GEMINI_API_BASE_URL") or "https://generativelanguage.googleapis.com").strip()
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output", "test_gemini")
os.makedirs(OUTPUT_DIR, exist_ok=True)

PROMPT = "A lone astronaut standing on a Mars-like red desert landscape, cinematic lighting, golden hour, photorealistic"

# Models to test: the configured one + alternatives with image generation support
MODELS_TO_TEST = [
    os.getenv("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview"),
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-exp-image-generation",
    "gemini-3.1-flash-image-preview",
]
# Deduplicate while preserving order
seen = set()
MODELS_TO_TEST = [m for m in MODELS_TO_TEST if not (m in seen or seen.add(m))]


def test_model_directly(model):
    """Call model directly and return result dict."""
    endpoint = f"{BASE_URL}/v1beta/models/{model}:generateContent?key={API_KEY}"
    payload = {
        "contents": [{"parts": [{"text": PROMPT}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
        elapsed = time.time() - start

        inline_data = None
        for candidate in data.get("candidates", []):
            content = candidate.get("content", {}) or {}
            for part in content.get("parts", []) or []:
                maybe = part.get("inlineData")
                if maybe and maybe.get("data"):
                    inline_data = maybe
                    break
            if inline_data:
                break

        if not inline_data:
            return {"model": model, "status": "no_image", "elapsed": elapsed, "error": "No inline image data"}

        image_bytes = base64.b64decode(inline_data["data"])
        mime = inline_data.get("mimeType", "image/png")
        ext = ".jpg" if ("jpeg" in mime or "jpg" in mime) else (".webp" if "webp" in mime else ".png")
        filepath = os.path.join(OUTPUT_DIR, f"{model.replace('/', '_')}_test{ext}")
        with open(filepath, "wb") as f:
            f.write(image_bytes)

        return {
            "model": model,
            "status": "ok",
            "elapsed": elapsed,
            "size_bytes": len(image_bytes),
            "size_kb": round(len(image_bytes) / 1024, 1),
            "mime": mime,
            "filepath": filepath,
        }

    except urllib.error.HTTPError as e:
        elapsed = time.time() - start
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"model": model, "status": f"http_{e.code}", "elapsed": elapsed, "error": body}
    except Exception as e:
        elapsed = time.time() - start
        return {"model": model, "status": "error", "elapsed": elapsed, "error": str(e)}


def main():
    print("=" * 65)
    print("  REAL TEST: Gemini Image Models (Nano Banana family)")
    print("=" * 65)
    print()

    if not API_KEY:
        print("ERROR: GEMINI_API_KEY not set")
        sys.exit(1)

    print(f"  API Key: {API_KEY[:10]}...{API_KEY[-4:]}")
    print(f"  Prompt : {PROMPT[:70]}...")
    print(f"  Models : {', '.join(MODELS_TO_TEST)}")
    print()

    results = []
    working_model = None

    for model in MODELS_TO_TEST:
        print(f"[TEST] {model}")
        result = test_model_directly(model)
        results.append(result)

        if result["status"] == "ok":
            print(f"  PASS: {result['size_kb']} KB, {result['mime']}, {result['elapsed']:.1f}s")
            print(f"  File: {result['filepath']}")
            if working_model is None:
                working_model = model
        else:
            print(f"  FAIL: {result['status']} ({result['elapsed']:.1f}s)")
            err_short = str(result.get("error", ""))[:120]
            print(f"  Detail: {err_short}")
        print()

        # Small delay between models to avoid triggering rate limits
        if model != MODELS_TO_TEST[-1]:
            time.sleep(2)

    # ── Summary ──────────────────────────────────────────────────
    print("=" * 65)
    print("  SUMMARY")
    print("-" * 65)
    for r in results:
        icon = "PASS" if r["status"] == "ok" else "FAIL"
        if r["status"] == "ok":
            detail = f"{r.get('size_kb', '-')} KB, {r['elapsed']:.1f}s"
        else:
            detail = r["status"]
        print(f"  [{icon}] {r['model']:45s} {detail}")
    print("-" * 65)

    if working_model:
        configured = os.getenv("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")
        print(f"\n  Working model found: {working_model}")
        if working_model != configured:
            print(f"  >>> RECOMMENDATION: Update GEMINI_IMAGE_MODEL in .env")
            print(f"  >>> Current : {configured}")
            print(f"  >>> Suggested: {working_model}")
    else:
        print("\n  NO WORKING IMAGE MODEL FOUND!")
        print("  Check your API key billing/quota at https://ai.google.dev/")

    # ── Test via generate_images.py function (if a model works) ──
    if working_model:
        print()
        print("=" * 65)
        print(f"  FUNCTIONAL TEST: generate_with_gemini() with {working_model}")
        print("=" * 65)
        print()

        os.environ["GEMINI_IMAGE_MODEL"] = working_model
        try:
            import generate_images
            generate_images._WORKFLOW_TEMPLATE_CACHE = None

            start = time.time()
            result_path = generate_images.generate_with_gemini(
                prompt=PROMPT,
                style="cinematic",
                width=1280,
                height=720,
                scene_index=99,
                project_id="smoke_test",
            )
            elapsed = time.time() - start
            file_size = os.path.getsize(result_path) if os.path.exists(result_path) else 0

            print(f"  PASS: generate_with_gemini() completed in {elapsed:.1f}s")
            print(f"  Output: {result_path}")
            print(f"  Size  : {file_size / 1024:.1f} KB")
            print(f"  429   : 0")
        except Exception as e:
            print(f"  FAIL: generate_with_gemini() raised {type(e).__name__}: {e}")

    print()
    sys.exit(0 if working_model else 1)


if __name__ == "__main__":
    main()
