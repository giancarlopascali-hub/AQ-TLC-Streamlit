"""The portable host must preserve the Streamlit desktop analysis contract."""

from __future__ import annotations

import base64
import http.client
import io
import json
import threading
import unittest

from PIL import Image

import tlc_backend
from windows_desktop.launcher import AppHandler, AppServer, response_for


def image_data_url() -> str:
    image = Image.new("RGB", (64, 96), color=(180, 180, 180))
    for y in range(30, 55):
        for x in range(20, 44):
            image.putpixel((x, y), (40, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class WindowsHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = AppServer(("127.0.0.1", 0), AppHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method: str, path: str, body: object = None, headers: dict | None = None):
        # The first profile request loads SciPy lazily, which can take several
        # seconds on a fresh Windows environment.
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=60)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        all_headers = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, body=payload, headers=all_headers)
        reply = connection.getresponse()
        data = reply.read()
        status = reply.status
        connection.close()
        return status, data

    def test_serves_desktop_interface(self) -> None:
        status, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"AQ-TLC v1.1", data)
        status, data = self.request("GET", "/modules/api.js")
        self.assertEqual(status, 200)
        self.assertIn(b"generate_profiles", data)
        status, data = self.request("GET", "/modules/image_filters.js")
        self.assertEqual(status, 200)
        self.assertIn(b"wavelengthWindowToRgb", data)

    def test_rejects_cross_origin_and_path_traversal(self) -> None:
        status, _ = self.request("GET", "/%2e%2e/tlc_backend.py")
        self.assertEqual(status, 404)
        status, _ = self.request("POST", "/api", body={}, headers={"Origin": "https://example.com"})
        self.assertEqual(status, 403)

    def test_profile_response_matches_original_backend(self) -> None:
        payload = {
            "image": image_data_url(),
            "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 24, "h": 80, "angle": 0}],
            "peak_detection": True,
            "peak_prominence": 10,
            "peak_distance": 3,
            "peak_threshold": 50,
            "smooth_sigma": 1.0,
            "polarity_mode": "dark",
            "target_wavelength": 650,
            "wavelength_bandwidth": 30,
        }
        message = {"protocol_version": 1, "action": "generate_profiles", "request_id": "profiles-1", "payload": payload}
        status, body = self.request("POST", "/api", body=message)
        response = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])
        self.assertEqual(response["request_id"], "profiles-1")
        self.assertEqual(response["data"], tlc_backend.generate_profiles(payload))

    def test_crop_and_validation_envelopes(self) -> None:
        payload = {"image": image_data_url(), "x": 10, "y": 10, "w": 30, "h": 40, "angle": 0}
        response = response_for({"protocol_version": 1, "action": "crop", "request_id": "crop-1", "payload": payload})
        self.assertTrue(response["ok"])
        self.assertEqual(response["data"], tlc_backend.crop_image(payload))
        invalid = response_for({"protocol_version": 2, "action": "crop", "request_id": "crop-2", "payload": payload})
        self.assertEqual(invalid["error"]["code"], "INVALID_PROTOCOL")
        unknown = response_for({"protocol_version": 1, "action": "erase_all", "request_id": "bad-1", "payload": {}})
        self.assertEqual(unknown["error"]["code"], "UNKNOWN_ACTION")


if __name__ == "__main__":
    unittest.main()
