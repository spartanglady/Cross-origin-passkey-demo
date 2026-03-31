import { defineConfig } from '@playwright/test';

const merchantOrigin = 'http://localhost:3000';
const walletOrigin = 'http://localhost:3001';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: merchantOrigin,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `WALLET_ORIGIN=${walletOrigin} WALLET_URL=${walletOrigin} MERCHANT_URL=${merchantOrigin} npm start`,
    url: merchantOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
