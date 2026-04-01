const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const STORE_FILE = process.env.WALLET_STORE_FILE || path.join(os.tmpdir(), 'passwallet-demo-store.json');

// In-memory stores
const store = {
  users: new Map(), // phoneNumber -> User object
  credentials: new Map(), // credentialID (base64url) -> Credential object
  challenges: new Map(), // visitorId -> challenge (temporary, for WebAuthn ceremonies)
  otps: new Map(), // phoneNumber -> otp string
  devices: new Map(), // deviceId -> { publicKey, phoneNumber } (for WebCrypto possession binding)
};

function normalizeCredentialId(id) {
  if (!id) return '';

  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (!trimmed) return '';

    try {
      const bytes = Buffer.from(trimmed, 'base64url');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Continue to next decode strategy
    }

    try {
      const bytes = Buffer.from(trimmed, 'base64');
      if (bytes.length > 0) return bytes.toString('base64url');
    } catch (_) {
      // Use as-is as the last resort
    }

    return trimmed;
  }

  if (Buffer.isBuffer(id) || id instanceof Uint8Array) {
    return Buffer.from(id).toString('base64url');
  }

  return String(id);
}

// Card brands with their styles
const CARD_TEMPLATES = [
  { brand: 'Visa', color1: '#1a1f71', color2: '#2557d6', prefix: '4' },
  { brand: 'Mastercard', color1: '#eb001b', color2: '#f79e1b', prefix: '5' },
  { brand: 'Amex', color1: '#006fcf', color2: '#00aeef', prefix: '3' },
];

function hashSeed(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

function stableNumber(seed, min, max) {
  const span = max - min + 1;
  return min + (parseInt(hashSeed(seed).slice(0, 8), 16) % span);
}

function defaultDisplayName(phoneNumber) {
  return `User ${String(phoneNumber).slice(-4)}`;
}

function buildStableCards(phoneNumber, count = 2) {
  const cards = [];
  const startIndex = stableNumber(`cards:start:${phoneNumber}`, 0, CARD_TEMPLATES.length - 1);

  for (let i = 0; i < Math.min(count, CARD_TEMPLATES.length); i++) {
    const template = CARD_TEMPLATES[(startIndex + i) % CARD_TEMPLATES.length];
    const last4 = String(stableNumber(`cards:last4:${phoneNumber}:${template.brand}:${i}`, 1000, 9999));
    const expMonth = String(stableNumber(`cards:month:${phoneNumber}:${template.brand}:${i}`, 1, 12)).padStart(2, '0');
    const expYear = String(stableNumber(`cards:year:${phoneNumber}:${template.brand}:${i}`, 27, 30));
    cards.push({
      id: `card_${hashSeed(`cards:id:${phoneNumber}:${template.brand}:${i}`).slice(0, 24)}`,
      brand: template.brand,
      last4,
      expiry: `${expMonth}/${expYear}`,
      color1: template.color1,
      color2: template.color2,
    });
  }
  return cards;
}

function buildStableUser(phoneNumber, displayName, createdAt = new Date().toISOString()) {
  const user = {
    id: `user_${hashSeed(`user:id:${phoneNumber}`).slice(0, 24)}`,
    phoneNumber,
    displayName: displayName || defaultDisplayName(phoneNumber),
    cards: buildStableCards(phoneNumber, 2),
    createdAt,
  };
  return user;
}

function generateMockCards(count = 2, phoneNumber = 'demo') {
  return buildStableCards(phoneNumber, count);
}

function serializeCredential(credential) {
  return {
    ...credential,
    id: normalizeCredentialId(credential.id),
    publicKey: credential.publicKey ? Buffer.from(credential.publicKey).toString('base64url') : '',
  };
}

function persistStore() {
  const payload = {
    users: Array.from(store.users.entries()),
    credentials: Array.from(store.credentials.entries()).map(([id, credential]) => [id, serializeCredential(credential)]),
    devices: Array.from(store.devices.entries()),
  };

  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    const tmpFile = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpFile, STORE_FILE);
  } catch (error) {
    console.warn('[PassWallet][store_persist_failed]', error.message);
  }
}

function loadPersistedStore() {
  if (!fs.existsSync(STORE_FILE)) return;

  try {
    const payload = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));

    if (Array.isArray(payload.users)) {
      for (const [phoneNumber, user] of payload.users) {
        if (!phoneNumber || !user) continue;
        store.users.set(phoneNumber, {
          id: user.id || `user_${hashSeed(`user:id:${phoneNumber}`).slice(0, 24)}`,
          phoneNumber,
          displayName: user.displayName || defaultDisplayName(phoneNumber),
          cards: Array.isArray(user.cards) && user.cards.length > 0 ? user.cards : buildStableCards(phoneNumber, 2),
          createdAt: user.createdAt || new Date().toISOString(),
        });
      }
    }

    if (Array.isArray(payload.credentials)) {
      for (const [id, credential] of payload.credentials) {
        const normalizedId = normalizeCredentialId(id || credential?.id);
        if (!normalizedId || !credential?.phoneNumber || !credential.publicKey) continue;
        store.credentials.set(normalizedId, {
          ...credential,
          id: normalizedId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
        });
      }
    }

    if (Array.isArray(payload.devices)) {
      for (const [deviceId, binding] of payload.devices) {
        if (!deviceId || !binding?.phoneNumber || !binding.publicKey) continue;
        store.devices.set(deviceId, {
          publicKey: binding.publicKey,
          phoneNumber: binding.phoneNumber,
        });
      }
    }
  } catch (error) {
    console.warn('[PassWallet][store_load_failed]', error.message);
  }
}

function createUser(phoneNumber, displayName) {
  const existing = store.users.get(phoneNumber);
  if (existing) {
    if (displayName && existing.displayName !== displayName) {
      existing.displayName = displayName;
      persistStore();
    }
    return existing;
  }

  const user = buildStableUser(phoneNumber, displayName);
  store.users.set(phoneNumber, user);
  persistStore();
  return user;
}

function saveUser(user) {
  if (!user || !user.phoneNumber) {
    throw new Error('Valid user with phoneNumber required');
  }
  const existing = store.users.get(user.phoneNumber);
  const normalized = buildStableUser(
    user.phoneNumber,
    user.displayName || existing?.displayName,
    user.createdAt || existing?.createdAt || new Date().toISOString(),
  );
  store.users.set(user.phoneNumber, normalized);
  persistStore();
  return normalized;
}

function getUser(phoneNumber) {
  return store.users.get(phoneNumber) || null;
}

function getUserById(id) {
  for (const user of store.users.values()) {
    if (user.id === id) return user;
  }
  return null;
}

function addCredential(phoneNumber, credential) {
  const normalizedId = normalizeCredentialId(credential.id);
  if (!normalizedId) {
    throw new Error('Invalid credential id');
  }
  store.credentials.set(normalizedId, { ...credential, id: normalizedId, phoneNumber });
  persistStore();
}

function getCredentialsByPhoneNumber(phoneNumber) {
  const result = [];
  for (const [id, cred] of store.credentials) {
    if (cred.phoneNumber === phoneNumber) {
      result.push(cred);
    }
  }
  return result;
}

function getCredentialById(id) {
  const normalizedId = normalizeCredentialId(id);
  if (!normalizedId) return null;
  return store.credentials.get(normalizedId) || null;
}

function removeCredentialsByPhoneNumber(phoneNumber) {
  for (const [id, cred] of store.credentials) {
    if (cred.phoneNumber === phoneNumber) {
      store.credentials.delete(id);
    }
  }
  persistStore();
}

function updateCredentialCounter(id, newCounter) {
  const normalizedId = normalizeCredentialId(id);
  if (!normalizedId) return;
  const cred = store.credentials.get(normalizedId);
  if (cred) {
    cred.counter = newCounter;
    persistStore();
  }
}

function setChallenge(key, challenge) {
  store.challenges.set(key, challenge);
}

function getChallenge(key) {
  const challenge = store.challenges.get(key);
  store.challenges.delete(key);
  return challenge;
}

// OTP Management
function setOTP(phoneNumber, otp) {
  store.otps.set(phoneNumber, otp);
  // In a real app, you'd set an expiry here
}

function getOTP(phoneNumber) {
  return store.otps.get(phoneNumber);
}

function clearOTP(phoneNumber) {
  store.otps.delete(phoneNumber);
}

// Device Binding Management
function addDeviceBinding(deviceId, publicKey, phoneNumber) {
  store.devices.set(deviceId, { publicKey, phoneNumber });
  persistStore();
}

function getDeviceBinding(deviceId) {
  return store.devices.get(deviceId) || null;
}

function removeDeviceBinding(deviceId) {
  store.devices.delete(deviceId);
  persistStore();
}

loadPersistedStore();

// Pre-seed a demo user
if (!store.users.has('1234567890')) {
  const demoUser = createUser('1234567890', 'Alex Johnson');
  demoUser.cards = [
    { id: uuidv4(), brand: 'Visa', last4: '4242', expiry: '09/28', color1: '#1a1f71', color2: '#2557d6' },
    { id: uuidv4(), brand: 'Mastercard', last4: '8888', expiry: '03/27', color1: '#eb001b', color2: '#f79e1b' },
    { id: uuidv4(), brand: 'Amex', last4: '1234', expiry: '12/29', color1: '#006fcf', color2: '#00aeef' },
  ];
  persistStore();
}

module.exports = {
  createUser,
  saveUser,
  getUser,
  getUserById,
  addCredential,
  getCredentialsByPhoneNumber,
  getCredentialById,
  removeCredentialsByPhoneNumber,
  updateCredentialCounter,
  setChallenge,
  getChallenge,
  generateMockCards,
  setOTP,
  getOTP,
  clearOTP,
  addDeviceBinding,
  getDeviceBinding,
  removeDeviceBinding,
};
