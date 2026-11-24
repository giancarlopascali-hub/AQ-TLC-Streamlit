"""Regression tests for the bounded AQ-TLC backend contract."""

from __future__ import annotations

import base64
import io
import math

import cv2
import numpy as np
from PIL import Image
import pytest
from scipy.signal import find_peaks

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


def _array_image_data_url(rgb: np.ndarray) -> str:
    buffer = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@pytest.mark.parametrize(
    ("angle", "rotation", "external_centre"),
    [
        (-math.pi / 2, Image.Transpose.ROTATE_270, (29, 50)),
        (-3 * math.pi / 2, Image.Transpose.ROTATE_90, (30, 49)),
    ],
)
def test_rotated_lane_matches_physically_rotated_plate(angle, rotation, external_centre) -> None:
    source = np.full((60, 100, 3), 180, dtype=np.uint8)
    source[25:35, 18:27] = 35
    source[25:35, 61:70] = 65
    rotated = np.asarray(Image.fromarray(source, mode="RGB").transpose(rotation))
    settings = {
        "peak_detection": True, "peak_prominence": 50, "peak_distance": 4,
        "peak_threshold": 50, "smooth_sigma": 0, "polarity_mode": "dark",
    }
    in_app = tlc_backend.generate_profiles({
        **settings, "image": _array_image_data_url(source),
        "lanes": [{"id": 1, "cx": 50, "cy": 30, "w": 10, "h": 80, "angle": angle}],
    })
    external = tlc_backend.generate_profiles({
        **settings, "image": _array_image_data_url(rotated),
        "lanes": [{"id": 1, "cx": external_centre[0], "cy": external_centre[1],
                   "w": 10, "h": 80, "angle": 0}],
    })
    assert "error" not in in_app
    assert "error" not in external
    in_app_lane, external_lane = in_app["results"][0], external["results"][0]
    assert len(in_app_lane["profile_display"]) == 80
    assert in_app_lane["profile_display"] == external_lane["profile_display"]
    assert in_app_lane["profile_analysis"] == external_lane["profile_analysis"]
    assert [(peak["idx"], peak["rf"]) for peak in in_app_lane["peaks"]] == [
        (peak["idx"], peak["rf"]) for peak in external_lane["peaks"]
    ]


def test_rotated_lane_clips_at_source_edge_without_wrapping() -> None:
    image = np.arange(60 * 100, dtype=np.uint8).reshape(60, 100)
    lane = {"cx": 50, "cy": 0, "w": 10, "h": 80, "angle": -math.pi / 2}
    roi = tlc_backend._extract_lane_roi(image, lane)
    physically_rotated = np.asarray(Image.fromarray(image).transpose(Image.Transpose.ROTATE_270))
    assert roi.shape == (80, 6)
    assert np.array_equal(roi, physically_rotated[10:90, 54:60])


def test_unrotated_lane_retains_original_slice_and_dimension_limits() -> None:
    image = np.arange(60 * 100, dtype=np.uint8).reshape(60, 100)
    lane = {"cx": 50, "cy": 30, "w": 10, "h": 40, "angle": 0}
    assert np.array_equal(tlc_backend._extract_lane_roi(image, lane), image[10:50, 45:55])
    assert len(tlc_backend._validated_lanes([{**lane, "h": 80, "angle": -math.pi / 2}], 100, 60)) == 1
    with pytest.raises(tlc_backend.InputValidationError):
        tlc_backend._validated_lanes([{**lane, "h": 80}], 100, 60)
    with pytest.raises(tlc_backend.InputValidationError):
        tlc_backend._validated_lanes([{**lane, "h": 101, "angle": -math.pi / 2}], 100, 60)


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


def test_lane_width_changes_the_sampled_profile() -> None:
    image = Image.new("RGB", (64, 96), color=(180, 180, 180))
    for y in range(25, 35):
        for x in range(29, 35):
            image.putpixel((x, y), (40, 40, 40))
    for y in range(55, 65):
        for x in range(17, 23):
            image.putpixel((x, y), (40, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    payload = {
        "image": data_url,
        "peak_detection": False,
        "polarity_mode": "dark",
        "smooth_sigma": 1,
    }
    narrow = tlc_backend.generate_profiles({
        **payload,
        "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 8, "h": 80, "angle": 0}],
    })["results"][0]
    wide = tlc_backend.generate_profiles({
        **payload,
        "lanes": [{"id": 1, "cx": 32, "cy": 48, "w": 40, "h": 80, "angle": 0}],
    })["results"][0]
    assert narrow["profile_analysis"] != wide["profile_analysis"]
    assert max(wide["profile_analysis"][20:35]) > max(narrow["profile_analysis"][20:35])


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


def _synthetic_plate(signal: np.ndarray) -> str:
    """Encode a row-uniform image whose dark profile reads origin to front."""
    gray = np.clip(180 - signal[::-1], 0, 255).astype(np.uint8)
    rgb = np.repeat(np.repeat(gray[:, None, None], 24, axis=1), 3, axis=2)
    buffer = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _shoulder_payload(signal: np.ndarray) -> dict:
    return {
        "image": _synthetic_plate(signal),
        "lanes": [{"id": 1, "cx": 12, "cy": 120, "w": 20, "h": 240, "angle": 0}],
        "peak_detection": True,
        "peak_prominence": 40,
        "peak_distance": 8,
        "peak_threshold": 50,
        "smooth_sigma": 1.5,
        "polarity_mode": "dark",
    }


def _direct_shoulder_fit(
    raw: np.ndarray, sensitivity: float = 80, max_peak_asymmetry: float = 5,
    default_asymmetry: bool = True,
):
    signal = (raw - raw.min()) / (raw.max() - raw.min()) * 100
    indices, properties = find_peaks(signal, prominence=41, distance=8)
    assert len(indices) == 1
    apex = int(indices[0])
    base_lb, base_rb = int(properties["left_bases"][0]), int(properties["right_bases"][0])
    left, right = tlc_backend._display_bounds(signal, apex, base_lb, base_rb, 0.5)
    ordinary = {
        "idx": apex,
        "rf": tlc_backend.calculate_rf(apex, len(signal)),
        "height_display": float(raw[apex]),
        "area": tlc_backend.calculate_peak_area(signal, left, right),
        "area_lb": left,
        "area_rb": right,
    }
    return tlc_backend._fit_shoulder_group(
        signal, raw, apex, base_lb, base_rb, 0.5, sensitivity, max_peak_asymmetry,
        f"1:{apex}", ordinary, [], None, default_asymmetry=default_asymmetry,
    )


def test_shoulder_fit_resolves_hidden_peak_and_conserves_width_controlled_area() -> None:
    x = np.arange(240, dtype=float)
    raw = 80 * np.exp(-0.5 * ((x - 100) / 12) ** 2) + 35 * np.exp(-0.5 * ((x - 132) / 12) ** 2)
    payload = _shoulder_payload(raw)
    ordinary = tlc_backend.generate_profiles(payload)["results"][0]
    disabled = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 0})["results"][0]
    assert ordinary == disabled  # zero keeps the pre-feature numerical path
    disabled_constrained = tlc_backend.generate_profiles({
        **payload, "shoulder_sensitivity": 0,
        "default_asymmetry": False, "max_peak_asymmetry": 1,
    })["results"][0]
    assert disabled_constrained == ordinary
    assert len(ordinary["peaks"]) == 1
    assert ordinary["fit_groups"] == []

    lane = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 80})["results"][0]
    explicit_default = tlc_backend.generate_profiles({
        **payload, "shoulder_sensitivity": 80,
        "default_asymmetry": True, "max_peak_asymmetry": 5,
    })["results"][0]
    assert explicit_default == lane  # checked mode ignores the hidden R setting
    assert len(lane["peaks"]) == 2
    group = lane["fit_groups"][0]
    assert (group["status"], group["recommendation"], group["decision"], group["active"]) == (
        "resolved", "split", "split", True,
    )
    assert group["area_basis"] == "component_threshold_union"
    assert group["width_threshold"] == 50
    assert [peak["area_method"] for peak in lane["peaks"]] == ["deconvolved", "deconvolved"]
    assert "max_fitted_asymmetry" not in group["quality"]  # original fit output
    assert [peak["idx"] for peak in lane["peaks"]] == pytest.approx([100, 132], abs=3)
    assert [component["center_idx"] for component in group["components"]] == pytest.approx([100, 132], abs=3)
    assert group["split_peaks"] == lane["peaks"]
    assert sum(segment["area"] for segment in group["integration_segments"]) == pytest.approx(group["measured_cluster_area"], abs=1e-4)
    assert sum(peak["area"] for peak in lane["peaks"]) == pytest.approx(group["measured_cluster_area"], abs=1e-4)
    assert all(segment["rb"] < following["lb"] for segment, following in zip(
        group["integration_segments"], group["integration_segments"][1:],
    ))
    for segment in group["integration_segments"]:
        assert segment["area"] == pytest.approx(tlc_backend.calculate_peak_area(
            lane["profile_analysis"], segment["lb"], segment["rb"],
        ), abs=1e-4)
    fit_length = group["bounds"]["rb"] - group["bounds"]["lb"] + 1
    assert all(len(curve) == fit_length for curve in (
        group["baseline_curve"], group["single_curve"], group["double_curve"],
        *(component["curve"] for component in group["components"]),
    ))
    for peak in lane["peaks"]:
        assert peak["height_display"] == pytest.approx(lane["profile_display"][peak["idx"]], abs=0.01)

    wide = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 80, "peak_threshold": 20})["results"][0]
    narrow = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 80, "peak_threshold": 80})["results"][0]
    assert wide["fit_groups"][0]["measured_cluster_area"] > narrow["fit_groups"][0]["measured_cluster_area"]
    assert len(narrow["fit_groups"][0]["integration_segments"]) == 2
    very_narrow = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 80, "peak_threshold": 95})["results"][0]
    narrow_group = very_narrow["fit_groups"][0]
    assert len(narrow_group["integration_segments"]) == 2
    outer = narrow_group["integration_bounds"]
    assert narrow_group["measured_cluster_area"] < 0.2 * tlc_backend.calculate_peak_area(
        very_narrow["profile_analysis"], outer["lb"], outer["rb"],
    )  # the gap is not counted merely because it lies between components


def test_peak_asymmetry_limit_prefers_a_close_fit_and_keeps_a_poor_one_unresolved() -> None:
    x = np.arange(240, dtype=float)
    raw = 80 * np.exp(-0.5 * ((x - 100) / 12) ** 2) + 35 * np.exp(-0.5 * ((x - 132) / 12) ** 2)

    # An undistorted symmetric doublet remains resolvable at the strict default.
    direct_group, direct_peaks = _direct_shoulder_fit(
        raw, max_peak_asymmetry=1, default_asymmetry=False,
    )
    assert direct_peaks is not None and len(direct_peaks) == 2
    assert direct_group["quality"]["max_fitted_asymmetry"] == pytest.approx(1)

    # Image extraction changes this profile enough that exact symmetry is a
    # materially worse explanation; it must not be forced into a split.
    payload = _shoulder_payload(raw)
    strict = tlc_backend.generate_profiles({
        **payload, "shoulder_sensitivity": 80,
        "default_asymmetry": False, "max_peak_asymmetry": 1,
    })["results"][0]
    strict_group = strict["fit_groups"][0]
    assert len(strict["peaks"]) == 1
    assert strict_group["status"] == "unresolved"
    assert strict_group["quality"]["max_peak_asymmetry"] == 1
    assert strict_group["quality"]["max_fitted_asymmetry"] == pytest.approx(1)
    assert strict_group["quality"]["fit_loss_pct"] > 5

    relaxed = tlc_backend.generate_profiles({
        **payload, "shoulder_sensitivity": 80,
        "default_asymmetry": False, "max_peak_asymmetry": 1.5,
    })["results"][0]
    relaxed_group = relaxed["fit_groups"][0]
    assert len(relaxed["peaks"]) == 2
    assert relaxed_group["status"] == "resolved"
    assert relaxed_group["quality"]["max_fitted_asymmetry"] <= 1.5
    assert relaxed_group["quality"]["fit_loss_pct"] <= 5
    assert sum(peak["area"] for peak in relaxed["peaks"]) == pytest.approx(
        relaxed_group["measured_cluster_area"], abs=1e-4,
    )


def test_peak_asymmetry_range_is_validated() -> None:
    payload = {"image": _image_data_url(), "lanes": []}
    for ratio in (0.9, 5.1, float("nan")):
        result = tlc_backend.generate_profiles({**payload, "max_peak_asymmetry": ratio})
        assert result["error_code"] == "INVALID_INPUT"
    for invalid in ("false", 0, None):
        result = tlc_backend.generate_profiles({**payload, "default_asymmetry": invalid})
        assert result["error_code"] == "INVALID_INPUT"


def test_shoulder_keep_override_preserves_original_peak_and_offers_local_split() -> None:
    x = np.arange(240, dtype=float)
    raw = 80 * np.exp(-0.5 * ((x - 100) / 12) ** 2) + 35 * np.exp(-0.5 * ((x - 132) / 12) ** 2)
    payload = _shoulder_payload(raw)
    split = tlc_backend.generate_profiles({**payload, "shoulder_sensitivity": 80, "max_peak_asymmetry": 5})["results"][0]
    group_id = split["fit_groups"][0]["id"]
    kept = tlc_backend.generate_profiles({
        **payload, "shoulder_sensitivity": 80, "max_peak_asymmetry": 5,
        "fit_overrides": {group_id: "keep"},
    })["results"][0]
    assert len(kept["peaks"]) == 1
    group = kept["fit_groups"][0]
    assert group["decision"] == "keep" and group["active"] is False
    assert kept["peaks"][0] == group["original_peak"]
    assert group["split_peaks"] == split["peaks"]


def test_weak_shoulder_skewed_tail_and_flat_top_do_not_split() -> None:
    x = np.arange(240, dtype=float)
    weak = 80 * np.exp(-0.5 * ((x - 100) / 12) ** 2) + 8 * np.exp(-0.5 * ((x - 132) / 12) ** 2)
    weak_group, weak_peaks = _direct_shoulder_fit(weak)
    assert weak_peaks is None
    assert weak_group is None or weak_group["status"] == "unresolved"

    rng = np.random.default_rng(3)
    asymmetric = 80 * np.exp(-0.5 * ((x - 100) / np.where(x < 100, 10, 22)) ** 2)
    tail = asymmetric + np.where(x > 100, 5 * np.exp(-(x - 100) / 35), 0)
    tail += rng.normal(0, 0.3, len(x))
    tail_group, tail_peaks = _direct_shoulder_fit(tail)
    assert tail_peaks is None
    assert tail_group is None or tail_group["status"] == "unresolved"

    saturated = np.minimum(80 * np.exp(-0.5 * ((x - 100) / 12) ** 2)
                           + 35 * np.exp(-0.5 * ((x - 132) / 12) ** 2), 64)
    saturated_group, saturated_peaks = _direct_shoulder_fit(saturated)
    assert saturated_peaks is None
    assert saturated_group is None or saturated_group["status"] == "unresolved"


def test_blank_or_remote_noise_cannot_become_a_shoulder() -> None:
    rng = np.random.default_rng(7)
    raw_noise = rng.normal(0, 1, 240)
    lane = tlc_backend.generate_profiles({
        **_shoulder_payload(raw_noise), "shoulder_sensitivity": 100, "peak_prominence": 80,
    })["results"][0]
    assert lane["fit_groups"] == []
    assert all(peak.get("area_method") != "deconvolved" for peak in lane["peaks"])

    x = np.arange(240, dtype=float)
    remote = 8 * np.exp(-0.5 * ((x - 50) / 8) ** 2) + 2 * np.exp(-0.5 * ((x - 170) / 5) ** 2)
    analysis = remote / remote.max() * 100
    apex = 170
    ordinary = {"idx": apex, "height_display": float(remote[apex]), "area": 1, "area_lb": 160, "area_rb": 180}
    group, replacement = tlc_backend._fit_shoulder_group(
        analysis, remote, apex, 155, 185, 0.5, 100, 1.0, "1:170", ordinary, [], None,
    )
    assert group is None and replacement is None


def test_fit_overrides_reject_non_text_choices_safely() -> None:
    result = tlc_backend.generate_profiles({
        "image": _image_data_url(), "lanes": [], "fit_overrides": {"1:100": []},
    })
    assert result["error_code"] == "INVALID_INPUT"


def test_crop_rejects_empty_region() -> None:
    result = tlc_backend.crop_image(
        {"image": _image_data_url(), "x": 1000, "y": 1000, "w": 5, "h": 5, "angle": 0}
    )
    assert result["error_code"] == "INVALID_INPUT"


@pytest.mark.parametrize(
    ("angle", "quarter_turns"),
    [(0, 0), (math.pi / 2, 3), (math.pi, 2), (3 * math.pi / 2, 1), (-math.pi / 2, 1)],
)
def test_crop_rotates_selected_source_pixels_without_clipping(angle, quarter_turns) -> None:
    source = np.arange(60 * 100 * 3, dtype=np.uint8).reshape(60, 100, 3)
    image_url = _array_image_data_url(source)
    result = tlc_backend.crop_image({
        "image": image_url, "x": 10, "y": 20, "w": 50, "h": 20, "angle": angle,
    })
    assert "error" not in result
    source_bgr = tlc_backend.load_image(image_url)
    expected = np.ascontiguousarray(np.rot90(source_bgr[20:40, 10:60], k=quarter_turns))
    encoded, jpeg = cv2.imencode(".jpg", expected, [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert encoded
    assert base64.b64decode(result["image"].split(",", 1)[1]) == jpeg.tobytes()
    actual = tlc_backend.load_image(result["image"])
    assert actual.shape[:2] == expected.shape[:2]


def test_crop_negative_drag_direction_and_arbitrary_rotation_expand_bounds() -> None:
    source = np.full((60, 100, 3), 180, dtype=np.uint8)
    source[23:37, 18:52] = (20, 60, 100)
    image_url = _array_image_data_url(source)
    normal = tlc_backend.crop_image({
        "image": image_url, "x": 10, "y": 20, "w": 50, "h": 20, "angle": math.pi / 2,
    })
    reversed_drag = tlc_backend.crop_image({
        "image": image_url, "x": 60, "y": 40, "w": -50, "h": -20, "angle": math.pi / 2,
    })
    assert normal["image"] == reversed_drag["image"]

    diagonal = tlc_backend.crop_image({
        "image": image_url, "x": 10, "y": 20, "w": 50, "h": 20, "angle": math.pi / 4,
    })
    assert "error" not in diagonal
    assert tlc_backend.load_image(diagonal["image"]).shape[:2] == (50, 50)
