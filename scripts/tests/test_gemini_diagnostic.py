#!/usr/bin/env python3
"""
Diagnose Gemini API key: check text quota, image quota, and identify the root cause of 429s.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import re

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

# Load .env
env_path = os.path.join(PROJECT_ROOT, ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
BASE = "https://generativelanguage.googleapis.com"


def call_gemini(model, text, modalities=None, timeout=30):
    """Single call. Returns (ok, data_or_error)."""
    url = f"{BASE}/v1beta/models/{model}:generateContent?key={API_KEY}"
    config = {}
    if modalities:
        config["responseModalities"] = modalities
    body = {"contents": [{"parts": [{"text": text}]}]}
    if config:
        body["generationConfig"] = config
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(raw)
        except Exception:
            err = {"raw": raw[:500]}
        return False, {"code": e.code, "error": err}
    except Exception as e:
        return False, {"code": 0, "error": str(e)}


def extract_quota_info(error_data):
    """Extract limit and retry info from 429 error."""
    msg = error_data.get("error", {}).get("error", {}).get("message", "")
    if not msg:
        msg = error_data.get("error", {}).get("message", "")
    
    limits = re.findall(r"limit:\s*(\d+)", msg)
    retry = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
    return {
        "limits": [int(x) for x in limits],
        "retry_after": float(retry.group(1)) if retry else None,
        "has_limit_zero": "limit: 0" in msg,
        "message_preview": msg[:200],
    }


def main():
    print("=" * 65)
    print("  GEMINI API KEY DIAGNOSTIC")
    print("=" * 65)
    print()
    
    if not API_KEY:
        print("ERROR: No GEMINI_API_KEY in .env")
        sys.exit(1)
    
    print(f"  Key: {API_KEY[:12]}...{API_KEY[-4:]}")
    print()
    
    # Phase 1: text-only call (cheapest, most likely to succeed)
    print("[Phase 1] Text-only call (gemini-2.0-flash-lite)...")
    ok, data = call_gemini("gemini-2.0-flash-lite", "Say 'hello'. One word only.")
    if ok:
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        print(f"  PASS: Text generation works -> '{text.strip()[:50]}'")
        text_works = True
    else:
        code = data.get("code", 0)
        print(f"  FAIL: HTTP {code}")
        text_works = False
        if code == 429:
            qi = extract_quota_info(data)
            if qi["has_limit_zero"]:
                print("  >>> CRITICAL: limit=0 even for TEXT. This API key's project")
                print("  >>> has no free-tier quota at all. You need to:")
                print("  >>>   1. Go to https://aistudio.google.com/apikey")
                print("  >>>   2. Create a NEW API key from Google AI Studio")
                print("  >>>   3. Make sure to accept Terms of Service")
                print("  >>>   4. Update GEMINI_API_KEY in .env")
                sys.exit(1)
            elif qi["retry_after"]:
                wait = min(qi["retry_after"] + 5, 90)
                print(f"  Rate limited (temporary). Waiting {wait:.0f}s...")
                time.sleep(wait)
                # Retry
                ok2, data2 = call_gemini("gemini-2.0-flash-lite", "Say 'hello'. One word only.")
                if ok2:
                    print(f"  PASS (after wait): Text generation works")
                    text_works = True
                else:
                    print(f"  Still failing after wait. HTTP {data2.get('code', '?')}")
    
    print()
    
    # Phase 2: image call 
    if not text_works:
        print("[Phase 2] Skipping image test (text doesn't work)")
        print()
        print("  DIAGNOSIS: API key project is mis-configured or exhausted.")
        print("  ACTION: Generate a new key from https://aistudio.google.com/apikey")
        sys.exit(1)
    
    print("[Phase 2] Image generation (gemini-2.5-flash-image)...")
    time.sleep(3)  # Small gap
    ok, data = call_gemini(
        "gemini-2.5-flash-image",
        "Generate an image of a red apple on a white background",
        modalities=["TEXT", "IMAGE"],
        timeout=120,
    )
    if ok:
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        has_image = any(p.get("inlineData", {}).get("data") for p in parts)
        if has_image:
            print(f"  PASS: Image generation works!")
            # Save it
            for p in parts:
                if p.get("inlineData", {}).get("data"):
                    import base64
                    img = base64.b64decode(p["inlineData"]["data"])
                    out = os.path.join(PROJECT_ROOT, "output", "test_gemini", "diagnostic_image.png")
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    with open(out, "wb") as f:
                        f.write(img)
                    print(f"  Saved: {out} ({len(img)/1024:.1f} KB)")
                    break
        else:
            print(f"  PARTIAL: Got response but no image data")
    else:
        code = data.get("code", 0)
        print(f"  FAIL: HTTP {code}")
        if code == 429:
            qi = extract_quota_info(data)
            print(f"  limit=0: {qi['has_limit_zero']}")
            print(f"  Message: {qi['message_preview']}")
            if qi["has_limit_zero"]:
                print()
                print("  DIAGNOSIS:")
                print("  Text works but image quota = 0.")
                print("  This means the API key project needs image generation enabled.")
                print()
                print("  FIX:")
                print("  1. Go to https://aistudio.google.com/")
                print("  2. Try generating an image there manually first")
                print("     (this triggers TOS acceptance for image generation)")
                print("  3. Then re-run this diagnostic")
                print()
                print("  ALTERNATIVE: Create a new key at https://aistudio.google.com/apikey")
            elif qi["retry_after"]:
                wait = min(qi["retry_after"] + 5, 120)
                print(f"  Temporary rate limit. Retrying after {wait:.0f}s...")
                time.sleep(wait)
                ok2, data2 = call_gemini(
                    "gemini-2.5-flash-image",
                    "Generate an image of a red apple on a white background",
                    modalities=["TEXT", "IMAGE"],
                    timeout=120,
                )
                if ok2:
                    print(f"  PASS (after retry): Image generation works!")
                else:
                    print(f"  Still failing: HTTP {data2.get('code', '?')}")
        elif code == 400:
            print(f"  Model doesn't support image modality with this config")
    
    print()
    print("=" * 65)
    if text_works:
        print("  Text gen: OK | Image gen: check results above")
    else:
        print("  Text gen: FAIL | Image gen: FAIL")
    print("=" * 65)


if __name__ == "__main__":
    main()
