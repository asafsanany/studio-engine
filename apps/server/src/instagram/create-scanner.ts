import type { Config } from '../config.js';
import type { InstagramRepository } from '../db/index.js';
import { fakeSpeedFromEnv } from '../pipeline/fake-runner.js';
import { createFakeInstagramScanner } from './fake-scanner.js';
import { sampleInstagramFixtures } from './sample-accounts.js';
import { createInstagramScanner, type InstagramScanner } from './scanner.js';

/** How long each of a fake scan's two runs takes at speed 1, in milliseconds: long enough to see "Reading…". */
export const FAKE_SCAN_RUN_MS = 6_000;

/**
 * The Instagram scanner `config.runner` names, as `createStyleRunner` picks the style run: the real
 * one (Apify, with the key in `.env`) for `claude`, the fake one for `fake`. The fake scanner knows
 * the sample accounts of ./sample-accounts.ts (Falcon FPV, a private account, ones that fail), makes
 * each run take {@link FAKE_SCAN_RUN_MS} ÷ `STUDIO_FAKE_SPEED`, and touches no network and no key, so
 * the e2e run and a QA engine on `STUDIO_RUNNER=fake` never spend anything. Throws for a
 * `STUDIO_FAKE_SPEED` that is not a number above 0.
 */
export function createScannerFor(
  config: Pick<Config, 'runner' | 'dataDir'>,
  options: {
    instagram: InstagramRepository;
    clock?: () => Date;
    env?: Record<string, string | undefined>;
  },
): InstagramScanner {
  const { instagram, clock } = options;
  if (config.runner === 'claude') {
    return createInstagramScanner({ instagram, dataDir: config.dataDir, clock });
  }
  return createFakeInstagramScanner({
    instagram,
    dataDir: config.dataDir,
    clock,
    fixtures: sampleInstagramFixtures({ anchor: (clock ?? (() => new Date()))() }),
    delayMs: Math.round(FAKE_SCAN_RUN_MS / (fakeSpeedFromEnv(options.env) ?? 1)),
  });
}
