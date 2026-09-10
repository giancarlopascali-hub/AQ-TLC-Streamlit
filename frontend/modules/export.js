/**
 * @module export
 * @file modules/export.js
 *
 * Report generation engine — builds and exports analytical HTML/PDF reports.
 */

import { state } from './state.js';
import { generatePeakRowHTML } from './profiles.js';
import { calculateCalibrationCurve, calculateMWCalibrationCurve } from './analysis.js';

/**
 * Generates an analytical report for the active lane or all lanes.
 *
 * @param {string|null} type - 'all' for full report of all lanes, or null for active lane only.
 */
export async function exportReport(type = null) {
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

  const img = new Image();
  img.src = state.imgB64;
  await new Promise(r => (img.onload = r));

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
    sctx.drawImage(img, -l.cx, -l.cy);
    sctx.restore();

    const n = (l.profile || []).length;
    if (n > 1) {
      (l.peaks || []).forEach(pk => {
        const lb = pk.lb !== undefined ? pk.lb : Math.max(0, pk.idx - 5);
        const rb = pk.rb !== undefined ? pk.rb : Math.min(n - 1, pk.idx + 5);
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
    }

    const hiResChart = document.createElement('canvas');
    hiResChart.width = 1600;
    hiResChart.height = 800;
    const hctx = hiResChart.getContext('2d');
    hctx.fillStyle = '#ffffff';
    hctx.fillRect(0, 0, 1600, 800);

    const p_orig = l.profile || [];
    const p = [...p_orig].reverse();
    const padL = 80;
    const padR = 120;
    const pw = 1600 - padL - padR;
    const maxVal = Math.max(...p, 1);
    if (p.length > 0) {
      hctx.strokeStyle = '#0366d6';
      hctx.lineWidth = 3;
      hctx.beginPath();
      p.forEach((v, i) => {
        const x = padL + (i / (p.length - 1)) * pw;
        const y = 700 - (v / maxVal) * 600;
        if (i === 0) hctx.moveTo(x, y);
        else hctx.lineTo(x, y);
      });
      hctx.stroke();
    }

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
                <div><h1 style="color:#0366d6; margin:0">AQ-TLC Analytical Report <span class="badge">v1.0</span></h1>
                     <p style="color:#666; margin:5px 0 0 0">Sample: <strong>${l.name || l.id}</strong></p></div>
                <div style="text-align:right; color:#888; font-size:0.9rem">${new Date().toLocaleString()}</div>
            </div>
            <div class="stack-wrap">
                <h3 style="color:#fff; font-size:0.65rem; padding:8px 15px; margin:0; text-transform:uppercase; letter-spacing:1px">Physical-to-Signal Alignment Stack</h3>
                <div class="lane-strip-area"><img src="${laneStripUrl}" class="lane-strip-img"></div>
                <img src="${chartImgUrl}" class="chart-img">
            </div>
            <h3 style="margin-top:40px; border-bottom:2px solid #eee; padding-bottom:10px; font-size:0.9rem">QUANTITATIVE INTEGRATION (${state.integrationMethod.toUpperCase()})</h3>
            <table><thead>${tableHeaders}</thead><tbody>${rows}</tbody></table>
        </div>`;
  }

  reportHtml += `<script>window.onload = () => { setTimeout(() => window.print(), 1000); }</script></body></html>`;

  const fileName = isFullReport
    ? 'AQ-TLC_Full_Report.html'
    : `AQ-TLC_Report_${lanesToExport[0].name || lanesToExport[0].id}.html`;

  try {
    const win = window.open('', '_blank');
    win.document.write(reportHtml);
    win.document.close();
  } catch (e) {
    console.warn('Popup document.write blocked by iframe sandbox. Falling back to explicit file download.', e);
    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
