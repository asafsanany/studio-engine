import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIX_MESSAGES,
  type Job,
  type JobFixesResponse,
  jobSchema,
  type QuickFix,
  type ReviewNote,
  type UndoFixResponse,
} from '@studio/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCanvasServer } from './seed-canvas.js';
import { QUICK_FIX_IDS, QUICK_FIX_JOB_SPECS } from './seed-quick-fixes.js';

// `pnpm seed:canvas --quick-fixes`: eleven jobs in Review, one for each state of the boards QFStates
// and QFEffort, with the real fix service, note routing and routes behind them (fake router, fake
// quick fix), so a note typed in any job goes through for real.

const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
  const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
  await writeFile(join(webDist, 'index.html'), '<!doctype html>');
  stops.push(() => rm(webDist, { recursive: true, force: true }));
  const server = await startCanvasServer({ webDist, quickFixes: true, fixSpeed: 100, ...options });
  stops.push(server.stop);
  const send = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> => {
    const response = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as T };
  };
  const notes = async (id: string) => (await send<ReviewNote[]>('GET', `/jobs/${id}/notes`)).json;
  const fixes = async (id: string) =>
    (await send<JobFixesResponse>('GET', `/jobs/${id}/fixes`)).json.fixes;
  return { server, send, notes, fixes };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('the Quick fixes boards (--quick-fixes)', () => {
  let shared: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    shared = await boot();
  }, 60_000);

  it('has eleven jobs in Review, one for each state of the boards', () => {
    expect(QUICK_FIX_JOB_SPECS).toHaveLength(11);
    expect(new Set(QUICK_FIX_JOB_SPECS.map((spec) => spec.id)).size).toBe(11);
    expect(QUICK_FIX_JOB_SPECS.every((spec) => spec.state === 'review')).toBe(true);
    expect(Object.values(QUICK_FIX_IDS).sort()).toEqual(
      QUICK_FIX_JOB_SPECS.map((spec) => spec.id).sort(),
    );
  });

  it('says so in the health, serves the jobs (every one parses), and keeps the switch off without the option', async () => {
    const { send } = shared;
    expect((await send('GET', '/health')).json).toMatchObject({ quickFixes: true });
    const jobs = (await send<Job[]>('GET', '/jobs')).json;
    expect(jobs).toHaveLength(11);
    for (const job of jobs) expect(jobSchema.safeParse(job).success, job.name).toBe(true);
    expect(jobs.every((job) => job.state === 'review')).toBe(true);
    // Auto for all of them but "Extra high picked".
    expect(jobs.filter((job) => job.reviewEffort !== null).map((job) => job.id)).toEqual([
      QUICK_FIX_IDS.manual,
    ]);
    expect(jobs.find((job) => job.id === QUICK_FIX_IDS.manual)?.reviewEffort).toBe('xhigh');

    const plain = await startCanvasServer({
      webDist: await mkdtemp(join(tmpdir(), 'seed-web-')),
    });
    stops.push(plain.stop);
    expect(
      ((await (await fetch(`${plain.url}/api/health`)).json()) as { quickFixes: boolean })
        .quickFixes,
    ).toBe(false);
    expect((await fetch(`${plain.url}/api/jobs/j1/fixes`)).status).toBe(404);
    expect(shared.server.fixes).not.toBeNull();
    expect(plain.fixes).toBeNull();
  });

  it('has no note on the empty round, and one being read on the next', async () => {
    const { notes, fixes } = shared;
    expect(await notes(QUICK_FIX_IDS.fresh)).toEqual([]);
    const [reading] = await notes(QUICK_FIX_IDS.reading);
    expect(reading).toMatchObject({ atSec: 12, routeStatus: 'pending', route: null, fixId: null });
    expect(await fixes(QUICK_FIX_IDS.reading)).toEqual([]);
  });

  it('has a fix running at step 1, and another at step 2 with the next one waiting', async () => {
    const { fixes } = shared;
    expect(await fixes(QUICK_FIX_IDS.fixing)).toMatchObject([
      { status: 'running', step: 1, stepLabel: 'Changing the caption font', said: null },
    ]);
    expect(await fixes(QUICK_FIX_IDS.queue)).toMatchObject([
      { status: 'running', step: 2, stepLabel: 'Checking it' },
      { status: 'queued', step: null, startedAt: null },
    ]);
  });

  it('has a fixed note with its fix, its before copy and the two Compare stills', async () => {
    const { server, notes, fixes, send } = shared;
    const [fix] = await fixes(QUICK_FIX_IDS.fixed);
    expect(fix).toMatchObject({
      status: 'fixed',
      said: 'The font is Georgia now.',
      durationSec: 38,
      hasCompare: true,
      round: 1,
    });
    const [note] = await notes(QUICK_FIX_IDS.fixed);
    expect(note).toMatchObject({ fixId: fix?.id, route: { tier: 'quick' } });
    expect(note?.fixedAt).toBe(fix?.endedAt);

    const dir = join(server.inboxPath, 'Horizon FPV', 'Fixed');
    const fixDir = join(dir, 'edit', 'review', 'fixes', fix?.id ?? '');
    expect(await exists(join(fixDir, 'before', 'preview', 'index.html'))).toBe(true);
    expect(await exists(join(fixDir, 'before', 'project.md'))).toBe(true);
    // The change is in the live composition, and the copy is how it was.
    const now = await readFile(join(dir, 'edit', 'preview', 'index.html'), 'utf8');
    const before = await readFile(join(fixDir, 'before', 'preview', 'index.html'), 'utf8');
    expect(now).toContain('Georgia');
    expect(before).not.toContain('Georgia');
    expect(before).toContain('"Noto Sans Hebrew"');

    for (const file of ['before.png', 'after.png']) {
      const response = await fetch(
        `${server.url}/api/jobs/${QUICK_FIX_IDS.fixed}/fixes/${fix?.id}/compare/${file}`,
      );
      expect(response.status, file).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    }
    expect((await send('GET', '/jobs/qf-fixed/fixes')).status).toBe(200);
  });

  it('has a round of one fixed note and two that go with Send, routed as the boards say', async () => {
    const { notes, fixes } = shared;
    // The list is by time in the video.
    const list = await notes(QUICK_FIX_IDS.mixed);
    expect(list.map((note) => [note.atSec, note.route?.tier, note.fixId === null])).toEqual([
      [5, 'revise', true],
      [12, 'quick', false],
      [21, 'revise', true],
    ]);
    expect(list.map((note) => note.route?.why)).toEqual([
      'it changes the music',
      '',
      'it changes the cut',
    ]);
    expect((await fixes(QUICK_FIX_IDS.mixed)).map((fix) => fix.status)).toEqual(['fixed']);
  });

  it('has a whole-video note, an escalated fix, an undone one and a level with no sorting', async () => {
    const { notes, fixes } = shared;
    expect((await notes(QUICK_FIX_IDS.full))[0]?.route).toMatchObject({
      tier: 'full',
      why: 'it changes the whole video',
    });
    expect(await fixes(QUICK_FIX_IDS.full)).toEqual([]);

    expect(await fixes(QUICK_FIX_IDS.escalated)).toMatchObject([
      {
        status: 'escalated',
        why: 'the sign is part of the footage',
        said: null,
        hasCompare: false,
      },
    ]);

    expect(await fixes(QUICK_FIX_IDS.undone)).toMatchObject([{ status: 'undone', said: null }]);
    expect((await notes(QUICK_FIX_IDS.undone))[0]).toMatchObject({ fixId: null, fixedAt: null });

    const manual = await notes(QUICK_FIX_IDS.manual);
    expect(manual).toHaveLength(2);
    for (const note of manual) {
      expect(note).toMatchObject({ routeStatus: null, route: null, fixId: null });
    }
    expect(await fixes(QUICK_FIX_IDS.manual)).toEqual([]);
  });

  it('has three fixed notes, one in Hebrew, and the newest fix is the last one that ended', async () => {
    const { notes, fixes } = shared;
    const list = await fixes(QUICK_FIX_IDS.allFixed);
    expect(list.map((fix) => fix.status)).toEqual(['fixed', 'fixed', 'fixed']);
    const all = await notes(QUICK_FIX_IDS.allFixed);
    expect(all.some((note) => /[֐-׿]/.test(note.text ?? ''))).toBe(true);
    expect(all.every((note) => note.fixId !== null)).toBe(true);
    const ends = list.map((fix) => Date.parse(fix.endedAt ?? ''));
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
  });

  it('seeds its own rows: not together with the others', async () => {
    for (const other of ['review', 'series', 'sheet', 'analytics', 'music'] as const) {
      await expect(startCanvasServer({ quickFixes: true, [other]: true })).rejects.toThrow(
        '--quick-fixes seeds its own rows',
      );
    }
  });
});

describe('the Quick fixes seed works for real', () => {
  it('reads a note typed in an empty round, fixes it, and Undo puts the composition back', async () => {
    const { server, send, notes, fixes } = await boot();
    const id = QUICK_FIX_IDS.fresh;
    const dir = join(server.inboxPath, 'Horizon FPV', 'Try it here');
    const original = await readFile(join(dir, 'edit', 'preview', 'index.html'), 'utf8');

    const created = await send<ReviewNote>('POST', `/jobs/${id}/notes`, {
      atSec: 3,
      text: 'Make the captions yellow',
    });
    expect(created.status).toBe(201);

    // The fake router reads it, and it is fixed by the fake quick fix.
    await expect
      .poll(async () => (await fixes(id)).map((fix) => fix.status), { timeout: 15_000 })
      .toEqual(['fixed']);
    const [fix] = (await fixes(id)) as [QuickFix];
    expect(fix).toMatchObject({ said: 'The title is yellow now.', hasCompare: true });
    expect((await notes(id))[0]).toMatchObject({ routeStatus: 'routed', fixId: fix.id });
    expect(await readFile(join(dir, 'edit', 'preview', 'index.html'), 'utf8')).toContain('#ffd60a');

    const undone = await send<UndoFixResponse>('POST', `/jobs/${id}/fixes/${fix.id}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.json.fix.status).toBe('undone');
    expect(await readFile(join(dir, 'edit', 'preview', 'index.html'), 'utf8')).toBe(original);
    expect((await notes(id))[0]).toMatchObject({ fixId: null });
  }, 60_000);

  it('keeps the rows of the running and queued states as seeded, and takes Undo only for the newest fixed fix', async () => {
    const { send, fixes } = await boot();
    // start() ran on an empty table, so the fixes written after it are not failed or cancelled.
    expect((await fixes(QUICK_FIX_IDS.fixing)).map((fix) => fix.status)).toEqual(['running']);
    expect((await fixes(QUICK_FIX_IDS.queue)).map((fix) => fix.status)).toEqual([
      'running',
      'queued',
    ]);

    // All fixed: the oldest fix cannot be undone before the newest.
    const [first, , third] = await fixes(QUICK_FIX_IDS.allFixed);
    const refused = await send<{ error: string }>(
      'POST',
      `/jobs/${QUICK_FIX_IDS.allFixed}/fixes/${first?.id}/undo`,
    );
    expect(refused).toEqual({ status: 409, json: { error: FIX_MESSAGES.notNewest } });
    const ok = await send<UndoFixResponse>(
      'POST',
      `/jobs/${QUICK_FIX_IDS.allFixed}/fixes/${third?.id}/undo`,
    );
    expect(ok.status).toBe(200);
    expect(ok.json.fix).toMatchObject({ status: 'undone' });
    // The Undo moved the fix's end, so the page's rev changes.
    expect(Date.parse(ok.json.fix.endedAt ?? '')).toBeGreaterThan(Date.parse(third?.endedAt ?? ''));
  }, 60_000);
});
