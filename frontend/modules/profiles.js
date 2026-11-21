/**
 * @module profiles
 * @file modules/profiles.js
 *
 * Densitogram panel - right-hand analysis sidebar of AQ-TLC.
 *
 * PUBLIC API
 * ----------
 *   renderProfiles()   - Full panel rebuild. Call whenever the active lane changes
 *                        or the integration method switches.
 *   drawProfileChart() - Redraws ONLY the canvas chart. Called every mousemove
 *                        during peak/boundary dragging to avoid rebuilding DOM.
 *
 * INTERNAL HELPERS
 * ----------------
 *   buildPanelHeader()   - Lane name, export buttons, action buttons, tab strip.
 *   buildPeakTable()     - Table HTML for the three integration modes.
 *   generatePeakRowHTML() - Single row HTML (used by buildPeakTable and export.js).
 *   setupChartInteractions() - Mouse/wheel event handlers on the chart canvas.
 *
 * GLOBAL BRIDGE
 * -------------
 * A small set of functions are deliberately placed on `window` by the main entry
 * point (app.js) so that inline onchange handlers in the dynamically generated
 * per-peak input fields can reference them without circular module imports.
 * This is an explicit, documented architectural decision - see app.js for the full list.
 */

import { state, $                                          } from './state.js';
import { calculateRf, calculatePeakArea, findPeakBounds,
         buildAreaCalibrationModel, calculateMWCalibrationCurve } from './analysis.js';
import { cancelPendingProfileRequests, updateDensitograms  } from './api.js';
import { render                                            } from './render.js';
import { saveState                                         } from './workspace.js';
import { analysisReady, applyFitDecision, fitCurveSeries, fitGroups, fitIntegrationSegments,
         invalidateKeptFitGroup, isFittedPeak, isInsideActiveFit, overlapsActiveFit } from './shoulder.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Return the single canonical origin-to-front signal used for all AUC edits. */
function getAnalysisProfile(lane) {
  if (Array.isArray(lane.profile_analysis)) return lane.profile_analysis;
  if (Array.isArray(lane.profileAnalysis)) return lane.profileAnalysis;
  // Legacy profile responses are front -> origin and have no normalized data.
  const legacy = Array.isArray(lane.profile) ? lane.profile.slice().reverse() : [];
  const min = Math.min(...legacy, 0);
  const max = Math.max(...legacy, 0);
  const range = max - min;
  return range > 1e-9 ? legacy.map(value => (value - min) / range * 100) : legacy.map(() => 0);
}

function getDisplayProfile(lane) {
  if (Array.isArray(lane.profile_display)) return lane.profile_display;
  if (Array.isArray(lane.profileDisplay)) return lane.profileDisplay;
  return Array.isArray(lane.profile) ? lane.profile.slice().reverse() : [];
}

function areaLeft(peak) { return Number.isInteger(peak.area_lb) ? peak.area_lb : peak.lb; }
function areaRight(peak) { return Number.isInteger(peak.area_rb) ? peak.area_rb : peak.rb; }

function ensurePeakBounds(peak, length) {
  // Migrate responses produced by the former dual-bound contract by keeping
  // its Width-controlled (smaller) interval as the one canonical interval.
  const preferredLeft = Number.isInteger(peak.display_lb) ? peak.display_lb : areaLeft(peak);
  const preferredRight = Number.isInteger(peak.display_rb) ? peak.display_rb : areaRight(peak);
  const left = Math.max(0, Math.min(Number.isInteger(preferredLeft) ? preferredLeft : peak.idx - 1, length - 1));
  const right = Math.max(left + 1, Math.min(Number.isInteger(preferredRight) ? preferredRight : peak.idx + 1, length - 1));
  peak.area_lb = left;
  peak.area_rb = right;
  peak.lb = left; // compatibility with saved pre-contract projects.
  peak.rb = right;
  peak.display_lb = left;
  peak.display_rb = right;
}

function setPeakFromApex(peak, profile, index, threshold) {
  const bounds = findPeakBounds(profile, index, threshold);
  peak.idx = index;
  peak.rf = calculateRf(index, profile.length);
  peak.height_analysis = profile[index];
  peak.height = peak.height_analysis;
  peak.area_lb = bounds.area_lb;
  peak.area_rb = bounds.area_rb;
  peak.display_lb = bounds.display_lb;
  peak.display_rb = bounds.display_rb;
  peak.lb = bounds.area_lb;
  peak.rb = bounds.area_rb;
  peak.area = calculatePeakArea(profile, bounds.area_lb, bounds.area_rb);
  peak.manual = true;
}

//                                                                             
//  MAIN ENTRY - Full panel rebuild
//                                                                             

/**
 * Completely rebuilds the right-hand analysis panel from the current state.
 *
 * This replaces the entire `#densitogram-list` innerHTML.  It is intentionally
 * NOT called on every mousemove - use drawProfileChart() for that instead.
 *
 * Call this when:
 *   - The active lane changes (user clicks a lane on the canvas).
 *   - The integration method tab changes.
 *   - A peak is added, deleted, or its type/value changes.
 *   - A new set of peaks is received from the server.
 */
export function renderProfiles() {
  const list = $('densitogram-list');
  if (!list) return;

  list.innerHTML = '';

  // Empty state - no active lane selected
  if (!state.activeLane) {
    list.innerHTML = `<div class="empty-state" style="text-align:center; padding:50px; opacity:0.5">
      Select a lane to view analysis
    </div>`;
    return;
  }

  const l = state.activeLane;

  // -- Build the panel HTML ---------------------------------------------------
  const container = document.createElement('div');
  container.innerHTML = buildPanelHeader(l);
  list.appendChild(container);

  // -- Attach event listeners to panel-level buttons -------------------------
  // These are attached here (not via inline onclick) to keep JS out of HTML.
  attachPanelEvents(container, l);

  // -- Attach delegated listeners to the peak table body ---------------------
  // Per-peak controls (type switch, value inputs) use data-action attributes
  // so they can be handled by a single delegated listener rather than N inline handlers.
  attachTableEvents(container, l);

  // -- Draw the chart and set up its interactions ----------------------------
  // Use setTimeout(0) to allow the DOM to flush the new canvas element's layout
  // before reading its clientWidth/clientHeight for the drawing buffer size.
  setTimeout(() => {
    const cv = $('chart-active');
    if (!cv) return;
    drawProfileChart(cv, l);
    setupChartInteractions(cv, l);
  }, 0);
}

//                                                                             
//  PANEL HTML BUILDERS
//                                                                             

/**
 * Generates the HTML for the lane header, action buttons, and tab strip.
 *
 * @param {Object} l - The active lane object.
 * @returns {string} HTML string.
 */
export function buildPanelHeader(l) {
  const method = state.integrationMethod;
  const analysisContent = analysisReady(state) ? `
    <canvas id="chart-active" style="width:100%; height:280px; background:#010409;
            border:1px solid var(--border); border-radius:8px; cursor:crosshair"></canvas>
    ${buildFitGroupsHTML(l)}

    <div class="integration-table-wrap" style="margin-top:20px">
      <div class="tabs-nav">
        <button class="tab-btn ${method === 'relative'      ? 'active' : ''}" data-method="relative"      >Relative Intensity</button>
        <button class="tab-btn ${method === 'calibration'   ? 'active' : ''}" data-method="calibration"   >Area Calibration</button>
        <button class="tab-btn ${method === 'mw_calibration'? 'active' : ''}" data-method="mw_calibration">MW Calibration</button>
      </div>
      ${buildPeakTable(l)}
    </div>` : '';

  return `
    <div style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center">
      <input type="text" id="lane-name-input" value="${escapeHtml(l.name || 'Lane ' + l.id)}"
             style="background:transparent; border:none; color:white; font-family:Outfit;
                    font-size:1.2rem; font-weight:700; width:150px">
      <div style="display:flex; gap:6px">
        <button id="btn-export-lane" class="action-btn secondary"
                style="font-size:0.75rem; padding:4px 10px" title="Export this active lane" ${analysisReady(state) ? '' : 'disabled'}>
          &#128196; Export Lane
        </button>
        <button id="btn-export-all" class="action-btn primary"
                style="font-size:0.75rem; padding:4px 10px" title="Export all detected lanes" ${analysisReady(state) ? '' : 'disabled'}>
          &#128218; Full Report
        </button>
      </div>
    </div>

    ${!analysisReady(state) ? `<div class="analysis-pending">${state.isProfilePending ? 'Updating analysis…' : 'Analysis needs refresh. Choose Reset integration to retry.'}</div>` : ''}

    <div style="margin-bottom:10px; display:flex; gap:6px; flex-wrap:wrap;">
      <button id="btn-delete-peaks"    class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px" title="Delete all detected peaks in this lane">&#128465;&#65039; Delete all peaks</button>
      <button id="btn-reset-integ"     class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px" title="Re-run automated peak detection for this lane">&#128259; Reset integration</button>
      <button id="btn-reset-chartview" class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px" title="Reset chart zoom and pan">&#127919; Reset view</button>
    </div>

    ${analysisContent}
  `;
}

function metric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—';
}

/** A fit is a reviewable interpretation of the measured trace, not a new signal. */
export function buildFitGroupsHTML(lane, isExport = false) {
  if (state.shoulderSensitivity === 0) return '';
  const groups = fitGroups(lane);
  if (!groups.length) {
    return isExport ? '' : '<p class="fit-empty">No shoulder candidates at this sensitivity.</p>';
  }
  const cards = groups.map(group => {
    const quality = group.quality || {};
    const resolved = group.status === 'resolved';
    const decision = resolved && group.decision === 'split' ? 'split' : 'keep';
    const rf = Number.isFinite(group.original_peak?.rf) ? Number(group.original_peak.rf).toFixed(3) : '—';
    const allocatedSum = Array.isArray(group.components) && group.components.length
      ? group.components.reduce((sum, component) => sum + (Number(component.area) || 0), 0)
      : NaN;
    const details = [
      `Measured cluster ${metric(group.measured_cluster_area, 1)} AU (${fitIntegrationSegments(group).length} Width ${metric(group.width_threshold, 0)}% component window${fitIntegrationSegments(group).length === 1 ? '' : 's'})`,
      `Allocated sum ${metric(allocatedSum, 1)} AU`,
      `Noise ${metric(quality.noise)} AU`,
      `RMSE ${metric(quality.rmse_single)} → ${metric(quality.rmse_double)} AU`,
      `Improvement ${Number.isFinite(quality.improvement) ? metric(quality.improvement * 100, 1) + '%' : '—'}`,
      `Separation ${metric(quality.separation, 1)} samples`,
      `ΔAICc ${metric(quality.aicc_delta, 1)}`,
      `Weaker share ${Number.isFinite(quality.component_share) ? metric(quality.component_share * 100, 1) + '%' : '—'}`,
      `S/N ${metric(quality.snr, 1)}`,
    ].join(' · ');
    const buttons = isExport ? '' : resolved ? `
      <div class="fit-choice" role="group" aria-label="Shoulder decision near Rf ${rf}">
        <button type="button" data-action="fit-decision" data-group-id="${escapeHtml(group.id)}" ${state.isProfilePending ? 'disabled' : ''}
                data-decision="split" aria-pressed="${decision === 'split'}"
                class="${decision === 'split' ? 'active' : ''}">Split</button>
        <button type="button" data-action="fit-decision" data-group-id="${escapeHtml(group.id)}" ${state.isProfilePending ? 'disabled' : ''}
                data-decision="keep" aria-pressed="${decision === 'keep'}"
                class="${decision === 'keep' ? 'active' : ''}">Keep single</button>
      </div>` : '<span class="fit-unresolved">Keep single · unresolved</span>';
    const status = state.isProfilePending ? 'Recalculating…' : resolved
      ? (decision === 'split' ? 'Split applied' : 'Single peak retained; split preview only')
      : 'Unresolved; single peak retained';
    return `<div class="fit-card">
      <div class="fit-card-head"><strong>Shoulder near Rf ${rf}</strong><span>${status}</span></div>
      ${buttons}
      <div class="fit-diagnostics">${escapeHtml(details)}</div>
      ${group.reason && group.reason !== 'accepted' ? `<div class="fit-reason">${escapeHtml(group.reason)}</div>` : ''}
    </div>`;
  }).join('');
  const legend = groups.some(group => group.status === 'resolved')
    ? '<div class="fit-legend"><span class="measured">Measured</span><span class="total">Fit total</span><span class="component">Fitted components</span></div>'
    : '';
  return `<div class="fit-groups">${legend}${cards}
    <p class="fit-provenance">Fitted components are read-only. Use Keep single to edit the ordinary peak, or adjust shoulder sensitivity to refit.</p>
  </div>`;
}

/**
 * Generates the full peak data table (thead + tbody) for the current mode.
 *
 * @param {Object} l - The active lane object.
 * @returns {string} HTML string for the <table>.
 */
function buildPeakTable(l) {
  const method       = state.integrationMethod;
  const peaks        = l.peaks || [];
  const totalArea    = peaks.reduce((s, pk) => s + pk.area, 0);
  const totalCorr    = peaks.reduce((s, pk) => s + (pk.area / (pk.absRatio || 1)), 0);
  const calModel     = method === 'calibration'    ? buildAreaCalibrationModel()   : null;
  const mwCurve      = method === 'mw_calibration' ? calculateMWCalibrationCurve() : null;

  // Build column headers based on integration mode
  const headers = method === 'mw_calibration'
    ? `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area (AU)</th><th style="text-align:center">Type</th><th style="text-align:right">MW (kDa)</th>`
    : method === 'calibration'
    ? `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area (AU)</th><th style="text-align:center">Type</th><th style="text-align:right">Value</th>`
    : `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area (AU)</th><th style="text-align:right">%</th><th style="text-align:center">Abs Ratio</th><th style="text-align:right">% Corr.</th>`;

  const rows = peaks.map((pk, i) =>
    generatePeakRowHTML(pk, i, method, { totalArea, totalCorr, calModel, mwCurve })
  ).join('');

  return `
    ${buildCalibrationNoteHTML(calModel)}
    <table class="integration-table" style="width:100%">
      <thead><tr style="border-bottom:2px solid var(--border)">${headers}</tr></thead>
      <tbody id="peak-table-body">${rows}</tbody>
    </table>
    ${peaks.some(isFittedPeak) ? '<p class="fit-table-note">Model-allocated areas partition the summed measured Width%-controlled component windows. Each row also shows its model integral over those windows.</p>' : ''}
  `;
}

/** Explain the standards used and make an unavailable calibration visible. */
export function buildCalibrationNoteHTML(model) {
  if (!model) return '';
  const spots = model.levels.reduce((count, level) => count + level.replicates, 0);
  let description;
  if (model.error) {
    description = `Calibration unavailable: ${model.error}`;
  } else {
    const pooling = `${model.levels.length} known amount level${model.levels.length === 1 ? '' : 's'} from ${spots} standard spot${spots === 1 ? '' : 's'}; replicate areas at the same amount are averaged.`;
    const method = model.levels.length === 1
      ? 'One measured level gives a proportional straight line through the assumed zero point.'
      : model.levels.length === 2
        ? 'Two measured levels and the assumed zero point define a quadratic within the standard range. A segment that bends backwards uses a straight line.'
        : 'Local three-point quadratic interpolation uses neighbouring measured levels; below the first measured level it also uses the assumed zero point. A segment that bends backwards uses a straight line.';
    const extension = model.levels.length > 1
      ? 'Above the highest standard, the last two measured levels define straight-line extrapolation.'
      : 'Values above the standard use the same proportional line.';
    description = `Area calibration: ${pooling} Zero area is assumed to mean zero amount. ${method} ${extension}`;
  }
  if (model.skippedCount) description += ` ${model.skippedCount} incomplete or invalid S spot${model.skippedCount === 1 ? ' was' : 's were'} excluded.`;
  const style = model.error
    ? 'color:#b42318; background:#fff1f0; border:1px solid #efb5b0;'
    : 'color:#386b53; background:#edf8f0; border:1px solid #b9ddc1;';
  return `<p class="calibration-note" role="status" style="${style} padding:8px; border-radius:5px; font-size:0.76rem; line-height:1.4">${escapeHtml(description)}</p>`;
}

//                                                                             
//  PEAK ROW HTML - shared by profiles panel and export.js
//                                                                             

/**
 * Generates the <tr> HTML string for a single peak, for any integration mode.
 *
 * This function is the single source of truth for peak row presentation.
 * It is used both by the interactive panel (via buildPeakTable) and the
 * PDF/HTML report generator (export.js) to guarantee they stay in sync.
 *
 * Per-peak input fields use data-action / data-idx attributes so that a
 * single delegated listener on the tbody can handle all interactions.
 *
 * @param {Object}  pk            - Peak data object.
 * @param {number}  i             - Zero-based peak index within the lane.
 * @param {string}  method        - Integration mode: 'relative' | 'calibration' | 'mw_calibration'
 * @param {Object}  [opts={}]     - Optional calculated values to avoid re-computing per row.
 * @param {number}  [opts.totalArea]  - Sum of all peak areas in the lane.
 * @param {number}  [opts.totalCorr]  - Sum of all corrected areas in the lane.
 * @param {Object}  [opts.calModel]   - Area calibration model (or null).
 * @param {Function}[opts.mwCurve]    - MW calibration function (or null).
 * @param {boolean} [opts.isExport]   - When true, omit interactive data-action attributes.
 * @returns {string} <tr> HTML string.
 */
export function generatePeakRowHTML(pk, i, method, opts = {}) {
  const { totalArea = 0, totalCorr = 0, calModel = null, mwCurve = null, isExport = false } = opts;
  const type      = pk.type || 'N';
  const corrArea  = pk.area / (pk.absRatio || 1);
  const rfDisplay = `${pk.rf.toFixed(3)}${pk.manual ? '<span style="color:#e34c26; margin-left:2px">*</span>' : ''}`;

  // Color coding: Green for standards, red for manual, yellow/default for others
  let nameColor = '#ffd700';
  let rowStyle  = '';
  if (type === 'S') {
    nameColor = '#2ea043';
    rowStyle  = 'background:rgba(46, 160, 67, 0.15)';
  } else if (pk.manual) {
    nameColor = '#e34c26';
    rowStyle  = 'background:rgba(227, 76, 38, 0.15)';
  }

  const nameAttr  = isExport ? '' : `data-action="set-peak-name" data-idx="${i}"`;

  // Shared peak name cell
  const nameCell = isExport ? `<td style="color:${nameColor}; font-weight:600">${escapeHtml(pk.name || '#' + (i + 1))}</td>` : `
    <td style="color:${nameColor}; font-weight:600">
      <input type="text" value="${escapeHtml(pk.name || '#' + (i + 1))}"
             style="background:transparent; border:none; color:inherit; width:60px"
             ${nameAttr}>
    </td>`;

  const areaDisplay = Number(pk.area || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const areaCell = isFittedPeak(pk)
    ? `<td style="text-align:right">${areaDisplay}<small class="fit-area-label" title="Model integral: ${metric(pk.fit_area, 1)} AU">Model allocated · fit ${metric(pk.fit_area, 1)} AU</small></td>`
    : `<td style="text-align:right">${areaDisplay}</td>`;

  // Type-switch cell (S / N / A) - used by calibration modes
  const typeSwitchCell = (showInteractive) => `
    <td style="text-align:center">
      <div class="type-switch">
        <div class="type-option s-type ${type === 'S' ? 'active' : ''}"
             ${showInteractive ? `data-action="set-peak-type" data-idx="${i}" data-type="S"` : ''}>S</div>
        <div class="type-option n-type ${type === 'N' ? 'active' : ''}"
             ${showInteractive ? `data-action="set-peak-type" data-idx="${i}" data-type="N"` : ''}>N</div>
        <div class="type-option a-type ${type === 'A' ? 'active' : ''}"
             ${showInteractive ? `data-action="set-peak-type" data-idx="${i}" data-type="A"` : ''}>A</div>
      </div>
    </td>`;

  // Single-letter type display for exported reports
  const typeCell = isExport
    ? `<td style="text-align:center; font-weight:700">${type}</td>`
    : typeSwitchCell(true);

  // -- MW Calibration mode ----------------------------------------------------
  if (method === 'mw_calibration') {
    let mwCell;
    if (type === 'S') {
      mwCell = isExport
        ? `<td style="text-align:right">${pk.mwValue !== undefined && pk.mwValue !== null && !isNaN(pk.mwValue) ? pk.mwValue : 'N/A'}</td>`
        : `<td style="text-align:right">
             <input type="number" value="${pk.mwValue || ''}" placeholder="MW"
                    style="background:transparent; border:1px solid rgba(255,255,255,0.2);
                           border-radius:4px; color:#58a6ff; width:80px; text-align:right"
                    data-action="set-mw" data-idx="${i}">
           </td>`;
    } else if (type === 'N') {
      mwCell = `<td style="text-align:right"><span style="color:var(--text-dim); font-size:0.7rem">N/A</span></td>`;
    } else {
      const mwVal   = mwCurve ? mwCurve(pk.rf) : null;
      const mwStr   = mwVal !== null ? mwVal.toFixed(1) : '<span style="font-size:0.6rem; opacity:0.6">Need 2+ S</span>';
      mwCell = `<td style="text-align:right"><span style="color:#58a6ff; font-weight:700">${mwStr}</span></td>`;
    }
    return `<tr style="${rowStyle}">${nameCell}<td style="text-align:center">${rfDisplay}</td>${areaCell}${typeCell}${mwCell}</tr>`;
  }

  // -- Area Calibration mode --------------------------------------------------
  if (method === 'calibration') {
    let valCell;
    if (type === 'S') {
      const entered = pk.calibrationValue;
      const displayValue = entered !== undefined && entered !== null && String(entered).trim() !== ''
        && Number.isFinite(Number(entered)) ? escapeHtml(entered) : '';
      valCell = isExport
        ? `<td style="text-align:right">${displayValue || 'N/A'}</td>`
        : `<td style="text-align:right">
              <input type="number" value="${displayValue}" placeholder="Enter val"
                    style="background:transparent; border:1px solid rgba(255,255,255,0.2);
                           border-radius:4px; color:#f0883e; width:80px; text-align:right"
                    data-action="set-calibration" data-idx="${i}">
           </td>`;
    } else if (type === 'N') {
      valCell = `<td style="text-align:right"><span style="color:var(--text-dim); font-size:0.7rem">N/A</span></td>`;
    } else {
      const calVal = calModel?.evaluate ? calModel.evaluate(pk.area) : null;
      const first = calModel?.levels?.[0];
      const last = calModel?.levels?.at(-1);
      const area = Number(pk.area);
      const belowMeasured = !calModel?.error && Number.isFinite(area) && area >= 0 && area < first?.area;
      const aboveMeasured = !calModel?.error && Number.isFinite(area) && area > last?.area;
      const areaNote = !Number.isFinite(calVal) ? ''
        : aboveMeasured
          ? calModel.levels.length === 1
            ? 'Proportional estimate outside standard area; use caution.'
            : 'Linear extrapolation outside standards; use caution.'
          : belowMeasured
            ? calModel.levels.length === 1
              ? 'Proportional estimate from assumed zero point.'
              : 'Interpolation from assumed zero point.'
            : '';
      valCell = `<td style="text-align:right"><span style="color:#238636; font-weight:700">${Number.isFinite(calVal) ? calVal.toFixed(2) : '—'}</span>${areaNote ? `<small class="calibration-extrapolation" style="display:block; font-size:0.65rem">${areaNote}</small>` : ''}</td>`;
    }
    return `<tr style="${rowStyle}">${nameCell}<td style="text-align:center">${rfDisplay}</td>${areaCell}${typeCell}${valCell}</tr>`;
  }

  // -- Relative Intensity mode (default) --------------------------------------
  const pctArea = totalArea > 0 ? ((pk.area / totalArea) * 100).toFixed(1) : 0;
  const pctCorr = totalCorr > 0 ? ((corrArea / totalCorr) * 100).toFixed(1) : 0;

  const absRatioCell = isExport
    ? `<td style="text-align:center">${pk.absRatio || 1}</td>`
    : `<td style="text-align:center">
         <input type="number" step="0.1" value="${pk.absRatio || 1}"
                style="background:transparent; border:1px solid rgba(255,255,255,0.2);
                       border-radius:4px; color:#fff; width:60px; text-align:center"
                data-action="set-abs-ratio" data-idx="${i}">
       </td>`;

  return `<tr style="${rowStyle}">
    ${nameCell}
    <td style="text-align:center">${rfDisplay}</td>
    ${areaCell}
    <td style="text-align:right; font-weight:700">${pctArea}%</td>
    ${absRatioCell}
    <td style="text-align:right; font-weight:700; color:#58a6ff">${pctCorr}%</td>
  </tr>`;
}

//                                                                             
//  EVENT BINDING - Panel-level buttons
//                                                                             

/**
 * Attaches click listeners to the action buttons in the panel header.
 * Called once per renderProfiles() invocation.
 *
 * @param {HTMLElement} container - The panel container element.
 * @param {Object}      l         - The active lane object.
 */
function attachPanelEvents(container, l) {
  // Lane name changes update the lane object and refresh the canvas label
  const laneNameInput = container.querySelector('#lane-name-input');
  if (laneNameInput) {
    laneNameInput.onchange = () => {
      const lane = state.lanes.find(ln => ln.id === l.id);
      if (lane) lane.name = laneNameInput.value;
      render();
    };
  }

  // Export single active lane
  container.querySelector('#btn-export-lane')?.addEventListener('click', () => {
    if (window._exportReport) window._exportReport();
  });

  // Export all lanes as a multi-page report
  container.querySelector('#btn-export-all')?.addEventListener('click', () => {
    if (window._exportReport) window._exportReport('all');
  });

  // Delete all peaks in the active lane (with undo support)
  container.querySelector('#btn-delete-peaks')?.addEventListener('click', () => {
    if (!analysisReady(state)) return;
    saveState();
    state.activeLane.peaks = [];
    state.activeLane.fit_groups = [];
    renderProfiles();
    render();
  });

  container.querySelector('.fit-groups')?.addEventListener('click', event => {
    const button = event.target.closest('[data-action="fit-decision"]');
    if (!button) return;
    const group = fitGroups(l).find(item => item.id === button.dataset.groupId);
    const decision = button.dataset.decision;
    if (!analysisReady(state) || !group || group.status !== 'resolved' || !['split', 'keep'].includes(decision)
        || group.decision === decision) return;
    saveState();
    cancelPendingProfileRequests();
    if (!applyFitDecision(l, group.id, decision)) {
      state.undoStack.pop();
      return;
    }
    state.fitOverrides[group.id] = decision;
    renderProfiles();
    render();
  });

  // Re-run peak detection using current slider settings
  container.querySelector('#btn-reset-integ')?.addEventListener('click', () => {
    updateDensitograms(true);
  });

  // Reset chart zoom to full view
  container.querySelector('#btn-reset-chartview')?.addEventListener('click', () => {
    state.chartView.zoom   = 1;
    state.chartView.offset = 0;
    renderProfiles();
  });

  // Integration method tabs
  container.querySelectorAll('.tab-btn[data-method]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.integrationMethod = btn.dataset.method;
      renderProfiles();
    });
  });
}

//                                                                             
//  EVENT BINDING - Delegated peak table events
//                                                                             

/**
 * Attaches delegated event listeners to the peak table body.
 * All per-peak controls (type switches, value inputs) are handled here
 * via data-action attributes instead of inline onclick/onchange handlers.
 *
 * @param {HTMLElement} container - The panel container element.
 * @param {Object}      l         - The active lane object.
 */
export function attachTableEvents(container, l) {
  const tbody = container.querySelector('#peak-table-body');
  if (!tbody) return;

  // -- Type switch clicks (S / N / A) ----------------------------------------
  tbody.addEventListener('click', e => {
    if (!analysisReady(state)) return;
    const el = e.target.closest('[data-action="set-peak-type"]');
    if (!el) return;
    const idx = parseInt(el.dataset.idx, 10);
    if (isNaN(idx) || !l.peaks[idx]) return;
    l.peaks[idx].type = el.dataset.type;
    renderProfiles();
  });

  // -- Input field changes (MW, calibration value, abs ratio, peak name) ----
  tbody.addEventListener('change', e => {
    if (!analysisReady(state)) return;
    const el  = e.target;
    const idx = parseInt(el.dataset.idx, 10);

    if (el.dataset.action === 'set-mw' && !isNaN(idx)) {
      l.peaks[idx].mwValue = parseFloat(el.value);
      renderProfiles();
    } else if (el.dataset.action === 'set-calibration' && !isNaN(idx)) {
      l.peaks[idx].calibrationValue = parseFloat(el.value);
      renderProfiles();
    } else if (el.dataset.action === 'set-abs-ratio' && !isNaN(idx)) {
      l.peaks[idx].absRatio = parseFloat(el.value) || 1;
      renderProfiles();
    } else if (el.dataset.action === 'set-peak-name' && !isNaN(idx)) {
      l.peaks[idx].name = el.value;
      // No full re-render needed for a name change - just the table would suffice,
      // but renderProfiles is cheap enough here.
    }
  });
}

//                                                                             
//  CHART CANVAS - Drawing
//                                                                             

/**
 * Draws the densitogram chart on the provided canvas element.
 *
 * This function is separated from renderProfiles() so it can be called at
 * high frequency (every mousemove during peak dragging) without touching
 * the DOM table.  Only the canvas pixels are updated.
 *
 * Chart anatomy:
 *   - Horizontal axis: Rf (0.0 = Origin, 1.0 = Front)
 *   - Vertical axis: arbitrary density units (scaled to canvas height)
 *   - Blue filled curve: the Gaussian-smoothed density profile
 *   - Gold/red bands: integration windows for each peak
 *   - Dashed vertical lines: peak apex positions
 *   - Circular handles: boundary drag points (lb, rb)
 *   - Rf labels: shown at apex and on x-axis
 *
 * @param {HTMLCanvasElement} cv - The chart canvas element.
 * @param {Object}            l  - The active lane object.
 */
export function drawProfileChart(cv, l) {
  // Sync the canvas buffer size to its CSS layout size
  cv.width  = cv.clientWidth;
  cv.height = cv.clientHeight;

  const ctx = cv.getContext('2d');
  const p = getAnalysisProfile(l);
  if (p.length === 0) return;

  const fittedSeries = fitGroups(l)
    .filter(group => group.status === 'resolved')
    .map(group => ({ group, series: fitCurveSeries(group, p.length) }))
    .filter(item => item.series);
  let minV = Infinity;
  let maxV = -Infinity;
  const includeRange = value => { minV = Math.min(minV, value); maxV = Math.max(maxV, value); };
  p.forEach(includeRange);
  fittedSeries.forEach(({ series }) => {
    series.total.forEach(includeRange);
    series.components.forEach(component => component.curve.forEach(includeRange));
  });
  const range = (maxV - minV) || 1;

  // Chart padding (pixels) - provides space for axis labels and handles
  const PAD_L = 50, PAD_R = 50, PAD_T = 30, PAD_B = 40;
  const plotW = cv.width  - PAD_L - PAD_R;
  const plotH = cv.height - PAD_T - PAD_B;

  const z   = state.chartView.zoom;
  const off = state.chartView.offset;

  // Map each profile point to a canvas pixel position
  const pts = p.map((val, i) => ({
    x: PAD_L + ((i / (p.length - 1)) * z + off) * plotW,
    y: PAD_T + (1 - (val - minV) / range) * plotH,
  }));

  // -- Grid lines ------------------------------------------------------------
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = PAD_T + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, gy);
    ctx.lineTo(cv.width - PAD_R, gy);
    ctx.stroke();
  }

  // -- Clip to plot area (prevents peaks from drawing over axis labels) -------
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();

  // -- Filled density curve --------------------------------------------------
  ctx.beginPath();
  ctx.moveTo(pts[0].x, PAD_T + plotH);
  pts.forEach(pt => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(pts[pts.length - 1].x, PAD_T + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(31, 111, 235, 0.15)';
  ctx.fill();

  fitGroups(l).filter(group => group.active === true).forEach(group => {
    fitIntegrationSegments(group).forEach(segment => {
      const x0 = PAD_L + ((segment.lb / (p.length - 1)) * z + off) * plotW;
      const x1 = PAD_L + ((segment.rb / (p.length - 1)) * z + off) * plotW;
      ctx.fillStyle = 'rgba(194,151,255,0.14)';
      ctx.fillRect(x0, PAD_T, x1 - x0, plotH);
    });
  });

  // -- Signal line -----------------------------------------------------------
  ctx.beginPath();
  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth   = 2.5;
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.stroke();

  // -- Peak integration windows ----------------------------------------------
  (l.peaks || []).forEach(pk => {
    const fitted = isFittedPeak(pk);
    if (!fitted) ensurePeakBounds(pk, p.length);
    const apexX  = PAD_L + ((pk.idx / (p.length - 1)) * z + off) * plotW;
    const apexHeight = Number.isFinite(pk.height_analysis) ? pk.height_analysis : p[pk.idx];
    const apexY  = PAD_T + (1 - (apexHeight - minV) / range) * plotH;
    const lb_x   = fitted ? null : PAD_L + ((areaLeft(pk)  / (p.length - 1)) * z + off) * plotW;
    const rb_x   = fitted ? null : PAD_L + ((areaRight(pk) / (p.length - 1)) * z + off) * plotW;

    // Green for standards ('S'), red for manual/added/modified, yellow for all others
    let color, rgbaFill, rgbaLine;
    if (fitted) {
      color    = '#c297ff';
      rgbaLine = 'rgba(194, 151, 255, 0.8)';
    } else if (pk.type === 'S') {
      color    = '#2ea043';
      rgbaFill = 'rgba(46, 160, 67, 0.25)';
      rgbaLine = 'rgba(46, 160, 67, 0.7)';
    } else if (pk.manual) {
      color    = '#e34c26';
      rgbaFill = 'rgba(227, 76, 38, 0.2)';
      rgbaLine = 'rgba(227, 76, 38, 0.6)';
    } else {
      color    = '#ffd700';
      rgbaFill = 'rgba(255, 215, 0, 0.2)';
      rgbaLine = 'rgba(255, 215, 0, 0.6)';
    }

    // The fill, edge lines, and drag handles all use the one Width-controlled
    // interval that is also used for AUC.
    if (!fitted) {
      ctx.fillStyle = rgbaFill;
      ctx.fillRect(lb_x, PAD_T, rb_x - lb_x, plotH);

      // Boundary edge lines and draggable handles apply only to direct areas.
      ctx.strokeStyle = rgbaLine;
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.moveTo(lb_x, PAD_T); ctx.lineTo(lb_x, PAD_T + plotH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rb_x, PAD_T); ctx.lineTo(rb_x, PAD_T + plotH); ctx.stroke();
      ctx.beginPath();
      ctx.arc(lb_x, PAD_T + plotH / 2, 4, 0, Math.PI * 2);
      ctx.arc(rb_x, PAD_T + plotH / 2, 4, 0, Math.PI * 2);
      ctx.fillStyle = rgbaLine;
      ctx.fill();
    }

    // Apex dashed vertical line
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = rgbaLine;
    ctx.beginPath();
    ctx.moveTo(apexX, apexY);
    ctx.lineTo(apexX, PAD_T + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Apex dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(apexX, apexY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Rf label above apex
    ctx.font        = 'bold 10px Roboto Mono';
    ctx.fillStyle   = color;
    ctx.textAlign   = 'center';
    ctx.fillText((fitted ? 'fit ' : pk.manual ? '*' : '') + pk.rf.toFixed(2), apexX, apexY - 12);
  });

  // Model curves are drawn over the measured trace. Kept candidates remain a
  // dashed preview; their components are never treated as measured points.
  const strokeFit = (values, firstIndex, color, width, dashed, opacity) => {
    ctx.beginPath();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [7, 5] : []);
    values.forEach((value, offset) => {
      const index = firstIndex + offset;
      const x = PAD_L + ((index / (p.length - 1)) * z + off) * plotW;
      const y = PAD_T + (1 - (value - minV) / range) * plotH;
      if (offset === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };
  fittedSeries.forEach(({ group, series }) => {
    const preview = group.active !== true;
    strokeFit(series.total, series.lb, '#70e1d0', 2.5, preview, preview ? 0.65 : 1);
    series.components.forEach((component, index) => {
      strokeFit(component.curve, series.lb, index % 2 ? '#ffb86b' : '#c297ff',
        1.8, true, preview ? 0.55 : 0.95);
    });
  });

  ctx.restore(); // remove clip

  // -- Axis labels -----------------------------------------------------------
  ctx.font      = 'bold 11px Inter';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b949e';
  ctx.fillText('ORIGIN (0.0)', PAD_L,              cv.height - 15);
  ctx.fillText('FRONT (1.0)',  cv.width - PAD_R,   cv.height - 15);
}

//                                                                             
//  CHART CANVAS - Interaction (mouse wheel, drag, peak add/delete)
//                                                                             

/**
 * Wires up all mouse and wheel event handlers on the chart canvas.
 * These handlers implement:
 *   - Horizontal zoom via mouse wheel
 *   - Peak boundary drag (resize integration window)
 *   - Peak apex drag (move peak location)
 *   - Single click on empty space -> add new peak
 *   - Right-click on apex -> delete peak
 *   - Dynamic cursor changes (col-resize / pointer / crosshair)
 *   - Double-click -> re-run peak detection
 *
 * @param {HTMLCanvasElement} cv - The chart canvas element.
 * @param {Object}            l  - The active lane object.
 */
export function setupChartInteractions(cv, l) {
  // Compute layout constants once (must match drawProfileChart)
  const PAD_L = 50, PAD_R = 50, PAD_T = 30, PAD_B = 40;
  const plotW = cv.width  - PAD_L - PAD_R;
  const plotH = cv.height - PAD_T - PAD_B;

  // All editing uses the backend's canonical origin-to-front normalized signal.
  const p = getAnalysisProfile(l);
  if (p.length < 2) return;

  /**
   * Converts a canvas-X pixel position to a profile array index.
   * Accounts for the current zoom and offset of chartView.
   */
  const xToIdx = mx => {
    const z   = state.chartView.zoom;
    const off = state.chartView.offset;
    return Math.max(0, Math.min(p.length - 1,
      Math.round((((mx - PAD_L) / plotW) - off) / z * (p.length - 1))
    ));
  };

  /**
   * Returns the canvas-X for a given profile index.
   */
  const idxToX = idx => {
    const z   = state.chartView.zoom;
    const off = state.chartView.offset;
    return PAD_L + ((idx / (p.length - 1)) * z + off) * plotW;
  };

  // -- Horizontal zoom via mouse wheel ---------------------------------------
  cv.onwheel = e => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    if (mx < PAD_L || mx > cv.width - PAD_R) return;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;   // scroll down = zoom out
    const oldZ       = state.chartView.zoom;
    const newZ       = Math.min(50, Math.max(1, oldZ * zoomFactor));

    // Anchor the zoom to the cursor's fractional position in the plot
    const f                  = (mx - PAD_L) / plotW;
    state.chartView.offset   = f - (f - state.chartView.offset) * (newZ / oldZ);
    state.chartView.zoom     = newZ;

    // At zoom=1 there is no offset needed
    if (state.chartView.zoom === 1) state.chartView.offset = 0;

    drawProfileChart(cv, l);
  };

  // -- Mouse down - hit detection and drag start -----------------------------
  cv.onmousedown = me => {
    if (!analysisReady(state)) return;
    const rect = cv.getBoundingClientRect();
    const mx   = me.clientX - rect.left;
    const idx  = xToIdx(mx);
    if (isInsideActiveFit(l, idx)) return;

    // Detect if the cursor is on a peak apex or boundary handle
    let hitBound = null;   // {pk, type:'lb'|'rb'}
    let hitApex  = null;   // peak object

    for (const pk of (l.peaks || [])) {
      if (isFittedPeak(pk)) continue;
      const apexX = idxToX(pk.idx);
      ensurePeakBounds(pk, p.length);
      const lb_x  = idxToX(areaLeft(pk));
      const rb_x  = idxToX(areaRight(pk));

      // Boundary handles can sit close to the apex for narrow peaks. Give an
      // exact handle hit priority so those Width-controlled edges stay
      // draggable; the wider apex tolerance is only a fallback.
      if (Math.abs(mx - lb_x) < 10)          hitBound = { pk, type: 'lb' };
      else if (Math.abs(mx - rb_x) < 10)     hitBound = { pk, type: 'rb' };
      else if (Math.abs(mx - apexX) < 20)    hitApex  = pk;
    }

    // Right-click on apex: delete the peak
    if (me.button === 2) {
      if (hitApex) {
        saveState();
        invalidateKeptFitGroup(l, hitApex, state.fitOverrides);
        l.peaks = l.peaks.filter(pk => pk !== hitApex);
        renderProfiles();
        render();
      }
      return;
    }

    if (hitApex) {
      // Start apex drag
      saveState();
      state.isDraggingPeak = hitApex;
    } else if (hitBound) {
      // Start boundary drag
      saveState();
      state.isDraggingBound = hitBound;
    } else {
      // No hit - create a new peak at the clicked position
      const rf = calculateRf(idx, p.length);
      if (rf < 0 || rf > 1) return;  // Outside valid Rf range

      const threshold = parseFloat($('peak-threshold')?.value || 50);
      const peak = { idx, rf, manual: true, type: 'N' };
      setPeakFromApex(peak, p, idx, threshold);
      if (overlapsActiveFit(l, peak.area_lb, peak.area_rb)) return;
      saveState();
      l.peaks.push(peak);
      l.peaks.sort((a, b) => a.idx - b.idx);
      renderProfiles();
      render();
    }
  };

  // -- Double-click - reset peak detection -----------------------------------
  cv.ondblclick = () => { if (analysisReady(state)) updateDensitograms(true); };

  // -- Mouse move - handle drags and cursor feedback -------------------------
  cv.onmousemove = me => {
    if (!analysisReady(state)) {
      state.isDraggingPeak = null;
      state.isDraggingBound = null;
      cv.style.cursor = 'wait';
      return;
    }
    const rect = cv.getBoundingClientRect();
    const mx   = me.clientX - rect.left;
    const idx  = xToIdx(mx);

    // -- Dynamic cursor feedback (no active drag) ---------------------------
    if (!state.isDraggingBound && !state.isDraggingPeak) {
      let cursor = isInsideActiveFit(l, idx) ? 'not-allowed' : 'crosshair';
      for (const pk of (l.peaks || [])) {
        if (isFittedPeak(pk)) continue;
        ensurePeakBounds(pk, p.length);
        const lb_x  = idxToX(areaLeft(pk));
        const rb_x  = idxToX(areaRight(pk));
        const apexX = idxToX(pk.idx);
        if (Math.abs(mx - lb_x) < 8 || Math.abs(mx - rb_x) < 8) cursor = 'col-resize';
        else if (Math.abs(mx - apexX) < 10)                       cursor = 'pointer';
      }
      cv.style.cursor = cursor;
    }

    // -- Boundary drag -----------------------------------------------------
    if (state.isDraggingBound) {
      const { pk, type } = state.isDraggingBound;
      ensurePeakBounds(pk, p.length);
      const proposedLeft = type === 'lb' ? Math.min(areaRight(pk) - 1, Math.max(0, idx)) : areaLeft(pk);
      const proposedRight = type === 'rb' ? Math.max(areaLeft(pk) + 1, Math.min(p.length - 1, idx)) : areaRight(pk);
      if (overlapsActiveFit(l, proposedLeft, proposedRight)) return;
      pk.area_lb = proposedLeft;
      pk.area_rb = proposedRight;
      pk.lb = pk.area_lb;
      pk.rb = pk.area_rb;
      pk.display_lb = pk.area_lb;
      pk.display_rb = pk.area_rb;
      pk.manual = true;
      pk.area = calculatePeakArea(p, pk.area_lb, pk.area_rb);
      invalidateKeptFitGroup(l, pk, state.fitOverrides);

      // Redraw chart only (not the table) during drag for smooth feedback
      drawProfileChart(cv, l);
      render();
      return;
    }

    // -- Apex drag ----------------------------------------------------------
    if (!state.isDraggingPeak) return;
    const pk = state.isDraggingPeak;
    const rf = calculateRf(idx, p.length);
    if (rf < 0 || rf > 1) return;   // Prevent dragging outside valid Rf range

    const proposed = { ...pk };
    setPeakFromApex(proposed, p, idx, parseFloat($('peak-threshold')?.value || 50));
    if (overlapsActiveFit(l, proposed.area_lb, proposed.area_rb)) return;
    Object.assign(pk, proposed);
    invalidateKeptFitGroup(l, pk, state.fitOverrides);

    // Redraw chart only during drag; table updates on mouseup (see events.js)
    drawProfileChart(cv, l);
    render();
  };

  // -- Mouse up - end any active drag ----------------------------------------
  cv.onmouseup = () => {
    if (!analysisReady(state)) {
      state.isDraggingPeak = null;
      state.isDraggingBound = null;
      return;
    }
    // After a drag ends, do a full renderProfiles() to update the table with
    // the new area values that accumulated during the drag.
    const wasDragging = state.isDraggingPeak || state.isDraggingBound;
    state.isDraggingPeak  = null;
    state.isDraggingBound = null;
    if (wasDragging) renderProfiles();
  };

  // -- Context menu - suppress browser right-click menu on chart -------------
  cv.oncontextmenu = e => e.preventDefault();
}
