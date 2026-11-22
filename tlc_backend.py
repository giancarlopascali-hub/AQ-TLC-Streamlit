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


def _filter_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InputValidationError(f"{field} must be numeric.") from exc
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise InputValidationError(f"{field} must be between {minimum} and {maximum} nm.")
    return math.floor(number + 0.5)


def wavelength_window_to_rgb(target: Any, half_width: Any = 0) -> tuple[float, float, float]:
    """Average the approximate raw RGB vectors over an inclusive ±nm window."""
    centre = _filter_integer(target, "RGB projection wavelength", 380, 750)
    radius = _filter_integer(0 if half_width is None else half_width, "RGB projection window", 0, 50)
    first = max(380, centre - radius)
    last = min(750, centre + radius)
    red = green = blue = 0.0
    for nm in range(first, last + 1):
        r, g, b = wavelength_to_rgb(nm)
        red += r
        green += g
        blue += b
    count = last - first + 1
    return red / count, green / count, blue / count


def load_gray(b64str: str, target_wavelength: Any = None, wavelength_bandwidth: Any = 0) -> np.ndarray:
    """Load grayscale or a clearly-labelled RGB-channel projection."""
    source_key = hashlib.sha256(b64str.encode("utf-8")).hexdigest()
    if target_wavelength is not None and str(target_wavelength).strip().lower() not in {"", "full", "none", "null"}:
        wavelength = _filter_integer(target_wavelength, "RGB projection wavelength", 380, 750)
        half_width = _filter_integer(0 if wavelength_bandwidth is None else wavelength_bandwidth, "RGB projection window", 0, 50)
        key = f"{source_key}_gray_wl_{wavelength}_window_{half_width}"
        cached = _cache_get(key)
        if cached is not None:
            return cached
        color = load_image(b64str)
        r, g, b = wavelength_window_to_rgb(wavelength, half_width)
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


def _asymmetric_gaussian(x: np.ndarray, amplitude: float, centre: float, left_width: float, right_width: float) -> np.ndarray:
    """A continuous, nonnegative peak with independently fitted left/right tails."""
    width = np.where(x < centre, left_width, right_width)
    return amplitude * np.exp(-0.5 * np.square((x - centre) / width))


def _shoulder_model(x: np.ndarray, parameters: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    """Return baseline, total fit, and baseline-free components on a local index grid."""
    scaled_x = (x - (len(x) - 1) / 2) / max(1, len(x))
    baseline = parameters[0] + parameters[1] * scaled_x + parameters[2] * np.square(scaled_x)
    components = [
        _asymmetric_gaussian(x, *parameters[3 + 4 * index : 7 + 4 * index])
        for index in range(count)
    ]
    return baseline, baseline + sum(components), components


def _shoulder_noise(signal: np.ndarray) -> float:
    """Robust high-frequency noise estimate in normalized analysis units."""
    from scipy.ndimage import gaussian_filter1d

    high_frequency = signal - gaussian_filter1d(signal, sigma=1.0)
    middle = float(np.median(high_frequency))
    return max(0.1, 1.4826 * float(np.median(np.abs(high_frequency - middle))))


def _shoulder_candidates(signal: np.ndarray, single_curve: np.ndarray, apex: int, sensitivity: float, noise: float) -> list[int]:
    """Find secondary curvature lobes, including lobes revealed by the one-peak residual."""
    from scipy.ndimage import gaussian_filter1d
    from scipy.signal import find_peaks

    peak_height = float(signal.max() - min(signal[0], signal[-1]))
    curvature = -gaussian_filter1d(signal, sigma=2.0, order=2)
    residual = gaussian_filter1d(signal - single_curve, sigma=1.5)
    residual_curvature = -gaussian_filter1d(residual, sigma=1.5, order=2)
    curvature_floor = max(0.025, float(curvature.max()) * (0.14 - 0.001 * sensitivity))
    residual_floor = max(0.025, noise * 0.12)
    raw_indices, raw_properties = find_peaks(curvature, prominence=curvature_floor, distance=3)
    residual_indices, residual_properties = find_peaks(residual_curvature, prominence=residual_floor, distance=3)
    candidates: dict[int, float] = {}
    for index, prominence in zip(raw_indices, raw_properties["prominences"]):
        if curvature[index] > curvature_floor and signal[index] > min(signal[0], signal[-1]) + peak_height * 0.12:
            candidates[int(index)] = float(prominence)
    for index, prominence in zip(residual_indices, residual_properties["prominences"]):
        if residual[index] > max(noise * (3.5 - 0.015 * sensitivity), peak_height * (0.055 - 0.0003 * sensitivity)):
            candidates[int(index)] = max(candidates.get(int(index), 0.0), float(prominence))
    minimum_separation = max(4, round(len(signal) * 0.045))
    return [
        index for index, _ in sorted(candidates.items(), key=lambda pair: pair[1], reverse=True)
        if abs(index - apex) >= minimum_separation and 2 <= index <= len(signal) - 3
    ][:3]


def _fit_shoulder_group(
    signal: np.ndarray,
    display_signal: np.ndarray,
    apex: int,
    base_lb: int,
    base_rb: int,
    threshold: float,
    sensitivity: float,
    max_peak_asymmetry: float,
    group_id: str,
    original_peak: dict[str, Any],
    neighbor_intervals: list[tuple[int, int]],
    override: str | None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]] | None]:
    """Compare one versus two shape-limited peaks around a detected apex.

    Only a curvature-supported, statistically and materially better two-peak
    fit is allowed to replace the measured single peak. Candidate fits with
    insufficient support are exposed as unresolved, never silently accepted.
    """
    from scipy.optimize import least_squares

    if sensitivity <= 0 or base_rb - base_lb < 16:
        return None, None
    # Per-lane 0..100 normalization can amplify a nearly blank image into a
    # full-scale-looking trace. Require meaningful contrast in the measured
    # (pre-normalization) display profile before considering a split.
    raw_contrast = float(display_signal.max() - display_signal.min())

    # Fit through the low-signal shoulders, but keep the resulting measured
    # integration envelope separate from any neighbouring peak interval.
    baseline_level = min(float(signal[base_lb]), float(signal[base_rb]))
    cutoff = baseline_level + 0.025 * max(0.0, float(signal[apex]) - baseline_level)
    lb, rb = apex, apex
    while lb > base_lb and signal[lb] > cutoff:
        lb -= 1
    while rb < base_rb and signal[rb] > cutoff:
        rb += 1
    lb = max(base_lb, lb - 2)
    rb = min(base_rb, rb + 2)
    if rb - lb < 18 or rb - lb > 512 or any(lb <= right and left <= rb for left, right in neighbor_intervals):
        return None, None
    local_raw_contrast = float(np.ptp(display_signal[lb : rb + 1]))
    if local_raw_contrast < 8.0:
        return None, None

    y = np.asarray(signal[lb : rb + 1], dtype=float)
    x = np.arange(len(y), dtype=float)
    local_apex = apex - lb
    if not np.all(np.isfinite(y)) or y.max() - y.min() < 8:
        return None, None
    flat_run = np.flatnonzero(y >= y.max() * 0.985)
    if len(flat_run) >= max(7, round(len(y) * 0.08)):
        return None, None

    noise = _shoulder_noise(y)
    half_level = min(y[0], y[-1]) + 0.5 * (y[local_apex] - min(y[0], y[-1]))
    left_half = local_apex
    right_half = local_apex
    while left_half > 0 and y[left_half] >= half_level:
        left_half -= 1
    while right_half < len(y) - 1 and y[right_half] >= half_level:
        right_half += 1
    left_width = max(2.0, (local_apex - left_half) / 1.18)
    right_width = max(2.0, (right_half - local_apex) / 1.18)
    base_guess = max(0.0, min(float(y[0]), float(y[-1])))
    initial_single = np.array([base_guess, float(y[-1] - y[0]), 0.0,
                               max(1.0, float(y[local_apex] - base_guess)),
                               float(local_apex), left_width, right_width])
    single_lower = [0, -150, -150, 0, 1, 1.5, 1.5]
    single_upper = [120, 150, 150, 150, len(y) - 2, len(y), len(y)]
    def residuals(parameters: np.ndarray, count: int) -> np.ndarray:
        fitted_baseline, fitted_total, _ = _shoulder_model(x, parameters, count)
        return np.concatenate((
            fitted_total - y,
            3.0 * np.minimum(fitted_baseline, 0),
            3.0 * np.maximum(fitted_baseline - 100.0, 0),
        ))
    try:
        single_fit = least_squares(
            lambda params: residuals(params, 1),
            initial_single, bounds=(single_lower, single_upper), max_nfev=400,
        )
    except (ValueError, FloatingPointError):
        return None, None
    if not single_fit.success:
        return None, None
    _, single_curve, _ = _shoulder_model(x, single_fit.x, 1)
    candidates = _shoulder_candidates(y, single_curve, local_apex, sensitivity, noise)
    if not candidates:
        return None, None

    single_sse = float(np.sum(np.square(y - single_curve)))
    log_ratio_limit = math.log(max_peak_asymmetry)

    def limited_parameters(variables: np.ndarray) -> np.ndarray:
        """Map bounded width ratios back to the usual two-Gaussian parameters."""
        parameters = np.empty(11, dtype=float)
        parameters[:3] = variables[:3]
        stride = 3 if max_peak_asymmetry == 1 else 4
        for index in range(2):
            source = 3 + stride * index
            target = 3 + 4 * index
            parameters[target : target + 3] = variables[source : source + 3]
            left_width = float(variables[source + 2])
            parameters[target + 3] = (
                left_width if max_peak_asymmetry == 1 else
                float(np.clip(left_width * math.exp(float(variables[source + 3])), 1.5, len(y)))
            )
        return parameters

    def limited_start(parameters: np.ndarray) -> np.ndarray:
        start = list(map(float, parameters[:3]))
        for index in range(2):
            offset = 3 + 4 * index
            amplitude, centre, left_width, right_width = map(float, parameters[offset : offset + 4])
            if max_peak_asymmetry == 1:
                start.extend((amplitude, centre, math.sqrt(left_width * right_width)))
            else:
                start.extend((amplitude, centre, left_width,
                              float(np.clip(math.log(right_width / left_width),
                                            -log_ratio_limit * 0.999, log_ratio_limit * 0.999))))
        return np.asarray(start, dtype=float)

    unrestricted_sse: list[float] = []
    limited_fits: list[dict[str, Any]] = []
    for candidate in candidates:
        # Each plausible shoulder has its own centre bounds and starting fit.
        if candidate > local_apex:
            main_min, main_max = max(1, local_apex - 8), min(len(y) - 3, candidate - 3)
            second_min, second_max = max(3, local_apex + 3), min(len(y) - 2, candidate + 8)
        else:
            main_min, main_max = max(3, candidate + 3), min(len(y) - 2, local_apex + 8)
            second_min, second_max = max(1, candidate - 8), min(len(y) - 3, local_apex - 3)
        if main_min >= main_max or second_min >= second_max:
            continue
        main_start = float(np.clip(single_fit.x[4], main_min + 0.01, main_max - 0.01))
        second_start = float(np.clip(candidate, second_min + 0.01, second_max - 0.01))
        initial_double = np.array([
            *single_fit.x[:3],
            max(1.0, single_fit.x[3] * 0.8), main_start,
            max(2.0, single_fit.x[5] * 0.9), max(2.0, single_fit.x[6] * 0.9),
            max(1.0, float(y[candidate] - single_curve[candidate]) * 2.0,
                single_fit.x[3] * 0.2),
            second_start, max(2.0, min(single_fit.x[5], len(y) / 5)),
            max(2.0, min(single_fit.x[6], len(y) / 5)),
        ])
        double_lower = [0, -150, -150, 0, main_min, 1.5, 1.5, 0, second_min, 1.5, 1.5]
        double_upper = [120, 150, 150, 150, main_max, len(y), len(y),
                        150, second_max, len(y), len(y)]
        unrestricted_fit = None
        try:
            attempt = least_squares(
                lambda params: residuals(params, 2),
                initial_double, bounds=(double_lower, double_upper), max_nfev=700,
            )
            if attempt.success:
                unrestricted_fit = attempt
                _, unrestricted_curve, _ = _shoulder_model(x, attempt.x, 2)
                unrestricted_sse.append(float(np.sum(np.square(y - unrestricted_curve))))
        except (ValueError, FloatingPointError):
            pass

        if unrestricted_fit is not None and max_peak_asymmetry > 1 and all(
            max(unrestricted_fit.x[5 + 4 * index], unrestricted_fit.x[6 + 4 * index]) /
            min(unrestricted_fit.x[5 + 4 * index], unrestricted_fit.x[6 + 4 * index])
            <= max_peak_asymmetry
            for index in range(2)
        ):
            fitted_baseline, double_curve, component_curves = _shoulder_model(x, unrestricted_fit.x, 2)
            limited_fits.append({
                "parameters": unrestricted_fit.x,
                "baseline": fitted_baseline,
                "curve": double_curve,
                "components": component_curves,
                "sse": float(np.sum(np.square(y - double_curve))),
                "candidate": candidate,
            })
            continue

        limited_lower = [0, -150, -150]
        limited_upper = [120, 150, 150]
        for centre_min, centre_max in ((main_min, main_max), (second_min, second_max)):
            limited_lower.extend((0, centre_min, 1.5))
            limited_upper.extend((150, centre_max, len(y)))
            if max_peak_asymmetry > 1:
                limited_lower.append(-log_ratio_limit)
                limited_upper.append(log_ratio_limit)
        def limited_residuals(variables: np.ndarray) -> np.ndarray:
            return residuals(limited_parameters(variables), 2)
        starts = [limited_start(initial_double)]
        if unrestricted_fit is not None:
            alternative_start = limited_start(unrestricted_fit.x)
            if not np.allclose(alternative_start, starts[0], rtol=1e-8, atol=1e-8):
                starts.append(alternative_start)
        starts.sort(key=lambda value: float(np.sum(np.square(limited_residuals(value)))))
        for initial_limited in starts:
            try:
                limited_fit = least_squares(
                    limited_residuals, initial_limited,
                    bounds=(limited_lower, limited_upper), max_nfev=500,
                )
            except (ValueError, FloatingPointError):
                continue
            if not limited_fit.success:
                continue
            limited_params = limited_parameters(limited_fit.x)
            fitted_baseline, double_curve, component_curves = _shoulder_model(x, limited_params, 2)
            limited_sse = float(np.sum(np.square(y - double_curve)))
            limited_fits.append({
                "parameters": limited_params,
                "baseline": fitted_baseline,
                "curve": double_curve,
                "components": component_curves,
                "sse": limited_sse,
                "candidate": candidate,
            })
    if not limited_fits:
        return None, None
    # A constrained attempt may converge to a better local minimum than the
    # unrestricted attempt from another start; it is also a valid reference fit.
    reference_sse = min([*unrestricted_sse, *(fit["sse"] for fit in limited_fits)])

    def aicc(sse: float, count: int) -> float:
        n = len(y)
        return n * math.log(max(sse / n, 1e-12)) + 2 * count + 2 * count * (count + 1) / max(1, n - count - 1)

    def evaluate_fit(fit: dict[str, Any]) -> dict[str, Any] | None:
        params = fit["parameters"]
        fitted_baseline = fit["baseline"]
        component_curves = fit["components"]
        ordered = sorted(range(2), key=lambda index: params[4 + 4 * index])
        centres = [float(params[4 + 4 * index] + lb) for index in ordered]
        widths = [(float(params[5 + 4 * index]), float(params[6 + 4 * index])) for index in ordered]
        amplitudes = [float(params[3 + 4 * index]) for index in ordered]
        ratios = [max(pair) / min(pair) for pair in widths]
        # Width % controls the measured-area union, independently of fit support.
        width_factor = math.sqrt(-2 * math.log(max(threshold, 1e-9)))
        component_bounds = [
            (max(lb, int(math.floor(centre - width_factor * width[0]))),
             min(rb, int(math.ceil(centre + width_factor * width[1]))))
            for centre, width in zip(centres, widths)
        ]
        merged_bounds: list[list[int]] = []
        for left, right in sorted(component_bounds):
            if merged_bounds and left <= merged_bounds[-1][1]:
                merged_bounds[-1][1] = max(merged_bounds[-1][1], right)
            else:
                merged_bounds.append([left, right])
        if any(right - left < 2 for left, right in merged_bounds) or any(
            left <= neighbor_right and neighbor_left <= right
            for left, right in merged_bounds
            for neighbor_left, neighbor_right in neighbor_intervals
        ):
            return None
        integration_lb, integration_rb = merged_bounds[0][0], merged_bounds[-1][1]
        segments = [
            {"lb": left, "rb": right, "area": round(calculate_peak_area(signal, left, right), 4)}
            for left, right in merged_bounds
        ]
        fit_areas = [
            sum(float(_trapz(component[left - lb : right - lb + 1])) for left, right in merged_bounds)
            for component in component_curves
        ]
        total_fit_area = sum(fit_areas)
        measured_area = round(sum(segment["area"] for segment in segments), 4)
        if total_fit_area <= 0 or measured_area <= 0:
            return None
        shares = [fit_areas[index] / total_fit_area for index in ordered]
        allocated_areas = [round(measured_area * shares[0], 4), 0.0]
        allocated_areas[1] = round(measured_area - allocated_areas[0], 4)
        separation = centres[1] - centres[0]
        rmse_single = math.sqrt(single_sse / len(y))
        rmse_double = math.sqrt(fit["sse"] / len(y))
        improvement = 1 - rmse_double / max(rmse_single, 1e-9)
        aicc_delta = aicc(single_sse, 7) - aicc(fit["sse"], 9 if max_peak_asymmetry == 1 else 11)
        secondary_share = min(shares)
        secondary_snr = min(amplitudes) / max(noise, 1e-9)
        secondary_raw_height = min(amplitudes) * raw_contrast / 100.0
        checks = {
            "fit_quality_vs_unrestricted": fit["sse"] <= reference_sse * 1.05 + 1e-9,
            "component_share": secondary_share >= 0.12 - 0.00065 * sensitivity,
            "signal_to_noise": secondary_snr >= 6.0 - 0.02 * sensitivity,
            "raw_signal": secondary_raw_height >= 5.0,
            "separation": separation >= max(6.0, 0.8 * max(max(pair) for pair in widths)),
            "component_width": max(max(pair) for pair in widths) <= (rb - lb) * 0.60,
            "rmse_improvement": improvement >= 0.30 - 0.0015 * sensitivity,
            "model_selection": aicc_delta >= 12.0,
            "centres_within_fit": all(lb + 2 < centre < rb - 2 for centre in centres),
            "baseline": all(-2.0 <= value <= 105.0 for value in fitted_baseline),
        }
        return {**fit, "ordered": ordered, "centres": centres, "widths": widths,
                "component_bounds": component_bounds, "integration_lb": integration_lb,
                "integration_rb": integration_rb, "segments": segments, "fit_areas": fit_areas,
                "measured_area": measured_area, "allocated_areas": allocated_areas,
                "rmse_single": rmse_single, "rmse_double": rmse_double, "improvement": improvement,
                "aicc_delta": aicc_delta, "separation": separation, "secondary_share": secondary_share,
                "secondary_snr": secondary_snr, "secondary_raw_height": secondary_raw_height,
                "ratios": ratios, "checks": checks, "fit_valid": all(checks.values())}

    evaluated = [result for fit in limited_fits if (result := evaluate_fit(fit)) is not None]
    if not evaluated:
        return None, None
    valid = [fit for fit in evaluated if fit["fit_valid"]]
    best = min(valid if valid else evaluated, key=lambda fit: fit["sse"])
    fitted_baseline = best["baseline"]
    double_curve = best["curve"]
    component_curves = best["components"]
    ordered = best["ordered"]
    centres = best["centres"]
    component_bounds = best["component_bounds"]
    integration_lb, integration_rb = best["integration_lb"], best["integration_rb"]
    segments = best["segments"]
    fit_areas = best["fit_areas"]
    measured_area = best["measured_area"]
    allocated_areas = best["allocated_areas"]
    rmse_single, rmse_double = best["rmse_single"], best["rmse_double"]
    improvement, aicc_delta = best["improvement"], best["aicc_delta"]
    separation = best["separation"]
    secondary_share, secondary_snr = best["secondary_share"], best["secondary_snr"]
    secondary_raw_height = best["secondary_raw_height"]
    checks = best["checks"]
    fit_valid = best["fit_valid"]
    reason = "accepted" if fit_valid else next(name for name, passed in checks.items() if not passed)
    decision = "split" if fit_valid and override != "keep" else "keep"
    group: dict[str, Any] = {
        "id": group_id,
        "status": "resolved" if fit_valid else "unresolved",
        "reason": reason,
        "recommendation": "split" if fit_valid else "keep",
        "decision": decision,
        "active": decision == "split",
        "bounds": {"lb": int(lb), "rb": int(rb)},
        "integration_bounds": {"lb": int(integration_lb), "rb": int(integration_rb)},
        "integration_segments": segments,
        "measured_cluster_area": measured_area,
        "area_basis": "component_threshold_union",
        "width_threshold": round(threshold * 100, 4),
        "original_peak": dict(original_peak),
        "quality": {
            "noise": round(noise, 4),
            "max_peak_asymmetry": round(max_peak_asymmetry, 4),
            "component_asymmetry": [round(ratio, 4) for ratio in best["ratios"]],
            "max_fitted_asymmetry": round(max(best["ratios"]), 4),
            "sse_unrestricted": round(reference_sse, 6),
            "sse_constrained": round(best["sse"], 6),
            "fit_loss_pct": round(100 * max(0.0, best["sse"] - reference_sse) / max(reference_sse, 1e-9), 3),
            "rmse_single": round(rmse_single, 4),
            "rmse_double": round(rmse_double, 4),
            "improvement": round(improvement, 4),
            "aicc_delta": round(aicc_delta, 4),
            "separation": round(separation, 4),
            "component_share": round(secondary_share, 4),
            "snr": round(secondary_snr, 4),
            "raw_contrast": round(raw_contrast, 4),
            "local_raw_contrast": round(local_raw_contrast, 4),
            "secondary_raw_height": round(secondary_raw_height, 4),
            "checks": checks,
        },
        "baseline_curve": [round(float(value), 4) for value in fitted_baseline],
        "single_curve": [round(float(value), 4) for value in single_curve],
        "double_curve": [round(float(value), 4) for value in double_curve],
        "components": [],
    }
    replacement_peaks: list[dict[str, Any]] = []
    for output_index, source_index in enumerate(ordered):
        centre = centres[output_index]
        sample_index = int(round(centre))
        component_curve = component_curves[source_index]
        component: dict[str, Any] = {
            "peak_index": None,
            "center_idx": round(centre, 4),
            "rf": round(calculate_rf(centre, len(signal)), 3),
            "area": allocated_areas[output_index],
            "fit_area": round(fit_areas[source_index], 4),
            "integration_bounds": {"lb": component_bounds[output_index][0], "rb": component_bounds[output_index][1]},
            "curve": [round(float(value), 4) for value in component_curve],
        }
        group["components"].append(component)
        replacement_peaks.append({
            "idx": sample_index,
            "rf": component["rf"],
            "height": round(float(display_signal[sample_index]), 2),
            "height_display": round(float(display_signal[sample_index]), 2),
            "height_analysis": round(float(fitted_baseline[sample_index - lb] + component_curve[sample_index - lb]), 4),
            "area": component["area"],
            "fit_area": component["fit_area"],
            "area_method": "deconvolved",
            "fit_group_id": group_id,
            "fit_component_index": output_index,
            "fit_center_idx": component["center_idx"],
            "area_lb": component_bounds[output_index][0], "area_rb": component_bounds[output_index][1],
            "display_lb": component_bounds[output_index][0], "display_rb": component_bounds[output_index][1],
            "lb": component_bounds[output_index][0], "rb": component_bounds[output_index][1],
            "manual": False,
            "type": "N",
        })
    group["split_peaks"] = [dict(peak) for peak in replacement_peaks] if fit_valid else []
    return group, replacement_peaks if fit_valid and decision == "split" else None


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
        image = load_gray(data.get("image"), data.get("target_wavelength"), data.get("wavelength_bandwidth", 0))
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
        shoulder_sensitivity = _finite_number(data.get("shoulder_sensitivity", 0), "shoulder sensitivity", 0, 100)
        max_peak_asymmetry = _finite_number(data.get("max_peak_asymmetry", 1), "maximum peak asymmetry", 1, 5)
        fit_overrides = data.get("fit_overrides", {})
        if not isinstance(fit_overrides, dict) or len(fit_overrides) > MAX_LANES * 32:
            raise InputValidationError("Fit overrides must be a small object.")
        if any(not isinstance(key, str) or len(key) > 100 or not isinstance(value, str)
               or value not in {"split", "keep"}
               for key, value in fit_overrides.items()):
            raise InputValidationError("Fit overrides must select split or keep.")
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
                results.append({"id": lane["id"], "profile": [], "profile_display": [], "profile_analysis": [], "peaks": [], "fit_groups": []})
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
            fit_groups: list[dict[str, Any]] = []
            peak_bases: list[tuple[int, int]] = []
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
                    peak_bases.append((area_lb, area_rb))
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

                if shoulder_sensitivity > 0 and peaks:
                    original_peaks = peaks
                    peaks = []
                    used_bounds: list[tuple[int, int]] = []
                    for peak_index, original_peak in enumerate(original_peaks):
                        other_intervals = [
                            (int(other["area_lb"]), int(other["area_rb"]))
                            for other_index, other in enumerate(original_peaks)
                            if other_index != peak_index
                        ]
                        group_id = f"{lane['id']}:{original_peak['idx']}"
                        group, replacement = _fit_shoulder_group(
                            profile_analysis,
                            profile_display,
                            int(original_peak["idx"]),
                            *peak_bases[peak_index],
                            threshold,
                            shoulder_sensitivity,
                            max_peak_asymmetry,
                            group_id,
                            original_peak,
                            other_intervals,
                            fit_overrides.get(group_id),
                        )
                        if group is not None:
                            group_bounds = (group["bounds"]["lb"], group["bounds"]["rb"])
                            if any(group_bounds[0] <= right and left <= group_bounds[1]
                                   for left, right in used_bounds):
                                group = None
                                replacement = None
                            else:
                                fit_groups.append(group)
                                used_bounds.append(group_bounds)
                        peaks.extend(replacement if replacement is not None else [original_peak])
                    peaks.sort(key=lambda peak: peak["idx"])
                    for peak_index, peak in enumerate(peaks):
                        if peak.get("area_method") == "deconvolved":
                            group = next(group for group in fit_groups if group["id"] == peak["fit_group_id"])
                            group["components"][peak["fit_component_index"]]["peak_index"] = peak_index

            results.append({
                "id": lane["id"],
                # Legacy profile remains front -> origin for older clients.
                "profile": profile.tolist(),
                "profile_display": profile_display.tolist(),
                "profile_analysis": profile_analysis.tolist(),
                "peaks": peaks,
                "fit_groups": fit_groups,
            })

        return {
            "results": results,
            "_detectPeaks": detect_peaks,
            "profile_direction": "origin_to_front",
            "analysis_signal": "normalized_0_to_100",
        }
    except Exception as exc:
        return _result_error(exc)
