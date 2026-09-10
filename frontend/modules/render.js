/**
 * @module render
 * @file modules/render.js
 *
 * Canvas rendering engine for AQ-TLC.
 *
 * render() is the only public export.  It clears and redraws the entire
 * main canvas on every call.  Drawing layers (bottom to top):
 *
 *   1. Background image      — scaled to fill canvas width, centred, rotated.
 *   2. Spotting marks        — blue circles (amber when selected).
 *   3. Origin / Front lines  — orange (Origin) or green (Front); amber when selected.
 *   4. Plate bounding boxes  — dashed white rectangles pairing each Origin+Front pair.
 *   5. Lane regions          — blue outlines; gold/red peak highlight bands inside.
 *   6. ROI rectangle         — orange dashed rectangle shown while 'roi' tool is active.
 *
 * All annotation drawing (layers 2–6) happens inside the rotated image transform,
 * so annotations always follow the image rotation correctly.
 *
 * Performance note: render() is called frequently (every mousemove during pan/drag).
 * Keep it free of DOM mutations, network calls, and heavy allocations.
 */

import { state, $       } from './state.js';
import { getImageCanvasPos } from './coords.js';

let _filterCacheKey = null;
let _filteredCanvas = null;

function wavelengthToRGB(wavelength) {
  let r = 0, g = 0, b = 0;
  if (wavelength >= 380 && wavelength < 440) {
    r = -(wavelength - 440) / (440 - 380); g = 0; b = 1;
  } else if (wavelength >= 440 && wavelength < 490) {
    r = 0; g = (wavelength - 440) / (490 - 440); b = 1;
  } else if (wavelength >= 490 && wavelength < 510) {
    r = 0; g = 1; b = -(wavelength - 510) / (510 - 490);
  } else if (wavelength >= 510 && wavelength < 580) {
    r = (wavelength - 510) / (580 - 510); g = 1; b = 0;
  } else if (wavelength >= 580 && wavelength < 645) {
    r = 1; g = -(wavelength - 645) / (645 - 580); b = 0;
  } else if (wavelength >= 645 && wavelength <= 750) {
    r = 1; g = 0; b = 0;
  }
  let factor = 1.0;
  if (wavelength >= 380 && wavelength < 420) {
    factor = 0.3 + 0.7 * (wavelength - 380) / (420 - 380);
  } else if (wavelength > 700 && wavelength <= 750) {
    factor = 0.3 + 0.7 * (750 - wavelength) / (750 - 700);
  }
  return { r: r * factor, g: g * factor, b: b * factor };
}

function getFilteredImageSource() {
  if (!state.imgEl) return null;
  const currentKey = `${state.imgB64}_${state.targetWavelength}_${state.invertColors}`;
  if (!state.targetWavelength && !state.invertColors) {
    _filterCacheKey = null;
    _filteredCanvas = null;
    return state.imgEl;
  }
  if (_filterCacheKey === currentKey && _filteredCanvas) {
    return _filteredCanvas;
  }

  const off = document.createElement('canvas');
  const w = state.imgEl.naturalWidth || state.imgW || 800;
  const h = state.imgEl.naturalHeight || state.imgH || 600;
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(state.imgEl, 0, 0, w, h);

  try {
    const imgData = octx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let w_r = 0.299, w_g = 0.587, w_b = 0.114;
    let r_c = 1.0, g_c = 1.0, b_c = 1.0;
    const hasWl = state.targetWavelength !== null && state.targetWavelength !== 'full';

    if (hasWl) {
      const spec = wavelengthToRGB(parseFloat(state.targetWavelength));
      r_c = spec.r; g_c = spec.g; b_c = spec.b;
      const sum = r_c + g_c + b_c;
      if (sum > 0) {
        w_r = r_c / sum;
        w_g = g_c / sum;
        w_b = b_c / sum;
      }
    }

    const invert = state.invertColors;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (hasWl) {
        const y = w_r * r + w_g * g + w_b * b;
        r = Math.min(255, Math.max(0, y * r_c));
        g = Math.min(255, Math.max(0, y * g_c));
        b = Math.min(255, Math.max(0, y * b_c));
      }
      if (invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      data[i]     = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }

    octx.putImageData(imgData, 0, 0);
    _filterCacheKey = currentKey;
    _filteredCanvas = off;
    return _filteredCanvas;
  } catch (e) {
    console.warn('[AQ-TLC] Image filtering fallback:', e);
    return state.imgEl;
  }
}

/**
 * Redraws the entire main canvas from the current application state.
 * No-ops silently if no image is loaded or the canvas element is absent.
 */
export function render() {
  const canvas = $('canvas-main');
  if (!state.imgEl || !canvas) return;

  // Resize the canvas buffer to match its CSS layout size
  const wrap    = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;

  const ctx = canvas.getContext('2d');

  // ── Lane count badge ───────────────────────────────────────────────────────
  // Update the badge in the sidebar header each frame (cheap, cached ref via $)
  const badge = $('lane-count-badge');
  if (badge) badge.textContent = `${state.lanes.length} Lanes`;

  // ── Outer save: pan + zoom ─────────────────────────────────────────────────
  ctx.save();
  ctx.translate(state.view.dx, state.view.dy);
  ctx.scale(state.view.zoom, state.view.zoom);

  // Scale factor: canvas pixels per image pixel (uniform, width-fitted)
  const sx    = canvas.width / state.imgW;
  const drawW = canvas.width;
  const drawH = state.imgH * sx;

  // ── Inner save: image rotation ─────────────────────────────────────────────
  // All annotation layers are drawn INSIDE this save/restore so they rotate
  // with the image.  The translate-rotate-translate pattern keeps the rotation
  // centre at the image centre.
  ctx.save();
  ctx.translate((state.imgW * sx) / 2, (state.imgH * sx) / 2);
  ctx.rotate(state.imageRotation);
  const imgSrc = getFilteredImageSource() || state.imgEl;
  ctx.drawImage(imgSrc, -(state.imgW * sx) / 2, -(state.imgH * sx) / 2, drawW, drawH);
  ctx.translate(-(state.imgW * sx) / 2, -(state.imgH * sx) / 2);

  // ══ Layer 2: Spotting Marks ════════════════════════════════════════════════
  state.spottingMarks.forEach(m => {
    const isSelected = state.activeMark === m;
    ctx.fillStyle   = isSelected ? '#ffc107' : '#58a6ff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1 / state.view.zoom;
    ctx.beginPath();
    // Radius scales inversely with zoom so marks stay a consistent screen size
    ctx.arc(m.x * sx, m.y * sx, 6 / state.view.zoom, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  });

  // ══ Layer 3: Boundary Lines (Origin & Front) ═══════════════════════════════
  state.lines.forEach(l => {
    const isSelected = state.activeLine === l;
    const pos        = getImageCanvasPos(l.cx, l.cy, sx, sx);

    // A line is classified as Origin if its canvas-Y sits in the lower half of the image.
    // This assumes the plate is photographed right-side up (Origin at bottom).
    const isOrigin = pos.cy > (state.imgH * sx) / 2;

    ctx.save();
    ctx.translate(l.cx * sx, l.cy * sx);
    // Counter-rotate the line's own angle by imageRotation so the line angle
    // is expressed relative to the image rather than the canvas.
    ctx.rotate((l.angle || 0) - state.imageRotation);

    ctx.strokeStyle = isSelected ? '#ffc107' : (isOrigin ? '#f0883e' : '#238636');
    ctx.lineWidth   = 4 / state.view.zoom;
    ctx.beginPath();
    ctx.moveTo(-l.w * sx / 2, 0);
    ctx.lineTo( l.w * sx / 2, 0);
    ctx.stroke();

    // Label above the line
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font      = `bold ${12 / state.view.zoom}px Inter`;
    ctx.fillText(isOrigin ? 'ORIGIN' : 'FRONT', -l.w * sx / 2, -8 / state.view.zoom);
    ctx.restore();
  });

  // ══ Layer 4: Plate Bounding Boxes (paired Origin + Front lines) ════════════
  // Pair each line with its nearest counterpart that is >50 scaled px away
  // vertically, forming an Origin/Front pair.  The dashed rectangle spans
  // 110% of the inter-line distance (5% padding each side).
  const pool        = [...state.lines];
  const uniquePairs = [];

  while (pool.length >= 2) {
    const l1     = pool.shift();
    const l1_pos = getImageCanvasPos(l1.cx, l1.cy, sx, sx);
    let bestIdx  = -1;
    let minDist  = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const pi_pos = getImageCanvasPos(pool[i].cx, pool[i].cy, sx, sx);
      const d      = Math.hypot(l1_pos.cx - pi_pos.cx, l1_pos.cy - pi_pos.cy);
      // Require >50 scaled px of vertical separation to distinguish Origin from Front
      if (d < minDist && Math.abs(l1_pos.cy - pi_pos.cy) > 50 * sx) {
        minDist = d; bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      const l2     = pool.splice(bestIdx, 1)[0];
      const l2_pos = getImageCanvasPos(l2.cx, l2.cy, sx, sx);

      // Assign: f = lower canvas-Y (Front/top), o = higher canvas-Y (Origin/bottom)
      const [f, o] = l1_pos.cy < l2_pos.cy ? [l1, l2] : [l2, l1];
      const f_pos  = getImageCanvasPos(f.cx, f.cy, sx, sx);
      const o_pos  = getImageCanvasPos(o.cx, o.cy, sx, sx);

      // Compute midpoint of the pair in canvas space, then rotate back to image space
      const midCX = (o_pos.cx + f_pos.cx) / 2;
      const midCY = (o_pos.cy + f_pos.cy) / 2;
      const icx   = (state.imgW * sx) / 2;
      const icy   = (state.imgH * sx) / 2;
      const ca    = Math.cos(-state.imageRotation);
      const sa    = Math.sin(-state.imageRotation);
      const rx    = (midCX - icx) * ca - (midCY - icy) * sa;
      const ry    = (midCX - icx) * sa + (midCY - icy) * ca;

      uniquePairs.push({
        o, f,
        cx: (rx + icx) / sx,
        cy: (ry + icy) / sx,
        w:  Math.max(o.w, f.w),
        // Box height = 110% of inter-line distance (matches lane box in btn-calc-lanes)
        h:  Math.abs(o_pos.cy - f_pos.cy) * 1.1 / sx,
      });
    }
  }

  uniquePairs.forEach(p => {
    ctx.save();
    ctx.translate(p.cx * sx, p.cy * sx);
    ctx.rotate(-state.imageRotation);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth   = 1 / state.view.zoom;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(-p.w * sx / 2, -p.h * sx / 2, p.w * sx, p.h * sx);
    ctx.setLineDash([]);
    ctx.restore();
  });

  // ══ Layer 5: Lane Regions & Peak Highlight Bands ══════════════════════════
  state.lanes.forEach(l => {
    ctx.save();
    ctx.translate(l.cx * sx, l.cy * sx);
    ctx.rotate(l.angle || 0);

    const isActive = state.activeLane === l;

    // Lane outline — amber when active, translucent blue otherwise
    ctx.strokeStyle = isActive ? '#ffc107' : 'rgba(88,166,255,0.4)';
    ctx.lineWidth   = isActive ? 4 / state.view.zoom : 2 / state.view.zoom;
    ctx.strokeRect(-(l.w * sx) / 2, -(l.h * sx) / 2, l.w * sx, l.h * sx);

    // Peak bands — drawn as horizontal strips across the lane width.
    // Gold (#ffd700) for auto-detected peaks, red (#e34c26) for manually adjusted.
    // Bands are more opaque when the lane is active for clearer visual feedback.
    const n = (l.profile || []).length;
    if (n > 1) {
      (l.peaks || []).forEach(pk => {
        const lb    = pk.lb !== undefined ? pk.lb : Math.max(0, pk.idx - 5);
        const rb    = pk.rb !== undefined ? pk.rb : Math.min(n - 1, pk.idx + 5);

        // Profile index 0 = Front, n-1 = Origin (reversed).  Map to lane canvas-Y.
        // y_top corresponds to rb (closer to Front = higher up the lane).
        const y_top = (0.5 - rb / (n - 1)) * l.h * sx;
        const y_bot = (0.5 - lb / (n - 1)) * l.h * sx;

        let color;
        if (pk.type === 'S') {
          color = '46, 160, 67';   // Green for standards
        } else if (pk.manual) {
          color = '227, 76, 38';   // Red for manual/modified
        } else {
          color = '255, 215, 0';   // Yellow for auto
        }
        const alphaFill   = isActive ? 0.25 : 0.12;
        const alphaStroke = isActive ? 0.70 : 0.30;

        ctx.fillStyle = `rgba(${color}, ${alphaFill})`;
        ctx.fillRect(-(l.w * sx) / 2, y_top, l.w * sx, y_bot - y_top);

        ctx.strokeStyle = `rgba(${color}, ${alphaStroke})`;
        ctx.lineWidth   = 1 / state.view.zoom;
        ctx.beginPath(); ctx.moveTo(-(l.w * sx) / 2, y_top); ctx.lineTo((l.w * sx) / 2, y_top); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-(l.w * sx) / 2, y_bot); ctx.lineTo((l.w * sx) / 2, y_bot); ctx.stroke();
      });
    }

    ctx.restore();
  });

  // ══ Layer 6: ROI Crop Rectangle ════════════════════════════════════════════
  if (state.roiRect) {
    ctx.strokeStyle = '#f0883e';
    ctx.lineWidth   = 2 / state.view.zoom;
    ctx.setLineDash([5 / state.view.zoom, 5 / state.view.zoom]);
    ctx.strokeRect(state.roiRect.x * sx, state.roiRect.y * sx,
                   state.roiRect.w * sx, state.roiRect.h * sx);
    ctx.fillStyle = 'rgba(240,136,62,0.1)';
    ctx.fillRect(state.roiRect.x * sx, state.roiRect.y * sx,
                 state.roiRect.w * sx, state.roiRect.h * sx);
    ctx.setLineDash([]);
  }

  // ── Restore both save levels ───────────────────────────────────────────────
  ctx.restore(); // inner  — removes image rotation
  ctx.restore(); // outer  — removes pan + zoom
}
