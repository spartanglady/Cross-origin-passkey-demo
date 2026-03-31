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

function generateMockCards(count = 2) {
  const cards = [];
  const shuffled = [...CARD_TEMPLATES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(count, shuffled.length); i++) {
    const template = shuffled[i];
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    const expMonth = String(Math.floor(1 + Math.random() * 12)).padStart(2, '0');
    const expYear = String(27 + Math.floor(Math.random() * 4));
    cards.push({
      id: uuidv4(),
      brand: template.brand,
      last4,
      expiry: `${expMonth}/${expYear}`,
      color1: template.color1,
      color2: template.color2,
    });
  }
  return cards;
}

function createUser(phoneNumber, displayName) {
  const userId = uuidv4();
  const user = {
    id: userId,
    phoneNumber,
    displayName,
    cards: generateMockCards(2),
    createdAt: new Date().toISOString(),
  };
  store.users.set(phoneNumber, user);
  return user;
}

function saveUser(user) {
  if (!user || !user.phoneNumber) {
    throw new Error('Valid user with phoneNumber required');
  }
  store.users.set(user.phoneNumber, user);
  return user;
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
  updateCredentialCounter,
  setChallenge,
  getChallenge,
  generateMockCards,
  setOTP,
  getOTP,
  clearOTP,
  addDeviceBinding,
  getDeviceBinding,
};
