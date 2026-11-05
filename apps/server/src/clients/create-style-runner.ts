import type { Config } from '../config.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { fakeSpeedFromEnv } from '../pipeline/fake-runner.js';
import { ClaudeStyleRunner } from './claude-style.js';
import { FakeStyleRunner } from './fake-style.js';
import type { StyleRunner } from './style-run.js';

/**
 * The style runner `config.runner` names, as `createBriefStep` picks the Brief run: the Claude run
 * for `claude`, the fake one (at `STUDIO_FAKE_SPEED`) for `fake`. Throws for a `STUDIO_FAKE_SPEED`
 * that is not a number above 0.
 */
export function createStyleRunner(
  config: Pick<Config, 'runner' | 'logsDir' | 'dataDir' | 'claudeBin'> &
    Partial<Pick<Config, 'claudePlanOnly'>>,
  options: { logger?: RunnerLogger; env?: Record<string, string | undefined> } = {},
): StyleRunner {
  return config.runner === 'claude'
    ? new ClaudeStyleRunner({ config, logger: options.logger })
    : new FakeStyleRunner({ speed: fakeSpeedFromEnv(options.env) });
}
