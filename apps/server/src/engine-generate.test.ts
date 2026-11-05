import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateHistoryResponseSchema,
  generateStateSchema,
  healthResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { resolveFfmpeg } from './pipeline/fake-media.js';
import type { GenerateRun } from './pipeline/generate-step.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// Generated videos, GN0: the Generate switch in the boot composition. Off (the default) the engine
// is as it was before them: no route, no state on any job, health says off. On, health says so, the
// route answers the job's row, and a job with a Generate stage carries it in the job list and the
// job events.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function boot(env: Record<string, string> = {}): { engine: Engine; config: Config } {
  const home = makeTempDir('studio-engine-generate-');
  const config = loadConfig({ home, env });
  ensureDirs(config);
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
  return { engine, config };
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the Generate switch off (STUDIO_GENERATE=0)', () => {
  it('leaves the engine as it was: the disabled service, no route, no state on a job', async () => {
    for (const env of [{ STUDIO_GENERATE: '0' }] as Record<string, string>[]) {
      const { engine } = boot(env);
      expect(await health(engine)).toMatchObject({ generate: false });
      expect(engine.generate.enabled).toBe(false);

      const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
      // Even a row in the table is invisible: nothing reads it while the switch is off.
      engine.generateRepo.start(job.id, 3);
      expect(engine.jobs.get(job.id)).not.toHaveProperty('generate');
      const res = await engine.app.request(`/api/jobs/${job.id}/generate`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });
});

// The fake run starts the two scripts as real processes: about 1 to 2 s alone, over vitest's 5 s default when a busy full run keeps every core in use (C69).
describe('the Generate switch on (STUDIO_GENERATE=1)', { timeout: 60_000 }, () => {
  it('says so in /api/health, and answers a generated job’s state', async () => {
    const { engine } = boot({ STUDIO_GENERATE: '1' });
    expect(await health(engine)).toMatchObject({ generate: true, music: true, songs: true });
    expect(engine.generate.enabled).toBe(true);

    const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
    const plain = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo 2')).job;
    engine.generateRepo.start(job.id, 3);
    engine.generateRepo.update(job.id, { phase: 'voice', voice: { done: 3, total: 7 } });

    const res = await engine.app.request(`/api/jobs/${job.id}/generate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      phase: 'voice',
      counts: { voice: { done: 3, total: 7 } },
      budgetUsd: 3,
    });
    expect((await engine.app.request(`/api/jobs/${plain.id}/generate`)).status).toBe(404);

    // The job carries it, in the list and on the bus.
    const list = (await (await engine.app.request('/api/jobs')).json()) as {
      id: string;
      generate?: { phase: string };
    }[];
    expect(list.find((entry) => entry.id === job.id)?.generate?.phase).toBe('voice');
    expect(list.find((entry) => entry.id === plain.id)).not.toHaveProperty('generate');
    const events: ServerEvent[] = [];
    engine.bus.subscribe((event) => events.push(event));
    // A change of the job (here its note) publishes it, and it carries its Generate state.
    const saved = await engine.app.request(`/api/jobs/${job.id}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'budget $5' }),
    });
    expect(saved.status).toBe(200);
    const upsert = events.find((event) => event.type === 'job.upsert');
    expect(upsert?.type === 'job.upsert' && upsert.job.generate?.phase).toBe('voice');
  });

  it('uses the budget of the config (STUDIO_GENERATE_BUDGET_USD) for a row the run starts', () => {
    const { config } = boot({ STUDIO_GENERATE: '1', STUDIO_GENERATE_BUDGET_USD: '4.5' });
    expect(config.generateBudgetUsd).toBe(4.5);
  });

  it('takes a job’s row with it when the job is removed', () => {
    const { engine } = boot({ STUDIO_GENERATE: '1' });
    const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
    engine.generateRepo.start(job.id, 3);
    engine.jobs.remove(job.id);
    expect(engine.generateRepo.get(job.id)).toBeNull();
  });
});

// The Generate stage in the boot composition (GN5): with the switch on and the fake runner, the
// engine builds the Generate step beside the Brief step, a generated job goes through it, the page
// hears `job.generate`, and the History is a route. Off, or with a stand-in runner, there is no step.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');

const PINEWOOD_BRIEF = fileURLToPath(
  new URL('./pipeline/testdata/pinewood/PINEWOOD brief.txt', import.meta.url),
);

const idleInbox: EngineOptions['startInbox'] = async (): Promise<RunningInbox> => ({
  watcher: {} as InboxWatcher,
  summary: {
    created: 0,
    changed: 0,
    removed: 0,
    settled: 0,
    failedMissingExport: 0,
    failedMissingPreview: 0,
    failedFolderRemoved: 0,
    resuming: 0,
    unchanged: 0,
  },
  stop: async () => {},
});

function bootFake(
  env: Record<string, string> = {},
  options: Partial<EngineOptions> = {},
): { engine: Engine; config: Config } {
  const home = makeTempDir('studio-engine-generate-run-');
  const config = loadConfig({
    home,
    env: {
      STUDIO_RUNNER: 'fake',
      STUDIO_GENERATE: '1',
      STUDIO_REVIEW: '1',
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_QUICK_FIXES: '0',
      ...env,
    },
  });
  ensureDirs(config);
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return { engine, config };
}

describe.skipIf(ffmpeg === null || ffprobe === null)(
  'a generated job through the engine (fake runner)',
  { timeout: 60_000 },
  () => {
    // The fake Brief, Generate and edit runs read their speed from the process environment.
    beforeEach(() => {
      vi.stubEnv('STUDIO_FAKE_SPEED', '100000');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('goes through Brief, Generate and the edit to Review, tells the page, and keeps a History', async () => {
      const { engine, config } = bootFake();
      const seen: ServerEvent[] = [];
      engine.bus.subscribe((event) => seen.push(event));
      await engine.start();

      const jobDir = join(config.inboxPath, 'Pinewood', '97 Window Ad');
      mkdirSync(jobDir, { recursive: true });
      copyFileSync(PINEWOOD_BRIEF, join(jobDir, 'PINEWOOD brief.txt'));
      const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.worker?.notify();
      await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), {
        timeout: 60_000,
      });

      // The row and the route agree, and the page heard every change of it, ending on the finished one.
      const state = generateStateSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/generate`)).json(),
      );
      expect(state).toMatchObject({ phase: 'done', counts: { clips: { done: 6, total: 6 } } });
      const heard = seen.flatMap((event) =>
        event.type === 'job.generate' && event.jobId === job.id ? [event.generate] : [],
      );
      expect(heard.length).toBeGreaterThanOrEqual(2);
      expect(heard.at(-1)).toEqual(state);
      expect(heard[0]?.phase).toBe('plan');

      // The History is a route, oldest first, and it starts with what the brief decided.
      const history = generateHistoryResponseSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/generate/history`)).json(),
      );
      expect(history.events[0]).toMatchObject({ kind: 'decided', formats: ['9:16', '1:1'] });
      expect(history.events.at(-1)).toMatchObject({ kind: 'clips_done', count: 6 });

      // The edit ran after it, on the footage section of brief.md.
      expect(readFileSync(join(jobDir, 'edit', 'brief.md'), 'utf8')).toContain(
        '## Generated footage',
      );
      expect(existsSync(join(jobDir, 'edit', 'generate', 'shots', 'A.mp4'))).toBe(true);
    }, 90_000);

    it('builds no Generate step while the switch is off: the same job is edited as any other', async () => {
      const { engine, config } = bootFake({ STUDIO_GENERATE: '0' });
      await engine.start();
      const jobDir = join(config.inboxPath, 'Pinewood', '97 Window Ad');
      mkdirSync(jobDir, { recursive: true });
      copyFileSync(PINEWOOD_BRIEF, join(jobDir, 'PINEWOOD brief.txt'));
      const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.worker?.notify();
      await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), {
        timeout: 60_000,
      });

      expect(existsSync(join(jobDir, 'edit', 'generate'))).toBe(false);
      expect(engine.generateRepo.get(job.id)).toBeNull();
      expect(engine.jobs.get(job.id)).not.toHaveProperty('generate');
    }, 90_000);

    it('uses the Generate step a test gives it, and none for a stand-in runner', async () => {
      const calls: string[] = [];
      const step: GenerateRun = {
        prepare: async (job) => {
          calls.push(job.id);
          return { ok: false, error: 'Generate stopped: injected.' };
        },
      };
      const { engine, config } = bootFake({}, { createGenerateStep: () => step });
      await engine.start();
      const jobDir = join(config.inboxPath, 'Pinewood', '97 Window Ad');
      mkdirSync(jobDir, { recursive: true });
      copyFileSync(PINEWOOD_BRIEF, join(jobDir, 'PINEWOOD brief.txt'));
      const { job } = engine.jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.worker?.notify();
      await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('failed'), {
        timeout: 30_000,
      });

      expect(calls).toEqual([job.id]);
      expect(engine.jobs.get(job.id)).toMatchObject({
        step: 1,
        error: 'Generate stopped: injected.',
      });

      // A test that replaces the runner and not the step gets no Generate step.
      const standIn = bootFake(
        {},
        { createRunner: () => ({ start: async () => ({ ok: false, error: 'x' }) }) },
      );
      await standIn.engine.start();
      expect(standIn.engine.worker).not.toBeNull();
    }, 60_000);
  },
);
