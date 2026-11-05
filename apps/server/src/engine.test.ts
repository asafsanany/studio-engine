import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  analyticsResponseSchema,
  apiErrorSchema,
  clientInstagramSchema,
  clientListResponseSchema,
  createClientResponseSchema,
  healthResponseSchema,
  INSTAGRAM_MESSAGES,
  InvalidTransition,
  type Job,
  jobListResponseSchema,
  jobOutputSchema,
  jobSchema,
  noClientInstagram,
  type ServerEvent,
  STEP_IDS,
  type StepId,
} from '@studio/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeStyleRunner } from './clients/fake-style.js';
import { type Config, loadConfig } from './config.js';
import { InstagramRepository, type StudioDb } from './db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine as createRealEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox, StartInboxOptions } from './inbox/boot.js';
import { DurationCache } from './inbox/probe.js';
import { clientIdFor, scanJob } from './inbox/scan.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { resolveFfmpeg } from './pipeline/fake-media.js';
import { FakeRunner } from './pipeline/fake-runner.js';
import type { Runner } from './pipeline/runner.js';
import { FakeIntervals } from './pipeline/test-utils.js';
import {
  createVoiceTranscriber,
  FAKE_VOICE_TEXT,
  type VoiceTranscriber,
} from './pipeline/voice-transcriber.js';
import { REVIEW_MESSAGES } from './review/review-service.js';
import { injectTimelineRegistry } from './routes/preview.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

/**
 * Every engine of this file boots without the real built-in LUTs: their preview stills (ffmpeg) are
 * written into the temp homes after `stop()` and after the tests removed them (see test-temp.ts).
 */
function createEngine(options: EngineOptions): Engine {
  return createRealEngine({ builtInLuts: noBuiltInLuts(), ...options });
}

// The boot composition on an in-memory database. The runner is always injected: which real
// runners exist changes as E3 and E7 land, and none of these tests may depend on that.

let home: string;
let config: Config;

beforeAll(() => {
  home = makeTempDir('studio-engine-');
  // Review is on by default (W15). These tests are about an edit that ends ready, so the shared
  // config turns the switch off; the Review tests below name it themselves. Quick fixes are on by
  // default too (QF9); notes here go straight to Send, so the shared config turns that off as well.
  config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_REVIEW: '0',
      STUDIO_QUICK_FIXES: '0',
      // These tests start fake runners on a bare engine and read the job the moment it boots: the
      // LUT wrapper (notes naming a LUT, camera log) looks at the footage first, which is its own
      // test file's business (engine-luts.test.ts).
      STUDIO_LUTS_IN_EDITS: '0',
    },
  });
});

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function unavailable(): () => Runner {
  return () => {
    throw new RunnerUnavailableError('claude', 'E3');
  };
}

interface Booted {
  engine: Engine;
  db: StudioDb;
  logger: ReturnType<typeof recordingLogger>;
}

/** An inbox that does nothing: these tests must not start a real file watcher. */
const idleInbox: EngineOptions['startInbox'] = async () => fakeRunningInbox();

function fakeRunningInbox(stop: () => Promise<void> = async () => {}): RunningInbox {
  return {
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
    stop,
  };
}

function boot(createRunner: () => Runner, startInbox = idleInbox): Booted {
  const db = memoryDb();
  const logger = recordingLogger();
  const engine = createEngine({ config, db, logger, createRunner, startInbox });
  return { engine, db, logger };
}

/** Puts a job in the database the way the watcher would, then settles it into the queue. */
function addQueued(engine: Engine, name = 'Spring menu'): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  return engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
}

describe('the Job sheet switch', () => {
  async function jobSheetInHealth(env: Record<string, string>): Promise<boolean> {
    const switched = loadConfig({
      home,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', STUDIO_REVIEW: '0', ...env },
    });
    const engine = createEngine({
      config: switched,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
    });
    try {
      const res = await engine.app.request('/api/health');
      return healthResponseSchema.parse(await res.json()).jobSheet;
    } finally {
      await engine.stop();
    }
  }

  it('is on by default, and /api/health says so', async () => {
    expect(await jobSheetInHealth({})).toBe(true);
  });

  it('is off with STUDIO_JOB_SHEET=0, and /api/health says so', async () => {
    expect(await jobSheetInHealth({ STUDIO_JOB_SHEET: '0' })).toBe(false);
  });
});

describe('the Analytics switch', () => {
  async function withAnalytics<T>(
    env: Record<string, string>,
    run: (engine: Engine) => Promise<T>,
  ): Promise<T> {
    const switched = loadConfig({
      home,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', STUDIO_REVIEW: '0', ...env },
    });
    const engine = createEngine({
      config: switched,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
    });
    try {
      return await run(engine);
    } finally {
      await engine.stop();
    }
  }

  async function healthOf(engine: Engine): Promise<boolean> {
    const res = await engine.app.request('/api/health');
    return healthResponseSchema.parse(await res.json()).analytics;
  }

  it('is on by default: /api/health says so and /api/analytics answers', async () => {
    await withAnalytics({}, async (engine) => {
      expect(await healthOf(engine)).toBe(true);
      const res = await engine.app.request('/api/analytics');
      expect(res.status).toBe(200);
      const body = analyticsResponseSchema.parse(await res.json());
      expect(body.jobs.tiles).toHaveLength(5);
      expect(body.jobs.deliveredPerDay).toHaveLength(91);
    });
  });

  it('is off with STUDIO_ANALYTICS=0: /api/health says so and /api/analytics does not exist', async () => {
    await withAnalytics({ STUDIO_ANALYTICS: '0' }, async (engine) => {
      expect(await healthOf(engine)).toBe(false);
      const res = await engine.app.request('/api/analytics');
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not found' });
    });
  });
});

describe('the Clients × Instagram switch', () => {
  async function withInstagram<T>(
    env: Record<string, string>,
    run: (engine: Engine, db: StudioDb) => Promise<T>,
  ): Promise<T> {
    const switched = loadConfig({
      home,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', STUDIO_REVIEW: '0', ...env },
    });
    const db = memoryDb();
    const engine = createEngine({
      config: switched,
      db,
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
    });
    try {
      return await run(engine, db);
    } finally {
      await engine.stop();
    }
  }

  async function healthOf(engine: Engine): Promise<boolean | undefined> {
    const res = await engine.app.request('/api/health');
    return healthResponseSchema.parse(await res.json()).instagram;
  }

  it('is off with STUDIO_INSTAGRAM=0: /api/health says so and every Instagram route says it is off', async () => {
    await withInstagram({ STUDIO_INSTAGRAM: '0' }, async (engine) => {
      expect(await healthOf(engine)).toBe(false);
      const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
      for (const [method, path] of [
        ['GET', `/api/clients/${job.clientId}/instagram`],
        ['PUT', `/api/clients/${job.clientId}/instagram`],
        ['DELETE', `/api/clients/${job.clientId}/instagram`],
        ['POST', `/api/clients/${job.clientId}/instagram/scan`],
        ['GET', `/api/clients/${job.clientId}/photo`],
        ['POST', '/api/instagram/reels/C9xYz12AbCd/link'],
        ['DELETE', '/api/instagram/reels/C9xYz12AbCd/link'],
      ] as const) {
        const res = await engine.app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(apiErrorSchema.parse(await res.json())).toEqual({
          error: INSTAGRAM_MESSAGES.off,
        });
      }
    });
  });

  it('is on by default: /api/health says so and the client page answers', async () => {
    await withInstagram({}, async (engine) => {
      expect(await healthOf(engine)).toBe(true);
      const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
      const res = await engine.app.request(`/api/clients/${job.clientId}/instagram`);
      expect(res.status).toBe(200);
      expect(clientInstagramSchema.parse(await res.json())).toEqual(noClientInstagram());
    });
  });

  it('links a reel to a delivered job: the job turns Uploaded, and the bus carries both pieces of news (IG5)', async () => {
    await withInstagram({ STUDIO_INSTAGRAM: '1' }, async (engine, db) => {
      const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
      engine.deliveries.record({
        jobId: job.id,
        clientId: job.clientId,
        client: job.client,
        name: job.name,
        relPath: job.relPath,
        deliveredAt: Date.parse('2026-10-19T12:00:00.000Z'),
        price: 40,
        currency: 'ILS',
      });
      const instagram = new InstagramRepository(db);
      const scan = instagram.startScan({ clientId: job.clientId, handle: 'northwind' });
      instagram.upsertReels(scan.id, [
        {
          shortcode: 'C-spring',
          clientId: job.clientId,
          url: 'https://www.instagram.com/reel/C-spring/',
          postedAt: Date.parse('2026-10-20T09:30:00.000Z'),
          plays: 100,
          likes: 10,
          comments: 1,
        },
      ]);
      const events: ServerEvent[] = [];
      engine.bus.subscribe((event) => events.push(event));

      const res = await engine.app.request('/api/instagram/reels/C-spring/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });

      expect(res.status).toBe(200);
      expect(engine.jobs.get(job.id)?.delivery).toMatchObject({
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelUrl: 'https://www.instagram.com/reel/C-spring/',
      });
      expect(events).toEqual([
        { type: 'job.upsert', job: engine.jobs.get(job.id) },
        { type: 'client-instagram', clientId: job.clientId },
      ]);
    });
  });

  it('is on: the client page and the Clients list read the stored account (IG6)', async () => {
    await withInstagram({ STUDIO_INSTAGRAM: '1' }, async (engine, db) => {
      const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
      engine.clientFolders.add('Northwind Bakery');
      const instagram = new InstagramRepository(db);
      instagram.upsertAccount({
        clientId: job.clientId,
        client: 'Northwind Bakery',
        handle: 'northwind.bakery',
      });
      const scan = instagram.startScan({ clientId: job.clientId, handle: 'northwind.bakery' });
      instagram.finishScan(scan.id, { outcome: 'ok', followers: 1_060 });

      const page = clientInstagramSchema.parse(
        await (await engine.app.request(`/api/clients/${job.clientId}/instagram`)).json(),
      );
      expect(page.account?.handle).toBe('northwind.bakery');
      expect(page.numbers?.tiles.followers.now).toBe(1_060);
      expect(page.lastScan).toMatchObject({ outcome: 'ok', followers: 1_060 });

      const list = await (await engine.app.request('/api/clients')).json();
      expect(list).toEqual([
        expect.objectContaining({
          clientId: job.clientId,
          instagram: {
            handle: 'northwind.bakery',
            followers: 1_060,
            weekChange: null,
            oursVsTheirs: null,
            photoAt: null,
          },
        }),
      ]);
    });
  });

  it('is off (STUDIO_INSTAGRAM=0): a client row has no instagram', async () => {
    await withInstagram({ STUDIO_INSTAGRAM: '0' }, async (engine) => {
      engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
      engine.clientFolders.add('Northwind Bakery');
      const list = (await (await engine.app.request('/api/clients')).json()) as Record<
        string,
        unknown
      >[];
      expect(list).toHaveLength(1);
      expect('instagram' in (list[0] ?? {})).toBe(false);
    });
  });
});

describe('the Phone switch', () => {
  async function phoneInHealth(env: Record<string, string>): Promise<boolean> {
    const switched = loadConfig({
      home,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', STUDIO_REVIEW: '0', ...env },
    });
    const engine = createEngine({
      config: switched,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
    });
    try {
      const res = await engine.app.request('/api/health');
      return healthResponseSchema.parse(await res.json()).phone;
    } finally {
      await engine.stop();
    }
  }

  it('is on by default, and /api/health says so', async () => {
    expect(await phoneInHealth({})).toBe(true);
  });

  it('is off with STUDIO_PHONE=0, and /api/health says so', async () => {
    expect(await phoneInHealth({ STUDIO_PHONE: '0' })).toBe(false);
  });
});

describe('when no runner is available', () => {
  it('boots without a worker and says clearly that edits are paused', () => {
    const { engine, logger } = boot(unavailable());

    expect(engine.worker).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0] as [object, string];
    expect(fields).toEqual({ runner: 'claude' });
    expect(message).toContain('Edits are paused');
    expect(message).toContain('"claude" runner is not available yet (E3)');
  });

  it('still serves the API', async () => {
    const { engine } = boot(unavailable());

    const health = await engine.app.request('/api/health');
    const list = await engine.app.request('/api/jobs');

    expect(health.status).toBe(200);
    expect(jobListResponseSchema.parse(await list.json())).toEqual([]);
  });

  it('start and stop do nothing and do not throw', async () => {
    const { engine } = boot(unavailable());

    await expect(engine.start()).resolves.toBeUndefined();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('lets jobs be held, released and cancelled through the repository', async () => {
    const { engine } = boot(unavailable());
    const queued = addQueued(engine, 'One');
    const editing = engine.jobs.applyTransition(addQueued(engine, 'Two').id, { type: 'START' });

    const held = await engine.app.request(`/api/jobs/${queued.id}/hold`, { method: 'POST' });
    const cancelled = await engine.app.request(`/api/jobs/${editing.id}/cancel`, {
      method: 'POST',
    });

    expect(jobSchema.parse(await held.json()).state).toBe('held');
    expect(jobSchema.parse(await cancelled.json()).state).toBe('cancelled');
  });

  it('keeps a queued job queued: nothing runs it', async () => {
    const { engine } = boot(unavailable());
    const job = addQueued(engine);

    await engine.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.jobs.get(job.id)?.state).toBe('queued');
  });
});

describe('when the runner cannot be created for another reason', () => {
  it('still boots, and logs the error', async () => {
    const boom = new Error('claude binary is not executable');
    const { engine, logger } = boot(() => {
      throw boom;
    });

    expect(engine.worker).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      { err: boom, runner: 'claude' },
      expect.stringContaining('Edits are paused'),
    );
    expect((await engine.app.request('/api/jobs')).status).toBe(200);
  });
});

describe('when a runner is available', () => {
  it('has a worker that starts with the engine and edits queued jobs', async () => {
    const started: string[] = [];
    const { engine } = boot(() => ({
      start: async (job) => {
        started.push(job.id);
        return { ok: true };
      },
    }));
    const job = addQueued(engine);
    expect(engine.worker).not.toBeNull();

    await engine.start();
    await engine.worker?.idle();

    expect(started).toEqual([job.id]);
  });

  it('fails a finished run at Render with a readable note when the edit left no final.mp4', async () => {
    const { engine } = boot(() => ({ start: async () => ({ ok: true }) }));
    const job = addQueued(engine);

    await engine.start();
    await engine.worker?.idle();

    const list = jobListResponseSchema.parse(await (await engine.app.request('/api/jobs')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: job.id,
      state: 'failed',
      failedAt: 8,
      error: 'Export failed: The edit finished but there is no edit/final.mp4 to export',
    });
  });

  it('retry through the API wakes the worker, which edits the job again', async () => {
    const calls: Array<{ id: string; mode: string }> = [];
    const { engine } = boot(() => ({
      start: async (job, mode) => {
        calls.push({ id: job.id, mode });
        return { ok: false, error: 'stopped here' };
      },
    }));
    const job = addQueued(engine);
    engine.jobs.applyTransition(job.id, { type: 'START' });
    engine.jobs.applyTransition(job.id, { type: 'FAIL', step: 4, error: 'boom' });
    await engine.start();
    await engine.worker?.idle();
    expect(calls).toEqual([]);

    const res = await engine.app.request(`/api/jobs/${job.id}/retry`, { method: 'POST' });
    await engine.worker?.idle();

    expect(jobSchema.parse(await res.json()).state).toBe('queued');
    expect(calls).toEqual([{ id: job.id, mode: 'retry' }]);
  });

  it('stop aborts the edit in progress and leaves the job editing, for the next boot to resume', async () => {
    let aborted = false;
    const { engine } = boot(() => ({
      start: (_job, _mode, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ ok: false, error: 'killed' });
          });
        }),
    }));
    const job = addQueued(engine);
    await engine.start();
    expect(engine.jobs.get(job.id)?.state).toBe('editing');

    await engine.stop();

    expect(aborted).toBe(true);
    expect(engine.jobs.get(job.id)?.state).toBe('editing');
  });

  it('cancel through the API stops the edit before it answers', async () => {
    let aborted = false;
    const { engine } = boot(() => ({
      start: (_job, _mode, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ ok: false, error: 'killed' });
          });
        }),
    }));
    const job = addQueued(engine);
    await engine.start();

    const res = await engine.app.request(`/api/jobs/${job.id}/cancel`, { method: 'POST' });

    expect(aborted).toBe(true);
    expect(jobSchema.parse(await res.json()).state).toBe('cancelled');
    await engine.stop();
  });

  it('answers errors in the shared shape', async () => {
    const { engine } = boot(unavailable());

    const res = await engine.app.request('/api/jobs/nosuchjob00/hold', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toContain('nosuchjob00');
  });
});

describe('progress (E4)', () => {
  it('gives the runner the logger and a progress tracker hook whose reports reach the job', async () => {
    let hooks: Parameters<NonNullable<EngineOptions['createRunner']>>[1];
    const editDir = join(home, 'tracked-job', 'edit');
    const db = memoryDb();
    const logger = recordingLogger();
    const engine = createEngine({
      config,
      db,
      logger,
      startInbox: idleInbox,
      createRunner: (_config, options) => {
        hooks = options;
        // What the Claude runner does with the hook: one tracker per run, every stream event,
        // stopped once the process has exited.
        return {
          start: async (job, mode, context) => {
            const tracker = options?.track?.({
              job,
              mode,
              jobDir: dirname(editDir),
              editDir,
              pid: 1,
              signal: context.signal,
              progress: context.progress,
            });
            tracker?.onEvent?.({
              kind: 'tool_use',
              raw: {},
              parentToolUseId: null,
              id: 'toolu_1',
              name: 'Bash',
              input: { command: '$P render.py edl.json -o final.mp4' },
            });
            await tracker?.stop?.();
            return { ok: true };
          },
        };
      },
    });
    const seen: Job[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'job.upsert' && event.job.state === 'editing') seen.push(event.job);
    });
    const job = addQueued(engine);

    expect(hooks?.logger).toBe(logger);
    expect(typeof hooks?.track).toBe('function');

    await engine.start();
    await engine.worker?.idle();
    await engine.stop();

    // START (Brief, the engine's own step), then the tracker: Transcribe with the job's 14 videos
    // + 1 audio, then Render.
    expect(seen.filter((j) => j.id === job.id).map((j) => [j.step, j.subProgress])).toEqual([
      [1, null],
      [2, '0/15'],
      [8, null],
    ]);
  });
});

describe('the Brief step (B4)', () => {
  it('runs the Brief step it is given before every edit, with the logger', async () => {
    const order: string[] = [];
    let briefOptions: { logger: unknown } | undefined;
    const logger = recordingLogger();
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger,
      startInbox: idleInbox,
      createRunner: () => ({
        start: async (job) => {
          order.push(`edit ${job.name}`);
          return { ok: true };
        },
      }),
      createBriefStep: (_config, options) => {
        briefOptions = options;
        return {
          prepare: async (job) => {
            order.push(`brief ${job.name}`);
            return { ok: true, source: 'skipped', brief: {} as never };
          },
        };
      },
    });
    addQueued(engine, 'Spring menu');

    await engine.start();
    await engine.worker?.idle();
    await engine.stop();

    expect(briefOptions?.logger).toBe(logger);
    expect(order).toEqual(['brief Spring menu', 'edit Spring menu']);
  });

  it('pauses edits when the Brief step cannot be built: no edit may start without it', () => {
    const logger = recordingLogger();
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger,
      startInbox: idleInbox,
      createRunner: () => ({ start: async () => ({ ok: true }) }),
      createBriefStep: () => {
        throw new Error('STUDIO_FAKE_SPEED must be a number above 0 (got "warp").');
      },
    });

    expect(engine.worker).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runner: 'claude' }),
      'Edits are paused: could not create the Brief step',
    );
  });
});

describe('the ETA (E5)', () => {
  /** Three past jobs of 10 minutes of footage with 60 s in each of the 8 steps: 6 s per footage minute. */
  function seedHistory(db: StudioDb): void {
    const insert = db.sqlite.prepare(
      'insert into step_runs (job_id, step, started_at, ended_at, footage_seconds) values (?, ?, ?, ?, ?)',
    );
    for (const jobId of ['past-a', 'past-b', 'past-c']) {
      for (const step of STEP_IDS) insert.run(jobId, step, 0, 60_000, 600);
    }
  }

  function bootEditing() {
    const clock = fakeClock();
    const timers = new FakeIntervals();
    const db = memoryDb();
    seedHistory(db);
    let progress: ((step: StepId, sub?: string | null) => void) | undefined;
    const engine = createEngine({
      config,
      db,
      logger: recordingLogger(),
      startInbox: idleInbox,
      clock,
      etaTimers: timers,
      createRunner: () => ({
        start: (_job, _mode, context) =>
          new Promise((resolve) => {
            progress = context.progress;
            context.signal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }));
          }),
      }),
    });
    const events: Job[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'job.upsert' && event.job.state === 'editing') events.push(event.job);
    });
    // 5 minutes of footage: 30 s per step.
    const { job } = engine.jobs.upsertFromScan(
      makeScan('Northwind Bakery', 'Launch film', { footageSec: 300 }),
    );
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    return {
      engine,
      clock,
      timers,
      events,
      id: job.id,
      progress: (step: StepId) => progress?.(step),
    };
  }

  it('shows how long an editing job has left, from past runs, over the API', async () => {
    const { engine, id } = bootEditing();
    expect(engine.jobs.get(id)?.etaSec).toBeNull();

    await engine.start();
    const list = jobListResponseSchema.parse(await (await engine.app.request('/api/jobs')).json());

    expect(list.find((job) => job.id === id)).toMatchObject({ state: 'editing', etaSec: 240 });
    await engine.stop();
  });

  it('has no ETA for a job when there is no history yet', async () => {
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      startInbox: idleInbox,
      createRunner: () => ({
        start: (_job, _mode, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }));
          }),
      }),
    });
    const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'First ever'));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    await engine.start();

    expect(engine.jobs.get(job.id)).toMatchObject({ state: 'editing', etaSec: null });
    await engine.stop();
  });

  it('publishes the new estimate on each PROGRESS', async () => {
    const { engine, events, id, progress } = bootEditing();
    await engine.start();

    progress(4);
    await engine.stop();

    expect(events.filter((job) => job.id === id).map((job) => [job.step, job.etaSec])).toEqual([
      [1, 240],
      [4, 150],
    ]);
  });

  it('republishes the editing job every 15 s with the time left, and stops with the engine', async () => {
    const { engine, clock, timers, events, id } = bootEditing();
    expect(timers.active).toEqual([]);

    await engine.start();
    expect(timers.active).toEqual([15_000]);
    events.length = 0;

    clock.tick(15_000);
    timers.fire();
    clock.tick(15_000);
    timers.fire();
    // Nothing moved between two ticks of a stopped clock.
    timers.fire();

    expect(events.map((job) => [job.id, job.etaSec])).toEqual([
      [id, 225],
      [id, 210],
    ]);
    // The estimate changed, the job did not: updatedAt stays.
    expect(new Set(events.map((job) => job.updatedAt)).size).toBe(1);

    await engine.stop();
    expect(timers.active).toEqual([]);
  });

  it('does not tick when edits are paused', async () => {
    const timers = new FakeIntervals();
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      startInbox: idleInbox,
      createRunner: unavailable(),
      etaTimers: timers,
    });

    await engine.start();

    expect(timers.active).toEqual([]);
    await engine.stop();
  });
});

describe('clients (C1)', () => {
  function bootWithOpener(openFolder: (path: string) => Promise<void>): Engine {
    return createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
      openFolder,
    });
  }

  it('serves the style of a client over the API, state none until there is one', async () => {
    const engine = bootWithOpener(async () => {});
    const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));

    const res = await engine.app.request(`/api/clients/${job.clientId}/style`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientId: job.clientId,
      client: 'Northwind Bakery',
      state: 'none',
      version: 0,
      updatedAt: null,
      error: null,
      sourceJobId: null,
      pass: null,
      markdown: null,
    });
  });

  it('serves the style kept in the engine, and exposes the repository for the style runs', async () => {
    const engine = bootWithOpener(async () => {});
    const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    engine.clientStyles.upsert({
      clientId: job.clientId,
      client: 'Northwind Bakery',
      state: 'analysing',
      version: 2,
    });

    const body = (await (
      await engine.app.request(`/api/clients/${job.clientId}/style`)
    ).json()) as {
      state: string;
      version: number;
    };

    expect(body).toMatchObject({ state: 'analysing', version: 2 });
  });

  it('opens the client folder, in the inbox of the config, through the opener it is given', async () => {
    const opened: string[] = [];
    const engine = bootWithOpener(async (path) => {
      opened.push(path);
    });
    const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    mkdirSync(join(config.inboxPath, 'Northwind Bakery'), { recursive: true });

    const res = await engine.app.request(`/api/clients/${job.clientId}/reveal`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(opened).toEqual([join(config.inboxPath, 'Northwind Bakery')]);
  });

  it('answers 404 for a client it does not know', async () => {
    const engine = bootWithOpener(async () => {});

    const res = await engine.app.request('/api/clients/000000000000/style');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toContain('000000000000');
  });

  it('lists every job with its clientId', async () => {
    const engine = bootWithOpener(async () => {});
    engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));

    const [listed] = jobListResponseSchema.parse(
      await (await engine.app.request('/api/jobs')).json(),
    );

    expect(listed?.clientId).toBe('1c9823704bf5');
  });
});

describe('client folders (C12)', () => {
  function bootClients() {
    const clientHome = makeTempDir('studio-engine-clients-');
    const clientConfig = loadConfig({
      home: clientHome,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
    });
    mkdirSync(clientConfig.inboxPath, { recursive: true });
    const engine = createEngine({
      config: clientConfig,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
      openFolder: async () => {},
    });
    const events: ServerEvent[] = [];
    engine.bus.subscribe((event) => events.push(event));
    return {
      engine,
      events,
      inbox: clientConfig.inboxPath,
    };
  }

  it('lists the client folders the engine keeps, with no job needed', async () => {
    const { engine } = bootClients();
    // What the inbox boot does; until then the list waits for it.
    engine.clientFolders.seed(['Empty Client']);

    const res = await engine.app.request('/api/clients');

    expect(res.status).toBe(200);
    expect(clientListResponseSchema.parse(await res.json())).toEqual([
      {
        clientId: clientIdFor('Empty Client'),
        client: 'Empty Client',
        jobs: 0,
        lastJobAt: null,
        style: { state: 'none', updatedAt: null },
        instagram: null,
      },
    ]);
  });

  it('gives a client with no job a style page and a Finder reveal', async () => {
    const { engine, inbox } = bootClients();
    mkdirSync(join(inbox, 'Empty Client', '_Style'), { recursive: true });
    engine.clientFolders.add('Empty Client');
    const id = clientIdFor('Empty Client');

    const style = await engine.app.request(`/api/clients/${id}/style`);
    const reveal = await engine.app.request(`/api/clients/${id}/reveal`, { method: 'POST' });

    expect(style.status).toBe(200);
    expect(reveal.status).toBe(200);
  });

  it('makes a client in the inbox of the config and announces it on the bus', async () => {
    const { engine, events, inbox } = bootClients();

    const res = await engine.app.request('/api/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Kova Coffee' }),
    });

    expect(res.status).toBe(201);
    expect(createClientResponseSchema.parse(await res.json()).client).toBe('Kova Coffee');
    expect(readdirSync(join(inbox, 'Kova Coffee'))).toEqual(['_Style']);
    expect(engine.clientFolders.list()).toEqual(['Kova Coffee']);
    expect(events).toEqual([
      { type: 'client.added', clientId: clientIdFor('Kova Coffee'), client: 'Kova Coffee' },
    ]);
    expect(engine.jobs.getAll()).toEqual([]);
  });

  it('refuses a name the inbox keeps for its exports folder', async () => {
    const { engine, inbox } = bootClients();

    const res = await engine.app.request('/api/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '_Exports' }),
    });

    expect(res.status).toBe(400);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it('hands the inbox the list of client folders to fill and keep', async () => {
    const calls: StartInboxOptions[] = [];
    const { engine } = boot(unavailable(), async (options) => {
      calls.push(options);
      return fakeRunningInbox();
    });

    await engine.start();
    await engine.stop();

    expect(calls[0]?.clientFolders).toBe(engine.clientFolders);
  });
});

describe('client styles (C3)', () => {
  const fastStyles = () => new FakeStyleRunner({ speed: 100 });

  function bootStyles(overrides: Partial<EngineOptions> = {}): Engine {
    return createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      createStyleRunner: fastStyles,
      startInbox: idleInbox,
      ...overrides,
    });
  }

  function styleFolder(client: string, cfg: Config = config): string {
    const dir = join(cfg.inboxPath, client, '_Style');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('runs again, once it starts, the style pass the last engine left analysing', async () => {
    const engine = bootStyles();
    const dir = styleFolder('Kova Coffee');
    writeFileSync(join(dir, 'logo.png'), 'png');
    const { job } = engine.jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    engine.clientStyles.upsert({
      clientId: job.clientId,
      client: 'Kova Coffee',
      state: 'analysing',
      lastPass: { kind: 'read', mode: 'create', files: [{ name: 'logo.png', size: 3 }] },
    });
    const published: string[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'client.upsert')
        published.push(`${event.style.state} v${event.style.version}`);
    });

    await engine.start();
    await engine.styleWorker.idle();
    await engine.stop();

    expect(readFileSync(join(dir, 'style.md'), 'utf8')).toMatch(
      /^# Style: Kova Coffee\nFrom your files: logo.png\./,
    );
    expect(engine.clientStyles.get(job.clientId)).toMatchObject({ state: 'ready', version: 1 });
    expect(published).toEqual(['ready v1']);
  });

  it('takes an upload from the request to style.md', async () => {
    const engine = bootStyles();
    styleFolder('Arc Fitness');
    const { job } = engine.jobs.upsertFromScan(makeScan('Arc Fitness', 'Launch'));
    await engine.start();

    const body = new FormData();
    body.append('files[]', new File(['Bold, loud, fast cuts.'], 'notes.txt'));
    body.append('mode', 'add');
    const res = await engine.app.request(`/api/clients/${job.clientId}/style/files`, {
      method: 'POST',
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'analysing' });
    await engine.styleWorker.idle();
    await engine.stop();

    const style = readFileSync(join(config.inboxPath, 'Arc Fitness', '_Style', 'style.md'), 'utf8');
    expect(style.split('\n').slice(0, 2)).toEqual([
      '# Style: Arc Fitness',
      'From your files: notes.txt.',
    ]);
    expect(engine.clientStyles.get(job.clientId)).toMatchObject({ state: 'ready', version: 1 });
  });

  it('hands the inbox watcher’s style folder events to the Finder drops, which queue a Read pass', async () => {
    const quick = loadConfig({
      home,
      env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', STUDIO_SETTLE_MS: '30' },
    });
    let onStyleEvent: StartInboxOptions['onStyleEvent'];
    const engine = createEngine({
      config: quick,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      createStyleRunner: fastStyles,
      startInbox: async (options) => {
        onStyleEvent = options.onStyleEvent;
        return fakeRunningInbox();
      },
    });
    await engine.start();
    writeFileSync(join(styleFolder('Dropco', quick), 'brand.txt'), 'Use green.');

    onStyleEvent?.({ kind: 'add', client: 'Dropco', path: 'brand.txt' });
    const id = clientIdFor('Dropco');
    for (let i = 0; i < 200 && engine.clientStyles.get(id)?.state !== 'ready'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await engine.stop();

    expect(engine.clientStyles.get(id)).toMatchObject({ state: 'ready', version: 1 });
  });
});

describe('the settle delay (Config.settleMs)', () => {
  /** An engine whose config sets the settle delay, as STUDIO_SETTLE_MS does. */
  function bootWithSettleMs(settleMs: number): Engine {
    const custom = loadConfig({
      home,
      env: {
        STUDIO_MANUAL_START: '0',
        STUDIO_KNOWN_CLIENTS_ONLY: '0',
        STUDIO_SETTLE_MS: String(settleMs),
      },
    });
    return createEngine({
      config: custom,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      startInbox: idleInbox,
    });
  }

  async function listJobs(engine: Engine): Promise<Job[]> {
    return jobListResponseSchema.parse(await (await engine.app.request('/api/jobs')).json());
  }

  it('shows settlesAt that long after the last change, over the API', async () => {
    const engine = bootWithSettleMs(5_000);
    const { job } = engine.jobs.upsertFromScan(makeScan());

    const [listed] = await listJobs(engine);

    expect(listed?.state).toBe('arriving');
    expect(Date.parse(listed?.settlesAt ?? '') - Date.parse(job.lastChangeAt)).toBe(5_000);
  });

  it('tells the web the delay in /api/health', async () => {
    const engine = bootWithSettleMs(5_000);

    const health = (await (await engine.app.request('/api/health')).json()) as { settleMs: number };

    expect(health.settleMs).toBe(5_000);
  });

  it('keeps the 60 s default when the config does not set it', async () => {
    const { engine } = boot(unavailable());
    const { job } = engine.jobs.upsertFromScan(makeScan());

    const [listed] = await listJobs(engine);

    expect(Date.parse(listed?.settlesAt ?? '') - Date.parse(job.lastChangeAt)).toBe(60_000);
  });

  it('lets Release queue a held job that has already settled by the config, over the API', async () => {
    // With a zero delay every held job has settled the moment it is released; with the 60 s
    // default the same job, whose files changed a moment ago, would go back to arriving.
    const engine = bootWithSettleMs(0);
    const { job } = engine.jobs.upsertFromScan(makeScan());
    await engine.app.request(`/api/jobs/${job.id}/hold`, { method: 'POST' });

    const res = await engine.app.request(`/api/jobs/${job.id}/release`, { method: 'POST' });

    expect(jobSchema.parse(await res.json())).toMatchObject({ state: 'queued', settlesAt: null });

    const { engine: byDefault } = boot(unavailable());
    const { job: other } = byDefault.jobs.upsertFromScan(makeScan());
    await byDefault.app.request(`/api/jobs/${other.id}/hold`, { method: 'POST' });
    const resDefault = await byDefault.app.request(`/api/jobs/${other.id}/release`, {
      method: 'POST',
    });
    expect(jobSchema.parse(await resDefault.json()).state).toBe('arriving');
  });
});

describe('the inbox (W3)', () => {
  /** A runner that records what it is asked to edit and keeps editing until aborted. */
  function hangingRunner(log: string[] = []): () => Runner {
    return () => ({
      start: (job, mode, { signal }) =>
        new Promise((resolve) => {
          log.push(`edit ${job.id} ${mode}`);
          signal.addEventListener('abort', () => {
            log.push('worker aborted');
            resolve({ ok: false, error: 'killed' });
          });
        }),
    });
  }

  it('hands the inbox the config, the repository, the engine bus and a logger', async () => {
    const calls: StartInboxOptions[] = [];
    const { engine } = boot(unavailable(), async (options) => {
      calls.push(options);
      return fakeRunningInbox();
    });

    await engine.start();
    await engine.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toBe(config);
    expect(calls[0]?.repo).toBe(engine.jobs);
    expect(calls[0]?.clientStyles).toBe(engine.clientStyles);
    expect(calls[0]?.bus).toBe(engine.bus);
    expect(calls[0]?.logger).toBeDefined();
  });

  it('brings the inbox up first and starts the worker only once it has been reconciled', async () => {
    const order: string[] = [];
    let release!: () => void;
    const reconciled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine } = boot(hangingRunner(order), async () => {
      order.push('inbox starting');
      await reconciled;
      // Still waiting on the disk: the worker has not looked at the queue yet.
      order.push(`job is ${engine.jobs.get(jobId)?.state}`);
      return fakeRunningInbox();
    });
    const jobId = addQueued(engine).id;

    const starting = engine.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['inbox starting']);
    expect(engine.jobs.get(jobId)?.state).toBe('queued');

    release();
    await starting;

    expect(order).toEqual(['inbox starting', 'job is queued', `edit ${jobId} start`]);
    expect(engine.jobs.get(jobId)?.state).toBe('editing');
    await engine.stop();
  });

  it('does not let the worker pick a queued job whose folder vanished, and fails an editing one', async () => {
    const realHome = makeTempDir('studio-engine-restart-');
    try {
      const realConfig = loadConfig({
        home: realHome,
        env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
      });
      mkdirSync(realConfig.inboxPath, { recursive: true });
      const started: Array<{ id: string; mode: string }> = [];
      const engine = createEngine({
        config: realConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () => ({
          start: async (job, mode) => {
            started.push({ id: job.id, mode });
            return { ok: false, error: 'stopped here' };
          },
        }),
      });
      // Both folders were deleted while the engine was down.
      const queued = addQueued(engine, 'Queued and gone');
      const crashed = addQueued(engine, 'Editing and gone');
      engine.jobs.applyTransition(crashed.id, { type: 'START' });
      expect(engine.jobs.getEditing().map((job) => job.id)).toEqual([crashed.id]);

      await engine.start();
      await engine.worker?.idle();

      expect(started).toEqual([]);
      expect(engine.jobs.get(queued.id)).toBeNull();
      expect(engine.jobs.get(crashed.id)).toMatchObject({
        state: 'failed',
        error: 'Folder was removed',
      });
      await engine.stop();
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  it('resumes a job left in editing whose folder is still there, in resume mode', async () => {
    const realHome = makeTempDir('studio-engine-restart-');
    try {
      const realConfig = loadConfig({
        home: realHome,
        env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
      });
      mkdirSync(join(realConfig.inboxPath, 'Northwind Bakery', 'Crashed'), { recursive: true });
      writeFileSync(join(realConfig.inboxPath, 'Northwind Bakery', 'Crashed', 'a.mp4'), 'x');
      const started: Array<{ id: string; mode: string }> = [];
      const engine = createEngine({
        config: realConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () => ({
          start: async (job, mode) => {
            started.push({ id: job.id, mode });
            return { ok: false, error: 'stopped here' };
          },
        }),
      });
      const scan = await scanJob(realConfig.inboxPath, 'Northwind Bakery', 'Crashed', {
        exportsDir: realConfig.exportsDir,
        durations: new DurationCache(async () => null),
      });
      const job = engine.jobs.upsertFromScan(scan as NonNullable<typeof scan>).job;
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.jobs.applyTransition(job.id, { type: 'START' });
      // Past the Brief step: a job still at step 1 has no edit to resume and edits as `start`.
      engine.jobs.applyTransition(job.id, { type: 'PROGRESS', step: 3, sub: null });

      await engine.start();
      await engine.worker?.idle();

      expect(started).toEqual([{ id: job.id, mode: 'resume' }]);
      await engine.stop();
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  it('starts without a worker too: reconciling needs no runner', async () => {
    const startInbox = vi.fn(idleInbox as NonNullable<typeof idleInbox>);
    const { engine } = boot(unavailable(), startInbox);

    await engine.start();
    await engine.stop();

    expect(startInbox).toHaveBeenCalledTimes(1);
  });

  it('stops watching before it stops the edit', async () => {
    const order: string[] = [];
    const { engine } = boot(hangingRunner(order), async () =>
      fakeRunningInbox(async () => {
        order.push('inbox stopped');
      }),
    );
    addQueued(engine);

    await engine.start();
    await engine.stop();

    expect(order.filter((entry) => !entry.startsWith('edit'))).toEqual([
      'inbox stopped',
      'worker aborted',
    ]);
  });

  it('waits for an inbox that is still starting, stops it when it is up, and never starts the worker', async () => {
    let finish!: (inbox: RunningInbox) => void;
    const stopped = vi.fn(async () => {});
    const log: string[] = [];
    const { engine } = boot(
      hangingRunner(log),
      () =>
        new Promise<RunningInbox>((resolve) => {
          finish = resolve;
        }),
    );
    addQueued(engine);
    void engine.start();

    let done = false;
    const stopping = engine.stop().then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);

    finish(fakeRunningInbox(stopped));
    await stopping;

    expect(stopped).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
  });

  it('keeps going, and says so, when the inbox cannot be started', async () => {
    const boom = new Error('inbox is on a drive that is not mounted');
    const started: string[] = [];
    const { engine, logger } = boot(
      () => ({
        start: async (job) => {
          started.push(job.id);
          return { ok: true };
        },
      }),
      async () => {
        throw boom;
      },
    );
    const job = addQueued(engine);

    await expect(engine.start()).resolves.toBeUndefined();
    await engine.worker?.idle();
    await engine.stop();

    expect(started).toEqual([job.id]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, inboxPath: config.inboxPath }),
      expect.stringContaining('The inbox is not being watched'),
    );
  });

  it('asks the worker to stop the edit of a job whose folder was removed', async () => {
    const calls: StartInboxOptions[] = [];
    const log: string[] = [];
    const { engine } = boot(hangingRunner(log), async (options) => {
      calls.push(options);
      return fakeRunningInbox();
    });
    const job = addQueued(engine);
    await engine.start();
    expect(engine.jobs.get(job.id)?.state).toBe('editing');

    // What the watcher does first: the job is failed. Then it calls the hook.
    const failed = engine.jobs.applyTransition(job.id, {
      type: 'FAIL',
      step: 1,
      error: 'Folder was removed',
    });
    calls[0]?.onFolderRemovedWhileEditing?.(failed);
    await engine.worker?.idle();

    expect(log).toContain('worker aborted');
    expect(engine.jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'Folder was removed' });
    await engine.stop();
  });

  it('wakes the worker when the bus announces a queued job', async () => {
    const started: string[] = [];
    const { engine } = boot(() => ({
      start: async (job) => {
        started.push(job.id);
        return { ok: false, error: 'stopped here' };
      },
    }));
    await engine.start();
    await engine.worker?.idle();
    expect(started).toEqual([]);

    // The way the watcher settles a job: through the repository, then onto the bus.
    const job = addQueued(engine);
    engine.bus.publish({ type: 'job.upsert', job });
    await engine.worker?.idle();

    expect(started).toEqual([job.id]);
    await engine.stop();
  });

  it('ignores a queued job announced before the worker starts, and still edits it exactly once', async () => {
    const started: string[] = [];
    let startedWhenAnnounced: string[] | undefined;
    let job!: Job;
    const { engine } = boot(
      () => ({
        start: async (picked) => {
          started.push(picked.id);
          return { ok: false, error: 'stopped here' };
        },
      }),
      async (options) => {
        // The way reconcile and the watcher settle a job: in the repository, then on the bus.
        job = addQueued(engine);
        options.bus.publish({ type: 'job.upsert', job });
        startedWhenAnnounced = [...started];
        return fakeRunningInbox();
      },
    );

    await engine.start();
    await engine.worker?.idle();

    expect(startedWhenAnnounced).toEqual([]);
    expect(started).toEqual([job.id]);
    await engine.stop();
  });

  it('puts what the routes change on the same bus', async () => {
    const { engine } = boot(unavailable());
    const job = addQueued(engine);
    const seen: Job[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'job.upsert') seen.push(event.job);
    });

    await engine.app.request(`/api/jobs/${job.id}/hold`, { method: 'POST' });

    expect(seen.map((j) => [j.id, j.state])).toEqual([[job.id, 'held']]);
  });
});

describe('the live preview', () => {
  it("serves a job's preview from the inbox the config names", async () => {
    const { engine } = boot(unavailable());
    const html = '<!doctype html><p>preview</p>';
    const previewDir = join(config.inboxPath, 'Northwind Bakery', 'Preview', 'edit', 'preview');
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, 'index.html'), html);
    const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Preview'));

    const res = await engine.app.request(`/api/jobs/${job.id}/preview/index.html`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // The root composition is served with the timeline registry first (W2).
    expect(await res.text()).toBe(injectTimelineRegistry(html));
  });
});

describe('review notes (W5)', () => {
  /** A voice transcriber that records what it is asked and never answers. */
  function recordingTranscriber() {
    const transcriber = {
      kind: 'fake' as const,
      enqueue: vi.fn(() => new Promise<{ text: string }>(() => {})),
      stop: vi.fn(async () => {}),
    } satisfies VoiceTranscriber;
    return transcriber;
  }

  function bootReview(
    extra: Partial<EngineOptions> = {},
    createRunner: () => Runner = unavailable(),
  ): Booted {
    const db = memoryDb();
    const logger = recordingLogger();
    const engine = createEngine({
      config,
      db,
      logger,
      createRunner,
      startInbox: idleInbox,
      ...extra,
    });
    return { engine, db, logger };
  }

  /** A job in review, with its folder in the inbox the config names. */
  function addReview(engine: Engine, name: string): Job {
    const queued = addQueued(engine, name);
    engine.jobs.applyTransition(queued.id, { type: 'START' });
    const job = engine.jobs.applyTransition(queued.id, {
      type: 'PREVIEW_READY',
      preview: SAMPLE_PREVIEW,
    });
    mkdirSync(join(config.inboxPath, job.relPath), { recursive: true });
    return job;
  }

  it('wires the Send guard: send-notes without a note answers 409', async () => {
    const { engine } = bootReview();
    const job = addReview(engine, 'Send guard');

    const res = await engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(REVIEW_MESSAGES.noNotesToSend);
  });

  it('wires Approve: it refuses while a note is unsent', async () => {
    const { engine } = bootReview();
    const job = addReview(engine, 'Approve guard');
    engine.review.addTextNote(job.id, { atSec: 1, text: 'Unsent' });

    const res = await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(REVIEW_MESSAGES.sendOrDeleteFirst);
  });

  it('transcribes a voice note uploaded through the API and publishes the done note on the bus', async () => {
    const { engine } = bootReview({
      createTranscriber: () => createVoiceTranscriber({ kind: 'fake', sleep: async () => {} }),
    });
    const job = addReview(engine, 'Voice upload');
    const published: string[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'note.upsert') {
        published.push(`${event.note.transcriptStatus}:${event.note.text ?? '-'}`);
      }
    });
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'v.webm');
    form.append('atSec', '3.5');
    form.append('audioSec', '4');

    const res = await engine.app.request(`/api/jobs/${job.id}/notes/voice`, {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(published).toEqual(['pending:-', `done:${FAKE_VOICE_TEXT}`]);
    });
    expect(engine.notes.listUnsent(job.id)).toMatchObject([
      { transcriptStatus: 'done', text: FAKE_VOICE_TEXT },
    ]);
    await engine.stop();
  });

  it('start() enqueues a pending voice note that was stored before it', async () => {
    const transcriber = recordingTranscriber();
    const { engine } = bootReview({ createTranscriber: () => transcriber });
    const job = addReview(engine, 'Resume voice');
    engine.notes.create({
      id: 'left-over',
      jobId: job.id,
      kind: 'voice',
      atSec: 2,
      audioFile: 'edit/review/voice/left-over.webm',
      audioSec: 3,
    });
    expect(transcriber.enqueue).not.toHaveBeenCalled();

    await engine.start();

    expect(transcriber.enqueue).toHaveBeenCalledTimes(1);
    expect(transcriber.enqueue).toHaveBeenCalledWith({
      audioPath: join(config.inboxPath, job.relPath, 'edit/review/voice/left-over.webm'),
      outDir: join(config.inboxPath, job.relPath, 'edit/review/voice'),
      signal: expect.any(AbortSignal),
    });
    await engine.stop();
  });

  it('start() runs even when edits are paused', async () => {
    const transcriber = recordingTranscriber();
    const { engine } = bootReview({ createTranscriber: () => transcriber }, unavailable());
    const job = addReview(engine, 'Resume paused');
    engine.notes.create({
      id: 'left-over',
      jobId: job.id,
      kind: 'voice',
      atSec: 2,
      audioFile: 'edit/review/voice/left-over.webm',
      audioSec: 3,
    });

    await engine.start();

    expect(engine.worker).toBeNull();
    expect(transcriber.enqueue).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('stop() stops the transcriber once', async () => {
    const transcriber = recordingTranscriber();
    const { engine } = bootReview({ createTranscriber: () => transcriber });
    await engine.start();

    await engine.stop();

    expect(transcriber.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() stops the transcriber even when the worker's stop throws", async () => {
    const transcriber = recordingTranscriber();
    const { engine } = bootReview({ createTranscriber: () => transcriber }, () => ({
      start: async () => ({ ok: true }),
    }));
    await engine.start();
    expect(engine.worker).not.toBeNull();
    vi.spyOn(engine.worker as NonNullable<Engine['worker']>, 'stop').mockRejectedValue(
      new Error('worker would not stop'),
    );

    await expect(engine.stop()).rejects.toThrow('worker would not stop');

    expect(transcriber.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps booting when the transcriber cannot be created: voice notes fail, typed notes work', async () => {
    const { engine, logger } = bootReview({
      createTranscriber: () => {
        throw new Error('bad STUDIO_FAKE_SPEED');
      },
    });
    const job = addReview(engine, 'No transcriber');
    expect(logger.error).toHaveBeenCalledTimes(1);

    const typed = await engine.app.request(`/api/jobs/${job.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atSec: 1, text: 'Typed' }),
    });
    expect(typed.status).toBe(201);
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/webm' }), 'v.webm');
    form.append('atSec', '1');
    form.append('audioSec', '1');
    await engine.app.request(`/api/jobs/${job.id}/notes/voice`, { method: 'POST', body: form });

    await vi.waitFor(() => {
      expect(engine.notes.listUnsent(job.id).map((note) => note.transcriptStatus)).toEqual([
        null,
        'failed',
      ]);
    });
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('exposes the repository and the service', () => {
    const { engine } = bootReview();
    expect(engine.notes.countUnsent('nobody')).toBe(0);
    expect(typeof engine.review.sendNotes).toBe('function');
  });
});

describe('Add to style (W7)', () => {
  // The style runs are the fake style runner; the engine is never started, so a queued pass stays
  // queued and the client stays analysing.
  const CLIENT = 'Dar Bakery';

  function bootAddToStyle(extra: Partial<EngineOptions> = {}): Engine {
    return createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      createStyleRunner: () => new FakeStyleRunner({ speed: 100 }),
      startInbox: idleInbox,
      ...extra,
    });
  }

  /** A job of `CLIENT` in review, with two text notes: the first marked Add to style. */
  async function reviewWithTwoNotes(engine: Engine, name: string) {
    const { job: scanned } = engine.jobs.upsertFromScan(makeScan(CLIENT, name));
    const queued = engine.jobs.applyTransition(scanned.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(queued.id, { type: 'START' });
    const job = engine.jobs.applyTransition(queued.id, {
      type: 'PREVIEW_READY',
      preview: SAMPLE_PREVIEW,
    });
    mkdirSync(join(config.inboxPath, job.relPath), { recursive: true });
    const styled = engine.review.addTextNote(job.id, {
      atSec: 3.5,
      text: 'Titles stay on screen a second longer.',
    });
    const plain = engine.review.addTextNote(job.id, { atSec: 9, text: 'Cut the pause here.' });
    const patched = await engine.app.request(`/api/jobs/${job.id}/notes/${styled.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addToStyle: true }),
    });
    expect(patched.status).toBe(200);
    return { job, styled, plain };
  }

  const send = (engine: Engine, job: Job) =>
    engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' });

  it('writes the marked notes into the client’s _Style and queues a Read pass for them', async () => {
    const engine = bootAddToStyle();
    const { job } = await reviewWithTwoNotes(engine, 'Spring promo');

    const res = await send(engine, job);

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json())).toMatchObject({
      id: job.id,
      state: 'queued',
      round: 1,
    });
    const styleDir = join(config.inboxPath, CLIENT, '_Style');
    const name = 'Review notes – Spring promo – round 1.md';
    expect(readdirSync(styleDir)).toEqual([name]);
    const file = readFileSync(join(styleDir, name), 'utf8');
    expect(file.startsWith('# Review notes from Spring promo (round 1)\n')).toBe(true);
    expect(file).toContain('- 0:03.5 — Titles stay on screen a second longer.');
    expect(file).not.toContain('Cut the pause here.');
    expect(engine.clientStyles.get(clientIdFor(CLIENT))).toMatchObject({
      state: 'analysing',
      lastPass: { kind: 'read', mode: 'create', files: [{ name }] },
    });
  });

  it('uses the hook it is given instead, and writes nothing itself', async () => {
    const styleNotes = { append: vi.fn(async () => {}) };
    const engine = bootAddToStyle({ styleNotes });
    const { job, styled } = await reviewWithTwoNotes(engine, 'Hook promo');

    const res = await send(engine, job);

    expect(res.status).toBe(200);
    expect(styleNotes.append).toHaveBeenCalledTimes(1);
    const [sentJob, sentNotes] = styleNotes.append.mock.calls[0] as unknown as [
      Job,
      { id: string }[],
    ];
    expect(sentJob).toMatchObject({ id: job.id, round: 1 });
    expect(sentNotes.map((note) => note.id)).toEqual([styled.id]);
    expect(
      existsSync(
        join(config.inboxPath, CLIENT, '_Style', 'Review notes – Hook promo – round 1.md'),
      ),
    ).toBe(false);
    expect(engine.clientStyles.get(clientIdFor(CLIENT))?.state).not.toBe('analysing');
  });

  it('still answers 200 when the style can’t take the notes', async () => {
    const engine = bootAddToStyle();
    const { job } = await reviewWithTwoNotes(engine, 'No style folder');
    // _Style is a plain file: nothing can be put in it.
    const dir = join(config.inboxPath, CLIENT, '_Style');
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a folder');

    const res = await send(engine, job);

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json())).toMatchObject({ state: 'queued', round: 1 });
    rmSync(dir, { force: true });
  });
});

describe('the inbox, for real (reconcile, watch, edit)', () => {
  it('finds the folders in the inbox, settles them and hands them to the worker', async () => {
    const realHome = makeTempDir('studio-engine-inbox-');
    try {
      // The edit ends ready, so Review is off (it is on by default).
      const realConfig = loadConfig({
        home: realHome,
        env: {
          STUDIO_MANUAL_START: '0',
          STUDIO_KNOWN_CLIENTS_ONLY: '0',
          STUDIO_SETTLE_MS: '300',
          STUDIO_REVIEW: '0',
        },
      });
      mkdirSync(join(realConfig.inboxPath, 'Northwind Bakery', 'Spring menu'), { recursive: true });
      writeFileSync(join(realConfig.inboxPath, 'Northwind Bakery', 'Spring menu', 'a.mp4'), 'x');
      const engine = createEngine({
        config: realConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () => ({ start: async () => ({ ok: true }) }),
      });

      await engine.start();
      try {
        const deadline = Date.now() + 15_000;
        let job: Job | undefined;
        while (Date.now() < deadline) {
          job = engine.jobs.getAll()[0];
          // Edited by the (stub) runner, which leaves no final.mp4: the export fails at Render.
          if (job?.state === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(job).toMatchObject({
          client: 'Northwind Bakery',
          name: 'Spring menu',
          state: 'failed',
          failedAt: 8,
          error: 'Export failed: The edit finished but there is no edit/final.mp4 to export',
        });
      } finally {
        await engine.stop();
      }
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });
});

// The whole path of a finished edit: the real inbox, the real worker, the fake runner (E7) making
// the edit with ffmpeg, and the real export (E6) putting it in the exports folder.
const haveVideoTools =
  (await resolveFfmpeg('ffmpeg')) !== null && (await resolveFfmpeg('ffprobe')) !== null;

describe('client styles learned from finished jobs (C4)', () => {
  const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };
  let learnHome: string;
  let learnConfig: Config;

  beforeAll(() => {
    learnHome = makeTempDir('studio-engine-learn-');
    // A style is learned from a finished (ready) job, so Review is off (it is on by default).
    learnConfig = loadConfig({
      home: learnHome,
      env: {
        STUDIO_MANUAL_START: '0',
        STUDIO_KNOWN_CLIENTS_ONLY: '0',
        STUDIO_SETTLE_MS: '300',
        STUDIO_REVIEW: '0',
      },
    });
  });

  /** A style runner that records the Learn passes and writes the fake style, fast. */
  function recordingStyles(runs: string[]) {
    const fake = new FakeStyleRunner({ speed: 1_000 });
    return () => ({
      run: async (request: Parameters<FakeStyleRunner['run']>[0]) => {
        if (request.pass.kind === 'learn') runs.push(`${request.client}/${request.pass.job}`);
        return fake.run(request);
      },
    });
  }

  /** A finished job, as the database and the job folder have it. */
  function finished(engine: Engine, client: string, name: string): Job {
    mkdirSync(join(learnConfig.inboxPath, client, name, 'edit'), { recursive: true });
    const { job } = engine.jobs.upsertFromScan(makeScan(client, name));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(job.id, { type: 'START' });
    return engine.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
  }

  it('learns every client’s style from its newest finished job on the first start, and only then', async () => {
    const db = memoryDb();
    const runs: string[] = [];
    const bootOn = () =>
      createEngine({
        config: learnConfig,
        db,
        logger: recordingLogger(),
        createRunner: unavailable(),
        createStyleRunner: recordingStyles(runs),
        startInbox: idleInbox,
      });

    const first = bootOn();
    finished(first, 'Backfill Co', 'Older');
    const newest = finished(first, 'Backfill Co', 'Newest');
    await first.start();
    await first.styleWorker.idle();
    await first.stop();

    expect(runs).toEqual(['Backfill Co/Newest']);
    expect(first.clientStyles.get(newest.clientId)).toMatchObject({
      state: 'ready',
      version: 1,
      sourceJobId: newest.id,
    });

    // The next start has a stored style: no backfill, even with the style.md gone.
    rmSync(join(learnConfig.inboxPath, 'Backfill Co', '_Style', 'style.md'));
    const second = bootOn();
    await second.start();
    await second.styleWorker.idle();
    await second.stop();
    expect(runs).toEqual(['Backfill Co/Newest']);
  });

  it('serves Use this look, Undo and the still over the API', async () => {
    const engine = createEngine({
      config: learnConfig,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      createStyleRunner: recordingStyles([]),
      startInbox: idleInbox,
    });
    const job = finished(engine, 'Look Co', 'Menu');
    const styleFile = join(learnConfig.inboxPath, 'Look Co', '_Style', 'style.md');
    mkdirSync(dirname(styleFile), { recursive: true });
    writeFileSync(styleFile, '# Style: Look Co\nFrom your files: notes.txt.\n');
    engine.clientStyles.upsert({
      clientId: job.clientId,
      client: 'Look Co',
      state: 'ready',
      version: 1,
    });
    await engine.start();

    const used = await engine.app.request(`/api/jobs/${job.id}/use-look`, { method: 'POST' });
    expect(used.status).toBe(200);
    await engine.styleWorker.idle();
    expect(readFileSync(styleFile, 'utf8')).toMatch(/^# Style: Look Co\nLearned from Menu \(/);

    const undone = await engine.app.request(`/api/clients/${job.clientId}/style/undo`, {
      method: 'POST',
    });
    expect(await undone.json()).toMatchObject({ state: 'ready', version: 3, sourceJobId: null });
    expect(readFileSync(styleFile, 'utf8')).toBe('# Style: Look Co\nFrom your files: notes.txt.\n');

    // No export file: no still.
    expect((await engine.app.request(`/api/jobs/${job.id}/still`)).status).toBe(404);
    await engine.stop();
  });

  it('Undo right after Use this look cancels the Learn pass that is still running (C13)', async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const engine = createEngine({
      config: learnConfig,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable(),
      // A Learn run that takes as long as it is let: it ends when it is aborted.
      createStyleRunner: () => ({
        run: (request: Parameters<FakeStyleRunner['run']>[0]) =>
          new Promise((resolve) => {
            signal = request.signal;
            request.signal.addEventListener('abort', () =>
              resolve({ ok: false, error: 'Style stopped: aborted' }),
            );
            started();
          }),
      }),
      startInbox: idleInbox,
    });
    const job = finished(engine, 'Undo Co', 'Menu');
    const styleDir = join(learnConfig.inboxPath, 'Undo Co', '_Style');
    mkdirSync(join(styleDir, 'kit', 'slot_old'), { recursive: true });
    writeFileSync(join(styleDir, 'style.md'), '# Style: Undo Co\nFrom your files: notes.txt.\n');
    writeFileSync(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old graphic');
    engine.clientStyles.upsert({
      clientId: job.clientId,
      client: 'Undo Co',
      state: 'ready',
      version: 1,
    });
    await engine.start();

    const used = await engine.app.request(`/api/jobs/${job.id}/use-look`, { method: 'POST' });
    expect(await used.json()).toMatchObject({ state: 'analysing' });
    await running;
    // The Learn is running: Use this look again is refused, Undo is not.
    const again = await engine.app.request(`/api/jobs/${job.id}/use-look`, { method: 'POST' });
    expect(again.status).toBe(409);

    const undone = await engine.app.request(`/api/clients/${job.clientId}/style/undo`, {
      method: 'POST',
    });

    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ state: 'ready', version: 1, pass: null });
    expect(signal?.aborted).toBe(true);
    expect(engine.clientStyles.get(job.clientId)).toMatchObject({ state: 'ready', version: 1 });
    expect(readFileSync(join(styleDir, 'style.md'), 'utf8')).toBe(
      '# Style: Undo Co\nFrom your files: notes.txt.\n',
    );
    expect(readFileSync(join(styleDir, 'kit', 'slot_old', 'index.html'), 'utf8')).toBe(
      'old graphic',
    );
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
    expect(existsSync(join(styleDir, '.kit-previous'))).toBe(false);
    await engine.styleWorker.idle();
    await engine.stop();
  });

  it.skipIf(!haveVideoTools)(
    'learns the style from every finished job, and the next edit of the client waits for it',
    async () => {
      // An inbox of its own: the real inbox side reads everything in it. One job at a time: with
      // two at once, both jobs of the client start together, before there is a look to learn.
      const ownConfig = loadConfig({
        home: join(learnHome, 'fresh'),
        env: {
          STUDIO_MANUAL_START: '0',
          STUDIO_KNOWN_CLIENTS_ONLY: '0',
          STUDIO_SETTLE_MS: '300',
          STUDIO_REVIEW: '0',
          STUDIO_TWO_JOBS_AT_ONCE: '0',
        },
      });
      const inboxPath = ownConfig.inboxPath;
      for (const name of ['First', 'Second']) {
        mkdirSync(join(inboxPath, 'Fresh Co', name), { recursive: true });
        writeFileSync(join(inboxPath, 'Fresh Co', name, 'clip-01.mp4'), 'x');
      }
      const order: string[] = [];
      const engine = createEngine({
        config: ownConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () => new FakeRunner({ inboxPath, speed: 100_000, clipSeconds: 1 }),
        createStyleRunner: () => new FakeStyleRunner({ speed: 20 }),
      });
      engine.bus.subscribe((event) => {
        if (event.type === 'client.upsert') order.push(`style ${event.style.state}`);
        if (event.type === 'job.upsert' && event.job.state === 'editing' && event.job.step === 1) {
          const entry = `edit ${event.job.name}`;
          if (!order.includes(entry)) order.push(entry);
        }
      });

      await engine.start();
      try {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const states = engine.jobs.getAll().map((job) => job.state);
          const style = engine.clientStyles.get(clientIdFor('Fresh Co'));
          if (states.every((state) => state === 'ready') && style?.version === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await engine.styleWorker.idle();

        const jobs = engine.jobs.getAll();
        expect(jobs.map((job) => job.state)).toEqual(['ready', 'ready']);
        // The job edited first wrote the style; the next edit started only once it had, and its
        // own look was merged in after it.
        const style = engine.clientStyles.get(clientIdFor('Fresh Co'));
        expect(style).toMatchObject({ state: 'ready', version: 2 });
        const second = jobs.find((job) => job.id === style?.sourceJobId) as Job;
        const first = jobs.find((job) => job.id !== second.id) as Job;
        expect(order).toEqual([
          `edit ${first.name}`,
          'style analysing',
          'style ready',
          `edit ${second.name}`,
          'style analysing',
          'style ready',
        ]);
        const styleDir = join(inboxPath, 'Fresh Co', '_Style');
        const [title, source] = readFileSync(join(styleDir, 'style.md'), 'utf8').split('\n');
        expect(title).toBe('# Style: Fresh Co');
        expect(source).toMatch(
          new RegExp(`^Learned from ${first.name} \\(.+\\)\\. Plus ${second.name} \\(.+\\)\\.$`),
        );
        const kit = join(styleDir, 'kit');
        const slots = readdirSync(kit);
        expect(slots.length).toBeGreaterThan(0);
        for (const slot of slots) {
          expect(readdirSync(join(kit, slot))).toContain('index.html');
          expect(readdirSync(join(kit, slot))).not.toContain('render.mov');
        }
        // The first job's kit went to history with the style it came with.
        const history = join(ownConfig.dataDir, 'clients', clientIdFor('Fresh Co'), 'history');
        expect(readdirSync(history).sort()).toEqual(['1-kit', '1.json', '1.md']);
      } finally {
        await engine.stop();
      }
    },
    60_000,
  );
});

// C10: every job that reaches ready adds its look to its client's style, and only an edit of the
// same client waits for that. The jobs are put in the queue in a known order, without the inbox.
describe('every approved video adds its look (C10)', () => {
  let ownHome: string;

  beforeAll(() => {
    ownHome = makeTempDir('studio-engine-c10-');
  });

  /** Queues `<client>/<name>`, with its folder and a clip, one after the other. */
  async function queue(engine: Engine, inboxPath: string, client: string, name: string) {
    mkdirSync(join(inboxPath, client, name), { recursive: true });
    writeFileSync(join(inboxPath, client, name, 'clip-01.mp4'), 'x');
    const { job } = engine.jobs.upsertFromScan(makeScan(client, name));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    // The next one joins the line a moment later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return job;
  }

  async function until(condition: () => boolean, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(condition()).toBe(true);
  }

  it.skipIf(!haveVideoTools)(
    'starts another client’s edit beside a Learn, and holds back only the same client’s next edit',
    async () => {
      // One job at a time, so the line's order is the order the edits start in.
      const ownConfig = loadConfig({
        home: join(ownHome, 'beside'),
        env: {
          STUDIO_MANUAL_START: '0',
          STUDIO_KNOWN_CLIENTS_ONLY: '0',
          STUDIO_REVIEW: '0',
          STUDIO_TWO_JOBS_AT_ONCE: '0',
        },
      });
      const { inboxPath } = ownConfig;
      const order: string[] = [];
      const engine = createEngine({
        config: ownConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () => new FakeRunner({ inboxPath, speed: 100_000, clipSeconds: 1 }),
        // Half a second per style run: long enough to see what goes on beside it.
        createStyleRunner: () => new FakeStyleRunner({ speed: 2 }),
        startInbox: idleInbox,
      });
      engine.bus.subscribe((event) => {
        if (event.type === 'client.upsert' && event.style.state === 'ready') {
          order.push(`style ${event.style.client}`);
        }
        if (event.type === 'job.upsert' && event.job.state === 'editing' && event.job.step === 1) {
          const entry = `edit ${event.job.client}/${event.job.name}`;
          if (!order.includes(entry)) order.push(entry);
        }
      });
      await queue(engine, inboxPath, 'Fresh Co', 'First');
      await queue(engine, inboxPath, 'Other Co', 'Only');
      await queue(engine, inboxPath, 'Fresh Co', 'Second');

      await engine.start();
      try {
        // Every job ready, and the Learn of the last one (queued just after it was) over too.
        const styleOf = (client: string) => engine.clientStyles.get(clientIdFor(client));
        await until(
          () =>
            engine.jobs.getAll().every((job) => job.state === 'ready') &&
            styleOf('Fresh Co')?.version === 2 &&
            styleOf('Fresh Co')?.state === 'ready' &&
            styleOf('Other Co')?.state === 'ready',
        );
        await engine.styleWorker.idle();

        // Other Co's edit went on while Fresh Co's style was learned; Fresh Co's second edit
        // waited for Fresh Co's style only, not for Other Co's.
        expect(order.indexOf('edit Other Co/Only')).toBeLessThan(order.indexOf('style Fresh Co'));
        expect(order.indexOf('style Fresh Co')).toBeLessThan(order.indexOf('edit Fresh Co/Second'));
        expect(order.indexOf('edit Fresh Co/Second')).toBeLessThan(order.indexOf('style Other Co'));
        expect(engine.clientStyles.get(clientIdFor('Fresh Co'))).toMatchObject({
          state: 'ready',
          version: 2,
        });
        expect(engine.clientStyles.get(clientIdFor('Other Co'))).toMatchObject({
          state: 'ready',
          version: 1,
        });
      } finally {
        await engine.stop();
      }
    },
    60_000,
  );

  it.skipIf(!haveVideoTools)(
    'learns nothing from a preview in Review, and learns from the video once it is approved',
    async () => {
      const ownConfig: Config = {
        ...loadConfig({
          home: join(ownHome, 'review'),
          env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
        }),
        review: true,
      };
      const { inboxPath } = ownConfig;
      const styleRuns: string[] = [];
      const fakeStyles = new FakeStyleRunner({ speed: 1_000 });
      const engine = createEngine({
        config: ownConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () =>
          new FakeRunner({ inboxPath, speed: 100_000, clipSeconds: 1, review: true }),
        createStyleRunner: () => ({
          run: async (request) => {
            if (request.pass.kind === 'learn') {
              styleRuns.push(`${request.pass.mode} ${request.pass.job}`);
            }
            return fakeStyles.run(request);
          },
        }),
        startInbox: idleInbox,
      });
      const job = await queue(engine, inboxPath, 'Review Co', 'Menu');

      await engine.start();
      try {
        await until(() => engine.jobs.get(job.id)?.state === 'review');
        await engine.styleWorker.idle();
        expect(styleRuns).toEqual([]);
        expect(engine.clientStyles.get(job.clientId)).toBeNull();

        const approved = await engine.app.request(`/api/jobs/${job.id}/approve`, {
          method: 'POST',
        });
        expect(approved.status).toBe(200);
        await until(() => engine.clientStyles.get(job.clientId)?.state === 'ready');

        expect(engine.jobs.get(job.id)).toMatchObject({ state: 'ready', runKind: 'render' });
        expect(styleRuns).toEqual(['create Menu']);
        expect(engine.clientStyles.get(job.clientId)).toMatchObject({
          version: 1,
          sourceJobId: job.id,
        });
      } finally {
        await engine.stop();
      }
    },
    60_000,
  );
});

describe('a finished edit is exported', () => {
  it.skipIf(!haveVideoTools)(
    'ends ready with the video in _Exports/<Client>/<Job>.mp4 and its facts',
    async () => {
      const realHome = makeTempDir('studio-engine-export-');
      try {
        // The edit ends ready and is exported, so Review is off (it is on by default).
        const realConfig = loadConfig({
          home: realHome,
          env: {
            STUDIO_MANUAL_START: '0',
            STUDIO_KNOWN_CLIENTS_ONLY: '0',
            STUDIO_SETTLE_MS: '300',
            STUDIO_REVIEW: '0',
          },
        });
        // Hebrew names all the way through: the folder, the export, the database, the API.
        const jobDir = join(realConfig.inboxPath, 'לקוח א', 'סרטון אביב');
        mkdirSync(jobDir, { recursive: true });
        writeFileSync(join(jobDir, 'clip-01.mp4'), 'x');
        writeFileSync(join(jobDir, 'voice.m4a'), 'x');
        const engine = createEngine({
          config: realConfig,
          db: memoryDb(),
          logger: recordingLogger(),
          createRunner: () =>
            new FakeRunner({ inboxPath: realConfig.inboxPath, speed: 100_000, clipSeconds: 1 }),
        });

        await engine.start();
        try {
          const deadline = Date.now() + 30_000;
          let job: Job | undefined;
          while (Date.now() < deadline) {
            job = engine.jobs.getAll()[0];
            if (job?.state === 'ready' || job?.state === 'failed') break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          expect(job).toMatchObject({ state: 'ready', error: null, failedAt: null });
          const output = jobOutputSchema.parse(job?.output);
          expect(output).toMatchObject({
            fileName: 'לקוח א/סרטון אביב.mp4',
            width: 360,
            height: 640,
            durationSec: expect.closeTo(1, 1),
          });
          const exported = join(realConfig.exportsDir, 'לקוח א');
          expect(readdirSync(exported)).toEqual(['סרטון אביב.mp4']);
          // A copy, not a move: the edit's own workspace is still in the job folder.
          expect(existsSync(join(jobDir, 'edit', 'final.mp4'))).toBe(true);

          // And the download route serves it.
          const response = await engine.app.request(`/api/jobs/${job?.id}/download`);
          expect(response.status).toBe(200);
          expect((await response.arrayBuffer()).byteLength).toBe(output.sizeBytes);
        } finally {
          await engine.stop();
        }
      } finally {
        rmSync(realHome, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// W2: the Review switch reaches the repository (the machine), the worker and the runner from the
// config. Each test names the one a missed wiring would break.
describe('the Review switch (W2)', () => {
  // The base config is made in beforeAll with the switch off, so a test turns it on when it asks.
  const reviewConfig = (): Config => ({ ...config, review: true });
  const OUTPUT = {
    fileName: 'Northwind Bakery/Spring menu.mp4',
    durationSec: 4,
    width: 360,
    height: 640,
    sizeBytes: 1000,
  };

  function bootWith(cfg: Config, createRunner: (cfg: Config) => Runner): Booted {
    const db = memoryDb();
    const logger = recordingLogger();
    const engine = createEngine({
      config: cfg,
      db,
      logger,
      createRunner: () => createRunner(cfg),
      startInbox: idleInbox,
    });
    return { engine, db, logger };
  }

  it('is on in the default config, and off in the base config of this file', () => {
    expect(
      loadConfig({ home, env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' } })
        .review,
    ).toBe(true);
    expect(config.review).toBe(false);
  });

  it('ends an edit in Review with the preview the runner reports, and exports nothing', async () => {
    const { engine } = bootWith(reviewConfig(), () => ({
      start: async () => ({ ok: true, preview: SAMPLE_PREVIEW }),
    }));
    const job = addQueued(engine);

    await engine.start();
    await engine.worker?.idle();

    const list = jobListResponseSchema.parse(await (await engine.app.request('/api/jobs')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: job.id,
      state: 'review',
      step: 7,
      runKind: 'edit',
      preview: SAMPLE_PREVIEW,
      output: null,
      error: null,
    });
    expect(engine.jobs.getMeta(job.id)?.finishedAt).not.toBeNull();
    await engine.stop();
  });

  it('tells the machine as well: an edit run may not SUCCEED while the switch is on', () => {
    const { engine } = bootWith(reviewConfig(), () => ({ start: async () => ({ ok: true }) }));
    const job = addQueued(engine);
    engine.jobs.applyTransition(job.id, { type: 'START' });

    expect(() => engine.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT })).toThrow(
      InvalidTransition,
    );
  });

  it('with the switch off, an edit run may SUCCEED, and the worker exports', async () => {
    const { engine } = boot(() => ({
      start: async () => ({ ok: true, preview: SAMPLE_PREVIEW }),
    }));
    const first = addQueued(engine, 'First');
    engine.jobs.applyTransition(first.id, { type: 'START' });
    expect(engine.jobs.applyTransition(first.id, { type: 'SUCCEED', output: OUTPUT }).state).toBe(
      'ready',
    );

    // The worker does not look at the preview: a run that says ok exports edit/final.mp4.
    const second = addQueued(engine, 'Second');
    await engine.start();
    await engine.worker?.idle();

    expect(engine.jobs.get(second.id)).toMatchObject({
      state: 'failed',
      failedAt: 8,
      error: 'Export failed: The edit finished but there is no edit/final.mp4 to export',
    });
    await engine.stop();
  });

  it('hands the runner the whole config, switch included', () => {
    const seen: boolean[] = [];
    bootWith(reviewConfig(), (cfg) => {
      seen.push(cfg.review);
      return { start: async () => ({ ok: true }) };
    });
    expect(seen).toEqual([true]);
  });

  it.skipIf(!haveVideoTools)(
    'ends a fake edit in Review with the 6 s sample composition, served with the registry',
    async () => {
      const realHome = makeTempDir('studio-engine-review-');
      try {
        const realConfig = loadConfig({
          home: realHome,
          env: {
            STUDIO_MANUAL_START: '0',
            STUDIO_KNOWN_CLIENTS_ONLY: '0',
            STUDIO_SETTLE_MS: '300',
            STUDIO_REVIEW: '1',
          },
        });
        expect(realConfig.review).toBe(true);
        // Hebrew names all the way through: the folder, the title of the composition, the API.
        const jobDir = join(realConfig.inboxPath, 'לקוח א', 'סרטון אביב');
        mkdirSync(jobDir, { recursive: true });
        writeFileSync(join(jobDir, 'clip-01.mp4'), 'x');
        const engine = createEngine({
          config: realConfig,
          db: memoryDb(),
          logger: recordingLogger(),
          createRunner: (cfg) =>
            new FakeRunner({
              inboxPath: cfg.inboxPath,
              speed: 100_000,
              clipSeconds: 1,
              review: cfg.review,
            }),
        });

        await engine.start();
        try {
          const deadline = Date.now() + 30_000;
          let job: Job | undefined;
          while (Date.now() < deadline) {
            job = engine.jobs.getAll()[0];
            if (job?.state === 'review' || job?.state === 'failed' || job?.state === 'ready') break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          expect(job).toMatchObject({
            state: 'review',
            step: 7,
            error: null,
            output: null,
            preview: { durationSec: 6, width: 1080, height: 1920 },
          });
          expect(existsSync(join(jobDir, 'edit', 'final.mp4'))).toBe(false);
          expect(existsSync(join(jobDir, 'edit', 'preview', 'index.html'))).toBe(true);
          expect(existsSync(realConfig.exportsDir)).toBe(false);

          const page = await engine.app.request(`/api/jobs/${job?.id}/preview/index.html`);
          expect(page.status).toBe(200);
          const html = await page.text();
          expect(html).toContain('<head><script>window.__timelines = window.__timelines || {};');
          expect(html).toContain('<title>סרטון אביב</title>');
        } finally {
          await engine.stop();
        }
      } finally {
        rmSync(realHome, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
