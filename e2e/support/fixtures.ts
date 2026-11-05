import { test as base, expect } from '@playwright/test';
import { type Engine, startEngine } from './engine.ts';

/**
 * How long a job folder must be quiet before it queues (the work item asks for 2 s).
 */
const SETTLE_MS = 2_000;

/**
 * How much faster than the real one-minute fake edit to go. At 4 an edit takes about 15 s: slow
 * enough that a test can act on a job while it is still editing (hold the queue behind it, cancel
 * it), fast enough for the whole spec to stay under 3 minutes. `E2E_FAKE_SPEED` overrides it.
 */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);

export const test = base.extend<{ serverLog: undefined }, { engine: Engine }>({
  // One server for the whole run: the specs share its inbox and its queue, in order.
  engine: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function needs from its first argument.
    async ({}, use) => {
      // The smoke test covers the flow without Review (an edit ends ready); review.spec.ts covers Review.
      const engine = await startEngine({
        settleMs: SETTLE_MS,
        fakeSpeed: FAKE_SPEED,
        review: false,
      });
      try {
        await use(engine);
      } finally {
        await engine.stop();
      }
    },
    { scope: 'worker', timeout: 90_000 },
  ],

  baseURL: async ({ engine }, use) => {
    await use(engine.baseURL);
  },

  // A failed test brings the server's own log along, which says why a job did not move.
  serverLog: [
    async ({ engine }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', {
          body: await engine.readLog(),
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
