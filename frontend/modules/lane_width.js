/** Shared lane width and the largest width that keeps sampling strips separate. */

export const MIN_LANE_WIDTH = 2;
const WIDTH_STEPS_PER_PIXEL = 10;

function frame(lane) {
  const angle = Number(lane.angle || 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    cx: Number(lane.cx),
    cy: Number(lane.cy),
    halfHeight: Number(lane.h) / 2,
    across: { x: cosine, y: sine },
    along: { x: -sine, y: cosine },
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y;
}

function rectanglesOverlap(first, second, width) {
  const delta = { x: second.cx - first.cx, y: second.cy - first.cy };
  const axes = [first.across, first.along, second.across, second.along];
  for (const axis of axes) {
    const firstRadius = width / 2 * Math.abs(dot(first.across, axis))
      + first.halfHeight * Math.abs(dot(first.along, axis));
    const secondRadius = width / 2 * Math.abs(dot(second.across, axis))
      + second.halfHeight * Math.abs(dot(second.along, axis));
    // Touching edges are allowed; only a positive intersection is overlap.
    if (Math.abs(dot(delta, axis)) >= firstRadius + secondRadius - 1e-9) return false;
  }
  return true;
}

/** Return the maximum width before lane overlap or source-image edge clipping. */
export function maxCommonLaneWidth(lanes, imageWidth, imageHeight = imageWidth) {
  if (!Array.isArray(lanes) || !lanes.length || !Number.isFinite(imageWidth) || imageWidth <= 0
    || !Number.isFinite(imageHeight) || imageHeight <= 0) return 0;
  if (lanes.some(lane => ![lane.cx, lane.cy, lane.h, lane.angle || 0].every(Number.isFinite) || lane.h <= 0)) return 0;

  const visible = lanes.map(lane => frame(lane));
  const overlaps = width => {
    for (let index = 0; index < lanes.length; index += 1) {
      for (let other = index + 1; other < lanes.length; other += 1) {
        if (rectanglesOverlap(visible[index], visible[other], width)) return true;
      }
    }
    return false;
  };

  const edgeLimit = Math.min(...visible.map(lane => {
    const xMargin = Math.min(lane.cx, imageWidth - lane.cx);
    const yMargin = Math.min(lane.cy, imageHeight - lane.cy);
    const xLimit = Math.abs(lane.across.x) > 1e-9 ? 2 * xMargin / Math.abs(lane.across.x) : Infinity;
    const yLimit = Math.abs(lane.across.y) > 1e-9 ? 2 * yMargin / Math.abs(lane.across.y) : Infinity;
    return Math.min(Math.hypot(imageWidth, imageHeight), xLimit, yLimit);
  }));
  let safe = 0;
  let unsafe = Math.max(0, Math.floor(edgeLimit * WIDTH_STEPS_PER_PIXEL));
  while (safe < unsafe) {
    const candidate = Math.ceil((safe + unsafe) / 2);
    if (overlaps(candidate / WIDTH_STEPS_PER_PIXEL)) unsafe = candidate - 1;
    else safe = candidate;
  }
  return safe / WIDTH_STEPS_PER_PIXEL;
}

/** Apply one width to every lane, respecting the current overlap limit. */
export function applyCommonLaneWidth(state, requestedWidth) {
  const maximum = maxCommonLaneWidth(state.lanes, state.imgW, state.imgH ?? state.imgW);
  if (maximum < MIN_LANE_WIDTH) return false;
  const requested = Number(requestedWidth);
  const fallback = Number(state.laneWidth ?? state.lanes[0].w);
  const value = Number.isFinite(requested) ? requested : fallback;
  const width = Math.min(maximum, Math.max(MIN_LANE_WIDTH,
    Math.round(value * WIDTH_STEPS_PER_PIXEL) / WIDTH_STEPS_PER_PIXEL));
  state.laneWidth = width;
  state.lanes.forEach(lane => { lane.w = width; });
  return true;
}

export function syncLaneWidthControl(state, doc = document) {
  const slider = doc.getElementById('lane-width');
  if (!slider) return;
  const value = doc.getElementById('lane-width-val');
  const limit = doc.getElementById('lane-width-max');
  const maximum = maxCommonLaneWidth(state.lanes, state.imgW, state.imgH ?? state.imgW);
  const usable = maximum >= MIN_LANE_WIDTH;
  slider.disabled = !usable;
  slider.min = String(MIN_LANE_WIDTH);
  slider.max = String(usable ? maximum : MIN_LANE_WIDTH);
  slider.value = String(usable ? Math.min(maximum, state.laneWidth ?? state.lanes[0].w) : MIN_LANE_WIDTH);
  if (value) value.textContent = usable ? `${Number(slider.value)} px` : '—';
  if (limit) limit.textContent = usable ? `${maximum} px` : '—';
}
