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
  const USER_HINTS_STORAGE_KEY = 'pw_user_hints_v1';
  const CREDENTIAL_HINTS_STORAGE_KEY = 'pw_credential_hints_v1';
  const BOUND_PHONE_STORAGE_KEY = 'pw_bound_phone';

  class PassWalletSDK {
    constructor() {
      this.bridgeIframe = null;
      this.bridgeReady = false;
      this._bridgeReadyPromise = null;
      this._pendingRequests = new Map(); // requestId -> { resolve, reject, timer }
      this._messageHandler = this._handleMessage.bind(this);
      this._requestCounter = 0;
      this._errorHandlersInstalled = false;
      this._installGlobalErrorHandlers();
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
      const loginData = await this._walletFetch('/api/login/options', { phoneNumber: phone });
      const optData = loginData && loginData.options ? loginData : {
        options: loginData,
        sessionId: undefined,
        verificationToken: undefined,
      };

      // 2. Send to bridge, wait for user to click and complete ceremony
      const asseResp = await this._postToBridge('PASSKEY_AUTH_REQUEST', {
        options: optData.options,
      });

      // 3. Verify on server
      return this._walletFetch('/api/login/verify', {
        phoneNumber: phone,
        sessionId: optData.sessionId,
        verificationToken: optData.verificationToken,
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
      const registrationData = await this._walletFetch('/api/register/options', {
        phoneNumber: phone,
        displayName,
      });
      const regData = registrationData && registrationData.options ? registrationData : {
        options: registrationData,
        verificationToken: undefined,
      };

      // 2. Send to bridge
      const attResp = await this._postToBridge('PASSKEY_REGISTER_REQUEST', {
        options: regData.options,
      });

      // 3. Verify on server
      return this._walletFetch('/api/register/verify', {
        phoneNumber: phone,
        verificationToken: regData.verificationToken,
        response: attResp,
      });
    }

    // =========================================================
    // Device Binding (WebCrypto)
    // =========================================================

    getDeviceId() {
      return localStorage.getItem('pw_device_id');
    }

    getBoundPhoneNumber() {
      return localStorage.getItem(BOUND_PHONE_STORAGE_KEY);
    }

    clearDeviceState() {
      localStorage.removeItem('pw_device_id');
      localStorage.removeItem('pw_mock_key');
      localStorage.removeItem(BOUND_PHONE_STORAGE_KEY);
      this._pendingDeviceVerificationToken = null;
    }

    async challengeDevice(deviceId) {
      const data = await this._walletFetch('/api/device/challenge', { deviceId });
      this._pendingDeviceVerificationToken = data && data.verificationToken ? data.verificationToken : null;
      return data;
    }

    async verifyDevice(deviceId, signature) {
      try {
        return await this._walletFetch('/api/device/verify', { deviceId, signature });
      } finally {
        this._pendingDeviceVerificationToken = null;
      }
    }

    async registerDevice(deviceId, phoneNumber, publicKey) {
      return this._walletFetch('/api/device/register', { deviceId, phoneNumber, publicKey });
    }

    _readStorageJSON(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    _writeStorageJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {
        // Ignore storage failures in demo mode
      }
    }

    _getUserHint(phoneNumber) {
      if (!phoneNumber) return null;
      const cache = this._readStorageJSON(USER_HINTS_STORAGE_KEY);
      const hint = cache[phoneNumber];
      return hint && hint.phoneNumber === phoneNumber ? hint : null;
    }

    _cacheUserHint(phoneNumber, user) {
      const normalizedPhone = phoneNumber || user?.phoneNumber;
      if (!normalizedPhone || !user) return;

      const cache = this._readStorageJSON(USER_HINTS_STORAGE_KEY);
      cache[normalizedPhone] = {
        phoneNumber: normalizedPhone,
        displayName: user.displayName || null,
        cards: Array.isArray(user.cards) ? user.cards : [],
      };
      this._writeStorageJSON(USER_HINTS_STORAGE_KEY, cache);
    }

    _getCredentialHints(phoneNumber) {
      if (!phoneNumber) return [];
      const cache = this._readStorageJSON(CREDENTIAL_HINTS_STORAGE_KEY);
      const hints = cache[phoneNumber];
      return Array.isArray(hints) ? hints : [];
    }

    _cacheCredentialHint(phoneNumber, credentialRecord) {
      const normalizedPhone = phoneNumber || credentialRecord?.phoneNumber;
      if (!normalizedPhone || !credentialRecord || !credentialRecord.id || !credentialRecord.publicKey) return;

      const cache = this._readStorageJSON(CREDENTIAL_HINTS_STORAGE_KEY);
      const existing = Array.isArray(cache[normalizedPhone]) ? cache[normalizedPhone] : [];
      const next = existing.filter((entry) => entry && entry.id !== credentialRecord.id);
      next.push({
        id: credentialRecord.id,
        publicKey: credentialRecord.publicKey,
        counter: Number(credentialRecord.counter) || 0,
        transports: Array.isArray(credentialRecord.transports) ? credentialRecord.transports : [],
        phoneNumber: normalizedPhone,
      });
      cache[normalizedPhone] = next;
      this._writeStorageJSON(CREDENTIAL_HINTS_STORAGE_KEY, cache);
    }

    _prepareWalletRequest(path, body) {
      const payload = body && typeof body === 'object' ? { ...body } : {};
      const phoneNumber = payload.phoneNumber || this.getBoundPhoneNumber() || null;

      if (path === '/api/lookup' || path === '/api/login/options') {
        if (phoneNumber && !payload.userHint) {
          payload.userHint = this._getUserHint(phoneNumber);
        }
        if (phoneNumber && !payload.credentialHints) {
          payload.credentialHints = this._getCredentialHints(phoneNumber);
        }
      }

      if (path === '/api/device/challenge' && phoneNumber && !payload.phoneNumber) {
        payload.phoneNumber = phoneNumber;
      }

      if (path === '/api/device/verify') {
        if (this._pendingDeviceVerificationToken && !payload.verificationToken) {
          payload.verificationToken = this._pendingDeviceVerificationToken;
        }
        if (phoneNumber && !payload.phoneNumber) {
          payload.phoneNumber = phoneNumber;
        }
        if (!payload.publicKey) {
          payload.publicKey = localStorage.getItem('pw_mock_key') || null;
        }
        if (phoneNumber && !payload.userHint) {
          payload.userHint = this._getUserHint(phoneNumber);
        }
        if (phoneNumber && !payload.credentialHints) {
          payload.credentialHints = this._getCredentialHints(phoneNumber);
        }
      }

      return payload;
    }

    _cacheWalletResponse(path, requestBody, data) {
      if (!data || typeof data !== 'object') return;

      if (path === '/api/device/register' && requestBody?.phoneNumber) {
        localStorage.setItem(BOUND_PHONE_STORAGE_KEY, requestBody.phoneNumber);
      }

      if (path === '/api/device/challenge' && data.verificationToken) {
        this._pendingDeviceVerificationToken = data.verificationToken;
      }

      if (
        path === '/api/auth/otp/verify'
        || path === '/api/login/verify'
        || path === '/api/device/verify'
        || path === '/api/register/verify'
      ) {
        const responsePhone = data.user?.phoneNumber || requestBody?.phoneNumber || null;
        if (data.user && responsePhone) {
          this._cacheUserHint(responsePhone, { ...data.user, phoneNumber: responsePhone });
          if (path === '/api/device/verify' || path === '/api/register/verify') {
            localStorage.setItem(BOUND_PHONE_STORAGE_KEY, responsePhone);
          }
        }
      }

      if (path === '/api/register/verify' && data.credentialRecord) {
        this._cacheCredentialHint(requestBody?.phoneNumber, data.credentialRecord);
      }
    }

    _maskPhoneNumber(phoneNumber) {
      const digits = String(phoneNumber || '').replace(/\D/g, '');
      if (!digits) return null;
      return `***${digits.slice(-4)}`;
    }

    _sanitizeLogValue(value, key = '', depth = 0) {
      if (value == null) return value;
      if (depth > 3) return '[truncated]';

      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('phone')) {
        return this._maskPhoneNumber(value);
      }
      if (
        lowerKey.includes('otp')
        || lowerKey.includes('token')
        || lowerKey.includes('challenge')
        || lowerKey.includes('publickey')
      ) {
        return '[redacted]';
      }
      if (typeof value === 'string') {
        return value.length > 300 ? `${value.slice(0, 300)}...[truncated]` : value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (Array.isArray(value)) {
        return value.slice(0, 10).map((entry) => this._sanitizeLogValue(entry, key, depth + 1));
      }
      if (typeof value === 'object') {
        const out = {};
        for (const [entryKey, entryValue] of Object.entries(value).slice(0, 20)) {
          out[entryKey] = this._sanitizeLogValue(entryValue, entryKey, depth + 1);
        }
        return out;
      }
      return String(value);
    }

    async logClientEvent(event, details = {}, level = 'info', source = 'merchant-sdk') {
      const payload = {
        level,
        source,
        event,
        details: this._sanitizeLogValue(details),
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
            `${WALLET_ORIGIN}/api/client-log`,
            new Blob([body], { type: 'application/json' }),
          );
          if (sent) return;
        }

        await fetch(`${WALLET_ORIGIN}/api/client-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        });
      } catch (err) {
        console.warn('[PassWallet] Failed to send client log', err);
      }
    }

    _serializeError(error) {
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
          out[key] = typeof value === 'string' && value.length > 300
            ? `${value.slice(0, 300)}...[truncated]`
            : value;
        }
        return out;
      }
      return { message: String(error) };
    }

    _installGlobalErrorHandlers() {
      if (this._errorHandlersInstalled) return;
      this._errorHandlersInstalled = true;

      window.addEventListener('error', (event) => {
        void this.logClientEvent('window_error', {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: this._serializeError(event.error),
        }, 'error', 'merchant-window');
      });

      window.addEventListener('unhandledrejection', (event) => {
        void this.logClientEvent('unhandled_rejection', {
          reason: this._serializeError(event.reason),
        }, 'error', 'merchant-window');
      });
    }

    // =========================================================
    // Internal: Fetch wrapper
    // =========================================================

    async _walletFetch(path, body) {
      const requestBody = path === '/api/client-log' ? body : this._prepareWalletRequest(path, body);
      try {
        const res = await fetch(`${WALLET_ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        const data = await res.json();

        if (!res.ok) {
          const err = new Error(data.error || `Request failed: ${res.status}`);
          err.status = res.status;
          if (path !== '/api/client-log') {
            void this.logClientEvent('wallet_fetch_error', {
              path,
              status: res.status,
              requestBody,
              responseBody: data,
            }, 'error');
          }
          throw err;
        }

        if (path !== '/api/client-log') {
          this._cacheWalletResponse(path, requestBody, data);
        }

        return data;
      } catch (error) {
        if (path !== '/api/client-log') {
          void this.logClientEvent('wallet_fetch_exception', {
            path,
            requestBody,
            error: this._serializeError(error),
          }, 'error');
        }
        throw error;
      }
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
          void this.logClientEvent('bridge_request_timeout', {
            requestType: type,
            requestId,
            payload,
          }, 'error', 'bridge-rpc');
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
            void this.logClientEvent('bridge_response_error', {
              requestType: type,
              error,
            }, 'error', 'bridge-rpc');
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
