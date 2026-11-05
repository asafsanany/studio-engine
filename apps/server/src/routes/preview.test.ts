import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { apiErrorSchema, type Job, type JobEvent } from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { matchesIfNoneMatch } from './download.js';
import {
  injectPlaysInline,
  injectTimelineRegistry,
  isSafePreviewPath,
  NO_PREVIEW_MESSAGE,
  PREVIEW_CONTENT_TYPES,
  PREVIEW_FILE_MISSING_MESSAGE,
  previewContentType,
  TIMELINE_REGISTRY_SCRIPT,
} from './preview.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repository on an in-memory database, the real routes and a real folder of files;
// `app.request` for the HTTP, except in "over a real socket".

const CLIENT = 'Northwind Bakery';
// A Hebrew title, so the page's byte length differs from its character length.
const INDEX_HTML = `<!doctype html>
<html lang="he"><head><meta charset="utf-8"><title>פרומו לסוף השבוע</title></head>
<body><div data-composition-id="w4" data-width="1080"
data-height="1920" data-duration="6"></div>
<script src="vendor/gsap.min.js"></script></body></html>`;
/** What the route sends for INDEX_HTML: the same page with the timeline registry first in its head. */
const SERVED_INDEX = injectTimelineRegistry(INDEX_HTML);
const BADGE_HTML = '<template id="badge"><div>badge</div></template>\n';
const SAMPLE_INDEX = readFileSync(
  fileURLToPath(new URL('../pipeline/testdata/preview/index.html', import.meta.url)),
  'utf8',
);
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

const OUTPUT = {
  fileName: `${CLIENT}/Ready one.mp4`,
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 1000,
};

function events(...list: JobEvent[]): JobEvent[] {
  return list;
}

const SETTLED_AND_STARTED = events({ type: 'SETTLED' }, { type: 'START' });

/** Every state, with the events that reach it from a new (arriving) job. An array, not a Record. */
const STATE_PATHS: Array<[Job['state'], JobEvent[]]> = [
  ['arriving', []],
  ['queued', events({ type: 'SETTLED' })],
  ['held', events({ type: 'HOLD' })],
  ['editing', SETTLED_AND_STARTED],
  ['review', [...SETTLED_AND_STARTED, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW }]],
  ['ready', [...SETTLED_AND_STARTED, { type: 'SUCCEED', output: OUTPUT }]],
  ['failed', [...SETTLED_AND_STARTED, { type: 'FAIL', step: 4, error: 'boom' }]],
  ['cancelled', [...SETTLED_AND_STARTED, { type: 'CANCEL' }]],
];

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

async function bytesOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

let base: string;
let inboxPath: string;
let exportsDir: string;
let jobs: JobRepository;
let app: Hono;
let spring: string;

/** The job's folder, <inbox>/<client>/<name>. */
function jobDir(client: string, name: string): string {
  return join(inboxPath, client, name);
}

/** Writes `content` at `<job folder>/<rel>`, creating the folders. */
function put(client: string, name: string, rel: string, content: string | Buffer): void {
  const path = join(jobDir(client, name), rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Adds a job (arriving) and returns its id. */
function addJob(client: string, name: string): string {
  return jobs.upsertFromScan(makeScan(client, name)).job.id;
}

/** `/api/jobs/<id>/preview/<path>`; `path` is already as it goes on the wire. */
function previewPath(id: string, path: string): string {
  return `/api/jobs/${id}/preview/${path}`;
}

function get(
  id: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Response | Promise<Response> {
  return app.request(previewPath(id, path), { method, headers });
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'studio-preview-'));
  inboxPath = join(base, 'inbox');
  exportsDir = join(base, 'exports');

  // Outside every job: what must never come back.
  const outside = join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(outside, 'index.html'), '<p>TOP SECRET</p>');

  // The job with a preview.
  put(CLIENT, 'Spring menu', 'edit/brief.md', 'BRIEF SECRET');
  put(CLIENT, 'Spring menu', 'edit/preview/index.html', INDEX_HTML);
  put(CLIENT, 'Spring menu', 'edit/preview/vendor/gsap.min.js', 'gsap');
  put(CLIENT, 'Spring menu', 'edit/preview/compositions/badge.html', BADGE_HTML);
  put(CLIENT, 'Spring menu', 'edit/preview/sub/index.html', '<p>a page named index.html</p>');
  put(CLIENT, 'Spring menu', 'edit/preview/style.css', 'body{}');
  put(CLIENT, 'Spring menu', 'edit/preview/data.json', '{}');
  put(CLIENT, 'Spring menu', 'edit/preview/fonts/Heebo.woff2', 'font');
  put(CLIENT, 'Spring menu', 'edit/preview/music.mp3', 'music');
  put(CLIENT, 'Spring menu', 'edit/preview/logo.svg', '<svg/>');
  put(CLIENT, 'Spring menu', 'edit/preview/still.JPG', 'jpg');
  put(CLIENT, 'Spring menu', 'edit/preview/notes.xyz', 'notes');
  put(CLIENT, 'Spring menu', 'edit/preview/cut.mp4', BYTES);
  put(CLIENT, 'Spring menu', 'edit/preview/כותרת.png', 'hebrew');
  put(CLIENT, 'Spring menu', 'edit/preview/100%.png', 'percent');
  const preview = join(jobDir(CLIENT, 'Spring menu'), 'edit', 'preview');
  symlinkSync('cut.mp4', join(preview, 'alias.mp4'));
  symlinkSync(outside, join(preview, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(preview, 'escape.txt'));

  // Jobs the route has to refuse.
  put(CLIENT, 'No preview', 'edit/project.md', 'project');
  put(CLIENT, 'No index', 'edit/preview/cut.mp4', BYTES);
  mkdirSync(join(jobDir(CLIENT, 'Linked out'), 'edit'), { recursive: true });
  symlinkSync(outside, join(jobDir(CLIENT, 'Linked out'), 'edit', 'preview'));

  // The export, for the download guard.
  mkdirSync(join(exportsDir, CLIENT), { recursive: true });
  writeFileSync(join(exportsDir, CLIENT, 'Ready one.mp4'), BYTES);

  jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
  app = createApp({ jobs: { jobs, exportsDir }, preview: { jobs, inboxPath } });
  spring = addJob(CLIENT, 'Spring menu');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/jobs/:id/preview/<path>', () => {
  it('serves index.html inline and revalidated, with the timeline registry first in its head', async () => {
    const res = await get(spring, 'index.html');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{27}"$/);
    expect(res.headers.get('last-modified')).toBeTruthy();
    // The page is served whole: no ranges for it.
    expect(res.headers.get('accept-ranges')).toBeNull();
    // Bytes, not characters: the Hebrew title makes the two differ.
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(SERVED_INDEX)));
    expect(Buffer.byteLength(SERVED_INDEX)).toBeGreaterThan(SERVED_INDEX.length);
    const body = (await bytesOf(res)).toString('utf8');
    expect(body).toBe(SERVED_INDEX);
    expect(body).toContain(`<head>${TIMELINE_REGISTRY_SCRIPT}<meta charset="utf-8">`);
    expect(body.indexOf(TIMELINE_REGISTRY_SCRIPT)).toBeLessThan(body.indexOf('vendor/gsap.min.js'));
  });

  it('does not write the registry into the job folder', () => {
    const onDisk = readFileSync(
      join(jobDir(CLIENT, 'Spring menu'), 'edit', 'preview', 'index.html'),
      'utf8',
    );
    expect(onDisk).toBe(INDEX_HTML);
    expect(onDisk).not.toContain('__timelines');
  });

  it('puts the registry into the sample composition too, and leaves its own line', async () => {
    const id = addJob('Samples', 'Sample');
    put('Samples', 'Sample', 'edit/preview/index.html', SAMPLE_INDEX);

    const body = (await bytesOf(await get(id, 'index.html'))).toString('utf8');

    expect(body).toBe(injectPlaysInline(injectTimelineRegistry(SAMPLE_INDEX)));
    expect(body).toContain(`<head>${TIMELINE_REGISTRY_SCRIPT}`);
    expect(body.split('window.__timelines = window.__timelines || {};').length - 1).toBe(2);
    expect(SAMPLE_INDEX.split('window.__timelines = window.__timelines || {};').length - 1).toBe(1);
  });

  it('serves ./index.html with the registry too', async () => {
    // `.%2Findex.html` reaches the route as "./index.html" (a literal ./ is folded by the URL parser).
    const res = await get(spring, '.%2Findex.html');

    expect(res.status).toBe(200);
    expect((await bytesOf(res)).toString('utf8')).toBe(SERVED_INDEX);
  });

  it('serves a page named index.html in a sub-folder as it is', async () => {
    const res = await get(spring, 'sub/index.html');

    expect(res.status).toBe(200);
    expect((await bytesOf(res)).toString('utf8')).toBe('<p>a page named index.html</p>');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('serves a sub-composition and the cut exactly as they are on disk, with the size-mtime ETag', async () => {
    const badge = await get(spring, 'compositions/badge.html');
    expect(badge.status).toBe(200);
    expect(badge.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(badge.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(badge.headers.get('accept-ranges')).toBe('bytes');
    expect((await bytesOf(badge)).toString('utf8')).toBe(BADGE_HTML);

    const cut = await get(spring, 'cut.mp4');
    expect(cut.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(cut.headers.get('accept-ranges')).toBe('bytes');
    expect(await bytesOf(cut)).toEqual(BYTES);
  });

  it('adds playsinline to the videos of the root and of a sub-composition, and nothing else (PH9)', async () => {
    const id = addJob(CLIENT, 'Inline videos');
    const root = `<!doctype html><html><head><title>x</title></head><body>
<video id="cut" class="clip" src="cut.mp4" data-start="0"></video>
<video id="broll" src="broll.mp4" playsinline></video></body></html>`;
    const scene = '<template id="scene"><video src="scene.mp4" muted></video></template>\n';
    put(CLIENT, 'Inline videos', 'edit/preview/index.html', root);
    put(CLIENT, 'Inline videos', 'edit/preview/compositions/scene.html', scene);

    const page = await get(id, 'index.html');
    const body = (await bytesOf(page)).toString('utf8');
    expect(body).toBe(injectPlaysInline(injectTimelineRegistry(root)));
    expect(body).toContain(
      '<video id="cut" class="clip" src="cut.mp4" data-start="0" playsinline webkit-playsinline>',
    );
    expect(body).toContain('<video id="broll" src="broll.mp4" playsinline webkit-playsinline>');
    expect(page.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));

    const sub = await get(id, 'compositions/scene.html');
    expect(sub.status).toBe(200);
    expect(sub.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // Changed bytes: a hash ETag, and no ranges, like the root.
    expect(sub.headers.get('etag')).toMatch(/^"[0-9a-f]{27}"$/);
    expect(sub.headers.get('accept-ranges')).toBeNull();
    expect((await bytesOf(sub)).toString('utf8')).toBe(
      '<template id="scene"><video src="scene.mp4" muted playsinline webkit-playsinline></video></template>\n',
    );
    // HEAD has the headers only, and the same ETag answers 304.
    const head = await get(id, 'compositions/scene.html', {}, 'HEAD');
    expect(head.headers.get('etag')).toBe(sub.headers.get('etag'));
    expect(await head.text()).toBe('');
    const again = await get(id, 'compositions/scene.html', {
      'If-None-Match': sub.headers.get('etag') ?? '',
    });
    expect(again.status).toBe(304);

    // Nothing is written into the job's folder.
    expect(
      readFileSync(
        join(jobDir(CLIENT, 'Inline videos'), 'edit/preview/compositions/scene.html'),
        'utf8',
      ),
    ).toBe(scene);
  });

  it.each([
    ['vendor/gsap.min.js', 'text/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['data.json', 'application/json'],
    ['fonts/Heebo.woff2', 'font/woff2'],
    ['cut.mp4', 'video/mp4'],
    ['music.mp3', 'audio/mpeg'],
    ['logo.svg', 'image/svg+xml'],
    ['still.JPG', 'image/jpeg'],
    ['notes.xyz', 'application/octet-stream'],
  ])('sends %s as %s', async (path, type) => {
    const res = await get(spring, path);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
  });

  it('decodes the name once', async () => {
    const hebrew = await get(spring, encodeURIComponent('כותרת.png'));
    expect(hebrew.status).toBe(200);
    expect(hebrew.headers.get('content-type')).toBe('image/png');
    expect((await bytesOf(hebrew)).toString()).toBe('hebrew');

    const percent = await get(spring, '100%25.png');
    expect(percent.status).toBe(200);
    expect((await bytesOf(percent)).toString()).toBe('percent');
  });

  it('ignores the query string', async () => {
    const plain = await bytesOf(await get(spring, 'index.html'));
    const round = await get(spring, 'index.html?r=3');

    expect(round.status).toBe(200);
    expect(await bytesOf(round)).toEqual(plain);
    expect(plain.toString('utf8')).toBe(SERVED_INDEX);
  });

  it('follows a symlink that stays inside the preview', async () => {
    const res = await get(spring, 'alias.mp4');

    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(BYTES);
  });

  it.each(STATE_PATHS)('serves a job that is %s', async (state, walk) => {
    const id = addJob('States', state);
    for (const event of walk) jobs.applyTransition(id, event);
    put('States', state, 'edit/preview/index.html', `<p>${state}</p>`);

    const res = await get(id, 'index.html?r=0');

    expect(jobs.get(id)?.state).toBe(state);
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).toString()).toBe(injectTimelineRegistry(`<p>${state}</p>`));
  });
});

describe('byte ranges', () => {
  it('answers 206 with the slice and keeps revalidating', async () => {
    const res = await get(spring, 'cut.mp4', { Range: 'bytes=0-99' });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await bytesOf(res)).toEqual(BYTES.subarray(0, 100));
  });

  it('answers 416 for a range past the end', async () => {
    const res = await get(spring, 'cut.mp4', { Range: 'bytes=1000-' });

    expect(await expectError(res, 416)).toBe('Range not satisfiable.');
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('honours If-Range only with the current ETag', async () => {
    const etag = (await get(spring, 'cut.mp4')).headers.get('etag') as string;

    const current = await get(spring, 'cut.mp4', { Range: 'bytes=0-9', 'If-Range': etag });
    expect(current.status).toBe(206);
    expect(await bytesOf(current)).toEqual(BYTES.subarray(0, 10));

    const stale = await get(spring, 'cut.mp4', { Range: 'bytes=0-9', 'If-Range': '"stale"' });
    expect(stale.status).toBe(200);
    expect(await bytesOf(stale)).toEqual(BYTES);
  });
});

describe('index.html is not ranged', () => {
  it('answers a Range with 200 and the whole page', async () => {
    const res = await get(spring, 'index.html', { Range: 'bytes=0-9' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBeNull();
    expect((await bytesOf(res)).toString('utf8')).toBe(SERVED_INDEX);
  });

  it('answers HEAD with the headers of the page and no body', async () => {
    const res = await get(spring, 'index.html', {}, 'HEAD');
    const full = await get(spring, 'index.html');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(SERVED_INDEX)));
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toBe(full.headers.get('etag'));
    expect((await bytesOf(res)).length).toBe(0);
  });
});

describe('HEAD', () => {
  it('sends the headers and no body', async () => {
    const res = await get(spring, 'cut.mp4', {}, 'HEAD');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await bytesOf(res)).length).toBe(0);
  });
});

describe('revalidation (304)', () => {
  async function etagOf(path: string): Promise<string> {
    return (await get(spring, path)).headers.get('etag') as string;
  }

  it('answers 304 with no body for the current ETag', async () => {
    const etag = await etagOf('index.html');

    const res = await get(spring, 'index.html', { 'If-None-Match': etag });

    expect(res.status).toBe(304);
    expect((await bytesOf(res)).length).toBe(0);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it.each([
    ['a weak tag', (etag: string) => `W/${etag}`],
    ['a list with the tag', (etag: string) => `"other", ${etag}`],
    ['the tag alone', (etag: string) => etag],
    ['a star', () => '*'],
  ])('answers 304 for %s', async (_label, header) => {
    const etag = await etagOf('index.html');

    const res = await get(spring, 'index.html', { 'If-None-Match': header(etag) });

    expect(res.status).toBe(304);
  });

  it('sends the whole file for a tag that is not current', async () => {
    const res = await get(spring, 'index.html', { 'If-None-Match': '"stale"' });

    expect(res.status).toBe(200);
    expect((await bytesOf(res)).toString('utf8')).toBe(SERVED_INDEX);
  });

  it('does not take the size-mtime tag of the file for the tag of the page', async () => {
    // The bytes sent are not the file's bytes, so the tag is a hash of what is sent.
    const etag = await etagOf('index.html');
    expect(etag).toMatch(/^"[0-9a-f]{27}"$/);
    const res = await get(spring, 'index.html', {
      'If-None-Match': `"${INDEX_HTML.length.toString(16)}-0"`,
    });
    expect(res.status).toBe(200);
  });

  it('answers 304 with only the validators for the current tag of index.html', async () => {
    const etag = await etagOf('index.html');

    const res = await get(spring, 'index.html', { 'If-None-Match': etag });

    expect(res.status).toBe(304);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBeNull();
  });

  it('answers a HEAD of index.html with a current tag 304 too', async () => {
    const etag = await etagOf('index.html');

    const res = await get(spring, 'index.html', { 'If-None-Match': etag }, 'HEAD');

    expect(res.status).toBe(304);
  });

  it('keeps the tag when only the modified time changes, and changes it with the bytes', async () => {
    const id = addJob('Rounds', 'Touched');
    put('Rounds', 'Touched', 'edit/preview/index.html', '<p>same</p>');
    const before = (await get(id, 'index.html')).headers.get('etag');

    const file = join(jobDir('Rounds', 'Touched'), 'edit', 'preview', 'index.html');
    utimesSync(file, new Date(), new Date(Date.now() + 9_000));
    expect((await get(id, 'index.html')).headers.get('etag')).toBe(before);

    writeFileSync(file, '<p>other</p>');
    expect((await get(id, 'index.html')).headers.get('etag')).not.toBe(before);
  });

  it('answers 304, not 206, when a Range comes with a current tag', async () => {
    const etag = await etagOf('cut.mp4');

    const res = await get(spring, 'cut.mp4', { 'If-None-Match': etag, Range: 'bytes=0-9' });

    expect(res.status).toBe(304);
  });

  it('answers a HEAD with a current tag 304 too', async () => {
    const etag = await etagOf('cut.mp4');

    const res = await get(spring, 'cut.mp4', { 'If-None-Match': etag }, 'HEAD');

    expect(res.status).toBe(304);
  });

  it('fetches a changed file again', async () => {
    const id = addJob('Rounds', 'Round');
    put('Rounds', 'Round', 'edit/preview/index.html', '<p>round one</p>');
    const first = await get(id, 'index.html?r=0');
    const oldTag = first.headers.get('etag') as string;

    const file = join(jobDir('Rounds', 'Round'), 'edit', 'preview', 'index.html');
    writeFileSync(file, '<p>round two, longer</p>');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const second = await get(id, 'index.html?r=1', { 'If-None-Match': oldTag });

    expect(second.status).toBe(200);
    expect((await bytesOf(second)).toString()).toBe(
      injectTimelineRegistry('<p>round two, longer</p>'),
    );
    expect(second.headers.get('etag')).not.toBe(oldTag);
  });
});

describe('404', () => {
  it('names an unknown job', async () => {
    const message = await expectError(await get('nosuchjob00', 'index.html'), 404);

    expect(message).toContain('nosuchjob00');
  });

  it('says a job without edit/preview has no preview', async () => {
    const id = addJob(CLIENT, 'No preview');

    expect(await expectError(await get(id, 'index.html'), 404)).toBe(NO_PREVIEW_MESSAGE);
    expect(await expectError(await get(id, 'cut.mp4'), 404)).toBe(NO_PREVIEW_MESSAGE);
  });

  it('says a preview without index.html is no preview, even for a file that exists', async () => {
    const id = addJob(CLIENT, 'No index');

    expect(await expectError(await get(id, 'index.html'), 404)).toBe(NO_PREVIEW_MESSAGE);
    expect(await expectError(await get(id, 'cut.mp4'), 404)).toBe(NO_PREVIEW_MESSAGE);
  });

  it('says a preview folder that is a symlink out is no preview', async () => {
    const id = addJob(CLIENT, 'Linked out');

    const res = await get(id, 'index.html');

    expect(await expectError(res, 404)).toBe(NO_PREVIEW_MESSAGE);
  });

  it('says a missing file is missing', async () => {
    const res = await get(spring, 'nope.js');

    expect(await expectError(res, 404)).toBe(PREVIEW_FILE_MISSING_MESSAGE);
  });

  it.each(['fonts', 'fonts/'])('does not serve the folder %s', async (path) => {
    const res = await get(spring, path);

    expect(await expectError(res, 404)).toBe(PREVIEW_FILE_MISSING_MESSAGE);
  });

  it.each(['/preview/', '/preview'])(
    'answers the app 404 for %s with no file name',
    async (tail) => {
      const res = await app.request(`/api/jobs/${spring}${tail}`);

      expect(await expectError(res, 404)).toBe('Not found');
    },
  );

  // Dot segments (`../`, `%2e%2e/`) are folded by the URL parser before routing, so those land on
  // another path and get the app's own 404. The encoded slashes below reach the route.
  const ESCAPES: Array<[string, () => string]> = [
    ['..', () => '../brief.md'],
    ['%2e%2e', () => '%2e%2e/brief.md'],
    ['%2E%2E three deep', () => '%2E%2E/%2e%2e/%2e%2e/outside/secret.txt'],
    ['..%2F', () => '..%2Fbrief.md'],
    ['%2e%2e%2f', () => '%2e%2e%2fbrief.md'],
    ['a segment then ..', () => 'vendor%2F..%2F..%2Fbrief.md'],
    ['..%2F five deep', () => '..%2F..%2F..%2F..%2F..%2Foutside%2Fsecret.txt'],
    ['an absolute path', () => encodeURIComponent(join(base, 'outside', 'secret.txt'))],
    ['a double slash', () => `/${join(base, 'outside', 'secret.txt')}`],
    ['a folder symlink out', () => 'escape/secret.txt'],
    ['a file symlink out', () => 'escape.txt'],
    ['a NUL byte', () => 'index.html%00.png'],
    ['a double-encoded ..', () => '%252e%252e%252fbrief.md'],
  ];

  it.each(ESCAPES)('never serves a file outside edit/preview: %s', async (_label, build) => {
    const res = await get(spring, build());

    await expectError(res.clone(), 404);
    expect(await res.text()).not.toContain('SECRET');
  });

  it.each([
    ['..%2F', () => '..%2Fbrief.md'],
    ['%2e%2e%2f', () => '%2e%2e%2fbrief.md'],
    ['an absolute path', () => encodeURIComponent(join(base, 'outside', 'secret.txt'))],
    ['a folder symlink out', () => 'escape/secret.txt'],
    ['a file symlink out', () => 'escape.txt'],
    ['a NUL byte', () => 'index.html%00.png'],
    ['a double-encoded ..', () => '%252e%252e%252fbrief.md'],
  ])('reaches the route and is refused as a missing file: %s', async (_label, build) => {
    const res = await get(spring, build());

    expect(await expectError(res, 404)).toBe(PREVIEW_FILE_MISSING_MESSAGE);
  });
});

describe('over a real socket', () => {
  let server: Server;
  let port: number;

  function rawGet(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
        resolve(listening as Server),
      ) as Server;
      listening.once('error', reject);
    });
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves index.html', async () => {
    const res = await rawGet(previewPath(spring, 'index.html'));

    expect(res.status).toBe(200);
    expect(res.body).toBe(SERVED_INDEX);
  });

  it.each([
    '../brief.md',
    '%2e%2e/brief.md',
    '..%2fbrief.md',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2foutside%2fsecret.txt',
    'escape/secret.txt',
  ])('refuses %s', async (path) => {
    const res = await rawGet(previewPath(spring, path));

    expect(res.status).toBe(404);
    expect(res.body).not.toContain('SECRET');
  });
});

describe('injectTimelineRegistry', () => {
  const R = TIMELINE_REGISTRY_SCRIPT;

  it('is the script that creates the registry only when missing', () => {
    expect(R).toBe('<script>window.__timelines = window.__timelines || {};</script>');
  });

  it.each([
    [
      'a plain head',
      '<html><head><title>x</title></head><body></body></html>',
      `<html><head>${R}<title>x</title></head><body></body></html>`,
    ],
    [
      'a head with attributes in capitals',
      '<HTML><HEAD lang="he"><title>x</title></HEAD></HTML>',
      `<HTML><HEAD lang="he">${R}<title>x</title></HEAD></HTML>`,
    ],
    [
      'a head after a <header> in a comment',
      '<!-- <header> --><html><head><meta></head></html>',
      `<!-- <header> --><html><head>${R}<meta></head></html>`,
    ],
    [
      'a head that is also named in a comment before it',
      '<!-- <head> --><head><meta></head>',
      `<!-- <head> --><head>${R}<meta></head>`,
    ],
    [
      'no head, but an html tag',
      '<html lang="he"><body>x</body></html>',
      `<html lang="he">${R}<body>x</body></html>`,
    ],
    ['only a doctype', '<!DOCTYPE html><div>x</div>', `<!DOCTYPE html>${R}<div>x</div>`],
    ['a bare fragment', '<div>x</div>', `${R}<div>x</div>`],
    ['nothing', '', R],
  ])('puts it right after the right tag: %s', (_label, html, expected) => {
    expect(injectTimelineRegistry(html)).toBe(expected);
  });

  it('does not take <header> for the head', () => {
    expect(injectTimelineRegistry('<html><body><header>x</header></body></html>')).toBe(
      `<html>${R}<body><header>x</header></body></html>`,
    );
    expect(injectTimelineRegistry('<header>x</header>')).toBe(`${R}<header>x</header>`);
  });

  it('gives the same text when run twice, and leaves a page that has the exact tag alone', () => {
    const page = '<html><head><title>x</title></head></html>';
    const once = injectTimelineRegistry(page);
    expect(injectTimelineRegistry(once)).toBe(once);
    const own = `<html><head><title>x</title>${R}</head></html>`;
    expect(injectTimelineRegistry(own)).toBe(own);
  });

  it("adds it to W9's sample, which makes the registry itself, and leaves its own line", () => {
    const own = 'window.__timelines = window.__timelines || {};';
    const out = injectTimelineRegistry(SAMPLE_INDEX);
    expect(out).toContain(`<head>${R}`);
    expect(out.split(own)).toHaveLength(3);
    expect(out.replace(R, '')).toBe(SAMPLE_INDEX);
  });

  it('keeps Hebrew and every other byte of the page', () => {
    const page = '<head><title>פרומו</title></head>';
    expect(injectTimelineRegistry(page)).toBe(`<head>${R}<title>פרומו</title></head>`);
  });
});

describe('injectPlaysInline', () => {
  it.each([
    [
      'a bare video',
      '<video src="a.mp4"></video>',
      '<video src="a.mp4" playsinline webkit-playsinline></video>',
    ],
    [
      'a video with only playsinline',
      '<video playsinline src="a.mp4">',
      '<video playsinline src="a.mp4" webkit-playsinline>',
    ],
    [
      'a video with only the old name',
      '<video webkit-playsinline>',
      '<video webkit-playsinline playsinline>',
    ],
    [
      'capitals and a value',
      '<VIDEO PlaysInline="true" Src=a.mp4>',
      '<VIDEO PlaysInline="true" Src=a.mp4 webkit-playsinline>',
    ],
    [
      'a tag that ends in a space',
      '<video src="a.mp4" >',
      '<video src="a.mp4" playsinline webkit-playsinline>',
    ],
    [
      'a self-closed tag',
      '<video src="a.mp4"/>',
      '<video src="a.mp4" playsinline webkit-playsinline/>',
    ],
    [
      'a tag over lines',
      '<video\n  src="a.mp4"\n  muted\n>',
      '<video\n  src="a.mp4"\n  muted\nplaysinline webkit-playsinline>',
    ],
    [
      'a > inside a quoted value',
      '<video title="a > b" src="a.mp4">',
      '<video title="a > b" src="a.mp4" playsinline webkit-playsinline>',
    ],
    [
      'the words only inside a value',
      '<video data-note="playsinline webkit-playsinline">',
      '<video data-note="playsinline webkit-playsinline" playsinline webkit-playsinline>',
    ],
  ])('adds what is missing: %s', (_label, html, expected) => {
    expect(injectPlaysInline(html)).toBe(expected);
  });

  it('leaves a page whose videos have both alone, and gives the same text when run twice', () => {
    const page = '<video src="a.mp4" playsinline webkit-playsinline></video>';
    expect(injectPlaysInline(page)).toBe(page);
    const once = injectPlaysInline('<video src="a.mp4"></video><video src="b.mp4"></video>');
    expect(injectPlaysInline(once)).toBe(once);
    expect(once.split('playsinline webkit-playsinline')).toHaveLength(3);
  });

  it('does not take <video-player>, <videos> or a video in a comment, a script or a style for a video', () => {
    const page = [
      '<video-player src="a"></video-player><videos></videos>',
      '<!-- <video src="old.mp4"> -->',
      '<script>el.innerHTML = \'<video src="x.mp4">\'; if (a > b) {}</script>',
      '<style>video { width: 100% } /* <video> */</style>',
    ].join('\n');
    expect(injectPlaysInline(page)).toBe(page);
  });

  it("leaves W9's sample alone (its video already has playsinline) apart from the old name", () => {
    const out = injectPlaysInline(SAMPLE_INDEX);
    expect(out).toContain('data-has-audio="true" webkit-playsinline>');
    expect(out.replace(' webkit-playsinline', '')).toBe(SAMPLE_INDEX);
  });

  it('keeps Hebrew and every other byte of the page', () => {
    const page = '<p>פרומו</p><video src="סרט.mp4"></video>';
    expect(injectPlaysInline(page)).toBe(
      '<p>פרומו</p><video src="סרט.mp4" playsinline webkit-playsinline></video>',
    );
  });
});

describe('helpers', () => {
  describe('previewContentType', () => {
    it.each([...PREVIEW_CONTENT_TYPES])('maps .%s to %s', (extension, type) => {
      expect(previewContentType(`file.${extension}`)).toBe(type);
    });

    it('ignores the case of the extension', () => {
      expect(previewContentType('A.MP4')).toBe('video/mp4');
    });

    it.each(['x', '.hidden', 'x.constructor', 'x.__proto__', 'x.toString'])(
      'falls back to octet-stream for %s',
      (name) => {
        expect(previewContentType(name)).toBe('application/octet-stream');
      },
    );
  });

  describe('isSafePreviewPath', () => {
    it.each(['index.html', 'fonts/Heebo.woff2', '..foo', 'a/..b/c', 'a/./b'])(
      'accepts %s',
      (path) => {
        expect(isSafePreviewPath(path)).toBe(true);
      },
    );

    it.each(['', 'a\0b', '/etc/hosts', '..', '../x', 'a/../b', 'a/..'])('refuses %j', (path) => {
      expect(isSafePreviewPath(path)).toBe(false);
    });
  });

  describe('matchesIfNoneMatch', () => {
    const etag = '"3e8-19a2b3c4d5e"';

    it('compares tags weakly, in lists, and takes a star', () => {
      expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
      expect(matchesIfNoneMatch(etag, etag)).toBe(true);
      expect(matchesIfNoneMatch(`W/${etag}`, etag)).toBe(true);
      expect(matchesIfNoneMatch(`"a", ${etag} , "b"`, etag)).toBe(true);
      expect(matchesIfNoneMatch('*', etag)).toBe(true);
      expect(matchesIfNoneMatch('"other"', etag)).toBe(false);
      expect(matchesIfNoneMatch('3e8-19a2b3c4d5e', etag)).toBe(false);
    });
  });
});

describe('mounting', () => {
  it('sits next to the jobs routes', async () => {
    const list = await app.request('/api/jobs');
    expect(list.status).toBe(200);

    const download = await app.request(`/api/jobs/${spring}/download`);
    expect(await expectError(download, 404)).toBe('This job has no export yet.');
  });

  it('is not there when the app is built without it', async () => {
    const bare = createApp({ jobs: { jobs, exportsDir } });

    const res = await bare.request(previewPath(spring, 'index.html'));

    expect(await expectError(res, 404)).toBe('Not found');
  });
});

describe('the download is unchanged', () => {
  let id: string;

  beforeAll(() => {
    // `ready`, with the export at <exports>/Northwind Bakery/Ready one.mp4.
    id = addJob(CLIENT, 'Ready one');
    for (const event of STATE_PATHS.find(([state]) => state === 'ready')?.[1] ?? []) {
      jobs.applyTransition(id, event);
    }
  });

  it('still sends the export as an attachment with no cache header', async () => {
    const res = await app.request(`/api/jobs/${id}/download`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Ready one.mp4"; filename*=UTF-8''Ready%20one.mp4`,
    );
    expect(res.headers.get('cache-control')).toBeNull();
    expect(await bytesOf(res)).toEqual(BYTES);
  });

  it('ignores If-None-Match: the download is never a 304', async () => {
    const etag = (await app.request(`/api/jobs/${id}/download`)).headers.get('etag') as string;

    const res = await app.request(`/api/jobs/${id}/download`, {
      headers: { 'If-None-Match': etag },
    });

    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(BYTES);
  });
});
