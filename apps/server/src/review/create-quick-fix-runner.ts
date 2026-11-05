// Picks the quick fix runner `config.runner` names, as createGraphicRunner does for graphic runs.
// OWNER: QF2 (the fix service, QF3, calls it).

import type { Config } from '../config.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { fakeSpeedFromEnv } from '../pipeline/fake-runner.js';
import { ClaudeQuickFixRunner } from './claude-quick-fix.js';
import { FakeQuickFixRunner } from './fake-quick-fix.js';
import type { QuickFixRunner } from './quick-fix-run.js';

/**
 * The Claude run for `claude`, the fake one (at `STUDIO_FAKE_SPEED`) for `fake`. Throws for a
 * `STUDIO_FAKE_SPEED` that is not a number above 0.
 */
export function createQuickFixRunner(
  config: Pick<Config, 'runner' | 'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin'> &
    Partial<Pick<Config, 'claudePlanOnly'>>,
  options: { logger?: RunnerLogger; env?: Record<string, string | undefined> } = {},
): QuickFixRunner {
  return config.runner === 'claude'
    ? new ClaudeQuickFixRunner({ config, logger: options.logger, env: options.env })
    : new FakeQuickFixRunner({ config, speed: fakeSpeedFromEnv(options.env) });
}
