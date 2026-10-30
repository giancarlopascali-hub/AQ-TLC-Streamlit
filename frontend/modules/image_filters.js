/** Approximate visible-light labels as weights over a camera image's RGB channels. */
export function wavelengthToRgb(wavelength) {
  const value = Number(wavelength);
  let r = 0; let g = 0; let b = 0;
  if (value >= 380 && value < 440) {
    r = -(value - 440) / 60; b = 1;
  } else if (value >= 440 && value < 490) {
    g = (value - 440) / 50; b = 1;
  } else if (value >= 490 && value < 510) {
    g = 1; b = -(value - 510) / 20;
  } else if (value >= 510 && value < 580) {
    r = (value - 510) / 70; g = 1;
  } else if (value >= 580 && value < 645) {
    r = 1; g = -(value - 645) / 65;
  } else if (value >= 645 && value <= 750) {
    r = 1;
  }
  let factor = 1;
  if (value >= 380 && value < 420) factor = 0.3 + 0.7 * (value - 380) / 40;
  else if (value > 700 && value <= 750) factor = 0.3 + 0.7 * (750 - value) / 50;
  return { r: r * factor, g: g * factor, b: b * factor };
}

/** Round valid positive settings to an integer nm, matching the Python backend. */
export function roundFilterSetting(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`RGB projection setting must be between ${minimum} and ${maximum}.`);
  }
  return Math.floor(number + 0.5);
}

/** Mean raw RGB vector within target ± halfWidth, clipped to 380–750 nm. */
export function wavelengthWindowToRgb(target, halfWidth = 0) {
  const centre = roundFilterSetting(target, 380, 750);
  const radius = roundFilterSetting(halfWidth, 0, 50);
  const start = Math.max(380, centre - radius);
  const end = Math.min(750, centre + radius);
  let r = 0; let g = 0; let b = 0;
  for (let nm = start; nm <= end; nm += 1) {
    const sample = wavelengthToRgb(nm);
    r += sample.r; g += sample.g; b += sample.b;
  }
  const count = end - start + 1;
  return { r: r / count, g: g / count, b: b / count };
}
