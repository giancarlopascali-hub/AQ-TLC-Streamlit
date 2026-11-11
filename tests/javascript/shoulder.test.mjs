import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyFitDecision,
  analysisReady,
  fitCurveSeries,
  fitIntegrationSegments,
  invalidateKeptFitGroup,
  isInsideActiveFit,
  normalizeShoulderSensitivity,
  overlapsActiveFit,
  shoulderSensitivityLabel,
  tagKeptFitPeaks,
} from '../../frontend/modules/shoulder.js';

globalThis.window = { __stCallbacks: [], __stRenderQueue: [], parent: { postMessage() {} } };
globalThis.document = { getElementById: () => null };
const { state } = await import('../../frontend/modules/state.js');
const { setupChartInteractions, attachTableEvents, generatePeakRowHTML, buildFitGroupsHTML, buildPanelHeader } =
  await import('../../frontend/modules/profiles.js');
const { exportReport, getReportProfile } = await import('../../frontend/modules/export.js');
const { updateDensitograms, cancelPendingProfileRequests } = await import('../../frontend/modules/api.js');

function fixture(decision = 'split') {
  const ordinary = { idx: 5, rf: 0.5, area: 20, area_lb: 3, area_rb: 7, type: 'N', name: 'Original' };
  const split = [
    { idx: 4, rf: 0.6, area: 8, fit_area: 7, area_method: 'deconvolved', fit_group_id: '1:5', fit_component_index: 0, type: 'N' },
    { idx: 6, rf: 0.4, area: 12, fit_area: 11, area_method: 'deconvolved', fit_group_id: '1:5', fit_component_index: 1, type: 'N' },
  ];
  const group = {
    id: '1:5', status: 'resolved', decision, active: decision === 'split',
    bounds: { lb: 3, rb: 7 }, integration_bounds: { lb: 3, rb: 7 },
    integration_segments: [{ lb: 3, rb: 4, area: 8 }, { lb: 6, rb: 7, area: 12 }],
    original_peak: ordinary, split_peaks: split,
    measured_cluster_area: 20, width_threshold: 50,
    quality: { noise: 1, rmse_single: 5, rmse_double: 2, improvement: 0.6, separation: 2 },
    baseline_curve: [1, 1, 1, 1, 1],
    double_curve: [2, 4, 6, 4, 2],
    components: [
      { peak_index: 0, area: 8, fit_area: 7, curve: [1, 2, 2, 1, 0] },
      { peak_index: 1, area: 12, fit_area: 11, curve: [0, 1, 3, 2, 1] },
    ],
  };
  return {
    profile_analysis: [0, 0, 1, 2, 4, 6, 4, 2, 1, 0, 0],
    peaks: decision === 'split' ? [{ idx: 1, rf: 0.9, area: 3, name: 'Manual', type: 'S', calibrationValue: 42 }, ...split.map(item => ({ ...item }))]
      : [{ idx: 1, rf: 0.9, area: 3, name: 'Manual', type: 'S', calibrationValue: 42 }, { ...ordinary }],
    fit_groups: [group],
  };
}

test('Off is the default and sensitivity is bounded', () => {
  assert.equal(normalizeShoulderSensitivity(-5), 0);
  assert.equal(shoulderSensitivityLabel(0), 'Off');
  assert.equal(normalizeShoulderSensitivity(150), 100);
});

test('fit overlays align to the measured profile and add the baseline to each component', () => {
  const lane = fixture();
  const series = fitCurveSeries(lane.fit_groups[0], lane.profile_analysis.length);
  assert.deepEqual([series.lb, series.rb], [3, 7]);
  assert.deepEqual(series.total, [2, 4, 6, 4, 2]);
  assert.deepEqual(series.components[0].curve, [2, 3, 3, 2, 1]);
});

test('Split and Keep single swap only their cluster and preserve unrelated annotations', () => {
  const lane = fixture('keep');
  tagKeptFitPeaks(lane);
  assert.equal(lane.peaks[1].fit_candidate_group_id, '1:5');
  lane.peaks[1].name = 'Adjusted original';
  assert.equal(applyFitDecision(lane, '1:5', 'split'), true);
  assert.equal(lane.peaks.length, 3);
  assert.equal(lane.peaks[0].name, 'Manual');
  assert.equal(lane.peaks[0].calibrationValue, 42);
  assert.equal(lane.fit_groups[0].active, true);
  assert.deepEqual(lane.fit_groups[0].components.map(item => item.peak_index), [1, 2]);
  lane.peaks[1].name = 'Component A';
  assert.equal(applyFitDecision(lane, '1:5', 'keep'), true);
  assert.equal(lane.peaks.length, 2);
  assert.equal(lane.peaks[1].name, 'Adjusted original');
  assert.deepEqual(lane.fit_groups[0].components.map(item => item.peak_index), [null, null]);
  assert.equal(applyFitDecision(lane, '1:5', 'split'), true);
  assert.equal(lane.peaks[1].name, 'Component A');
});

test('unresolved candidates cannot be forced to split', () => {
  const lane = fixture('keep');
  lane.fit_groups[0].status = 'unresolved';
  assert.equal(applyFitDecision(lane, '1:5', 'split'), false);
  assert.equal(lane.peaks.length, 2);
});

test('manual editing a kept candidate clears its stale fit preview and override', () => {
  const lane = fixture('keep');
  tagKeptFitPeaks(lane);
  const overrides = { '1:5': 'keep' };
  assert.equal(invalidateKeptFitGroup(lane, lane.peaks[1], overrides), true);
  assert.equal(lane.fit_groups.length, 0);
  assert.equal(lane.peaks[1].fit_candidate_group_id, undefined);
  assert.deepEqual(overrides, {});
});

test('active fitted interval blocks additions and direct component dragging', () => {
  const lane = fixture();
  state.chartView = { zoom: 1, offset: 0 };
  state.isDraggingPeak = null;
  state.isDraggingBound = null;
  state.undoStack = [];
  const cv = { width: 500, height: 280, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  setupChartInteractions(cv, lane);
  assert.equal(isInsideActiveFit(lane, 5), true);
  assert.equal(overlapsActiveFit(lane, 2, 4), true);
  assert.equal(overlapsActiveFit(lane, 5, 5), false);
  assert.deepEqual(fitIntegrationSegments(lane.fit_groups[0]).map(item => [item.lb, item.rb]), [[3, 4], [6, 7]]);
  cv.onmousedown({ clientX: 250, clientY: 100, button: 0 });
  cv.onmousemove({ clientX: 250, clientY: 100 });
  assert.equal(cv.style.cursor, 'not-allowed');
  cv.onmousedown({ clientX: 250, clientY: 100, button: 2 });
  assert.equal(state.isDraggingPeak, null);
  assert.equal(state.isDraggingBound, null);
  assert.equal(state.undoStack.length, 0);
  assert.equal(lane.peaks.length, 3);
  assert.equal(lane.peaks[1].area, 8);
});

test('fit provenance and cluster diagnostics appear in table and report summaries', () => {
  const lane = fixture();
  state.shoulderSensitivity = 50;
  state.isProfilePending = false;
  const row = generatePeakRowHTML(lane.peaks[1], 1, 'relative', { totalArea: 23 });
  assert.match(row, /Model allocated/);
  assert.match(row, /fit 7\.0 AU/);
  const summary = buildFitGroupsHTML(lane, true);
  assert.match(summary, /Measured cluster 20\.0 AU \(2 Width 50% component windows\)/);
  assert.match(summary, /Allocated sum 20\.0 AU/);
  assert.match(summary, /RMSE 5\.00 → 2\.00 AU/);
  assert.doesNotMatch(summary, /data-action="fit-decision"/);
});

test('report uses the measured analysis scale whether fitting is on or off', () => {
  const lane = fixture();
  lane.profile = [0, 50, 255];
  assert.equal(getReportProfile(lane), lane.profile_analysis);
  lane.fit_groups = [];
  assert.equal(getReportProfile(lane), lane.profile_analysis);
  delete lane.profile_analysis;
  assert.deepEqual(getReportProfile(lane), [255, 50, 0]);
});

test('On to Off cannot export stale fitted areas while the replacement response is pending', async () => {
  const lane = fixture();
  state.activeLane = lane;
  state.lanes = [lane];
  state.shoulderSensitivity = 0;
  state.isProfilePending = true;
  state.isProfileStale = true;
  assert.equal(buildFitGroupsHTML(lane, true), '');
  assert.equal(analysisReady(state), false);
  const pendingPanel = buildPanelHeader(lane);
  assert.doesNotMatch(pendingPanel, /id="chart-active"/);
  assert.doesNotMatch(pendingPanel, /id="peak-table-body"/);
  assert.match(pendingPanel, /btn-export-lane[^>]+disabled/);
  let message = '';
  globalThis.alert = text => { message = text; };
  await exportReport();
  assert.match(message, /still updating/);
  state.isProfilePending = false;
  assert.equal(analysisReady(state), false);
  state.isProfileStale = false;
  assert.equal(analysisReady(state), true);
});

test('an in-flight profile request blocks edits from an already mounted chart and table', () => {
  const lane = fixture('keep');
  state.lanes = [lane];
  state.activeLane = lane;
  state.imgB64 = 'pending-image';
  state.shoulderSensitivity = 0;
  state.chartView = { zoom: 1, offset: 0 };
  state.undoStack = [];
  const cv = { width: 500, height: 280, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  setupChartInteractions(cv, lane);
  const listeners = {};
  const tbody = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  attachTableEvents({ querySelector: () => tbody }, lane);

  updateDensitograms(true);
  assert.equal(analysisReady(state), false);
  cv.onmousedown({ clientX: 90, clientY: 100, button: 0 });
  cv.onmousemove({ clientX: 90, clientY: 100 });
  assert.equal(cv.style.cursor, 'wait');
  listeners.click({ target: { closest: () => ({ dataset: { idx: '0', type: 'A' } }) } });
  listeners.change({ target: { dataset: { action: 'set-calibration', idx: '0' }, value: '99' } });
  assert.equal(lane.peaks[0].type, 'S');
  assert.equal(lane.peaks[0].calibrationValue, 42);
  assert.equal(lane.peaks.length, 2);
  assert.equal(state.undoStack.length, 0);
  cancelPendingProfileRequests();
  state.imgB64 = null;
});
