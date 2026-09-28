"""Pure, bounded image-processing functions for the AQ-TLC Streamlit host."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import math
import traceback
from collections import OrderedDict
from typing import Any

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

# NumPy 2 compatibility. Keep the implementation in one place so automated
# and manual integrations can be compared against the same definition.
_trapz = getattr(np, "trapezoid", getattr(np, "trapz", None))

MAX_ENCODED_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 12_000_000
MAX_LANES = 64
MAX_CACHE_ENTRIES = 32
MAX_CACHE_BYTES = 64 * 1024 * 1024

_cache: OrderedDict[str, np.ndarray] = OrderedDict()
_cache_bytes = 0


class InputValidationError(ValueError):
    """A safe, user-actionable request validation failure."""


def _cache_put(key: str, value: np.ndarray) -> None:
    """Insert an array into a small byte-bounded LRU cache."""
    global _cache_bytes
    size = int(value.nbytes)
    if size > MAX_CACHE_BYTES:
        return
    if key in _cache:
        _cache_bytes -= int(_cache.pop(key).nbytes)
    _cache[key] = value
    _cache_bytes += size
    while _cache and (len(_cache) > MAX_CACHE_ENTRIES or _cache_bytes > MAX_CACHE_BYTES):
        _, evicted = _cache.popitem(last=False)
        _cache_bytes -= int(evicted.nbytes)


def _cache_get(key: str) -> np.ndarray | None:
    value = _cache.get(key)
    if value is not None:
        _cache.move_to_end(key)
    return value


def _decode_data_url(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise InputValidationError("An image is required.")
    encoded = value.split(",", 1)[-1]
    if len(encoded) > (MAX_ENCODED_IMAGE_BYTES * 4 // 3) + 8:
        raise InputValidationError("The selected image is too large.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InputValidationError("The selected image is not valid base64 data.") from exc
    if not raw or len(raw) > MAX_ENCODED_IMAGE_BYTES:
        raise InputValidationError("The selected image is too large or empty.")
    return raw


def load_image(b64str: str) -> np.ndarray:
    """Decode a bounded data URL to a uint8 BGR image, using an LRU cache."""
    key = hashlib.sha256(b64str.encode("utf-8")).hexdigest() + "_color"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    raw = _decode_data_url(b64str)
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(raw)) as source:
            width, height = source.size
            if width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise InputValidationError("Image dimensions exceed the supported limit.")
            if width * height > MAX_IMAGE_PIXELS:
                raise InputValidationError("Image resolution exceeds the supported limit.")
            source.load()
            rgb = np.array(source.convert("RGB"))
    except InputValidationError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise InputValidationError("The selected image could not be decoded.") from exc

    value = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    _cache_put(key, value)
    return value


def wavelength_to_rgb(wavelength: float) -> tuple[float, float, float]:
    """Approximate RGB-channel weights for a visible-light wavelength label."""
    if 380 <= wavelength < 440:
        r, g, b = -(wavelength - 440) / 60, 0.0, 1.0
    elif 440 <= wavelength < 490:
        r, g, b = 0.0, (wavelength - 440) / 50, 1.0
    elif 490 <= wavelength < 510:
        r, g, b = 0.0, 1.0, -(wavelength - 510) / 20
    elif 510 <= wavelength < 580:
        r, g, b = (wavelength - 510) / 70, 1.0, 0.0
    elif 580 <= wavelength < 645:
        r, g, b = 1.0, -(wavelength - 645) / 65, 0.0
    elif 645 <= wavelength <= 750:
        r, g, b = 1.0, 0.0, 0.0
    else:
        r = g = b = 0.0

    if 380 <= wavelength < 420:
        factor = 0.3 + 0.7 * (wavelength - 380) / 40
    elif 420 <= wavelength <= 700:
        factor = 1.0
    elif 700 < wavelength <= 750:
        factor = 0.3 + 0.7 * (750 - wavelength) / 50
    else:
        factor = 0.0
    return r * factor, g * factor, b * factor


def load_gray(b64str: str, target_wavelength: Any = None) -> np.ndarray:
    """Load grayscale or a clearly-labelled RGB-channel projection."""
    source_key = hashlib.sha256(b64str.encode("utf-8")).hexdigest()
    if target_wavelength is not None and str(target_wavelength).strip().lower() not in {"", "full", "none", "null"}:
        try:
            wavelength = float(target_wavelength)
        except (TypeError, ValueError) as exc:
            raise InputValidationError("RGB projection wavelength must be numeric.") from exc
        if not 380 <= wavelength <= 750:
            raise InputValidationError("RGB projection wavelength must be between 380 and 750 nm.")
        key = f"{source_key}_gray_wl_{wavelength:.1f}"
        cached = _cache_get(key)
        if cached is not None:
            return cached
        color = load_image(b64str)
        r, g, b = wavelength_to_rgb(wavelength)
        total = r + g + b
        w_r, w_g, w_b = (r / total, g / total, b / total) if total > 0 else (0.299, 0.587, 0.114)
        gray = (
            color[:, :, 0].astype(np.float32) * w_b
            + color[:, :, 1].astype(np.float32) * w_g
            + color[:, :, 2].astype(np.float32) * w_r
        )
        value = np.clip(gray, 0, 255).astype(np.uint8)
        _cache_put(key, value)
        return value

    key = f"{source_key}_gray"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    value = cv2.cvtColor(load_image(b64str), cv2.COLOR_BGR2GRAY)
    _cache_put(key, value)
    return value


def _finite_number(value: Any, field: str, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InputValidationError(f"{field} must be numeric.") from exc
    if not math.isfinite(number):
        raise InputValidationError(f"{field} must be finite.")
    if minimum is not None and number < minimum:
        raise InputValidationError(f"{field} is below the supported range.")
    if maximum is not None and number > maximum:
        raise InputValidationError(f"{field} is above the supported range.")
    return number


def calculate_peak_area(profile: np.ndarray | list[float], lb: int, rb: int) -> float:
    """Integrate the origin-to-front normalized signal above its endpoint baseline."""
    signal = np.asarray(profile, dtype=float)
    if signal.ndim != 1 or signal.size < 2 or not np.all(np.isfinite(signal)):
        return 0.0
    left = max(0, min(int(round(lb)), signal.size - 1))
    right = max(0, min(int(round(rb)), signal.size - 1))
    if right <= left:
        return 0.0
    baseline = min(float(signal[left]), float(signal[right]))
    clipped = np.clip(signal[left : right + 1] - baseline, 0, None)
    return float(_trapz(clipped))


def calculate_rf(idx: int, length: int) -> float:
    if length < 2:
        return 0.0
    y_origin_line = 1.05 / 1.10
    y_front_line = 0.05 / 1.10
    y_fraction = 1.0 - (float(idx) / (length - 1))
    return (y_origin_line - y_fraction) / (y_origin_line - y_front_line)


def _display_bounds(signal: np.ndarray, idx: int, area_lb: int, area_rb: int, threshold: float) -> tuple[int, int]:
    """Return the single Width-controlled interval within the detected base.

    The SciPy base positions are search limits only. The returned threshold
    crossings are authoritative for display, manual editing, and AUC.
    """
    baseline = min(float(signal[area_lb]), float(signal[area_rb]))
    cutoff = baseline + (float(signal[idx]) - baseline) * threshold
    left, right = area_lb, area_rb
    for pos in range(idx, area_lb, -1):
        if signal[pos] < cutoff:
            left = pos
            break
    for pos in range(idx, area_rb):
        if signal[pos] < cutoff:
            right = pos
            break
    if right - left < 2:
        left, right = max(area_lb, idx - 2), min(area_rb, idx + 2)
    return int(left), int(right)


def _validated_lanes(value: Any, width: int, height: int) -> list[dict[str, float | int]]:
    if not isinstance(value, list):
        raise InputValidationError("lanes must be a list.")
    if len(value) > MAX_LANES:
        raise InputValidationError("Too many lanes were requested.")
    lanes: list[dict[str, float | int]] = []
    for index, lane in enumerate(value):
        if not isinstance(lane, dict):
            raise InputValidationError("Each lane must be an object.")
        lane_id = lane.get("id", index + 1)
        cx = _finite_number(lane.get("cx"), "lane centre x", 0, width)
        cy = _finite_number(lane.get("cy"), "lane centre y", 0, height)
        lane_width = _finite_number(lane.get("w"), "lane width", 1, width)
        lane_height = _finite_number(lane.get("h"), "lane height", 1, height)
        angle = _finite_number(lane.get("angle", 0), "lane angle", -2 * math.pi, 2 * math.pi)
        lanes.append({"id": lane_id, "cx": cx, "cy": cy, "w": lane_width, "h": lane_height, "angle": angle})
    return lanes


def _result_error(exc: Exception) -> dict[str, str]:
    if isinstance(exc, InputValidationError):
        return {"error": str(exc), "error_code": "INVALID_INPUT"}
    traceback.print_exc()
    return {"error": "The analysis could not be completed.", "error_code": "PROCESSING_ERROR"}


def crop_image(data: dict[str, Any]) -> dict[str, Any]:
    """Apply rotation and crop, returning a bounded JPEG data URL."""
    try:
        if not isinstance(data, dict):
            raise InputValidationError("Crop data must be an object.")
        image = load_image(data.get("image"))
        height, width = image.shape[:2]
        x = _finite_number(data.get("x"), "crop x", -width, 2 * width)
        y = _finite_number(data.get("y"), "crop y", -height, 2 * height)
        crop_width = _finite_number(data.get("w"), "crop width", -width, 2 * width)
        crop_height = _finite_number(data.get("h"), "crop height", -height, 2 * height)
        angle = _finite_number(data.get("angle", 0), "crop angle", -2 * math.pi, 2 * math.pi)

        if angle:
            matrix = cv2.getRotationMatrix2D((width / 2, height / 2), np.degrees(-angle), 1.0)
            image = cv2.warpAffine(image, matrix, (width, height))

        x1, x2 = sorted((int(round(x)), int(round(x + crop_width))))
        y1, y2 = sorted((int(round(y)), int(round(y + crop_height))))
        crop = image[max(0, y1) : min(height, y2), max(0, x1) : min(width, x2)]
        if crop.size == 0:
            raise InputValidationError("The crop region is outside the image.")
        ok, buffer = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise RuntimeError("Could not encode crop.")
        return {"image": "data:image/jpeg;base64," + base64.b64encode(buffer).decode("ascii")}
    except Exception as exc:
        return _result_error(exc)


def generate_profiles(data: dict[str, Any]) -> dict[str, Any]:
    """Generate bounded, origin-to-front display/analysis profiles and peaks."""
    try:
        from scipy.ndimage import gaussian_filter1d, median_filter
        from scipy.signal import find_peaks

        if not isinstance(data, dict):
            raise InputValidationError("Analysis data must be an object.")
        image = load_gray(data.get("image"), data.get("target_wavelength"))
        if bool(data.get("invert_colors", False)):
            image = 255 - image
        image_height, image_width = image.shape[:2]
        lanes = _validated_lanes(data.get("lanes", []), image_width, image_height)

        detect_peaks = bool(data.get("peak_detection", False))
        prominence_input = _finite_number(data.get("peak_prominence", 10), "peak prominence", 0, 100)
        peak_prominence = 81.0 - prominence_input
        peak_distance = max(1, int(round(_finite_number(data.get("peak_distance", 5), "peak distance", 1, 10000))))
        smooth_sigma = _finite_number(data.get("smooth_sigma", 1.5), "smoothing", 0, 100)
        threshold = _finite_number(data.get("peak_threshold", 50), "peak threshold", 0, 100) / 100.0
        polarity = data.get("polarity_mode", "default")
        if polarity not in {"default", "dark", "bright"}:
            raise InputValidationError("Unsupported polarity mode.")

        results = []
        for lane in lanes:
            cx, cy, lane_width, lane_height, angle = (
                float(lane["cx"]), float(lane["cy"]), float(lane["w"]), float(lane["h"]), float(lane["angle"])
            )
            rotation = cv2.getRotationMatrix2D((cx, cy), np.degrees(-angle), 1.0)
            straight = cv2.warpAffine(image, rotation, (image_width, image_height))
            y1, y2 = max(0, int(cy - lane_height / 2)), min(image_height, int(cy + lane_height / 2))
            x1, x2 = max(0, int(cx - lane_width / 2)), min(image_width, int(cx + lane_width / 2))
            roi = straight[y1:y2, x1:x2]
            if roi.size == 0:
                results.append({"id": lane["id"], "profile": [], "profile_display": [], "profile_analysis": [], "peaks": []})
                continue

            raw_signal = np.mean(roi, axis=1)
            if polarity == "dark":
                profile = 255.0 - raw_signal
            elif polarity == "bright":
                profile = raw_signal
            else:
                profile = 255.0 - raw_signal if np.mean(roi) < np.median(roi) else raw_signal

            window = max(21, int(len(profile) * 0.50))
            window = min(window if window % 2 else window + 1, len(profile) if len(profile) % 2 else max(1, len(profile) - 1))
            background = median_filter(profile, size=max(1, window))
            profile = np.clip(profile - background, 0, None)
            profile = profile - profile.min()
            if smooth_sigma > 0 and len(profile) > 1:
                profile = gaussian_filter1d(profile, sigma=smooth_sigma)

            # Profile extraction starts at the solvent front. Public arrays run
            # origin -> front for every client and all numerical operations.
            profile_display = profile[::-1].copy()
            if profile_display.size:
                profile_range = float(profile_display.max() - profile_display.min())
                profile_analysis = (
                    (profile_display - profile_display.min()) / profile_range * 100.0
                    if profile_range >= 1e-6
                    else np.zeros_like(profile_display)
                )
            else:
                profile_analysis = np.array([], dtype=float)

            peaks: list[dict[str, Any]] = []
            if detect_peaks and len(profile_analysis) > 4 and float(profile_analysis.max()) > 0:
                indices, properties = find_peaks(profile_analysis, prominence=peak_prominence, distance=max(1, peak_distance))
                for peak_number, idx in enumerate(indices):
                    rf = calculate_rf(int(idx), len(profile_analysis))
                    if not 0.0 <= rf <= 1.0:
                        continue
                    area_lb = int(properties["left_bases"][peak_number])
                    area_rb = int(properties["right_bases"][peak_number])
                    peak_lb, peak_rb = _display_bounds(profile_analysis, int(idx), area_lb, area_rb, threshold)
                    area = calculate_peak_area(profile_analysis, peak_lb, peak_rb)
                    peaks.append({
                        "idx": int(idx),
                        "rf": round(rf, 3),
                        "height": round(float(profile_display[idx]), 2),
                        "height_display": round(float(profile_display[idx]), 2),
                        "height_analysis": round(float(profile_analysis[idx]), 4),
                        "area": round(area, 4),
                        "area_lb": peak_lb,
                        "area_rb": peak_rb,
                        # Compatibility aliases: there is one boundary set.
                        "display_lb": peak_lb,
                        "display_rb": peak_rb,
                        "lb": peak_lb,
                        "rb": peak_rb,
                        "manual": False,
                        "type": "N",
                    })

            results.append({
                "id": lane["id"],
                # Legacy profile remains front -> origin for older clients.
                "profile": profile.tolist(),
                "profile_display": profile_display.tolist(),
                "profile_analysis": profile_analysis.tolist(),
                "peaks": peaks,
            })

        return {
            "results": results,
            "_detectPeaks": detect_peaks,
            "profile_direction": "origin_to_front",
            "analysis_signal": "normalized_0_to_100",
        }
    except Exception as exc:
        return _result_error(exc)
