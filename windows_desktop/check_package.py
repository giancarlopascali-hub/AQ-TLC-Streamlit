"""Smoke-check the actual packaged executable through its local HTTP API."""

from __future__ import annotations

import base64
import http.client
import io
import json
import math
import sys
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent


def request(port: int, method: str, path: str, data: object = None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    connection.request(method, path, body=body, headers={"Content-Type": "application/json"})
    reply = connection.getresponse()
    status, payload = reply.status, reply.read()
    connection.close()
    return status, payload


def synthetic_doublet_image() -> str:
    """A single visible peak with a 2-component shoulder from backend tests."""
    image = Image.new("RGB", (24, 240))
    for y in range(240):
        x = 239 - y  # public analysis profile runs origin to front
        signal = 80 * math.exp(-0.5 * ((x - 100) / 12) ** 2)
        signal += 35 * math.exp(-0.5 * ((x - 132) / 12) ** 2)
        gray = int(max(0, min(255, 180 - signal)))
        for column in range(24):
            image.putpixel((column, y), (gray, gray, gray))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def main(url: str) -> None:
    port = urlsplit(url).port
    assert port is not None
    status, body = request(port, "GET", "/health")
    assert status == 200 and json.loads(body)["status"] == "ok"
    status, body = request(port, "GET", "/")
    assert status == 200 and b"AQ-TLC v1.3" in body
    assert b'id="shoulder-sensitivity"' in body
    assert b"fonts.googleapis.com" not in body  # offline staging
    status, body = request(port, "GET", "/modules/streamlit_bridge.js")
    assert status == 200 and b"fetch('/api'" in body
    status, body = request(port, "GET", "/modules/image_filters.js")
    assert status == 200 and b"wavelengthWindowToRgb" in body
    status, body = request(port, "GET", "/modules/shoulder.js")
    assert status == 200 and b"applyFitDecision" in body
    status, body = request(port, "GET", "/modules/api.js")
    assert status == 200 and b"shoulder_sensitivity" in body
    status, body = request(port, "GET", "/modules/analysis.js")
    assert status == 200 and body == (REPO_ROOT / "frontend" / "modules" / "analysis.js").read_bytes()
    assert b"buildAreaCalibrationModel" in body and b"zeroAmountConflict" in body
    status, body = request(port, "GET", "/modules/profiles.js")
    assert status == 200 and body == (REPO_ROOT / "frontend" / "modules" / "profiles.js").read_bytes()
    assert b"Interpolation from assumed zero point" in body
    status, body = request(port, "GET", "/guide.html")
    assert status == 200 and b"zero area means zero amount" in body

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
            "shoulder_sensitivity": 50, "fit_overrides": {},
        },
    }
    status, body = request(port, "POST", "/api", profiles)
    data = json.loads(body)
    assert status == 200 and data["ok"] and len(data["data"]["results"][0]["profile_analysis"]) > 0, data
    assert isinstance(data["data"]["results"][0]["fit_groups"], list), data

    doublet = {
        "image": synthetic_doublet_image(),
        "lanes": [{"id": 1, "cx": 12, "cy": 120, "w": 20, "h": 240, "angle": 0}],
        "peak_detection": True, "peak_prominence": 40, "peak_distance": 8,
        "peak_threshold": 50, "smooth_sigma": 1.5, "polarity_mode": "dark",
    }
    off_message = {
        "protocol_version": 1, "action": "generate_profiles", "request_id": "smoke-shoulder-off",
        "payload": {**doublet, "shoulder_sensitivity": 0},
    }
    status, body = request(port, "POST", "/api", off_message)
    off = json.loads(body)
    assert status == 200 and off["ok"], off
    ordinary_lane = off["data"]["results"][0]
    assert len(ordinary_lane["peaks"]) == 1 and ordinary_lane["fit_groups"] == [], ordinary_lane

    on_message = {
        **off_message, "request_id": "smoke-shoulder-on",
        "payload": {**doublet, "shoulder_sensitivity": 80},
    }
    status, body = request(port, "POST", "/api", on_message)
    on = json.loads(body)
    assert status == 200 and on["ok"], on
    fitted_lane = on["data"]["results"][0]
    assert len(fitted_lane["peaks"]) == 2, fitted_lane
    assert all(peak.get("area_method") == "deconvolved" for peak in fitted_lane["peaks"]), fitted_lane
    group = fitted_lane["fit_groups"][0]
    assert group["status"] == "resolved" and group["active"], group
    allocated = sum(peak["area"] for peak in fitted_lane["peaks"])
    measured = group["measured_cluster_area"]
    assert abs(allocated - measured) < 0.001, (allocated, measured)
    assert abs(sum(segment["area"] for segment in group["integration_segments"]) - measured) < 0.001

    crop = {
        "protocol_version": 1, "action": "crop", "request_id": "smoke-crop",
        "payload": {"image": image_url, "x": 10, "y": 10, "w": 30, "h": 40, "angle": 0},
    }
    status, body = request(port, "POST", "/api", crop)
    data = json.loads(body)
    assert status == 200 and data["ok"] and data["data"]["image"].startswith("data:image/jpeg;base64,"), data
    print("Packaged app served v1.3 calibration source and completed profile, shoulder split, area conservation, and crop checks.")


if __name__ == "__main__":
    main(sys.argv[1])
