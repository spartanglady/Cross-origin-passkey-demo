/**
 * PassWallet SDK
 * Thin client for merchant-driven checkout.
 * Provides fetch wrappers for wallet API endpoints and a micro-iframe
 * bridge for WebAuthn ceremonies (passkeys must run on the wallet origin).
 */
(function () {
  if (window.PassWallet) return;

  const WALLET_ORIGIN = window.__CONFIG__?.WALLET_ORIGIN
    || (location.hostname === 'localhost' || location.hostname.endsWith('.localhost')
        ? 'http://wallet.localhost:3001'
        : '');

  class PassWalletSDK {
    constructor() {
      this.bridgeIframe = null;
      this.bridgeReady = false;
      this._bridgeReadyPromise = null;
      this._pendingRequests = new Map(); // requestId -> { resolve, reject, timer }
      this._messageHandler = this._handleMessage.bind(this);
      this._requestCounter = 0;
    }

    // =========================================================
    // Initialization & Lifecycle
    // =========================================================

    /**
     * Mount the hidden passkey bridge iframe.
     * @param {HTMLElement} container - Element to append the bridge iframe into.
     * @returns {Promise<void>} Resolves when bridge posts BRIDGE_READY.
     */
    init(container) {
      if (this._bridgeReadyPromise) return this._bridgeReadyPromise;

      this._bridgeReadyPromise = new Promise((resolve, reject) => {
        this._bridgeReadyResolve = resolve;

        window.addEventListener('message', this._messageHandler);

        this.bridgeIframe = document.createElement('iframe');
        this.bridgeIframe.src = `${WALLET_ORIGIN}/passkey-bridge.html?v=2`;
        this.bridgeIframe.setAttribute('allow', 'publickey-credentials-get *; publickey-credentials-create *');
        this.bridgeIframe.style.cssText = `
          width: 100%; height: 0; border: none; overflow: hidden;
          transition: height 0.25s ease;
        `;
        this.bridgeIframe.id = 'pw-bridge-iframe';

        this._bridgeContainer = container;
        container.appendChild(this.bridgeIframe);

        // Timeout if bridge doesn't respond
        this._bridgeTimeout = setTimeout(() => {
          if (!this.bridgeReady) {
            reject(new Error('PassWallet bridge timeout'));
          }
        }, 10000);
      });

      return this._bridgeReadyPromise;
    }

    /**
     * Remove bridge iframe and clean up.
     */
    destroy() {
      if (this.bridgeIframe) {
        this.bridgeIframe.remove();
        this.bridgeIframe = null;
      }
      this.bridgeReady = false;
      this._bridgeReadyPromise = null;
      window.removeEventListener('message', this._messageHandler);
      clearTimeout(this._bridgeTimeout);

      // Reject any pending requests
      for (const [, pending] of this._pendingRequests) {
        clearTimeout(pending.timer);
        if (pending.retryTimers) pending.retryTimers.forEach(clearTimeout);
        pending.reject(new Error('SDK destroyed'));
      }
      this._pendingRequests.clear();
    }

    /**
     * Abort all pending bridge requests, rejecting their promises.
     */
    abortPendingRequests() {
      for (const [, pending] of this._pendingRequests) {
        clearTimeout(pending.timer);
        if (pending.retryTimers) pending.retryTimers.forEach(clearTimeout);
        pending.reject(new DOMException('Request aborted', 'AbortError'));
      }
      this._pendingRequests.clear();
      this.hidePasskeyButton();
    }

    // =========================================================
    // Bridge visibility
    // =========================================================

    showPasskeyButton(label) {
      if (this.bridgeIframe) {
        this.bridgeIframe.style.height = '52px';
        if (label) {
          this._postToBridgeRaw({ type: 'SET_BUTTON_LABEL', payload: { label } });
        }
      }
    }

    hidePasskeyButton() {
      if (this.bridgeIframe) {
        this.bridgeIframe.style.height = '0';
        this._postToBridgeRaw({ type: 'HIDE_BRIDGE' });
      }
    }

    /**
     * Move the bridge iframe into a different container.
     * If the container is different from the current one, the iframe reloads.
     * This method waits for the bridge to re-signal BRIDGE_READY after a move.
     */
    async reparent(container) {
      if (!this.bridgeIframe || !container) return;
      if (this._bridgeContainer === container) return; // Same container, no-op

      // Moving to a different parent reloads the iframe
      this.bridgeReady = false;
      const readyPromise = new Promise((resolve) => {
        this._bridgeReadyResolve = resolve;
        this._reparentTimeout = setTimeout(() => {
          if (!this.bridgeReady) {
            console.warn('[PassWallet] Bridge reparent timeout');
            this.bridgeReady = true;
            resolve();
          }
        }, 3000);
      });

      container.appendChild(this.bridgeIframe);
      this._bridgeContainer = container;

      await readyPromise;
      clearTimeout(this._reparentTimeout);
    }

    // =========================================================
    // API Methods (direct fetch to wallet server)
    // =========================================================

    /** Check if a phone number is registered. */
    lookup(phone) {
      return this._walletFetch('/api/lookup', { phoneNumber: phone });
    }

    /** Send OTP to phone. */
    sendOTP(phone) {
      return this._walletFetch('/api/auth/otp/send', { phoneNumber: phone });
    }

    /** Verify OTP code. */
    verifyOTP(phone, otp) {
      return this._walletFetch('/api/auth/otp/verify', { phoneNumber: phone, otp });
    }

    /** Process payment. */
    pay(phone, cardId, amount) {
      return this._walletFetch('/api/pay', { phoneNumber: phone, cardId, amount });
    }

    // =========================================================
    // Passkey Methods (bridge-mediated)
    // =========================================================

    /**
     * Full passkey authentication flow:
     *   1. Fetch assertion options from server
     *   2. Post to bridge → user clicks button → browser credentials.get()
     *   3. Verify assertion on server
     * @returns {Promise<{verified, user}>}
     */
    async authenticatePasskey(phone) {
      // 1. Get options from server
      const optData = await this._walletFetch('/api/login/options', { phoneNumber: phone });

      // 2. Send to bridge, wait for user to click and complete ceremony
      const asseResp = await this._postToBridge('PASSKEY_AUTH_REQUEST', {
        options: optData.options,
      });

      // 3. Verify on server
      return this._walletFetch('/api/login/verify', {
        phoneNumber: phone,
        sessionId: optData.sessionId,
        response: asseResp,
      });
    }

    /**
     * Full passkey registration flow:
     *   1. Fetch attestation options from server
     *   2. Post to bridge → user clicks button → browser credentials.create()
     *   3. Verify attestation on server
     * @returns {Promise<{verified, user}>}
     */
    async registerPasskey(phone, displayName) {
      // 1. Get options from server
      const options = await this._walletFetch('/api/register/options', {
        phoneNumber: phone,
        displayName,
      });

      // 2. Send to bridge
      const attResp = await this._postToBridge('PASSKEY_REGISTER_REQUEST', {
        options,
      });

      // 3. Verify on server
      return this._walletFetch('/api/register/verify', {
        phoneNumber: phone,
        response: attResp,
      });
    }

    // =========================================================
    // Device Binding (WebCrypto)
    // =========================================================

    getDeviceId() {
      return localStorage.getItem('pw_device_id');
    }

    async challengeDevice(deviceId) {
      return this._walletFetch('/api/device/challenge', { deviceId });
    }

    async verifyDevice(deviceId, signature) {
      return this._walletFetch('/api/device/verify', { deviceId, signature });
    }

    async registerDevice(deviceId, phoneNumber, publicKey) {
      return this._walletFetch('/api/device/register', { deviceId, phoneNumber, publicKey });
    }

    // =========================================================
    // Internal: Fetch wrapper
    // =========================================================

    async _walletFetch(path, body) {
      const res = await fetch(`${WALLET_ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        const err = new Error(data.error || `Request failed: ${res.status}`);
        err.status = res.status;
        throw err;
      }

      return data;
    }

    // =========================================================
    // Internal: Bridge postMessage RPC
    // =========================================================

    _postToBridgeRaw(msg) {
      if (this.bridgeIframe && this.bridgeIframe.contentWindow) {
        this.bridgeIframe.contentWindow.postMessage(msg, WALLET_ORIGIN);
      } else {
        console.warn(`[PassWallet] Message dropped (no bridge): ${msg.type}`);
      }
    }

    /**
     * Send a request to the bridge and return a promise that resolves
     * when the bridge responds with a matching requestId.
     * Includes automatic retry to handle potential message delivery issues.
     */
    _postToBridge(type, payload, timeoutMs = 120000) {
      return new Promise((resolve, reject) => {
        const requestId = `req_${++this._requestCounter}_${Date.now()}`;

        const timer = setTimeout(() => {
          this._pendingRequests.delete(requestId);
          reject(new Error('Bridge request timeout'));
        }, timeoutMs);

        this._pendingRequests.set(requestId, { resolve, reject, timer });

        const msg = { type, requestId, payload };
        this._postToBridgeRaw(msg);

        // Retry to handle potential message loss (e.g., iframe not yet ready
        // after visibility change). The bridge handler is idempotent so
        // duplicate deliveries are harmless.
        const retry1 = setTimeout(() => {
          if (this._pendingRequests.has(requestId)) this._postToBridgeRaw(msg);
        }, 150);
        const retry2 = setTimeout(() => {
          if (this._pendingRequests.has(requestId)) this._postToBridgeRaw(msg);
        }, 500);

        const entry = this._pendingRequests.get(requestId);
        entry.retryTimers = [retry1, retry2];
      });
    }

    _handleMessage(event) {
      if (event.origin !== WALLET_ORIGIN) return;
      const { type, requestId, payload, error } = event.data || {};

      switch (type) {
        case 'BRIDGE_READY':
          this.bridgeReady = true;
          clearTimeout(this._bridgeTimeout);
          if (this._bridgeReadyResolve) {
            this._bridgeReadyResolve();
            this._bridgeReadyResolve = null;
          }
          break;

        case 'PASSKEY_AUTH_RESPONSE':
        case 'PASSKEY_REGISTER_RESPONSE': {
          const pending = this._pendingRequests.get(requestId);
          if (!pending) return;

          this._pendingRequests.delete(requestId);
          clearTimeout(pending.timer);
          if (pending.retryTimers) pending.retryTimers.forEach(clearTimeout);

          if (error) {
            const err = new Error(error.message);
            err.name = error.name;
            pending.reject(err);
          } else {
            pending.resolve(payload);
          }
          break;
        }
      }
    }
  }

  // Expose globally
  window.PassWallet = new PassWalletSDK();
})();
