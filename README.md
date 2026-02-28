# Cross-Origin Passkey Demo

A working demo that proves **WebAuthn passkeys work within cross-origin iframes** -- enabling embedded checkout experiences where users authenticate with biometrics, select a payment card, and complete checkout without ever leaving the merchant's site.

Inspired by [Skipify](https://skipify.com)'s embedded checkout UX.

## Architecture

Two separate web applications running on **different origins** to demonstrate true cross-origin behavior:

| Component | Local URL | Role |
|-----------|-----------|------|
| **TechStore** (Merchant) | `http://localhost:3000` | Apple-inspired e-commerce store |
| **PassWallet** (Wallet) | `http://localhost:3001` | Passkey-authenticated wallet, embedded via iframe |

The merchant embeds PassWallet in an iframe with the required permissions policy:

```html
<iframe src="http://localhost:3001/checkout.html"
        allow="publickey-credentials-get; publickey-credentials-create">
```

Communication between merchant and wallet uses `window.postMessage` with strict origin validation.

## User Flow

```
Merchant Site                          PassWallet (iframe)
    |                                        |
    |  1. User shops, adds to cart           |
    |  2. Clicks "Pay with PassWallet"       |
    |  -------- iframe opens ---------->     |
    |  3. INIT_CHECKOUT (postMessage)  ----> |
    |                                        |  4. User enters email
    |                                        |  5a. New user: Register passkey
    |                                        |  5b. Existing user: Sign in with passkey
    |                                        |  6. Select card from carousel
    |                                        |  7. Click "Pay"
    |  <---- PAYMENT_COMPLETE (postMessage)  |
    |  8. Show confirmation, close iframe    |
```

## Quick Start

```bash
# Install dependencies
npm install

# Start both servers
npm start
```

Then open **http://localhost:3000** in your browser.

### Demo User

A pre-seeded user is available for quick testing (no passkey registration needed for the email lookup flow):

- **Email:** `demo@example.com`
- **Name:** Alex Johnson
- **Cards:** Visa 4242, Mastercard 8888, Amex 1234

> Note: Since this user has no passkey credential registered in your browser, you'll need to register a new account with a fresh email to test the full passkey flow.

## Tech Stack

- **Backend:** Node.js + Express
- **WebAuthn:** [@simplewebauthn/server](https://simplewebauthn.dev/) + [@simplewebauthn/browser](https://simplewebauthn.dev/)
- **Frontend:** Vanilla HTML/CSS/JS (no frameworks)
- **Storage:** In-memory (demo only)

## How the Cross-Origin Passkey Works

### The Problem
By default, browsers block `navigator.credentials.create()` and `navigator.credentials.get()` in cross-origin iframes. This prevents embedded checkout widgets from using passkeys.

### The Solution
The [Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy) mechanism allows the parent page to explicitly grant passkey access to the iframe:

1. **Merchant (parent)** sets the `allow` attribute on the iframe:
   ```html
   <iframe allow="publickey-credentials-get; publickey-credentials-create" ...>
   ```

2. **Wallet (iframe server)** sets the `Permissions-Policy` response header:
   ```
   Permissions-Policy: publickey-credentials-get=(*), publickey-credentials-create=(*)
   ```

3. **User activation** is required -- passkey operations must be triggered by a user click (not programmatically), which the wallet UI handles with explicit "Register" / "Sign in" buttons.

### Browser Support

| Browser | Registration (create) | Authentication (get) |
|---------|----------------------|---------------------|
| Chrome 123+ | Yes | Yes |
| Firefox | Yes | Yes |
| Safari | No | Yes |

## Deploy to Vercel

This project is structured for Vercel deployment as two separate projects:

### 1. Deploy the Wallet (PassWallet)

```bash
cd wallet
vercel --prod
```

Set environment variables in Vercel:
- `WALLET_URL` = `https://your-wallet.vercel.app`
- `MERCHANT_URL` = `https://your-merchant.vercel.app`

### 2. Deploy the Merchant (TechStore)

Before deploying, update the wallet URL in `merchant/public/index.html`:

```html
<script>
  window.__CONFIG__ = {
    WALLET_ORIGIN: 'https://your-wallet.vercel.app'  // <-- Set this
  };
</script>
```

Then deploy:

```bash
cd merchant
vercel --prod
```

### Key Deployment Notes

- The two apps **must** be on different origins (different domains/subdomains) for the cross-origin demo to be meaningful
- The WebAuthn RP ID is automatically derived from the wallet's hostname
- CORS is configured to accept requests from the merchant's origin

## Project Structure

```
Cross-origin-passkey-demo/
├── package.json                 # Root: runs both servers locally
├── merchant/
│   ├── server.js                # Express static server (port 3000)
│   ├── vercel.json              # Vercel static deployment config
│   └── public/
│       ├── index.html           # Apple-inspired store UI
│       └── app.js               # Cart, iframe, postMessage logic
├── wallet/
│   ├── server.js                # Express + WebAuthn API (port 3001)
│   ├── store.js                 # In-memory user/credential/card store
│   ├── vercel.json              # Vercel serverless config
│   ├── api/
│   │   └── index.js             # Vercel serverless entry point
│   └── public/
│       ├── checkout.html        # Multi-step checkout UI
│       └── checkout.js          # WebAuthn + postMessage client logic
```

## API Endpoints (Wallet Server)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/lookup` | Check if email has an account |
| POST | `/api/register/options` | Generate WebAuthn registration options |
| POST | `/api/register/verify` | Verify registration and create account |
| POST | `/api/login/options` | Generate WebAuthn authentication options |
| POST | `/api/login/verify` | Verify authentication and return cards |
| POST | `/api/pay` | Process mock payment |

## License

MIT
