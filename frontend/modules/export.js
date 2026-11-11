/**
 * @module export
 * @file modules/export.js
 *
 * Report generation engine - builds and exports analytical HTML/PDF reports.
 */

import { state } from './state.js';
import { buildFitGroupsHTML, generatePeakRowHTML } from './profiles.js';
import { calculateCalibrationCurve, calculateMWCalibrationCurve } from './analysis.js';
import { analysisReady, fitCurveSeries, fitGroups, fitIntegrationSegments, isFittedPeak } from './shoulder.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeFileName(value, fallback = 'AQ-TLC_Report') {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** The report curve and fitted overlays must use the same analytical scale. */
export function getReportProfile(lane) {
  return Array.isArray(lane.profile_analysis) && lane.profile_analysis.length
    ? lane.profile_analysis
    : [...(lane.profile || [])].reverse();
}

let _lastDownloadUrl = null;

function offerReportDownload(reportHtml, fileName, autoClick = false) {
  if (_lastDownloadUrl) URL.revokeObjectURL(_lastDownloadUrl);
  _lastDownloadUrl = URL.createObjectURL(new Blob([reportHtml], { type: 'text/html' }));
  let link = document.getElementById('report-download-link');
  if (!link) {
    link = document.createElement('a');
    link.id = 'report-download-link';
    link.className = 'report-download-link';
    const host = document.getElementById('densitogram-list') || document.body;
    if (typeof host.prepend === 'function') host.prepend(link);
    else host.appendChild(link);
  }
  link.href = _lastDownloadUrl;
  link.download = fileName;
  link.textContent = 'Download report HTML';
  link.title = fileName;
  // Keep the link available even if a browser hides the popup WindowProxy.
  if (autoClick) link.click();
}

/**
 * Generates an analytical report for the active lane or all lanes.
 *
 * @param {string|null} type - 'all' for full report of all lanes, or null for active lane only.
 */
export async function exportReport(type = null) {
  if (!analysisReady(state)) {
    alert('Analysis is still updating or needs a successful retry before export.');
    return;
  }
  let lanesToExport = [];
  let isFullReport = false;

  if (type === 'all') {
    lanesToExport = state.lanes;
    isFullReport = true;
  } else {
    if (!state.activeLane) {
      alert('Please select a lane first.');
      return;
    }
    lanesToExport = [state.activeLane];
  }

  if (!lanesToExport || lanesToExport.length === 0) {
    alert('No lanes to export.');
    return;
  }

  // Claim the popup while the export click still has user activation. Waiting
  // for an image before window.open can make browsers silently block it.
  let win = null;
  try { win = window.open('', '_blank'); } catch (error) {
    console.warn('Report popup was blocked; preparing a download link.', error);
  }
  if (win) {
    try {
      win.document.write('<!doctype html><title>Preparing AQ-TLC report</title><p>Preparing report…</p>');
      win.document.close();
    } catch (error) {
      console.warn('Report popup could not be written; preparing a download link.', error);
      win = null;
    }
  }

  let img = state.imgEl;
  if (!img?.complete || img.naturalWidth <= 0) {
    img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('The plate image could not be loaded for the report.'));
        img.src = state.imgB64;
        if (img.complete && img.naturalWidth > 0) resolve();
      });
    } catch (error) {
      if (win) {
        win.document.open();
        win.document.write('<p>The plate image could not be loaded. Please try Export again.</p>');
        win.document.close();
      }
      alert(error.message);
      return;
    }
  }

  let reportHtml = `<html><head><title>AQ-TLC Analytical Report</title><style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1a1a1a; max-width: 1000px; margin: auto; }
        .page-break { page-break-after: always; margin-bottom: 60px; }
        .header { display: flex; justify-content: space-between; border-bottom: 3px solid #ffc107; padding-bottom: 15px; margin-bottom: 30px; }
        .stack-wrap { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); background: #000; padding-bottom: 10px; }
        .lane-strip-area { position: relative; height: 100px; background: #000; overflow: hidden; margin-bottom: -1px; }
        .lane-strip-img { position: absolute; left: ${ (80 / 1600) * 100 }%; width: ${ ((1600 - 80 - 120) / 1600) * 100 }%; height: 100%; object-fit: fill; }
        .chart-img { width: 100%; display: block; border-top: 2px solid #ffc107; }
        table { width: 100%; border-collapse: collapse; margin-top: 30px; font-size: 0.95rem; break-inside: avoid; }
        th, td { border-bottom: 1px solid #eee; padding: 12px 15px; text-align: left; }
        th { background: #f8f9fa; font-weight: 700; color: #555; text-transform: uppercase; font-size: 0.75rem; }
        .badge { background: #ffc107; padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 700; color:#000; }
        .fit-groups { margin: 18px 0; }
        .fit-card { border: 1px solid #bbb; border-radius: 6px; padding: 10px; margin: 8px 0; break-inside: avoid; }
        .fit-card-head { display: flex; justify-content: space-between; gap: 10px; font-size: 0.82rem; }
        .fit-diagnostics, .fit-reason, .fit-provenance { font-size: 0.75rem; color: #555; line-height: 1.5; }
        .fit-legend { display: flex; gap: 12px; font-size: 0.72rem; color: #555; }
        .fit-legend span::before { content: ''; display: inline-block; width: 17px; margin-right: 5px; vertical-align: middle; border-top: 2px solid; }
        .fit-legend .measured::before { border-color: #0366d6; }
        .fit-legend .total::before { border-color: #008f82; }
        .fit-legend .component::before { border-color: #8055b7; border-top-style: dashed; }
        .fit-area-label { display: block; color: #68409b; font-size: 0.7rem; }
        @media print { .page-break:last-child { page-break-after: auto; margin-bottom: 0px; } }
    </style></head><body>`;

  for (let c = 0; c < lanesToExport.length; c++) {
    const l = lanesToExport[c];

    const laneStrip = document.createElement('canvas');
    const boxHeight = l.h;
    laneStrip.width = boxHeight;
    laneStrip.height = l.w;
    const sctx = laneStrip.getContext('2d');

    sctx.save();
    sctx.translate(boxHeight / 2, l.w / 2);
    sctx.rotate(Math.PI / 2 - l.angle);
    sctx.drawImage(img, -l.cx, -l.cy, state.imgW, state.imgH);
    sctx.restore();

    const n = (l.profile || []).length;
    if (n > 1) {
      (l.peaks || []).filter(pk => !isFittedPeak(pk)).forEach(pk => {
        const lb = pk.area_lb !== undefined ? pk.area_lb : (pk.lb !== undefined ? pk.lb : Math.max(0, pk.idx - 5));
        const rb = pk.area_rb !== undefined ? pk.area_rb : (pk.rb !== undefined ? pk.rb : Math.min(n - 1, pk.idx + 5));
        const x_pos_rb_flipped = (lb / (n - 1)) * boxHeight;
        const x_pos_lb_flipped = (rb / (n - 1)) * boxHeight;
        let fillStyle, strokeStyle;
        if (pk.type === 'S') {
          fillStyle   = 'rgba(46,160,67,0.35)';
          strokeStyle = 'rgba(46,160,67,0.8)';
        } else if (pk.manual) {
          fillStyle   = 'rgba(227,76,38,0.35)';
          strokeStyle = 'rgba(227,76,38,0.8)';
        } else {
          fillStyle   = 'rgba(255,215,0,0.35)';
          strokeStyle = 'rgba(255,165,0,0.8)';
        }
        sctx.fillStyle = fillStyle;
        sctx.fillRect(x_pos_rb_flipped, 0, x_pos_lb_flipped - x_pos_rb_flipped, l.w);
        sctx.strokeStyle = strokeStyle;
        sctx.lineWidth = 1;
        sctx.beginPath();
        sctx.moveTo(x_pos_rb_flipped, 0);
        sctx.lineTo(x_pos_rb_flipped, l.w);
        sctx.stroke();
        sctx.beginPath();
        sctx.moveTo(x_pos_lb_flipped, 0);
        sctx.lineTo(x_pos_lb_flipped, l.w);
        sctx.stroke();
      });
      fitGroups(l).filter(group => group.active === true).forEach(group => {
        fitIntegrationSegments(group).forEach(segment => {
          const x0 = (segment.lb / (n - 1)) * boxHeight;
          const x1 = (segment.rb / (n - 1)) * boxHeight;
          sctx.fillStyle = 'rgba(128,85,183,0.24)';
          sctx.fillRect(x0, 0, x1 - x0, l.w);
        });
      });
    }

    const hiResChart = document.createElement('canvas');
    hiResChart.width = 1600;
    hiResChart.height = 800;
    const hctx = hiResChart.getContext('2d');
    hctx.fillStyle = '#ffffff';
    hctx.fillRect(0, 0, 1600, 800);

    const fitSeries = fitGroups(l)
      .filter(group => group.status === 'resolved')
      .map(group => ({ group, series: fitCurveSeries(group, l.profile_analysis?.length || 0) }))
      .filter(item => item.series);
    const p = getReportProfile(l);
    const padL = 80;
    const padR = 120;
    const pw = 1600 - padL - padR;
    let minVal = 0;
    let maxVal = 1;
    const includeRange = value => { minVal = Math.min(minVal, value); maxVal = Math.max(maxVal, value); };
    p.forEach(includeRange);
    fitSeries.forEach(({ series }) => {
      series.total.forEach(includeRange);
      series.components.forEach(component => component.curve.forEach(includeRange));
    });
    const range = maxVal - minVal || 1;
    const yFor = value => 700 - ((value - minVal) / range) * 600;
    if (p.length > 0) {
      hctx.strokeStyle = '#0366d6';
      hctx.lineWidth = 3;
      hctx.beginPath();
      p.forEach((v, i) => {
        const x = padL + (i / (p.length - 1)) * pw;
        const y = yFor(v);
        if (i === 0) hctx.moveTo(x, y);
        else hctx.lineTo(x, y);
      });
      hctx.stroke();
    }

    const plotFit = (curve, firstIndex, color, dashed, width) => {
      hctx.beginPath();
      hctx.strokeStyle = color;
      hctx.lineWidth = width;
      hctx.setLineDash(dashed ? [11, 7] : []);
      curve.forEach((value, offset) => {
        const x = padL + ((firstIndex + offset) / (p.length - 1)) * pw;
        const y = yFor(value);
        if (offset === 0) hctx.moveTo(x, y);
        else hctx.lineTo(x, y);
      });
      hctx.stroke();
      hctx.setLineDash([]);
    };
    fitSeries.forEach(({ group, series }) => {
      plotFit(series.total, series.lb, '#008f82', group.active !== true, 3);
      series.components.forEach((component, index) => {
        plotFit(component.curve, series.lb, index % 2 ? '#b8741d' : '#8055b7', true, 2);
      });
    });

    hctx.fillStyle = '#000';
    hctx.font = 'bold 24px Inter';
    hctx.textAlign = 'center';
    hctx.fillText('Retention Factor (Rf)', 800, 785);
    for (let i = 0; i <= 10; i++) {
      const rf = i / 10;
      const rel_pos = 0.05 / 1.1 + rf * (1.0 / 1.1);
      const x = padL + rel_pos * pw;
      hctx.font = '18px Inter';
      hctx.fillText(rf.toFixed(1), x, 730);
      hctx.beginPath();
      hctx.moveTo(x, 700);
      hctx.lineTo(x, 693);
      hctx.stroke();
    }

    const laneStripUrl = laneStrip.toDataURL();
    const chartImgUrl = hiResChart.toDataURL();

    const peaks = l.peaks || [];
    const totalArea = peaks.reduce((s, pk) => s + pk.area, 0);
    const totalCorr = peaks.reduce((s, pk) => s + pk.area / (pk.absRatio || 1), 0);
    const mwCurve = state.integrationMethod === 'mw_calibration' ? calculateMWCalibrationCurve() : null;
    const calCurve = state.integrationMethod === 'calibration' ? calculateCalibrationCurve() : null;

    const rows = peaks
      .map((pk, i) =>
        generatePeakRowHTML(pk, i, state.integrationMethod, {
          totalArea,
          totalCorr,
          calCurve,
          mwCurve,
          isExport: true,
        })
      )
      .join('');

    const tableHeaders =
      state.integrationMethod === 'mw_calibration'
        ? `<tr><th>PEAK NAME</th><th style="text-align:center">Rf</th><th style="text-align:right">AREA (AU)</th><th style="text-align:center">TYPE</th><th style="text-align:right">MW (kDa)</th></tr>`
        : state.integrationMethod === 'relative'
        ? `<tr><th>PEAK NAME</th><th style="text-align:center">Rf</th><th style="text-align:right">AREA (AU)</th><th style="text-align:right">% AREA</th><th style="text-align:center">ABS RATIO</th><th style="text-align:right">% CORR. AREA</th></tr>`
        : `<tr><th>PEAK NAME</th><th style="text-align:center">Rf</th><th style="text-align:right">AREA (AU)</th><th style="text-align:center">TYPE</th><th style="text-align:right">VALUE</th></tr>`;

    reportHtml += `
        <div class="page-break">
            <div class="header">
                <div><h1 style="color:#0366d6; margin:0">AQ-TLC Analytical Report <span class="badge">v1.1</span></h1>
                     <p style="color:#666; margin:5px 0 0 0">Sample: <strong>${escapeHtml(l.name || l.id)}</strong></p></div>
                <div style="text-align:right; color:#888; font-size:0.9rem">${new Date().toLocaleString()}</div>
            </div>
            <div class="stack-wrap">
                <h3 style="color:#fff; font-size:0.65rem; padding:8px 15px; margin:0; text-transform:uppercase; letter-spacing:1px">Physical-to-Signal Alignment Stack</h3>
                <div class="lane-strip-area"><img src="${laneStripUrl}" class="lane-strip-img"></div>
                <img src="${chartImgUrl}" class="chart-img">
            </div>
            ${buildFitGroupsHTML(l, true)}
            <h3 style="margin-top:40px; border-bottom:2px solid #eee; padding-bottom:10px; font-size:0.9rem">QUANTITATIVE INTEGRATION (${state.integrationMethod.toUpperCase()})</h3>
            <table><thead>${tableHeaders}</thead><tbody>${rows}</tbody></table>
            ${peaks.some(isFittedPeak) ? '<p class="fit-provenance">Fitted component areas are model-allocated estimates from the summed measured Width%-controlled component windows. The model integral shown beneath each area is a diagnostic, not the quantity used for percentages or calibration.</p>' : ''}
        </div>`;
  }

  reportHtml += `<script>window.onload = () => { setTimeout(() => window.print(), 1000); }</script></body></html>`;

  const fileName = isFullReport
    ? 'AQ-TLC_Full_Report.html'
    : `AQ-TLC_Report_${safeFileName(lanesToExport[0].name || lanesToExport[0].id)}.html`;

  let popupSucceeded = false;
  if (win) {
    try {
      win.document.open();
      win.document.write(reportHtml);
      win.document.close();
      popupSucceeded = true;
    } catch (error) {
      console.warn('Report popup could not be filled; preparing a download link.', error);
    }
  }
  offerReportDownload(reportHtml, fileName, !popupSucceeded);
}
