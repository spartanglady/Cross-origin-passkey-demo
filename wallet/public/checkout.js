// checkout.js - PassWallet State Machine
const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

document.addEventListener('DOMContentLoaded', () => {

  // --- State ---
  let state = {
    email: '',
    checkoutData: null,
    user: null, // { displayName, cards }
    hasPasskey: false,
    selectedCardId: null,
    currentView: 'view-email'
  };

  // --- DOM Elements ---
  const appContainer = document.getElementById('checkout-app');

  // Views
  const views = {
    'view-email': document.getElementById('view-email'),
    'view-otp': document.getElementById('view-otp'),
    'view-register-passkey': document.getElementById('view-register-passkey'),
    'view-payment': document.getElementById('view-payment'),
    'view-processing': document.getElementById('view-processing')
  };

  // Form elements
  const emailForm = document.getElementById('email-form');
  const emailInput = document.getElementById('email-input');
  const emailBtn = document.getElementById('continue-email-btn');
  const emailLoading = document.getElementById('email-loading');

  const otpForm = document.getElementById('otp-form');
  const otpInput = document.getElementById('otp-input');
  const displayOtpEmail = document.getElementById('display-otp-email');

  const registerBtn = document.getElementById('register-passkey-btn');
  const skipBtn = document.getElementById('skip-passkey-btn');

  const displayPaymentEmail = document.getElementById('display-payment-email');
  const userAvatar = document.getElementById('user-avatar');
  const cardList = document.getElementById('card-list');
  const payBtn = document.getElementById('pay-btn');
  const payAmount = document.getElementById('pay-amount');
  const logoutBtn = document.getElementById('logout-btn');

  const processingText = document.getElementById('processing-text');

  // --- Core Lifecycle & Communication ---

  // Notify parent SDK that iframe is ready to receive data
  window.parent.postMessage({ type: 'WALLET_READY' }, '*');

  window.addEventListener('message', (event) => {
    const { type, data } = event.data;
    if (type === 'INIT_CHECKOUT') {
      state.checkoutData = data;
      payAmount.textContent = `$${data.amount}`;
      // Tell parent height
      notifyResize();
    }
  });

  function notifyResize() {
    // Small delay to let animations/DOM settle
    setTimeout(() => {
      const height = appContainer.offsetHeight;
      window.parent.postMessage({ type: 'RESIZE_IFRAME', data: { height } }, '*');
    }, 50);
  }

  // --- Navigation & Transitions ---
  function navigateTo(viewId, direction = 'forward') {
    const oldView = views[state.currentView];
    const newView = views[viewId];

    if (oldView) {
      oldView.classList.remove('active');
      oldView.classList.add(direction === 'forward' ? 'exit-left' : 'exit-right');
    }

    // Clean up entrance classes from new view
    newView.classList.remove('exit-left', 'exit-right');
    newView.classList.add('active');

    state.currentView = viewId;
    notifyResize();
  }

  function showError(msg) {
    alert(msg); // In a real app, use a nice inline toast
    notifyResize();
  }

  // --- 0. Conditional Passkey Autofill ---
  async function initConditionalPasskey() {
    try {
      const optRes = await fetch('/api/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // no email for conditional
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
        state.email = verData.user.email;
        state.hasPasskey = true;

        emailLoading.style.display = 'none';
        emailBtn.disabled = false;

        setupPaymentView();
        navigateTo('view-payment');
      }
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        console.error('Conditional Passkey Error:', err);
      }
    }
  }

  // Kick off the conditional UI listener immediately
  initConditionalPasskey();

  // --- 1. Email Flow ---
  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.email = emailInput.value.trim();
    if (!state.email) return;

    emailBtn.disabled = true;
    emailLoading.style.display = 'flex';

    try {
      // Check user existence and passkey status
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email })
      });
      const data = await res.json();

      state.hasPasskey = data.hasPasskey;

      if (data.exists && state.hasPasskey) {
        // Known user WITH passkey -> Trigger Biometrics immediately
        emailLoading.style.display = 'none';
        emailBtn.disabled = false;
        await triggerPasskeyLogin();
      } else {
        // Unknown user OR known without passkey -> Send OTP
        await fetch('/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: state.email })
        });

        displayOtpEmail.textContent = state.email;
        emailLoading.style.display = 'none';
        emailBtn.disabled = false;

        navigateTo('view-otp', 'forward');
        setTimeout(() => otpInput.focus(), 300);
      }
    } catch (err) {
      console.error(err);
      showError('Network error checking email.');
      emailLoading.style.display = 'none';
      emailBtn.disabled = false;
    }
  });

  // --- 2. OTP flow ---
  document.getElementById('back-to-email-btn').addEventListener('click', () => {
    navigateTo('view-email', 'backward');
  });

  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Strip any non-digit characters (like spaces added by auto-formatting)
    const otp = otpInput.value.replace(/\D/g, '');
    if (otp.length !== 6) return;

    const btn = document.getElementById('verify-otp-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email, otp })
      });

      if (!res.ok) throw new Error('Invalid OTP');

      const data = await res.json();
      state.user = data.user;

      if (state.hasPasskey) {
        // Fallback login succeeded, go straight to payment
        setupPaymentView();
        navigateTo('view-payment');
      } else {
        // No passkey exists on account, prompt to register
        navigateTo('view-register-passkey');
      }

    } catch (err) {
      showError('Invalid code. Check server console for mock email.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify Code';
    }
  });

  // --- 3. Passkey Registration (Post OTP) ---
  skipBtn.addEventListener('click', () => {
    setupPaymentView();
    navigateTo('view-payment');
  });

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    registerBtn.textContent = 'Follow browser prompts...';

    try {
      // 1. Get options
      const optRes = await fetch('/api/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email, displayName: state.user.displayName })
      });
      const options = await optRes.json();

      // 2. Client ceremony
      const attResp = await startRegistration(options);

      // 3. Verify on server
      const verRes = await fetch('/api/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email, response: attResp })
      });

      if (verRes.ok) {
        state.hasPasskey = true;
        setupPaymentView();
        navigateTo('view-payment');
      } else {
        throw new Error('Registration verification failed');
      }
    } catch (err) {
      console.error(err);
      if (err.name === 'NotAllowedError') {
        showError('Passkey registration cancelled.');
        setupPaymentView();
        navigateTo('view-payment');
      } else {
        showError('Failed to register passkey.');
      }
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'Save Passkey';
    }
  });

  // --- Passkey Login ---
  async function triggerPasskeyLogin() {
    try {
      // 1. Get options
      const optRes = await fetch('/api/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email })
      });
      const data = await optRes.json();

      // 2. Client ceremony
      const asseResp = await startAuthentication(data.options);

      // 3. Verify
      const verRes = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email, sessionId: data.sessionId, response: asseResp })
      });

      if (verRes.ok) {
        const data = await verRes.json();
        state.user = data.user;
        setupPaymentView();
        navigateTo('view-payment');
      } else {
        throw new Error('Login failed');
      }
    } catch (err) {
      console.error(err);
      if (err.name === 'NotAllowedError') {
        // They cancelled the passkey prompt. Fallback to OTP.
        await fetch('/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: state.email })
        });
        displayOtpEmail.textContent = state.email;
        navigateTo('view-otp', 'forward');
      } else {
        showError('Authentication failed.');
      }
    }
  }

  // --- 4. Payment View ---
  function setupPaymentView() {
    displayPaymentEmail.textContent = state.email;
    userAvatar.textContent = state.user.displayName.charAt(0).toUpperCase();

    if (!state.user.cards || state.user.cards.length === 0) {
      cardList.innerHTML = '<p>No cards saved.</p>';
      payBtn.disabled = true;
      return;
    }

    // Default to first card
    state.selectedCardId = state.user.cards[0].id;

    renderCards();
  }

  function renderCards() {
    cardList.innerHTML = state.user.cards.map(card => `
      <div class="card-item ${card.id === state.selectedCardId ? 'selected' : ''}" data-id="${card.id}">
        <div class="card-icon" style="background: linear-gradient(135deg, ${card.color1}, ${card.color2})"></div>
        <div class="card-details">
          <span class="card-brand">${card.brand}</span>
          <span class="card-last4">•••• ${card.last4}</span>
        </div>
        <div class="radio-circle"></div>
      </div>
    `).join('');

    document.querySelectorAll('.card-item').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedCardId = el.dataset.id;
        renderCards();
      });
    });

    notifyResize();
  }

  logoutBtn.addEventListener('click', () => {
    state.email = '';
    state.user = null;
    emailInput.value = '';
    navigateTo('view-email', 'backward');
  });

  // --- 5. Payment Processing ---
  payBtn.addEventListener('click', async () => {
    if (!state.selectedCardId) return;

    navigateTo('view-processing');

    try {
      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: state.email,
          cardId: state.selectedCardId,
          amount: state.checkoutData.amount
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        processingText.textContent = 'Success!';
        document.querySelector('.spinner-large').style.borderColor = 'var(--success)';

        // Brief pause to show success checkmark before messaging parent
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
  });

});
