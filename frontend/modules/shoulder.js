/** Shared presentation helpers for optional shoulder fitting. */

export const DEFAULT_SHOULDER_SENSITIVITY = 0;

export function normalizeShoulderSensitivity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

export function shoulderSensitivityLabel(value) {
  const sensitivity = normalizeShoulderSensitivity(value);
  return sensitivity === 0 ? 'Off' : String(sensitivity);
}

export function analysisReady(appState) {
  return !appState.isProfilePending && !appState.isProfileStale;
}

export function syncShoulderControl(appState) {
  const slider = document.getElementById('shoulder-sensitivity');
  const label = document.getElementById('shoulder-sensitivity-val');
  if (slider) slider.value = normalizeShoulderSensitivity(appState.shoulderSensitivity);
  if (label) label.textContent = shoulderSensitivityLabel(appState.shoulderSensitivity);
}

export function isFittedPeak(peak) {
  return peak?.area_method === 'deconvolved' && typeof peak.fit_group_id === 'string';
}

export function fitGroups(lane) {
  return Array.isArray(lane?.fit_groups) ? lane.fit_groups : [];
}

/** The measured support can comprise disjoint Width%-controlled windows. */
export function fitIntegrationSegments(group) {
  if (Array.isArray(group?.integration_segments) && group.integration_segments.length) {
    return group.integration_segments.filter(segment => Number.isInteger(segment.lb)
      && Number.isInteger(segment.rb) && segment.rb >= segment.lb);
  }
  const bounds = group?.integration_bounds || group?.bounds;
  return Number.isInteger(bounds?.lb) && Number.isInteger(bounds?.rb) && bounds.rb >= bounds.lb
    ? [bounds] : [];
}

/** Curves are window-local and share the origin-to-front analysis-profile scale. */
export function fitCurveSeries(group, profileLength) {
  const lb = group?.bounds?.lb;
  const rb = group?.bounds?.rb;
  if (!Number.isInteger(lb) || !Number.isInteger(rb) || lb < 0 || rb < lb || rb >= profileLength) return null;
  const count = rb - lb + 1;
  const validCurve = curve => Array.isArray(curve) && curve.length === count
    && curve.every(value => Number.isFinite(value));
  if (!validCurve(group.double_curve) || !validCurve(group.baseline_curve)) return null;
  const components = (Array.isArray(group.components) ? group.components : [])
    .filter(component => validCurve(component.curve))
    .map(component => ({
      index: component.peak_index,
      curve: component.curve.map((value, index) => group.baseline_curve[index] + value),
    }));
  return { lb, rb, total: group.double_curve, components };
}

export function isInsideActiveFit(lane, index) {
  return fitGroups(lane).some(group => group.active === true
    && Number.isInteger(group.bounds?.lb) && Number.isInteger(group.bounds?.rb)
    && index >= group.bounds.lb && index <= group.bounds.rb);
}

export function overlapsActiveFit(lane, left, right) {
  return fitGroups(lane).some(group => {
    if (group.active !== true) return false;
    return fitIntegrationSegments(group).some(segment => left <= segment.rb && right >= segment.lb);
  });
}

/** Mark the ordinary peak retained for a reviewable candidate. */
export function tagKeptFitPeaks(lane) {
  for (const group of fitGroups(lane)) {
    if (group.status !== 'resolved' || group.active === true) continue;
    const peak = (lane.peaks || []).find(item => !isFittedPeak(item)
      && item.idx === group.original_peak?.idx);
    if (peak) peak.fit_candidate_group_id = group.id;
  }
}

/** An ordinary peak's manual geometry no longer describes its old candidate. */
export function invalidateKeptFitGroup(lane, peak, overrides) {
  const id = peak?.fit_candidate_group_id;
  if (!id) return false;
  lane.fit_groups = fitGroups(lane).filter(group => group.id !== id);
  delete overrides[id];
  delete peak.fit_candidate_group_id;
  return true;
}

/** Swap just one cluster; unrelated peaks and user annotations stay intact. */
export function applyFitDecision(lane, groupId, decision) {
  const group = fitGroups(lane).find(item => item.id === groupId);
  if (!group || group.status !== 'resolved' || !['split', 'keep'].includes(decision)
      || group.decision === decision) return false;
  const peaks = Array.isArray(lane.peaks) ? lane.peaks : [];
  if (decision === 'split') {
    if (!Array.isArray(group.split_peaks) || group.split_peaks.length !== 2) return false;
    const original = peaks.find(item => item.fit_candidate_group_id === groupId)
      || peaks.find(item => !isFittedPeak(item) && item.idx === group.original_peak?.idx);
    if (!original) return false;
    const savedOriginal = { ...original };
    delete savedOriginal.fit_candidate_group_id;
    group.original_peak = savedOriginal;
    lane.peaks = peaks.filter(item => item !== original)
      .concat(group.split_peaks.map(item => ({ ...item }))).sort((a, b) => a.idx - b.idx);
  } else {
    const active = peaks.filter(item => isFittedPeak(item) && item.fit_group_id === groupId);
    if (active.length !== 2 || !group.original_peak) return false;
    group.split_peaks = active.map(item => ({ ...item }));
    lane.peaks = peaks.filter(item => !active.includes(item))
      .concat({ ...group.original_peak, fit_candidate_group_id: groupId })
      .sort((a, b) => a.idx - b.idx);
  }
  group.decision = decision;
  group.active = decision === 'split';
  (group.components || []).forEach((component, index) => {
    const peakIndex = decision === 'split'
      ? lane.peaks.findIndex(peak => peak.fit_group_id === groupId
        && peak.fit_component_index === index)
      : -1;
    component.peak_index = peakIndex >= 0 ? peakIndex : null;
  });
  return true;
}
