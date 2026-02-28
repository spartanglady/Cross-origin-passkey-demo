const { v4: uuidv4 } = require('uuid');

// In-memory stores
const users = new Map();        // email -> user object
const credentials = new Map();  // credentialID (base64url) -> credential object
const challenges = new Map();   // visitorId -> challenge (temporary, for WebAuthn ceremonies)

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

function createUser(email, displayName) {
  const userId = uuidv4();
  const user = {
    id: userId,
    email,
    displayName,
    cards: generateMockCards(2),
    createdAt: new Date().toISOString(),
  };
  users.set(email, user);
  return user;
}

function getUser(email) {
  return users.get(email) || null;
}

function getUserById(id) {
  for (const user of users.values()) {
    if (user.id === id) return user;
  }
  return null;
}

function addCredential(email, credential) {
  credentials.set(credential.id, { ...credential, email });
}

function getCredentialsByEmail(email) {
  const result = [];
  for (const [id, cred] of credentials) {
    if (cred.email === email) {
      result.push(cred);
    }
  }
  return result;
}

function getCredentialById(id) {
  return credentials.get(id) || null;
}

function updateCredentialCounter(id, newCounter) {
  const cred = credentials.get(id);
  if (cred) {
    cred.counter = newCounter;
  }
}

function setChallenge(key, challenge) {
  challenges.set(key, challenge);
}

function getChallenge(key) {
  const challenge = challenges.get(key);
  challenges.delete(key);
  return challenge;
}

// Pre-seed a demo user
const demoUser = createUser('demo@example.com', 'Alex Johnson');
demoUser.cards = [
  { id: uuidv4(), brand: 'Visa', last4: '4242', expiry: '09/28', color1: '#1a1f71', color2: '#2557d6' },
  { id: uuidv4(), brand: 'Mastercard', last4: '8888', expiry: '03/27', color1: '#eb001b', color2: '#f79e1b' },
  { id: uuidv4(), brand: 'Amex', last4: '1234', expiry: '12/29', color1: '#006fcf', color2: '#00aeef' },
];

module.exports = {
  createUser,
  getUser,
  getUserById,
  addCredential,
  getCredentialsByEmail,
  getCredentialById,
  updateCredentialCounter,
  setChallenge,
  getChallenge,
  generateMockCards,
};
