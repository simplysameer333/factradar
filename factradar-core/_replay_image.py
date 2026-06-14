import base64
import json
import time

import httpx

IMG = r"C:\Users\samor\Downloads\WhatsApp Image 2026-06-12 at 22.41.36.jpeg"

with open(IMG, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

payload = {
    "message_id": "replay-test-1",
    "chat_id": "149838691840144@lid",
    "is_group": False,
    "type": "image",
    "text": None,
    "media_b64": b64,
    "mimetype": "image/jpeg",
    "timestamp": time.time(),
}

r = httpx.post("http://localhost:8000/ingest", json=payload, timeout=600)
print(r.status_code)
print(json.dumps(r.json(), indent=2)[:2000])
