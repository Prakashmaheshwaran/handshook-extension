import { defineConfig } from '@playwright/test';

/**
 * Live suite: runs against the real Handshake site through the running live harness
 * (`npm run live:start`). Tests attach over CDP to the harness's logged-in browser,
 * so they share its write guard. Serial, no retries.
 */
export default defineConfig({
  testDir: './tests/live',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-live', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
