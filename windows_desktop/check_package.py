"""Smoke-check the actual packaged executable through its local HTTP API."""

from __future__ import annotations

import base64
import http.client
import io
import json
import sys
from urllib.parse import urlsplit

from PIL import Image


def request(port: int, method: str, path: str, data: object = None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    connection.request(method, path, body=body, headers={"Content-Type": "application/json"})
    reply = connection.getresponse()
    status, payload = reply.status, reply.read()
    connection.close()
    return status, payload


def main(url: str) -> None:
    port = urlsplit(url).port
    assert port is not None
    status, body = request(port, "GET", "/health")
    assert status == 200 and json.loads(body)["status"] == "ok"
    status, body = request(port, "GET", "/")
    assert status == 200 and b"AQ-TLC v1.1" in body
    assert b"fonts.googleapis.com" not in body  # offline staging
    status, body = request(port, "GET", "/modules/streamlit_bridge.js")
    assert status == 200 and b"fetch('/api'" in body
    status, body = request(port, "GET", "/modules/image_filters.js")
    assert status == 200 and b"wavelengthWindowToRgb" in body

    image = Image.new("RGB", (64, 96), color=(180, 180, 180))
    for y in range(30, 55):
        for x in range(20, 44):
            image.putpixel((x, y), (40, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    profiles = {
        "protocol_version": 1, "action": "generate_profiles", "request_id": "smoke-profile",
        "payload": {
            "image": image_url,
            "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 24, "h": 80, "angle": 0}],
            "peak_detection": True, "peak_prominence": 10, "peak_distance": 3,
            "peak_threshold": 50, "smooth_sigma": 1.0, "polarity_mode": "dark",
        },
    }
    status, body = request(port, "POST", "/api", profiles)
    data = json.loads(body)
    assert status == 200 and data["ok"] and len(data["data"]["results"][0]["profile_analysis"]) > 0, data

    crop = {
        "protocol_version": 1, "action": "crop", "request_id": "smoke-crop",
        "payload": {"image": image_url, "x": 10, "y": 10, "w": 30, "h": 40, "angle": 0},
    }
    status, body = request(port, "POST", "/api", crop)
    data = json.loads(body)
    assert status == 200 and data["ok"] and data["data"]["image"].startswith("data:image/jpeg;base64,"), data
    print("Packaged app served the interface and completed profile and crop analysis.")


if __name__ == "__main__":
    main(sys.argv[1])
