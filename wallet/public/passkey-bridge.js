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
        label.textContent = 'Verify with PassWallet';
        btn.style.display = 'flex';
        btn.disabled = false;
        break;

      case 'PASSKEY_REGISTER_REQUEST':
        pendingOperation = { type: 'register', requestId, options: payload.options };
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
        postToParent({
          type: 'PASSKEY_AUTH_RESPONSE',
          requestId,
          payload: result,
        });
      } else if (type === 'register') {
        result = await startRegistration(options);
        postToParent({
          type: 'PASSKEY_REGISTER_RESPONSE',
          requestId,
          payload: result,
        });
      }
    } catch (err) {
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
