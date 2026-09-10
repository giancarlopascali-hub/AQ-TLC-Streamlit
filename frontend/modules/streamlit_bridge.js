/**
 * @module streamlit_bridge
 * @file modules/streamlit_bridge.js
 *
 * Lightweight, vanilla-JS implementation of the Streamlit custom component
 * messaging protocol.  No npm / React build step required.
 *
 * Protocol summary (Streamlit v1.x):
 *   JS ? Python  : window.parent.postMessage with type "streamlit:componentChanged"
 *   Python ? JS  : window receives message with type "streamlit:render"
 */

function _post(msg) {
  window.parent.postMessage({ isStreamlitMessage: true, ...msg }, '*');
}

/** Signal to Streamlit that the iframe is loaded and ready. Call once at init. */
export function stReady() {
  _post({ type: 'streamlit:componentReady', apiVersion: 1 });
}

/**
 * Send a value from JS to Python, triggering a Streamlit rerun.
 * @param {any} value - JSON-serialisable payload.
 */
export function stSend(value) {
  _post({ type: 'streamlit:componentChanged', value, dataUrls: [] });
}

/**
 * Register a callback invoked whenever Streamlit sends new args (render event).
 * @param {function(args: object): void} callback
 */
export function stOnRender(callback) {
  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'streamlit:render' && typeof callback === 'function') {
      callback(event.data.args || {});
    }
  });
}

/**
 * Inform Streamlit of the desired iframe height.
 * @param {number} [height] - px. Defaults to full document height.
 */
export function stSetHeight(height) {
  _post({ type: 'streamlit:setFrameHeight', height: height ?? document.documentElement.scrollHeight });
}
