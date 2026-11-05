import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientSeriesResponse,
  episodeFrom,
  type GraphicDetail,
  type GraphicMessage,
  type GraphicSummary,
  isArchived,
  type Job,
  type JobStepsResponse,
  jobSchema,
  jobStage,
  type MusicView,
  musicRecordSchema,
  type NoSongStatus,
  type NoteView,
  type ReviewNote,
  relativeTime,
  type SeriesResponse,
  setHomeCurrencySymbol,
  statusDetail,
} from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { injectTimelineRegistry } from '../routes/preview.js';
import {
  CANVAS_JOB_SPECS,
  CANVAS_NOW,
  CANVAS_SERIES_SPECS,
  canvasStoredJobs,
  REVIEW_JOB_SPECS,
  SERIES_JOB_SPECS,
  seedCanvasJobs,
  startCanvasServer,
} from './seed-canvas.js';
import { SHEET_IDS, SHEET_JOB_SPECS, SHEET_NOW } from './seed-job-sheet.js';
import { MUSIC_IDS, MUSIC_JOB_SPECS, MUSIC_RECORDS } from './seed-music.js';
import {
  SONGS_IDS,
  SONGS_JOB_SPECS,
  SONGS_NOTE_PICTURE,
  SONGS_NOTES,
  SONGS_NOW,
  SONGS_RECORDS,
  SONGS_SCREENSHOT,
} from './seed-songs.js';

// The Jobs board lists them in Last updated order, newest first (page one holds the first ten).
const BOARD_ORDER = ['j5', 'j1', 'j2', 'j3', 'j4', 'j10', 'j7', 'j8', 'j6', 'j9', 'j11', 'j12'];

describe('the canvas seed', () => {
  it('has the twelve jobs of the Jobs board, in the states it shows', () => {
    expect(CANVAS_JOB_SPECS).toHaveLength(12);
    const count = (state: Job['state']) => CANVAS_JOB_SPECS.filter((s) => s.state === state).length;
    expect({
      arriving: count('arriving'),
      queued: count('queued'),
      held: count('held'),
      editing: count('editing'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      ready: count('ready'),
    }).toEqual({ arriving: 1, queued: 2, held: 1, editing: 1, failed: 1, cancelled: 1, ready: 5 });
  });

  it('lists them in the board order, with the derived columns the board prints', () => {
    const db = memoryDb();
    seedCanvasJobs(db);
    const repo = new JobRepository(db, { estimateEtaSec: (job) => (job.id === 'j5' ? 420 : null) });
    const jobs = repo.getAll();
    expect(jobs.map((j) => j.id)).toEqual(BOARD_ORDER);

    const byId = new Map(jobs.map((j) => [j.id, j]));
    // "#1 in line" is the Patient testimonial (joined the queue first), "#2" is Class schedule.
    expect(byId.get('j4')?.placeInLine).toBe(1);
    expect(byId.get('j2')?.placeInLine).toBe(2);
    // "settles in 0:42" at the canvas's own moment.
    expect(Date.parse(byId.get('j1')?.settlesAt ?? '') - Date.parse(CANVAS_NOW)).toBe(42_000);
    // "Coach intro reel" is editing at Brief, "~7 min left".
    expect(byId.get('j5')).toMatchObject({ step: 1, subProgress: 'reading 2 files', etaSec: 420 });
    expect(byId.get('j7')?.error).toBe(
      'Brief stopped: Claude Code isn’t signed in on this Mac. Open Terminal, run claude and sign in, then retry.',
    );
    expect(byId.get('j7')).toMatchObject({ failedAt: 1, note: null });
    expect(byId.get('j8')?.stoppedAt).toBe(1);
    // The one note on the board: the held job's, in Hebrew.
    expect(byId.get('j3')?.note).toBe('לפתוח על הצוות, לא על המבנה. עד דקה.');
    expect(byId.get('j6')?.output).toEqual({
      fileName: 'Kova Coffee/השקת תפריט חדש.mp4',
      durationSec: 45,
      width: 1080,
      height: 1920,
      sizeBytes: 62_000_000,
    });
    db.close();
  });

  it('archives three of the twelve: a paid job, a delivered one that is not paid, and a cancelled one', () => {
    const db = memoryDb();
    seedCanvasJobs(db);
    const jobs = new JobRepository(db).getAll();
    const byId = new Map(jobs.map((job) => [job.id, job]));

    // GET /api/jobs lists them all; the web app is what hides the archived ones.
    expect(jobs.map((job) => job.id)).toEqual(BOARD_ORDER);
    expect(
      jobs
        .filter(isArchived)
        .map((job) => job.id)
        .sort(),
    ).toEqual(['j6', 'j8', 'j9']);
    expect(jobStage(byId.get('j6') as Job)).toBe('paid');
    expect(jobStage(byId.get('j9') as Job)).toBe('delivered');
    expect(byId.get('j8')).toMatchObject({ state: 'cancelled', delivery: null });
    expect(byId.get('j6')?.delivery).toMatchObject({
      price: 40,
      currency: 'ILS',
      paidOn: '2026-10-20',
    });
    expect(byId.get('j9')?.delivery).toMatchObject({ price: 40, paidOn: null });
    for (const job of jobs) expect(jobSchema.safeParse(job).success, job.id).toBe(true);
    // The rest stay as the board draws them: not archived, and not delivered.
    for (const job of jobs.filter((j) => !['j6', 'j8', 'j9'].includes(j.id))) {
      expect(job.archivedAt, job.id).toBeNull();
      expect(job.delivery, job.id).toBeNull();
    }
    db.close();
  });

  it('archives them after they were last updated, and moves the archive dates like every time', () => {
    const shift = 3 * 86_400_000;
    const at = canvasStoredJobs(0);
    const moved = canvasStoredJobs(shift);
    for (const [i, job] of at.entries()) {
      if (job.archivedAt === null) {
        expect(moved[i]?.archivedAt).toBeNull();
        continue;
      }
      expect(Date.parse(job.archivedAt)).toBeGreaterThan(Date.parse(job.updatedAt));
      expect(Date.parse(moved[i]?.archivedAt ?? '') - Date.parse(job.archivedAt)).toBe(shift);
    }
  });

  it('moves every time by the same amount, so the ages read the same on any day', () => {
    const shift = 3 * 86_400_000 + 17 * 60_000;
    const at = canvasStoredJobs(0);
    const moved = canvasStoredJobs(shift);
    for (const [i, job] of at.entries()) {
      expect(Date.parse(moved[i]?.addedAt ?? '') - Date.parse(job.addedAt)).toBe(shift);
      expect(Date.parse(moved[i]?.updatedAt ?? '') - Date.parse(job.updatedAt)).toBe(shift);
    }
  });

  it('has the added and last-updated times the board prints at the canvas moment', () => {
    // [Added, Last updated] per job, as the board's tooltips give them (UTC).
    const board: Record<string, [string, string]> = {
      j1: ['2026-10-20T13:41:00.000Z', '2026-10-20T13:41:00.000Z'],
      j2: ['2026-10-20T13:30:00.000Z', '2026-10-20T13:31:00.000Z'],
      j3: ['2026-10-20T13:17:00.000Z', '2026-10-20T13:22:00.000Z'],
      j4: ['2026-10-20T13:11:00.000Z', '2026-10-20T13:12:00.000Z'],
      j5: ['2026-10-20T12:54:00.000Z', '2026-10-20T13:42:00.000Z'],
      j6: ['2026-10-20T07:02:00.000Z', '2026-10-20T07:22:00.000Z'],
      j7: ['2026-10-20T10:42:00.000Z', '2026-10-20T12:07:00.000Z'],
      j8: ['2026-10-20T08:42:00.000Z', '2026-10-20T09:02:00.000Z'],
      j9: ['2026-10-19T13:20:00.000Z', '2026-10-19T13:22:00.000Z'],
      j10: ['2026-10-20T11:57:00.000Z', '2026-10-20T12:32:00.000Z'],
      j11: ['2026-10-18T15:10:00.000Z', '2026-10-18T15:32:00.000Z'],
      j12: ['2026-10-17T10:15:00.000Z', '2026-10-17T08:32:00.000Z'],
    };
    const stored = canvasStoredJobs(0);
    expect(stored.map((j) => [j.id, j.addedAt, j.updatedAt])).toEqual(
      Object.entries(board).map(([id, [added, updated]]) => [id, added, updated]),
    );
  });
});

describe('the canvas seed server', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  it('serves the jobs and a download for a ready one, and starts empty on request', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));

    const server = await startCanvasServer({ now: 'canvas', webDist });
    stops.push(server.stop);
    const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as Job[];
    expect(jobs.map((j) => j.id)).toEqual(BOARD_ORDER);

    const download = await fetch(`${server.url}/api/jobs/j6/download`);
    expect(download.status).toBe(200);
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // The live preview reads from <dir>/inbox, which starts empty: j6 has one once it is put there.
    const previewDir = join(server.inboxPath, 'Kova Coffee', 'השקת תפריט חדש', 'edit', 'preview');
    await mkdir(previewDir, { recursive: true });
    await writeFile(join(previewDir, 'index.html'), '<!doctype html><p>שלום</p>');
    const preview = await fetch(`${server.url}/api/jobs/j6/preview/index.html`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // The root composition is served with the timeline registry first (W2).
    expect(await preview.text()).toBe(injectTimelineRegistry('<!doctype html><p>שלום</p>'));
    const noPreview = await fetch(`${server.url}/api/jobs/j2/preview/index.html`);
    expect(noPreview.status).toBe(404);
    expect(await noPreview.json()).toEqual({ error: 'This job has no preview.' });

    // Hold works through the real routes: the queued job j2 becomes held.
    const held = await fetch(`${server.url}/api/jobs/j2/hold`, { method: 'POST' });
    expect(held.status).toBe(200);
    expect(((await held.json()) as Job).state).toBe('held');

    // Archive and Unarchive work through the real routes, and the seeded archive is in the list.
    expect(
      jobs
        .filter((j) => j.archivedAt !== null)
        .map((j) => j.id)
        .sort(),
    ).toEqual(['j6', 'j8', 'j9']);
    const post = (verb: string, ids: string[]) =>
      fetch(`${server.url}/api/jobs/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    const unarchived = await post('unarchive', ['j6']);
    expect(unarchived.status).toBe(200);
    expect(((await unarchived.json()) as { jobs: Job[] }).jobs[0]).toMatchObject({
      id: 'j6',
      archivedAt: null,
    });
    const archived = await post('archive', ['j12']);
    expect(archived.status).toBe(200);
    const refused = await post('archive', ['j5']);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'Can\'t archive "Coach intro reel" while it is editing.',
    });

    const empty = await startCanvasServer({ empty: true, webDist });
    stops.push(empty.stop);
    expect(await (await fetch(`${empty.url}/api/jobs`)).json()).toEqual([]);
    // Its temp folder is its own and goes away with it.
    await expect(readFile(join(empty.dir, 'canvas.db'))).resolves.toBeDefined();
  });
});

describe('the demo (--demo, `pnpm demo`)', () => {
  it('serves every mock set at once, on dates near today, with every page answering', async () => {
    const server = await startCanvasServer({ demo: true });
    try {
      const get = async (path: string) => {
        const answer = await fetch(`${server.url}${path}`);
        expect(answer.status, path).toBe(200);
        return answer.json();
      };
      const jobs = (await get('/api/jobs')) as Job[];
      for (const id of ['j2', 'p4', 'm5', 'gn-pinewood', 'ig-granite']) {
        expect(jobs.map((job) => job.id)).toContain(id);
      }
      // The Instagram set follows the last Monday, the others the clock: none is far from today.
      const newest = (name: string) => jobs.find((job) => job.name === name)?.addedAt ?? '';
      expect(Date.now() - Date.parse(newest('Granite'))).toBeLessThan(14 * 86_400_000);
      expect(Date.now() - Date.parse(newest('Coach intro reel'))).toBeLessThan(86_400_000);

      const health = (await get('/api/health')) as { currencySymbol?: string; instagram?: boolean };
      expect(health).toMatchObject({ currencySymbol: '$', instagram: true });
      const money = (await get('/api/money')) as { subscriptions: unknown[] };
      expect(money.subscriptions).toHaveLength(3);
      for (const path of [
        '/api/clients',
        '/api/analytics',
        '/api/graphics',
        '/api/luts',
        '/api/fonts',
        '/api/settings',
        '/api/team',
      ]) {
        await get(path);
      }
      expect(await get('/api/clients')).toHaveLength(new Set(jobs.map((job) => job.client)).size);
    } finally {
      await server.stop();
      setHomeCurrencySymbol('₪');
    }
  }, 30_000);
});

describe('the Phase 3 rows (--review)', () => {
  const REVIEW_ORDER = ['p4', 'p3', 'p1', 'p2', 'p5'];

  it('has five jobs in the states of the P3Rows board', () => {
    expect(REVIEW_JOB_SPECS.map((spec) => [spec.id, spec.state, spec.runKind ?? 'edit'])).toEqual([
      ['p1', 'review', 'edit'],
      ['p2', 'review', 'revise'],
      ['p3', 'editing', 'revise'],
      ['p4', 'editing', 'render'],
      ['p5', 'ready', 'render'],
    ]);
  });

  it('seeds through the repository and every job parses with the shared schema', () => {
    const db = memoryDb();
    seedCanvasJobs(db, 0, REVIEW_JOB_SPECS);
    const repo = new JobRepository(db, {
      estimateEtaSec: (job) => REVIEW_JOB_SPECS.find((spec) => spec.id === job.id)?.etaSec ?? null,
    });
    const jobs = repo.getAll();
    expect(jobs.map((job) => job.id)).toEqual(REVIEW_ORDER);
    for (const job of jobs) expect(jobSchema.safeParse(job).success, job.id).toBe(true);

    const byId = new Map(jobs.map((job) => [job.id, job]));
    // "0:06 · 1080×1920" and, on the second cut (one round of notes sent), "0:06 · 1920×1080 · round 2".
    expect(statusDetail(byId.get('p1') as Job, CANVAS_NOW)).toBe('0:06 · 1080×1920');
    expect(statusDetail(byId.get('p2') as Job, CANVAS_NOW)).toBe('0:06 · 1920×1080 · round 2');
    // The revise run is at Cut, "round 2 · ~4 min left"; the render run is at step 8, approved.
    expect(byId.get('p3')).toMatchObject({
      runKind: 'revise',
      round: 1,
      step: 5,
      subProgress: 'graphics 2/5',
      etaSec: 240,
    });
    expect(byId.get('p4')).toMatchObject({ runKind: 'render', round: 1, step: 8, etaSec: 180 });
    expect(byId.get('p4')?.approvedAt).toBe('2026-10-20T13:41:30.000Z');
    expect(byId.get('p5')).toMatchObject({
      runKind: 'render',
      approvedAt: '2026-10-20T12:20:00.000Z',
    });
    expect(byId.get('p5')?.output).toEqual({
      fileName: 'Lumen Dental/Customer story · Dana.mp4',
      durationSec: 45,
      width: 1080,
      height: 1920,
      sizeBytes: 62_000_000,
    });
    db.close();
  });

  it('keeps the twelve jobs exactly as they were without the option', () => {
    expect(
      canvasStoredJobs(0).map((job) => [job.runKind, job.round, job.preview, job.approvedAt]),
    ).toEqual(CANVAS_JOB_SPECS.map(() => ['edit', 0, null, null]));
  });

  it('serves the five jobs and a playable preview for each job in Review', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, review: true });
    try {
      const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as Job[];
      expect(jobs.map((job) => job.id)).toEqual(REVIEW_ORDER);

      const p1 = await fetch(`${server.url}/api/jobs/p1/preview/index.html?r=0`);
      expect(p1.status).toBe(200);
      expect(p1.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const html = await p1.text();
      expect(html).toContain('פרומו לסוף השבוע');
      expect(html).not.toContain('Sample preview');
      expect(html).toContain('data-width="1080" data-height="1920"');

      // The 16:9 job: the copy is turned around, in the page and in the badge it loads.
      const p2 = await (await fetch(`${server.url}/api/jobs/p2/preview/index.html?r=1`)).text();
      expect(p2).toContain('Studio tour');
      expect(p2).toContain('data-width="1920" data-height="1080"');
      expect(p2).toContain('width: 1920px; height: 1080px;');
      expect(p2).not.toContain('width: 1080px; height: 1920px;');
      const badge = await (
        await fetch(`${server.url}/api/jobs/p2/preview/compositions/badge.html`)
      ).text();
      expect(badge).toContain('data-width="1920" data-height="1080"');

      // The video answers a range request, as the player's seeks need.
      const cut = await fetch(`${server.url}/api/jobs/p1/preview/cut.mp4`, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(cut.status).toBe(206);
      expect((await cut.arrayBuffer()).byteLength).toBe(10);

      // The jobs that are not in Review have no composition.
      expect((await fetch(`${server.url}/api/jobs/p3/preview/index.html`)).status).toBe(404);
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('serves the notes, Send notes and Approve, so the Review dialog can be tried by hand', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, review: true });
    const post = (path: string, body?: unknown) =>
      fetch(`${server.url}/api/jobs/${path}`, {
        method: 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      // A typed note joins the list.
      const added = await post('p1/notes', { atSec: 1.2, text: 'שלום' });
      expect(added.status).toBe(201);
      const note = (await added.json()) as ReviewNote;
      expect(note).toMatchObject({ atSec: 1.2, text: 'שלום', kind: 'text', round: null });
      const listed = (await (
        await fetch(`${server.url}/api/jobs/p1/notes`)
      ).json()) as ReviewNote[];
      expect(listed.map((existing) => existing.id)).toEqual([note.id]);

      // Approve is refused while a note is unsent; Send queues a revise run at round 1.
      const refused = await post('p1/approve');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'Send or delete your notes first.' });
      const sent = await post('p1/send-notes');
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({
        id: 'p1',
        state: 'queued',
        runKind: 'revise',
        round: 1,
      });
      const roundFile = join(
        server.inboxPath,
        'מאפיית הצפון',
        'פרומו לסוף השבוע',
        'edit',
        'review',
        'round-1.md',
      );
      expect(await readFile(roundFile, 'utf8')).toContain('שלום');
      expect(await (await fetch(`${server.url}/api/jobs/p1/notes`)).json()).toMatchObject({
        error: 'Notes can only be changed while the job is in Review.',
      });

      // Approve, with no notes, queues the render run.
      const approved = await post('p2/approve');
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ id: 'p2', state: 'queued', runKind: 'render' });
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('transcribes a voice note with the fake transcriber, and stop() waits for nothing', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, review: true });
    try {
      const form = new FormData();
      form.set('audio', new Blob([Buffer.alloc(2048)], { type: 'audio/webm' }), 'note.webm');
      form.set('atSec', '2.8');
      form.set('audioSec', '4');
      const added = await fetch(`${server.url}/api/jobs/p1/notes/voice`, {
        method: 'POST',
        body: form,
      });
      expect(added.status).toBe(201);
      const note = (await added.json()) as ReviewNote;
      expect(note).toMatchObject({ kind: 'voice', transcriptStatus: 'pending' });

      // The fake transcript arrives after about a second.
      let latest = note;
      for (let tries = 0; tries < 40 && latest.transcriptStatus === 'pending'; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const listed = (await (
          await fetch(`${server.url}/api/jobs/p1/notes`)
        ).json()) as ReviewNote[];
        latest = listed.find((existing) => existing.id === note.id) ?? latest;
      }
      expect(latest).toMatchObject({
        transcriptStatus: 'done',
        text: '[voice note, fake transcript]',
      });
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('writes nothing to the inbox for the twelve jobs', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist });
    try {
      expect((await fetch(`${server.url}/api/jobs/j6/preview/index.html`)).status).toBe(404);
      await expect(readFile(join(server.inboxPath, 'Kova Coffee'))).rejects.toBeDefined();
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });
});

describe('the Series boards (--series)', () => {
  it('has the eight rows of the SeriesJobs board, in the states it shows', () => {
    const count = (state: Job['state']) =>
      SERIES_JOB_SPECS.filter((spec) => spec.state === state).length;
    expect(SERIES_JOB_SPECS).toHaveLength(8);
    expect({
      queued: count('queued'),
      editing: count('editing'),
      review: count('review'),
      ready: count('ready'),
    }).toEqual({ queued: 3, editing: 1, review: 1, ready: 3 });
  });

  it('has the client’s two series, each with its format at episode 5 and the episodes by number', () => {
    expect(
      CANVAS_SERIES_SPECS.map((spec) => [
        spec.name,
        spec.formatJobId,
        spec.episodes.map((episode) => episode.episode),
      ]),
    ).toEqual([
      ['מיתוס או אמת', 'm5', [5, 6, 7, 8]],
      ['שאלות נפוצות', 'f5', [5, 6]],
    ]);
    for (const spec of CANVAS_SERIES_SPECS) {
      for (const episode of spec.episodes) {
        const job = SERIES_JOB_SPECS.find((candidate) => candidate.id === episode.jobId);
        expect(episodeFrom(job?.name ?? ''), episode.jobId).toBe(episode.episode);
      }
    }
  });

  it('serves the two series, their episodes and series.md, with the Series switch on', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, series: true });
    try {
      expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
        series: true,
      });

      const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as Job[];
      expect(jobs.map((job) => job.id).sort()).toEqual(
        SERIES_JOB_SPECS.map((spec) => spec.id).sort(),
      );
      const byId = new Map(jobs.map((job) => [job.id, job]));
      const clientId = byId.get('m5')?.clientId ?? '';
      const listed = (await (
        await fetch(`${server.url}/api/clients/${clientId}/series`)
      ).json()) as ClientSeriesResponse;
      expect(listed.series.map((s) => [s.name, s.episodeCount, s.state, s.formatJob])).toEqual([
        ['מיתוס או אמת', 4, 'ready', 'מיתוס או אמת 5'],
        ['שאלות נפוצות', 2, 'ready', 'שאלות נפוצות 5'],
      ]);

      // Each series page reads its series.md from the seed inbox.
      for (const [name, formatJobId] of [
        ['מיתוס או אמת', 'm5'],
        ['שאלות נפוצות', 'f5'],
      ] as const) {
        const seriesId = listed.series.find((s) => s.name === name)?.id ?? '';
        const detail = (await (
          await fetch(`${server.url}/api/series/${seriesId}`)
        ).json()) as SeriesResponse;
        expect(detail.series).toMatchObject({
          name,
          state: 'ready',
          formatJobId,
          client: 'עו״ד דוד לוי',
        });
        expect(detail.markdown?.split('\n')[0]).toBe(`# Series: ${name}`);
      }

      // The episodes are in their series by the number of their names; the other two rows are not.
      const mythId = listed.series.find((s) => s.name === 'מיתוס או אמת')?.id;
      const faqId = listed.series.find((s) => s.name === 'שאלות נפוצות')?.id;
      expect(
        ['m5', 'm6', 'm7', 'm8'].map((id) => [byId.get(id)?.seriesId, byId.get(id)?.episode]),
      ).toEqual([
        [mythId, 5],
        [mythId, 6],
        [mythId, 7],
        [mythId, 8],
      ]);
      expect(['f5', 'f6'].map((id) => [byId.get(id)?.seriesId, byId.get(id)?.episode])).toEqual([
        [faqId, 5],
        [faqId, 6],
      ]);
      expect(byId.get('rgm')).toMatchObject({ state: 'queued', seriesId: null, episode: null });
      expect(byId.get('dk')).toMatchObject({ state: 'ready', seriesId: null, episode: null });
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('leaves the Series switch off without the option: the series routes are not served', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist });
    try {
      expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
        series: false,
      });
      expect((await fetch(`${server.url}/api/clients/x/series`)).status).toBe(404);
      const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as Job[];
      expect(jobs.every((job) => job.seriesId === null && job.episode === null)).toBe(true);
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('refuses --series together with --review', async () => {
    await expect(startCanvasServer({ series: true, review: true })).rejects.toThrow(
      '--review, --series and --sheet seed different rows',
    );
  });
});

const LAW = 'עו״ד דוד לוי';

describe('the Job sheet boards (--sheet)', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  async function start(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ webDist, ...options });
    stops.push(server.stop);
    const get = async <T>(path: string): Promise<{ status: number; json: T }> => {
      const response = await fetch(`${server.url}/api${path}`);
      return { status: response.status, json: (await response.json()) as T };
    };
    return { server, get };
  }

  it('has one job for each of the thirteen states of JSStatesA and JSStatesB', () => {
    expect(SHEET_JOB_SPECS).toHaveLength(13);
    expect(new Set(SHEET_JOB_SPECS.map((spec) => spec.id)).size).toBe(13);
    const count = (state: Job['state']) => SHEET_JOB_SPECS.filter((s) => s.state === state).length;
    expect({
      arriving: count('arriving'),
      queued: count('queued'),
      held: count('held'),
      editing: count('editing'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      review: count('review'),
      ready: count('ready'),
    }).toEqual({
      arriving: 1,
      queued: 1,
      held: 1,
      editing: 2,
      failed: 1,
      cancelled: 1,
      review: 2,
      ready: 4,
    });
  });

  it('seeds through the repository, and every job parses with the shared schema', () => {
    const db = memoryDb();
    seedCanvasJobs(db, 0, SHEET_JOB_SPECS);
    const repo = new JobRepository(db, {
      estimateEtaSec: (job) => SHEET_JOB_SPECS.find((spec) => spec.id === job.id)?.etaSec ?? null,
    });
    const jobs = repo.getAll();
    expect(jobs).toHaveLength(13);
    for (const job of jobs) expect(jobSchema.safeParse(job).success, job.id).toBe(true);

    const byId = new Map(jobs.map((job) => [job.id, job]));
    // "starts in 0:42" at the first board's moment, "#1 in line", and the second cut's round.
    expect(Date.parse(byId.get(SHEET_IDS.arriving)?.settlesAt ?? '') - Date.parse(SHEET_NOW)).toBe(
      42_000,
    );
    expect(byId.get(SHEET_IDS.queued)).toMatchObject({ placeInLine: 1, effort: 'high' });
    expect(byId.get(SHEET_IDS.held)?.heldSettledAt).toBe('2026-10-22T11:03:00.000Z');
    expect(byId.get(SHEET_IDS.editing)).toMatchObject({ etaSec: 240, step: 5 });
    expect(byId.get(SHEET_IDS.reviewRound2)).toMatchObject({ runKind: 'revise', round: 1 });
    expect(byId.get(SHEET_IDS.rendering)).toMatchObject({ state: 'editing', runKind: 'render' });
    expect(statusDetail(byId.get(SHEET_IDS.reviewRound2) as Job, SHEET_NOW)).toBe(
      '0:41 · 1080×1920 · round 2',
    );
    expect(jobStage(byId.get(SHEET_IDS.approved) as Job)).toBe('approved');
    expect(jobStage(byId.get(SHEET_IDS.delivered) as Job)).toBe('delivered');
    expect(jobStage(byId.get(SHEET_IDS.paid) as Job)).toBe('paid');
    expect(isArchived(byId.get(SHEET_IDS.archived) as Job)).toBe(true);
  });

  it('serves the sheet: the switch and Series on, the steps with their rounds, the sent notes', async () => {
    const { get } = await start({ sheet: true });
    expect((await get('/health')).json).toMatchObject({ series: true, jobSheet: true });
    expect((await get<Job[]>('/jobs')).json).toHaveLength(13);

    // A job that has not started has no runs; one editing has Cut open.
    expect((await get<JobStepsResponse>(`/jobs/${SHEET_IDS.queued}/steps`)).json.runs).toEqual([]);
    const editing = (await get<JobStepsResponse>(`/jobs/${SHEET_IDS.editing}/steps`)).json.runs;
    expect(editing.map((run) => [run.step, run.runKind, run.round])).toEqual([
      [1, 'edit', 0],
      [2, 'edit', 0],
      [3, 'edit', 0],
      [4, 'edit', 0],
      [5, 'edit', 0],
    ]);
    expect(editing.at(-1)).toMatchObject({ step: 5, endedAt: null });
    expect(editing[0]).toEqual({
      step: 1,
      runKind: 'edit',
      round: 0,
      startedAt: '2026-10-22T14:30:00.000Z',
      endedAt: '2026-10-22T14:31:00.000Z',
    });

    // The second cut's own steps follow the first cut's, as round 1; two rounds, a render after.
    const second = (await get<JobStepsResponse>(`/jobs/${SHEET_IDS.reviewRound2}/steps`)).json.runs;
    expect(second.filter((run) => run.round === 1).map((run) => run.step)).toEqual([4, 5, 6, 7]);
    const archived = (await get<JobStepsResponse>(`/jobs/${SHEET_IDS.archived}/steps`)).json.runs;
    expect(new Set(archived.map((run) => run.round))).toEqual(new Set([0, 1, 2]));
    expect(archived.at(-1)).toMatchObject({ step: 8, runKind: 'render', round: 2 });

    const sent = (await get<{ notes: ReviewNote[] }>(`/jobs/${SHEET_IDS.reviewRound2}/sent-notes`))
      .json.notes;
    expect(sent.map((note) => [note.atSec, note.round, note.addToStyle, note.addToSeries])).toEqual(
      [
        [4, 1, false, true],
        [19, 1, true, false],
        [33, 1, false, false],
      ],
    );
    expect(sent[1]).toMatchObject({ kind: 'voice', audioSec: 7, transcriptStatus: 'done' });
    const none = await get<{ notes: ReviewNote[] }>(`/jobs/${SHEET_IDS.review}/sent-notes`);
    expect(none.json.notes).toEqual([]);
  });

  it('shows the MP4 for a ready job and the folder for the rest, without asking Finder', async () => {
    const { server, get } = await start({ sheet: true });
    const reveal = (id: string) => fetch(`${server.url}/api/jobs/${id}/reveal`, { method: 'POST' });

    const file = await reveal(SHEET_IDS.approved);
    expect(await file.json()).toEqual({ ok: true, revealed: 'file' });
    const folder = await reveal(SHEET_IDS.editing);
    expect(await folder.json()).toEqual({ ok: true, revealed: 'folder' });
    // The folders are in the seed's own temp folder (macOS spells it /private/var).
    expect(server.finder.files).toHaveLength(1);
    expect(server.finder.files[0]).toMatch(/\/exports\/RGM\/טורניר בחירות שש בש\.mp4$/);
    expect(server.finder.folders).toHaveLength(1);
    expect(server.finder.folders[0]?.endsWith(`/inbox/${LAW}/מיתוס או אמת 6`)).toBe(true);
    expect((await get('/jobs/nope/steps')).status).toBe(404);
  });

  it('starts the clock at the boards’ day, and serves the lawyer’s two series', async () => {
    const { server, get } = await start({ sheet: true });
    const jobs = (await get<Job[]>('/jobs')).json;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get(SHEET_IDS.paid)).toMatchObject({ episode: 5 });
    expect(byId.get(SHEET_IDS.editing)).toMatchObject({ episode: 6 });
    expect(byId.get(SHEET_IDS.reviewRound2)).toMatchObject({ episode: 5 });
    expect(byId.get(SHEET_IDS.paid)?.seriesId).toBe(byId.get(SHEET_IDS.editing)?.seriesId);
    expect(byId.get(SHEET_IDS.paid)?.seriesId).not.toBe(byId.get(SHEET_IDS.reviewRound2)?.seriesId);

    // A Hold is stamped on the boards' day, not the real one.
    const held = await fetch(`${server.url}/api/jobs/${SHEET_IDS.queued}/hold`, { method: 'POST' });
    expect(held.status).toBe(200);
    expect(((await held.json()) as Job).updatedAt.startsWith('2026-10-22T15:0')).toBe(true);
  });

  it('is on for the job sheet in every mode, and off with jobSheet: false', async () => {
    const twelve = await start({ now: 'canvas' });
    expect((await twelve.get('/health')).json).toMatchObject({ jobSheet: true, series: false });
    // The routes work for the twelve too: nothing has run, so there are no steps.
    expect((await twelve.get<JobStepsResponse>('/jobs/j5/steps')).json).toEqual({
      jobId: 'j5',
      runs: [],
    });

    const off = await start({ now: 'canvas', jobSheet: false });
    expect((await off.get('/health')).json).toMatchObject({ jobSheet: false });
  });

  it('refuses --sheet together with --review or --series', async () => {
    await expect(startCanvasServer({ sheet: true, review: true })).rejects.toThrow(
      '--review, --series and --sheet seed different rows',
    );
    await expect(startCanvasServer({ sheet: true, series: true })).rejects.toThrow(
      '--review, --series and --sheet seed different rows',
    );
  });
});

describe('the Phone switch (--phone)', () => {
  async function healthWith(options: { phone?: boolean }): Promise<unknown> {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, ...options });
    try {
      return await (await fetch(`${server.url}/api/health`)).json();
    } finally {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    }
  }

  it('is off without the option', async () => {
    expect(await healthWith({})).toMatchObject({ phone: false });
  });

  it('turns the switch on with the option, and nothing else', async () => {
    expect(await healthWith({ phone: true })).toMatchObject({
      phone: true,
      series: false,
      jobSheet: true,
    });
  });
});

describe('the Graphics library (--graphics)', () => {
  const NOW = '2026-10-22T12:00:00.000Z';
  const NAMES = [
    'Hours saved counter',
    'Name on a white pill',
    'Name with the client’s logo',
    'מיתוס או אמת – פתיחה',
    'Big number that counts up',
    'Follow card',
    'Follow card – first try',
  ];

  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ now: NOW, webDist, ...options });
    stops.push(server.stop);
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`${server.url}${path}`)).json()) as T;
    return { server, get };
  }

  const summaries = (get: <T>(path: string) => Promise<T>) =>
    get<GraphicSummary[]>('/api/graphics');

  it('is off without the option: no graphics route, and the health says so', async () => {
    const { server, get } = await boot();
    expect(await get('/api/health')).toMatchObject({ graphics: false, graphicsInEdits: false });
    const res = await fetch(`${server.url}/api/graphics`);
    expect(res.status).toBe(404);
    expect(server.graphicsRepo).toBeNull();
  });

  it('turns the switch on and seeds the seven graphics of the GRLibrary board, newest change first', async () => {
    const { get } = await boot({ graphics: true });
    expect(await get('/api/health')).toMatchObject({ graphics: true, graphicsInEdits: true });

    const list = await summaries(get);
    expect(list.map((g) => g.name)).toEqual(NAMES);
    const by = new Map(list.map((g) => [g.name, g]));
    // one being made, one that could not finish v3 (v2 stays what edits use), the rest ready
    expect(by.get('Hours saved counter')).toMatchObject({
      status: 'making',
      makingVersion: 1,
      version: null,
      kind: null,
    });
    expect(by.get('Name on a white pill')).toMatchObject({
      status: 'ready',
      version: 2,
      kind: 'lower-third',
      lengthSec: 3,
      uses: true,
    });
    expect(by.get('Name with the client’s logo')).toMatchObject({
      status: 'failed',
      failedVersion: 3,
      version: 2,
      kind: 'lower-third',
    });
    expect(by.get('מיתוס או אמת – פתיחה')).toMatchObject({
      status: 'ready',
      version: 1,
      kind: 'title',
      lengthSec: 2.4,
    });
    expect(by.get('Big number that counts up')).toMatchObject({
      kind: 'callout',
      lengthSec: 2.5,
    });
    expect(by.get('Follow card')).toMatchObject({ kind: 'end-card', lengthSec: 3.5, uses: true });
    // the one that edits do not use
    expect(by.get('Follow card – first try')).toMatchObject({ kind: 'end-card', uses: false });
    expect(list.filter((g) => g.status === 'making')).toHaveLength(1);
  });

  it('ages the rows as the board does: just now, 10 min ago, 1 h ago, Yesterday, 2 days ago', async () => {
    const { get } = await boot({ graphics: true });
    const ages = (await summaries(get)).map((g) => relativeTime(g.updatedAt, NOW));
    expect(ages).toEqual([
      'Just now',
      '10 min ago',
      '1 h ago',
      'Yesterday',
      'Yesterday',
      '2 days ago',
      '2 days ago',
    ]);
  });

  it('gives each chat the thread of the GRStudio board', async () => {
    const { get } = await boot({ graphics: true });
    const list = await summaries(get);
    const detail = (name: string) =>
      get<GraphicDetail>(`/api/graphics/${list.find((g) => g.name === name)?.id}`);

    const pill = await detail('Name on a white pill');
    expect(pill.messages.map((m) => [m.role, m.status, m.version])).toEqual([
      ['you', null, null],
      ['claude', 'done', 1],
      ['you', null, null],
      ['claude', 'done', 2],
    ]);
    expect(pill.messages[0]).toMatchObject({ refs: ['lower-third-I-like.png'] });
    expect(pill.messages[2]?.text).toBe('Slower in, and higher: the captions sit where it is now.');
    expect(pill.messages[3]?.text).toContain('Made v2. The slide-in takes 0.7 s');
    // "1 min 52 s" and "1 min 10 s" in the chat
    const took = (m: GraphicMessage | undefined) =>
      Date.parse(m?.endedAt ?? '') - Date.parse(m?.startedAt ?? '');
    expect([took(pill.messages[1]), took(pill.messages[3])]).toEqual([112_000, 70_000]);
    expect(pill).toMatchObject({
      usedIn: 4,
      folder: 'Name on a white pill',
      when: 'The first time a person is named on camera.',
      variables: [
        { id: 'name', label: 'Name', default: 'דנה לוי' },
        { id: 'role', label: 'Role', default: 'מייסדת, Kova Coffee' },
      ],
    });

    const logo = await detail('Name with the client’s logo');
    expect(logo.messages.at(-1)).toMatchObject({
      role: 'claude',
      status: 'failed',
      version: 3,
      step: null,
    });
    expect(logo.messages.at(-1)?.text).toBe(
      'At 16:9 the logo pushed the role line out of the frame.',
    );
    expect(logo.messages.at(-1)?.error).toContain('the role line ends at x=1968');
    expect(logo.usedIn).toBe(4);

    const hours = await detail('Hours saved counter');
    expect(hours.messages).toHaveLength(2);
    expect(hours.messages[0]?.text).toContain('A counter for hours saved');
    expect(hours.messages[1]).toMatchObject({
      status: 'making',
      version: 1,
      step: 1,
      endedAt: null,
    });
    expect(hours.variables).toEqual([]);

    const hebrew = await detail('מיתוס או אמת – פתיחה');
    expect(hebrew.variables).toEqual([{ id: 'title', label: 'Title', default: 'מיתוס או אמת' }]);
  });

  it('writes every made version as a whole project the player can load', async () => {
    const { server, get } = await boot({ graphics: true });
    const list = await summaries(get);
    const pill = list.find((g) => g.name === 'Name on a white pill') as GraphicSummary;
    const dir = join(server.inboxPath, '_Graphics', 'Name on a white pill');

    for (const version of [1, 2]) {
      const v = join(dir, 'versions', `v${version}`);
      for (const file of [
        'index.html',
        'about.json',
        'vendor/gsap.min.js',
        `compositions/lib-${pill.id}.html`,
      ]) {
        await expect(readFile(join(v, file))).resolves.toBeDefined();
      }
    }
    await expect(readFile(join(dir, 'refs', 'lower-third-I-like.png'))).resolves.toBeDefined();
    // the Hebrew name is a folder too
    await expect(
      readFile(
        join(server.inboxPath, '_Graphics', 'מיתוס או אמת – פתיחה', 'versions', 'v1', 'about.json'),
      ),
    ).resolves.toBeDefined();

    // v2 is what its reply says: the pill sits at 62% and slides in in 0.7 s (v1: 72% and 0.4 s)
    const composition = (version: number) =>
      readFile(join(dir, 'versions', `v${version}`, 'compositions', `lib-${pill.id}.html`), 'utf8');
    expect(await composition(1)).toContain('top: 72%;');
    expect(await composition(2)).toContain('top: 62%;');
    expect(await composition(2)).toContain('duration: 0.7, ease: "power2.out"');
    expect(await composition(2)).not.toContain('duration: 0.4');

    // v2 plays through the real routes: the host, and the graphic it mounts
    const host = await fetch(`${server.url}/api/graphics/${pill.id}/v/2/host.html?size=9x16`);
    expect(host.status).toBe(200);
    expect(await host.text()).toContain(`lib-${pill.id}`);
    const served = await fetch(
      `${server.url}/api/graphics/${pill.id}/v/2/compositions/lib-${pill.id}.html`,
    );
    expect(served.status).toBe(200);
    // the graphic that is only being made has no version to play
    const hours = list.find((g) => g.name === 'Hours saved counter') as GraphicSummary;
    expect((await fetch(`${server.url}/api/graphics/${hours.id}/v/1/host.html`)).status).toBe(404);
  });

  it('works through the real routes: a change makes v3 with the fake run, and Use v1 again makes v4', async () => {
    const { server, get } = await boot({ graphics: true, graphicSpeed: 200 });
    const list = await summaries(get);
    const pill = list.find((g) => g.name === 'Name on a white pill') as GraphicSummary;

    const form = new FormData();
    form.set('text', 'Make it dark.');
    const sent = await fetch(`${server.url}/api/graphics/${pill.id}/messages`, {
      method: 'POST',
      body: form,
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      expect(await get<GraphicDetail>(`/api/graphics/${pill.id}`)).toMatchObject({
        status: 'ready',
        version: 3,
      });
    });
    await expect(
      access(join(server.inboxPath, '_Graphics', 'Name on a white pill', 'versions', 'v3')),
    ).resolves.toBeUndefined();

    const restored = await fetch(`${server.url}/api/graphics/${pill.id}/versions/1/restore`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ version: 4 });
  });

  it('moves a deleted graphic’s folder to a Trash of the seed’s own', async () => {
    const { server, get } = await boot({ graphics: true });
    const follow = (await summaries(get)).find((g) => g.name === 'Follow card') as GraphicSummary;

    const res = await fetch(`${server.url}/api/graphics/${follow.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const { where } = (await res.json()) as { where: string };
    expect(where).toBe(join(server.dir, 'home', '.Trash', 'Follow card'));
    await expect(readFile(join(where, 'versions', 'v1', 'about.json'))).resolves.toBeDefined();
    expect((await summaries(get)).map((g) => g.name)).not.toContain('Follow card');
  });

  it('turns the switch on with nothing made for --graphics-empty', async () => {
    const { server, get } = await boot({ graphicsEmpty: true });
    expect(await get('/api/health')).toMatchObject({ graphics: true });
    expect(await summaries(get)).toEqual([]);
    expect(server.graphicsRepo?.list()).toEqual([]);
  });

  it('changes no job rows', async () => {
    const { get } = await boot({ graphics: true });
    const jobs = await get<Job[]>('/api/jobs');
    expect(jobs.map((j) => j.id)).toEqual(BOARD_ORDER);
  });
});

describe('the Soundtrack boards (--music)', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ webDist, music: true, ...options });
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
    const music = async (id: string) =>
      (await send<MusicView | null>('GET', `/jobs/${id}/music`)).json;
    return { server, send, music };
  }

  // The read-only tests share one seed (a boot makes about twenty mp3s and compositions).
  let shared: Awaited<ReturnType<typeof boot>>;
  const sharedStops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    shared = await boot();
    sharedStops.push(...stops.splice(0));
  }, 240_000);
  afterAll(async () => {
    for (const stop of sharedStops.splice(0)) await stop();
  });

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  it('has a job for each state of SDStates and SDSheet, every record valid', () => {
    const ids = MUSIC_JOB_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
    // Every job with a record is a job of the seed, and every record fits the shared contract.
    for (const [id, record] of Object.entries(MUSIC_RECORDS)) {
      expect(ids, id).toContain(id);
      expect(musicRecordSchema.safeParse(record).success, id).toBe(true);
    }
  });

  it('says so in the health, serves the twelve jobs at the boards’ moment, and keeps the switch of the others off', async () => {
    const { server, send } = shared;
    expect((await send('GET', '/health')).json).toMatchObject({ music: true, series: true });
    const jobs = (await send<Job[]>('GET', '/jobs')).json;
    expect(jobs).toHaveLength(12);
    expect(jobs.map((job) => job.state).sort()).toEqual(
      ['editing', 'ready', 'ready', ...Array(9).fill('review')].sort(),
    );
    expect(Date.now() - Date.parse(SHEET_NOW)).toBeGreaterThan(0);
    // The default seed has no music routes: its health says off and the path answers 404.
    const plain = await startCanvasServer({
      webDist: await mkdtemp(join(tmpdir(), 'seed-web-')),
    });
    stops.push(plain.stop);
    expect(
      ((await (await fetch(`${plain.url}/api/health`)).json()) as { music: boolean }).music,
    ).toBe(false);
    expect((await fetch(`${plain.url}/api/jobs/j1/music`)).status).toBe(404);
    expect(server.music).not.toBeNull();
    expect(plain.music).toBeNull();
  }, 120_000);

  it('shows each state of the list and of the sheet in the job’s music', async () => {
    const { music } = shared;

    const demo = await music(MUSIC_IDS.demo);
    expect(demo).toMatchObject({ source: 'made', picked: 'v2', making: null, canMake: true });
    expect(demo?.versions.map((version) => [version.id, version.by, version.ask])).toEqual([
      ['v1', 'edit', null],
      ['v2', 'you', 'darker, heavier drums'],
    ]);
    expect(demo?.plan?.sections.map((section) => section.name)).toEqual([
      'Build',
      'Rise',
      'Drop',
      'Golden',
      'Logo',
    ]);
    expect(demo?.rev).toBeGreaterThan(0);

    expect(await music(MUSIC_IDS.teaser)).toMatchObject({ picked: 'v1' });
    // A job being edited: the record says the first make is running, and the job lets the view say it.
    expect(await music(MUSIC_IDS.editing)).toMatchObject({
      picked: null,
      making: { id: 'v1' },
      canMake: false,
    });
    // "Demo 3" is being made for real: v2 with words, v1 playing, and Approve waits.
    expect(await music(MUSIC_IDS.making)).toMatchObject({
      picked: 'v1',
      making: { id: 'v2', ask: 'darker, heavier drums' },
      whyNot: 'Music v2 is still being made.',
    });
    expect(await music(MUSIC_IDS.failedV2)).toMatchObject({
      picked: 'v1',
      failure: { id: 'v2', code: 'no_credits' },
      canMake: true,
    });
    expect(await music(MUSIC_IDS.failedV1)).toMatchObject({
      picked: null,
      versions: [],
      failure: { id: 'v1', code: 'no_credits' },
      canMake: true,
    });
    expect(await music(MUSIC_IDS.off)).toMatchObject({ picked: 'off' });
    expect(await music(MUSIC_IDS.folder)).toMatchObject({
      source: 'supplied',
      file: 'Summer Vibes.mp3',
      picked: 'file',
    });
    expect(await music(MUSIC_IDS.folderApproved)).toMatchObject({
      source: 'supplied',
      canMake: false,
      whyNot: 'Music can be changed while the video waits for your review.',
    });
    expect(await music(MUSIC_IDS.noStyle)).toMatchObject({
      source: 'none',
      reason: 'The client’s style says no music under the lawyer’s answers.',
    });
    expect(await music(MUSIC_IDS.series)).toMatchObject({
      source: 'series',
      picked: 'series',
      canMake: false,
      whyNot: 'Episodes play the series’ music.',
    });
    // The format job and a job of the Soundtrack boards' own have no music to show.
    expect(await music(MUSIC_IDS.mythFormat)).toBeNull();
  }, 120_000);

  it('writes what the engine leaves: the plan, the versions, the record and the music the composition plays', async () => {
    const { server } = shared;
    const edit = (client: string, name: string) => join(server.inboxPath, client, name, 'edit');
    const demo = edit('Horizon FPV', 'Demo');
    for (const file of [
      'music/plan.json',
      'music/v1.mp3',
      'music/v2.mp3',
      'music/music.json',
      'preview/music.mp3',
      'preview/index.html',
    ]) {
      expect(await exists(join(demo, file)), file).toBe(true);
    }
    // The pick is what the composition plays, and the composition plays it.
    expect(
      (await readFile(join(demo, 'music/v2.mp3'))).equals(
        await readFile(join(demo, 'preview/music.mp3')),
      ),
    ).toBe(true);
    expect(await readFile(join(demo, 'preview/index.html'), 'utf8')).toContain('src="music.mp3"');
    // The cut is as long as the board's (0:39).
    expect(await readFile(join(demo, 'preview/index.html'), 'utf8')).toContain(
      'data-duration="39"',
    );
    // No music is silence of the same length; a failed first make leaves silence too.
    const off = edit('Horizon FPV', 'Reel');
    expect((await stat(join(off, 'preview/music.mp3'))).size).toBeGreaterThan(1_000);
    expect(await exists(join(edit('Horizon FPV', 'Demo 5'), 'preview/music.mp3'))).toBe(true);
    // The folder's file is in the folder, a rule that says no music leaves no file and no music element.
    expect(
      await exists(join(server.inboxPath, 'LAKESHORE', 'Summer promo', 'Summer Vibes.mp3')),
    ).toBe(true);
    const none = edit('עו״ד דוד לוי', 'שאלות נפוצות 5');
    expect(await exists(join(none, 'preview/music.mp3'))).toBe(false);
    expect(await readFile(join(none, 'preview/index.html'), 'utf8')).not.toContain('music.mp3');
    // A job being edited has its record and no composition yet.
    expect(await exists(join(edit('Horizon FPV', 'Demo 2'), 'music/music.json'))).toBe(true);
    expect(await exists(join(edit('Horizon FPV', 'Demo 2'), 'preview'))).toBe(false);
  }, 120_000);

  it('works: Make another with words makes v3 and picks it, Pick goes back, and Approve waits for "Demo 3"', async () => {
    const { send, music } = await boot();
    const made = await send<MusicView>('POST', `/jobs/${MUSIC_IDS.demo}/music`, { ask: 'calmer' });
    expect(made.status).toBe(202);
    expect(made.json.making).toMatchObject({ id: 'v3', ask: 'calmer' });
    let view: MusicView | null = null;
    for (
      let tries = 0;
      tries < 100 && !(view?.picked === 'v3' && view.making === null);
      tries += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      view = await music(MUSIC_IDS.demo);
    }
    expect(view).toMatchObject({ picked: 'v3', making: null });
    expect(view?.versions.at(-1)).toMatchObject({ id: 'v3', by: 'you', ask: 'calmer' });

    const picked = await send<MusicView>('PUT', `/jobs/${MUSIC_IDS.demo}/music/pick`, { id: 'v1' });
    expect(picked).toMatchObject({ status: 200, json: { picked: 'v1' } });
    const off = await send<MusicView>('PUT', `/jobs/${MUSIC_IDS.demo}/music/pick`, { id: 'off' });
    expect(off.json.picked).toBe('off');

    // The job whose v2 is being made cannot be approved until it is (the real review service).
    const approve = await send<{ error: string }>('POST', `/jobs/${MUSIC_IDS.making}/approve`);
    expect(approve).toEqual({ status: 409, json: { error: 'Music v2 is still being made.' } });
    // And a refused Make another says why, in the engine's words.
    const refused = await send<{ error: string }>('POST', `/jobs/${MUSIC_IDS.making}/music`, {});
    expect(refused).toEqual({ status: 409, json: { error: 'Music v2 is still being made.' } });
  }, 120_000);

  it('seeds its own rows: not together with the others', async () => {
    await expect(startCanvasServer({ music: true, review: true })).rejects.toThrow(
      '--music seeds its own rows',
    );
    await expect(startCanvasServer({ music: true, sheet: true })).rejects.toThrow(
      '--music seeds its own rows',
    );
  });
});

describe('the Songs boards (--songs)', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ webDist, songs: true, ...options });
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
    const music = async (id: string) =>
      (await send<MusicView | null>('GET', `/jobs/${id}/music`)).json;
    const noSong = async (id: string) =>
      (await send<NoSongStatus>('GET', `/jobs/${id}/no-song`)).json;
    return { server, send, music, noSong };
  }

  // The read-only tests share one seed (a boot makes a dozen compositions and tones).
  let shared: Awaited<ReturnType<typeof boot>>;
  const sharedStops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    shared = await boot();
    sharedStops.push(...stops.splice(0));
  }, 240_000);
  afterAll(async () => {
    for (const stop of sharedStops.splice(0)) await stop();
  });

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const edit = (client: string, job: string) => join(shared.server.inboxPath, client, job, 'edit');

  it('has a job for each state of the boards, every record valid', () => {
    const ids = SONGS_JOB_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.values(SONGS_IDS).sort());
    for (const [id, record] of Object.entries(SONGS_RECORDS)) {
      expect(ids, id).toContain(id);
      expect(musicRecordSchema.safeParse(record).success, id).toBe(true);
    }
    for (const note of SONGS_NOTES) expect(ids).toContain(note.jobId);
  });

  it('says so in the health and serves the twelve jobs at the boards’ moment', async () => {
    const { send, server } = shared;
    expect((await send('GET', '/health')).json).toMatchObject({ music: true, songs: true });
    const jobs = (await send<Job[]>('GET', '/jobs')).json;
    expect(jobs).toHaveLength(12);
    expect(jobs.map((job) => job.state).sort()).toEqual(
      [...Array(2).fill('arriving'), ...Array(3).fill('ready'), ...Array(7).fill('review')].sort(),
    );
    expect(Date.now() - Date.parse(SONGS_NOW)).toBeGreaterThan(0);
    expect(server.noSong).not.toBeNull();
    // The default seed has none of Songs' routes: its health says off and the paths answer 404.
    const plain = await startCanvasServer({ webDist: await mkdtemp(join(tmpdir(), 'seed-web-')) });
    stops.push(plain.stop);
    expect(
      ((await (await fetch(`${plain.url}/api/health`)).json()) as { songs?: boolean }).songs,
    ).toBe(false);
    expect((await fetch(`${plain.url}/api/jobs/j1/no-song`)).status).toBe(404);
    expect((await fetch(`${plain.url}/api/jobs/j1/note`)).status).toBe(404);
    expect(plain.noSong).toBeNull();
  }, 120_000);

  it('shows each state of the Music list in the job’s music', async () => {
    const { music } = shared;
    const demo = await music(SONGS_IDS.song);
    expect(demo).toMatchObject({ source: 'song', picked: 'song', canMake: true });
    expect(demo?.song).toMatchObject({
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      fullMs: 192_000,
      part: { startMs: 42_000, endMs: 81_000, how: 'measured' },
      asked: { from: 'screenshot', file: SONGS_SCREENSHOT, by: 'brief' },
    });
    expect(await music(SONGS_IDS.off)).toMatchObject({ picked: 'off' });
    expect(await music(SONGS_IDS.fallback)).toMatchObject({
      source: 'made',
      picked: 'v1',
      song: null,
      songFailure: { code: 'unavailable' },
    });
    expect(await music(SONGS_IDS.original)).toMatchObject({
      picked: 'v1',
      songFailure: { code: 'original_audio', asked: 'Original audio · @reels.creator' },
    });
    expect((await music(SONGS_IDS.trend))?.song).toMatchObject({
      asked: { from: 'trending', by: 'editor' },
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    });
    expect(await music(SONGS_IDS.notedTrend)).toMatchObject({ picked: 'v1' });
    // The arriving jobs have no music.
    expect((await music(SONGS_IDS.arrivingShot)) ?? null).toBeNull();
  }, 120_000);

  it('writes what the edit leaves: the record, the part, and the composition that plays it', async () => {
    const demo = edit('Falcon FPV', 'Demo 2');
    for (const file of [
      'music/plan.json',
      'music/music.json',
      'music/song.mp3',
      'preview/music.mp3',
    ]) {
      expect(await exists(join(demo, file)), file).toBe(true);
    }
    expect(
      (await readFile(join(demo, 'music/song.mp3'))).equals(
        await readFile(join(demo, 'preview/music.mp3')),
      ),
    ).toBe(true);
    expect(await readFile(join(demo, 'preview/index.html'), 'utf8')).toContain('src="music.mp3"');
    // The two that fell back have ElevenLabs' v1 and no song.
    const fallback = edit('Falcon FPV', 'Demo 4');
    expect(await exists(join(fallback, 'music/v1.mp3'))).toBe(true);
    expect(await exists(join(fallback, 'music/song.mp3'))).toBe(false);
    // No music is the silence of the cut's length, and the record stays the board's.
    expect(
      (await stat(join(edit('Falcon FPV', 'Demo 3'), 'preview/music.mp3'))).size,
    ).toBeGreaterThan(1_000);
  }, 120_000);

  it('has the arriving job’s screenshot in its note, as Save leaves it, and the other with nothing', async () => {
    const { send } = shared;
    const shot = (await send<NoteView>('GET', `/jobs/${SONGS_IDS.arrivingShot}/note`)).json;
    expect(shot.note).toBe(SONGS_NOTE_PICTURE);
    expect(shot.attachments.map((file) => file.name)).toEqual([SONGS_SCREENSHOT]);
    const picture = await fetch(
      `${shared.server.url}/api/jobs/${SONGS_IDS.arrivingShot}/note/attachments/${SONGS_SCREENSHOT}`,
    );
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    const empty = (await send<NoteView>('GET', `/jobs/${SONGS_IDS.arrivingEmpty}/note`)).json;
    expect(empty).toEqual({ note: null, attachments: [] });
  }, 120_000);

  it('has the two notes of the “added” states, unsent and at 0:00', async () => {
    const { send } = shared;
    const song = (await send<ReviewNote[]>('GET', `/jobs/${SONGS_IDS.notedSong}/notes`)).json;
    const trend = (await send<ReviewNote[]>('GET', `/jobs/${SONGS_IDS.notedTrend}/notes`)).json;
    expect([...song, ...trend].map((note) => [note.atSec, note.text])).toEqual([
      [0, 'Use Blinding Lights instead.'],
      [0, 'Use a trending song that fits the cut.'],
    ]);
  }, 120_000);

  it('shows the second file of each approved job as drawn: made, being made, failed', async () => {
    const { noSong } = shared;
    expect(await noSong(SONGS_IDS.approved)).toMatchObject({
      state: 'ready',
      file: 'Demo 11 · no song.mp4',
    });
    expect(await noSong(SONGS_IDS.making)).toEqual({ state: 'making' });
    expect(await noSong(SONGS_IDS.failed)).toEqual({
      state: 'failed',
      message: 'Not enough disk space to make the file without the song',
    });
    // A job whose music is not the song has no second file, and the files download.
    expect(await noSong(SONGS_IDS.song)).toEqual({ state: 'none' });
    const second = await fetch(
      `${shared.server.url}/api/jobs/${SONGS_IDS.approved}/download?file=no-song`,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''Demo%2011%20%C2%B7%20no%20song.mp4",
    );
    expect(
      (await fetch(`${shared.server.url}/api/jobs/${SONGS_IDS.making}/download?file=no-song`))
        .status,
    ).toBe(404);
  }, 120_000);

  it('works: Try again makes the failed second file, Another song adds a note, Approve is not held', async () => {
    const { send, noSong } = await boot();
    const again = await send<NoSongStatus>('POST', `/jobs/${SONGS_IDS.failed}/no-song`);
    expect(again.status).toBe(200);
    let status: NoSongStatus = again.json;
    for (let tries = 0; tries < 100 && status.state !== 'ready'; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await noSong(SONGS_IDS.failed);
    }
    expect(status).toMatchObject({ state: 'ready', file: 'Demo 13 · no song.mp4' });
    // The one that is being made cannot be asked again, and the one with no such file says so.
    expect((await send('POST', `/jobs/${SONGS_IDS.making}/no-song`)).json).toEqual({
      state: 'making',
    });
    expect((await send('POST', `/jobs/${SONGS_IDS.song}/no-song`)).status).toBe(409);

    // Another song and Pick a trending one are Review notes at 0:00.
    const added = await send<ReviewNote>('POST', `/jobs/${SONGS_IDS.song}/notes`, {
      atSec: 0,
      text: 'Use a trending song that fits the cut.',
    });
    expect(added.status).toBe(201);
    // Make music instead still works on a song job (the script's fake path), and the song stays in the list.
    const made = await send<MusicView>('POST', `/jobs/${SONGS_IDS.song}/music`, {});
    expect(made.status).toBe(202);
  }, 120_000);

  it('seeds its own rows: not together with the others', async () => {
    for (const other of [
      'music',
      'review',
      'sheet',
      'series',
      'analytics',
      'quickFixes',
    ] as const) {
      await expect(startCanvasServer({ songs: true, [other]: true })).rejects.toThrow(
        '--songs seeds its own rows',
      );
    }
  });
});
