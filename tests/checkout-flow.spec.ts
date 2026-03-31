import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const MERCHANT_ORIGIN = 'http://localhost:3000';
const WALLET_ORIGIN = 'http://localhost:3001';
const OTP_CODE = '111111';

let phoneSeed = 0;

function nextPhoneNumber() {
  phoneSeed += 1;
  return `555${String(1_000_000 + phoneSeed).slice(-7)}`;
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

  const loginOptionsRes = await request.post(`${WALLET_ORIGIN}/api/login/options`, {
    data: { phoneNumber },
  });
  expect(loginOptionsRes.ok()).toBeTruthy();
  const loginOptions = await loginOptionsRes.json();
  const authenticationRpId = loginOptions?.options?.rpId ?? loginOptions?.options?.rpID;
  expect(authenticationRpId).toBe('localhost');
});

test('first-time user completes OTP + CVV flow and skips passkey registration', async ({ page }) => {
  const phoneNumber = nextPhoneNumber();

  await openMerchant(page);
  await addItemAndStartCheckout(page);

  await enterPhone(page, phoneNumber);
  await enterOTP(page);

  await expect(page.locator('#pw-step-payment.pw-active')).toBeVisible();
  await expect(page.locator('#pw-cvv-input')).toBeVisible();

  await page.locator('#pw-cvv-input').fill('123');
  await expect(page.locator('#pw-pay-btn')).toBeEnabled();
  await page.locator('#pw-pay-btn').click();

  await expect(page.locator('#pw-step-register-passkey.pw-active')).toBeVisible();
  await page.locator('#pw-skip-passkey-btn').click();

  await expectSuccess(page);
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
  await expect(page.locator('#pw-cvv-input')).toHaveCount(0);
  await page.locator('#pw-pay-btn').click();

  await expect(page.locator('#pw-step-otp.pw-active')).toBeVisible();
  await enterOTP(page);
  await expectSuccess(page);
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
