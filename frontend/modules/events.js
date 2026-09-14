/**
 * @module events
 * @file modules/events.js
 *
 * Event handlers for main canvas mouse/wheel interactions, global keyboard shortcuts,
 * and lane calculation geometry.
 */

import { state, $ } from './state.js';
import { getPos, getImageCanvasPos, calculateSnappedOriginPosition } from './coords.js';
import { render } from './render.js';
import { renderProfiles } from './profiles.js';
import { saveState, undo, applyCrop } from './workspace.js';
import { updateDensitograms } from './api.js';

/**
 * Initializes canvas mouse and wheel listeners, window mousemove/mouseup listeners,
 * and global keyboard shortcuts.
 */
export function setupCanvasEvents() {
  const canvas = $('canvas-main');
  if (!canvas) return;

  // -- Main Canvas Mouse Down --------------------------------------------------
  canvas.onmousedown = e => {
    const p = getPos(e, canvas);
    state.dragStart = p;
    state.mStart = { x: e.clientX, y: e.clientY };

    if (state.activeTool === 'select' || state.activeTool === 'pan') {
      const mHit = state.spottingMarks.find(m => Math.hypot(p.x - m.x, p.y - m.y) < 12);

      const sx = canvas.width / state.imgW;
      const lHit = state.lines.find(l => {
        const pos = getImageCanvasPos(l.cx, l.cy, sx, sx);
        return Math.abs(p.cy - pos.cy) < 20 && Math.abs(p.cx - pos.cx) < (l.w * sx) / 2;
      });

      const lnHit = state.lanes.find(ln => {
        const pos = getImageCanvasPos(ln.cx, ln.cy, sx, sx);
        return Math.abs(p.cx - pos.cx) < (ln.w * sx) / 2 && Math.abs(p.cy - pos.cy) < (ln.h * sx) / 2;
      });

      if (mHit) {
        saveState();
        state.activeMark = mHit;
        state.activeLine = null;
        state.activeLane = null;
        state.editingField = 'move-mark';
      } else if (lHit) {
        saveState();
        state.activeLine = lHit;
        state.activeMark = null;
        state.activeLane = null;
        state.editingField = 'move-line';
      } else if (lnHit) {
        saveState();
        state.activeLane = lnHit;
        state.activeLine = null;
        state.activeMark = null;
        state.editingField = 'move-lane';
        renderProfiles();
      } else {
        state.activeMark = null;
        state.activeLine = null;
        state.activeLane = null;
        if (state.activeTool === 'pan') state.isPanning = true;
        state.viewStart = { ...state.view };
      }
    } else if (state.activeTool === 'roi') {
      state.roiRect = { x: p.x, y: p.y, w: 1, h: 1 };
    } else if (state.activeTool === 'line') {
      const sx = canvas.width / state.imgW;
      const hit = state.lines.find(l => {
        const pos = getImageCanvasPos(l.cx, l.cy, sx, sx);
        const xPad = Math.max(20, (l.w * sx) / 2);
        return Math.abs(p.cy - pos.cy) < 15 && Math.abs(p.cx - pos.cx) <= xPad;
      });

      if (hit) {
        saveState();
        state.activeLine = hit;
        const pos = getImageCanvasPos(hit.cx, hit.cy, sx, sx);
        const distEdge = Math.abs(Math.abs(p.cx - pos.cx) - (hit.w * sx) / 2);
        state.editingField = distEdge < 20 ? 'resize-line' : 'move-line';
      } else {
        saveState();
        const nl = { cx: p.x, cy: p.y, w: 1, angle: 0 };
        state.lines.push(nl);
        state.activeLine = nl;
        state.editingField = 'resize-line';
      }
    } else if (state.activeTool === 'spotting') {
      saveState();
      const target = calculateSnappedOriginPosition(p, canvas);
      state.spottingMarks.push({ x: target.x, y: target.y });
    } else if (state.activeTool === 'rotate_img') {
      saveState();
      state.isRotating = true;
      state.rotateStart = state.imageRotation;
    }

    render();
  };

  // -- Main Canvas Double Click ------------------------------------------------
  canvas.ondblclick = () => {
    if (state.activeTool === 'rotate_img') {
      saveState();
      state.imageRotation += Math.PI / 2;
      render();
    }
  };

  // -- Main Canvas Wheel (Zoom) -----------------------------------------------
  canvas.onwheel = e => {
    e.preventDefault();
    const p = getPos(e, canvas);
    const d = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.view.zoom;
    state.view.zoom = Math.min(20, Math.max(0.1, state.view.zoom * d));
    state.view.dx -= (p.scX - state.view.dx) * (state.view.zoom / oldZoom - 1);
    state.view.dy -= (p.scY - state.view.dy) * (state.view.zoom / oldZoom - 1);
    render();
  };

  // -- Window Mouse Move -------------------------------------------------------
  window.onmousemove = e => {
    if (!state.dragStart) return;
    const p = getPos(e, canvas);

    if (state.isPanning) {
      state.view.dx = state.viewStart.dx + (e.clientX - state.mStart.x);
      state.view.dy = state.viewStart.dy + (e.clientY - state.mStart.y);
    } else if (state.isRotating) {
      state.imageRotation = state.rotateStart + (e.clientX - state.mStart.x) * 0.002;
    } else if (state.editingField === 'move-mark') {
      const target = calculateSnappedOriginPosition(p, canvas);
      state.activeMark.x = target.x;
      state.activeMark.y = target.y;
    } else if (state.editingField === 'move-line') {
      state.activeLine.cx = p.x;
      state.activeLine.cy = p.y;
    } else if (state.editingField === 'move-lane') {
      state.activeLane.cx = p.x;
      state.activeLane.cy = p.y;
    } else if (state.editingField === 'resize-line') {
      const sx = canvas.width / state.imgW;
      const pos = getImageCanvasPos(state.activeLine.cx, state.activeLine.cy, sx, sx);
      state.activeLine.w = (Math.abs(p.cx - pos.cx) * 2) / sx;
    } else if (state.roiRect && state.activeTool === 'roi') {
      state.roiRect.w = p.x - state.roiRect.x;
      state.roiRect.h = p.y - state.roiRect.y;
    }

    render();
  };

  // -- Window Mouse Up ---------------------------------------------------------
  window.onmouseup = () => {
    if (state.activeTool === 'roi' && state.roiRect && Math.abs(state.roiRect.w) > 5) {
      applyCrop();
    }
    if (state.editingField === 'move-lane') {
      updateDensitograms();
    }
    state.dragStart = null;
    state.isPanning = false;
    state.isRotating = false;
    state.editingField = null;
    render();
  };

  // -- Window Keydown (Undo & Delete Shortcuts) ------------------------------
  window.onkeydown = e => {
    const isEditing =
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable;
    if (isEditing) return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      undo();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.activeTool === 'select') {
        saveState();
        let changed = false;
        if (state.activeMark) {
          state.spottingMarks = state.spottingMarks.filter(m => m !== state.activeMark);
          state.activeMark = null;
          changed = true;
        } else if (state.activeLine) {
          state.lines = state.lines.filter(l => l !== state.activeLine);
          state.activeLine = null;
          changed = true;
        } else if (state.activeLane) {
          state.lanes = state.lanes.filter(l => l !== state.activeLane);
          state.activeLane = null;
          changed = true;
          renderProfiles();
        }
        if (changed) render();
      }
    }
  };
}

/**
 * Calculates lane bounding boxes from Origin/Front boundary lines and spotting marks.
 */
/**
 * Displays a user notification toast.
 * @param {string} message
 * @param {number} [duration=6000]
 */
export function showToast(message, duration = 6000) {
  let toast = $('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = [
      'position: fixed',
      'top: 60px',
      'left: 50%',
      'transform: translateX(-50%)',
      'background: rgba(22, 27, 34, 0.95)',
      'color: #fff',
      'border: 1px solid #ffc107',
      'border-radius: 8px',
      'padding: 12px 22px',
      'font-size: 0.85rem',
      'line-height: 1.5',
      'z-index: 999999',
      'box-shadow: 0 6px 20px rgba(0,0,0,0.6)',
      'max-width: 480px',
      'text-align: center',
      'white-space: pre-line',
      'pointer-events: auto',
      'cursor: pointer',
      'transition: opacity 0.3s, transform 0.3s',
    ].join(';');
    toast.onclick = () => { toast.style.opacity = '0'; };
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-10px)';
  }, duration);
}

/**
 * Calculates lane bounding boxes from Origin/Front boundary lines and spotting marks.
 */
export function calculateLanes() {
  const canvas = $('canvas-main');
  if (!canvas || !state.imgEl) return;

  if (state.lines.length < 2) {
    showToast('To calculate lanes, first draw 2 horizontal boundary lines across the plate (Origin and Solvent Front) using the "Lines" tool.');
    return;
  }

  saveState();
  state.lanes = [];
  const pool = [...state.lines];
  const pairs = [];

  const sx = canvas.width / state.imgW;

  while (pool.length >= 2) {
    const l1 = pool.shift();
    const l1_pos = getImageCanvasPos(l1.cx, l1.cy, sx, sx);
    let bestIdx = -1;
    let minDist = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const pi_pos = getImageCanvasPos(pool[i].cx, pool[i].cy, sx, sx);
      const d = Math.hypot(l1_pos.cx - pi_pos.cx, l1_pos.cy - pi_pos.cy);
      if (d < minDist && Math.abs(l1_pos.cy - pi_pos.cy) > 50 * sx) {
        minDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      const l2 = pool.splice(bestIdx, 1)[0];
      const l2_pos = getImageCanvasPos(l2.cx, l2.cy, sx, sx);
      const [f, o] = l1_pos.cy < l2_pos.cy ? [l1, l2] : [l2, l1];
      pairs.push({ o, f, id: pairs.length + 1, w: Math.max(o.w, f.w) });
    }
  }

  if (pairs.length === 0) {
    showToast('Boundary lines could not be paired. Please ensure the Origin line and Solvent Front line are separated vertically.');
    return;
  }

  if (state.spottingMarks.length === 0) {
    showToast('Boundary lines detected! Now use the "Marks" tool to click and place Spotting Marks along the Origin line for each sample lane.');
    return;
  }

  state.spottingMarks.forEach(m => {
    const m_pos = getImageCanvasPos(m.x, m.y, sx, sx);

    const bestPair = pairs.reduce((best, curr) => {
      const best_o_pos = getImageCanvasPos(best.o.cx, best.o.cy, sx, sx);
      const curr_o_pos = getImageCanvasPos(curr.o.cx, curr.o.cy, sx, sx);
      const d_curr = Math.hypot(m_pos.cx - curr_o_pos.cx, m_pos.cy - curr_o_pos.cy);
      const d_best = Math.hypot(m_pos.cx - best_o_pos.cx, m_pos.cy - best_o_pos.cy);
      return d_curr < d_best ? curr : best;
    }, pairs[0]);

    if (!bestPair) return;
    const { o, f } = bestPair;
    const o_pos = getImageCanvasPos(o.cx, o.cy, sx, sx);
    const f_pos = getImageCanvasPos(f.cx, f.cy, sx, sx);

    const midCanvasX = m_pos.cx;
    const midCanvasY = (o_pos.cy + f_pos.cy) / 2;
    const hImg = (Math.abs(o_pos.cy - f_pos.cy) * 1.10) / sx;

    const buddies = state.spottingMarks
      .filter(bm => {
        const bm_pos = getImageCanvasPos(bm.x, bm.y, sx, sx);
        const bBest = pairs.reduce((b, c) => {
          const b_o = getImageCanvasPos(b.o.cx, b.o.cy, sx, sx);
          const c_o = getImageCanvasPos(c.o.cx, c.o.cy, sx, sx);
          return Math.abs(bm_pos.cx - c_o.cx) < Math.abs(bm_pos.cx - b_o.cx) ? c : b;
        }, pairs[0]);
        return bBest === bestPair;
      })
      .sort((a, b) => getImageCanvasPos(a.x, a.y, sx, sx).cx - getImageCanvasPos(b.x, b.y, sx, sx).cx);

    let laneWCanvas = 35 * sx;
    if (buddies.length > 1) {
      let minDist = Infinity;
      for (let i = 0; i < buddies.length - 1; i++) {
        const p1 = getImageCanvasPos(buddies[i].x, buddies[i].y, sx, sx);
        const p2 = getImageCanvasPos(buddies[i + 1].x, buddies[i + 1].y, sx, sx);
        minDist = Math.min(minDist, p2.cx - p1.cx);
      }
      laneWCanvas = Math.min(35 * sx, minDist * 0.85);
    }

    const icx = (state.imgW * sx) / 2;
    const icy = (state.imgH * sx) / 2;
    const ca = Math.cos(-state.imageRotation);
    const sa = Math.sin(-state.imageRotation);
    const rx = (midCanvasX - icx) * ca - (midCanvasY - icy) * sa;
    const ry = (midCanvasX - icx) * sa + (midCanvasY - icy) * ca;

    state.lanes.push({
      id: bestPair.id + '.' + (buddies.indexOf(m) + 1),
      cx: (rx + icx) / sx,
      cy: (ry + icy) / sx,
      w: laneWCanvas / sx,
      h: hImg,
      angle: -state.imageRotation,
      profile: [],
      peaks: [],
    });
  });

  if (state.lanes.length > 0) {
    state.activeLane = state.lanes[0];
    renderProfiles();
    updateDensitograms(true);
  }
  render();
}
