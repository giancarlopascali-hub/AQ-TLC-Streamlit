/**
 * @module api
 * @file modules/api.js
 *
 * Network communication layer — sends lane geometry and image data to the
 * Python backend via the Streamlit component bridge, and receives density
 * profiles + peak detections in response.
 *
 * In the Streamlit deployment, all server calls use the bidirectional
 * postMessage protocol implemented in streamlit_bridge.js rather than
 * direct fetch() calls.  The response arrives asynchronously via the
 * streamlit:render event.
 *
 * Only one active endpoint is used by this module:
 *   action: 'generate_profiles'   (replaces POST /generate_profiles)
 *
 * The crop action is handled separately in workspace.js:
 *   action: 'crop'                (replaces POST /detect/crop)
 */

import { state, $     } from './state.js';
import { SMOOTH_SIGMA } from './constants.js';
import { calculatePeakArea } from './analysis.js';
import { stSend, stOnRender } from './streamlit_bridge.js';

// -- Circular-dependency bridge -------------------------------------------------
let _renderProfiles = null;
let _render         = null;

/** @type {number} Monotonically increasing ID for each outgoing request. */
let _reqCounter = 0;

/** Latest request per action. Crop and profile work must not invalidate each other. */
const _latestRequestIdByAction = new Map();
let _profileRequestTimer = null;

/**
 * Registers the render callback functions.
 * Must be called once during app initialisation (see init.js).
 *
 * @param {Function} renderProfilesFn
 * @param {Function} renderFn
 */
export function registerApiCallbacks(renderProfilesFn, renderFn) {
  _renderProfiles = renderProfilesFn;
  _render         = renderFn;

  // Set up the single shared render listener.  Both generate_profiles and crop
  // responses arrive here; routing is done by response.action.
  stOnRender(args => {
    const resp = args.response;
    if (!resp) return;

    if (resp.action === 'generate_profiles_result') {
      if (resp.protocol_version !== 1) return;
      if (resp.request_id !== _latestRequestIdByAction.get('generate_profiles')) return;
      if (!resp.ok) {
        console.warn('[AQ-TLC Backend Error]', resp.error?.code, resp.error?.message);
        return;
      }
      _handleProfilesResponse(resp.data);
    }
    // crop response is handled in workspace.js via its own stOnRender listener
  });
}

// -- Internal response handler -------------------------------------------------

function _handleProfilesResponse(data) {
  if (!data || !data.results) {
    if (data && data.error) {
      console.error('[AQ-TLC Backend Error]:', data.error);
      alert('Densitogram calculation error: ' + data.error);
    }
    return;
  }

  data.results.forEach(result => {
    const lane = state.lanes.find(ln => ln.id === result.id);
    if (!lane) return;

    // `profile` remains for legacy callers; numerical editing uses the explicit
    // origin->front normalised profile_analysis field.
    lane.profile = result.profile || [];
    lane.profile_display = result.profile_display || [];
    lane.profile_analysis = result.profile_analysis || [];

    // Only replace peaks when explicitly requested or when lane has none yet.
    if (!lane.peaks || lane.peaks.length === 0 || data._detectPeaks) {
      lane.peaks = result.peaks || [];
    } else {
      // Parameter changes can refresh the analysis signal without re-running
      // detection. Preserve user edits but keep every reported area on the
      // same signal scale as the refreshed backend profile.
      lane.peaks.forEach(peak => {
        const left = Number.isInteger(peak.area_lb) ? peak.area_lb : peak.lb;
        const right = Number.isInteger(peak.area_rb) ? peak.area_rb : peak.rb;
        peak.area = calculatePeakArea(lane.profile_analysis, left, right);
      });
    }
  });

  if (_renderProfiles) _renderProfiles();
  if (_render)         _render();
}

// ----------------------------------------------------------------------------
//  PROFILE GENERATION
// ----------------------------------------------------------------------------

/**
 * Requests density profiles (and optionally peak detection) from the backend.
 *
 * Sends the image (base64) and all lane geometry to Python via the Streamlit
 * bridge.  The response arrives asynchronously via the stOnRender listener
 * registered in registerApiCallbacks().
 *
 * Peak preservation rule:
 *   If detectPeaks is false, existing peaks on a lane are NOT overwritten —
 *   only the raw density profile is refreshed.
 *
 * @param {boolean} [detectPeaks=false]
 * @returns {void}
 */
export function updateDensitograms(detectPeaks = false) {
  if (state.lanes.length === 0 || !state.imgB64) return;

  // Range sliders can emit dozens of events.  Collapse a burst to the latest
  // request before it enters the Streamlit rerun cycle.
  if (_profileRequestTimer) clearTimeout(_profileRequestTimer);
  _profileRequestTimer = setTimeout(() => _sendProfileRequest(detectPeaks), 120);
}

function _sendProfileRequest(detectPeaks) {
  if (state.lanes.length === 0 || !state.imgB64) return;

  const prominence = parseFloat($('peak-prominence')?.value || 10);
  const distance   = parseInt($('peak-distance')?.value     || 8);
  const threshold  = parseFloat($('peak-threshold')?.value  || 50);

  const reqId = `generate_profiles-${++_reqCounter}`;
  _latestRequestIdByAction.set('generate_profiles', reqId);

  stSend({
    protocol_version: 1,
    action:     'generate_profiles',
    request_id: reqId,
    payload: {
      image:                state.imgB64,
      lanes:                state.lanes,
      peak_detection:       detectPeaks,
      peak_prominence:      prominence,
      peak_distance:        distance,
      peak_threshold:       threshold,
      smooth_sigma:         SMOOTH_SIGMA,
      polarity_mode:        state.polarityMode,
      target_wavelength:    state.targetWavelength,
      wavelength_bandwidth: state.wavelengthBandwidth,
      invert_colors:        state.invertColors,
    },
  });
}
