import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = { __stCallbacks: [], __stRenderQueue: [], parent: { postMessage() {} } };
globalThis.document = { getElementById: () => null };

const { state } = await import('../../frontend/modules/state.js');
const { buildAreaCalibrationModel, calculateCalibrationCurve } = await import('../../frontend/modules/analysis.js');
const { buildCalibrationNoteHTML, generatePeakRowHTML } = await import('../../frontend/modules/profiles.js');

const standard = (area, calibrationValue) => ({ type: 'S', area, calibrationValue });
const lanes = (...peaks) => [{ peaks }];

test('replicates at one amount become one mean-area, through-zero calibration level', () => {
  const plate = lanes(standard(8, 10), standard(12, '10'));
  const model = buildAreaCalibrationModel(plate);
  assert.deepEqual(model.levels, [{ value: 10, area: 10, replicates: 2 }]);
  assert.equal(model.evaluate(0), 0);
  assert.equal(model.evaluate(5), 5);
  assert.equal(model.evaluate(20), 20);
  state.lanes = plate;
  assert.equal(calculateCalibrationCurve()(20), 20);
  assert.match(buildCalibrationNoteHTML(model), /One measured level gives a proportional straight line through the assumed zero point/);
});

test('two distinct amounts use an origin-anchored quadratic and an upper endpoint line', () => {
  const model = buildAreaCalibrationModel(lanes(
    standard(8, 10), standard(12, 10), standard(28, 20), standard(32, 20),
  ));
  assert.deepEqual(model.levels.map(level => [level.value, level.area, level.replicates]),
    [[10, 10, 2], [20, 30, 2]]);
  assert.equal(model.evaluate(0), 0);
  assert.ok(Math.abs(model.evaluate(5) - 5.416666666666667) < 1e-12);
  assert.ok(Math.abs(model.evaluate(20) - 16.666666666666668) < 1e-12);
  assert.equal(model.evaluate(30), 20);
  assert.equal(model.evaluate(40), 25);
  assert.match(generatePeakRowHTML({ type: 'A', rf: 0.5, area: 40 }, 0, 'calibration', { calModel: model }),
    /Linear extrapolation outside standards; use caution/);
  assert.match(generatePeakRowHTML({ type: 'A', rf: 0.5, area: 5 }, 0, 'calibration', { calModel: model }),
    /Interpolation from assumed zero point/);
});

test('three and four levels use local quadratic interpolation within a fixed bracket', () => {
  const three = buildAreaCalibrationModel(lanes(standard(1, 1), standard(2, 4), standard(3, 9)));
  assert.equal(three.evaluate(0), 0);
  assert.equal(three.evaluate(0.5), 0.25, 'a zero derivative at the origin is allowed');
  assert.equal(three.evaluate(1.5), 2.25);
  assert.equal(three.evaluate(2.5), 6.25);
  assert.equal(three.evaluate(4), 14, 'above the highest measured level uses the final pair line');
  const four = buildAreaCalibrationModel(lanes(
    standard(1, 1), standard(2, 4), standard(3, 9), standard(4, 16),
  ));
  assert.equal(four.evaluate(2.5), 6.25);
  assert.equal(four.evaluate(3.5), 12.25);
  assert.deepEqual(four.levels.map(level => four.evaluate(level.area)), [1, 4, 9, 16]);
  assert.equal(four.evaluate(5), 23, 'above the range uses the last measured pair line');
  const uneven = buildAreaCalibrationModel(lanes(
    standard(1, 1), standard(2, 4), standard(3, 9), standard(4, 17),
  ));
  // The middle bracket uses the same left-hand third standard throughout.
  assert.ok(Math.abs(uneven.evaluate(2.2) - 4.84) < 1e-12);
  assert.ok(Math.abs(uneven.evaluate(2.8) - 7.84) < 1e-12);
  let previous = -Infinity;
  for (let area = 1; area <= 4; area += 0.02) {
    const value = uneven.evaluate(area);
    assert.ok(value >= previous - 1e-9);
    previous = value;
  }
  assert.equal(uneven.evaluate(0.5), 0.25, 'the first bracket uses the assumed origin');
  assert.equal(uneven.evaluate(5), 25, 'the upper line uses the last two measured levels');
  assert.ok(Math.abs(uneven.evaluate(1 - 1e-6) - 1) < 1e-5);
  assert.ok(Math.abs(uneven.evaluate(4 + 1e-6) - 17) < 1e-5);
});

test('three measured levels preserve interior calibration and restore upper endpoint line', () => {
  const model = buildAreaCalibrationModel(lanes(
    standard(553.9, 50), standard(755.3, 80), standard(859.65, 100),
  ));
  assert.equal(model.evaluate(0), 0);
  assert.ok(Math.abs(model.evaluate(500) - 43.0404327444) < 1e-8);
  assert.ok(Math.abs(model.evaluate(789) - 86.1264811947) < 1e-8);
  assert.ok(Math.abs(model.evaluate(900) - 107.7335888836) < 1e-8);
  assert.match(buildCalibrationNoteHTML(model), /last two measured levels define straight-line extrapolation/);
  assert.match(generatePeakRowHTML({ type: 'A', rf: 0.5, area: 900 }, 0, 'calibration', { calModel: model }),
    /Linear extrapolation outside standards; use caution/);
  assert.match(generatePeakRowHTML({ type: 'A', rf: 0.5, area: 0 }, 0, 'calibration', { calModel: model }),
    /Interpolation from assumed zero point/);
});

test('a backward-bending origin segment falls back to its straight line', () => {
  const two = buildAreaCalibrationModel(lanes(standard(1, 1), standard(2, 20)));
  assert.equal(two.evaluate(0), 0);
  assert.equal(two.evaluate(0.5), 0.5);
  assert.equal(two.evaluate(1.5), 8.25, 'the valid measured bracket keeps its quadratic');
  const three = buildAreaCalibrationModel(lanes(standard(1, 1), standard(2, 20), standard(3, 21)));
  assert.equal(three.evaluate(0.5), 0.5);
});

test('backward-bending local quadratics fall back to their bracket line', () => {
  const model = buildAreaCalibrationModel(lanes(standard(1, 1), standard(2, 2), standard(3, 20)));
  assert.equal(model.evaluate(1.5), 1.5);
  assert.equal(model.evaluate(2.5), 8.875, 'the other bracket keeps its valid quadratic');
  for (let area = 1; area <= 3; area += 0.1) {
    const value = model.evaluate(area);
    assert.ok(value >= 1 && value <= 20);
  }
});

test('equal or decreasing mean response and unusable standards are visible errors', () => {
  for (const plate of [lanes(standard(10, 1), standard(10, 2)),
    lanes(standard(20, 1), standard(10, 2))]) {
    const model = buildAreaCalibrationModel(plate);
    assert.equal(model.evaluate, null);
    assert.match(buildCalibrationNoteHTML(model), /Calibration unavailable: Mean standard areas must increase/);
  }
  const zeroConflict = buildAreaCalibrationModel(lanes(standard(10, 0), standard(12, 5)));
  assert.match(zeroConflict.error, /zero-amount S standard has positive area/);
  assert.equal(zeroConflict.evaluate, null);
  assert.deepEqual(zeroConflict.levels, [{ value: 5, area: 12, replicates: 1 }]);
  const redundantZero = buildAreaCalibrationModel(lanes(standard(0, 0), standard(12, 5)));
  assert.deepEqual(redundantZero.levels, [{ value: 5, area: 12, replicates: 1 }]);
  assert.equal(redundantZero.skippedCount, 0);
  assert.equal(redundantZero.evaluate(0), 0);
  const nearOrigin = buildAreaCalibrationModel(lanes(standard(1e-10, 5), standard(12, 10)));
  assert.match(nearOrigin.error, /too close to the assumed zero-area origin/);
  const blank = buildAreaCalibrationModel(lanes(standard(10, null), standard(11, ''), standard(12, 5)));
  assert.equal(blank.skippedCount, 2);
  assert.equal(blank.evaluate(24), 10);
  assert.equal(blank.evaluate(Number.NaN), null);
  assert.match(generatePeakRowHTML({ type: 'S', rf: 0.5, area: 10, calibrationValue: 0 }, 0, 'calibration'), /value="0"/);
  assert.match(generatePeakRowHTML({ type: 'S', rf: 0.5, area: 10, calibrationValue: NaN }, 0, 'calibration'), /value=""/);
});
