import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { ROUTE_POLICIES } from '../team/route-policies.js';
import {
  injectTimelineRegistry,
  NO_PREVIEW_MESSAGE,
  PREVIEW_FILE_MISSING_MESSAGE,
} from './preview.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Formats (GN7): `/api/jobs/:id/preview/<format>/<path>` serves an extra format's composition,
// edit/preview-<format>/<path>. Today's route for the main format is what it was, and a first
// segment that is not one of the job's extra formats is still a path of the main preview.

const CLIENT = 'Pinewood';
const MAIN_HTML = '<!doctype html><html><head></head><body>main 9:16</body></html>';
const SQUARE_HTML = '<!doctype html><html><head></head><body>square 1:1</body></html>';

let base: string;
let inboxPath: string;
let jobs: JobRepository;
let app: Hono;
let two: string;
let one: string;
let noSquare: string;

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

const get = (id: string, path: string, method = 'GET'): Response | Promise<Response> =>
  app.request(`/api/jobs/${id}/preview/${path}`, { method });

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'studio-preview-formats-'));
  inboxPath = join(base, 'inbox');

  const outside = join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');

  // A job with two formats and both compositions.
  put('Two', 'edit/preview/index.html', MAIN_HTML);
  put('Two', 'edit/preview/cut.mp4', 'MAIN CUT');
  put('Two', 'edit/preview/fonts/Heebo.woff2', 'font');
  put('Two', 'edit/preview-1x1/index.html', SQUARE_HTML);
  put('Two', 'edit/preview-1x1/cut.mp4', 'SQUARE CUT');
  put('Two', 'edit/preview-1x1/music.mp3', 'music');
  put('Two', 'edit/preview-1x1/compositions/badge.html', '<template>square badge</template>');
  put('Two', 'edit/brief.md', 'BRIEF SECRET');
  symlinkSync(outside, join(inboxPath, CLIENT, 'Two', 'edit', 'preview-1x1', 'escape'));
  symlinkSync(
    join(outside, 'secret.txt'),
    join(inboxPath, CLIENT, 'Two', 'edit', 'preview-1x1', 'escape.txt'),
  );
  // A job with one format that has a folder named like a format inside its preview.
  put('One', 'edit/preview/index.html', MAIN_HTML);
  put('One', 'edit/preview/1x1/index.html', '<p>a folder named 1x1 inside the main preview</p>');
  put('One', 'edit/preview-1x1/index.html', SQUARE_HTML);
  // A job with two formats whose second composition is not there (yet).
  put('No square', 'edit/preview/index.html', MAIN_HTML);

  jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
  app = createApp({
    jobs: { jobs, exportsDir: join(base, 'exports') },
    preview: { jobs, inboxPath },
  });
  two = add('Two', ['1080x1920', '1080x1080']);
  one = add('One', null);
  noSquare = add('No square', ['1080x1920', '1080x1080']);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/jobs/:id/preview/<format>/<path>', () => {
  it('serves the extra format’s composition, with the timeline registry first in its head', async () => {
    const res = await get(two, '1x1/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(injectTimelineRegistry(SQUARE_HTML));
  });

  it('serves the files beside it from its own folder, not the main one’s', async () => {
    expect(await (await get(two, '1x1/cut.mp4')).text()).toBe('SQUARE CUT');
    expect(await (await get(two, '1x1/music.mp3')).text()).toBe('music');
    expect(await (await get(two, '1x1/compositions/badge.html')).text()).toContain('square badge');
  });

  it('supports HEAD and byte ranges like the main route', async () => {
    const head = await get(two, '1x1/cut.mp4', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    const ranged = await app.request(`/api/jobs/${two}/preview/1x1/cut.mp4`, {
      headers: { Range: 'bytes=0-5' },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('SQUARE');
  });

  it('answers 404 for a file that is not there, a missing composition and an unknown job', async () => {
    const missing = await get(two, '1x1/nope.png');
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json()).error).toBe(PREVIEW_FILE_MISSING_MESSAGE);

    const noComposition = await get(noSquare, '1x1/index.html');
    expect(noComposition.status).toBe(404);
    expect(apiErrorSchema.parse(await noComposition.json()).error).toBe(NO_PREVIEW_MESSAGE);

    const unknown = await get('0000000000ff', '1x1/index.html');
    expect(unknown.status).toBe(404);
  });

  it('refuses a path that leaves the format’s folder, as the main route does', async () => {
    for (const path of [
      '1x1/%2e%2e%2findex.html',
      '1x1/%2e%2e%2f%2e%2e%2fbrief.md',
      '1x1/escape/secret.txt',
      '1x1/escape.txt',
    ]) {
      const res = await get(two, path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain('SECRET');
    }
  });
});

describe('the main route is what it was', () => {
  it('serves the main composition at index.html for a job with two formats', async () => {
    const res = await get(two, 'index.html');
    expect(await res.text()).toBe(injectTimelineRegistry(MAIN_HTML));
    expect(await (await get(two, 'cut.mp4')).text()).toBe('MAIN CUT');
  });

  it('serves a nested path whose first segment is no format of the job from the main preview', async () => {
    expect(await (await get(two, 'fonts/Heebo.woff2')).text()).toBe('font');
  });

  it('keeps a folder named like a format of a job that has only one format', async () => {
    const res = await get(one, '1x1/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('a folder named 1x1 inside the main preview');
  });

  it('answers 404 for a format the job does not have, as a path of the main preview', async () => {
    const res = await get(two, '4x5/index.html');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(PREVIEW_FILE_MISSING_MESSAGE);
  });

  it('does not serve the extra composition of a job with one format by its id', async () => {
    // edit/preview-1x1 exists on disk but the job has no such format: it is not reachable.
    const res = await get(one, '1x1/cut.mp4');
    expect(res.status).toBe(404);
  });
});

describe('who may call it', () => {
  it('has a policy row of its own, for the job named in the path', () => {
    expect(
      ROUTE_POLICIES.find(
        (row) => row.method === 'GET' && row.pattern === '/api/jobs/:id/preview/:format/:path{.+}',
      ),
    ).toEqual({ method: 'GET', pattern: '/api/jobs/:id/preview/:format/:path{.+}', policy: 'job' });
  });
});
