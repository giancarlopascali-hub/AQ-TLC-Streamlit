/**
 * @module analysis
 * @file modules/analysis.js
 *
 * Pure analytical and mathematical functions for chromatographic data.
 *
 * All functions are stateless mathematical transforms except where they read
 * `state.lanes` to gather calibration standards.  None of these functions
 * trigger DOM mutations, canvas redraws, or network requests — they only
 * compute and return values.
 */

import { state }                              from './state.js';
import { RF_ORIGIN_OFFSET, RF_FRONT_OFFSET } from './constants.js';

// ════════════════════════════════════════════════════════════════════════════
//  Rf CALCULATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Calculates the Retention Factor (Rf) for a peak at a given profile index.
 *
 * Background:
 *   The server returns the 1D density profile with index 0 = Origin end of the
 *   lane, index n−1 = Front end.  Before use in the chart, the array is reversed
 *   so that index 0 = Front (Rf≈1) and index n−1 = Origin (Rf≈0).
 *
 *   The lane bounding box is 1.10× the solvent travel distance.  The real
 *   chromatographic region occupies the middle 1.00/1.10 of the box, bounded by
 *   RF_ORIGIN_OFFSET at the bottom and RF_FRONT_OFFSET at the top.
 *
 * Formula:
 *   y_fract  = 1 − (idx / (n−1))   → fractional position in box (0=Origin end, 1=Front end)
 *   Rf       = (RF_ORIGIN_OFFSET − y_fract) / (RF_ORIGIN_OFFSET − RF_FRONT_OFFSET)
 *
 * This mapping must stay in sync with the identical formula in server.py
 * (generate_profiles function).
 *
 * @param {number} idx - Index in the reversed profile array (0 = Front end of lane).
 * @param {number} n   - Total number of profile data points.
 * @returns {number}   - Rf value.  Values outside [0, 1] indicate outside-bounds positions.
 */
export function calculateRf(idx, n) {
  const y_fract = 1.0 - (idx / (n - 1));
  return (RF_ORIGIN_OFFSET - y_fract) / (RF_ORIGIN_OFFSET - RF_FRONT_OFFSET);
}

// ════════════════════════════════════════════════════════════════════════════
//  AREA CALIBRATION CURVE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Builds a calibration function that converts integrated peak area (AU) to
 * a user-defined quantity (e.g. concentration, mass).
 *
 * The curve is constructed from all peaks flagged as Type S (Standard) across
 * ALL lanes in the current image, providing a global calibration model.
 *
 * Algorithm selection:
 *   0 standards → returns null (no calibration possible).
 *   1 standard  → linear-through-origin: y = (S.value / S.area) × area.
 *   2+ standards → ordinary least squares regression: y = m·area + b.
 *                  Guards against the degenerate case where all standards have
 *                  the same area (returns a constant function).
 *
 * @returns {((area: number) => number) | null}
 *   A function mapping area to calibrated quantity, or null if no standards are defined.
 */
export function calculateCalibrationCurve() {
  // Collect all Type-S peaks that have a valid calibrationValue
  const standards = [];
  state.lanes.forEach(l => {
    (l.peaks || []).forEach(pk => {
      if (pk.type === 'S' && pk.calibrationValue !== undefined && !isNaN(pk.calibrationValue)) {
        standards.push({ area: pk.area, value: pk.calibrationValue });
      }
    });
  });

  if (standards.length === 0) return null;

  // Single standard: force the regression line through the origin
  if (standards.length === 1) {
    const m = standards[0].value / (standards[0].area || 1);
    return area => area * m;
  }

  // Multiple standards: ordinary least squares (y = mx + b)
  const n = standards.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  standards.forEach(s => {
    sumX  += s.area;
    sumY  += s.value;
    sumXY += s.area  * s.value;
    sumXX += s.area  * s.area;
  });

  const denominator = n * sumXX - sumX * sumX;
  const m = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : NaN;
  const b = (sumY - m * sumX) / n;

  // Degenerate case: all standards have identical area → constant output
  if (isNaN(m)) return () => standards[0].value;

  // Clamp output at 0 to prevent negative calibrated values from extrapolation
  return area => Math.max(0, m * area + b);
}

// ════════════════════════════════════════════════════════════════════════════
//  MOLECULAR WEIGHT CALIBRATION CURVE (log-linear piecewise)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Builds a Molecular Weight estimation function from Standard peaks.
 *
 * Model: log10(MW) vs Rf  (Ferguson / standard SDS-PAGE approach).
 *
 * The model is piecewise log-linear:
 *   - Between standards: interpolate linearly in log10(MW) vs Rf space.
 *   - Below the lowest standard: extrapolate using the slope of the first segment.
 *   - Above the highest standard: extrapolate using the slope of the last segment.
 *
 * MW values are expected in a consistent unit (e.g. kDa) as entered by the user.
 * Minimum 2 Type-S standards with valid mwValue entries are required.
 *
 * @returns {((rf: number) => number) | null}
 *   A function mapping Rf → estimated MW, or null if < 2 standards are defined.
 */
export function calculateMWCalibrationCurve() {
  // Collect all Type-S peaks with a positive mwValue
  const standards = [];
  state.lanes.forEach(l => {
    (l.peaks || []).forEach(pk => {
      if (pk.type === 'S' && pk.mwValue > 0) {
        // Work in log-space for the piecewise linear interpolation
        standards.push({ x: pk.rf, y: Math.log10(pk.mwValue) });
      }
    });
  });

  if (standards.length < 2) return null;   // Need at least 2 points

  // Sort by ascending Rf (x-axis) to enable sequential piecewise lookup
  standards.sort((a, b) => a.x - b.x);

  return rf => {
    // ── Extrapolate below lowest standard ──────────────────────────────────
    if (rf <= standards[0].x) {
      const s0 = standards[0], s1 = standards[1];
      const slope = (s1.y - s0.y) / (s1.x - s0.x);
      return Math.pow(10, s0.y + slope * (rf - s0.x));
    }

    // ── Extrapolate above highest standard ─────────────────────────────────
    const last = standards[standards.length - 1];
    if (rf >= last.x) {
      const sN1 = standards[standards.length - 2];
      const slope = (last.y - sN1.y) / (last.x - sN1.x);
      return Math.pow(10, last.y + slope * (rf - last.x));
    }

    // ── Interpolate within range ───────────────────────────────────────────
    for (let i = 0; i < standards.length - 1; i++) {
      if (rf >= standards[i].x && rf <= standards[i + 1].x) {
        const s0    = standards[i];
        const s1    = standards[i + 1];
        const slope = (s1.y - s0.y) / (s1.x - s0.x);
        return Math.pow(10, s0.y + slope * (rf - s0.x));
      }
    }
    return null;  // Should never reach here given the guards above
  };
}
