import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  isFixedNote,
  type Job,
  jobSchema,
  jobVersionsResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository, NoteRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { REVIEW_MESSAGES } from '../review/review-service.js';
import { createVersionService } from '../versions/version-service.js';
import { injectTimelineRegistry } from './preview.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repositories on an in-memory database, the real version service and routes, and a real
// folder of files; `app.request` for the HTTP.

const CLIENT = 'Northwind Bakery';
const SECOND_PREVIEW = { durationSec: 9, width: 1080, height: 1920 };

let base: string;
let inboxPath: string;
let jobs: JobRepository;
let notes: NoteRepository;
let app: Hono;
let blocked: string | null;
let changed: Job[];
let jobCounter = 0;

function page(cut: number): string {
  return `<!doctype html><html><head><title>cut ${cut}</title></head><body>cut ${cut}</body></html>`;
}

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

/**
 * A job in review with two cuts: v1 was captured, then the live preview became cut 2 (9 s) and v2
 * was captured. Returns its id and folder.
 */
async function reviewJobWithTwoCuts(): Promise<{ id: string; edit: string }> {
  const name = `Teaser ${++jobCounter}`;
  const id = jobs.upsertFromScan(makeScan(CLIENT, name)).job.id;
  jobs.applyTransition(id, { type: 'SETTLED' });
  jobs.applyTransition(id, { type: 'START' });
  jobs.applyTransition(id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });

  const edit = join(inboxPath, CLIENT, name, 'edit');
  mkdirSync(join(edit, 'preview', 'compositions'), { recursive: true });
  mkdirSync(join(edit, 'music'), { recursive: true });
  writeFileSync(join(edit, 'preview', 'index.html'), page(1));
  writeFileSync(join(edit, 'preview', 'compositions', 'a.html'), 'a1');
  writeFileSync(join(edit, 'music', 'music.json'), '{"picked":"v1"}');
  writeFileSync(join(edit, 'edl.json'), '{"cuts":1}');
  writeFileSync(join(edit, 'project.md'), 'project 1');
  const versions = createVersionService({ inboxPath });
  const job = jobs.get(id) as Job;
  await versions.capture(job, SAMPLE_PREVIEW);

  writeFileSync(join(edit, 'preview', 'index.html'), page(2));
  writeFileSync(join(edit, 'music', 'music.json'), '{"picked":"v2"}');
  writeFileSync(join(edit, 'edl.json'), '{"cuts":2}');
  writeFileSync(join(edit, 'project.md'), 'project 2');
  jobs.setPreview(id, SECOND_PREVIEW);
  await versions.capture(job, SECOND_PREVIEW);
  return { id, edit };
}

function restore(id: string, n: number | string): Response | Promise<Response> {
  return app.request(`/api/jobs/${id}/versions/${n}/restore`, { method: 'POST' });
}

function file(id: string, n: number | string, path: string, method = 'GET') {
  return app.request(`/api/jobs/${id}/versions/${n}/preview/${path}`, { method });
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'studio-version-routes-'));
  inboxPath = join(base, 'inbox');
  mkdirSync(inboxPath, { recursive: true });
  const db = memoryDb();
  jobs = new JobRepository(db, { clock: fakeClock() });
  notes = new NoteRepository(db, { clock: fakeClock() });
  app = createApp({
    jobs: { jobs, exportsDir: join(base, 'exports') },
    versions: {
      jobs,
      versions: createVersionService({ inboxPath }),
      inboxPath,
      countUnsentNotes: (jobId) => notes.countUnsent(jobId),
      countFixedNotes: (jobId) => notes.listUnsent(jobId).filter(isFixedNote).length,
      reviewBlock: () => blocked,
      onJobChanged: (job) => changed.push(job),
    },
  });
});

beforeEach(() => {
  blocked = null;
  changed = [];
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/jobs/:id/versions', () => {
  it('lists the versions, newest first, with the current one marked', async () => {
    const { id } = await reviewJobWithTwoCuts();

    const res = await app.request(`/api/jobs/${id}/versions`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { versions } = jobVersionsResponseSchema.parse(await res.json());
    expect(versions.map((v) => [v.n, v.current, v.durationSec])).toEqual([
      [2, true, 9],
      [1, false, 28.4],
    ]);
  });

  it('is empty for a job from before versions, and 404 for an unknown job', async () => {
    const id = jobs.upsertFromScan(makeScan(CLIENT, 'Old job')).job.id;

    const res = await app.request(`/api/jobs/${id}/versions`);
    expect(await res.json()).toEqual({ versions: [] });

    expect(await expectError(await app.request('/api/jobs/nope/versions'), 404)).toBe(
      'Job nope not found',
    );
  });
});

describe('POST /api/jobs/:id/versions/:n/restore', () => {
  it('puts the version back: preview, music record, EDL, project notes and job.preview', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();

    const res = await restore(id, 1);

    expect(res.status).toBe(200);
    const job = jobSchema.parse(await res.json());
    expect(job).toMatchObject({ id, state: 'review', round: 0, preview: SAMPLE_PREVIEW });
    expect(jobs.get(id)?.preview).toEqual(SAMPLE_PREVIEW);
    expect(readFileSync(join(edit, 'preview', 'index.html'), 'utf8')).toBe(page(1));
    expect(readFileSync(join(edit, 'music', 'music.json'), 'utf8')).toBe('{"picked":"v1"}');
    expect(readFileSync(join(edit, 'edl.json'), 'utf8')).toBe('{"cuts":1}');
    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toContain('## Restored to Cut 1');
    expect(changed.map((j) => j.id)).toEqual([id]);

    const list = await app.request(`/api/jobs/${id}/versions`);
    const { versions } = jobVersionsResponseSchema.parse(await list.json());
    expect(versions.find((v) => v.current)?.n).toBe(1);
  });

  it('keeps the round and the sent notes', async () => {
    const { id } = await reviewJobWithTwoCuts();
    const before = jobs.get(id) as Job;

    const job = jobSchema.parse(await (await restore(id, 1)).json());

    expect(job.round).toBe(before.round);
    expect(job.state).toBe('review');
  });

  it('restoring the current version changes nothing', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();

    const res = await restore(id, 2);

    expect(res.status).toBe(200);
    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toBe('project 2');
  });

  it('answers 404 for a job, a version and a number that do not exist', async () => {
    const { id } = await reviewJobWithTwoCuts();

    expect(await expectError(await restore('nope', 1), 404)).toBe('Job nope not found');
    for (const n of [9, 0, -1, '1.5', 'abc', '01']) {
      expect(await expectError(await restore(id, n), 404)).toBe('This job has no such version.');
    }
  });

  it.each([
    ['queued', ['SETTLED']],
    ['editing', ['SETTLED', 'START']],
    ['cancelled', ['SETTLED', 'START', 'CANCEL']],
  ] as const)('answers 409 for a job that is not in review (%s)', async (state, events) => {
    const id = jobs.upsertFromScan(makeScan(CLIENT, `Not review ${state}`)).job.id;
    for (const type of events) jobs.applyTransition(id, { type });

    expect(await expectError(await restore(id, 1), 409)).toBe(
      'Only a job in Review can go back to an earlier cut.',
    );
    expect(changed).toEqual([]);
  });

  it('answers 409 for an archived job, changing nothing', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();
    jobs.archive([id]);

    expect(await expectError(await restore(id, 1), 409)).toBe(
      'An archived job cannot go back to an earlier cut.',
    );
    expect(readFileSync(join(edit, 'preview', 'index.html'), 'utf8')).toBe(page(2));
  });

  it('answers 409 while notes are not sent, changing nothing', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();
    notes.create({ id: 'n1', jobId: id, kind: 'text', atSec: 1, text: 'tighter' });

    expect(await expectError(await restore(id, 1), 409)).toBe(REVIEW_MESSAGES.sendOrDeleteFirst);
    expect(readFileSync(join(edit, 'preview', 'index.html'), 'utf8')).toBe(page(2));
    expect(changed).toEqual([]);
  });

  // QF4: Send would turn down notes that were all fixed in Review, so "Send or delete" would mislead.
  it('answers 409 "Approve or undo your fixes first." while every unsent note was fixed in Review', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();
    notes.create({ id: 'fx1', jobId: id, kind: 'text', atSec: 1, text: 'make the title yellow' });
    notes.create({ id: 'fx2', jobId: id, kind: 'text', atSec: 2, text: 'bigger logo' });
    for (const noteId of ['fx1', 'fx2']) {
      notes.setFix(noteId, { fixId: `fix-${noteId}`, fixedAt: '2026-10-25T10:00:00.000Z' });
    }

    expect(await expectError(await restore(id, 1), 409)).toBe('Approve or undo your fixes first.');
    expect(readFileSync(join(edit, 'preview', 'index.html'), 'utf8')).toBe(page(2));
    expect(changed).toEqual([]);
  });

  it('still says "Send or delete your notes first." when a note waits for Send next to the fixed ones', async () => {
    const { id } = await reviewJobWithTwoCuts();
    notes.create({ id: 'fx3', jobId: id, kind: 'text', atSec: 1, text: 'make the title yellow' });
    notes.setFix('fx3', { fixId: 'fix-fx3', fixedAt: '2026-10-25T10:00:00.000Z' });
    notes.create({ id: 'wt1', jobId: id, kind: 'text', atSec: 2, text: 'swap this shot' });

    expect(await expectError(await restore(id, 1), 409)).toBe(REVIEW_MESSAGES.sendOrDeleteFirst);
  });

  it('answers 409 with the review block while a music pick is under way, changing nothing', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();
    blocked = 'A pick is under way.';

    expect(await expectError(await restore(id, 1), 409)).toBe('A pick is under way.');
    expect(readFileSync(join(edit, 'music', 'music.json'), 'utf8')).toBe('{"picked":"v2"}');
  });
});

describe('GET /api/jobs/:id/versions/:n/preview/<path>', () => {
  it('serves the files of an old version, the root page with the timeline registry', async () => {
    const { id } = await reviewJobWithTwoCuts();

    const root = await file(id, 1, 'index.html');
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toBe(injectTimelineRegistry(page(1)));

    const sub = await file(id, 1, 'compositions/a.html');
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe('a1');

    const head = await file(id, 2, 'index.html', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('answers 404 for an unknown job, a version the job does not have and a missing file', async () => {
    const { id } = await reviewJobWithTwoCuts();

    expect(await expectError(await file('nope', 1, 'index.html'), 404)).toBe('Job nope not found');
    expect(await expectError(await file(id, 9, 'index.html'), 404)).toBe(
      'This job has no such version.',
    );
    expect(await expectError(await file(id, 'x', 'index.html'), 404)).toBe(
      'This job has no such version.',
    );
    expect(await expectError(await file(id, 1, 'nothing.html'), 404)).toBe(
      'The preview file is missing.',
    );
  });

  describe('stays inside the version', () => {
    let id: string;
    let edit: string;
    beforeAll(async () => {
      ({ id, edit } = await reviewJobWithTwoCuts());
      writeFileSync(join(edit, 'brief.md'), 'BRIEF SECRET');
      const outside = join(base, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
      const versionPreview = join(edit, 'versions', 'v1', 'preview');
      symlinkSync(outside, join(versionPreview, 'escape'));
      symlinkSync(join(outside, 'secret.txt'), join(versionPreview, 'escape.txt'));
    });

    it.each([
      ['..', '../brief.md'],
      ['%2e%2e', '%2e%2e/brief.md'],
      ['..%2F', '..%2Fbrief.md'],
      ['%2e%2e%2f', '%2e%2e%2fbrief.md'],
      ['the version folder next to it', '..%2Fmeta.json'],
      ['the next version', '..%2F..%2Fv2%2Fpreview%2Findex.html'],
      ['the index', '..%2F..%2Findex.json'],
      ['a segment then ..', 'compositions%2F..%2F..%2Fmeta.json'],
      ['an absolute path', encodeURIComponent('/etc/hosts')],
      ['a double slash', '/etc/hosts'],
      ['a folder symlink out', 'escape/secret.txt'],
      ['a file symlink out', 'escape.txt'],
      ['a NUL byte', 'index.html%00.png'],
      ['a double-encoded ..', '%252e%252e%252fmeta.json'],
    ])('never serves a file outside it: %s', async (_label, path) => {
      const res = await file(id, 1, path);

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('cut 2');
    });

    it('answers the same 404 as the live preview for the names it refuses', async () => {
      expect(await expectError(await file(id, 1, '..%2Fmeta.json'), 404)).toBe(
        'The preview file is missing.',
      );
    });
  });

  it('answers 404 when the folder of a listed version has no index.html', async () => {
    const { id, edit } = await reviewJobWithTwoCuts();
    rmSync(join(edit, 'versions', 'v1', 'preview', 'index.html'));

    expect(await expectError(await file(id, 1, 'compositions/a.html'), 404)).toBe(
      'This job has no such version.',
    );
  });
});
