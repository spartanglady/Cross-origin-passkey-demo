import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const MERCHANT_ORIGIN = 'http://localhost:3000';
const WALLET_ORIGIN = 'http://localhost:3001';
const OTP_CODE = '111111';

let phoneSeed = 0;

function nextPhoneNumber() {
  phoneSeed += 1;
  return `555${String(1_000_000 + phoneSeed).slice(-7)}`;
}

function decodeSignedTokenPayload(token: string) {
  const [body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

async function seedWalletUser(request: APIRequestContext, phoneNumber: string) {
  const sendOTP = await request.post(`${WALLET_ORIGIN}/api/auth/otp/send`, {
    data: { phoneNumber },
  });
  expect(sendOTP.ok()).toBeTruthy();

  const verifyOTP = await request.post(`${WALLET_ORIGIN}/api/auth/otp/verify`, {
    data: { phoneNumber, otp: OTP_CODE },
  });
  expect(verifyOTP.ok()).toBeTruthy();

  const payload = await verifyOTP.json();
  return {
    phoneNumber,
    displayName: payload.user.displayName,
    cards: payload.user.cards,
  };
}

async function waitForSDK(page: Page) {
  await page.waitForFunction(() => Boolean((window as any).PassWallet));
}

async function installVirtualAuthenticator(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable');
  const authenticator = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    session,
    authenticatorId: authenticator.authenticatorId as string,
  };
}

async function openMerchant(page: Page) {
  await page.goto(MERCHANT_ORIGIN);
}

async function addItemAndStartCheckout(page: Page) {
  await page.locator('.add-to-cart-btn').first().click();
  await expect(page.locator('#start-checkout-btn')).toBeEnabled();
  await page.locator('#start-checkout-btn').click();
  await expect(page.locator('#checkout-page.active')).toBeVisible();
}

async function enterPhone(page: Page, phoneNumber: string) {
  await expect(page.locator('#pw-step-phone.pw-active')).toBeVisible();
  await page.locator('#pw-phone-input').fill(phoneNumber);
}

async function enterOTP(page: Page, otp = OTP_CODE) {
  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
  await page.locator('#pw-otp-input').fill(otp);
}

async function expectSuccess(page: Page) {
  await expect(page.locator('#pw-step-success.pw-active')).toBeVisible();
  await expect(page.locator('#pw-conf-txn')).toContainText('TXN-');
}

test('WebAuthn options are pinned to the wallet RP ID', async ({ request }) => {
  const phoneNumber = nextPhoneNumber();

  const registerOptionsRes = await request.post(`${WALLET_ORIGIN}/api/register/options`, {
    data: { phoneNumber, displayName: `User ${phoneNumber.slice(-4)}` },
  });
  expect(registerOptionsRes.ok()).toBeTruthy();
  const registerOptions = await registerOptionsRes.json();
  const registrationRpId = registerOptions?.options?.rp?.id ?? registerOptions?.options?.rpID;
  expect(registrationRpId).toBe('localhost');
  const registerTokenPayload = decodeSignedTokenPayload(registerOptions.verificationToken);
  expect(registerTokenPayload.phoneNumber).toBe(phoneNumber);
  expect(registerTokenPayload.user.phoneNumber).toBe(phoneNumber);
  expect(registerTokenPayload.user.displayName).toBe(`User ${phoneNumber.slice(-4)}`);

  const loginOptionsRes = await request.post(`${WALLET_ORIGIN}/api/login/options`, {
    data: { phoneNumber },
  });
  expect(loginOptionsRes.ok()).toBeTruthy();
  const loginOptions = await loginOptionsRes.json();
  const authenticationRpId = loginOptions?.options?.rpId ?? loginOptions?.options?.rpID;
  expect(authenticationRpId).toBe('localhost');
  const authTokenPayload = decodeSignedTokenPayload(loginOptions.verificationToken);
  expect(authTokenPayload.phoneNumber).toBe(phoneNumber);
  expect(authTokenPayload.user.phoneNumber).toBe(phoneNumber);
  expect(Array.isArray(authTokenPayload.user.cards)).toBe(true);
});

test('wallet client log endpoint accepts browser diagnostics', async ({ request }) => {
  const res = await request.post(`${WALLET_ORIGIN}/api/client-log`, {
    data: {
      level: 'error',
      source: 'playwright',
      event: 'browser_error',
      message: 'Synthetic browser error',
      details: {
        errorName: 'SyntheticError',
        errorMessage: 'Something went wrong',
      },
      page: {
        origin: MERCHANT_ORIGIN,
        href: `${MERCHANT_ORIGIN}/checkout`,
      },
      timestamp: new Date().toISOString(),
    },
  });

  expect(res.ok()).toBeTruthy();
  await expect(res.json()).resolves.toEqual({ logged: true });
});

test('wallet users keep the same saved cards for a phone number', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('../wallet/store');
  const phoneNumber = nextPhoneNumber();

  const firstUser = store.createUser(phoneNumber, 'User Stable');
  const normalizedUser = store.saveUser({
    phoneNumber,
    displayName: 'User Renamed',
    cards: [{ id: 'bogus-card' }],
  });

  expect(normalizedUser.displayName).toBe('User Renamed');
  expect(normalizedUser.cards).toEqual(firstUser.cards);
  expect(normalizedUser.cards).toHaveLength(2);
});

test('wallet login options can restore passkey credentials from phone-bound client hints', async ({ request }) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('../wallet/store');
  const phoneNumber = nextPhoneNumber();
  const user = store.createUser(phoneNumber, `User ${phoneNumber.slice(-4)}`);
  const credentialHint = {
    id: Buffer.from(`credential-${phoneNumber}`).toString('base64url'),
    publicKey: Buffer.from(`public-key-${phoneNumber}`).toString('base64url'),
    counter: 7,
    transports: ['internal'],
    phoneNumber,
  };

  store.addCredential(phoneNumber, {
    id: credentialHint.id,
    publicKey: Buffer.from(credentialHint.publicKey, 'base64url'),
    counter: credentialHint.counter,
    transports: credentialHint.transports,
  });
  expect(store.getCredentialsByPhoneNumber(phoneNumber)).toHaveLength(1);

  store.removeCredentialsByPhoneNumber(phoneNumber);
  expect(store.getCredentialsByPhoneNumber(phoneNumber)).toHaveLength(0);

  const res = await request.post(`${WALLET_ORIGIN}/api/login/options`, {
    data: {
      phoneNumber,
      userHint: {
        phoneNumber,
        displayName: user.displayName,
        cards: user.cards,
      },
      credentialHints: [credentialHint],
    },
  });

  expect(res.ok()).toBeTruthy();
  const payload = await res.json();
  expect(payload.hasPasskeys).toBe(true);

  const tokenPayload = decodeSignedTokenPayload(payload.verificationToken);
  expect(tokenPayload.user.phoneNumber).toBe(phoneNumber);
  expect(tokenPayload.credentials).toEqual([
    expect.objectContaining({
      id: credentialHint.id,
      phoneNumber,
    }),
  ]);
});

test('wallet device verify can restore a phone-bound device binding from client hints', async ({ request }) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('../wallet/store');
  const phoneNumber = nextPhoneNumber();
  const user = store.createUser(phoneNumber, `User ${phoneNumber.slice(-4)}`);
  const deviceId = `dev_${phoneNumber}`;
  const publicKey = Buffer.from(`device-public-key-${phoneNumber}`).toString('base64');

  store.removeDeviceBinding(deviceId);

  const challengeRes = await request.post(`${WALLET_ORIGIN}/api/device/challenge`, {
    data: { deviceId, phoneNumber },
  });
  expect(challengeRes.ok()).toBeTruthy();
  const challengePayload = await challengeRes.json();

  const verifyRes = await request.post(`${WALLET_ORIGIN}/api/device/verify`, {
    data: {
      deviceId,
      signature: 'demo-signature',
      verificationToken: challengePayload.verificationToken,
      phoneNumber,
      publicKey,
      userHint: {
        phoneNumber,
        displayName: user.displayName,
        cards: user.cards,
      },
    },
  });

  expect(verifyRes.ok()).toBeTruthy();
  await expect(verifyRes.json()).resolves.toEqual(expect.objectContaining({
    verified: true,
    hasPasskey: false,
    user: expect.objectContaining({
      phoneNumber,
      displayName: user.displayName,
      cards: user.cards,
    }),
  }));

  const secondChallengeRes = await request.post(`${WALLET_ORIGIN}/api/device/challenge`, {
    data: { deviceId },
  });
  expect(secondChallengeRes.ok()).toBeTruthy();
  const secondChallengePayload = await secondChallengeRes.json();

  const secondVerifyRes = await request.post(`${WALLET_ORIGIN}/api/device/verify`, {
    data: {
      deviceId,
      signature: 'demo-signature',
      verificationToken: secondChallengePayload.verificationToken,
    },
  });
  expect(secondVerifyRes.ok()).toBeTruthy();
  await expect(secondVerifyRes.json()).resolves.toEqual(expect.objectContaining({
    verified: true,
    user: expect.objectContaining({
      phoneNumber,
    }),
  }));
});

test('real passkey registration and returning-user authentication succeed', async ({ page }) => {
  const phoneNumber = nextPhoneNumber();
  const bridgeWarnings: string[] = [];
  await installVirtualAuthenticator(page);

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('startRegistration() was not called correctly') || text.includes('startAuthentication() was not called correctly')) {
      bridgeWarnings.push(text);
    }
  });

  await openMerchant(page);
  await addItemAndStartCheckout(page);

  await enterPhone(page, phoneNumber);
  await enterOTP(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await page.locator('#pw-cvv-input').fill('123');
  await expect(page.locator('#pw-pay-btn')).toBeEnabled();
  await page.locator('#pw-pay-btn').click();

  await expect(page.locator('#pw-step-register-passkey.pw-active')).toBeVisible();
  await page.frameLocator('#pw-bridge-iframe').locator('#bridge-btn').click();
  await expectSuccess(page);
  await page.locator('#pw-continue-shopping-btn').click();

  await page.locator('.add-to-cart-btn').first().click();
  await page.locator('#start-checkout-btn').click();

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await page.locator('#pw-pay-btn').click();
  await page.frameLocator('#pw-bridge-iframe').locator('#bridge-btn').click();

  await expectSuccess(page);
  expect(bridgeWarnings).toEqual([]);
});

test('first-time user completes OTP + CVV flow and skips passkey registration', async ({ page }) => {
  const phoneNumber = nextPhoneNumber();

  await openMerchant(page);
  await addItemAndStartCheckout(page);
  await expect(page.locator('#checkout-pane-header')).toBeVisible();
  await expect(page.locator('#checkout-pane-subtitle')).toHaveText('Enter your details to complete your purchase.');

  await enterPhone(page, phoneNumber);
  await expect(page.locator('#checkout-pane-header')).toBeHidden();
  await enterOTP(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#checkout-pane-header')).toBeVisible();
  await expect(page.locator('#checkout-pane-subtitle')).toHaveText('Review your saved card and complete your purchase.');
  await expect(page.locator('#pw-cvv-input')).toBeVisible();

  await page.locator('#pw-cvv-input').fill('123');
  await expect(page.locator('#pw-pay-btn')).toBeEnabled();
  await page.locator('#pw-pay-btn').click();

  await expect(page.locator('#pw-step-register-passkey.pw-active')).toBeVisible();
  await expect(page.locator('#checkout-pane-header')).toBeHidden();
  await page.locator('#pw-skip-passkey-btn').click();

  await expectSuccess(page);
  await expect(page.locator('#checkout-pane-header')).toBeHidden();
  await expect(page.locator('#checkout-secured-badge')).toBeHidden();
});

test('phone-entry passkey attempt falls back to OTP when passkey auth is cancelled', async ({ page, request }) => {
  const phoneNumber = nextPhoneNumber();
  await seedWalletUser(request, phoneNumber);

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ phone }) => {
    const sdk = (window as any).PassWallet;
    const originalLookup = sdk.lookup.bind(sdk);
    const originalWalletFetch = sdk._walletFetch.bind(sdk);

    (window as any).__pwPasskeyLoginOptionsRequested = false;

    sdk.lookup = async (candidate: string) => {
      const result = await originalLookup(candidate);
      if (candidate === phone && result.exists) {
        return { ...result, hasPasskey: true };
      }
      return result;
    };

    sdk._walletFetch = async (path: string, body: unknown) => {
      if (path === '/api/login/options') {
        (window as any).__pwPasskeyLoginOptionsRequested = true;
      }
      return originalWalletFetch(path, body);
    };

    sdk._postToBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const err = new Error('Simulated passkey cancellation');
      (err as any).name = 'NotAllowedError';
      throw err;
    };
  }, { phone: phoneNumber });

  await addItemAndStartCheckout(page);
  await enterPhone(page, phoneNumber);

  await expect.poll(async () => {
    return page.evaluate(() => Boolean((window as any).__pwPasskeyLoginOptionsRequested));
  }).toBe(true);
  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
});

test('returning WebCrypto user without passkey is prompted for OTP at pay time', async ({ page, request }) => {
  const phoneNumber = nextPhoneNumber();
  const user = await seedWalletUser(request, phoneNumber);
  const secondCard = user.cards[1];

  await page.addInitScript(({ deviceId }) => {
    localStorage.setItem('pw_device_id', deviceId);
    localStorage.setItem('pw_mock_key', 'mock-webcrypto-public-key');
  }, { deviceId: `dev_${phoneNumber}` });

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ returningUser }) => {
    const sdk = (window as any).PassWallet;
    sdk.challengeDevice = async () => ({ challenge: 'test-challenge' });
    sdk.verifyDevice = async () => ({
      verified: true,
      hasPasskey: false,
      user: returningUser,
    });
  }, { returningUser: user });

  await addItemAndStartCheckout(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await expect(page.locator('#pw-cvv-input')).toHaveCount(0);
  await page.locator(`.pw-card-wrapper[data-id="${secondCard.id}"] .pw-card-item`).click();
  await page.locator('#pw-pay-btn').click();

  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
  await enterOTP(page);
  await expectSuccess(page);
  await expect(page.locator('#pw-conf-card')).toContainText(secondCard.last4);
});

test('returning WebCrypto user with passkey falls back to OTP when passkey auth is cancelled', async ({ page, request }) => {
  const phoneNumber = nextPhoneNumber();
  const user = await seedWalletUser(request, phoneNumber);

  await page.addInitScript(({ deviceId }) => {
    localStorage.setItem('pw_device_id', deviceId);
    localStorage.setItem('pw_mock_key', 'mock-webcrypto-public-key');
  }, { deviceId: `dev_${phoneNumber}` });

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ returningUser }) => {
    const sdk = (window as any).PassWallet;
    sdk.challengeDevice = async () => ({ challenge: 'test-challenge' });
    sdk.verifyDevice = async () => ({
      verified: true,
      hasPasskey: true,
      user: returningUser,
    });
    sdk._postToBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const err = new Error('Simulated passkey cancellation');
      (err as any).name = 'NotAllowedError';
      throw err;
    };
  }, { returningUser: user });

  await addItemAndStartCheckout(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await page.locator('#pw-pay-btn').click();
  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
});

test('OTP fallback refreshes the selected card after a passkey failure', async ({ page, request }) => {
  const phoneNumber = nextPhoneNumber();
  const user = await seedWalletUser(request, phoneNumber);
  const refreshedUser = {
    ...user,
    cards: [
      {
        id: 'refreshed-card-id',
        brand: 'Visa',
        last4: '9999',
        expiry: '09/29',
        color1: '#1a1f71',
        color2: '#2557d6',
      },
    ],
  };

  await page.addInitScript(({ deviceId }) => {
    localStorage.setItem('pw_device_id', deviceId);
    localStorage.setItem('pw_mock_key', 'mock-webcrypto-public-key');
  }, { deviceId: `dev_${phoneNumber}` });

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ returningUser, verifiedUser }) => {
    const sdk = (window as any).PassWallet;
    const originalWalletFetch = sdk._walletFetch.bind(sdk);

    sdk.challengeDevice = async () => ({ challenge: 'test-challenge' });
    sdk.verifyDevice = async () => ({
      verified: true,
      hasPasskey: true,
      user: returningUser,
    });
    sdk._walletFetch = async (path: string, body: unknown) => {
      if (path === '/api/login/options') {
        return {
          options: {
            challenge: 'test-challenge',
            rpId: 'localhost',
            userVerification: 'preferred',
          },
          sessionId: 'session-1',
          verificationToken: 'token-1',
          hasPasskeys: true,
        };
      }
      return originalWalletFetch(path, body);
    };
    sdk._postToBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const err = new Error('Simulated passkey verification failure');
      (err as any).name = 'UnknownError';
      throw err;
    };
    sdk.verifyOTP = async () => ({
      verified: true,
      user: verifiedUser,
    });
    sdk.pay = async (_phone: string, cardId: string, amount: string) => {
      (window as any).__lastPayCardId = cardId;
      if (cardId !== verifiedUser.cards[0].id) {
        throw new Error('Card not found');
      }
      return {
        success: true,
        amount,
        cardBrand: verifiedUser.cards[0].brand,
        last4: verifiedUser.cards[0].last4,
        transactionId: 'TXN-REFRESHED-CARD',
      };
    };
  }, { returningUser: user, verifiedUser: refreshedUser });

  await addItemAndStartCheckout(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await page.locator('#pw-pay-btn').click();
  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();

  await enterOTP(page);
  await expectSuccess(page);
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__lastPayCardId);
  }).toBe(refreshedUser.cards[0].id);
});

test('returning WebCrypto user with passkey can switch to OTP when passkey auth fails', async ({ page, request }) => {
  const phoneNumber = nextPhoneNumber();
  const user = await seedWalletUser(request, phoneNumber);

  await page.addInitScript(({ deviceId }) => {
    localStorage.setItem('pw_device_id', deviceId);
    localStorage.setItem('pw_mock_key', 'mock-webcrypto-public-key');
  }, { deviceId: `dev_${phoneNumber}` });

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ returningUser }) => {
    const sdk = (window as any).PassWallet;
    const originalWalletFetch = sdk._walletFetch.bind(sdk);

    sdk.challengeDevice = async () => ({ challenge: 'test-challenge' });
    sdk.verifyDevice = async () => ({
      verified: true,
      hasPasskey: true,
      user: returningUser,
    });
    sdk._walletFetch = async (path: string, body: unknown) => {
      if (path === '/api/login/options') {
        return {
          options: {
            challenge: 'test-challenge',
            rpId: 'localhost',
            allowCredentials: [{ id: 'test-credential-id', type: 'public-key' }],
            userVerification: 'preferred',
          },
          sessionId: 'session-1',
          verificationToken: 'token-1',
          hasPasskeys: true,
        };
      }
      return originalWalletFetch(path, body);
    };
    sdk._postToBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const err = new Error('Simulated non-cancel passkey failure');
      (err as any).name = 'UnknownError';
      throw err;
    };
  }, { returningUser: user });

  await addItemAndStartCheckout(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await page.locator('#pw-pay-btn').click();
  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
});

test('returning user can click Change and log in as a different phone', async ({ page, request }) => {
  const originalPhone = nextPhoneNumber();
  const replacementPhone = nextPhoneNumber();
  const originalUser = await seedWalletUser(request, originalPhone);
  await seedWalletUser(request, replacementPhone);

  await page.addInitScript(({ deviceId }) => {
    localStorage.setItem('pw_device_id', deviceId);
    localStorage.setItem('pw_mock_key', 'mock-webcrypto-public-key');
  }, { deviceId: `dev_${originalPhone}` });

  await openMerchant(page);
  await waitForSDK(page);
  await page.evaluate(({ returningUser }) => {
    const sdk = (window as any).PassWallet;
    sdk.challengeDevice = async () => ({ challenge: 'test-challenge' });
    sdk.verifyDevice = async () => ({
      verified: true,
      hasPasskey: false,
      user: returningUser,
    });
  }, { returningUser: originalUser });

  await addItemAndStartCheckout(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-pay-btn')).toHaveText('Pay Now');
  await expect(page.locator('#pw-display-phone')).toContainText(originalPhone);

  await page.locator('#pw-logout-btn').click();
  await expect(page.locator('#pw-step-phone.pw-active')).toBeVisible();
  await expect(page.locator('#pw-phone-input')).toHaveValue('');

  await enterPhone(page, replacementPhone);
  await enterOTP(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-display-phone')).toContainText(replacementPhone);
  await expect(page.locator('#pw-cvv-input')).toBeVisible();
});
