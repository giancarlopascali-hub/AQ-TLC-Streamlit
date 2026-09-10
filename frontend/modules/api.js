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
import { stSend, stOnRender } from './streamlit_bridge.js';

// -- Circular-dependency bridge -------------------------------------------------
let _renderProfiles = null;
let _render         = null;

/** @type {number} Monotonically increasing ID for each outgoing request. */
let _reqCounter = 0;

/** @type {number} ID of the most recently sent request (to ignore stale responses). */
let _lastReqId = 0;

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
      _handleProfilesResponse(resp.data);
    }
    // crop response is handled in workspace.js via its own stOnRender listener
  });
}

// -- Internal response handler -------------------------------------------------

function _handleProfilesResponse(data) {
  if (!data || !data.results) return;

  data.results.forEach(result => {
    const lane = state.lanes.find(ln => ln.id === result.id);
    if (!lane) return;

    lane.profile = result.profile;

    // Only replace peaks when explicitly requested or when lane has none yet.
    if (!lane.peaks || lane.peaks.length === 0 || data._detectPeaks) {
      lane.peaks = result.peaks || [];
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

  const prominence = parseFloat($('peak-prominence')?.value || 10);
  const distance   = parseInt($('peak-distance')?.value     || 8);
  const threshold  = parseFloat($('peak-threshold')?.value  || 50);

  const reqId = ++_reqCounter;
  _lastReqId  = reqId;

  stSend({
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
