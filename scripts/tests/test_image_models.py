"""Test image-specific Gemini models with current API key."""
import urllib.request, urllib.error, json, base64, os, sys, time

KEY = ""
env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        if line.startswith("GEMINI_API_KEY="):
            KEY = line.split("=", 1)[1].strip()
            break
if not KEY:
    print("No GEMINI_API_KEY"); sys.exit(1)

print(f"Key: {KEY[:10]}...{KEY[-4:]}\n")

IMAGE_MODELS = [
    "gemini-2.0-flash-exp-image-generation",
    "gemini-2.5-flash-image",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
]

for model in IMAGE_MODELS:
    print(f"--- {model} ---")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent?key={KEY}"
    )
    payload = {
        "contents": [
            {"parts": [{"text": "Generate an image of a red circle on white background"}]}
        ],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=90)
        data = json.loads(resp.read().decode())
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        for i, p in enumerate(parts):
            if "text" in p:
                print(f"  Part {i}: TEXT -> {p['text'][:100]}")
            elif "inlineData" in p:
                mime = p["inlineData"].get("mimeType", "?")
                raw = base64.b64decode(p["inlineData"]["data"])
                print(f"  Part {i}: IMAGE ({mime}, {len(raw)} bytes)  <<<< SUCCESS!")
                fname = os.path.join(
                    os.path.dirname(__file__),
                    f"test_img_{model.replace('-', '_').replace('.', '_')}.png",
                )
                with open(fname, "wb") as f:
                    f.write(raw)
                print(f"  -> Saved: {fname}")
        if not parts:
            # check for finish reason
            cand = data.get("candidates", [{}])[0]
            print(f"  No parts. finishReason={cand.get('finishReason', '?')}")
        print(f"  Total parts: {len(parts)}")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        try:
            ej = json.loads(err_body)
            msg = ej.get("error", {}).get("message", "")[:300]
            print(f"  HTTP {e.code}: {msg}")
        except Exception:
            print(f"  HTTP {e.code}: {err_body[:300]}")
    except Exception as ex:
        print(f"  ERROR: {ex}")
    print()
    time.sleep(5)

print("Done.")
