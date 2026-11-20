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
  assert.equal(model.evaluate(5), 5);
  assert.equal(model.evaluate(20), 20);
  state.lanes = plate;
  assert.equal(calculateCalibrationCurve()(20), 20);
  assert.match(buildCalibrationNoteHTML(model), /One-level estimate assumes response is proportional/);
});

test('two distinct amounts use mean areas and a straight line, including endpoint extension', () => {
  const model = buildAreaCalibrationModel(lanes(
    standard(8, 10), standard(12, 10), standard(28, 20), standard(32, 20),
  ));
  assert.deepEqual(model.levels.map(level => [level.value, level.area, level.replicates]),
    [[10, 10, 2], [20, 30, 2]]);
  assert.equal(model.evaluate(20), 15);
  assert.equal(model.evaluate(30), 20);
  assert.equal(model.evaluate(40), 25);
  assert.equal(model.evaluate(0), 5);
  assert.match(generatePeakRowHTML({ type: 'A', rf: 0.5, area: 40 }, 0, 'calibration', { calModel: model }), /Extrapolated/);
});

test('three and four levels use local quadratic interpolation within a fixed bracket', () => {
  const three = buildAreaCalibrationModel(lanes(standard(1, 1), standard(2, 4), standard(3, 9)));
  assert.equal(three.evaluate(1.5), 2.25);
  assert.equal(three.evaluate(2.5), 6.25);
  const four = buildAreaCalibrationModel(lanes(
    standard(1, 1), standard(2, 4), standard(3, 9), standard(4, 16),
  ));
  assert.equal(four.evaluate(2.5), 6.25);
  assert.equal(four.evaluate(3.5), 12.25);
  assert.deepEqual(four.levels.map(level => four.evaluate(level.area)), [1, 4, 9, 16]);
  assert.equal(four.evaluate(5), 23, 'outside the range uses the last endpoint line');
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
  const zeroOnly = buildAreaCalibrationModel(lanes(standard(10, 0)));
  assert.match(zeroOnly.error, /zero-amount/);
  const blank = buildAreaCalibrationModel(lanes(standard(10, null), standard(11, ''), standard(12, 5)));
  assert.equal(blank.skippedCount, 2);
  assert.equal(blank.evaluate(24), 10);
  assert.equal(blank.evaluate(Number.NaN), null);
  assert.match(generatePeakRowHTML({ type: 'S', rf: 0.5, area: 10, calibrationValue: 0 }, 0, 'calibration'), /value="0"/);
  assert.match(generatePeakRowHTML({ type: 'S', rf: 0.5, area: 10, calibrationValue: NaN }, 0, 'calibration'), /value=""/);
});
