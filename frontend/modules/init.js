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
    dz.onclick = () => fi.click();
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
      if (e.target.files.length) handleFile(e.target.files[0]);
    };
  }

  // -- Sidebar Action Buttons -------------------------------------------------
  $('btn-new').onclick = () => resetState(false);
  $('btn-reset').onclick = () => {
    resetState(true);
    renderProfiles();
    render();
  };
  $('btn-calc-lanes').onclick = () => calculateLanes();

  // -- Polarity Toggle Buttons -------------------------------------------------
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.polarityMode = btn.dataset.mode;
      if (state.activeLane) updateDensitograms(true);
    };
  });

  // -- Wavelength Filter Handlers ----------------------------------------------
  const wavelengthToHex = (wavelength) => {
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
    const toHex = c => Math.round(c * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  };

  const updateWavelengthSwatch = (wl) => {
    const swatch = $('wl-swatch');
    if (!swatch) return;
    if (wl === null || wl === 'full') {
      swatch.style.background = '#ffffff';
    } else {
      swatch.style.background = wavelengthToHex(parseFloat(wl));
    }
  };

  const wlControls = $('wl-custom-controls');
  const wlSlider   = $('wl-slider');
  const wlInput    = $('wl-num-input');

  const updateWlControlsVisibility = () => {
    if (!wlControls) return;
    wlControls.style.display = (state.wavelengthPreset === 'full') ? 'none' : 'flex';
  };

  const setWavelength = (wl, updateInputs = true) => {
    if (wl === 'full' || wl === null) {
      state.targetWavelength = null;
      updateWavelengthSwatch(null);
    } else if (wl === 'custom') {
      if (state.targetWavelength === null) {
        state.targetWavelength = 540;
        if (wlSlider)  wlSlider.value  = 540;
        if (wlInput)   wlInput.value   = 540;
        updateWavelengthSwatch(540);
      }
      updateWlControlsVisibility();
      render();
      return;
    } else {
      const numWl = parseFloat(wl);
      state.targetWavelength = isNaN(numWl) ? null : numWl;
      updateWavelengthSwatch(state.targetWavelength);
      if (updateInputs && state.targetWavelength !== null) {
        if (wlSlider) wlSlider.value = state.targetWavelength;
        if (wlInput)  wlInput.value  = state.targetWavelength;
      }
    }
    updateWlControlsVisibility();
    render();
    if (state.lanes.length > 0) updateDensitograms(false);
  };

  updateWlControlsVisibility();

  const btnInvert = $('btn-invert-colors');
  if (btnInvert) {
    btnInvert.onclick = () => {
      state.invertColors = !state.invertColors;
      btnInvert.classList.toggle('active', state.invertColors);
      render();
      if (state.lanes.length > 0) updateDensitograms(false);
    };
  }

  const bwSlider = $('wl-bw-slider');
  if (bwSlider) {
    bwSlider.oninput = e => {
      if ($('wl-bw-val')) $('wl-bw-val').textContent = e.target.value;
      state.wavelengthBandwidth = parseInt(e.target.value, 10);
    };
    bwSlider.onchange = e => {
      if (state.lanes.length > 0) updateDensitograms(false);
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
    const numVal = parseFloat(val);
    if (isNaN(numVal)) return;
    const clamped = Math.min(750, Math.max(380, numVal));
    document.querySelectorAll('.wl-preset-btn').forEach(b => b.classList.remove('active'));
    $('wl-preset-custom')?.classList.add('active');
    state.wavelengthPreset = 'custom';
    setWavelength(clamped, true);
  };

  if (wlSlider) {
    wlSlider.oninput = e => {
      if (wlInput) wlInput.value = e.target.value;
      updateWavelengthSwatch(parseFloat(e.target.value));
      state.targetWavelength = parseFloat(e.target.value);
      render();
    };
    wlSlider.onchange = e => onCustomWlChange(e.target.value);
  }

  if (wlInput) {
    wlInput.onchange = e => {
      const val = Math.min(750, Math.max(380, parseFloat(e.target.value) || 540));
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
