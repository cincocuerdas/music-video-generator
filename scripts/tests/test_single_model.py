"""Quick single-model test."""
import urllib.request, urllib.error, json, base64, os, time

KEY = ""
env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
for line in open(env_path):
    if line.startswith("GEMINI_API_KEY="):
        KEY = line.split("=", 1)[1].strip()
        break

model = "gemini-3-pro-image-preview"
print(f"Testing {model}...")
url = (
    f"https://generativelanguage.googleapis.com/v1beta/"
    f"models/{model}:generateContent?key={KEY}"
)
payload = json.dumps({
    "contents": [{"parts": [{"text": "A red circle"}]}],
    "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
}).encode()
req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
t0 = time.time()
try:
    resp = urllib.request.urlopen(req, timeout=120)
    elapsed = time.time() - t0
    data = json.loads(resp.read().decode())
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    for p in parts:
        if "inlineData" in p:
            raw = base64.b64decode(p["inlineData"]["data"])
            print(f"IMAGE: {len(raw)} bytes in {elapsed:.1f}s -> SUCCESS!")
        elif "text" in p:
            print(f"TEXT: {p['text'][:80]}")
    if not parts:
        fr = data.get("candidates", [{}])[0].get("finishReason", "?")
        print(f"No parts. finishReason={fr}")
except urllib.error.HTTPError as e:
    elapsed = time.time() - t0
    err = e.read().decode()
    try:
        msg = json.loads(err).get("error", {}).get("message", "")[:300]
    except Exception:
        msg = err[:300]
    print(f"HTTP {e.code} in {elapsed:.1f}s: {msg}")
except Exception as ex:
    print(f"ERROR: {ex}")
