/**
 * @module streamlit_bridge
 * @file modules/streamlit_bridge.js
 *
 * Streamlit custom component messaging bridge (vanilla JS, no npm/React).
 *
 * Works in tandem with the inline bootstrap script in index.html:
 *   - The inline script sends "streamlit:componentReady" IMMEDIATELY on page load
 *     and buffers any incoming "streamlit:render" events in window.__stRenderQueue.
 *   - stOnRender() registers callbacks and drains that buffer on first call.
 *   - stReady() is a no-op here (signal already sent inline) but kept for clarity.
 *   - stSend() / stSetHeight() post messages to the Streamlit parent frame.
 */

function _post(msg) {
  window.parent.postMessage(Object.assign({ isStreamlitMessage: true }, msg), '*');
}

/**
 * No-op: the componentReady signal is sent immediately by the inline bootstrap
 * script in index.html, long before ES modules finish loading.
 * This function is retained so call-sites in init.js remain readable.
 */
export function stReady() {
  // Already sent inline - nothing to do.
}

/**
 * Send a value from JS to Python, triggering a Streamlit script rerun.
 * @param {any} value - JSON-serialisable payload.
 */
export function stSend(value) {
  _post({ type: 'streamlit:componentChanged', value, dataUrls: [] });
}

/**
 * Register a callback invoked whenever Streamlit sends new args.
 *
 * Uses the global buffer (window.__stRenderCallbacks / window.__stRenderQueue)
 * set up by the inline bootstrap script.  Multiple callers are supported; each
 * registered callback fires independently on every render event.
 *
 * @param {function(args: object): void} callback
 */
export function stOnRender(callback) {
  if (!window.__stCallbacks)    window.__stCallbacks    = [];
  if (!window.__stRenderQueue)  window.__stRenderQueue  = [];

  window.__stCallbacks.push(callback);

  // Drain any events that arrived before this callback was registered
  var queued = window.__stRenderQueue.splice(0);
  queued.forEach(function (args) { callback(args); });
}

/**
 * Inform Streamlit of the desired iframe height.
 * @param {number} [height] - px. Defaults to full document scroll height.
 */
export function stSetHeight(height) {
  _post({ type: 'streamlit:setFrameHeight', height: height != null ? height : document.documentElement.scrollHeight });
}