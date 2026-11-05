import { healthResponseSchema } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The Quick fixes switch in the boot composition (QF0): off by default, told to the web in
// /api/health, and turned on by STUDIO_QUICK_FIXES=1. QF0 builds only the contract, so the switch
// changes nothing else yet.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-quick-fixes-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

function boot(config: Config): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    builtInLuts: noBuiltInLuts(),
  });
  engines.push(engine);
  return engine;
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the Quick fixes switch in the engine', () => {
  it('is on by default (since QF9), and /api/health says so', async () => {
    const config = tempConfig();
    expect(config.quickFixes).toBe(true);
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ quickFixes: true });
  });

  it('is off with STUDIO_QUICK_FIXES=0, and /api/health says so', async () => {
    const engine = boot(tempConfig({ STUDIO_QUICK_FIXES: '0' }));

    await engine.start();

    expect(await health(engine)).toMatchObject({ quickFixes: false });
  });

  it('moves apart from the other switches', async () => {
    const engine = boot(tempConfig({ STUDIO_QUICK_FIXES: '1', STUDIO_FONTS: '0' }));

    await engine.start();

    expect(await health(engine)).toMatchObject({
      quickFixes: true,
      fonts: false,
      fontsInNotes: true,
      music: true,
    });
  });
});
