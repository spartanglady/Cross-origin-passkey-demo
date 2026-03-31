/**
 * PassWalletCheckout - Merchant-side checkout state machine.
 * Drives the entire checkout UI on the merchant page, using the
 * PassWallet SDK for API calls and the passkey bridge for WebAuthn.
 */
class PassWalletCheckout {
  constructor({ amount, merchantName, onComplete, onCancel }) {
    this.amount = amount;
    this.merchantName = merchantName;
    this.onComplete = onComplete;
    this.onCancel = onCancel;

    // State
    this.phoneNumber = '';
    this.user = null;
    this.hasPasskey = false;
    this.selectedCardId = null;
    this.currentStep = 'pw-step-phone';
    this.flowMode = 'INITIAL'; // INITIAL | PASSKEY_LOGIN | WEBCRYPTO_RETURNING | WEBCRYPTO_OTP_FALLBACK
    this.skipCVV = false;
    this.cvvValue = '';
    this.isDestroyed = false;
    this._paymentInProgress = false;
    this._phoneSubmitting = false;
    this._flowEpoch = 0;

    // DOM refs
    this.container = document.getElementById('passwallet-checkout');
    this.steps = {
      'pw-step-phone': document.getElementById('pw-step-phone'),
      'pw-step-otp': document.getElementById('pw-step-otp'),
      'pw-step-register-passkey': document.getElementById('pw-step-register-passkey'),
      'pw-step-payment': document.getElementById('pw-step-payment'),
      'pw-step-processing': document.getElementById('pw-step-processing'),
      'pw-step-success': document.getElementById('pw-step-success'),
    };

    this._bindEvents();
    this._init();
  }

  _isCurrentFlow(flowEpoch) {
    return !this.isDestroyed && flowEpoch === this._flowEpoch;
  }

  _normalizePasskeyOptions(data) {
    if (data && data.options) return data;
    return { options: data, verificationToken: null };
  }

  // =========================================================
  // Initialization
  // =========================================================

  async _init() {
    const sdk = window.PassWallet;
    if (!sdk) {
      console.error('PassWallet SDK not loaded');
      return;
    }

    // Initialize bridge in a body-level container so it's in a fully visible
    // rendering context (not nested inside display:none steps). This ensures
    // the iframe's event loop is active and can receive postMessage calls.
    // The iframe is reparented to specific step slots when the button is needed.
    let bodySlot = document.getElementById('pw-bridge-body-slot');
    if (!bodySlot) {
      bodySlot = document.createElement('div');
      bodySlot.id = 'pw-bridge-body-slot';
      bodySlot.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
      document.body.appendChild(bodySlot);
    }
    try {
      await sdk.init(bodySlot);
    } catch (err) {
      console.warn('Bridge init warning:', err.message);
    }

    // Set amount display
    const payAmountEl = document.getElementById('pw-pay-amount');
    if (payAmountEl) payAmountEl.textContent = `$${this.amount}`;

    // Show a neutral startup state while probing local device binding.
    // This avoids flashing the phone step before returning-user cards load.
    const processingText = document.getElementById('pw-processing-text');
    if (processingText) processingText.textContent = 'Checking saved wallet...';
    this.navigateTo('pw-step-processing');

    // Attempt WebCrypto auto-login
    const loggedIn = await this._attemptWebCryptoLogin();
    if (!loggedIn) {
      // Auto-login unavailable: show phone entry as the first visible step.
      if (processingText) processingText.textContent = 'Processing payment...';
      this.navigateTo('pw-step-phone');
      // Focus phone input
      const phoneInput = document.getElementById('pw-phone-input');
      if (phoneInput) setTimeout(() => phoneInput.focus(), 200);
    }
  }

  // =========================================================
  // Event Bindings
  // =========================================================

  _bindEvents() {
    // Phone form
    const phoneForm = document.getElementById('pw-phone-form');
    const phoneInput = document.getElementById('pw-phone-input');

    phoneInput.addEventListener('input', (e) => {
      const raw = e.target.value.replace(/\D/g, '');
      let x = raw.match(/(\d{0,3})(\d{0,3})(\d{0,4})/);
      e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');

      if (raw.length === 10) {
        phoneForm.requestSubmit();
      }
    });

    phoneForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handlePhoneSubmit();
    });

    // OTP form
    const otpForm = document.getElementById('pw-otp-form');
    const otpInput = document.getElementById('pw-otp-input');

    otpInput.addEventListener('input', (e) => {
      const raw = e.target.value.replace(/\D/g, '').slice(0, 6);
      e.target.value = raw;
      if (raw.length === 6) {
        otpForm.requestSubmit();
      }
    });

    otpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleOTPSubmit();
    });

    // Back to phone
    document.getElementById('pw-back-to-phone').addEventListener('click', () => {
      document.getElementById('pw-otp-input').value = '';
      document.getElementById('pw-otp-error').style.display = 'none';
      this.navigateTo('pw-step-phone', 'backward');
    });

    // Register passkey — merchant button is hidden by default;
    // _prepareRegistration() auto-starts and shows only the bridge iframe button.
    document.getElementById('pw-register-passkey-btn').addEventListener('click', () => {
      this._prepareRegistration();
    });

    // Skip passkey — abort any pending bridge request
    document.getElementById('pw-skip-passkey-btn').addEventListener('click', () => {
      const sdk = window.PassWallet;
      sdk.abortPendingRequests();
      this._processPayment();
    });

    // Pay button
    document.getElementById('pw-pay-btn').addEventListener('click', () => {
      this._handlePayClick();
    });

    // Logout / change user
    document.getElementById('pw-logout-btn').addEventListener('click', () => {
      this._handleLogout();
    });

    // Continue Shopping (from success step)
    document.getElementById('pw-continue-shopping-btn').addEventListener('click', () => {
      if (this.onComplete && this._paymentData) {
        this.onComplete(this._paymentData);
      }
      this.destroy();
    });
  }

  // =========================================================
  // Navigation
  // =========================================================

  navigateTo(stepId, direction = 'forward') {
    if (this.isDestroyed) return;

    const oldStep = this.steps[this.currentStep];
    const newStep = this.steps[stepId];

    if (oldStep) {
      oldStep.classList.remove('pw-active');
    }

    if (newStep) {
      newStep.classList.add('pw-active');
    }

    this.currentStep = stepId;
  }

  // =========================================================
  // Phone Submit
  // =========================================================

  async _handlePhoneSubmit() {
    if (this._phoneSubmitting) return;
    const phoneInput = document.getElementById('pw-phone-input');
    const raw = phoneInput.value.replace(/\D/g, '');
    if (raw.length !== 10) return;
    const flowEpoch = this._flowEpoch;
    this._phoneSubmitting = true;

    this.phoneNumber = raw;
    const phoneBtn = document.getElementById('pw-phone-btn');
    const phoneLoading = document.getElementById('pw-phone-loading');

    phoneBtn.disabled = true;
    phoneLoading.style.display = 'flex';

    let data;
    try {
      const sdk = window.PassWallet;
      data = await sdk.lookup(this.phoneNumber);
      if (!this._isCurrentFlow(flowEpoch)) return;
      this.hasPasskey = data.hasPasskey;
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      console.error(err);
      phoneLoading.style.display = 'none';
      phoneBtn.disabled = false;
      this._showError('Network error. Please try again.');
      return;
    } finally {
      if (this._isCurrentFlow(flowEpoch)) {
        phoneLoading.style.display = 'none';
        phoneBtn.disabled = false;
      }
      this._phoneSubmitting = false;
    }

    if (!this._isCurrentFlow(flowEpoch)) return;

    if (data.exists && this.hasPasskey) {
      // Show bridge button on the phone step for passkey auth
      await this._attemptPasskeyLogin(flowEpoch);
    } else {
      // No passkey, go to OTP
      const sdk = window.PassWallet;
      sdk.hidePasskeyButton();
      this.flowMode = 'INITIAL';
      await this._beginOTPFlow(flowEpoch);
    }
  }

  /**
   * Show the passkey bridge button on the phone step and attempt authentication.
   * Fetches auth options first, then shows bridge button for user click.
   * Falls back to OTP on cancellation or error.
   */
  async _attemptPasskeyLogin(flowEpoch = this._flowEpoch) {
    const sdk = window.PassWallet;
    const phoneBtn = document.getElementById('pw-phone-btn');
    const phoneLoading = document.getElementById('pw-phone-loading');

    // Show loading while fetching auth options
    phoneBtn.disabled = true;
    phoneLoading.style.display = 'flex';

    try {
      // Step 1: Fetch assertion options from server
      const optionsData = await sdk._walletFetch('/api/login/options', {
        phoneNumber: this.phoneNumber,
      });
      const optData = this._normalizePasskeyOptions(optionsData);
      if (!this._isCurrentFlow(flowEpoch)) return;

      // Step 2: Options ready — hide loading, show bridge button on phone step
      phoneLoading.style.display = 'none';
      phoneBtn.disabled = false;

      const phoneSlot = document.getElementById('pw-phone-iframe-slot');
      await sdk.reparent(phoneSlot);
      sdk.showPasskeyButton('Verify with PassWallet');

      // Step 3: Send to bridge — bridge shows button, waits for user click
      const asseResp = await sdk._postToBridge('PASSKEY_AUTH_REQUEST', {
        options: optData.options,
      });
      if (!this._isCurrentFlow(flowEpoch)) return;

      // Step 4: User clicked, ceremony complete — verify on server
      sdk.hidePasskeyButton();
      const verData = await sdk._walletFetch('/api/login/verify', {
        phoneNumber: this.phoneNumber,
        sessionId: optData.sessionId,
        verificationToken: optData.verificationToken,
        response: asseResp,
      });
      if (!this._isCurrentFlow(flowEpoch)) return;

      this.user = verData.user;
      this.flowMode = 'PASSKEY_LOGIN';
      await this._ensureWebCryptoKeypair();
      if (!this._isCurrentFlow(flowEpoch)) return;
      this._setupPaymentView(true);
      this.navigateTo('pw-step-payment');
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      sdk.hidePasskeyButton();
      phoneLoading.style.display = 'none';
      phoneBtn.disabled = false;

      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        // Passkey cancelled, fall back to OTP
        this.flowMode = 'INITIAL';
        await this._beginOTPFlow(flowEpoch);
      } else {
        this._showError('Authentication failed. Please try again.');
      }
    }
  }

  // =========================================================
  // OTP Submit
  // =========================================================

  async _handleOTPSubmit() {
    if (this._otpSubmitting) return;
    const flowEpoch = this._flowEpoch;
    const otpInput = document.getElementById('pw-otp-input');
    const otp = otpInput.value.replace(/\D/g, '');
    if (otp.length !== 6) return;

    this._otpSubmitting = true;
    const btn = document.getElementById('pw-verify-otp-btn');
    const errEl = document.getElementById('pw-otp-error');
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const sdk = window.PassWallet;
      const data = await sdk.verifyOTP(this.phoneNumber, otp);
      if (!this._isCurrentFlow(flowEpoch)) return;
      this.user = data.user;

      if (this.flowMode === 'WEBCRYPTO_OTP_FALLBACK') {
        // WebCrypto returning user who failed passkey — payment satisfied
        await this._processPayment(flowEpoch);
      } else {
        // Normal INITIAL flow — need CVV
        this._setupPaymentView(false);
        this.navigateTo('pw-step-payment');
      }
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      errEl.textContent = err.message || 'Verification failed. Please try again.';
      errEl.style.display = 'block';
    } finally {
      if (!this._isCurrentFlow(flowEpoch)) return;
      this._otpSubmitting = false;
      btn.disabled = false;
      btn.textContent = 'Verify Code';
    }
  }

  // =========================================================
  // Payment View Setup
  // =========================================================

  _setupPaymentView(skipCVV = false) {
    this.skipCVV = skipCVV;
    this.cvvValue = '';

    const phoneDisplay = document.getElementById('pw-display-phone');
    const avatar = document.getElementById('pw-user-avatar');
    const payAmountEl = document.getElementById('pw-pay-amount');

    phoneDisplay.textContent = this.phoneNumber;
    avatar.textContent = this.user.displayName.charAt(0).toUpperCase();
    if (payAmountEl) payAmountEl.textContent = `$${this.amount}`;

    if (!this.user.cards || this.user.cards.length === 0) {
      document.getElementById('pw-card-list').innerHTML = '<p style="color:#64748B;text-align:center;padding:1rem;">No cards saved.</p>';
      document.getElementById('pw-pay-btn').disabled = true;
      return;
    }

    this.selectedCardId = this.user.cards[0].id;
    this._renderCards();
  }

  _renderCards() {
    const cardList = document.getElementById('pw-card-list');
    const payBtn = document.getElementById('pw-pay-btn');

    const showCVV = (cardId) => {
      if (this.skipCVV) return '';
      if (cardId !== this.selectedCardId) return '';
      return `
        <div class="pw-cvv-container">
          <label for="pw-cvv-input">Security Code</label>
          <div class="pw-cvv-wrapper">
            <input type="password" id="pw-cvv-input" class="pw-cvv-input" placeholder="CVV" maxlength="4" autocomplete="cc-csc" value="${this.cvvValue}">
            <span class="pw-cvv-hint">Use 123 for demo</span>
          </div>
        </div>
      `;
    };

    cardList.innerHTML = this.user.cards.map(card => `
      <div class="pw-card-wrapper" data-id="${card.id}">
        <div class="pw-card-item ${card.id === this.selectedCardId ? 'pw-selected' : ''}">
          <div class="pw-card-icon" style="background: linear-gradient(135deg, ${card.color1}, ${card.color2})"></div>
          <div class="pw-card-details">
            <span class="pw-card-brand">${card.brand}</span>
            <span class="pw-card-last4">&bull;&bull;&bull;&bull; ${card.last4}</span>
          </div>
          <div class="pw-radio-circle"></div>
        </div>
        ${showCVV(card.id)}
      </div>
    `).join('');

    // Card selection listeners
    cardList.querySelectorAll('.pw-card-item').forEach(el => {
      el.addEventListener('click', () => {
        const wrapper = el.parentElement;
        this.selectedCardId = wrapper.dataset.id;
        this.cvvValue = '';
        this._renderCards();
      });
    });

    // CVV input listener
    const cvvInput = document.getElementById('pw-cvv-input');
    if (cvvInput) {
      cvvInput.addEventListener('input', (e) => {
        this.cvvValue = e.target.value;
        payBtn.disabled = this.cvvValue !== '123';
      });
      payBtn.disabled = this.cvvValue !== '123';
    } else {
      payBtn.disabled = false;
    }
  }

  // =========================================================
  // Pay Button Click
  // =========================================================

  async _handlePayClick() {
    if (!this.selectedCardId) return;
    const flowEpoch = this._flowEpoch;
    const sdk = window.PassWallet;

    if (this.flowMode === 'INITIAL') {
      // Validate CVV
      const cvvInput = document.getElementById('pw-cvv-input');
      if (cvvInput && cvvInput.value !== '123') {
        this._showError('Invalid CVV');
        return;
      }

      // CVV validated — establish WebCrypto bind
      await this._ensureWebCryptoKeypair();

      // Offer passkey registration if not present
      if (!this.hasPasskey) {
        // Move bridge to register slot, show step, and auto-start
        const registerSlot = document.getElementById('pw-register-iframe-slot');
        this.navigateTo('pw-step-register-passkey');
        await sdk.reparent(registerSlot);
        if (!this._isCurrentFlow(flowEpoch)) return;
        this._prepareRegistration(flowEpoch);
      } else {
        await this._processPayment(flowEpoch);
      }

    } else if (this.flowMode === 'WEBCRYPTO_RETURNING') {
      // Returning user, skipped CVV. Need biometric or OTP.
      if (this.hasPasskey) {
        const payBtn = document.getElementById('pw-pay-btn');
        payBtn.disabled = true;
        payBtn.textContent = 'Verifying...';

        try {
          // Step 1: Fetch auth options
          const optionsData = await sdk._walletFetch('/api/login/options', {
            phoneNumber: this.phoneNumber,
          });
          const optData = this._normalizePasskeyOptions(optionsData);
          if (!this._isCurrentFlow(flowEpoch)) return;

          // Step 2: Options ready — hide pay button, show bridge button
          payBtn.style.display = 'none';
          const authSlot = document.getElementById('pw-auth-iframe-slot');
          await sdk.reparent(authSlot);
          sdk.showPasskeyButton('Verify with PassWallet');

          // Step 3: Send to bridge, wait for user click
          const asseResp = await sdk._postToBridge('PASSKEY_AUTH_REQUEST', {
            options: optData.options,
          });
          if (!this._isCurrentFlow(flowEpoch)) return;

          // Step 4: Verify on server
          sdk.hidePasskeyButton();
          const verData = await sdk._walletFetch('/api/login/verify', {
            phoneNumber: this.phoneNumber,
            sessionId: optData.sessionId,
            verificationToken: optData.verificationToken,
            response: asseResp,
          });
          if (!this._isCurrentFlow(flowEpoch)) return;

          payBtn.style.display = '';
          this.user = verData.user;
          await this._processPayment(flowEpoch);
        } catch (err) {
          if (!this._isCurrentFlow(flowEpoch)) return;
          sdk.hidePasskeyButton();
          payBtn.style.display = '';
          payBtn.disabled = false;
          payBtn.innerHTML = 'Pay <span id="pw-pay-amount">$' + this.amount + '</span>';

          if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            this.flowMode = 'WEBCRYPTO_OTP_FALLBACK';
            await this._beginOTPFlow(flowEpoch);
          } else {
            this._showError('Authentication failed.');
          }
        }
      } else {
        // No passkey, fall to OTP
        this.flowMode = 'WEBCRYPTO_OTP_FALLBACK';
        await this._beginOTPFlow(flowEpoch);
      }

    } else if (this.flowMode === 'PASSKEY_LOGIN') {
      // Already authenticated via passkey
      await this._processPayment(flowEpoch);
    }
  }

  // =========================================================
  // Passkey Registration
  // =========================================================

  /**
   * Pre-fetch registration options and show the bridge iframe button
   * as the sole "Save Passkey" action. The merchant button is hidden —
   * user only clicks the bridge button (one click for WebAuthn).
   */
  async _prepareRegistration(flowEpoch = this._flowEpoch) {
    const sdk = window.PassWallet;
    const loadingEl = document.getElementById('pw-register-loading');

    // Show loading while fetching options
    loadingEl.style.display = 'block';

    try {
      // Step 1: Fetch registration options from server
      const optionsData = await sdk._walletFetch('/api/register/options', {
        phoneNumber: this.phoneNumber,
        displayName: this.user.displayName,
      });
      const regData = this._normalizePasskeyOptions(optionsData);
      if (!this._isCurrentFlow(flowEpoch)) return;

      // Step 2: Options ready — hide loading, show bridge button
      loadingEl.style.display = 'none';
      sdk.showPasskeyButton('Save Passkey');

      // Step 3: Send options to bridge — bridge renders its button, waits for user click
      const attResp = await sdk._postToBridge('PASSKEY_REGISTER_REQUEST', {
        options: regData.options,
      });
      if (!this._isCurrentFlow(flowEpoch)) return;

      // Step 4: User clicked bridge button, ceremony complete — verify on server
      sdk.hidePasskeyButton();
      const result = await sdk._walletFetch('/api/register/verify', {
        phoneNumber: this.phoneNumber,
        verificationToken: regData.verificationToken,
        response: attResp,
      });
      if (!this._isCurrentFlow(flowEpoch)) return;

      if (result.verified) {
        this.hasPasskey = true;
      }
      await this._processPayment(flowEpoch);
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      sdk.hidePasskeyButton();
      loadingEl.style.display = 'none';

      if (err.name === 'AbortError') {
        // Aborted by "Not now" — processPayment already called from skip handler
        return;
      }

      console.error('Passkey registration error:', err);
      if (err.name === 'NotAllowedError') {
        // User cancelled WebAuthn — proceed to payment
        await this._processPayment(flowEpoch);
      } else {
        this._showError('Failed to register passkey. Continuing to payment.');
        await this._processPayment(flowEpoch);
      }
    }
  }

  // =========================================================
  // Payment Processing
  // =========================================================

  async _processPayment(flowEpoch = this._flowEpoch) {
    if (!this._isCurrentFlow(flowEpoch)) return;
    if (this._paymentInProgress) return;
    this._paymentInProgress = true;
    this.navigateTo('pw-step-processing');
    const processingText = document.getElementById('pw-processing-text');
    const spinner = document.querySelector('#pw-step-processing .pw-spinner');
    processingText.textContent = 'Processing payment...';

    try {
      const sdk = window.PassWallet;
      const data = await sdk.pay(this.phoneNumber, this.selectedCardId, this.amount);
      if (!this._isCurrentFlow(flowEpoch)) return;

      if (data.success) {
        // Populate inline success step
        this._paymentData = data;
        document.getElementById('pw-conf-amount').textContent = `$${data.amount}`;
        document.getElementById('pw-conf-card').textContent = `${data.cardBrand} \u2022\u2022\u2022\u2022 ${data.last4}`;
        document.getElementById('pw-conf-txn').textContent = data.transactionId;

        this.navigateTo('pw-step-success');
      } else {
        throw new Error(data.error || 'Payment failed');
      }
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      processingText.textContent = 'Payment failed';
      this._showError(err.message);
      this.navigateTo('pw-step-payment');
    } finally {
      this._paymentInProgress = false;
    }
  }

  // =========================================================
  // WebCrypto Device Binding
  // =========================================================

  async _attemptWebCryptoLogin() {
    try {
      const sdk = window.PassWallet;
      const deviceId = sdk.getDeviceId();
      if (!deviceId) return false;

      let hasKey = false;
      // Check localStorage first (fallback key), then try IDB with timeout
      const mockKey = localStorage.getItem('pw_mock_key');
      if (mockKey) {
        hasKey = true;
      } else if (window.crypto && window.crypto.subtle && window.indexedDB) {
        try {
          const keypair = await Promise.race([
            import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
              .then(({ get }) => get('device_key')),
            new Promise(resolve => setTimeout(() => resolve(null), 3000))
          ]);
          if (keypair) hasKey = true;
        } catch (idbErr) {
          console.warn('IDB read failed', idbErr);
        }
      }

      if (!hasKey) return false;

      const { challenge } = await sdk.challengeDevice(deviceId);
      const mockSignature = btoa(`signed_${challenge}_by_${deviceId}`);
      const result = await sdk.verifyDevice(deviceId, mockSignature);

      if (result.verified) {
        this.user = result.user;
        this.phoneNumber = result.user.phoneNumber;
        this.hasPasskey = result.hasPasskey;
        this.flowMode = 'WEBCRYPTO_RETURNING';

        this._setupPaymentView(true);
        this.navigateTo('pw-step-payment');
        return true;
      } else if (result.status === 404) {
        localStorage.removeItem('pw_device_id');
        localStorage.removeItem('pw_mock_key');
        if (window.indexedDB) {
          import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
            .then(({ del }) => del('device_key'))
            .catch(console.warn);
        }
      }
    } catch (err) {
      console.warn('WebCrypto login failed', err);
      // If 404, clear stale keys
      if (err.status === 404) {
        localStorage.removeItem('pw_device_id');
        localStorage.removeItem('pw_mock_key');
        if (window.indexedDB) {
          import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
            .then(({ del }) => del('device_key'))
            .catch(console.warn);
        }
      }
    }
    return false;
  }

  async _ensureWebCryptoKeypair() {
    try {
      let deviceId = localStorage.getItem('pw_device_id');
      if (!deviceId) {
        deviceId = 'dev_' + Math.random().toString(36).substr(2, 9);
      }

      const sdk = window.PassWallet;
      let pubB64 = localStorage.getItem('pw_mock_key') || '';

      if (!pubB64 && window.crypto && window.crypto.subtle && window.indexedDB) {
        try {
          const keypair = await Promise.race([
            import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
              .then(({ get }) => get('device_key')),
            new Promise(resolve => setTimeout(() => resolve(null), 3000))
          ]);
          if (keypair && keypair.publicKey) {
            const exportedPub = await window.crypto.subtle.exportKey('spki', keypair.publicKey);
            const pubBuf = new Uint8Array(exportedPub);
            pubB64 = btoa(String.fromCharCode.apply(null, pubBuf));
            localStorage.setItem('pw_mock_key', pubB64);
          }
        } catch (idbErr) {
          console.warn('Existing key read failed, regenerating', idbErr);
        }
      }

      if (!pubB64 && window.crypto && window.crypto.subtle) {
        try {
          const keypair = await window.crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign', 'verify']
          );
          const exportedPub = await window.crypto.subtle.exportKey('spki', keypair.publicKey);
          const pubBuf = new Uint8Array(exportedPub);
          pubB64 = btoa(String.fromCharCode.apply(null, pubBuf));

          // Try IDB storage with timeout to avoid hangs
          if (window.indexedDB) {
            const stored = await Promise.race([
              import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
                .then(({ set }) => set('device_key', keypair).then(() => true)),
              new Promise(resolve => setTimeout(() => resolve(false), 3000))
            ]);
            if (!stored) {
              console.warn('IDB store timed out, using localStorage fallback');
            }
          }
          localStorage.setItem('pw_mock_key', pubB64);
        } catch (cryptoErr) {
          console.warn('WebCrypto failed, using mock key', cryptoErr);
        }
      }

      if (!pubB64) {
        pubB64 = btoa('mock-key-' + deviceId);
        localStorage.setItem('pw_mock_key', pubB64);
      }

      const res = await sdk.registerDevice(deviceId, this.phoneNumber, pubB64);
      if (res.success) {
        localStorage.setItem('pw_device_id', deviceId);
      }
    } catch (err) {
      console.error('Failed to establish WebCrypto binding', err);
    }
  }

  // =========================================================
  // Helpers
  // =========================================================

  _formatPhone(raw) {
    const x = raw.match(/(\d{0,3})(\d{0,3})(\d{0,4})/);
    return !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');
  }

  async _beginOTPFlow(flowEpoch = this._flowEpoch) {
    try {
      await this._sendOTP();
    } catch (err) {
      if (!this._isCurrentFlow(flowEpoch)) return;
      this._showError('Unable to send verification code. Please try again.');
      return;
    }
    if (!this._isCurrentFlow(flowEpoch)) return;
    this.navigateTo('pw-step-otp');
    setTimeout(() => document.getElementById('pw-otp-input').focus(), 300);
  }

  async _sendOTP() {
    const sdk = window.PassWallet;
    await sdk.sendOTP(this.phoneNumber);
    const displayEl = document.getElementById('pw-display-otp-phone');
    if (displayEl) displayEl.textContent = `+1 ${this._formatPhone(this.phoneNumber)}`;
  }

  _showError(msg) {
    // Try step-specific error element first, then fall back to a general toast
    const errEl = document.getElementById('pw-otp-error');
    if (errEl && this.currentStep === 'pw-step-otp') {
      errEl.textContent = msg;
      errEl.style.display = 'block';
      return;
    }

    // General error: show a temporary toast on the checkout container
    let toast = this.container.querySelector('.pw-error-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'pw-error-toast';
      this.container.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('pw-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('pw-visible'), 4000);
  }

  _handleLogout() {
    this._flowEpoch += 1;
    if (window.PassWallet) {
      window.PassWallet.abortPendingRequests();
      window.PassWallet.hidePasskeyButton();
    }

    // Reset checkout state and go back to phone for manual user switch
    this.phoneNumber = '';
    this.user = null;
    this.hasPasskey = false;
    this.selectedCardId = null;
    this.flowMode = 'INITIAL';
    this.skipCVV = false;
    this.cvvValue = '';
    this._paymentInProgress = false;
    this._otpSubmitting = false;
    this._phoneSubmitting = false;

    document.getElementById('pw-phone-input').value = '';
    document.getElementById('pw-otp-input').value = '';
    document.getElementById('pw-otp-error').style.display = 'none';
    this.navigateTo('pw-step-phone');
    setTimeout(() => document.getElementById('pw-phone-input').focus(), 200);
  }

  destroy() {
    this.isDestroyed = true;
    this._flowEpoch += 1;
    this._paymentInProgress = false;
    if (window.PassWallet) {
      window.PassWallet.hidePasskeyButton();
      window.PassWallet.destroy();
    }
    // Reset all step visibility (container stays in the DOM)
    if (this.container) {
      Object.values(this.steps).forEach(step => {
        if (step) step.classList.remove('pw-active');
      });
    }
  }
}
