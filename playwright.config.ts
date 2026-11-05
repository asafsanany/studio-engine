import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke test (V2): the built server with the fake runner, driven through the real UI.
 *
 * `pnpm e2e` builds first and then runs this. The server, its temp inbox and data folder, and the
 * port are set up by the `engine` fixture in e2e/support/fixtures.ts, so nothing here knows them.
 *
 * Google Chrome is used as installed (`channel: 'chrome'`): no browser is downloaded.
 *
 * review.spec.ts sets its own Chrome flags (a fake microphone) with test.use, so it runs in a
 * browser of its own.
 *
 * Two projects: `desktop` runs everything in e2e/ except the phone specs, in a wide window; `phone`
 * runs e2e/phone/*.spec.ts only, in Chrome at iPhone 15 size with touch and an iPhone user agent
 * (`pnpm exec playwright test --project=phone`). WebKit is not used: it would be a download, which
 * writes outside the repo. What only Safari shows is checked in the iOS Simulator.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One server, one job queue: the specs run in order in a single worker.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // The whole smoke test must stay well under the 3 minutes the work item allows.
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    channel: 'chrome',
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: 'phone/**',
      // Wide enough for the whole Jobs table (see COLUMN_SPECS in the web app).
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      testMatch: 'phone/*.spec.ts',
      use: {
        // iPhone 15: 393×852 points at 3×, a touch screen, and Safari's user agent. Not
        // `devices['iPhone 15']` itself, which also asks for WebKit.
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 15'].userAgent,
      },
    },
  ],
});
