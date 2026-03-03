#!/usr/bin/env python3
"""Test Gemini text rendering in images."""
import urllib.request, json, base64, os, time, sys

api_key = os.getenv("GEMINI_API_KEY", "").strip()
if not api_key:
    print("Missing GEMINI_API_KEY")
    sys.exit(1)
model = "gemini-3-pro-image-preview"
url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

prompt = (
    "Generate a photorealistic image of a supermarket aisle with gondola shelves "
    "full of branded products. The products should have READABLE TEXT on their labels "
    "and packaging: cereal boxes saying CORN FLAKES, CHEERIOS, cans of COCA COLA, "
    "bottles of PEPSI, boxes of OREO cookies, bags of DORITOS chips. "
    "The text on every product must be sharp, clear and legible. "
    "Bright supermarket fluorescent lighting, high quality, 8k detail, photorealistic."
)

payload = {
    "contents": [{"parts": [{"text": prompt}]}],
    "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")

print(f"Requesting image from {model}...")
t0 = time.time()
with urllib.request.urlopen(req, timeout=120) as response:
    result = json.loads(response.read().decode("utf-8"))

elapsed = time.time() - t0
print(f"Response in {elapsed:.1f}s")

candidates = result.get("candidates", [])
if candidates:
    parts = candidates[0].get("content", {}).get("parts", [])
    for i, part in enumerate(parts):
        if "inlineData" in part:
            img_data = base64.b64decode(part["inlineData"]["data"])
            mime = part["inlineData"].get("mimeType", "image/png")
            ext = "png" if "png" in mime else "jpg"
            path = f"c:/PROJECT/output/images/text_test_supermarket.{ext}"
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(img_data)
            print(f"Image saved: {path} ({len(img_data)//1024} KB)")
        elif "text" in part:
            txt = part["text"][:200]
            print(f"Text response: {txt}")
else:
    print("No candidates in response")
    print(json.dumps(result, indent=2)[:500])
