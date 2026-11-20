/**
 * @module analysis
 * @file modules/analysis.js
 *
 * Pure analytical and mathematical functions for chromatographic data.
 *
 * All functions are stateless mathematical transforms except where they read
 * `state.lanes` to gather calibration standards.  None of these functions
 * trigger DOM mutations, canvas redraws, or network requests - they only
 * compute and return values.
 */

import { state }                              from './state.js';
import { RF_ORIGIN_OFFSET, RF_FRONT_OFFSET } from './constants.js';

//                                                                             
//  Rf CALCULATION
//                                                                             

/**
 * Calculates the Retention Factor (Rf) for a peak at a given profile index.
 *
 * Background:
 *   The server returns the 1D density profile with index 0 = Origin end of the
 *   lane, index n 1 = Front end.  Before use in the chart, the array is reversed
 *   so that index 0 = Front (Rf~1) and index n 1 = Origin (Rf~0).
 *
 *   The lane bounding box is 1.10  the solvent travel distance.  The real
 *   chromatographic region occupies the middle 1.00/1.10 of the box, bounded by
 *   RF_ORIGIN_OFFSET at the bottom and RF_FRONT_OFFSET at the top.
 *
 * Formula:
 *   y_fract  = 1   (idx / (n 1))   -> fractional position in box (0=Origin end, 1=Front end)
 *   Rf       = (RF_ORIGIN_OFFSET   y_fract) / (RF_ORIGIN_OFFSET   RF_FRONT_OFFSET)
 *
 * This mapping must stay in sync with the identical formula in server.py
 * (generate_profiles function).
 *
 * @param {number} idx - Index in the reversed profile array (0 = Front end of lane).
 * @param {number} n   - Total number of profile data points.
 * @returns {number}   - Rf value.  Values outside [0, 1] indicate outside-bounds positions.
 */
export function calculateRf(idx, n) {
  if (!Number.isFinite(idx) || !Number.isFinite(n) || n < 2) return 0;
  const y_fract = 1.0 - (idx / (n - 1));
  return (RF_ORIGIN_OFFSET - y_fract) / (RF_ORIGIN_OFFSET - RF_FRONT_OFFSET);
}

// -----------------------------------------------------------------------------
//  PEAK INTEGRATION
// -----------------------------------------------------------------------------

/**
 * Trapezoidal area above the smaller endpoint baseline.  The input must be
 * the backend's origin-to-front `profile_analysis` (normalised 0..100), not
 * the visual/raw density profile.  It mirrors tlc_backend.calculate_peak_area.
 */
export function calculatePeakArea(profile, lb, rb) {
  if (!Array.isArray(profile) || profile.length < 2) return 0;
  const n = profile.length;
  const left = Math.max(0, Math.min(Math.round(lb), n - 1));
  const right = Math.max(0, Math.min(Math.round(rb), n - 1));
  if (right <= left || !Number.isFinite(profile[left]) || !Number.isFinite(profile[right])) return 0;

  const baseline = Math.min(profile[left], profile[right]);
  let area = 0;
  for (let index = left; index < right; index++) {
    const y0 = Math.max(0, Number(profile[index]) - baseline);
    const y1 = Math.max(0, Number(profile[index + 1]) - baseline);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return 0;
    area += (y0 + y1) / 2;
  }
  return Math.max(0, area);
}

/** Finds the single Width-controlled interval for display and integration. */
export function findPeakBounds(profile, apex, thresholdPercent = 50) {
  if (!Array.isArray(profile) || profile.length < 2) {
    return { area_lb: 0, area_rb: 0, display_lb: 0, display_rb: 0 };
  }
  const index = Math.max(0, Math.min(Math.round(apex), profile.length - 1));
  let areaLb = index;
  let areaRb = index;
  while (areaLb > 0 && profile[areaLb - 1] <= profile[areaLb]) areaLb--;
  while (areaRb < profile.length - 1 && profile[areaRb + 1] <= profile[areaRb]) areaRb++;

  const base = Math.min(profile[areaLb], profile[areaRb]);
  const fraction = Math.max(0, Math.min(100, Number(thresholdPercent) || 50)) / 100;
  const cutoff = base + (profile[index] - base) * fraction;
  let displayLb = areaLb;
  let displayRb = areaRb;
  for (let pos = index; pos > areaLb; pos--) {
    if (profile[pos] < cutoff) { displayLb = pos; break; }
  }
  for (let pos = index; pos < areaRb; pos++) {
    if (profile[pos] < cutoff) { displayRb = pos; break; }
  }
  if (displayRb - displayLb < 2) {
    displayLb = Math.max(areaLb, index - 2);
    displayRb = Math.min(areaRb, index + 2);
  }
  return {
    area_lb: displayLb,
    area_rb: displayRb,
    display_lb: displayLb,
    display_rb: displayRb,
  };
}

//                                                                             
//  AREA CALIBRATION CURVE
//                                                                             

/** Group replicate standards by entered amount and average their existing areas. */
export function buildAreaCalibrationModel(lanes = state.lanes) {
  const groups = new Map();
  let skippedCount = 0;
  for (const lane of lanes || []) {
    for (const peak of lane.peaks || []) {
      if (peak.type !== 'S') continue;
      const entered = peak.calibrationValue;
      const value = entered === undefined || entered === null || String(entered).trim() === ''
        ? NaN : Number(entered);
      const area = Number(peak.area);
      if (!Number.isFinite(value) || value < 0 || !Number.isFinite(area) || area <= 0) {
        skippedCount++;
        continue;
      }
      const group = groups.get(value) || { value, areaSum: 0, replicates: 0 };
      group.areaSum += area;
      group.replicates++;
      groups.set(value, group);
    }
  }

  const levels = [...groups.values()]
    .map(group => ({ value: group.value, area: group.areaSum / group.replicates, replicates: group.replicates }))
    .sort((left, right) => left.value - right.value);
  const fail = error => ({ evaluate: null, error, levels, skippedCount });
  if (!levels.length) return fail('Add an S standard with a known amount and a positive measured area.');
  if (levels.some(level => !Number.isFinite(level.area))) return fail('Standard mean areas must be finite.');
  if (levels.some((level, index) => index > 0 &&
      level.area - levels[index - 1].area <= 1e-9 * Math.max(1, level.area, levels[index - 1].area))) {
    return fail('Mean standard areas must increase with known amount. Check the standards and integration windows.');
  }
  if (levels.length === 1 && levels[0].value === 0) {
    return fail('A single zero-amount standard cannot define a proportional calibration.');
  }

  const straightLine = (left, right, area) =>
    left.value + (area - left.area) * (right.value - left.value) / (right.area - left.area);
  const evaluate = inputArea => {
    const area = Number(inputArea);
    if (!Number.isFinite(area) || area < 0) return null;
    // Exact standards retain their entered values even at a bracket boundary.
    const exact = levels.find(level => Math.abs(area - level.area) <= 1e-12 * Math.max(1, area));
    if (exact) return exact.value;
    if (levels.length === 1) return area * levels[0].value / levels[0].area;
    if (area < levels[0].area) return Math.max(0, straightLine(levels[0], levels[1], area));
    const last = levels.length - 1;
    if (area > levels[last].area) return Math.max(0, straightLine(levels[last - 1], levels[last], area));

    const bracket = levels.findIndex((level, index) => index < last && area > level.area && area < levels[index + 1].area);
    if (bracket < 0) return null;
    const left = levels[bracket], right = levels[bracket + 1];
    const linear = straightLine(left, right, area);
    if (levels.length === 2) return Math.max(0, linear);

    // Choose one fixed neighbouring triplet per bracket, so the prediction
    // cannot jump because the third point changes inside that bracket.
    const third = bracket === 0 ? levels[2] : bracket + 2 > last ? levels[bracket - 1]
      : left.area - levels[bracket - 1].area <= levels[bracket + 2].area - right.area
        ? levels[bracket - 1] : levels[bracket + 2];
    const trio = [left, right, third].sort((a, b) => a.area - b.area);
    const [first, middle, final] = trio;
    const slope01 = (middle.value - first.value) / (middle.area - first.area);
    const slope12 = (final.value - middle.value) / (final.area - middle.area);
    const curvature = (slope12 - slope01) / (final.area - first.area);
    const derivative = x => slope01 + curvature * (2 * x - first.area - middle.area);
    const quadratic = first.value + slope01 * (area - first.area)
      + curvature * (area - first.area) * (area - middle.area);
    // A local quadratic may bend backwards despite increasing standards.
    // Reject that shape for the whole bracket, not only one query position.
    const monotone = derivative(left.area) > 0 && derivative(right.area) > 0;
    const inBracket = quadratic >= left.value - 1e-9 && quadratic <= right.value + 1e-9;
    return Math.max(0, monotone && inBracket && Number.isFinite(quadratic) ? quadratic : linear);
  };
  return { evaluate, error: null, levels, skippedCount };
}

/** Compatibility wrapper for callers that only need the area-to-amount function. */
export function calculateCalibrationCurve() {
  return buildAreaCalibrationModel().evaluate;
}

//                                                                             
//  MOLECULAR WEIGHT CALIBRATION CURVE (log-linear piecewise)
//                                                                             

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
 *   A function mapping Rf -> estimated MW, or null if < 2 standards are defined.
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
    // -- Extrapolate below lowest standard ----------------------------------
    if (rf <= standards[0].x) {
      const s0 = standards[0], s1 = standards[1];
      if (s1.x === s0.x) return null;
      const slope = (s1.y - s0.y) / (s1.x - s0.x);
      return Math.pow(10, s0.y + slope * (rf - s0.x));
    }

    // -- Extrapolate above highest standard ---------------------------------
    const last = standards[standards.length - 1];
    if (rf >= last.x) {
      const sN1 = standards[standards.length - 2];
      if (last.x === sN1.x) return null;
      const slope = (last.y - sN1.y) / (last.x - sN1.x);
      return Math.pow(10, last.y + slope * (rf - last.x));
    }

    // -- Interpolate within range -------------------------------------------
    for (let i = 0; i < standards.length - 1; i++) {
      if (rf >= standards[i].x && rf <= standards[i + 1].x) {
        const s0    = standards[i];
        const s1    = standards[i + 1];
        if (s1.x === s0.x) return null;
        const slope = (s1.y - s0.y) / (s1.x - s0.x);
        return Math.pow(10, s0.y + slope * (rf - s0.x));
      }
    }
    return null;  // Should never reach here given the guards above
  };
}
