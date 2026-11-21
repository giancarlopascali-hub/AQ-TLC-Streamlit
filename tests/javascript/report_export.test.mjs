import assert from 'node:assert/strict';
import { test } from 'node:test';

const canvases = [];
const links = new Map();
const body = { appendChild(node) { if (node.id) links.set(node.id, node); } };
globalThis.document = {
  body,
  getElementById(id) { return links.get(id) || null; },
  createElement(tag) {
    if (tag === 'a') return { clickCount: 0, click() { this.clickCount++; } };
    assert.equal(tag, 'canvas');
    const context = {
      strokes: [], fillRects: [], images: [],
      save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {},
      moveTo() {}, lineTo() {}, setLineDash() {}, fillText() {},
      stroke() { this.strokes.push(this.strokeStyle); },
      fillRect(...args) { this.fillRects.push({ color: this.fillStyle, args }); },
      drawImage(...args) { this.images.push(args); },
    };
    const canvas = {
      width: 0, height: 0, context,
      getContext() { return context; },
      toDataURL() { return `data:image/png;base64,canvas${canvases.length}`; },
    };
    canvases.push(canvas);
    return canvas;
  },
};
globalThis.window = { __stCallbacks: [], __stRenderQueue: [], parent: { postMessage() {} } };
globalThis.alert = message => { throw new Error(`Unexpected alert: ${message}`); };

const { state } = await import('../../frontend/modules/state.js');
const { exportReport } = await import('../../frontend/modules/export.js');

function makeLane() {
  const measured = [0, 1, 2, 3, 6, 9, 7, 3, 1, 0, 0];
  const groupId = '1:5';
  return {
    id: 1, name: 'Plate lane', cx: 50, cy: 50, w: 20, h: 100, angle: 0,
    profile: [...measured].reverse(), profile_analysis: measured,
    peaks: [
      { idx: 4, rf: 0.6, area: 8, fit_area: 7, area_method: 'deconvolved', fit_group_id: groupId, fit_component_index: 0, type: 'N' },
      { idx: 6, rf: 0.4, area: 12, fit_area: 11, area_method: 'deconvolved', fit_group_id: groupId, fit_component_index: 1, type: 'N' },
    ],
    fit_groups: [{
      id: groupId, status: 'resolved', reason: 'accepted', decision: 'split', active: true,
      original_peak: { idx: 5, rf: 0.5, area: 15 },
      bounds: { lb: 3, rb: 7 }, integration_bounds: { lb: 3, rb: 7 },
      integration_segments: [{ lb: 3, rb: 4, area: 8 }, { lb: 6, rb: 7, area: 12 }],
      width_threshold: 50, measured_cluster_area: 20,
      quality: { noise: 1, rmse_single: 5, rmse_double: 2, improvement: 0.6, separation: 2, aicc_delta: 20, component_share: 0.4, snr: 8 },
      baseline_curve: [1, 1, 1, 1, 1],
      single_curve: [2, 3, 5, 3, 2], double_curve: [2, 4, 7, 5, 2],
      components: [
        { peak_index: 0, area: 8, fit_area: 7, curve: [1, 2, 3, 1, 0] },
        { peak_index: 1, area: 12, fit_area: 11, curve: [0, 1, 3, 3, 1] },
      ],
    }],
  };
}

function readyState() {
  const lane = makeLane();
  state.activeLane = lane;
  state.lanes = [lane];
  state.imgEl = { complete: true, naturalWidth: 200, naturalHeight: 200 };
  state.imgB64 = 'data:image/jpeg;base64,plate';
  state.imgW = 100;
  state.imgH = 100;
  state.shoulderSensitivity = 50;
  state.integrationMethod = 'relative';
  state.isProfilePending = false;
  state.isProfileStale = false;
}

function makePopup() {
  const writes = [];
  return {
    writes,
    document: { open() {}, close() {}, write(value) { writes.push(value); } },
  };
}

test('Export Lane opens in the click path and includes fit provenance, summary and drawn overlays', async () => {
  readyState();
  canvases.length = 0;
  const popup = makePopup();
  const events = [];
  window.open = () => { events.push('open'); return popup; };
  let imageConstructed = 0;
  globalThis.Image = class { constructor() { imageConstructed++; } };

  const result = exportReport();
  // No image wait is needed for the already loaded workspace image.
  assert.equal(events[0], 'open');
  assert.equal(imageConstructed, 0);
  await result;

  const html = popup.writes.at(-1);
  assert.match(html, /AQ-TLC Analytical Report/);
  assert.match(html, /Model allocated · fit 7\.0 AU/);
  assert.match(html, /Measured cluster 20\.0 AU/);
  assert.match(html, /Allocated sum 20\.0 AU/);
  assert.match(html, /Width%-controlled component windows/);
  assert.match(html, /Fit total/);
  const link = links.get('report-download-link');
  assert.ok(link, 'every completed report has a visible HTML download link');
  assert.equal(link.textContent, 'Download report HTML');
  assert.equal(link.download, 'AQ-TLC_Report_Plate_lane.html');
  assert.equal(link.clickCount, 0, 'a successful popup does not auto-download');
  const [strip, chart] = canvases;
  assert.deepEqual(strip.context.images[0].slice(-2), [100, 100]);
  assert.equal(strip.context.fillRects.filter(item => item.color === 'rgba(128,85,183,0.24)').length, 2);
  assert.ok(chart.context.strokes.includes('#0366d6'), 'measured trace was drawn');
  assert.ok(chart.context.strokes.includes('#008f82'), 'fit total was drawn');
  assert.ok(chart.context.strokes.includes('#8055b7'), 'first component was drawn');
  assert.ok(chart.context.strokes.includes('#b8741d'), 'second component was drawn');
});

test('popup blocking leaves a clickable report download link', async () => {
  readyState();
  window.open = () => null;
  const originalCreateUrl = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:aq-tlc-report';
  try {
    await exportReport();
    const link = links.get('report-download-link');
    assert.ok(link);
    assert.equal(link.href, 'blob:aq-tlc-report');
    assert.equal(link.download, 'AQ-TLC_Report_Plate_lane.html');
    assert.equal(link.clickCount, 1);
  } finally {
    URL.createObjectURL = originalCreateUrl;
  }
});

test('uncached image fallback opens popup before loading and installs onload before src', async () => {
  readyState();
  state.imgEl = null;
  const events = [];
  const popup = makePopup();
  window.open = () => { events.push('open'); return popup; };
  globalThis.Image = class {
    complete = false;
    naturalWidth = 0;
    set src(value) {
      assert.equal(typeof this.onload, 'function');
      events.push('image-src');
      queueMicrotask(() => { this.complete = true; this.naturalWidth = 100; this.onload(); });
    }
  };
  await exportReport();
  assert.deepEqual(events, ['open', 'image-src']);
  assert.match(popup.writes.at(-1), /AQ-TLC Analytical Report/);
});

test('area calibration report uses replicate mean areas and labels proportional estimates', async () => {
  readyState();
  const lane = state.activeLane;
  lane.peaks = [{ idx: 5, rf: 0.5, area: 15, area_lb: 4, area_rb: 6, type: 'A' }];
  lane.fit_groups = [];
  state.lanes.push({ id: 2, peaks: [
    { type: 'S', area: 8, calibrationValue: 10 },
    { type: 'S', area: 12, calibrationValue: 10 },
  ] });
  state.integrationMethod = 'calibration';
  state.shoulderSensitivity = 0;
  const popup = makePopup();
  window.open = () => popup;
  await exportReport();
  const html = popup.writes.at(-1);
  assert.match(html, /1 known amount level from 2 standard spots/);
  assert.match(html, /One measured level gives a proportional straight line through the assumed zero point/);
  assert.match(html, /<td style="text-align:right"><span style="color:#238636; font-weight:700">15\.00<\/span>/);
});

test('area calibration report uses the assumed zero point and linear upper extrapolation', async () => {
  readyState();
  const lane = state.activeLane;
  lane.peaks = [
    { idx: 4, rf: 0.6, area: 0, area_lb: 3, area_rb: 5, type: 'A' },
    { idx: 6, rf: 0.4, area: 900, area_lb: 5, area_rb: 7, type: 'A' },
  ];
  lane.fit_groups = [];
  state.lanes.push({ id: 2, peaks: [
    { type: 'S', area: 553.9, calibrationValue: 50 },
    { type: 'S', area: 755.3, calibrationValue: 80 },
    { type: 'S', area: 859.65, calibrationValue: 100 },
  ] });
  state.integrationMethod = 'calibration';
  state.shoulderSensitivity = 0;
  const popup = makePopup();
  window.open = () => popup;
  await exportReport();
  const html = popup.writes.at(-1);
  assert.match(html, /Zero area is assumed to mean zero amount/);
  assert.match(html, /last two measured levels define straight-line extrapolation/);
  assert.match(html, /0\.00<\/span>/);
  assert.match(html, /107\.73<\/span><small class="calibration-extrapolation"/);
  assert.match(html, /Linear extrapolation outside standards; use caution/);
});

test('area calibration report fits two measured levels with the assumed zero point', async () => {
  readyState();
  const lane = state.activeLane;
  lane.peaks = [
    { idx: 4, rf: 0.6, area: 0.5, area_lb: 3, area_rb: 5, type: 'A' },
    { idx: 6, rf: 0.4, area: 1.5, area_lb: 5, area_rb: 7, type: 'A' },
  ];
  lane.fit_groups = [];
  state.lanes.push({ id: 2, peaks: [
    { type: 'S', area: 1, calibrationValue: 1 },
    { type: 'S', area: 2, calibrationValue: 4 },
  ] });
  state.integrationMethod = 'calibration';
  state.shoulderSensitivity = 0;
  const popup = makePopup();
  window.open = () => popup;
  await exportReport();
  const html = popup.writes.at(-1);
  assert.match(html, /2 known amount levels from 2 standard spots/);
  assert.match(html, /Two measured levels and the assumed zero point define a quadratic/);
  assert.match(html, /0\.25<\/span><small class="calibration-extrapolation"/);
  assert.match(html, /Interpolation from assumed zero point/);
  assert.match(html, /2\.25<\/span>/);
});

test('report stops if analysis changes while its image is loading', async () => {
  readyState();
  state.imgEl = null;
  const popup = makePopup();
  window.open = () => popup;
  const alerts = [];
  globalThis.alert = message => alerts.push(message);
  globalThis.Image = class {
    complete = false;
    naturalWidth = 0;
    set src(_value) {
      queueMicrotask(() => {
        state.isProfilePending = true;
        this.complete = true;
        this.naturalWidth = 100;
        this.onload();
      });
    }
  };
  try {
    await exportReport();
    assert.match(popup.writes.at(-1), /analysis changed while preparing the report/);
    assert.match(alerts[0], /analysis changed while preparing the report/);
  } finally {
    globalThis.alert = message => { throw new Error(`Unexpected alert: ${message}`); };
    state.isProfilePending = false;
  }
});
