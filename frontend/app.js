/**
 * @file app.js
 * @description Main ES Module entry point for AQ-TLC (Streamlit edition).
 */

import { init } from './modules/init.js';

try {
  init();
} catch (err) {
  // Surface any initialisation error directly in the component iframe
  // so it is visible during debugging rather than silently swallowed.
  console.error('[AQ-TLC] Fatal initialisation error:', err);
  document.body.innerHTML = [
    '<div style="color:#ff6b6b;background:#1a1a2e;padding:24px;font-family:monospace;height:100vh;box-sizing:border-box;">',
    '<h2 style="margin:0 0 12px">AQ-TLC failed to initialise</h2>',
    '<pre style="white-space:pre-wrap;font-size:0.85em;">' + (err && err.stack ? err.stack : String(err)) + '</pre>',
    '</div>',
  ].join('');
}