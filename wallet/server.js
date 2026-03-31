const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const store = require('./store');

const app = express();
const PORT = 3001;

// For Vercel: use WALLET_URL env var to determine RP_ID, or fall back to .localhost tests
const VERCEL_WALLET_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const WALLET_URL = process.env.WALLET_URL || VERCEL_WALLET_URL || `http://wallet.localhost:${PORT}`;
const WALLET_URL_OBJ = new URL(WALLET_URL);

// Lock WebAuthn to wallet domain. Optional overrides allow explicit pinning.
const RP_ID = process.env.WEBAUTHN_RP_ID || WALLET_URL_OBJ.hostname;
const WALLET_ORIGIN = process.env.WEBAUTHN_ORIGIN
  ? new URL(process.env.WEBAUTHN_ORIGIN).origin
  : WALLET_URL_OBJ.origin;

const RP_NAME = 'PassWallet';
const DEMO_OTP = process.env.DEMO_OTP || '111111';
const CHALLENGE_TOKEN_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TOKEN_SECRET = process.env.CHALLENGE_TOKEN_SECRET || process.env.WALLET_URL || 'passwallet-demo-secret';

function maskPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  return `***${digits.slice(-4)}`;
}

function summarizeId(id) {
  const normalized = normalizeCredentialId(id);
  if (!normalized) return null;
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
}

function sanitizeLogValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > 400 ? `${value.slice(0, 400)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? value.stack.split('\n').slice(0, 3).join('\n') : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeLogValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 20)) {
      out[key] = sanitizeLogValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function logWalletEvent(level, event, details = {}) {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(`[PassWallet][${event}] ${JSON.stringify(sanitizeLogValue(details))}`);
}

function requestLogContext(req) {
  return {
    origin: req.get('origin') || null,
    referer: req.get('referer') || null,
    userAgent: req.get('user-agent') || null,
    forwardedFor: req.get('x-forwarded-for') || null,
  };
}

function serializeUserForToken(user) {
  if (!user) return null;
  return {
    id: user.id || null,
    phoneNumber: user.phoneNumber || null,
    displayName: user.displayName || null,
    cards: Array.isArray(user.cards) ? user.cards : [],
    createdAt: user.createdAt || null,
  };
}

function restoreUserFromToken(phoneNumber, tokenUser, reason) {
  let user = store.getUser(phoneNumber);
  if (user) return user;

  if (tokenUser && tokenUser.phoneNumber === phoneNumber) {
    user = store.saveUser({
      id: tokenUser.id || crypto.randomUUID(),
      phoneNumber,
      displayName: tokenUser.displayName || `User ${phoneNumber.slice(-4)}`,
      cards: Array.isArray(tokenUser.cards) ? tokenUser.cards : store.generateMockCards(2),
      createdAt: tokenUser.createdAt || new Date().toISOString(),
    });
    logWalletEvent('warn', 'user_restored_from_token', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      reason,
      cardCount: user.cards.length,
    });
    return user;
  }

  return null;
}

function restoreCredentialsFromHints(phoneNumber, credentialHints, reason) {
  if (!Array.isArray(credentialHints) || credentialHints.length === 0) {
    return store.getCredentialsByPhoneNumber(phoneNumber);
  }

  let restoredCount = 0;
  for (const hint of credentialHints) {
    if (!hint || hint.phoneNumber !== phoneNumber) continue;
    if (store.getCredentialById(hint.id)) continue;
    try {
      store.addCredential(phoneNumber, {
        id: hint.id,
        publicKey: Buffer.from(hint.publicKey, 'base64url'),
        counter: Number(hint.counter) || 0,
        transports: Array.isArray(hint.transports) ? hint.transports : [],
      });
      restoredCount += 1;
    } catch (_) {
      // Ignore malformed hint entries
    }
  }

  if (restoredCount > 0) {
    logWalletEvent('warn', 'credentials_restored_from_hints', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      reason,
      restoredCount,
    });
  }

  return store.getCredentialsByPhoneNumber(phoneNumber);
}

function normalizeCredentialId(id) {
  if (!id) return '';

  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (!trimmed) return '';

    try {
      const bytes = Buffer.from(trimmed, 'base64url');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Continue to next strategy
    }

    try {
      const bytes = Buffer.from(trimmed, 'base64');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Fall through
    }

    return trimmed;
  }

  if (Buffer.isBuffer(id) || id instanceof Uint8Array) {
    return Buffer.from(id).toString('base64url');
  }

  return '';
}

function normalizeCredentialPublicKey(publicKey) {
  if (!publicKey) return '';

  if (typeof publicKey === 'string') {
    const trimmed = publicKey.trim();
    if (!trimmed) return '';

    try {
      const bytes = Buffer.from(trimmed, 'base64url');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Continue to next strategy
    }

    try {
      const bytes = Buffer.from(trimmed, 'base64');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Fall through
    }

    return '';
  }

  if (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array) {
    return Buffer.from(publicKey).toString('base64url');
  }

  if (Array.isArray(publicKey)) {
    return Buffer.from(publicKey).toString('base64url');
  }

  if (
    typeof publicKey === 'object'
    && publicKey.type === 'Buffer'
    && Array.isArray(publicKey.data)
  ) {
    return Buffer.from(publicKey.data).toString('base64url');
  }

  return '';
}

function serializeCredentialForToken(credential) {
  if (!credential) return null;
  const id = normalizeCredentialId(credential.id);
  const publicKey = normalizeCredentialPublicKey(credential.publicKey);
  if (!id || !publicKey) return null;

  return {
    id,
    publicKey,
    counter: Number(credential.counter) || 0,
    transports: Array.isArray(credential.transports) ? credential.transports : [],
    phoneNumber: credential.phoneNumber || null,
  };
}

function deserializeCredentialFromToken(record) {
  if (!record || typeof record !== 'object') return null;
  const id = normalizeCredentialId(record.id);
  const publicKey = normalizeCredentialPublicKey(record.publicKey);
  if (!id || !publicKey) return null;

  return {
    id,
    publicKey: Buffer.from(publicKey, 'base64url'),
    counter: Number(record.counter) || 0,
    transports: Array.isArray(record.transports) ? record.transports : [],
    phoneNumber: record.phoneNumber || null,
  };
}

function signChallengeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', CHALLENGE_TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyChallengeToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Missing verification token' };
  }

  const [body, signature] = token.split('.');
  if (!body || !signature) {
    return { valid: false, error: 'Invalid verification token format' };
  }

  const expectedSignature = crypto.createHmac('sha256', CHALLENGE_TOKEN_SECRET).update(body).digest('base64url');
  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (
    sigBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return { valid: false, error: 'Invalid verification token signature' };
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') {
      return { valid: false, error: 'Invalid verification token payload' };
    }
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      return { valid: false, error: 'Verification token expired' };
    }
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: 'Invalid verification token payload' };
  }
}

function respondWebAuthnError(res, context, error) {
  logWalletEvent('error', 'webauthn_error', { context, error });
  const message = error && error.message ? error.message : context;
  const lower = String(message).toLowerCase();
  const isClientError = lower.includes('challenge')
    || lower.includes('origin')
    || lower.includes('rpid')
    || lower.includes('rp id')
    || lower.includes('credential')
    || lower.includes('counter')
    || lower.includes('json');

  if (isClientError) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: context });
}

// Middleware
app.use(express.json());
// CORS: dynamically reflect the requesting origin so deployed merchant
// frontends (Netlify, Vercel previews, custom domains) work without
// needing to enumerate every possible origin in an allowlist.
app.use(cors({
  origin: true,
  credentials: true,
}));

// Set Permissions-Policy header for cross-origin passkey support
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'publickey-credentials-get=(*), publickey-credentials-create=(*)');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Phone number lookup
app.post('/api/lookup', (req, res) => {
  const { phoneNumber, userHint, credentialHints } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  const userCredentials = restoreCredentialsFromHints(phoneNumber, credentialHints, 'lookup');
  const credentialCount = userCredentials.length;
  const hasPasskey = credentialCount > 0;
  let user = store.getUser(phoneNumber);
  if (!user && (hasPasskey || userHint?.phoneNumber === phoneNumber)) {
    user = restoreUserFromToken(phoneNumber, userHint, 'lookup')
      || store.createUser(phoneNumber, userHint?.displayName || `User ${phoneNumber.slice(-4)}`);
    logWalletEvent('warn', 'user_recreated_for_lookup', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      credentialCount,
    });
  }

  if (user) {
    res.json({ exists: true, hasPasskey, displayName: user.displayName });
  } else {
    res.json({ exists: false, hasPasskey: false });
  }
});

// Send OTP
app.post('/api/auth/otp/send', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  // Use static OTP for easier testing
  const otp = DEMO_OTP;
  store.setOTP(phoneNumber, otp);

  // Simulated SMS delivery
  console.log(`\n=============================================`);
  console.log(`📱 MOCK SMS TO: ${phoneNumber}`);
  console.log(`🔑 PassWallet Login Code: ${otp}`);
  console.log(`=============================================\n`);

  res.json({ success: true, message: 'OTP sent to SMS simulator' });
});

// Verify OTP
app.post('/api/auth/otp/verify', (req, res) => {
  const { phoneNumber, otp } = req.body;
  if (!phoneNumber || !otp) return res.status(400).json({ error: 'Phone number and OTP required' });

  // Serverless-safe demo behavior: accept the demo OTP even if this invocation
  // does not share in-memory state with the `/send` invocation.
  if (String(otp) !== DEMO_OTP) {
    return res.status(401).json({ error: 'Invalid OTP' });
  }

  const storedOtp = store.getOTP(phoneNumber);
  if (storedOtp) {
    store.clearOTP(phoneNumber);
  }

  let user = store.getUser(phoneNumber);
  if (!user) {
    // Implicit registration on first successful OTP
    user = store.createUser(phoneNumber, `User ${phoneNumber.slice(-4)}`);
  }

  logWalletEvent('info', 'otp_verify_success', {
    phoneNumber: maskPhoneNumber(phoneNumber),
    cardCount: Array.isArray(user.cards) ? user.cards.length : 0,
    request: requestLogContext(req),
  });

  res.json({
    verified: true,
    user: { displayName: user.displayName, cards: user.cards }
  });
});

// Registration: Generate options
app.post('/api/register/options', async (req, res) => {
  try {
    const { phoneNumber, displayName } = req.body;
    if (!phoneNumber || !displayName) {
      return res.status(400).json({ error: 'Phone number and displayName required' });
    }

    // Check if user already exists
    let user = store.getUser(phoneNumber);
    if (!user) {
      // Create user
      user = store.createUser(phoneNumber, displayName);
    }

    const existingCredentials = store.getCredentialsByPhoneNumber(phoneNumber);
    logWalletEvent('info', 'passkey_register_options', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      rpId: RP_ID,
      existingCredentialCount: existingCredentials.length,
      request: requestLogContext(req),
    });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(user.id),
      userName: phoneNumber,
      userDisplayName: displayName,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      },
    });

    const verificationToken = signChallengeToken({
      type: 'reg',
      phoneNumber,
      user: serializeUserForToken(user),
      challenge: options.challenge,
      exp: Date.now() + CHALLENGE_TOKEN_TTL_MS,
    });

    // Legacy fallback path if old clients do not return verificationToken
    store.setChallenge(`reg:${phoneNumber}`, options.challenge);

    res.json({ options, verificationToken });
  } catch (error) {
    logWalletEvent('error', 'passkey_register_options_error', { error, request: requestLogContext(req) });
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// Registration: Verify response
app.post('/api/register/verify', async (req, res) => {
  try {
    const { phoneNumber, response, verificationToken } = req.body;
    if (!phoneNumber || !response) {
      return res.status(400).json({ error: 'Phone number and response required' });
    }

    const expectedRPID = RP_ID;
    const expectedOrigin = WALLET_ORIGIN;
    let expectedChallenge;
    let tokenUser = null;

    logWalletEvent('info', 'passkey_register_verify_attempt', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      credentialId: summarizeId(response && response.id),
      expectedOrigin,
      expectedRPID,
      request: requestLogContext(req),
    });

    if (verificationToken) {
      const tokenResult = verifyChallengeToken(verificationToken);
      if (!tokenResult.valid) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const payload = tokenResult.payload;
      if (payload.type !== 'reg' || payload.phoneNumber !== phoneNumber) {
        return res.status(400).json({ error: 'Verification token does not match registration request' });
      }
      expectedChallenge = payload.challenge;
      tokenUser = payload.user || null;
    } else {
      expectedChallenge = store.getChallenge(`reg:${phoneNumber}`);
      if (!expectedChallenge) {
        return res.status(400).json({ error: 'Challenge not found or expired' });
      }
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential } = verification.registrationInfo;

      store.addCredential(phoneNumber, {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: response.response.transports || [],
      });
      const storedCredential = store.getCredentialById(credential.id);

      const user = restoreUserFromToken(phoneNumber, tokenUser, 'register_verify')
        || store.createUser(phoneNumber, tokenUser?.displayName || `User ${phoneNumber.slice(-4)}`);
      logWalletEvent('info', 'passkey_register_verify_success', {
        phoneNumber: maskPhoneNumber(phoneNumber),
        credentialId: summarizeId(credential.id),
        counter: credential.counter,
        transports: response.response.transports || [],
      });
      res.json({
        verified: true,
        user: { phoneNumber: user.phoneNumber, displayName: user.displayName, cards: user.cards },
        credentialRecord: serializeCredentialForToken(storedCredential),
      });
    } else {
      logWalletEvent('warn', 'passkey_register_verify_rejected', {
        phoneNumber: maskPhoneNumber(phoneNumber),
        credentialId: summarizeId(response && response.id),
      });
      res.status(400).json({ verified: false, error: 'Verification failed' });
    }
  } catch (error) {
    respondWebAuthnError(res, 'Failed to verify registration', error);
  }
});

// Authentication: Generate options
app.post('/api/login/options', async (req, res) => {
  try {
    const { phoneNumber, userHint, credentialHints } = req.body || {};
    let userCredentials = [];
    let hasPasskeys = false;
    let user = null;

    if (phoneNumber) {
      userCredentials = restoreCredentialsFromHints(phoneNumber, credentialHints, 'auth_options');
      hasPasskeys = userCredentials.length > 0;
      user = store.getUser(phoneNumber);
      if (!user && (hasPasskeys || userHint?.phoneNumber === phoneNumber)) {
        user = restoreUserFromToken(phoneNumber, userHint, 'auth_options')
          || store.createUser(phoneNumber, userHint?.displayName || `User ${phoneNumber.slice(-4)}`);
        logWalletEvent('warn', 'user_recreated_for_auth_options', {
          phoneNumber: maskPhoneNumber(phoneNumber),
          credentialCount: userCredentials.length,
        });
      }
      if (!user) return res.status(404).json({ error: 'User not found' });
    }

    const tokenCredentials = userCredentials
      .map(serializeCredentialForToken)
      .filter(Boolean);

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: userCredentials.map(c => ({
        id: c.id,
        type: 'public-key',
        transports: c.transports,
      })),
      userVerification: 'preferred',
    });

    // Let the browser surface a same-device passkey chooser for known users
    // instead of hinting a specific credential transport, which can push some
    // mobile browsers into hybrid/QR fallback.
    if (phoneNumber && hasPasskeys) {
      delete options.allowCredentials;
    }

    logWalletEvent('info', 'passkey_auth_options', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      rpId: RP_ID,
      hasPasskeys,
      credentialCount: userCredentials.length,
      allowCredentialsIncluded: Array.isArray(options.allowCredentials),
      request: requestLogContext(req),
    });

    const sessionId = phoneNumber || Math.random().toString(36).slice(2);
    const verificationToken = signChallengeToken({
      type: 'auth',
      phoneNumber: phoneNumber || null,
      user: phoneNumber ? serializeUserForToken(user || store.getUser(phoneNumber)) : null,
      challenge: options.challenge,
      credentials: tokenCredentials,
      exp: Date.now() + CHALLENGE_TOKEN_TTL_MS,
    });

    // Legacy fallback path if old clients do not return verificationToken
    store.setChallenge(`auth:${sessionId}`, options.challenge);

    res.json({ options, sessionId, verificationToken, hasPasskeys });
  } catch (error) {
    logWalletEvent('error', 'passkey_auth_options_error', { error, request: requestLogContext(req) });
    res.status(500).json({ error: 'Failed to generate authentication options' });
  }
});

// Authentication: Verify response
app.post('/api/login/verify', async (req, res) => {
  try {
    const { phoneNumber, sessionId, response, verificationToken } = req.body;
    if (!response) {
      return res.status(400).json({ error: 'Response required' });
    }

    let expectedChallenge;
    const expectedRPID = RP_ID;
    const expectedOrigin = WALLET_ORIGIN;
    let tokenPhoneNumber = null;
    let tokenCredentials = [];
    let tokenUser = null;

    logWalletEvent('info', 'passkey_auth_verify_attempt', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      sessionId: sessionId || null,
      credentialId: summarizeId(response && response.id),
      expectedOrigin,
      expectedRPID,
      request: requestLogContext(req),
    });

    if (verificationToken) {
      const tokenResult = verifyChallengeToken(verificationToken);
      if (!tokenResult.valid) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const payload = tokenResult.payload;
      if (payload.type !== 'auth') {
        return res.status(400).json({ error: 'Invalid authentication token type' });
      }
      expectedChallenge = payload.challenge;
      tokenPhoneNumber = payload.phoneNumber || null;
      tokenUser = payload.user || null;
      tokenCredentials = Array.isArray(payload.credentials)
        ? payload.credentials.map(deserializeCredentialFromToken).filter(Boolean)
        : [];
      if (phoneNumber && tokenPhoneNumber && phoneNumber !== tokenPhoneNumber) {
        return res.status(400).json({ error: 'Verification token does not match phone number' });
      }
    } else {
      const lookupKey = phoneNumber || sessionId;
      expectedChallenge = store.getChallenge(`auth:${lookupKey}`);
      if (!expectedChallenge) {
        return res.status(400).json({ error: 'Challenge not found or expired' });
      }
    }

    const responseCredentialId = normalizeCredentialId(response.id);
    let credential = store.getCredentialById(responseCredentialId || response.id);
    if (!credential && responseCredentialId && tokenCredentials.length > 0) {
      credential = tokenCredentials.find(c => c.id === responseCredentialId) || null;
    }
    if (!credential) {
      logWalletEvent('warn', 'passkey_auth_verify_missing_credential', {
        phoneNumber: maskPhoneNumber(phoneNumber || tokenPhoneNumber),
        credentialId: summarizeId(responseCredentialId || response.id),
        tokenCredentialCount: tokenCredentials.length,
      });
      return res.status(400).json({ error: 'Credential not found. Use OTP instead.' });
    }

    const targetPhoneNumber = phoneNumber || tokenPhoneNumber || credential.phoneNumber;
    if (targetPhoneNumber !== credential.phoneNumber) {
      return res.status(400).json({ error: 'Credential does not match requested user' });
    }
    const user = restoreUserFromToken(targetPhoneNumber, tokenUser, 'auth_verify');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
    });

    if (verification.verified) {
      store.updateCredentialCounter(responseCredentialId || response.id, verification.authenticationInfo.newCounter);
      logWalletEvent('info', 'passkey_auth_verify_success', {
        phoneNumber: maskPhoneNumber(targetPhoneNumber),
        credentialId: summarizeId(responseCredentialId || response.id),
        newCounter: verification.authenticationInfo.newCounter,
      });
      res.json({ verified: true, user: { phoneNumber: user.phoneNumber, displayName: user.displayName, cards: user.cards } });
    } else {
      logWalletEvent('warn', 'passkey_auth_verify_rejected', {
        phoneNumber: maskPhoneNumber(targetPhoneNumber),
        credentialId: summarizeId(responseCredentialId || response.id),
      });
      res.status(400).json({ verified: false, error: 'Authentication failed' });
    }
  } catch (error) {
    respondWebAuthnError(res, 'Failed to verify authentication', error);
  }
});

// Mock payment
app.post('/api/pay', (req, res) => {
  const { phoneNumber, cardId, amount } = req.body;
  if (!phoneNumber || !cardId || !amount) {
    return res.status(400).json({ error: 'phoneNumber, cardId, and amount required' });
  }

  let user = store.getUser(phoneNumber);
  if (!user) {
    user = store.createUser(phoneNumber, `User ${phoneNumber.slice(-4)}`);
    logWalletEvent('warn', 'user_recreated_for_payment', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      cardId,
    });
  }

  const card = user.cards.find(c => c.id === cardId);
  if (!card) {
    logWalletEvent('warn', 'payment_card_not_found', {
      phoneNumber: maskPhoneNumber(phoneNumber),
      cardId,
      knownCardIds: Array.isArray(user.cards) ? user.cards.map((entry) => entry.id) : [],
      request: requestLogContext(req),
    });
    return res.status(404).json({ error: 'Card not found' });
  }

  // Simulate payment processing
  const transactionId = 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

  res.json({
    success: true,
    transactionId,
    last4: card.last4,
    cardBrand: card.brand,
    amount,
  });
});

app.post('/api/client-log', (req, res) => {
  const {
    level = 'info',
    source = 'unknown',
    event = 'client_log',
    message = null,
    details = {},
    page = {},
    timestamp = null,
  } = req.body || {};

  logWalletEvent(level, `client:${source}:${event}`, {
    message,
    details,
    page,
    timestamp,
    request: requestLogContext(req),
  });

  res.json({ logged: true });
});

// --- WebCrypto endpoints ---

app.post('/api/device/challenge', (req, res) => {
  const { deviceId, phoneNumber } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  // A simple 32-byte hex challenge string
  const challenge = Array.from(crypto.randomBytes(32))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const verificationToken = signChallengeToken({
    type: 'device',
    deviceId,
    phoneNumber: phoneNumber || null,
    challenge,
    exp: Date.now() + CHALLENGE_TOKEN_TTL_MS,
  });

  store.setChallenge(`dev_${deviceId}`, challenge);
  logWalletEvent('info', 'device_challenge_created', {
    deviceId,
    phoneNumber: maskPhoneNumber(phoneNumber),
    request: requestLogContext(req),
  });
  res.json({ challenge, verificationToken });
});

app.post('/api/device/register', (req, res) => {
  const { deviceId, phoneNumber, publicKey } = req.body;
  if (!deviceId || !phoneNumber || !publicKey) {
    return res.status(400).json({ error: 'deviceId, phoneNumber, and publicKey required' });
  }

  // In a real implementation we would also verify a signed challenge here
  // to prove possession. Doing direct storage for demo purposes.
  store.addDeviceBinding(deviceId, publicKey, phoneNumber);
  store.createUser(phoneNumber, `User ${phoneNumber.slice(-4)}`);

  logWalletEvent('info', 'device_register_success', {
    deviceId,
    phoneNumber: maskPhoneNumber(phoneNumber),
    request: requestLogContext(req),
  });

  res.json({ success: true });
});

app.post('/api/device/verify', async (req, res) => {
  const {
    deviceId,
    signature,
    verificationToken,
    phoneNumber,
    publicKey,
    userHint,
    credentialHints,
  } = req.body || {}; // actual crypto validation is tricky without subtlecrypto in Node
  // For the sake of the demo, we will blindly trust the deviceID + signature pair if binding exists.
  // In reality: 
  // 1. Get `expectedChallenge` from `getChallenge('dev_' + deviceId)`
  // 2. Fetch `store.getDeviceBinding(deviceId).publicKey` (which is JWK or SPKI)
  // 3. Use `crypto.verify` to validate `signature` against `expectedChallenge` using `publicKey`

  if (!deviceId || !signature) return res.status(400).json({ error: 'deviceId and signature required' });

  let expectedChallenge;
  let tokenPhoneNumber = null;

  logWalletEvent('info', 'device_verify_attempt', {
    deviceId,
    phoneNumber: maskPhoneNumber(phoneNumber),
    hasPublicKeyHint: Boolean(publicKey),
    hasUserHint: Boolean(userHint),
    credentialHintCount: Array.isArray(credentialHints) ? credentialHints.length : 0,
    request: requestLogContext(req),
  });

  if (verificationToken) {
    const tokenResult = verifyChallengeToken(verificationToken);
    if (!tokenResult.valid) {
      return res.status(400).json({ error: tokenResult.error });
    }
    const payload = tokenResult.payload;
    if (payload.type !== 'device' || payload.deviceId !== deviceId) {
      return res.status(400).json({ error: 'Verification token does not match device challenge' });
    }
    expectedChallenge = payload.challenge;
    tokenPhoneNumber = payload.phoneNumber || null;
    if (phoneNumber && tokenPhoneNumber && phoneNumber !== tokenPhoneNumber) {
      return res.status(400).json({ error: 'Verification token does not match phone number' });
    }
  } else {
    expectedChallenge = store.getChallenge(`dev_${deviceId}`);
  }

  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge missing or expired' });

  let binding = store.getDeviceBinding(deviceId);
  const hintedPhoneNumber = phoneNumber || tokenPhoneNumber || userHint?.phoneNumber || null;
  if (!binding && hintedPhoneNumber && publicKey) {
    store.addDeviceBinding(deviceId, publicKey, hintedPhoneNumber);
    binding = store.getDeviceBinding(deviceId);
    logWalletEvent('warn', 'device_binding_restored_from_hints', {
      deviceId,
      phoneNumber: maskPhoneNumber(hintedPhoneNumber),
      request: requestLogContext(req),
    });
  }
  if (!binding) return res.status(404).json({ error: 'Device binding not found' });
  if (hintedPhoneNumber && binding.phoneNumber !== hintedPhoneNumber) {
    return res.status(400).json({ error: 'Device binding does not match requested user' });
  }

  let user = restoreUserFromToken(binding.phoneNumber, userHint, 'device_verify')
    || store.getUser(binding.phoneNumber);
  if (!user) {
    user = store.createUser(binding.phoneNumber, userHint?.displayName || `User ${binding.phoneNumber.slice(-4)}`);
    logWalletEvent('warn', 'user_recreated_for_device_verify', {
      deviceId,
      phoneNumber: maskPhoneNumber(binding.phoneNumber),
    });
  }

  // Assuming signature is valid for demo
  const hasPasskey = restoreCredentialsFromHints(binding.phoneNumber, credentialHints, 'device_verify').length > 0;

  logWalletEvent('info', 'device_verify_success', {
    deviceId,
    phoneNumber: maskPhoneNumber(binding.phoneNumber),
    hasPasskey,
    request: requestLogContext(req),
  });

  res.json({
    verified: true,
    hasPasskey,
    user: {
      phoneNumber: user.phoneNumber,
      displayName: user.displayName,
      cards: user.cards
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PassWallet service running at ${WALLET_URL}`);
    console.log(`  Demo user: 1234567890`);
  });
}

module.exports = app;
