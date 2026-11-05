// Picks the graphic runner `config.runner` names, as createStyleRunner does for style runs.
// OWNER: GR2 (GR0 wired the choice).

import type { Config } from '../config.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { fakeSpeedFromEnv } from '../pipeline/fake-runner.js';
import { ClaudeGraphicRunner } from './claude-graphic.js';
import { FakeGraphicRunner } from './fake-graphic-runner.js';
import type { GraphicRunner } from './graphic-run.js';

/**
 * The Claude run for `claude`, the fake one (at `STUDIO_FAKE_SPEED`) for `fake`. Throws for a
 * `STUDIO_FAKE_SPEED` that is not a number above 0.
 */
export function createGraphicRunner(
  config: Pick<Config, 'runner' | 'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin' | 'model'> &
    Partial<Pick<Config, 'claudePlanOnly'>>,
  options: { logger?: RunnerLogger; env?: Record<string, string | undefined> } = {},
): GraphicRunner {
  return config.runner === 'claude'
    ? new ClaudeGraphicRunner({ config, logger: options.logger })
    : new FakeGraphicRunner({ speed: fakeSpeedFromEnv(options.env) });
}
