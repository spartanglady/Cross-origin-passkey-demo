const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

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

function createUser(phoneNumber, displayName) {
  const existing = store.users.get(phoneNumber);
  if (existing) {
    if (displayName && existing.displayName !== displayName) {
      existing.displayName = displayName;
    }
    return existing;
  }

  const user = buildStableUser(phoneNumber, displayName);
  store.users.set(phoneNumber, user);
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
}

function updateCredentialCounter(id, newCounter) {
  const normalizedId = normalizeCredentialId(id);
  if (!normalizedId) return;
  const cred = store.credentials.get(normalizedId);
  if (cred) {
    cred.counter = newCounter;
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
}

function getDeviceBinding(deviceId) {
  return store.devices.get(deviceId) || null;
}

function removeDeviceBinding(deviceId) {
  store.devices.delete(deviceId);
}

// Pre-seed a demo user
const demoUser = createUser('1234567890', 'Alex Johnson');
demoUser.cards = [
  { id: uuidv4(), brand: 'Visa', last4: '4242', expiry: '09/28', color1: '#1a1f71', color2: '#2557d6' },
  { id: uuidv4(), brand: 'Mastercard', last4: '8888', expiry: '03/27', color1: '#eb001b', color2: '#f79e1b' },
  { id: uuidv4(), brand: 'Amex', last4: '1234', expiry: '12/29', color1: '#006fcf', color2: '#00aeef' },
];

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
