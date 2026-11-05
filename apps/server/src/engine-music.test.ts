import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  healthResponseSchema,
  type Job,
  MUSIC_FILES,
  MUSIC_MESSAGES,
  MUSIC_NOT_ASKED_REASON,
  type MusicRecord,
  musicPlanSchema,
  musicResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import type { MusicScriptOutcome, MusicScriptRunner } from './music/music-script.js';
import { fixtureRecord, ranOk, readRecordFile, writeRecord } from './music/test-utils.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import type { Runner } from './pipeline/runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';
import { readUsageLog } from './usage/usage-log.js';

// The Soundtrack switch in the boot composition: on by default (U22); off (STUDIO_MUSIC=0) the engine is
// as before Soundtrack (no music service, every music path 404 "Music is off."); on, /api/health says so,
// GET /api/jobs/:id/music reads the job's music.json, and the engine wires the rest: the page hears
// of the music when an edit or revise run ends, every version a run made is logged once in the
// usage log (a fake one never), Approve waits while a version is being made, and what the engine
// runs for a job stops when the job is deleted or the engine stops.

const FIXTURE = fileURLToPath(new URL('./music/testdata/music.json', import.meta.url));

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-music-');
  const config = loadConfig({ home, env });
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
    ...options,
  });
  engines.push(engine);
  return engine;
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the Soundtrack switch on by default (U22)', () => {
  it('is on with nothing set, and /api/health says music and songs', async () => {
    const config = tempConfig({});
    expect(config).toMatchObject({ music: true, songs: true });
    const engine = boot(config);

    expect(await health(engine)).toMatchObject({ music: true, songs: true });
    expect(engine.music).not.toBeNull();
  });
});

describe('the Soundtrack switch off (STUDIO_MUSIC=0)', () => {
  it('leaves the engine as it was: no music service, every music path says music is off', async () => {
    for (const env of [{ STUDIO_MUSIC: '0' }, { STUDIO_MUSIC: '0', STUDIO_SONGS: '1' }] as Record<
      string,
      string
    >[]) {
      const config = tempConfig(env);
      expect(config.music).toBe(false);
      const engine = boot(config);

      expect(await health(engine)).toMatchObject({ music: false });
      expect(engine.music).toBeNull();
      const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
      for (const [method, path] of [
        ['GET', `/api/jobs/${job.id}/music`],
        ['POST', `/api/jobs/${job.id}/music`],
        ['PUT', `/api/jobs/${job.id}/music/pick`],
      ] as const) {
        const res = await engine.app.request(path, { method });
        expect(res.status).toBe(404);
        expect(apiErrorSchema.parse(await res.json())).toEqual({ error: MUSIC_MESSAGES.off });
      }
    }
  });
});

describe('the Soundtrack switch on (STUDIO_MUSIC=1)', () => {
  it('says so in /api/health and reads a job’s music.json', async () => {
    const config = tempConfig({ STUDIO_MUSIC: '1' });
    const engine = boot(config);
    expect(await health(engine)).toMatchObject({ music: true });
    expect(engine.music).not.toBeNull();

    const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
    const res = await engine.app.request(`/api/jobs/${job.id}/music`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();

    const editDir = join(config.inboxPath, job.relPath, 'edit');
    mkdirSync(join(editDir, 'music'), { recursive: true });
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    const view = musicResponseSchema.parse(
      await (await engine.app.request(`/api/jobs/${job.id}/music`)).json(),
    );
    expect(view).toMatchObject({ source: 'made', picked: 'v2', canMake: false, rev: 0 });
    expect(view?.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
  });
});

// --- around the runs ----------------------------------------------------------------------------

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

function musicConfig(env: Record<string, string> = {}): Config {
  return tempConfig({
    STUDIO_MUSIC: '1',
    STUDIO_MANUAL_START: '0',
    STUDIO_KNOWN_CLIENTS_ONLY: '0',
    // Quick fixes are on by default (QF9); the notes here go straight to Send.
    STUDIO_QUICK_FIXES: '0',
    ...env,
  });
}

const editDirOf = (config: Config, job: Pick<Job, 'relPath'>) =>
  join(config.inboxPath, job.relPath, 'edit');

/** When the test's first version was made: a minute ago, so the usage log's lines (made now) are after it. */
const MADE_AT = Date.now() - 60_000;

/** What a script that made `ids` left in music.json (the last one picked), for a run that called it. */
function recordWith(model: string, ids: string[]): MusicRecord {
  const base = fixtureRecord();
  return {
    ...base,
    picked: ids.at(-1) as 'v1',
    versions: ids.map((id, index) => ({
      ...(base.versions[0] as MusicRecord['versions'][number]),
      id: id as 'v1',
      file: `${id}.mp3`,
      model,
      by: index === 0 ? 'edit' : 'revise',
      madeAt: new Date(MADE_AT + index * 1_000).toISOString(),
    })),
    picks: ids.map((id) => ({ id: id as 'v1', at: '2026-10-23T10:00:00.000Z' })),
  };
}

/** Boots an engine whose runs call `onRun` (and end in Review), with the music script held by `musicRunner`. */
async function bootWithRuns(options: {
  onRun?: (job: Job, editDir: string, runs: number) => void;
  musicRunner?: MusicScriptRunner;
  env?: Record<string, string>;
}) {
  const config = musicConfig(options.env);
  let runs = 0;
  const runner: Runner = {
    async start(job) {
      runs += 1;
      const editDir = editDirOf(config, job);
      mkdirSync(editDir, { recursive: true });
      options.onRun?.(job, editDir, runs);
      return { ok: true, preview: SAMPLE_PREVIEW };
    },
  };
  const engine = boot(config, {
    startInbox: idleInbox,
    createRunner: () => runner,
    ...(options.musicRunner === undefined ? {} : { musicRunner: options.musicRunner }),
  });
  const seen: ServerEvent[] = [];
  engine.bus.subscribe((event) => seen.push(event));
  await engine.start();

  mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
  const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.worker?.notify();
  await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
  return { engine, config, job, seen, runs: () => runs };
}

const musicEvents = (seen: ServerEvent[]) =>
  seen.flatMap((event) => (event.type === 'job.music' ? [event] : []));

const usageLines = async (config: Config) =>
  (await readUsageLog(config.dataDir)).filter((entry) => entry.tag === 'music');

/** Sends the notes of a job in review (a revise run follows) and waits until it is in Review again. */
async function reviseOnce(engine: Engine, job: Job) {
  engine.jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
  engine.worker?.notify();
  await vi.waitFor(() => {
    const now = engine.jobs.get(job.id);
    expect(now?.state).toBe('review');
    expect(now?.round).toBe(1);
  });
}

describe('when an edit or revise run ends', () => {
  it('tells the page the job’s music, and again once the job is in Review and may be changed', async () => {
    const { engine, job, seen } = await bootWithRuns({
      onRun: (_job, editDir) => writeRecord(editDir, recordWith('music_v2_5', ['v1'])),
    });
    await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
    await vi.waitFor(() => expect(musicEvents(seen).length).toBeGreaterThanOrEqual(2));

    const events = musicEvents(seen);
    // At the run's end the job is still editing; then it is in Review.
    expect(events[0]).toMatchObject({
      jobId: job.id,
      music: { picked: 'v1', canMake: false, whyNot: MUSIC_MESSAGES.notInReview },
    });
    expect(events.at(-1)).toMatchObject({
      jobId: job.id,
      music: { picked: 'v1', canMake: true, whyNot: null },
    });
    const indexOfReview = seen.findIndex(
      (event) => event.type === 'job.upsert' && event.job.state === 'review',
    );
    const indexOfFirst = seen.findIndex((event) => event.type === 'job.music');
    expect(indexOfFirst).toBeGreaterThan(-1);
    expect(indexOfFirst).toBeLessThan(indexOfReview);
  });

  it('tells the page again after a revise run', async () => {
    const { engine, job, seen } = await bootWithRuns({
      onRun: (_job, editDir, runs) =>
        writeRecord(editDir, recordWith('music_v2_5', runs === 1 ? ['v1'] : ['v1', 'v2'])),
    });
    await vi.waitFor(() => expect(musicEvents(seen).length).toBeGreaterThanOrEqual(2));
    const before = musicEvents(seen).length;

    await reviseOnce(engine, job);

    await vi.waitFor(() => expect(musicEvents(seen).length).toBeGreaterThan(before));
    expect(
      musicEvents(seen)
        .at(-1)
        ?.music?.versions.map((version) => version.id),
    ).toEqual(['v1', 'v2']);
  });

  it('logs a music line for every version a run made, once, whatever the number of runs', async () => {
    const { engine, config, job } = await bootWithRuns({
      onRun: (_job, editDir, runs) =>
        writeRecord(editDir, recordWith('music_v2_5', runs === 1 ? ['v1'] : ['v1', 'v2'])),
    });
    await vi.waitFor(async () => expect(await usageLines(config)).toHaveLength(1));
    expect((await usageLines(config))[0]).toMatchObject({
      source: 'app',
      tag: 'music',
      did: 'Made music v1 for Acme / Spring (0:39)',
      client: 'Acme',
      job: { id: job.id, name: 'Spring' },
      session: null,
      usage: {},
    });

    await reviseOnce(engine, job);

    await vi.waitFor(async () => expect(await usageLines(config)).toHaveLength(2));
    // A beat for a duplicate to show up, if there were going to be one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await usageLines(config)).map((line) => line.did)).toEqual([
      'Made music v1 for Acme / Spring (0:39)',
      'Made music v2 for Acme / Spring (0:39)',
    ]);
  });

  it('logs nothing for music made on the fake path', async () => {
    const { config, job, seen } = await bootWithRuns({
      onRun: (_job, editDir) => writeRecord(editDir, recordWith('fake', ['v1'])),
    });
    await vi.waitFor(() => expect(musicEvents(seen).length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await usageLines(config)).toEqual([]);
    expect(job.id).toBeDefined();
  });

  it('leaves the run and the job alone when there is no music at all', async () => {
    const { engine, config, job, seen } = await bootWithRuns({});
    await vi.waitFor(() => expect(musicEvents(seen).length).toBeGreaterThanOrEqual(1));
    expect(musicEvents(seen)[0]).toEqual({ type: 'job.music', jobId: job.id, music: null });
    expect(engine.jobs.get(job.id)?.state).toBe('review');
    expect(await usageLines(config)).toEqual([]);
  });
});

describe('Make another through the engine', () => {
  /** A script that waits for `release()` and then makes `v3`, or stops when it is told to. */
  function heldScript() {
    const calls: Array<{ argv: readonly string[]; signal?: AbortSignal }> = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const musicRunner: MusicScriptRunner = (call) => {
      calls.push({ argv: call.argv, signal: call.signal });
      return new Promise<MusicScriptOutcome>((resolve) => {
        call.signal?.addEventListener('abort', () =>
          resolve({
            kind: 'stopped',
            reason: call.signal?.reason === 'shutdown' ? 'shutdown' : 'cancel',
          }),
        );
        void held.then(() => {
          const editDir = String(call.argv[1]);
          writeRecord(editDir, recordWith('music_v2_5', ['v1', 'v2', 'v3']));
          resolve(ranOk('v3'));
        });
      });
    };
    return { musicRunner, calls, release: () => release() };
  }

  const onRun = (_job: Job, editDir: string) =>
    writeRecord(editDir, recordWith('music_v2_5', ['v1', 'v2']));

  it('refuses Approve with 409 while a version is being made, and approves when it is done', async () => {
    const script = heldScript();
    const { engine, job, seen, config } = await bootWithRuns({
      onRun,
      musicRunner: script.musicRunner,
    });

    const started = await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    expect(started.status).toBe(202);
    expect(musicResponseSchema.parse(await started.json())).toMatchObject({
      making: { id: 'v3' },
      canMake: false,
      whyNot: 'Music v3 is still being made.',
    });

    const refused = await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(apiErrorSchema.parse(await refused.json())).toEqual({
      error: 'Music v3 is still being made.',
    });
    expect(engine.jobs.get(job.id)?.state).toBe('review');

    script.release();
    await vi.waitFor(() => expect(engine.music?.makingVersion(job.id)).toBeNull());
    await vi.waitFor(() => expect(musicEvents(seen).at(-1)?.music?.picked).toBe('v3'));
    expect(musicEvents(seen).at(-1)?.music).toMatchObject({ making: null, canMake: true });
    // v1 and v2 came with the edit, v3 with Make another: each is logged once.
    await vi.waitFor(async () => expect(await usageLines(config)).toHaveLength(3));
    expect((await usageLines(config)).map((line) => line.did.slice(0, 13))).toEqual([
      'Made music v1',
      'Made music v2',
      'Made music v3',
    ]);

    const approved = await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });
    expect(approved.status).toBe(200);
  });

  it('refuses Send notes with the same 409 while a version is being made, and sends them when it is done', async () => {
    const script = heldScript();
    const { engine, job } = await bootWithRuns({ onRun, musicRunner: script.musicRunner });
    engine.review.addTextNote(job.id, { atSec: 1, text: 'Cut earlier' });
    const send = () => engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' });

    await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    const refused = await send();
    expect(refused.status).toBe(409);
    expect(apiErrorSchema.parse(await refused.json())).toEqual({
      error: 'Music v3 is still being made.',
    });
    expect(engine.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0 });
    expect(engine.review.listNotes(job.id)).toHaveLength(1);

    script.release();
    await vi.waitFor(() => expect(engine.music?.makingVersion(job.id)).toBeNull());
    expect((await send()).status).toBe(200);
    // The revise run is under way (the worker took it at once).
    expect(engine.jobs.get(job.id)).toMatchObject({ runKind: 'revise', round: 1 });
    expect(engine.jobs.get(job.id)?.state).not.toBe('review');
  });

  it('runs `make --again --by you` for the job’s edit folder, with the words', async () => {
    const script = heldScript();
    const { engine, job, config } = await bootWithRuns({ onRun, musicRunner: script.musicRunner });

    await engine.app.request(`/api/jobs/${job.id}/music`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ask: 'darker' }),
    });
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));

    expect(script.calls[0]?.argv).toEqual([
      'make',
      editDirOf(config, job),
      '--again',
      '--ask',
      'darker',
      '--by',
      'you',
    ]);
    script.release();
    await vi.waitFor(() => expect(engine.music?.makingVersion(job.id)).toBeNull());
  });

  it('stops the script before a deleted job’s folder goes', async () => {
    const script = heldScript();
    const { engine, job, config } = await bootWithRuns({ onRun, musicRunner: script.musicRunner });
    await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    const jobDir = join(config.inboxPath, job.relPath);
    expect(existsSync(jobDir)).toBe(true);

    const deleted = await engine.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect(script.calls[0]?.signal?.aborted).toBe(true);
    expect(engine.music?.makingVersion(job.id)).toBeNull();
    expect(existsSync(jobDir)).toBe(false);
  });

  it('stops the script when the engine stops', async () => {
    const script = heldScript();
    const { engine, job } = await bootWithRuns({ onRun, musicRunner: script.musicRunner });
    await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));

    await engine.stop();

    expect(script.calls[0]?.signal?.aborted).toBe(true);
    expect(script.calls[0]?.signal?.reason).toBe('shutdown');
    expect(engine.music?.makingVersion(job.id)).toBeNull();
  });

  it('is refused once the job leaves Review (a revise run is under way)', async () => {
    const script = heldScript();
    const { engine, job } = await bootWithRuns({ onRun, musicRunner: script.musicRunner });
    engine.jobs.applyTransition(job.id, { type: 'SEND_NOTES' });

    const res = await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(MUSIC_MESSAGES.notInReview);
    expect(script.calls).toEqual([]);
  });
});

describe('under the fake runner (STUDIO_RUNNER=fake)', () => {
  it('makes music v1 in the edit when the note asks for music, lets Make another make v2 with the script’s fake path, and logs no usage', async () => {
    vi.stubEnv('STUDIO_FAKE_SPEED', '100000');
    try {
      const config = musicConfig({ STUDIO_RUNNER: 'fake' });
      const engine = boot(config, { startInbox: idleInbox, createRunner: undefined });
      const seen: ServerEvent[] = [];
      engine.bus.subscribe((event) => seen.push(event));
      await engine.start();

      const jobDir = join(config.inboxPath, 'Acme', 'Spring');
      mkdirSync(jobDir, { recursive: true });
      const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
      // Music is made only when the job asks for it (U21): the note does.
      engine.jobs.setNote(job.id, 'Add music with a steady beat.');
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.worker?.notify();
      await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), {
        timeout: 20_000,
      });

      const editDir = join(jobDir, 'edit');
      expect(
        musicPlanSchema.safeParse(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8')))
          .success,
      ).toBe(true);
      const record = readRecordFile(editDir);
      expect(record).toMatchObject({ picked: 'v1', making: null, failure: null });
      expect(record.versions).toHaveLength(1);
      expect(record.versions[0]).toMatchObject({ id: 'v1', model: 'fake', by: 'edit' });
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(true);
      expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
        'src="music.mp3"',
      );

      const view = musicResponseSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/music`)).json(),
      );
      expect(view).toMatchObject({ picked: 'v1', canMake: true, whyNot: null });
      expect(view?.rev).toBeGreaterThan(0);

      // Make another: the script's fake path, no ElevenLabs.
      const made = await engine.app.request(`/api/jobs/${job.id}/music`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ask: 'darker' }),
      });
      expect(made.status).toBe(202);
      await vi.waitFor(() => expect(musicEvents(seen).at(-1)?.music?.picked).toBe('v2'), {
        timeout: 20_000,
      });
      expect(musicEvents(seen).at(-1)?.music).toMatchObject({ making: null, canMake: true });
      expect(readRecordFile(editDir).versions[1]).toMatchObject({
        id: 'v2',
        model: 'fake',
        by: 'you',
        ask: 'darker',
      });

      expect(await usageLines(config)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
});

describe('under the fake runner: a job that asked for no music (U21)', () => {
  it('makes none, keeps a plan so Make music works, and Make music then makes v1', async () => {
    vi.stubEnv('STUDIO_FAKE_SPEED', '100000');
    try {
      const config = musicConfig({ STUDIO_RUNNER: 'fake' });
      const engine = boot(config, { startInbox: idleInbox, createRunner: undefined });
      const seen: ServerEvent[] = [];
      engine.bus.subscribe((event) => seen.push(event));
      await engine.start();

      const jobDir = join(config.inboxPath, 'Acme', 'Quiet');
      mkdirSync(jobDir, { recursive: true });
      const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Quiet'));
      engine.jobs.setNote(job.id, 'Keep the logo at the end.');
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.worker?.notify();
      await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), {
        timeout: 20_000,
      });

      const editDir = join(jobDir, 'edit');
      const record = readRecordFile(editDir);
      expect(record).toMatchObject({
        source: 'none',
        reason: MUSIC_NOT_ASKED_REASON,
        picked: null,
        making: null,
        failure: null,
        versions: [],
      });
      expect(record.plan).not.toBeNull();
      expect(existsSync(join(editDir, 'music', 'v1.mp3'))).toBe(false);
      // The composition still has its music.mp3 (silence) to play.
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(true);
      expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
        'src="music.mp3"',
      );
      expect(readFileSync(join(editDir, 'brief.md'), 'utf8')).toContain('- Music: not asked for');

      // Review can make some: the engine allows it.
      const view = musicResponseSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/music`)).json(),
      );
      expect(view).toMatchObject({
        source: 'none',
        reason: MUSIC_NOT_ASKED_REASON,
        picked: null,
        canMake: true,
        whyNot: null,
      });

      const made = await engine.app.request(`/api/jobs/${job.id}/music`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(made.status).toBe(202);
      await vi.waitFor(() => expect(musicEvents(seen).at(-1)?.music?.picked).toBe('v1'), {
        timeout: 20_000,
      });
      expect(readRecordFile(editDir)).toMatchObject({ source: 'made', reason: null, picked: 'v1' });
      expect(readRecordFile(editDir).versions[0]).toMatchObject({
        id: 'v1',
        by: 'you',
        model: 'fake',
      });
      expect(await usageLines(config)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
});

// Quiet the linter about helpers only some blocks use.
void [copyFileSync, writeFileSync];
