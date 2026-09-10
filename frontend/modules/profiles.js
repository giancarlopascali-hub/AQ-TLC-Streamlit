/**
 * @module profiles
 * @file modules/profiles.js
 *
 * Densitogram panel — right-hand analysis sidebar of AQ-TLC.
 *
 * PUBLIC API
 * ──────────
 *   renderProfiles()   — Full panel rebuild. Call whenever the active lane changes
 *                        or the integration method switches.
 *   drawProfileChart() — Redraws ONLY the canvas chart. Called every mousemove
 *                        during peak/boundary dragging to avoid rebuilding DOM.
 *
 * INTERNAL HELPERS
 * ────────────────
 *   buildPanelHeader()   — Lane name, export buttons, action buttons, tab strip.
 *   buildPeakTable()     — Table HTML for the three integration modes.
 *   generatePeakRowHTML() — Single row HTML (used by buildPeakTable and export.js).
 *   setupChartInteractions() — Mouse/wheel event handlers on the chart canvas.
 *
 * GLOBAL BRIDGE
 * ─────────────
 * A small set of functions are deliberately placed on `window` by the main entry
 * point (app.js) so that inline onchange handlers in the dynamically generated
 * per-peak input fields can reference them without circular module imports.
 * This is an explicit, documented architectural decision — see app.js for the full list.
 */

import { state, $                                          } from './state.js';
import { calculateRf, calculateCalibrationCurve,
         calculateMWCalibrationCurve                       } from './analysis.js';
import { updateDensitograms                                } from './api.js';
import { render                                            } from './render.js';
import { saveState                                         } from './workspace.js';

// ════════════════════════════════════════════════════════════════════════════
//  MAIN ENTRY — Full panel rebuild
// ════════════════════════════════════════════════════════════════════════════

/**
 * Completely rebuilds the right-hand analysis panel from the current state.
 *
 * This replaces the entire `#densitogram-list` innerHTML.  It is intentionally
 * NOT called on every mousemove — use drawProfileChart() for that instead.
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

  // Empty state — no active lane selected
  if (!state.activeLane) {
    list.innerHTML = `<div class="empty-state" style="text-align:center; padding:50px; opacity:0.5">
      Select a lane to view analysis
    </div>`;
    return;
  }

  const l = state.activeLane;

  // ── Build the panel HTML ───────────────────────────────────────────────────
  const container = document.createElement('div');
  container.innerHTML = buildPanelHeader(l);
  list.appendChild(container);

  // ── Attach event listeners to panel-level buttons ─────────────────────────
  // These are attached here (not via inline onclick) to keep JS out of HTML.
  attachPanelEvents(container, l);

  // ── Attach delegated listeners to the peak table body ─────────────────────
  // Per-peak controls (type switch, value inputs) use data-action attributes
  // so they can be handled by a single delegated listener rather than N inline handlers.
  attachTableEvents(container, l);

  // ── Draw the chart and set up its interactions ────────────────────────────
  // Use setTimeout(0) to allow the DOM to flush the new canvas element's layout
  // before reading its clientWidth/clientHeight for the drawing buffer size.
  setTimeout(() => {
    const cv = $('chart-active');
    if (!cv) return;
    drawProfileChart(cv, l);
    setupChartInteractions(cv, l);
  }, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  PANEL HTML BUILDERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generates the HTML for the lane header, action buttons, and tab strip.
 *
 * @param {Object} l - The active lane object.
 * @returns {string} HTML string.
 */
function buildPanelHeader(l) {
  const method = state.integrationMethod;

  return `
    <div style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center">
      <input type="text" id="lane-name-input" value="${l.name || 'Lane ' + l.id}"
             style="background:transparent; border:none; color:white; font-family:Outfit;
                    font-size:1.2rem; font-weight:700; width:150px">
      <div style="display:flex; gap:6px">
        <button id="btn-export-lane" class="action-btn secondary"
                style="font-size:0.75rem; padding:4px 10px" title="Export this active lane">
          📄 Export Lane
        </button>
        <button id="btn-export-all" class="action-btn primary"
                style="font-size:0.75rem; padding:4px 10px" title="Export all detected lanes">
          📚 Full Report
        </button>
      </div>
    </div>

    <div style="margin-bottom:10px; display:flex; gap:6px; flex-wrap:wrap;">
      <button id="btn-delete-peaks"    class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px">🗑️ Delete all peaks</button>
      <button id="btn-reset-integ"     class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px">🔄 Reset integration</button>
      <button id="btn-reset-chartview" class="action-btn secondary" style="font-size:0.65rem; padding:3px 8px">🔍 Reset view</button>
    </div>

    <canvas id="chart-active" style="width:100%; height:280px; background:#010409;
            border:1px solid var(--border); border-radius:8px; cursor:crosshair"></canvas>

    <div class="integration-table-wrap" style="margin-top:20px">
      <div class="tabs-nav">
        <button class="tab-btn ${method === 'relative'      ? 'active' : ''}" data-method="relative"      >Relative Intensity</button>
        <button class="tab-btn ${method === 'calibration'   ? 'active' : ''}" data-method="calibration"   >Area Calibration</button>
        <button class="tab-btn ${method === 'mw_calibration'? 'active' : ''}" data-method="mw_calibration">MW Calibration</button>
      </div>
      ${buildPeakTable(l)}
    </div>
  `;
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
  const calCurve     = method === 'calibration'    ? calculateCalibrationCurve()   : null;
  const mwCurve      = method === 'mw_calibration' ? calculateMWCalibrationCurve() : null;

  // Build column headers based on integration mode
  const headers = method === 'mw_calibration'
    ? `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area</th><th style="text-align:center">Type</th><th style="text-align:right">MW (kDa)</th>`
    : method === 'calibration'
    ? `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area</th><th style="text-align:center">Type</th><th style="text-align:right">Value</th>`
    : `<th style="text-align:left">Peak</th><th style="text-align:center">Rf</th><th style="text-align:right">Area</th><th style="text-align:right">%</th><th style="text-align:center">Abs Ratio</th><th style="text-align:right">% Corr.</th>`;

  const rows = peaks.map((pk, i) =>
    generatePeakRowHTML(pk, i, method, { totalArea, totalCorr, calCurve, mwCurve })
  ).join('');

  return `
    <table class="integration-table" style="width:100%">
      <thead><tr style="border-bottom:2px solid var(--border)">${headers}</tr></thead>
      <tbody id="peak-table-body">${rows}</tbody>
    </table>
  `;
}

// ════════════════════════════════════════════════════════════════════════════
//  PEAK ROW HTML — shared by profiles panel and export.js
// ════════════════════════════════════════════════════════════════════════════

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
 * @param {Function}[opts.calCurve]   - Area calibration function (or null).
 * @param {Function}[opts.mwCurve]    - MW calibration function (or null).
 * @param {boolean} [opts.isExport]   - When true, omit interactive data-action attributes.
 * @returns {string} <tr> HTML string.
 */
export function generatePeakRowHTML(pk, i, method, opts = {}) {
  const { totalArea = 0, totalCorr = 0, calCurve = null, mwCurve = null, isExport = false } = opts;
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
  const nameCell = `
    <td style="color:${nameColor}; font-weight:600">
      <input type="text" value="${pk.name || '#' + (i + 1)}"
             style="background:transparent; border:none; color:inherit; width:60px"
             ${nameAttr}>
    </td>`;

  // Type-switch cell (S / N / A) — used by calibration modes
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

  // ── MW Calibration mode ────────────────────────────────────────────────────
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
    const areaDisplay = pk.area.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `<tr style="${rowStyle}">${nameCell}<td style="text-align:center">${rfDisplay}</td><td style="text-align:right">${areaDisplay}</td>${typeCell}${mwCell}</tr>`;
  }

  // ── Area Calibration mode ──────────────────────────────────────────────────
  if (method === 'calibration') {
    let valCell;
    if (type === 'S') {
      valCell = isExport
        ? `<td style="text-align:right">${pk.calibrationValue !== undefined ? pk.calibrationValue : 'N/A'}</td>`
        : `<td style="text-align:right">
             <input type="number" value="${pk.calibrationValue || ''}" placeholder="Enter val"
                    style="background:transparent; border:1px solid rgba(255,255,255,0.2);
                           border-radius:4px; color:#f0883e; width:80px; text-align:right"
                    data-action="set-calibration" data-idx="${i}">
           </td>`;
    } else if (type === 'N') {
      valCell = `<td style="text-align:right"><span style="color:var(--text-dim); font-size:0.7rem">N/A</span></td>`;
    } else {
      const calVal = calCurve ? calCurve(pk.area) : null;
      valCell = `<td style="text-align:right"><span style="color:#238636; font-weight:700">${calVal !== null ? calVal.toFixed(2) : '-'}</span></td>`;
    }
    const areaDisplay = pk.area.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `<tr style="${rowStyle}">${nameCell}<td style="text-align:center">${rfDisplay}</td><td style="text-align:right">${areaDisplay}</td>${typeCell}${valCell}</tr>`;
  }

  // ── Relative Intensity mode (default) ──────────────────────────────────────
  const pctArea = totalArea > 0 ? ((pk.area / totalArea) * 100).toFixed(1) : 0;
  const pctCorr = totalCorr > 0 ? ((corrArea / totalCorr) * 100).toFixed(1) : 0;
  const areaDisplay = pk.area.toLocaleString(undefined, { maximumFractionDigits: 1 });

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
    <td style="text-align:right">${areaDisplay}</td>
    <td style="text-align:right; font-weight:700">${pctArea}%</td>
    ${absRatioCell}
    <td style="text-align:right; font-weight:700; color:#58a6ff">${pctCorr}%</td>
  </tr>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  EVENT BINDING — Panel-level buttons
// ════════════════════════════════════════════════════════════════════════════

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
    saveState();
    state.activeLane.peaks = [];
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

// ════════════════════════════════════════════════════════════════════════════
//  EVENT BINDING — Delegated peak table events
// ════════════════════════════════════════════════════════════════════════════

/**
 * Attaches delegated event listeners to the peak table body.
 * All per-peak controls (type switches, value inputs) are handled here
 * via data-action attributes instead of inline onclick/onchange handlers.
 *
 * @param {HTMLElement} container - The panel container element.
 * @param {Object}      l         - The active lane object.
 */
function attachTableEvents(container, l) {
  const tbody = container.querySelector('#peak-table-body');
  if (!tbody) return;

  // ── Type switch clicks (S / N / A) ────────────────────────────────────────
  tbody.addEventListener('click', e => {
    const el = e.target.closest('[data-action="set-peak-type"]');
    if (!el) return;
    const idx = parseInt(el.dataset.idx, 10);
    if (isNaN(idx) || !l.peaks[idx]) return;
    l.peaks[idx].type = el.dataset.type;
    renderProfiles();
  });

  // ── Input field changes (MW, calibration value, abs ratio, peak name) ────
  tbody.addEventListener('change', e => {
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
      // No full re-render needed for a name change — just the table would suffice,
      // but renderProfiles is cheap enough here.
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  CHART CANVAS — Drawing
// ════════════════════════════════════════════════════════════════════════════

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
  const raw = l.profile;
  if (!raw || raw.length === 0) return;

  // The profile from the server is stored Origin→Front.
  // Reverse it so index 0 = Front (Rf≈1, left of chart), matching the chart axis.
  const p = raw.slice().reverse();

  const minV  = Math.min(...p);
  const maxV  = Math.max(...p);
  const range = (maxV - minV) || 1;

  // Chart padding (pixels) — provides space for axis labels and handles
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

  // ── Grid lines ────────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = PAD_T + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, gy);
    ctx.lineTo(cv.width - PAD_R, gy);
    ctx.stroke();
  }

  // ── Clip to plot area (prevents peaks from drawing over axis labels) ───────
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();

  // ── Filled density curve ──────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(pts[0].x, PAD_T + plotH);
  pts.forEach(pt => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(pts[pts.length - 1].x, PAD_T + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(31, 111, 235, 0.15)';
  ctx.fill();

  // ── Signal line ───────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth   = 2.5;
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.stroke();

  // ── Peak integration windows ──────────────────────────────────────────────
  (l.peaks || []).forEach(pk => {
    const apexX  = PAD_L + ((pk.idx / (p.length - 1)) * z + off) * plotW;
    const apexY  = PAD_T + (1 - (pk.height - minV) / range) * plotH;
    const lb_x   = PAD_L + ((pk.lb  / (p.length - 1)) * z + off) * plotW;
    const rb_x   = PAD_L + ((pk.rb  / (p.length - 1)) * z + off) * plotW;

    // Green for standards ('S'), red for manual/added/modified, yellow for all others
    let color, rgbaFill, rgbaLine;
    if (pk.type === 'S') {
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

    // Integration boundary fill
    ctx.fillStyle = rgbaFill;
    ctx.fillRect(lb_x, PAD_T, rb_x - lb_x, plotH);

    // Boundary edge lines
    ctx.strokeStyle = rgbaLine;
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(lb_x, PAD_T); ctx.lineTo(lb_x, PAD_T + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rb_x, PAD_T); ctx.lineTo(rb_x, PAD_T + plotH); ctx.stroke();

    // Drag handles — circular dots at mid-height of boundary lines
    ctx.beginPath();
    ctx.arc(lb_x, PAD_T + plotH / 2, 4, 0, Math.PI * 2);
    ctx.arc(rb_x, PAD_T + plotH / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = rgbaLine;
    ctx.fill();

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
    ctx.fillText((pk.manual ? '*' : '') + pk.rf.toFixed(2), apexX, apexY - 12);
  });

  ctx.restore(); // remove clip

  // ── Axis labels ───────────────────────────────────────────────────────────
  ctx.font      = 'bold 11px Inter';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b949e';
  ctx.fillText('ORIGIN (0.0)', PAD_L,              cv.height - 15);
  ctx.fillText('FRONT (1.0)',  cv.width - PAD_R,   cv.height - 15);
}

// ════════════════════════════════════════════════════════════════════════════
//  CHART CANVAS — Interaction (mouse wheel, drag, peak add/delete)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wires up all mouse and wheel event handlers on the chart canvas.
 * These handlers implement:
 *   - Horizontal zoom via mouse wheel
 *   - Peak boundary drag (resize integration window)
 *   - Peak apex drag (move peak location)
 *   - Single click on empty space → add new peak
 *   - Right-click on apex → delete peak
 *   - Dynamic cursor changes (col-resize / pointer / crosshair)
 *   - Double-click → re-run peak detection
 *
 * @param {HTMLCanvasElement} cv - The chart canvas element.
 * @param {Object}            l  - The active lane object.
 */
function setupChartInteractions(cv, l) {
  // Compute layout constants once (must match drawProfileChart)
  const PAD_L = 50, PAD_R = 50, PAD_T = 30, PAD_B = 40;
  const plotW = cv.width  - PAD_L - PAD_R;
  const plotH = cv.height - PAD_T - PAD_B;

  // Reverse the profile so chart x-axis runs Front→Origin (matching Rf direction)
  const raw = l.profile;
  const p   = (raw || []).slice().reverse();

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

  // ── Horizontal zoom via mouse wheel ───────────────────────────────────────
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

  // ── Mouse down — hit detection and drag start ─────────────────────────────
  cv.onmousedown = me => {
    const rect = cv.getBoundingClientRect();
    const mx   = me.clientX - rect.left;
    const idx  = xToIdx(mx);

    // Detect if the cursor is on a peak apex or boundary handle
    let hitBound = null;   // {pk, type:'lb'|'rb'}
    let hitApex  = null;   // peak object

    for (const pk of (l.peaks || [])) {
      const apexX = idxToX(pk.idx);
      const lb_x  = idxToX(pk.lb);
      const rb_x  = idxToX(pk.rb);

      if (Math.abs(mx - apexX) < 20)        hitApex  = pk;
      else if (Math.abs(mx - lb_x) < 10)    hitBound = { pk, type: 'lb' };
      else if (Math.abs(mx - rb_x) < 10)    hitBound = { pk, type: 'rb' };
    }

    // Right-click on apex: delete the peak
    if (me.button === 2) {
      if (hitApex) {
        saveState();
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
      // No hit — create a new peak at the clicked position
      const rf = calculateRf(idx, p.length);
      if (rf < 0 || rf > 1) return;  // Outside valid Rf range

      saveState();
      const val = p[idx];

      // Walk left and right to find the natural signal valley bounds
      let lb = idx, rb = idx;
      while (lb > 0             && p[lb - 1] <= p[lb]) lb--;
      while (rb < p.length - 1  && p[rb + 1] <= p[rb]) rb++;

      // Determine the integration window using the current Width% threshold
      const base    = Math.min(p[lb], p[rb]);
      const thresh  = base + (val - base) * (parseFloat($('peak-threshold')?.value || 50) / 100);
      let v_lb = lb, v_rb = rb;
      for (let j = idx; j > lb; j--) if (p[j] < thresh) { v_lb = j; break; }
      for (let j = idx; j < rb; j++) if (p[j] < thresh) { v_rb = j; break; }

      // Trapezoidal area under the curve, above baseline
      let area = 0;
      for (let k = v_lb; k < v_rb; k++) area += (p[k] + p[k + 1]) / 2 - base;

      l.peaks.push({ idx, rf, height: val, area: Math.max(0, area), lb: v_lb, rb: v_rb, manual: true, type: 'N' });
      l.peaks.sort((a, b) => a.idx - b.idx);
      renderProfiles();
      render();
    }
  };

  // ── Double-click — reset peak detection ───────────────────────────────────
  cv.ondblclick = () => updateDensitograms(true);

  // ── Mouse move — handle drags and cursor feedback ─────────────────────────
  cv.onmousemove = me => {
    const rect = cv.getBoundingClientRect();
    const mx   = me.clientX - rect.left;
    const idx  = xToIdx(mx);

    // ── Dynamic cursor feedback (no active drag) ───────────────────────────
    if (!state.isDraggingBound && !state.isDraggingPeak) {
      let cursor = 'crosshair';
      for (const pk of (l.peaks || [])) {
        const lb_x  = idxToX(pk.lb);
        const rb_x  = idxToX(pk.rb);
        const apexX = idxToX(pk.idx);
        if (Math.abs(mx - lb_x) < 8 || Math.abs(mx - rb_x) < 8) cursor = 'col-resize';
        else if (Math.abs(mx - apexX) < 10)                       cursor = 'pointer';
      }
      cv.style.cursor = cursor;
    }

    // ── Boundary drag ─────────────────────────────────────────────────────
    if (state.isDraggingBound) {
      const { pk, type } = state.isDraggingBound;
      if (type === 'lb') pk.lb = Math.min(pk.rb - 1, Math.max(0, idx));
      else               pk.rb = Math.max(pk.lb + 1, Math.min(p.length - 1, idx));
      pk.manual = true;

      // Recalculate area with the new boundary
      const base = Math.min(p[pk.lb], p[pk.rb]);
      let area   = 0;
      for (let k = pk.lb; k < pk.rb; k++) area += (p[k] + p[k + 1]) / 2 - base;
      pk.area = Math.max(0, area);

      // Redraw chart only (not the table) during drag for smooth feedback
      drawProfileChart(cv, l);
      render();
      return;
    }

    // ── Apex drag ──────────────────────────────────────────────────────────
    if (!state.isDraggingPeak) return;
    const pk = state.isDraggingPeak;
    const rf = calculateRf(idx, p.length);
    if (rf < 0 || rf > 1) return;   // Prevent dragging outside valid Rf range

    pk.idx    = idx;
    pk.rf     = rf;
    pk.height = p[idx];
    pk.manual = true;

    // Recalculate the integration window around the new apex position
    let lb = idx, rb = idx;
    while (lb > 0            && p[lb - 1] <= p[lb]) lb--;
    while (rb < p.length - 1 && p[rb + 1] <= p[rb]) rb++;
    const base   = Math.min(p[lb], p[rb]);
    const thresh = base + (p[idx] - base) * (parseFloat($('peak-threshold')?.value || 50) / 100);
    let v_lb = lb, v_rb = rb;
    for (let j = idx; j > lb; j--) if (p[j] < thresh) { v_lb = j; break; }
    for (let j = idx; j < rb; j++) if (p[j] < thresh) { v_rb = j; break; }
    pk.lb = v_lb;
    pk.rb = v_rb;

    // Trapezoidal area under the new window
    let area = 0;
    for (let k = v_lb; k < v_rb; k++) area += (p[k] + p[k + 1]) / 2 - base;
    pk.area = Math.max(0, area);

    // Redraw chart only during drag; table updates on mouseup (see events.js)
    drawProfileChart(cv, l);
    render();
  };

  // ── Mouse up — end any active drag ────────────────────────────────────────
  cv.onmouseup = () => {
    // After a drag ends, do a full renderProfiles() to update the table with
    // the new area values that accumulated during the drag.
    const wasDragging = state.isDraggingPeak || state.isDraggingBound;
    state.isDraggingPeak  = null;
    state.isDraggingBound = null;
    if (wasDragging) renderProfiles();
  };

  // ── Context menu — suppress browser right-click menu on chart ─────────────
  cv.oncontextmenu = e => e.preventDefault();
}
