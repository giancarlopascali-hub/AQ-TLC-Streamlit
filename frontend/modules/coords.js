/**
 * @module coords
 * @file modules/coords.js
 *
 * Coordinate transformation utilities for AQ-TLC.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * THREE COORDINATE SPACES
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 1. Screen space   — raw (clientX, clientY) from browser mouse events.
 *                     Units: CSS pixels, origin at viewport top-left.
 * 2. Canvas space   — pixel coordinates of the <canvas> drawing buffer.
 *                     May differ from screen space if devicePixelRatio != 1.
 * 3. Image space    — pixel coordinates within the loaded image (imgW × imgH).
 *                     This is the "canonical" annotation coordinate system.
 *
 * Transforms applied at draw time (render.js):
 *   ctx.translate(view.dx, view.dy)    — pan
 *   ctx.scale(view.zoom, view.zoom)    — zoom
 *   ctx.translate(cx, cy)             — move to image centre
 *   ctx.rotate(imageRotation)         — rotation
 *   ctx.translate(-cx, -cy)           — move back from centre
 *
 * getPos()             : Screen → Image  (inverse of draw transform)
 * getImageCanvasPos()  : Image → Canvas  (forward draw transform, no pan/zoom)
 */

import { state }             from './state.js';
import { SNAP_THRESHOLD_PX } from './constants.js';

/**
 * Converts a mouse-event position into image-space coordinates.
 *
 * Steps:
 *   1. Map from CSS pixels to canvas pixels (accounting for element scaling).
 *   2. Invert the pan (view.dx/dy) and zoom (view.zoom).
 *   3. Invert the image rotation around the image centre.
 *   4. Scale back from canvas pixels to image pixels.
 *
 * @param {MouseEvent}         e      - Browser mouse event.
 * @param {HTMLCanvasElement}  canvas - The main drawing canvas.
 * @returns {{
 *   x:   number,   // Image-space X (after rotation correction)
 *   y:   number,   // Image-space Y (after rotation correction)
 *   scX: number,   // Canvas-space X (before rotation correction)
 *   scY: number,   // Canvas-space Y (before rotation correction)
 *   cx:  number,   // Canvas-local X after inverting pan+zoom (before rotation)
 *   cy:  number    // Canvas-local Y after inverting pan+zoom (before rotation)
 * }}
 */
export function getPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();

  // 1. Map CSS pixels → canvas buffer pixels
  const scX = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const scY = (e.clientY - rect.top)  * (canvas.height / rect.height);

  const z = state.view.zoom;

  // 2. Invert pan and zoom to get position in the un-zoomed canvas
  const x = (scX - state.view.dx) / z;
  const y = (scY - state.view.dy) / z;

  // Scale factor: canvas pixels per image pixel
  const sx = canvas.width / state.imgW;

  // Image centre in un-zoomed canvas pixels
  const icx = (state.imgW * sx) / 2;
  const icy = (state.imgH * sx) / 2;

  // 3. Rotate the vector (x − centre, y − centre) by −imageRotation
  //    to undo the drawing rotation
  const dx = x - icx;
  const dy = y - icy;
  const sa = Math.sin(-state.imageRotation);
  const ca = Math.cos(-state.imageRotation);
  const rx = dx * ca - dy * sa;
  const ry = dx * sa + dy * ca;

  // 4. Scale from canvas pixels back to image pixels
  return {
    x:   (rx + icx) / sx,  // image-space X
    y:   (ry + icy) / sx,  // image-space Y
    scX,                   // raw canvas X (for zoom anchoring)
    scY,                   // raw canvas Y (for zoom anchoring)
    cx:  x,                // canvas-local X before de-rotation (for hit-testing)
    cy:  y,                // canvas-local Y before de-rotation
  };
}

/**
 * Converts an image-space point to un-zoomed canvas pixel coordinates.
 *
 * This mirrors the drawing transform in render.js (scale → centre → rotate → decentre),
 * but without the pan/zoom wrapper — useful for hit-testing annotation positions
 * against raw canvas geometry.
 *
 * @param {number} x   - Image-space X (pixels).
 * @param {number} y   - Image-space Y (pixels).
 * @param {number} sx  - Horizontal scale (canvas.width / state.imgW).
 * @param {number} sy  - Vertical scale (same as sx for uniform scaling).
 * @returns {{ cx: number, cy: number }} - Un-zoomed canvas coordinates.
 */
export function getImageCanvasPos(x, y, sx, sy) {
  const icx = (state.imgW * sx) / 2;  // Image centre X in canvas pixels
  const icy = (state.imgH * sy) / 2;  // Image centre Y in canvas pixels

  // Translate to centre-relative, then apply rotation
  const dx = x * sx - icx;
  const dy = y * sy - icy;
  const ca = Math.cos(state.imageRotation);
  const sa = Math.sin(state.imageRotation);

  return {
    cx: dx * ca - dy * sa + icx,
    cy: dx * sa + dy * ca + icy,
  };
}

/**
 * Calculates the snapped image-space position for a spotting mark placement.
 *
 * When the cursor is within SNAP_THRESHOLD_PX scaled pixels of the nearest Origin
 * line, the mark's Y coordinate snaps to that line's Y (horizontal alignment),
 * while X follows the cursor.  Outside the threshold the position is returned
 * unchanged.
 *
 * This consolidates the duplicate snapping logic that previously existed in both
 * the onmousedown and onmousemove handlers.
 *
 * @param {{ x: number, y: number, cx: number, cy: number }} p
 *   Position object from getPos() — contains both image-space (x, y) and
 *   canvas-space (cx, cy) coordinates.
 * @param {HTMLCanvasElement} canvas - The main canvas element.
 * @returns {{ x: number, y: number }} - Final image-space position (possibly snapped).
 */
export function calculateSnappedOriginPosition(p, canvas) {
  const sx = canvas.width / state.imgW;

  // ── Find all Origin lines ─────────────────────────────────────────────────
  // Origin lines sit in the lower half of the canvas (higher canvas-Y value).
  const origins = state.lines.filter(l => {
    const pos = getImageCanvasPos(l.cx, l.cy, sx, sx);
    return pos.cy > (state.imgH * sx) / 2;
  });

  if (origins.length === 0) return { x: p.x, y: p.y };

  // ── Find the nearest Origin line by Euclidean distance in image space ────
  const closest = origins.reduce((best, curr) => {
    const dCurr = Math.hypot(p.x - curr.cx, p.y - curr.cy);
    const dBest = Math.hypot(p.x - best.cx, p.y - best.cy);
    return dCurr < dBest ? curr : best;
  });

  const oPos = getImageCanvasPos(closest.cx, closest.cy, sx, sx);

  // ── Snap if within vertical proximity threshold ───────────────────────────
  if (Math.abs(p.cy - oPos.cy) < SNAP_THRESHOLD_PX * sx) {
    // Project the cursor's X onto the Origin line's Y, then convert back to image space.
    const icx = (state.imgW * sx) / 2;
    const icy = (state.imgH * sx) / 2;
    const ca  = Math.cos(-state.imageRotation);
    const sa  = Math.sin(-state.imageRotation);
    const rx  = (p.cx  - icx) * ca - (oPos.cy - icy) * sa;
    const ry  = (p.cx  - icx) * sa + (oPos.cy - icy) * ca;
    return { x: (rx + icx) / sx, y: (ry + icy) / sx };
  }

  // Outside snap threshold — return the raw position
  return { x: p.x, y: p.y };
}
