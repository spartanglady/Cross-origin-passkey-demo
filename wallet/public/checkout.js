const WALLET_API = ''; // Same origin, relative URLs

// Merchant origin: auto-detect for local dev, or accept postMessage from any origin
// In production, the merchant origin is validated per-message
function getMerchantOrigin() {
  const host = window.location.hostname;
  if (host === 'wallet.demo') return 'http://merchant.demo:3000';
  if (host === 'localhost') return 'http://localhost:3000';
  // On Vercel or other deployments, we accept the first INIT_CHECKOUT message origin
  return null; // Will be set dynamically
}

let MERCHANT_ORIGIN = getMerchantOrigin();

let currentEmail = '';
let currentUser = null;
let selectedCardId = null;
let checkoutData = null;

// ============================================================
// Step Navigation
// ============================================================

function showStep(stepId) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const step = document.getElementById(stepId);
  if (step) {
    step.classList.add('active');
    // Re-trigger animation by removing and re-adding
    step.style.animation = 'none';
    step.offsetHeight; // Force reflow
    step.style.animation = '';
  }
}

// ============================================================
// PostMessage Communication
// ============================================================

function sendToMerchant(type, data = {}) {
  if (window.parent !== window) {
    const target = MERCHANT_ORIGIN || '*';
    window.parent.postMessage({ type, data }, target);
  }
}

window.addEventListener('message', (event) => {
  // On first message, lock in the merchant origin
  if (!MERCHANT_ORIGIN && event.data && event.data.type === 'INIT_CHECKOUT') {
    MERCHANT_ORIGIN = event.origin;
  }

  // Validate origin if we have one set
  if (MERCHANT_ORIGIN && event.origin !== MERCHANT_ORIGIN) return;

  const { type, data } = event.data;

  if (type === 'INIT_CHECKOUT') {
    checkoutData = data;
    // Update payment amount displays
    document.querySelectorAll('.checkout-amount').forEach(el => {
      el.textContent = `$${parseFloat(data.amount).toFixed(2)}`;
    });
    const payBtn = document.getElementById('pay-btn');
    if (payBtn) {
      payBtn.textContent = `Pay $${parseFloat(data.amount).toFixed(2)}`;
    }
    const paymentAmount = document.getElementById('payment-amount');
    if (paymentAmount) {
      paymentAmount.textContent = `$${parseFloat(data.amount).toFixed(2)}`;
    }
  }
});

// Notify parent we're ready
window.addEventListener('load', () => {
  sendToMerchant('WALLET_READY');
});

// ============================================================
// Email Lookup
// ============================================================

async function lookupEmail() {
  const emailInput = document.getElementById('email-input');
  const submitBtn = document.getElementById('email-submit-btn');
  const loading = document.getElementById('email-loading');
  const errorEl = document.getElementById('email-error');

  const email = emailInput.value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    errorEl.textContent = 'Please enter a valid email address';
    errorEl.style.display = 'block';
    return;
  }

  currentEmail = email;
  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.classList.add('loading');
  submitBtn.innerHTML = '<span class="spinner"></span>';

  try {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (data.exists) {
      // Existing user - show auth step
      showAuthStep(data.displayName);
    } else {
      // New user - show registration step
      showStep('step-register');
      // Pre-fill email chip
      document.querySelectorAll('.email-chip').forEach(el => {
        el.textContent = email;
      });
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
    submitBtn.textContent = 'Continue';
  }
}

function showAuthStep(displayName) {
  const avatar = document.getElementById('user-avatar');
  const welcomeName = document.getElementById('welcome-name');

  if (avatar) {
    avatar.textContent = displayName.charAt(0).toUpperCase();
  }
  if (welcomeName) {
    welcomeName.textContent = `Welcome back, ${displayName}!`;
  }

  // Show email below welcome
  const authEmail = document.querySelector('#step-auth .email-chip');
  if (authEmail) authEmail.textContent = currentEmail;

  showStep('step-auth');
}

// ============================================================
// Passkey Registration
// ============================================================

async function registerPasskey() {
  const nameInput = document.getElementById('name-input');
  const registerBtn = document.getElementById('register-btn');
  const statusEl = document.getElementById('register-status');

  const displayName = nameInput.value.trim();
  if (!displayName) {
    statusEl.textContent = 'Please enter your name';
    statusEl.style.display = 'block';
    statusEl.style.color = '#ef4444';
    return;
  }

  registerBtn.disabled = true;
  registerBtn.classList.add('loading');
  registerBtn.innerHTML = '<span class="spinner"></span> Creating passkey...';
  statusEl.style.display = 'none';

  try {
    // Step 1: Get registration options from server
    const optionsRes = await fetch('/api/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, displayName }),
    });

    if (!optionsRes.ok) {
      const err = await optionsRes.json();
      throw new Error(err.error || 'Failed to get registration options');
    }

    const options = await optionsRes.json();

    // Step 2: Start WebAuthn registration (browser prompt)
    statusEl.textContent = 'Complete the biometric prompt...';
    statusEl.style.display = 'block';
    statusEl.style.color = '#667eea';

    const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

    // Step 3: Verify with server
    statusEl.textContent = 'Verifying...';

    const verifyRes = await fetch('/api/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, response: credential }),
    });

    const verifyData = await verifyRes.json();

    if (verifyData.verified) {
      currentUser = verifyData.user;
      // Show success briefly then move to cards
      statusEl.textContent = 'Account created!';
      statusEl.style.color = '#10b981';

      setTimeout(() => {
        showCardSelection(currentUser.cards);
      }, 800);
    } else {
      throw new Error(verifyData.error || 'Registration verification failed');
    }
  } catch (err) {
    console.error('Registration error:', err);
    if (err.name === 'NotAllowedError') {
      statusEl.textContent = 'Passkey creation was cancelled. Please try again.';
    } else {
      statusEl.textContent = err.message || 'Registration failed. Please try again.';
    }
    statusEl.style.display = 'block';
    statusEl.style.color = '#ef4444';
    registerBtn.disabled = false;
    registerBtn.classList.remove('loading');
    registerBtn.innerHTML = '🔐 Register with Passkey';
  }
}

// ============================================================
// Passkey Authentication
// ============================================================

async function authenticatePasskey() {
  const loginBtn = document.getElementById('login-btn');
  const statusEl = document.getElementById('auth-status');

  loginBtn.disabled = true;
  loginBtn.classList.add('loading');
  loginBtn.innerHTML = '<span class="spinner"></span> Authenticating...';
  statusEl.style.display = 'none';

  try {
    // Step 1: Get authentication options
    const optionsRes = await fetch('/api/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail }),
    });

    if (!optionsRes.ok) {
      const err = await optionsRes.json();
      throw new Error(err.error || 'Failed to get login options');
    }

    const options = await optionsRes.json();

    // Step 2: Start WebAuthn authentication (browser prompt)
    statusEl.textContent = 'Complete the biometric prompt...';
    statusEl.style.display = 'block';
    statusEl.style.color = '#667eea';

    const credential = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

    // Step 3: Verify with server
    statusEl.textContent = 'Verifying...';

    const verifyRes = await fetch('/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, response: credential }),
    });

    const verifyData = await verifyRes.json();

    if (verifyData.verified) {
      currentUser = verifyData.user;
      statusEl.textContent = 'Authenticated!';
      statusEl.style.color = '#10b981';

      setTimeout(() => {
        showCardSelection(currentUser.cards);
      }, 600);
    } else {
      throw new Error(verifyData.error || 'Authentication failed');
    }
  } catch (err) {
    console.error('Auth error:', err);
    if (err.name === 'NotAllowedError') {
      statusEl.textContent = 'Authentication was cancelled. Please try again.';
    } else {
      statusEl.textContent = err.message || 'Authentication failed. Please try again.';
    }
    statusEl.style.display = 'block';
    statusEl.style.color = '#ef4444';
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    loginBtn.innerHTML = '🔐 Sign in with Passkey';
  }
}

// ============================================================
// Card Selection
// ============================================================

function showCardSelection(cards) {
  const carousel = document.getElementById('card-carousel');
  const dotsContainer = document.querySelector('.card-dots');

  // Clear existing
  carousel.innerHTML = '';
  if (dotsContainer) dotsContainer.innerHTML = '';

  cards.forEach((card, index) => {
    // Create card element
    const cardEl = document.createElement('div');
    cardEl.className = 'payment-card';
    cardEl.dataset.cardId = card.id;
    cardEl.style.background = `linear-gradient(135deg, ${card.color1}, ${card.color2})`;

    cardEl.innerHTML = `
      <div class="payment-card-brand">${card.brand}</div>
      <div class="payment-card-number">•••• •••• •••• ${card.last4}</div>
      <div class="payment-card-details">
        <span>${currentUser.displayName || 'Cardholder'}</span>
        <span>${card.expiry}</span>
      </div>
    `;

    cardEl.addEventListener('click', () => selectCard(card.id));
    carousel.appendChild(cardEl);

    // Create dot
    if (dotsContainer) {
      const dot = document.createElement('div');
      dot.className = 'card-dot' + (index === 0 ? ' active' : '');
      dotsContainer.appendChild(dot);
    }
  });

  // Update amount on pay button
  if (checkoutData) {
    const payBtn = document.getElementById('pay-btn');
    if (payBtn) {
      payBtn.textContent = `Pay $${parseFloat(checkoutData.amount).toFixed(2)}`;
    }
    const paymentAmount = document.getElementById('payment-amount');
    if (paymentAmount) {
      paymentAmount.textContent = `$${parseFloat(checkoutData.amount).toFixed(2)}`;
    }
  }

  // Scroll listener for dot indicators
  carousel.addEventListener('scroll', () => {
    const scrollLeft = carousel.scrollLeft;
    const cardWidth = 296; // card width + gap
    const activeIndex = Math.round(scrollLeft / cardWidth);
    document.querySelectorAll('.card-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === activeIndex);
    });
  });

  showStep('step-cards');
}

function selectCard(cardId) {
  selectedCardId = cardId;

  // Update card visual selection
  document.querySelectorAll('.payment-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.cardId === cardId);
  });

  // Enable pay button
  const payBtn = document.getElementById('pay-btn');
  if (payBtn) payBtn.disabled = false;
}

// ============================================================
// Payment Processing
// ============================================================

async function processPayment() {
  if (!selectedCardId || !checkoutData) return;

  const payBtn = document.getElementById('pay-btn');
  const processingOverlay = document.getElementById('processing-overlay');

  payBtn.disabled = true;
  payBtn.classList.add('loading');
  payBtn.innerHTML = '<span class="spinner"></span> Processing...';

  // Show processing overlay
  if (processingOverlay) processingOverlay.style.display = 'flex';

  try {
    // Simulate slight delay for realism
    await new Promise(resolve => setTimeout(resolve, 1500));

    const res = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: currentEmail,
        cardId: selectedCardId,
        amount: checkoutData.amount,
      }),
    });

    const result = await res.json();

    if (result.success) {
      // Hide processing overlay
      if (processingOverlay) processingOverlay.style.display = 'none';

      // Show success step
      document.getElementById('success-txn-id').textContent = result.transactionId;
      document.getElementById('success-amount').textContent = `$${parseFloat(result.amount).toFixed(2)}`;
      document.getElementById('success-card').textContent = `${result.cardBrand} •••• ${result.last4}`;

      showStep('step-success');

      // Notify merchant
      sendToMerchant('PAYMENT_COMPLETE', {
        transactionId: result.transactionId,
        last4: result.last4,
        cardBrand: result.cardBrand,
        amount: result.amount,
      });
    } else {
      throw new Error('Payment failed');
    }
  } catch (err) {
    console.error('Payment error:', err);
    if (processingOverlay) processingOverlay.style.display = 'none';
    payBtn.disabled = false;
    payBtn.classList.remove('loading');
    payBtn.textContent = `Pay $${parseFloat(checkoutData.amount).toFixed(2)}`;
    alert('Payment failed. Please try again.');
  }
}

// ============================================================
// Event Listeners
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // Email step
  const emailInput = document.getElementById('email-input');
  const emailSubmitBtn = document.getElementById('email-submit-btn');

  emailSubmitBtn.addEventListener('click', lookupEmail);
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookupEmail();
  });
  emailInput.addEventListener('input', () => {
    emailSubmitBtn.disabled = !emailInput.value.trim();
  });

  // Registration step
  document.getElementById('register-btn').addEventListener('click', registerPasskey);
  document.getElementById('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') registerPasskey();
  });

  // Authentication step
  document.getElementById('login-btn').addEventListener('click', authenticatePasskey);

  // Switch email link
  document.getElementById('switch-email').addEventListener('click', (e) => {
    e.preventDefault();
    currentEmail = '';
    currentUser = null;
    document.getElementById('email-input').value = '';
    showStep('step-email');
  });

  // Back buttons
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showStep('step-email');
    });
  });

  // Pay button
  document.getElementById('pay-btn').addEventListener('click', processPayment);

  // Done button (after success)
  document.getElementById('done-btn').addEventListener('click', () => {
    sendToMerchant('CHECKOUT_CANCELLED'); // Signals merchant to close the iframe
  });

  // Show initial step
  showStep('step-email');
});
