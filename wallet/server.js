const express = require('express');
const cors = require('cors');
const path = require('path');
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
const WALLET_URL = process.env.WALLET_URL || `http://wallet.localhost:${PORT}`;
const MERCHANT_URL = process.env.MERCHANT_URL || 'http://store.localhost:3000';

// Extract hostname for WebAuthn RP ID (e.g., "my-wallet.vercel.app" or "localhost")
const RP_ID = new URL(WALLET_URL).hostname;

const RP_NAME = 'PassWallet';
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

// Middleware
app.use(express.json());
app.use(cors({
  origin: [...ALLOWED_ORIGINS, ...ALLOWED_MERCHANT_ORIGINS],
  credentials: true,
}));

// Set Permissions-Policy header for cross-origin passkey support
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'publickey-credentials-get=(*), publickey-credentials-create=(*)');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Email lookup
app.post('/api/lookup', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const user = store.getUser(email);
  const hasPasskey = user ? store.getCredentialsByEmail(email).length > 0 : false;

  if (user) {
    res.json({ exists: true, hasPasskey, displayName: user.displayName });
  } else {
    res.json({ exists: false, hasPasskey: false });
  }
});

// Send OTP
app.post('/api/auth/otp/send', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Generate a mock 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  store.setOTP(email, otp);

  // Simulated email delivery
  console.log(`\n=============================================`);
  console.log(`✉️ MOCK EMAIL TO: ${email}`);
  console.log(`🔑 PassWallet Login Code: ${otp}`);
  console.log(`=============================================\n`);

  res.json({ success: true, message: 'OTP sent to email simulator' });
});

// Verify OTP
app.post('/api/auth/otp/verify', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  const storedOtp = store.getOTP(email);
  if (!storedOtp || storedOtp !== otp) {
    return res.status(401).json({ error: 'Invalid or expired OTP' });
  }

  // OTP Valid
  store.clearOTP(email);

  let user = store.getUser(email);
  if (!user) {
    // Implicit registration on first successful OTP
    user = store.createUser(email, email.split('@')[0]);
  }

  res.json({
    verified: true,
    user: { displayName: user.displayName, cards: user.cards }
  });
});

// Registration: Generate options
app.post('/api/register/options', async (req, res) => {
  try {
    const { email, displayName } = req.body;
    if (!email || !displayName) {
      return res.status(400).json({ error: 'Email and displayName required' });
    }

    // Check if user already exists
    let user = store.getUser(email);
    if (!user) {
      // Create user
      user = store.createUser(email, displayName);
    }

    const existingCredentials = store.getCredentialsByEmail(email);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(user.id),
      userName: email,
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

    // Store challenge for verification
    store.setChallenge(email, options.challenge);

    res.json(options);
  } catch (error) {
    console.error('Registration options error:', error);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// Registration: Verify response
app.post('/api/register/verify', async (req, res) => {
  try {
    const { email, response } = req.body;
    if (!email || !response) {
      return res.status(400).json({ error: 'Email and response required' });
    }

    const expectedChallenge = store.getChallenge(email);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Challenge not found or expired' });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential } = verification.registrationInfo;

      store.addCredential(email, {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: response.response.transports || [],
      });

      const user = store.getUser(email);
      res.json({ verified: true, user: { displayName: user.displayName, cards: user.cards } });
    } else {
      res.status(400).json({ verified: false, error: 'Verification failed' });
    }
  } catch (error) {
    console.error('Registration verify error:', error);
    res.status(500).json({ error: 'Failed to verify registration' });
  }
});

// Authentication: Generate options
app.post('/api/login/options', async (req, res) => {
  try {
    const { email } = req.body || {};
    let userCredentials = [];

    if (email) {
      const user = store.getUser(email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      userCredentials = store.getCredentialsByEmail(email);
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: userCredentials.map(c => ({
        id: c.id,
        type: 'public-key',
        transports: c.transports,
      })),
      userVerification: 'preferred',
    });

    const sessionId = email || Math.random().toString(36).slice(2);
    store.setChallenge(sessionId, options.challenge);

    res.json({ options, sessionId });
  } catch (error) {
    console.error('Login options error:', error);
    res.status(500).json({ error: 'Failed to generate authentication options' });
  }
});

// Authentication: Verify response
app.post('/api/login/verify', async (req, res) => {
  try {
    const { email, sessionId, response } = req.body;
    if (!response) {
      return res.status(400).json({ error: 'Response required' });
    }

    const lookupKey = email || sessionId;
    const expectedChallenge = store.getChallenge(lookupKey);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Challenge not found or expired' });
    }

    const credential = store.getCredentialById(response.id);
    if (!credential) {
      return res.status(400).json({ error: 'Credential not found' });
    }

    const targetEmail = email || credential.email;
    const user = store.getUser(targetEmail);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
    });

    if (verification.verified) {
      store.updateCredentialCounter(response.id, verification.authenticationInfo.newCounter);
      res.json({ verified: true, user: { email: user.email, displayName: user.displayName, cards: user.cards } });
    } else {
      res.status(400).json({ verified: false, error: 'Authentication failed' });
    }
  } catch (error) {
    console.error('Login verify error:', error);
    res.status(500).json({ error: 'Failed to verify authentication' });
  }
});

// Mock payment
app.post('/api/pay', (req, res) => {
  const { email, cardId, amount } = req.body;
  if (!email || !cardId || !amount) {
    return res.status(400).json({ error: 'email, cardId, and amount required' });
  }

  const user = store.getUser(email);
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PassWallet service running at ${WALLET_URL}`);
    console.log(`  Demo user: demo@example.com`);
  });
}

module.exports = app;
