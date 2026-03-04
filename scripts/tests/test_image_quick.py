"""Quick test: does Gemini image generation work with the current API key?"""
import urllib.request, urllib.error, json, base64, os, sys, time

KEY = os.environ.get("GEMINI_API_KEY", "")
if not KEY:
    # read from .env
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            if line.startswith("GEMINI_API_KEY="):
                KEY = line.split("=", 1)[1].strip()
                break
if not KEY:
    print("ERROR: No GEMINI_API_KEY found"); sys.exit(1)

print(f"Key: {KEY[:10]}...{KEY[-4:]}")
print()

MODELS = ["gemini-2.5-flash", "gemini-3-flash-preview"]

for model in MODELS:
    print(f"=== {model} : IMAGE generation ===")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent?key={KEY}"
    )
    payload = {
        "contents": [
            {"parts": [{"text": "Generate a simple image of a red circle on a white background"}]}
        ],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
        },
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=90)
        data = json.loads(resp.read().decode())
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        for i, p in enumerate(parts):
            if "text" in p:
                print(f"  Part {i}: TEXT -> {p['text'][:120]}")
            elif "inlineData" in p:
                mime = p["inlineData"].get("mimeType", "?")
                raw = base64.b64decode(p["inlineData"]["data"])
                print(f"  Part {i}: IMAGE ({mime}, {len(raw)} bytes)")
                fname = os.path.join(os.path.dirname(__file__), f"test_img_{model.replace('-','_')}.png")
                with open(fname, "wb") as f:
                    f.write(raw)
                print(f"  -> Saved to {fname}")
        print(f"  TOTAL PARTS: {len(parts)}")
        print(f"  >>> SUCCESS!")
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  FAIL: HTTP {e.code}")
        # extract useful info
        try:
            ej = json.loads(err)
            msg = ej.get("error", {}).get("message", "")
            print(f"  Message: {msg[:300]}")
        except Exception:
            print(f"  Raw: {err[:300]}")
    except Exception as ex:
        print(f"  ERROR: {ex}")
    print()
    time.sleep(5)

print("Done.")
