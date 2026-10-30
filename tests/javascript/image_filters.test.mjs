import assert from 'node:assert/strict';
import { wavelengthToRgb, wavelengthWindowToRgb } from '../../frontend/modules/image_filters.js';

assert.deepEqual(wavelengthWindowToRgb(650, 0), wavelengthToRgb(650));
assert.equal(wavelengthWindowToRgb(650, 0).g, 0);
assert.ok(wavelengthWindowToRgb(650, 50).g > 0);
assert.notDeepEqual(wavelengthWindowToRgb(380, 50), wavelengthToRgb(380));
assert.deepEqual(wavelengthWindowToRgb(650.5, 0.5), wavelengthWindowToRgb(651, 1));
assert.throws(() => wavelengthWindowToRgb(650, 51), RangeError);

console.log('RGB window tests passed');
