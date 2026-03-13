// checkout.js - PassWallet State Machine
const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

document.addEventListener('DOMContentLoaded', () => {

  // --- State ---
  let state = {
    phoneNumber: '',
    checkoutData: null,
    user: null, // { displayName, cards }
    hasPasskey: false,
    selectedCardId: null,
    currentView: 'view-phone',
    flowMode: 'INITIAL', // 'INITIAL', 'PASSKEY_LOGIN', 'WEBCRYPTO_RETURNING', 'WEBCRYPTO_OTP_FALLBACK'
    skipCVV: false,
    cvvValue: ''
  };

  // --- DOM Elements ---
  const appContainer = document.getElementById('checkout-app');

  // Views
  const views = {
    'view-phone': document.getElementById('view-phone'),
    'view-otp': document.getElementById('view-otp'),
    'view-register-passkey': document.getElementById('view-register-passkey'),
    'view-payment': document.getElementById('view-payment'),
    'view-processing': document.getElementById('view-processing')
  };

  // Form elements
  const phoneForm = document.getElementById('phone-form');
  const phoneInput = document.getElementById('phone-input');
  const phoneBtn = document.getElementById('continue-phone-btn');
  const phoneLoading = document.getElementById('phone-loading');

  const otpForm = document.getElementById('otp-form');
  const otpInput = document.getElementById('otp-input');
  const displayOtpPhone = document.getElementById('display-otp-phone');

  const registerBtn = document.getElementById('register-passkey-btn');
  const skipBtn = document.getElementById('skip-passkey-btn');

  const displayPaymentPhone = document.getElementById('display-payment-phone');
  const userAvatar = document.getElementById('user-avatar');
  const cardList = document.getElementById('card-list');
  const payBtn = document.getElementById('pay-btn');
  const payAmount = document.getElementById('pay-amount');
  const logoutBtn = document.getElementById('logout-btn');

  const processingText = document.getElementById('processing-text');

  // --- Core Lifecycle & Communication ---

  window.parent.postMessage({ type: 'WALLET_READY' }, '*');

  let lastReportedHeight = 0;
  function notifyResize() {
    setTimeout(() => {
      const height = appContainer.scrollHeight;
      if (height !== lastReportedHeight) {
        lastReportedHeight = height;
        window.parent.postMessage({ type: 'RESIZE_IFRAME', data: { height } }, '*');
      }
    }, 50);
  }

  const resizeObserver = new ResizeObserver(() => notifyResize());
  resizeObserver.observe(appContainer);

  window.addEventListener('message', (event) => {
    const { type, data } = event.data;
    if (type === 'INIT_CHECKOUT') {
      state.checkoutData = data;
      payAmount.textContent = `$${data.amount}`;
      notifyResize();
    }
  });

  // --- Navigation & Transitions ---
  function navigateTo(viewId, direction = 'forward') {
    const oldView = views[state.currentView];
    const newView = views[viewId];

    if (oldView) {
      oldView.classList.remove('active');
      oldView.classList.add(direction === 'forward' ? 'exit-left' : 'exit-right');
    }

    newView.classList.remove('exit-left', 'exit-right');
    newView.classList.add('active');

    state.currentView = viewId;
    notifyResize();
  }

  function showError(msg) {
    alert(msg);
    notifyResize();
  }

  // --- Common Helpers ---
  async function sendOTP() {
    phoneLoading.style.display = 'flex';
    try {
      await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.phoneNumber })
      });
      displayOtpPhone.textContent = `+1 ${state.phoneNumber}`;
    } catch (err) {
      console.error(err);
    } finally {
      phoneLoading.style.display = 'none';
      phoneBtn.disabled = false;
    }
  }

  async function triggerPasskeyLogin() {
    // 1. Get options
    const optRes = await fetch('/api/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: state.phoneNumber })
    });
    const data = await optRes.json();

    // 2. Client ceremony
    const asseResp = await startAuthentication(data.options);

    // 3. Verify
    const verRes = await fetch('/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: state.phoneNumber, sessionId: data.sessionId, response: asseResp })
    });

    if (verRes.ok) {
      const verData = await verRes.json();
      state.user = verData.user;
      return true;
    }
    throw new Error('Login failed');
  }

  async function processPayment() {
    navigateTo('view-processing');
    try {
      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: state.phoneNumber,
          cardId: state.selectedCardId,
          amount: state.checkoutData ? state.checkoutData.amount : 0
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        processingText.textContent = 'Success!';
        document.querySelector('.spinner-large').style.borderColor = 'var(--success)';
        setTimeout(() => {
          window.parent.postMessage({ type: 'PAYMENT_COMPLETE', data }, '*');
        }, 1000);
      } else {
        throw new Error(data.error || 'Payment failed');
      }
    } catch (err) {
      showError(err.message);
      navigateTo('view-payment', 'backward');
    }
  }

  // --- 0. Conditional Passkey Autofill ---
  async function initConditionalPasskey() {
    try {
      const optRes = await fetch('/api/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // no email/phone for conditional
      });
      const data = await optRes.json();

      const asseResp = await startAuthentication({
        optionsJSON: data.options,
        useBrowserAutofill: true
      });

      const verRes = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: data.sessionId, response: asseResp })
      });

      if (verRes.ok) {
        const verData = await verRes.json();
        state.user = verData.user;
        state.phoneNumber = verData.user.phoneNumber;
        state.hasPasskey = true;
        state.flowMode = 'PASSKEY_LOGIN';

        phoneLoading.style.display = 'none';
        phoneBtn.disabled = false;

        await ensureWebCryptoKeypair();
        setupPaymentView(true);
        navigateTo('view-payment');
      }
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        console.error('Conditional Passkey Error:', err);
      }
    }
  }

  initConditionalPasskey();

  // --- 1. Phone Flow ---
  phoneInput.addEventListener('input', (e) => {
    const rawVal = e.target.value.replace(/\D/g, '');
    let x = rawVal.match(/(\d{0,3})(\d{0,3})(\d{0,4})/);
    e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');

    if (rawVal.length === 10 && !phoneBtn.disabled) {
      phoneBtn.click();
    }
  });

  phoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawDigits = phoneInput.value.replace(/\D/g, '');
    if (rawDigits.length !== 10) return;

    state.phoneNumber = rawDigits;
    phoneBtn.disabled = true;
    phoneLoading.style.display = 'flex';

    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.phoneNumber })
      });
      const data = await res.json();
      state.hasPasskey = data.hasPasskey;

      if (data.exists && state.hasPasskey) {
        try {
          await triggerPasskeyLogin();
          state.flowMode = 'PASSKEY_LOGIN';
          await ensureWebCryptoKeypair();
          setupPaymentView(true);
          navigateTo('view-payment');
        } catch (err) {
          if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            state.flowMode = 'INITIAL';
            await sendOTP();
            navigateTo('view-otp', 'forward');
            setTimeout(() => otpInput.focus(), 300);
          } else {
            showError('Authentication failed.');
          }
        }
      } else {
        state.flowMode = 'INITIAL';
        await sendOTP();
        navigateTo('view-otp', 'forward');
        setTimeout(() => otpInput.focus(), 300);
      }
    } catch (err) {
      console.error(err);
      showError('Network error strictly occurred.');
    } finally {
      phoneLoading.style.display = 'none';
      phoneBtn.disabled = false;
    }
  });

  // --- 2. OTP flow ---
  document.getElementById('back-to-phone-btn').addEventListener('click', () => {
    navigateTo('view-phone', 'backward');
  });

  otpInput.addEventListener('input', (e) => {
    const rawVal = e.target.value.replace(/\D/g, '');
    const btn = document.getElementById('verify-otp-btn');
    if (rawVal.length === 6 && !btn.disabled) {
      btn.click();
    }
  });

  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const otp = otpInput.value.replace(/\D/g, '');
    if (otp.length !== 6) return;

    const btn = document.getElementById('verify-otp-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.phoneNumber, otp })
      });

      if (!res.ok) throw new Error('Invalid OTP');

      const data = await res.json();
      state.user = data.user;

      if (state.flowMode === 'WEBCRYPTO_OTP_FALLBACK') {
        // Came from returning user flow who failed passkey, they bypass CVV since possession is satisfied by WebCrypto/OTP
        await processPayment();
      } else {
        // Normal INITIAL flow requires CVV next
        setupPaymentView(false); // require CVV
        navigateTo('view-payment');
      }

    } catch (err) {
      showError('Invalid code. Check server console for mock SMS.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify Code';
    }
  });

  // --- 3. Payment View ---
  function setupPaymentView(skipCVV = false) {
    state.skipCVV = skipCVV;
    state.cvvValue = '';
    displayPaymentPhone.textContent = state.phoneNumber;
    userAvatar.textContent = state.user.displayName.charAt(0).toUpperCase();

    if (!state.user.cards || state.user.cards.length === 0) {
      cardList.innerHTML = '<p>No cards saved.</p>';
      payBtn.disabled = true;
      return;
    }

    state.selectedCardId = state.user.cards[0].id;
    renderCards();
  }

  function renderCards() {
    const showCVV = (cardId) => {
      if (state.skipCVV) return '';
      if (cardId !== state.selectedCardId) return '';
      return `
        <div class="cvv-container" id="cvv-container">
          <label for="cvv-input">Security Code</label>
          <div class="cvv-input-wrapper">
            <input type="password" id="cvv-input" placeholder="CVV" maxlength="4" autocomplete="cc-csc" value="${state.cvvValue}">
            <span class="cvv-hint">Use 123 for demo</span>
          </div>
        </div>
      `;
    };

    cardList.innerHTML = state.user.cards.map(card => `
      <div class="card-wrapper" data-id="${card.id}">
        <div class="card-item ${card.id === state.selectedCardId ? 'selected' : ''}">
          <div class="card-icon" style="background: linear-gradient(135deg, ${card.color1}, ${card.color2})"></div>
          <div class="card-details">
            <span class="card-brand">${card.brand}</span>
            <span class="card-last4">•••• ${card.last4}</span>
          </div>
          <div class="radio-circle"></div>
        </div>
        ${showCVV(card.id)}
      </div>
    `).join('');

    document.querySelectorAll('.card-item').forEach(el => {
      el.addEventListener('click', () => {
        const wrapper = el.parentElement;
        state.selectedCardId = wrapper.dataset.id;
        state.cvvValue = ''; // reset on toggle
        renderCards();
      });
    });

    const cvvInput = document.getElementById('cvv-input');
    if (cvvInput) {
      cvvInput.addEventListener('input', (e) => {
        state.cvvValue = e.target.value;
        payBtn.disabled = state.cvvValue !== '123';
      });
      // Initial state
      payBtn.disabled = state.cvvValue !== '123';
    } else {
      payBtn.disabled = false;
    }

    notifyResize();
  }

  logoutBtn.addEventListener('click', () => {
    // Clear device bindings on explicit logout
    localStorage.removeItem('pw_device_id');
    localStorage.removeItem('pw_mock_key');

    if (window.indexedDB) {
      import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module')
        .then(({ del }) => del('device_key'))
        .catch(console.warn)
        .finally(() => window.location.reload());
    } else {
      window.location.reload();
    }
  });

  // --- 4. Payment Processing (Pay btn) ---
  payBtn.addEventListener('click', async () => {
    if (!state.selectedCardId) return;

    if (state.flowMode === 'INITIAL') {
      // 1. Validate CVV dynamically rendered
      const cvvInput = document.getElementById('cvv-input');
      if (cvvInput && cvvInput.value !== '123') {
        showError('Invalid CVV');
        return;
      }

      // 2. CVV Validated -> MFA satisfied. Establish WebCrypto bind
      await ensureWebCryptoKeypair();

      // 3. Request Passkey if not present
      if (!state.hasPasskey) {
        navigateTo('view-register-passkey');
      } else {
        await processPayment();
      }

    } else if (state.flowMode === 'WEBCRYPTO_RETURNING') {
      // Skipped CVV. Try Biometrics or OTP fallback to finalize auth
      if (state.hasPasskey) {
        try {
          await triggerPasskeyLogin();
          await processPayment();
        } catch (err) {
          if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            state.flowMode = 'WEBCRYPTO_OTP_FALLBACK';
            await sendOTP();
            navigateTo('view-otp', 'forward');
            setTimeout(() => otpInput.focus(), 300);
          } else {
            showError('Authentication failed.');
          }
        }
      } else {
        // Returning WebCrypto user but no passkeys setup! Drop into OTP.
        state.flowMode = 'WEBCRYPTO_OTP_FALLBACK';
        await sendOTP();
        navigateTo('view-otp', 'forward');
        setTimeout(() => otpInput.focus(), 300);
      }
    } else if (state.flowMode === 'PASSKEY_LOGIN') {
      // Automatically entered via Passkey login initially, CVV skipped.
      await processPayment();
    }
  });

  // --- 5. Passkey Registration (Post CVV) ---
  skipBtn.addEventListener('click', async () => {
    await processPayment();
  });

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    registerBtn.textContent = 'Follow browser prompts...';

    try {
      const optRes = await fetch('/api/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.phoneNumber, displayName: state.user.displayName })
      });
      const options = await optRes.json();

      const attResp = await startRegistration(options);

      const verRes = await fetch('/api/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.phoneNumber, response: attResp })
      });

      if (verRes.ok) {
        state.hasPasskey = true;
        await processPayment();
      } else {
        throw new Error('Registration verification failed');
      }
    } catch (err) {
      console.error(err);
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        showError('Passkey registration cancelled.');
        await processPayment();
      } else {
        showError('Failed to register passkey.');
      }
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'Save Passkey';
    }
  });

  // --- 6. WebCrypto Device Binding Helpers ---

  async function attemptWebCryptoLogin() {
    try {
      const deviceId = localStorage.getItem('pw_device_id');
      if (!deviceId) return false;

      let hasKey = false;
      if (window.crypto && window.crypto.subtle && window.indexedDB) {
        const { get } = await import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module');
        const keypair = await get('device_key');
        if (keypair) hasKey = true;
      } else {
        const mockKey = localStorage.getItem('pw_mock_key');
        if (mockKey) hasKey = true;
      }

      if (!hasKey) return false;

      const resChal = await fetch('/api/device/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId })
      });
      if (!resChal.ok) return false;
      const { challenge } = await resChal.json();

      const mockSignature = btoa(`signed_${challenge}_by_${deviceId}`);

      const resVer = await fetch('/api/device/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, signature: mockSignature })
      });

      if (resVer.ok) {
        const { user, hasPasskey } = await resVer.json();
        state.user = user;
        state.phoneNumber = user.phoneNumber;
        state.hasPasskey = hasPasskey;
        state.flowMode = 'WEBCRYPTO_RETURNING';

        phoneLoading.style.display = 'none';

        setupPaymentView(true); // true = skip CVV
        navigateTo('view-payment');
        return true;
      } else if (resVer.status === 404) {
        console.warn('Backend did not recognize device. Clearing local stale keys.');
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
    }
    return false;
  }

  async function ensureWebCryptoKeypair() {
    try {
      let deviceId = localStorage.getItem('pw_device_id');
      if (deviceId) return; // Already bound

      deviceId = 'dev_' + Math.random().toString(36).substr(2, 9);

      let pubB64 = '';
      // Support for secure environments to drop actual WebCrypto key.
      if (window.crypto && window.crypto.subtle && window.indexedDB) {
        const { set } = await import('https://unpkg.com/idb-keyval@6.0.3/dist/index.js?module');
        const keypair = await window.crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign", "verify"]
        );

        const exportedPub = await window.crypto.subtle.exportKey("spki", keypair.publicKey);
        const pubBuf = new Uint8Array(exportedPub);
        pubB64 = btoa(String.fromCharCode.apply(null, pubBuf));
        await set('device_key', keypair);
      } else {
        // Fallback for demo environments like HTTP Firefox where window.crypto.subtle is undefined.
        pubB64 = btoa('mock-key-' + deviceId);
        localStorage.setItem('pw_mock_key', pubB64);
      }

      const res = await fetch('/api/device/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          phoneNumber: state.phoneNumber,
          publicKey: pubB64
        })
      });

      if (res.ok) {
        localStorage.setItem('pw_device_id', deviceId);
      }
    } catch (err) {
      console.error('Failed to establish WebCrypto binding', err);
    }
  }

  attemptWebCryptoLogin().then(loggedIn => {
    if (!loggedIn) {
      console.log('Ready for input.');
    }
  });

});
