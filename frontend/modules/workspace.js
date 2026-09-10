/**
 * @module workspace
 * @file modules/workspace.js
 *
 * Workspace state management for AQ-TLC (Streamlit edition).
 *
 * Manages the undo stack, file loading, image reset, and the server-side
 * crop operation.  All functions that mutate the image or annotation state
 * in a non-trivial way should call saveState() first so the action can be
 * reversed with Ctrl+Z.
 *
 * In the Streamlit deployment, the crop operation sends data via the
 * Streamlit component bridge (stSend) rather than fetch('/detect/crop').
 * The response arrives via stOnRender() and is applied here.
 */

import { state, $        } from './state.js';
import { UNDO_STACK_LIMIT } from './constants.js';
import { render           } from './render.js';
import { renderProfiles   } from './profiles.js';
import { stSend, stOnRender } from './streamlit_bridge.js';

// -- Crop response counter -----------------------------------------------------
let _cropReqCounter = 0;

// Register a listener for crop responses (shared render event).
stOnRender(args => {
  const resp = args.response;
  if (!resp || resp.action !== 'crop_result') return;

  const data = resp.data;
  if (data && data.image) {
    const img  = new Image();
    img.onload = () => {
      state.imgEl        = img;
      state.imgB64       = data.image;
      state.imgW         = img.naturalWidth;
      state.imgH         = img.naturalHeight;
      state.roiRect      = null;
      state.imageRotation = 0;
      state.view         = { zoom: 1, dx: 0, dy: 0 };
      render();
    };
    img.src = data.image;
  }
});

// ----------------------------------------------------------------------------
//  UNDO STACK
// ----------------------------------------------------------------------------

/**
 * Saves a snapshot of the current mutable state onto the undo stack.
 */
export function saveState() {
  const snapshot = {
    lines:   JSON.parse(JSON.stringify(state.lines)),
    lanes:   JSON.parse(JSON.stringify(state.lanes)),
    marks:   JSON.parse(JSON.stringify(state.spottingMarks)),
    rot:     state.imageRotation,
    img:     state.imgB64,
    w:       state.imgW,
    h:       state.imgH,
  };

  state.undoStack.push(snapshot);

  if (state.undoStack.length > UNDO_STACK_LIMIT) {
    state.undoStack.shift();
  }
}

/**
 * Restores the most recent snapshot from the undo stack (Ctrl+Z).
 */
export function undo() {
  if (state.undoStack.length === 0) return;

  const snapshot = state.undoStack.pop();
  state.lines          = snapshot.lines;
  state.lanes          = snapshot.lanes;
  state.spottingMarks  = snapshot.marks;
  state.imageRotation  = snapshot.rot;

  if (state.imgB64 !== snapshot.img) {
    state.imgB64 = snapshot.img;
    state.imgW   = snapshot.w;
    state.imgH   = snapshot.h;
    const img    = new Image();
    img.onload   = () => { state.imgEl = img; render(); };
    img.src      = snapshot.img;
  }

  renderProfiles();
  render();
}

// ----------------------------------------------------------------------------
//  FILE LOADING
// ----------------------------------------------------------------------------

/**
 * Loads an image file into the application workspace.
 * Image is scaled to = 1000 px on the longest dimension before encoding.
 *
 * @param {File} file
 */
export function handleFile(file) {
  if (!file) return;

  const reader    = new FileReader();
  reader.onload   = e => {
    const img   = new Image();
    img.onload  = () => {
      state.imgEl = img;

      const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
      state.imgW  = Math.round(img.naturalWidth  * scale);
      state.imgH  = Math.round(img.naturalHeight * scale);

      const offscreen     = document.createElement('canvas');
      offscreen.width     = state.imgW;
      offscreen.height    = state.imgH;
      offscreen.getContext('2d').drawImage(img, 0, 0, state.imgW, state.imgH);
      state.imgB64        = offscreen.toDataURL('image/jpeg', 0.9);
      state.originalB64   = state.imgB64;

      $('upload-prompt').style.display = 'none';
      $('app-grid').style.display      = 'grid';

      state.lines          = [];
      state.lanes          = [];
      state.spottingMarks  = [];
      state.activeLine     = null;
      state.activeLane     = null;
      state.activeMark     = null;
      $('file-input-prompter').value   = '';

      renderProfiles();
      render();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ----------------------------------------------------------------------------
//  STATE RESET
// ----------------------------------------------------------------------------

/**
 * Resets the workspace state.
 *
 * @param {boolean} [keepImage=true]
 *   true  ? soft reset (keep the loaded image).
 *   false ? hard reset (return to upload screen).
 */
export function resetState(keepImage = true) {
  state.lines          = [];
  state.lanes          = [];
  state.spottingMarks  = [];
  state.roiRect        = null;
  state.activeLine     = null;
  state.activeLane     = null;
  state.activeMark     = null;
  state.imageRotation  = 0;
  state.view           = { zoom: 1, dx: 0, dy: 0 };
  state.targetWavelength = null;
  state.wavelengthPreset = 'full';
  state.wavelengthBandwidth = 25;
  state.invertColors = false;

  const btnInvert = document.getElementById('btn-invert-colors');
  if (btnInvert) btnInvert.classList.remove('active');
  const bwSlider = document.getElementById('wl-bw-slider');
  if (bwSlider) bwSlider.value = 25;
  const bwVal = document.getElementById('wl-bw-val');
  if (bwVal) bwVal.textContent = '25';
  const wlFullBtn = document.getElementById('wl-preset-full');
  if (wlFullBtn) {
    document.querySelectorAll('.wl-preset-btn').forEach(b => b.classList.remove('active'));
    wlFullBtn.classList.add('active');
  }
  const wlControls = document.getElementById('wl-custom-controls');
  if (wlControls) wlControls.style.display = 'none';
  const wlSwatch = document.getElementById('wl-swatch');
  if (wlSwatch) wlSwatch.style.background = '#ffffff';

  if (!keepImage) {
    state.imgEl       = null;
    state.imgB64      = null;
    state.originalB64 = null;
    $('upload-prompt').style.display = 'flex';
    $('app-grid').style.display      = 'none';
  } else if (state.originalB64) {
    const img   = new Image();
    img.onload  = () => {
      state.imgEl = img;
      state.imgB64 = state.originalB64;
      const scale  = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
      state.imgW   = Math.round(img.naturalWidth  * scale);
      state.imgH   = Math.round(img.naturalHeight * scale);
      renderProfiles();
      render();
    };
    img.src = state.originalB64;
  }
}

// ----------------------------------------------------------------------------
//  CROP (via Streamlit bridge)
// ----------------------------------------------------------------------------

/**
 * Applies the currently drawn ROI rectangle as a crop.
 *
 * Sends the image, crop coordinates, and current rotation angle to Python
 * via the Streamlit component bridge.  The response is handled by the
 * stOnRender listener registered at the top of this module.
 */
export async function applyCrop() {
  saveState();
  const r = state.roiRect;
  if (!r) return;

  stSend({
    action:     'crop',
    request_id: ++_cropReqCounter,
    payload: {
      image: state.imgB64,
      x: r.x, y: r.y, w: r.w, h: r.h,
      angle: state.imageRotation,
    },
  });
}
