/**
 * PassWallet Passkey Bridge
 * Runs inside the wallet-origin iframe. Handles WebAuthn ceremonies
 * that require navigator.credentials on the wallet RP_ID origin.
 * The user must click the bridge button to provide transient activation.
 */
(function () {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser;

  const btn = document.getElementById('bridge-btn');
  const label = document.getElementById('bridge-label');

  let pendingOperation = null; // { type, requestId, options }

  function serializeError(error) {
    if (!error) return null;
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : undefined,
      };
    }
    if (typeof error === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(error).slice(0, 10)) {
        out[key] = value;
      }
      return out;
    }
    return { message: String(error) };
  }

  function sendClientLog(level, event, details = {}) {
    const payload = {
      level,
      source: 'passkey-bridge',
      event,
      details,
      page: {
        origin: window.location.origin,
        href: window.location.href,
        userAgent: navigator.userAgent,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const sent = navigator.sendBeacon(
          '/api/client-log',
          new Blob([body], { type: 'application/json' }),
        );
        if (sent) return;
      }

      fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch((error) => console.warn('[PassWallet Bridge] Failed to send log', error));
    } catch (error) {
      console.warn('[PassWallet Bridge] Failed to queue log', error);
    }
  }

  window.addEventListener('error', (event) => {
    sendClientLog('error', 'window_error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: serializeError(event.error),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendClientLog('error', 'unhandled_rejection', {
      reason: serializeError(event.reason),
    });
  });

  // --- PostMessage helpers ---
  function postToParent(msg) {
    window.parent.postMessage(msg, '*');
  }

  // --- Notify parent that the bridge is ready ---
  postToParent({ type: 'BRIDGE_READY' });

  // --- Listen for requests from SDK ---
  window.addEventListener('message', (event) => {
    const { type, requestId, payload } = event.data || {};

    switch (type) {
      case 'PASSKEY_AUTH_REQUEST':
        pendingOperation = { type: 'auth', requestId, options: payload.options };
        sendClientLog('info', 'passkey_request_received', {
          type: 'auth',
          requestId,
          rpId: payload && payload.options ? payload.options.rpId : null,
          allowCredentialCount: Array.isArray(payload?.options?.allowCredentials)
            ? payload.options.allowCredentials.length
            : 0,
        });
        label.textContent = 'Verify with PassWallet';
        btn.style.display = 'flex';
        btn.disabled = false;
        break;

      case 'PASSKEY_REGISTER_REQUEST':
        pendingOperation = { type: 'register', requestId, options: payload.options };
        sendClientLog('info', 'passkey_request_received', {
          type: 'register',
          requestId,
          rpId: payload && payload.options ? (payload.options.rp?.id || payload.options.rpId || null) : null,
        });
        label.textContent = 'Save Passkey';
        btn.style.display = 'flex';
        btn.disabled = false;
        break;

      case 'SET_BUTTON_LABEL':
        if (payload && payload.label) {
          label.textContent = payload.label;
        }
        break;

      case 'HIDE_BRIDGE':
        btn.style.display = 'none';
        btn.disabled = true;
        pendingOperation = null;
        break;
    }
  });

  // --- Button click: execute the WebAuthn ceremony ---
  btn.addEventListener('click', async () => {
    if (!pendingOperation) return;

    const { type, requestId, options } = pendingOperation;
    btn.disabled = true;
    label.textContent = 'Follow browser prompts...';

    try {
      let result;
      if (type === 'auth') {
        result = await startAuthentication(options);
        sendClientLog('info', 'passkey_operation_succeeded', {
          type,
          requestId,
          credentialId: result && result.id ? result.id : null,
        });
        postToParent({
          type: 'PASSKEY_AUTH_RESPONSE',
          requestId,
          payload: result,
        });
      } else if (type === 'register') {
        result = await startRegistration(options);
        sendClientLog('info', 'passkey_operation_succeeded', {
          type,
          requestId,
          credentialId: result && result.id ? result.id : null,
        });
        postToParent({
          type: 'PASSKEY_REGISTER_RESPONSE',
          requestId,
          payload: result,
        });
      }
    } catch (err) {
      sendClientLog('error', 'passkey_operation_failed', {
        type,
        requestId,
        rpId: options ? (options.rp?.id || options.rpId || null) : null,
        error: serializeError(err),
      });
      const responseType = type === 'auth' ? 'PASSKEY_AUTH_RESPONSE' : 'PASSKEY_REGISTER_RESPONSE';
      postToParent({
        type: responseType,
        requestId,
        error: { name: err.name, message: err.message },
      });
    } finally {
      // Reset state
      btn.style.display = 'none';
      btn.disabled = true;
      label.textContent = 'Verify with PassWallet';
      pendingOperation = null;
    }
  });
})();
