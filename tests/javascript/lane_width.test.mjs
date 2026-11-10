import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCommonLaneWidth,
  maxCommonLaneWidth,
} from '../../frontend/modules/lane_width.js';

const lane = (cx, cy, { width = 5, height = 30, angle = 0 } = {}) => ({
  cx,
  cy,
  w: width,
  h: height,
  angle,
});

function assertTenthNear(actual, expected) {
  assert.ok(Number.isFinite(actual), `Expected a finite width, received ${actual}`);
  assert.ok(actual <= expected + 1e-8, `${actual} exceeds ${expected}`);
  assert.ok(actual >= expected - 0.1 - 1e-8, `${actual} is more than one tenth below ${expected}`);
  assert.ok(Math.abs(actual * 10 - Math.round(actual * 10)) < 1e-8,
    `${actual} is not a multiple of 0.1`);
}

test('adjacent lanes limit their common width, regardless of their existing widths', () => {
  const lanes = [lane(40, 50, { width: 5 }), lane(60, 50, { width: 50 })];
  assertTenthNear(maxCommonLaneWidth(lanes, 100), 20);
});

test('vertically separate lanes may use the full image width', () => {
  const lanes = [
    lane(50, 20, { height: 20 }),
    lane(50, 80, { height: 20 }),
  ];
  assert.equal(maxCommonLaneWidth(lanes, 100), 100);
});

test('image edges cap the width before the backend would clip the strip', () => {
  assert.equal(maxCommonLaneWidth([lane(10, 50)], 100), 20);
  const state = { lanes: [lane(10, 50)], imgW: 100, laneWidth: 5 };
  assert.equal(applyCommonLaneWidth(state, 100), true);
  assert.equal(state.laneWidth, 20);
  assert.equal(state.lanes[0].w, 20);
});

test('moving a lane centre changes the common limit', () => {
  const lanes = [lane(40, 50), lane(60, 50)];
  assertTenthNear(maxCommonLaneWidth(lanes, 100), 20);
  lanes[1].cx = 70;
  assertTenthNear(maxCommonLaneWidth(lanes, 100), 30);
});

test('rotated lanes respect both the visible and backend-sampled orientations', () => {
  const angle = Math.PI / 4;
  const lanes = [
    lane(40, 40, { angle }),
    lane(60, 50, { angle }),
  ];

  // The centre offset is (20, 10). In the visible +45-degree frame, its
  // horizontal component is about 21.2 px; in the backend -45-degree frame,
  // it is about 7.1 px. Both frames overlap vertically at height 30 px.
  assertTenthNear(maxCommonLaneWidth(lanes, 100), Math.SQRT1_2 * 10);
});

test('duplicate centres have no feasible common width', () => {
  const state = { lanes: [lane(50, 50), lane(50, 50)], imgW: 100, laneWidth: 5 };
  assert.equal(maxCommonLaneWidth(state.lanes, 100), 0);
  assert.equal(applyCommonLaneWidth(state, 10), false);
  assert.equal(state.laneWidth, 5);
  assert.deepEqual(state.lanes.map(item => item.w), [5, 5]);
});

test('a maximum below the two-pixel minimum is infeasible', () => {
  const state = { lanes: [lane(50, 50), lane(51, 50)], imgW: 100, laneWidth: 5 };
  assert.equal(applyCommonLaneWidth(state, 2), false);
  assert.equal(state.laneWidth, 5);
});

test('applying a common width clamps once and remains idempotent', () => {
  const state = { lanes: [lane(40, 50), lane(60, 50)], imgW: 100, laneWidth: 5 };

  assert.equal(applyCommonLaneWidth(state, 1), true);
  assert.equal(state.laneWidth, 2);
  assert.deepEqual(state.lanes.map(item => item.w), [2, 2]);

  assert.equal(applyCommonLaneWidth(state, 12), true);
  assert.equal(state.laneWidth, 12);
  assert.deepEqual(state.lanes.map(item => item.w), [12, 12]);
  assert.equal(applyCommonLaneWidth(state, 12), true);
  assert.deepEqual(state.lanes.map(item => item.w), [12, 12]);

  assert.equal(applyCommonLaneWidth(state, 999), true);
  assertTenthNear(state.laneWidth, 20);
  assert.deepEqual(state.lanes.map(item => item.w), [state.laneWidth, state.laneWidth]);
});

test('empty lane arrays have no width and cannot be changed', () => {
  const state = { lanes: [], imgW: 100, laneWidth: 8 };
  assert.equal(maxCommonLaneWidth([], 100), 0);
  assert.equal(applyCommonLaneWidth(state, 12), false);
  assert.equal(state.laneWidth, 8);
});
