import assert from 'node:assert/strict';
import { calculatePeakArea, findPeakBounds } from '../../frontend/modules/analysis.js';

const triangle = [0, 1, 2, 1, 0];
assert.equal(calculatePeakArea(triangle, 0, 4), 4);
assert.equal(calculatePeakArea(triangle, 3, 1), 0);

const bounds = findPeakBounds(triangle, 2, 50);
assert.equal(bounds.area_lb, 0);
assert.equal(bounds.area_rb, 4);
assert.ok(bounds.display_lb >= bounds.area_lb);
assert.ok(bounds.display_rb <= bounds.area_rb);

console.log('analysis contract tests passed');
