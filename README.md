# Cross-Origin PassWallet Demo

This demo shows a **merchant-native checkout UX** that uses an embedded wallet service on a different origin only when required (passkey ceremonies), while keeping the rest of the experience in the merchant UI.

The goal is to prove this pattern:

1. Merchant keeps full control of storefront + checkout layout.
2. Wallet SDK provides auth/payment APIs.
3. A minimal iframe button is shown only for WebAuthn operations that must run on the wallet origin.

## What This Demo Covers

### First-time user

1. Enter phone on merchant checkout.
2. OTP verification.
3. Card selection + CVV.
4. Device binding established (WebCrypto-backed demo binding).
5. Optional passkey registration prompt (minimal iframe button from wallet origin).
6. Payment completes in merchant-native flow.

### Returning user with device binding

1. Cards auto-display without phone step.
2. If passkey exists: pay click requires passkey (iframe button), then payment.
3. If passkey does not exist: pay click falls back to OTP, then payment.
4. User can click **Change** to switch to a different phone/login path.

### Phone-entry user with passkey

1. Enter phone.
2. Minimal iframe passkey button shown on phone step.
3. If passkey succeeds: go straight to payment.
4. If passkey is cancelled/fails: fall back to OTP flow.

## Architecture

Two applications run on different origins:

| Component | Local URL | Role |
|---|---|---|
| Merchant (Keysmith) | `http://localhost:3000` | Storefront + merchant-native checkout UI/state machine |
| Wallet (PassWallet) | `http://localhost:3001` | Auth/payment APIs, WebAuthn verification, passkey bridge + SDK |

### Core integration model

- Merchant dynamically loads `sdk.js` from wallet origin.
- Checkout logic lives in merchant UI (`checkout-flow.js`).
- Passkey ceremonies run in wallet-origin iframe (`passkey-bridge.html/js`).
- Merchant and bridge communicate through SDK-managed `postMessage`.

## Quick Start

```bash
npm install
npm start
```

Open:

- Merchant: `http://localhost:3000`
- Wallet: `http://localhost:3001`

## Demo OTP/CVV Values

- OTP: `111111`
- CVV: `123`

These are intentionally fixed for demo flow validation.

## Playwright Test Suite

This repo includes end-to-end coverage for the checkout state machine and fallback behavior.

### Install browser once

```bash
npx playwright install chromium
```

### Run tests

```bash
npm test
```

### Covered scenarios

1. First-time user: OTP + CVV + skip passkey registration.
2. Phone-entry passkey path: cancelled passkey falls back to OTP.
3. Returning device-bound user without passkey: pay triggers OTP fallback.
4. Returning device-bound user with passkey: cancelled passkey falls back to OTP.
5. Returning user clicks **Change** and logs in as a different phone.

## Environment Variables

### Merchant app

- `WALLET_ORIGIN` (preferred): wallet base URL used to load `sdk.js`
- `WALLET_URL` (fallback)

### Wallet app

- `WALLET_URL`: wallet base URL used for RP host derivation
- `MERCHANT_URL`: allowed merchant URL for demo configuration

The Playwright config sets these automatically for local tests.

## Deployment Notes

- Merchant is configured for Netlify static hosting (`merchant/netlify.toml`) with config endpoint support.
- Wallet is configured for Vercel (`wallet/vercel.json`, `wallet/api/index.js`).
- The two apps must be deployed to different origins to demonstrate real cross-origin behavior.

## Project Structure

```text
Cross-origin-passkey-demo/
├── playwright.config.ts
├── tests/
│   └── checkout-flow.spec.ts
├── merchant/
│   ├── server.js
│   ├── api/config.js
│   ├── netlify/functions/config.js
│   └── public/
│       ├── index.html
│       ├── app.js
│       ├── checkout-flow.js
│       └── css/style.css
├── wallet/
│   ├── server.js
│   ├── store.js
│   ├── api/index.js
│   └── public/
│       ├── sdk.js
│       ├── passkey-bridge.html
│       ├── passkey-bridge.js
│       └── css/wallet.css
└── package.json
```

## API Endpoints (Wallet)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/lookup` | Check phone account existence + passkey availability |
| POST | `/api/auth/otp/send` | Send demo OTP |
| POST | `/api/auth/otp/verify` | Verify OTP and return user/cards |
| POST | `/api/register/options` | WebAuthn registration options |
| POST | `/api/register/verify` | Verify registration |
| POST | `/api/login/options` | WebAuthn authentication options |
| POST | `/api/login/verify` | Verify authentication |
| POST | `/api/pay` | Process mock payment |
| POST | `/api/device/challenge` | Device-binding challenge |
| POST | `/api/device/register` | Register device binding |
| POST | `/api/device/verify` | Verify device binding |

## License

MIT

