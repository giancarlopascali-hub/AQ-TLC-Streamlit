"""Regression tests for the bounded AQ-TLC backend contract."""

from __future__ import annotations

import base64
import io

from PIL import Image
import pytest

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


def _solid_image_data_url(rgb: tuple[int, int, int]) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), color=rgb).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _green_band_image_data_url() -> str:
    image = Image.new("RGB", (64, 96), color=(0, 0, 0))
    for y in range(35, 45):
        for x in range(20, 44):
            image.putpixel((x, y), (0, 200, 0))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def test_rgb_window_changes_projection_and_full_rgb_ignores_it() -> None:
    image = _solid_image_data_url((0, 200, 0))
    red_only = tlc_backend.load_gray(image, 650, 0)
    red_with_window = tlc_backend.load_gray(image, 650, 50)
    assert red_only[0, 0] == 0
    assert red_with_window[0, 0] > 0
    assert red_with_window[0, 0] == tlc_backend.load_gray(image, 650, 50)[0, 0]
    assert (tlc_backend.load_gray(image, 650, None) == red_only).all()
    assert (tlc_backend.load_gray(image, None, 0) == tlc_backend.load_gray(image, None, 50)).all()


def test_rgb_window_rounds_to_integer_nm_and_rejects_invalid_values() -> None:
    assert tlc_backend.wavelength_window_to_rgb(650.5, 0.5) == tlc_backend.wavelength_window_to_rgb(651, 1)
    assert tlc_backend.wavelength_window_to_rgb(650, None) == tlc_backend.wavelength_window_to_rgb(650, 0)
    assert tlc_backend.wavelength_window_to_rgb(380, 50) != tlc_backend.wavelength_to_rgb(380)
    with pytest.raises(tlc_backend.InputValidationError):
        tlc_backend.wavelength_window_to_rgb(650, 51)


def test_rgb_window_reaches_profile_pipeline() -> None:
    payload = {
        "image": _green_band_image_data_url(),
        "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 24, "h": 80, "angle": 0}],
        "peak_detection": True,
        "peak_prominence": 10,
        "peak_distance": 3,
        "peak_threshold": 50,
        "smooth_sigma": 1,
        "polarity_mode": "bright",
        "target_wavelength": 650,
    }
    no_window = tlc_backend.generate_profiles({**payload, "wavelength_bandwidth": 0})["results"][0]
    wide_window = tlc_backend.generate_profiles({**payload, "wavelength_bandwidth": 50})["results"][0]
    assert max(no_window["profile_display"]) == 0
    assert max(wide_window["profile_display"]) > 0
    assert len(wide_window["peaks"]) > 0


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
        assert (peak["area_lb"], peak["area_rb"]) == (peak["display_lb"], peak["display_rb"])
        assert peak["area"] >= 0


def test_width_threshold_is_the_authoritative_integration_interval() -> None:
    import numpy as np

    signal = np.asarray([0, 5, 25, 100, 25, 5, 0], dtype=float)
    wide = tlc_backend._display_bounds(signal, 3, 0, 6, 0.20)
    narrow = tlc_backend._display_bounds(signal, 3, 0, 6, 0.60)
    assert wide == (1, 5)
    assert narrow == (2, 4)
    assert tlc_backend.calculate_peak_area(signal, *narrow) < tlc_backend.calculate_peak_area(signal, *wide)


def test_invalid_payload_is_a_safe_error() -> None:
    result = tlc_backend.generate_profiles({"image": "not-base64", "lanes": []})
    assert result["error_code"] == "INVALID_INPUT"
    assert "Traceback" not in result["error"]


def test_crop_rejects_empty_region() -> None:
    result = tlc_backend.crop_image(
        {"image": _image_data_url(), "x": 1000, "y": 1000, "w": 5, "h": 5, "angle": 0}
    )
    assert result["error_code"] == "INVALID_INPUT"
