/**
 * @module init
 * @file modules/init.js
 *
 * Application bootstrapping and event initialization module for AQ-TLC
 * (Streamlit edition).
 *
 * Changes from the desktop (Flask) version:
 *   - Heartbeat / shutdown watchdog calls removed (Flask lifecycle only).
 *   - stReady() is called at the end so Streamlit knows the iframe is ready.
 */

import { state, $ } from './state.js';
import { render } from './render.js';
import { renderProfiles } from './profiles.js';
import { registerApiCallbacks, updateDensitograms } from './api.js';
import { handleFile, resetState } from './workspace.js';
import { setupCanvasEvents, calculateLanes } from './events.js';
import { exportReport } from './export.js';
import {
  DEFAULT_PEAK_PROMINENCE,
  DEFAULT_PEAK_DISTANCE,
  DEFAULT_PEAK_THRESHOLD,
} from './constants.js';
import { stReady, stSetHeight } from './streamlit_bridge.js';
import { wavelengthWindowToRgb } from './image_filters.js';

/**
 * Initializes DOM event listeners, configures tool selection, attaches window
 * bridge methods, and boots up the initial canvas render.
 */
export function init() {
  // -- Register API Callbacks --------------------------------------------------
  registerApiCallbacks(renderProfiles, render);

  // -- Window Bridge Methods ---------------------------------------------------
  window._exportReport = exportReport;

  // -- Setup File Drag and Drop / Browsing -------------------------------------
  const dz = $('drop-zone');
  const fi = $('file-input-prompter');
  if (dz && fi) {
    // If dz is a <label for="file-input-prompter">, clicking it natively activates fi.
    // Calling fi.click() inside a label's click listener causes a duplicate click event
    // which cancels the file dialog in Chromium. Only attach onclick if not a label.
    if (dz.tagName !== 'LABEL') {
      dz.onclick = () => fi.click();
    }
    dz.ondragover = e => {
      e.preventDefault();
      dz.style.background = 'rgba(31, 111, 235, 0.1)';
      dz.style.borderColor = 'var(--accent)';
    };
    dz.ondragleave = () => {
      dz.style.background = 'rgba(22, 27, 34, 0.5)';
      dz.style.borderColor = 'var(--border)';
    };
    dz.ondrop = e => {
      e.preventDefault();
      dz.style.background = 'rgba(22, 27, 34, 0.5)';
      dz.style.borderColor = 'var(--border)';
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    };
    fi.onchange = e => {
      if (e.target.files && e.target.files.length) handleFile(e.target.files[0]);
    };
  }

  // Global window drop listener so dragging a file anywhere onto the page works
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // -- Sidebar Action Buttons -------------------------------------------------
  $('btn-new').onclick = () => resetState(false);
  $('btn-reset').onclick = () => {
    resetState(true);
    renderProfiles();
    render();
  };
  $('btn-calc-lanes').onclick = () => calculateLanes();

  // -- Polarity Toggle Buttons -------------------------------------------------
  document.querySelectorAll('.mode-toggle-btn[data-mode]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.mode-toggle-btn[data-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.polarityMode = btn.dataset.mode;
      if (state.activeLane) updateDensitograms(true);
    };
  });

  // -- Wavelength Filter Handlers ----------------------------------------------
  const clampInteger = (value, minimum, maximum, fallback) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, Math.floor(number + 0.5)))
      : fallback;
  };
  const updateWavelengthSwatch = () => {
    const swatch = $('wl-swatch');
    if (!swatch) return;
    if (state.targetWavelength === null) {
      swatch.style.background = '#ffffff';
    } else {
      const { r, g, b } = wavelengthWindowToRgb(state.targetWavelength, state.wavelengthBandwidth);
      const toHex = channel => Math.round(channel * 255).toString(16).padStart(2, '0');
      swatch.style.background = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
  };

  const wlControls = $('wl-custom-controls');
  const wlSlider   = $('wl-slider');
  const wlInput    = $('wl-num-input');
  const bwSlider   = $('wl-bw-slider');
  const bwInput    = $('wl-bw-input');

  const updateWlControlsVisibility = () => {
    if (!wlControls) return;
    wlControls.style.display = (state.wavelengthPreset === 'full') ? 'none' : 'flex';
  };

  const setWavelength = (wl) => {
    if (wl === 'full' || wl === null) {
      state.targetWavelength = null;
    } else if (wl === 'custom') {
      if (state.targetWavelength === null) {
        state.targetWavelength = 540;
      }
    } else {
      state.targetWavelength = clampInteger(wl, 380, 750, 540);
    }
    if (state.targetWavelength !== null) {
      if (wlSlider) wlSlider.value = state.targetWavelength;
      if (wlInput) wlInput.value = state.targetWavelength;
    }
    updateWavelengthSwatch();
    updateWlControlsVisibility();
    render();
    if (state.lanes.length > 0) updateDensitograms(true);
  };

  updateWlControlsVisibility();

  const btnInvert = $('btn-invert-colors');
  if (btnInvert) {
    btnInvert.onclick = () => {
      state.invertColors = !state.invertColors;
      btnInvert.classList.toggle('active', state.invertColors);
      render();
      if (state.lanes.length > 0) updateDensitograms(true);
    };
  }

  if (bwSlider) {
    bwSlider.oninput = e => {
      state.wavelengthBandwidth = clampInteger(e.target.value, 0, 50, 0);
      if (bwInput) bwInput.value = state.wavelengthBandwidth;
      updateWavelengthSwatch();
      render();
    };
    bwSlider.onchange = e => {
      if (state.lanes.length > 0) updateDensitograms(true);
    };
  }
  if (bwInput) {
    bwInput.onchange = e => {
      state.wavelengthBandwidth = clampInteger(e.target.value, 0, 50, 0);
      e.target.value = state.wavelengthBandwidth;
      if (bwSlider) bwSlider.value = state.wavelengthBandwidth;
      updateWavelengthSwatch();
      render();
      if (state.lanes.length > 0) updateDensitograms(true);
    };
  }

  document.querySelectorAll('.wl-preset-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.wl-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const wlVal = btn.dataset.wl;
      state.wavelengthPreset = wlVal;
      setWavelength(wlVal);
    };
  });

  const onCustomWlChange = (val) => {
    const clamped = clampInteger(val, 380, 750, 540);
    document.querySelectorAll('.wl-preset-btn').forEach(b => b.classList.remove('active'));
    $('wl-preset-custom')?.classList.add('active');
    state.wavelengthPreset = 'custom';
    setWavelength(clamped);
  };

  if (wlSlider) {
    wlSlider.oninput = e => {
      if (wlInput) wlInput.value = e.target.value;
      state.targetWavelength = clampInteger(e.target.value, 380, 750, 540);
      updateWavelengthSwatch();
      render();
    };
    wlSlider.onchange = e => onCustomWlChange(e.target.value);
  }

  if (wlInput) {
    wlInput.onchange = e => {
      const val = clampInteger(e.target.value, 380, 750, 540);
      wlInput.value = val;
      if (wlSlider) wlSlider.value = val;
      onCustomWlChange(val);
    };
  }

  // -- Peak Integration Sliders -------------------------------------------------
  $('peak-prominence').oninput = e => {
    $('peak-prominence-val').textContent = e.target.value;
    if (state.activeLane) updateDensitograms(true);
  };
  $('peak-distance').oninput = e => {
    $('peak-distance-val').textContent = e.target.value;
    if (state.activeLane) updateDensitograms(true);
  };
  $('peak-threshold').oninput = e => {
    $('peak-threshold-val').textContent = e.target.value;
    if (state.activeLane) updateDensitograms(true);
  };

  // -- Tool Selection Grid -----------------------------------------------------
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTool = btn.dataset.tool;
      render();
    };
  });

  document.querySelector('[data-tool="pan"]')?.classList.add('active');

  $('btn-restore-defaults').onclick = () => {
    $('peak-prominence').value = DEFAULT_PEAK_PROMINENCE;
    $('peak-prominence-val').textContent = DEFAULT_PEAK_PROMINENCE;
    $('peak-distance').value = DEFAULT_PEAK_DISTANCE;
    $('peak-distance-val').textContent = DEFAULT_PEAK_DISTANCE;
    $('peak-threshold').value = DEFAULT_PEAK_THRESHOLD;
    $('peak-threshold-val').textContent = DEFAULT_PEAK_THRESHOLD;
    if (state.activeLane) updateDensitograms(true);
  };

  // Setup Canvas Interactions
  setupCanvasEvents();

  // Initial Render
  render();

  // -- Streamlit: Signal that the component iframe is ready ------------------
  stReady();

  // Keep iframe height in sync with content
  window.addEventListener('resize', () => stSetHeight());
  stSetHeight();
}
