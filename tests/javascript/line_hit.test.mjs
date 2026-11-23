import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPos, hitBoundaryLine } from '../../frontend/modules/coords.js';
import { state } from '../../frontend/modules/state.js';

const line = { cx: 200, cy: 200, w: 160, angle: 0 };

function canvas(cssSize = 400) {
  return {
    width: 400,
    height: 400,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: cssSize, height: cssSize }),
  };
}

function screenPoint(surface, yOffsetCss, xOffsetCss = 0) {
  const rect = surface.getBoundingClientRect();
  const x = (line.cx * state.view.zoom + state.view.dx) * rect.width / surface.width;
  const y = (line.cy * state.view.zoom + state.view.dy) * rect.height / surface.height;
  return getPos({ clientX: rect.left + x + xOffsetCss, clientY: rect.top + y + yOffsetCss }, surface);
}

test('a nearby second line is not captured by the first line at high zoom', () => {
  const previous = { imgW: state.imgW, imgH: state.imgH, imageRotation: state.imageRotation, view: state.view };
  try {
    state.imgW = 400; state.imgH = 400; state.imageRotation = 0;
    const surface = canvas();
    for (const zoom of [1, 4, 12]) {
      state.view = { zoom, dx: 200 - 200 * zoom, dy: 200 - 200 * zoom };
      assert.equal(hitBoundaryLine(screenPoint(surface, 7), line, surface), true);
      assert.equal(hitBoundaryLine(screenPoint(surface, 9), line, surface), false);
      assert.equal(hitBoundaryLine(screenPoint(surface, 0, 90 * zoom), line, surface), false);
    }
  } finally {
    Object.assign(state, previous);
  }
});

test('line grab distance stays in CSS pixels when the canvas is scaled', () => {
  const previous = { imgW: state.imgW, imgH: state.imgH, imageRotation: state.imageRotation, view: state.view };
  try {
    state.imgW = 400; state.imgH = 400; state.imageRotation = 0;
    state.view = { zoom: 4, dx: -600, dy: -600 };
    const surface = canvas(200);
    assert.equal(hitBoundaryLine(screenPoint(surface, 7), line, surface), true);
    assert.equal(hitBoundaryLine(screenPoint(surface, 9), line, surface), false);
  } finally {
    Object.assign(state, previous);
  }
});
