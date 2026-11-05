import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  FIX_MESSAGES,
  type Job,
  jobFixesResponseSchema,
  type NoteRoute,
  type ReviewNote,
  undoFixResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ReviewExports } from '../clients/review-export.js';
import { JobRepository, NoteRepository, QuickFixRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import type { Sleep } from '../pipeline/fake-runner.js';
import { FakeQuickFixRunner } from '../review/fake-quick-fix.js';
import { createFixService, type FixService } from '../review/fix-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The fix routes on the real service, repositories and files, with the stand-in quick fix (which
// writes the stills Compare serves), and `app.request` for the HTTP.

const CLIENT = 'Northwind Bakery';
const QUICK: NoteRoute = { tier: 'quick', kind: 'Changing the title colour', why: '' };

let base: string;
let inboxPath: string;
let jobs: JobRepository;
let notes: NoteRepository;
let service: FixService;
let app: Hono;
let counter = 0;
let gate: Promise<void> = Promise.resolve();

/** Each step of the stand-in waits for `gate` (open unless a test closes it) and ends at once when stopped. */
const heldSleep: Sleep = (_ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
    void gate.then(() => resolve());
  });

beforeEach(async () => {
  gate = Promise.resolve();
  base = mkdtempSync(join(tmpdir(), 'studio-fix-routes-'));
  inboxPath = join(base, 'inbox');
  mkdirSync(inboxPath, { recursive: true });
  const db = memoryDb();
  jobs = new JobRepository(db, { clock: fakeClock() });
  notes = new NoteRepository(db, { clock: fakeClock() });
  const bus = createEventBus();
  service = createFixService({
    inboxPath,
    jobs,
    notes,
    fixes: new QuickFixRepository(db),
    bus,
    // A test holds a fix on one of its steps by replacing `gate`.
    runner: new FakeQuickFixRunner({ config: { inboxPath }, sleep: heldSleep }),
    newId: () => `fix${++counter}`,
  });
  await service.start();
  app = createApp({
    jobs: { jobs, exportsDir: join(base, 'exports') },
    quickFixes: true,
    fixRoutes: { jobs, fixes: service },
  });
});

afterEach(async () => {
  await service.stop();
  rmSync(base, { recursive: true, force: true });
});

async function reviewJob(name = `Teaser ${++counter}`): Promise<Job> {
  const { job } = jobs.upsertFromScan(makeScan(CLIENT, name));
  jobs.applyTransition(job.id, { type: 'SETTLED' });
  jobs.applyTransition(job.id, { type: 'START' });
  jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  const editDir = join(inboxPath, CLIENT, name, 'edit');
  mkdirSync(editDir, { recursive: true });
  await writeFakePreview(editDir, name);
  return jobs.get(job.id) as Job;
}

/** A quick note on the job, fixed by the stand-in; resolves once the fix is done. */
async function fixedNote(job: Job, text = 'make the title yellow'): Promise<ReviewNote> {
  const created = notes.create({
    id: `n${++counter}`,
    jobId: job.id,
    kind: 'text',
    atSec: 2,
    text,
  });
  const note = notes.setRoute(created.id, { status: 'routed', route: QUICK }) as ReviewNote;
  const fix = service.enqueue(job, note);
  expect(fix).not.toBeNull();
  await vi.waitFor(() => expect(service.find(job.id, fix?.id ?? '')?.status).toBe('fixed'));
  return notes.get(note.id) as ReviewNote;
}

async function expectError(res: Response, status: number, message?: string): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  const error = apiErrorSchema.parse(await res.json()).error;
  if (message !== undefined) expect(error).toBe(message);
  return error;
}

const titleRule = (job: Job): string =>
  /#title\s*\{[^}]*\}/.exec(
    readFileSync(join(inboxPath, job.relPath, 'edit', 'preview', 'index.html'), 'utf8'),
  )?.[0] ?? '';

describe('GET /api/jobs/:id/fixes', () => {
  it('lists the fixes of the next round, oldest first', async () => {
    const job = await reviewJob();
    const other = await reviewJob();
    const first = await fixedNote(job, 'make the title yellow');
    await fixedNote(job, 'the title should be bigger');
    await fixedNote(other, 'make the title yellow');

    const res = await app.request(`/api/jobs/${job.id}/fixes`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = jobFixesResponseSchema.parse(await res.json());
    expect(body.fixes.map((fix) => [fix.noteId, fix.status, fix.round])).toEqual([
      [first.id, 'fixed', 1],
      [expect.any(String), 'fixed', 1],
    ]);
    expect(body.fixes[0]).toMatchObject({
      said: 'The title is yellow now.',
      hasCompare: true,
      step: null,
    });
  });

  it('answers an empty list for a job with no fixes, and 404 for an unknown job', async () => {
    const job = await reviewJob();

    const res = await app.request(`/api/jobs/${job.id}/fixes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fixes: [] });
    await expectError(await app.request('/api/jobs/nope/fixes'), 404);
  });
});

describe('GET /api/jobs/:id/fixes/:fixId/compare/:file', () => {
  it.each(['before.png', 'after.png'])('serves %s as an image', async (file) => {
    const job = await reviewJob();
    const note = await fixedNote(job);

    const res = await app.request(`/api/jobs/${job.id}/fixes/${note.fixId}/compare/${file}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('answers 304 for a still the browser has, and the headers alone for HEAD', async () => {
    const job = await reviewJob();
    const note = await fixedNote(job);
    const url = `/api/jobs/${job.id}/fixes/${note.fixId}/compare/after.png`;
    const first = await app.request(url);
    const etag = first.headers.get('etag') ?? '';

    expect((await app.request(url, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    const head = await app.request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('answers 404 for any other name, an unknown fix, another job’s fix and an unknown job', async () => {
    const job = await reviewJob();
    const other = await reviewJob();
    const note = await fixedNote(job);
    const fix = note.fixId as string;

    for (const url of [
      `/api/jobs/${job.id}/fixes/${fix}/compare/other.png`,
      `/api/jobs/${job.id}/fixes/${fix}/compare/..%2Freply.json`,
      `/api/jobs/${job.id}/fixes/${fix}/compare/reply.json`,
      `/api/jobs/${job.id}/fixes/nope/compare/before.png`,
      `/api/jobs/${job.id}/fixes/..%2F..%2F${fix}/compare/before.png`,
      `/api/jobs/${other.id}/fixes/${fix}/compare/before.png`,
      `/api/jobs/nope/fixes/${fix}/compare/before.png`,
    ]) {
      await expectError(await app.request(url), 404);
    }
  });

  it('answers 404 for a fix whose still is not there', async () => {
    const job = await reviewJob();
    const note = await fixedNote(job);
    rmSync(join(inboxPath, job.relPath, 'edit', 'review', 'fixes', note.fixId as string), {
      recursive: true,
    });

    await expectError(
      await app.request(`/api/jobs/${job.id}/fixes/${note.fixId}/compare/before.png`),
      404,
    );
  });
});

describe('POST /api/jobs/:id/fixes/:fixId/undo', () => {
  it('puts the composition back and answers the fix, undone, with the job', async () => {
    const job = await reviewJob();
    const before = titleRule(job);
    const note = await fixedNote(job);
    expect(titleRule(job)).not.toBe(before);

    const res = await app.request(`/api/jobs/${job.id}/fixes/${note.fixId}/undo`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = undoFixResponseSchema.parse(await res.json());
    expect(body.fix).toMatchObject({ id: note.fixId, status: 'undone' });
    expect(body.job.id).toBe(job.id);
    expect(titleRule(job)).toBe(before);
    expect(notes.get(note.id)).toMatchObject({ fixId: null, fixedAt: null });
  });

  it('answers 409 for a fix that is not the newest fixed one', async () => {
    const job = await reviewJob();
    const first = await fixedNote(job, 'make the title yellow');
    await fixedNote(job, 'the title should be bigger');

    await expectError(
      await app.request(`/api/jobs/${job.id}/fixes/${first.fixId}/undo`, { method: 'POST' }),
      409,
      FIX_MESSAGES.notNewest,
    );
  });

  it('answers 409 busy while a fix is queued or running', async () => {
    const job = await reviewJob();
    const done = await fixedNote(job);
    const created = notes.create({
      id: 'later',
      jobId: job.id,
      kind: 'text',
      atSec: 3,
      text: 'the title should be bigger',
    });
    service.enqueue(
      job,
      notes.setRoute(created.id, { status: 'routed', route: QUICK }) as ReviewNote,
    );

    await expectError(
      await app.request(`/api/jobs/${job.id}/fixes/${done.fixId}/undo`, { method: 'POST' }),
      409,
      FIX_MESSAGES.busy,
    );
    await vi.waitFor(() => expect(service.reviewBlock(job.id)).toBeNull());
  });

  it('answers 404 for an unknown job or fix, and 409 when the job is not in Review', async () => {
    const job = await reviewJob();
    const note = await fixedNote(job);

    await expectError(await app.request('/api/jobs/nope/fixes/x/undo', { method: 'POST' }), 404);
    await expectError(
      await app.request(`/api/jobs/${job.id}/fixes/nope/undo`, { method: 'POST' }),
      404,
    );
    jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
    await expectError(
      await app.request(`/api/jobs/${job.id}/fixes/${note.fixId}/undo`, { method: 'POST' }),
      409,
    );
  });
});

describe('while the Quick fixes switch is off', () => {
  it('answers 404 “Quick fixes are off.” on every fix path, and mounts nothing', async () => {
    const job = await reviewJob();
    const off = createApp({
      jobs: { jobs, exportsDir: join(base, 'exports') },
      quickFixes: false,
      // Given, but not mounted while the switch is off.
      fixRoutes: { jobs, fixes: service },
    });

    for (const [method, url] of [
      ['GET', `/api/jobs/${job.id}/fixes`],
      ['POST', `/api/jobs/${job.id}/fixes/x/undo`],
      ['GET', `/api/jobs/${job.id}/fixes/x/compare/before.png`],
      ['GET', '/api/jobs/nope/fixes'],
    ] as const) {
      await expectError(await off.request(url, { method }), 404, FIX_MESSAGES.off);
    }
  });
});

describe('Export MP4 while a fix runs', () => {
  it('answers 409 busy until the fix has landed, then starts the render', async () => {
    const job = await reviewJob();
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const withExport = createApp({
      jobs: { jobs, exportsDir: join(base, 'exports') },
      preview: {
        jobs,
        inboxPath,
        exports: new ReviewExports({ inboxPath, render: async () => {} }),
        reviewBlock: (found) => service.reviewBlock(found.id),
      },
    });
    const created = notes.create({
      id: 'held',
      jobId: job.id,
      kind: 'text',
      atSec: 2,
      text: 'make the title yellow',
    });
    const fix = service.enqueue(
      job,
      notes.setRoute(created.id, { status: 'routed', route: QUICK }) as ReviewNote,
    );
    expect(fix).not.toBeNull();

    await expectError(
      await withExport.request(`/api/jobs/${job.id}/review-export`, { method: 'POST' }),
      409,
      FIX_MESSAGES.busy,
    );
    // Looking at the status is still fine.
    expect((await withExport.request(`/api/jobs/${job.id}/review-export`)).status).toBe(200);

    release();
    await vi.waitFor(() => expect(service.find(job.id, fix?.id ?? '')?.status).toBe('fixed'));
    const res = await withExport.request(`/api/jobs/${job.id}/review-export`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'making' });
  });
});
