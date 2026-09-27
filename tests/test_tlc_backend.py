"""Regression tests for the bounded AQ-TLC backend contract."""

from __future__ import annotations

import base64
import io

from PIL import Image

import tlc_backend


def _image_data_url() -> str:
    image = Image.new("RGB", (64, 96), color=(180, 180, 180))
    # Add a vertical darker band so profile generation exercises real data.
    for y in range(30, 55):
        for x in range(20, 44):
            image.putpixel((x, y), (40, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def test_peak_area_matches_trapezoid_contract() -> None:
    assert tlc_backend.calculate_peak_area([0, 1, 2, 1, 0], 0, 4) == 4.0
    assert tlc_backend.calculate_peak_area([0, 1, 2, 1, 0], 3, 1) == 0.0


def test_profile_response_has_explicit_analysis_contract() -> None:
    result = tlc_backend.generate_profiles(
        {
            "image": _image_data_url(),
            "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 24, "h": 80, "angle": 0}],
            "peak_detection": True,
            "peak_prominence": 10,
            "peak_distance": 3,
            "peak_threshold": 50,
            "smooth_sigma": 1.0,
            "polarity_mode": "dark",
        }
    )
    assert "error" not in result
    lane = result["results"][0]
    assert result["profile_direction"] == "origin_to_front"
    assert result["analysis_signal"] == "normalized_0_to_100"
    assert len(lane["profile_display"]) == len(lane["profile_analysis"])
    assert all(0 <= value <= 100 for value in lane["profile_analysis"])
    for peak in lane["peaks"]:
        assert peak["area_lb"] <= peak["display_lb"] <= peak["display_rb"] <= peak["area_rb"]
        assert peak["area"] >= 0


def test_invalid_payload_is_a_safe_error() -> None:
    result = tlc_backend.generate_profiles({"image": "not-base64", "lanes": []})
    assert result["error_code"] == "INVALID_INPUT"
    assert "Traceback" not in result["error"]


def test_crop_rejects_empty_region() -> None:
    result = tlc_backend.crop_image(
        {"image": _image_data_url(), "x": 1000, "y": 1000, "w": 5, "h": 5, "angle": 0}
    )
    assert result["error_code"] == "INVALID_INPUT"
