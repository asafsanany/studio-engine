import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiErrorSchema, type Job } from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ReviewExports } from '../clients/review-export.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { ROUTE_POLICIES } from '../team/route-policies.js';
import {
  exportFormatOf,
  NO_EXPORT_FORMAT_MESSAGE,
  NO_PREVIEW_MESSAGE,
  NO_REVIEW_EXPORT_MESSAGE,
} from './preview.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Export MP4 in Review (C65): on a job with two formats the export is the format on show. `?format=`
// on the three export routes names an extra format; none, or the main format's id, is the main
// format's export, as it was. A job with one format has the routes it had.

const CLIENT = 'Pinewood';
const PAGE = '<!doctype html><html><head></head><body>page</body></html>';

let base: string;
let inboxPath: string;
let jobs: JobRepository;
let exports: ReviewExports;
let app: Hono;
let two: string;
let one: string;
let noSquare: string;
const renders: string[] = [];

function put(name: string, rel: string, content: string): void {
  const path = join(inboxPath, CLIENT, name, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function add(name: string, canvases: string[] | null): string {
  const id = jobs.upsertFromScan(makeScan(CLIENT, name)).job.id;
  if (canvases !== null) jobs.setFormats(id, canvases);
  return id;
}

const call = (id: string, path: string, method = 'GET'): Response | Promise<Response> =>
  app.request(`/api/jobs/${id}/${path}`, { method });

const status = async (id: string, query = ''): Promise<unknown> =>
  (await call(id, `review-export${query}`)).json();

async function made(id: string, formatId?: string): Promise<void> {
  const job = jobs.get(id) as Job;
  await exports.idle(job.id, formatId);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'studio-preview-export-'));
  inboxPath = join(base, 'inbox');

  put('Two', 'edit/preview/index.html', PAGE);
  put('Two', 'edit/preview-1x1/index.html', PAGE);
  put('One', 'edit/preview/index.html', PAGE);
  // Left over from when it had a second format: not a size this job has.
  put('One', 'edit/preview-1x1/index.html', PAGE);
  put('No square', 'edit/preview/index.html', PAGE);

  jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
  exports = new ReviewExports({
    inboxPath,
    render: async (cwd, out) => {
      const square = cwd.endsWith('preview-1x1');
      renders.push(square ? '1x1' : 'main');
      writeFileSync(out, square ? 'SQUARE VIDEO' : 'MAIN VIDEO');
    },
  });
  app = createApp({
    jobs: { jobs, exportsDir: join(base, 'exports') },
    preview: { jobs, inboxPath, exports },
  });
  two = add('Two', ['1080x1920', '1080x1080']);
  one = add('One', null);
  noSquare = add('No square', ['1080x1920', '1080x1080']);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('Export MP4 of a job with two formats', () => {
  it('starts the extra format’s render, from its own composition, without touching the main one', async () => {
    expect(await status(two, '?format=1x1')).toEqual({ state: 'idle' });
    const started = await call(two, 'review-export?format=1x1', 'POST');
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ state: 'making' });
    await made(two, '1x1');
    expect(renders).toEqual(['1x1']);
    expect(await status(two, '?format=1x1')).toEqual({ state: 'ready' });
    // The main format's export is not made by it.
    expect(await status(two)).toEqual({ state: 'idle' });
    expect((await call(two, 'review-export.mp4')).status).toBe(404);
  });

  it('sends the extra format’s file as “<job> (1x1).mp4”', async () => {
    const res = await call(two, 'review-export.mp4?r=1&format=1x1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(decodeURIComponent(disposition)).toContain('Two (1x1).mp4');
    expect(await res.text()).toBe('SQUARE VIDEO');
  });

  it('makes the main format’s export as it always did, saved as “<job>.mp4”', async () => {
    const started = await call(two, 'review-export', 'POST');
    expect(await started.json()).toEqual({ state: 'making' });
    await made(two);
    expect(renders).toEqual(['1x1', 'main']);
    expect(await status(two)).toEqual({ state: 'ready' });

    const res = await call(two, 'review-export.mp4?r=1');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(decodeURIComponent(disposition)).toContain('filename="Two.mp4"');
    expect(decodeURIComponent(disposition)).not.toContain('1x1');
    expect(await res.text()).toBe('MAIN VIDEO');
  });

  it('takes the main format’s own id for the main format', async () => {
    expect(await status(two, '?format=9x16')).toEqual({ state: 'ready' });
    const res = await call(two, 'review-export.mp4?format=9x16');
    expect(await res.text()).toBe('MAIN VIDEO');
    expect(decodeURIComponent(res.headers.get('content-disposition') ?? '')).toContain('Two.mp4');
  });

  it('answers 404 for a size the job does not have, never the other size’s file', async () => {
    for (const [method, path] of [
      ['POST', 'review-export?format=4x5'],
      ['GET', 'review-export?format=4x5'],
      ['GET', 'review-export.mp4?format=4x5'],
    ] as const) {
      const res = await call(two, path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).error).toBe(NO_EXPORT_FORMAT_MESSAGE);
    }
    expect(renders).toEqual(['1x1', 'main']);
  });

  it('answers 404 for a format whose composition is not there yet', async () => {
    const res = await call(noSquare, 'review-export?format=1x1', 'POST');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(NO_PREVIEW_MESSAGE);
    const file = await call(noSquare, 'review-export.mp4?format=1x1');
    expect(file.status).toBe(404);
    expect(apiErrorSchema.parse(await file.json()).error).toBe(NO_REVIEW_EXPORT_MESSAGE);
  });
});

describe('Export MP4 of a job with one format is what it was', () => {
  it('makes and sends the one export with no format in the address', async () => {
    const before = renders.length;
    expect(await status(one)).toEqual({ state: 'idle' });
    const started = await call(one, 'review-export', 'POST');
    expect(await started.json()).toEqual({ state: 'making' });
    await made(one);
    expect(renders.slice(before)).toEqual(['main']);
    expect(await status(one)).toEqual({ state: 'ready' });
    const res = await call(one, 'review-export.mp4?r=1');
    expect(res.status).toBe(200);
    expect(decodeURIComponent(res.headers.get('content-disposition') ?? '')).toContain(
      'filename="One.mp4"',
    );
    expect(await res.text()).toBe('MAIN VIDEO');
  });

  it('does not export a folder left from a second format, even when asked by its id', async () => {
    for (const [method, path] of [
      ['POST', 'review-export?format=1x1'],
      ['GET', 'review-export?format=1x1'],
      ['GET', 'review-export.mp4?format=1x1'],
    ] as const) {
      const res = await call(one, path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).error).toBe(NO_EXPORT_FORMAT_MESSAGE);
    }
  });
});

describe('exportFormatOf', () => {
  const twoFormats = () => jobs.get(two) as Job;
  const oneFormat = () => jobs.get(one) as Job;

  it('is the main format with no format asked, or the main format’s id', () => {
    expect(exportFormatOf(twoFormats(), undefined)).toBeUndefined();
    expect(exportFormatOf(twoFormats(), '')).toBeUndefined();
    expect(exportFormatOf(twoFormats(), '9x16')).toBeUndefined();
  });

  it('is the extra format’s id for an extra format of the job', () => {
    expect(exportFormatOf(twoFormats(), '1x1')).toBe('1x1');
  });

  it('is null for any other size, and for any size at all on a job with one format', () => {
    expect(exportFormatOf(twoFormats(), '4x5')).toBeNull();
    expect(exportFormatOf(twoFormats(), '../x')).toBeNull();
    expect(exportFormatOf(oneFormat(), '1x1')).toBeNull();
    expect(exportFormatOf(oneFormat(), '9x16')).toBeNull();
    expect(exportFormatOf(oneFormat(), undefined)).toBeUndefined();
  });
});

describe('who may call it', () => {
  it('keeps the policy rows of the three export routes (the format is a query, not a path)', () => {
    for (const [method, pattern] of [
      ['POST', '/api/jobs/:id/review-export'],
      ['GET', '/api/jobs/:id/review-export'],
      ['GET', '/api/jobs/:id/review-export.mp4'],
    ] as const) {
      expect(
        ROUTE_POLICIES.find((row) => row.method === method && row.pattern === pattern),
      ).toEqual({ method, pattern, policy: 'job' });
    }
  });
});
