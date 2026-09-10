/**
 * @module state
 * @file modules/state.js
 *
 * Centralised application state for AQ-TLC.
 *
 * ALL modules import `state` from here to read and write application data.
 * Because `state` is exported as a plain object reference, any module that
 * mutates a property (e.g. `state.lanes.push(...)`) is immediately visible
 * to every other module — no pub/sub or store boilerplate required.
 *
 * IMPORTANT: Never reassign `state` itself (e.g. `state = {...}`).
 * Only mutate its properties. This preserves the live-binding across modules.
 */

/**
 * The single source of truth for all application state.
 *
 * @typedef {Object} AppState
 */
export const state = {
  // ── Image ──────────────────────────────────────────────────────────────
  /** @type {HTMLImageElement|null} Currently loaded image element. */
  imgEl:          null,

  /** @type {string|null} Base64 data-URL of the current (possibly cropped) image. */
  imgB64:         null,

  /** @type {string|null} Base64 data-URL of the original image before any crop. */
  originalB64:    null,

  /** @type {number} Display width of the image in pixels. */
  imgW:           0,

  /** @type {number} Display height of the image in pixels. */
  imgH:           0,

  /** @type {number} Current image rotation in radians (applied at draw time). */
  imageRotation:  0,

  // ── Annotations ────────────────────────────────────────────────────────
  /** @type {Array<{cx:number, cy:number, w:number, angle:number}>} Boundary lines (Origin / Front). */
  lines:          [],

  /** @type {Array<{x:number, y:number}>} Spotting marks placed on the Origin line. */
  spottingMarks:  [],

  /**
   * Detected / calculated lane objects.
   * Each lane: { id, cx, cy, w, h, angle, profile:number[], peaks:Object[] }
   * @type {Array<Object>}
   */
  lanes:          [],

  // ── Active selections ──────────────────────────────────────────────────
  /**
   * Currently active tool identifier.
   * One of: 'pan' | 'select' | 'line' | 'spotting' | 'roi' | 'rotate_img'
   * @type {string}
   */
  activeTool:     'pan',

  /** @type {Object|null} Currently selected boundary line object. */
  activeLine:     null,

  /** @type {Object|null} Currently selected lane object. */
  activeLane:     null,

  /** @type {Object|null} Currently selected spotting mark object. */
  activeMark:     null,

  // ── Canvas view transform ──────────────────────────────────────────────
  /** @type {{zoom:number, dx:number, dy:number}} Pan and zoom state. */
  view:           { zoom: 1, dx: 0, dy: 0 },

  // ── Drag / interaction transient state ────────────────────────────────
  /** @type {Object|null} Canvas position where the current drag started. */
  dragStart:      null,

  /** @type {{x:number, y:number}} Screen position where drag started (for panning delta). */
  mStart:         { x: 0, y: 0 },

  /** @type {{dx:number, dy:number}} View state at drag start (for pan undo). */
  viewStart:      { dx: 0, dy: 0 },

  /** @type {boolean} True while the pan tool is actively dragging. */
  isPanning:      false,

  /** @type {boolean} True while the rotate tool is actively dragging. */
  isRotating:     false,

  /** @type {number} imageRotation value at the start of a rotation drag. */
  rotateStart:    0,

  /**
   * Peak object currently being dragged in the densitogram chart.
   * Set to the peak object on mousedown, null on mouseup.
   * @type {Object|null}
   */
  isDraggingPeak:  null,

  /**
   * Boundary drag state for peak-width resizing in the chart.
   * Set to {pk: peakObject, type: 'lb'|'rb'} on mousedown, null on mouseup.
   * @type {{pk:Object, type:string}|null}
   */
  isDraggingBound: null,

  /**
   * ROI crop rectangle in image-space coordinates.
   * Set while the 'roi' tool is active and the user is dragging.
   * @type {{x:number, y:number, w:number, h:number}|null}
   */
  roiRect:         null,

  /**
   * Identifies what kind of edit is in progress during a drag.
   * One of: 'move-mark' | 'move-line' | 'move-lane' | 'resize-line' | null
   * @type {string|null}
   */
  editingField:    null,

  // ── Analysis ───────────────────────────────────────────────────────────
  /**
   * Active integration modality for the analysis panel.
   * One of: 'relative' | 'calibration' | 'mw_calibration'
   * @type {string}
   */
  integrationMethod: 'relative',

  // ── Undo ───────────────────────────────────────────────────────────────
  /**
   * Stack of serialised state snapshots for undo (Ctrl+Z).
   * Capped at UNDO_STACK_LIMIT entries; oldest entries are discarded first.
   * @type {Array<Object>}
   */
  undoStack:       [],

  // ── Chart ──────────────────────────────────────────────────────────────
  /**
   * Horizontal zoom and pan state for the densitogram chart canvas.
   * zoom: 1 = full view, >1 = zoomed in. offset shifts the visible window.
   * @type {{zoom:number, offset:number}}
   */
  chartView:       { zoom: 1, offset: 0 },

  // ── Polarity ───────────────────────────────────────────────────────────
  /**
   * Signal polarity mode for density profile extraction.
   * 'default'  — auto-detect based on mean vs median heuristic.
   * 'dark'     — force dark-spot mode (UV quenching): inverts signal.
   * 'bright'   — force bright-spot mode (fluorescence): uses signal as-is.
   * @type {string}
   */
  polarityMode:    'default',

  // ── Wavelength Filter ───────────────────────────────────────────────────
  /**
   * Target wavelength for spectral filtering (in nm, 380..750).
   * null or 'full' indicates full-spectrum RGB grayscale conversion.
   * @type {number|string|null}
   */
  targetWavelength: null,

  /** @type {string} Active wavelength preset button ('full'|'540'|'570'|'450'|'650'|'custom') */
  wavelengthPreset: 'full',

  /** @type {number} Spectral filter bandwidth (+/- nm) */
  wavelengthBandwidth: 25,

  /** @type {boolean} True if visual image colors are inverted */
  invertColors: false,
};

/**
 * Shorthand for document.getElementById.
 * Imported by all modules that need to access DOM elements by ID.
 *
 * @param {string} id - Element ID.
 * @returns {HTMLElement|null}
 */
export const $ = id => document.getElementById(id);
