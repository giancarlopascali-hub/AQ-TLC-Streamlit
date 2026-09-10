"""
tlc_backend.py
==============
Pure Python computation for AQ-TLC — no Flask dependency.

All functions take a plain dict (matching the JSON payloads from the
original Flask endpoints) and return a plain dict.  This module is shared
between streamlit_app.py (cloud/Streamlit deployment) and can be imported
by any other runner without bringing in Flask.

Functions
---------
generate_profiles(data)   — density profiles + peak detection
crop_image(data)          — ROI crop with rotation correction
"""

from __future__ import annotations

import base64
import hashlib
import io
import traceback

import cv2
import numpy as np
from PIL import Image


# -- Image cache ---------------------------------------------------------------

_cache: dict = {}
_CACHE_MAX = 40


def _cache_put(key: str, value):
    _cache[key] = value
    if len(_cache) > _CACHE_MAX:
        del _cache[next(iter(_cache))]


def load_image(b64str: str) -> np.ndarray:
    """Decode base64 image ? uint8 BGR array, cached by MD5."""
    key = hashlib.md5(b64str.encode()).hexdigest() + "_color"
    if key not in _cache:
        raw = base64.b64decode(b64str.split(",")[-1])
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
        _cache_put(key, cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR))
    return _cache[key]


def wavelength_to_rgb(wavelength: float):
    """Convert wavelength (nm, 380–750) to RGB tuple in [0, 1]."""
    if 380 <= wavelength < 440:
        r = -(wavelength - 440) / (440 - 380); g = 0.0; b = 1.0
    elif 440 <= wavelength < 490:
        r = 0.0; g = (wavelength - 440) / (490 - 440); b = 1.0
    elif 490 <= wavelength < 510:
        r = 0.0; g = 1.0; b = -(wavelength - 510) / (510 - 490)
    elif 510 <= wavelength < 580:
        r = (wavelength - 510) / (580 - 510); g = 1.0; b = 0.0
    elif 580 <= wavelength < 645:
        r = 1.0; g = -(wavelength - 645) / (645 - 580); b = 0.0
    elif 645 <= wavelength <= 750:
        r = 1.0; g = 0.0; b = 0.0
    else:
        r = g = b = 0.0

    if 380 <= wavelength < 420:
        factor = 0.3 + 0.7 * (wavelength - 380) / (420 - 380)
    elif 420 <= wavelength <= 700:
        factor = 1.0
    elif 700 < wavelength <= 750:
        factor = 0.3 + 0.7 * (750 - wavelength) / (750 - 700)
    else:
        factor = 0.0

    return r * factor, g * factor, b * factor


def load_gray(b64str: str, target_wavelength=None) -> np.ndarray:
    """Decode base64 image ? uint8 grayscale, optionally spectrally weighted."""
    if target_wavelength is not None and str(target_wavelength).strip() not in ("", "full", "none", "null"):
        try:
            wl = float(target_wavelength)
            key = hashlib.md5(b64str.encode()).hexdigest() + f"_gray_wl_{wl:.1f}"
            if key not in _cache:
                color = load_image(b64str)
                r, g, b = wavelength_to_rgb(wl)
                s = r + g + b
                w_r, w_g, w_b = (r / s, g / s, b / s) if s > 0 else (0.299, 0.587, 0.114)
                gray_f = (color[:, :, 0].astype(np.float32) * w_b +
                          color[:, :, 1].astype(np.float32) * w_g +
                          color[:, :, 2].astype(np.float32) * w_r)
                _cache_put(key, np.clip(gray_f, 0, 255).astype(np.uint8))
            return _cache[key]
        except Exception as e:
            print(f"[AQ-TLC] Wavelength filter error {target_wavelength}: {e}", flush=True)

    key = hashlib.md5(b64str.encode()).hexdigest() + "_gray"
    if key not in _cache:
        color = load_image(b64str)
        _cache_put(key, cv2.cvtColor(color, cv2.COLOR_BGR2GRAY))
    return _cache[key]


def apply_bg_norm(gray: np.ndarray, bg_rect: list | None = None):
    """Normalise image based on a reference background rect [x, y, w, h]."""
    gray_f = gray.astype(np.float64) / 255.0
    bg_val = 1.0

    if bg_rect and len(bg_rect) == 4:
        x, y, w, h = [int(v) for v in bg_rect]
        H, W = gray.shape
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        if x1 > x0 and y1 > y0:
            roi = gray_f[y0:y1, x0:x1]
            bg_val = float(np.median(roi))
            return np.clip(gray_f / (bg_val + 1e-6), 0, 1.0), bg_val

    return gray_f, bg_val


# -- Crop ----------------------------------------------------------------------

def crop_image(data: dict) -> dict:
    """
    Apply rotation + ROI crop.

    Parameters
    ----------
    data : dict
        image   : base64 data-URL string
        x, y, w, h : crop rect in image coordinates
        angle   : rotation in radians (applied before cropping)

    Returns
    -------
    dict with 'image' key (base64 JPEG) or 'error' key on failure.
    """
    try:
        img = load_image(data["image"])
        x, y, w, h = int(data["x"]), int(data["y"]), int(data["w"]), int(data["h"])
        angle = data.get("angle", 0)

        if angle != 0:
            M = cv2.getRotationMatrix2D(
                (img.shape[1] / 2, img.shape[0] / 2), np.degrees(-angle), 1.0
            )
            img = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]))

        x1, y1 = min(x, x + w), min(y, y + h)
        x2, y2 = max(x, x + w), max(y, y + h)
        crop = img[max(0, y1):min(img.shape[0], y2), max(0, x1):min(img.shape[1], x2)]
        if crop.size == 0:
            return {"error": "Invalid crop region"}

        _, buffer = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return {"image": "data:image/jpeg;base64," + base64.b64encode(buffer).decode()}
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}


# -- Profile Generation --------------------------------------------------------

def generate_profiles(data: dict) -> dict:
    """
    Compute 1-D density profiles and (optionally) detect peaks for each lane.

    Parameters
    ----------
    data : dict  — mirrors the JSON body of POST /generate_profiles

    Returns
    -------
    dict with 'results' key (list of per-lane dicts) or 'error' key on failure.
    """
    try:
        from scipy.signal import find_peaks
        from scipy.ndimage import gaussian_filter1d, median_filter

        target_wl    = data.get("target_wavelength")
        invert_colors = data.get("invert_colors", False)
        img = load_gray(data["image"], target_wavelength=target_wl)
        if invert_colors:
            img = 255 - img

        lanes              = data.get("lanes", [])
        detect_peaks_flag  = data.get("peak_detection", False)
        peak_prominence    = 81.0 - float(data.get("peak_prominence", 10))
        peak_distance      = int(data.get("peak_distance", 5))
        smooth_sigma       = float(data.get("smooth_sigma", 1.5))
        int_threshold      = float(data.get("peak_threshold", 50)) / 100.0
        polarity_mode      = data.get("polarity_mode", "default")

        results = []
        for lane in lanes:
            cx, cy, lw, lh, angle = (
                lane["cx"], lane["cy"], lane["w"], lane["h"], lane.get("angle", 0)
            )

            M = cv2.getRotationMatrix2D((cx, cy), np.degrees(-angle), 1.0)
            straight = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]))
            y1 = max(0, int(cy - lh / 2))
            y2 = min(straight.shape[0], int(cy + lh / 2))
            x1 = max(0, int(cx - lw / 2))
            x2 = min(straight.shape[1], int(cx + lw / 2))
            roi = straight[y1:y2, x1:x2]
            if roi.size == 0:
                results.append({"id": lane["id"], "profile": [], "peaks": []})
                continue

            raw_signal = np.mean(roi, axis=1)

            if polarity_mode == "dark":
                profile = 255.0 - raw_signal
            elif polarity_mode == "bright":
                profile = raw_signal
            else:
                if np.mean(roi) < np.median(roi):
                    profile = 255.0 - raw_signal
                else:
                    profile = raw_signal

            # Rolling-median baseline subtraction
            win = max(21, int(len(profile) * 0.50))
            if win % 2 == 0:
                win += 1
            background = median_filter(profile, size=win)
            profile = np.clip(profile - background, 0, None)
            profile = profile - profile.min()

            if smooth_sigma > 0:
                profile = gaussian_filter1d(profile, sigma=smooth_sigma)

            peaks_out = []
            if detect_peaks_flag and len(profile) > 4:
                p_rev = profile[::-1].copy()
                n = len(p_rev)

                p_min, p_max = p_rev.min(), p_rev.max()
                p_range = p_max - p_min
                if p_range < 1e-6:
                    results.append({"id": lane["id"], "profile": profile.tolist(), "peaks": []})
                    continue
                p_norm = (p_rev - p_min) / p_range * 100.0

                peak_indices, properties = find_peaks(
                    p_norm,
                    prominence=peak_prominence,
                    distance=max(1, peak_distance),
                )

                y_origin_line = 1.05 / 1.10
                y_front_line  = 0.05 / 1.10

                for i, idx in enumerate(peak_indices):
                    n = len(p_rev)
                    y_fract = 1.0 - (float(idx) / (n - 1)) if n > 1 else 0.0
                    rf = (y_origin_line - y_fract) / (y_origin_line - y_front_line)
                    if rf < 0.0 or rf > 1.0:
                        continue

                    lb, rb = int(properties["left_bases"][i]), int(properties["right_bases"][i])

                    local_peak_val = p_norm[idx]
                    local_base = min(p_norm[lb], p_norm[rb])
                    threshold_val = local_base + (local_peak_val - local_base) * int_threshold

                    v_lb, v_rb = lb, rb
                    for j in range(idx, lb, -1):
                        if p_norm[j] < threshold_val:
                            v_lb = j
                            break
                    for j in range(idx, rb):
                        if p_norm[j] < threshold_val:
                            v_rb = j
                            break

                    if (v_rb - v_lb) < 2:
                        v_lb, v_rb = max(0, idx - 2), min(n - 1, idx + 2)

                    base_val = min(p_norm[lb], p_norm[rb])
                    area = float(np.trapz(np.clip(p_norm[lb:rb + 1] - base_val, 0, None)))

                    peaks_out.append({
                        "idx":    int(idx),
                        "rf":     round(rf, 3),
                        "height": round(float(p_rev[idx]), 2),
                        "area":   round(area, 2),
                        "lb":     int(v_lb),
                        "rb":     int(v_rb),
                    })

            results.append({
                "id":      lane["id"],
                "profile": profile.tolist(),
                "peaks":   peaks_out,
            })

        return {"results": results, "_detectPeaks": detect_peaks_flag}
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}
