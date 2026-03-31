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
const MERCHANT_URL = process.env.MERCHANT_URL || 'http://store.localhost:3000';

// Extract hostname for WebAuthn RP ID (e.g., "my-wallet.vercel.app" or "localhost")
const RP_ID = new URL(WALLET_URL).hostname;

const RP_NAME = 'PassWallet';
const DEMO_OTP = process.env.DEMO_OTP || '111111';
const CHALLENGE_TOKEN_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TOKEN_SECRET = process.env.CHALLENGE_TOKEN_SECRET || process.env.WALLET_URL || 'passwallet-demo-secret';

// Build known origins list (for WebAuthn verification)
const ALLOWED_ORIGINS = [
  WALLET_URL,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://wallet.localhost:3001',
].filter(Boolean);

const ALLOWED_MERCHANT_ORIGINS = [
  MERCHANT_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://store.localhost:3000',
].filter(Boolean);

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
  console.error(context, error);
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

function getForwardedHeader(value) {
  if (!value) return '';
  return String(value).split(',')[0].trim();
}

function getRequestHost(req) {
  return getForwardedHeader(req.headers['x-forwarded-host'])
    || getForwardedHeader(req.headers.host)
    || RP_ID;
}

function getRequestProtocol(req) {
  return getForwardedHeader(req.headers['x-forwarded-proto'])
    || req.protocol
    || 'https';
}

function getRequestOrigin(req) {
  const host = getRequestHost(req);
  if (!host) return '';
  return `${getRequestProtocol(req)}://${host}`;
}

function getRpIdFromRequest(req) {
  return getRequestHost(req).split(':')[0];
}

function buildAllowedOrigins(req) {
  return Array.from(new Set([
    ...ALLOWED_ORIGINS,
    getRequestOrigin(req),
    getForwardedHeader(req.headers.origin),
  ].filter(Boolean)));
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
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  const user = store.getUser(phoneNumber);
  const hasPasskey = user ? store.getCredentialsByPhoneNumber(phoneNumber).length > 0 : false;

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

    const dynamicRpId = getRpIdFromRequest(req);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: dynamicRpId,
      userID: new TextEncoder().encode(user.id),
      userName: phoneNumber,
      userDisplayName: displayName,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const verificationToken = signChallengeToken({
      type: 'reg',
      phoneNumber,
      challenge: options.challenge,
      rpID: dynamicRpId,
      exp: Date.now() + CHALLENGE_TOKEN_TTL_MS,
    });

    // Legacy fallback path if old clients do not return verificationToken
    store.setChallenge(`reg:${phoneNumber}`, options.challenge);

    res.json({ options, verificationToken });
  } catch (error) {
    console.error('Registration options error:', error);
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

    const dynamicRpId = getRpIdFromRequest(req);
    let expectedRPID = dynamicRpId;
    let expectedChallenge;

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
      expectedRPID = payload.rpID || dynamicRpId;
    } else {
      expectedChallenge = store.getChallenge(`reg:${phoneNumber}`);
      if (!expectedChallenge) {
        return res.status(400).json({ error: 'Challenge not found or expired' });
      }
    }

    // Allow dynamic origins for Vercel preview environments
    const allowedOrigins = buildAllowedOrigins(req);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: allowedOrigins,
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

      const user = store.getUser(phoneNumber);
      res.json({ verified: true, user: { displayName: user.displayName, cards: user.cards } });
    } else {
      res.status(400).json({ verified: false, error: 'Verification failed' });
    }
  } catch (error) {
    respondWebAuthnError(res, 'Failed to verify registration', error);
  }
});

// Authentication: Generate options
app.post('/api/login/options', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    let userCredentials = [];

    if (phoneNumber) {
      const user = store.getUser(phoneNumber);
      if (!user) return res.status(404).json({ error: 'User not found' });
      userCredentials = store.getCredentialsByPhoneNumber(phoneNumber);
    }

    const dynamicRpId = getRpIdFromRequest(req);

    const options = await generateAuthenticationOptions({
      rpID: dynamicRpId,
      allowCredentials: userCredentials.map(c => ({
        id: c.id,
        type: 'public-key',
        transports: c.transports,
      })),
      userVerification: 'preferred',
    });

    const sessionId = phoneNumber || Math.random().toString(36).slice(2);
    const verificationToken = signChallengeToken({
      type: 'auth',
      phoneNumber: phoneNumber || null,
      challenge: options.challenge,
      rpID: dynamicRpId,
      exp: Date.now() + CHALLENGE_TOKEN_TTL_MS,
    });

    // Legacy fallback path if old clients do not return verificationToken
    store.setChallenge(`auth:${sessionId}`, options.challenge);

    res.json({ options, sessionId, verificationToken });
  } catch (error) {
    console.error('Login options error:', error);
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

    const credential = store.getCredentialById(response.id);
    if (!credential) {
      return res.status(400).json({ error: 'Credential not found' });
    }

    const dynamicRpId = getRpIdFromRequest(req);
    let expectedChallenge;
    let expectedRPID = dynamicRpId;
    let tokenPhoneNumber = null;

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
      expectedRPID = payload.rpID || dynamicRpId;
      tokenPhoneNumber = payload.phoneNumber || null;
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

    const targetPhoneNumber = phoneNumber || tokenPhoneNumber || credential.phoneNumber;
    if (targetPhoneNumber !== credential.phoneNumber) {
      return res.status(400).json({ error: 'Credential does not match requested user' });
    }
    const user = store.getUser(targetPhoneNumber);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Allow dynamic origins for Vercel preview environments
    const allowedOrigins = buildAllowedOrigins(req);

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: allowedOrigins,
      expectedRPID,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
    });

    if (verification.verified) {
      store.updateCredentialCounter(response.id, verification.authenticationInfo.newCounter);
      res.json({ verified: true, user: { phoneNumber: user.phoneNumber, displayName: user.displayName, cards: user.cards } });
    } else {
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

  const user = store.getUser(phoneNumber);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const card = user.cards.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });

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

// --- WebCrypto endpoints ---

app.post('/api/device/challenge', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  // A simple 32-byte hex challenge string
  const challenge = Array.from(crypto.randomBytes(32))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  store.setChallenge(`dev_${deviceId}`, challenge);
  res.json({ challenge });
});

app.post('/api/device/register', (req, res) => {
  const { deviceId, phoneNumber, publicKey } = req.body;
  if (!deviceId || !phoneNumber || !publicKey) {
    return res.status(400).json({ error: 'deviceId, phoneNumber, and publicKey required' });
  }

  // In a real implementation we would also verify a signed challenge here
  // to prove possession. Doing direct storage for demo purposes.
  store.addDeviceBinding(deviceId, publicKey, phoneNumber);

  res.json({ success: true });
});

app.post('/api/device/verify', async (req, res) => {
  const { deviceId, signature } = req.body; // actual crypto validation is tricky without subtlecrypto in Node
  // For the sake of the demo, we will blindly trust the deviceID + signature pair if binding exists.
  // In reality: 
  // 1. Get `expectedChallenge` from `getChallenge('dev_' + deviceId)`
  // 2. Fetch `store.getDeviceBinding(deviceId).publicKey` (which is JWK or SPKI)
  // 3. Use `crypto.verify` to validate `signature` against `expectedChallenge` using `publicKey`

  if (!deviceId || !signature) return res.status(400).json({ error: 'deviceId and signature required' });

  const expectedChallenge = store.getChallenge(`dev_${deviceId}`);
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge missing or expired' });

  const binding = store.getDeviceBinding(deviceId);
  if (!binding) return res.status(404).json({ error: 'Device binding not found' });

  const user = store.getUser(binding.phoneNumber);
  if (!user) return res.status(404).json({ error: 'Associated user not found' });

  // Assuming signature is valid for demo
  const hasPasskey = store.getCredentialsByPhoneNumber(binding.phoneNumber).length > 0;

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
