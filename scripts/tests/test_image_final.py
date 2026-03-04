"""Final test: verify both image models, update .env with the best one."""
import urllib.request, urllib.error, json, base64, os, time

KEY = ""
env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
for line in open(env_path):
    if line.startswith("GEMINI_API_KEY="):
        KEY = line.split("=", 1)[1].strip()
        break

print(f"Key: {KEY[:10]}...{KEY[-4:]}\n")

results = {}
for model in ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview"]:
    print(f"--- {model} ---")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent?key={KEY}"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": "A red circle on white background"}]}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        elapsed = time.time() - t0
        data = json.loads(resp.read().decode())
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        has_image = False
        for p in parts:
            if "inlineData" in p:
                raw = base64.b64decode(p["inlineData"]["data"])
                print(f"  IMAGE: {len(raw)} bytes in {elapsed:.1f}s  -> SUCCESS!")
                has_image = True
            elif "text" in p:
                print(f"  TEXT: {p['text'][:80]}")
        if not has_image:
            fr = data.get("candidates", [{}])[0].get("finishReason", "?")
            print(f"  No image. finishReason={fr}")
            results[model] = f"no-image ({fr})"
        else:
            results[model] = f"OK ({elapsed:.1f}s)"
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        try:
            msg = json.loads(e.read().decode()).get("error", {}).get("message", "")[:200]
        except Exception:
            msg = "?"
        print(f"  HTTP {e.code} in {elapsed:.1f}s: {msg}")
        results[model] = f"HTTP {e.code}"
    except Exception as ex:
        print(f"  ERROR: {ex}")
        results[model] = f"error"
    print()
    time.sleep(6)

print("=" * 50)
print("SUMMARY:")
for m, r in results.items():
    status = "OK" if r.startswith("OK") else "FAIL"
    print(f"  [{status}] {m}: {r}")
