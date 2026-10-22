/** Local transport for the Windows package. The scientific UI is unchanged. */

const listeners = new Set();

export function stOnRender(callback) {
  listeners.add(callback);
}

export function stSend(value) {
  fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
    .then(async reply => {
      const response = await reply.json();
      listeners.forEach(callback => callback({ response }));
    })
    .catch(error => {
      const response = {
        protocol_version: 1,
        action: `${value.action}_result`,
        request_id: value.request_id,
        ok: false,
        data: null,
        error: { code: 'CONNECTION_ERROR', message: String(error), retryable: true },
      };
      listeners.forEach(callback => callback({ response }));
    });
}

// The Windows interface fills the browser viewport directly, without an iframe.
export function stReady() {}
export function stSetHeight() {}
