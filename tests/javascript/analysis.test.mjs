import assert from 'node:assert/strict';
import { calculatePeakArea, findPeakBounds } from '../../frontend/modules/analysis.js';

const triangle = [0, 1, 2, 1, 0];
assert.equal(calculatePeakArea(triangle, 0, 4), 4);
assert.equal(calculatePeakArea(triangle, 3, 1), 0);

const bounds = findPeakBounds(triangle, 2, 50);
assert.equal(bounds.area_lb, 0);
assert.equal(bounds.area_rb, 4);
assert.deepEqual([bounds.area_lb, bounds.area_rb], [bounds.display_lb, bounds.display_rb]);

const widthProfile = [0, 5, 25, 100, 25, 5, 0];
const wide = findPeakBounds(widthProfile, 3, 20);
const narrow = findPeakBounds(widthProfile, 3, 60);
assert.deepEqual([wide.area_lb, wide.area_rb], [1, 5]);
assert.deepEqual([narrow.area_lb, narrow.area_rb], [2, 4]);
assert.ok(calculatePeakArea(widthProfile, narrow.area_lb, narrow.area_rb)
  < calculatePeakArea(widthProfile, wide.area_lb, wide.area_rb));

console.log('analysis contract tests passed');
