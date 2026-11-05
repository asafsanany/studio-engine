import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lutImportResponseSchema, lutStageResponseSchema } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { makeCube, TINT } from './luts/lut-test-utils.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts, noLutPreviews } from './test-temp.js';

// The LUT import in the boot composition (LU1): uploads waiting from before a boot are thrown away,
// the final proof is the engine's to choose, and a stage → import runs through the real engine.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-luts-import-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

function boot(config: Config, options: Partial<EngineOptions> = {}): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    lutPreviews: noLutPreviews(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

describe('LUT uploads at boot', () => {
  it('are thrown away when the engine starts with LUTs on', async () => {
    const config = tempConfig({ STUDIO_LUTS: '1' });
    const left = join(config.dataDir, 'lut-staging', '0123456789ab');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'f0.upload'), 'left from the last run');

    await boot(config).start();

    // the reaper runs without being waited for: give it a moment
    await vi.waitFor(() => expect(existsSync(left)).toBe(false));
  });

  it('are left alone with LUTs off (nothing of LUTs runs)', async () => {
    const config = tempConfig({ STUDIO_LUTS: '0' });
    const left = join(config.dataDir, 'lut-staging', '0123456789ab');
    mkdirSync(left, { recursive: true });

    await boot(config).start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(left)).toBe(true);
  });
});

describe('importing through the engine', () => {
  it('stages and imports a file, with the proof the engine was given', async () => {
    const config = tempConfig({ STUDIO_LUTS: '1' });
    const proved: string[] = [];
    const engine = boot(config, {
      lutProver: async (path) => {
        proved.push(path);
        return null;
      },
    });
    await engine.start();

    const form = new FormData();
    form.append('files[]', new File([makeCube(5, TINT)], 'Golden Hour.cube'));
    const staged = lutStageResponseSchema.parse(
      await (await engine.app.request('/api/luts/stage', { method: 'POST', body: form })).json(),
    );
    const res = await engine.app.request('/api/luts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId: staged.stageId, items: [{ id: 'f0', kind: 'look' }] }),
    });

    expect(res.status).toBe(201);
    const body = lutImportResponseSchema.parse(await res.json());
    expect(body.imported.map((lut) => lut.slug)).toEqual(['golden-hour']);
    expect(proved).toHaveLength(1);
    expect(existsSync(join(config.inboxPath, '_LUTs', 'Golden Hour.cube'))).toBe(true);
  });
});
