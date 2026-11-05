import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPOSITION_INDEX,
  injectPlaysInline,
  injectTimelineRegistry,
  isSafePreviewPath,
  PLAYS_INLINE_ATTRIBUTES,
  PREVIEW_CONTENT_TYPES,
  previewContentType,
  serveCompositionFile,
  TIMELINE_REGISTRY_SCRIPT,
} from './composition-files.js';
import * as preview from './preview.js';

// serveCompositionFile on a real folder, behind a one-route app. What the Review preview and the
// Graphics preview both rely on; their own tests (preview.test.ts, graphic-files.test.ts) cover
// each route's own rules.

const MISSING = 'No such file here.';
const PAGE = '<!doctype html><html><head><title>x</title></head><body></body></html>';
const SCENE = '<template id="scene"><video src="scene.mp4" muted></video></template>';

let root: string;
let outside: string;
let app: Hono;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'composition-files-'));
  outside = mkdtempSync(join(tmpdir(), 'composition-files-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  writeFileSync(join(root, 'index.html'), PAGE);
  mkdirSync(join(root, 'compositions'));
  writeFileSync(join(root, 'compositions', 'badge.html'), PAGE);
  writeFileSync(join(root, 'compositions', 'scene.html'), SCENE);
  writeFileSync(join(root, 'data.json'), '{"a":1}');
  symlinkSync(outside, join(root, 'link'));

  app = new Hono();
  app.get('/files/:path{.+}', (c) =>
    serveCompositionFile(c, { root, name: c.req.param('path'), missingMessage: MISSING }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('the Review preview’s helpers', () => {
  it('are the same ones preview.ts has always exported', () => {
    expect(preview.injectTimelineRegistry).toBe(injectTimelineRegistry);
    expect(preview.isSafePreviewPath).toBe(isSafePreviewPath);
    expect(preview.previewContentType).toBe(previewContentType);
    expect(preview.PREVIEW_CONTENT_TYPES).toBe(PREVIEW_CONTENT_TYPES);
    expect(preview.TIMELINE_REGISTRY_SCRIPT).toBe(TIMELINE_REGISTRY_SCRIPT);
    expect(preview.injectPlaysInline).toBe(injectPlaysInline);
    expect(preview.PLAYS_INLINE_ATTRIBUTES).toBe(PLAYS_INLINE_ATTRIBUTES);
    expect(preview.PREVIEW_INDEX).toBe(COMPOSITION_INDEX);
    expect(COMPOSITION_INDEX).toBe('index.html');
  });
});

describe('serveCompositionFile', () => {
  it('sends the root index.html with the timeline registry first in its head', async () => {
    for (const name of ['index.html', './index.html', 'compositions/../index.html']) {
      const res = await app.request(`/files/${name}`);

      expect(res.status, name).toBe(200);
      expect(await res.text(), name).toBe(injectTimelineRegistry(PAGE));
    }
  });

  it('sends every other file as it is, with its content type and revalidation', async () => {
    const html = await app.request('/files/compositions/badge.html');
    const json = await app.request('/files/data.json');

    expect(await html.text()).toBe(PAGE);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('cache-control')).toBe('no-cache');
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.text()).toBe('{"a":1}');
  });

  it('adds playsinline to the videos of a sub-composition, for the Review and the Graphics preview alike', async () => {
    const res = await app.request('/files/compositions/scene.html');

    expect(await res.text()).toBe(
      '<template id="scene"><video src="scene.mp4" muted playsinline webkit-playsinline></video></template>',
    );
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{27}"$/);
    const again = await app.request('/files/compositions/scene.html', {
      headers: { 'If-None-Match': res.headers.get('etag') as string },
    });
    expect(again.status).toBe(304);
  });

  it('answers 304 to the ETag it sent, for the index and for a file', async () => {
    for (const name of ['index.html', 'data.json']) {
      const head = await app.request(`/files/${name}`, { method: 'HEAD' });
      const etag = head.headers.get('etag') as string;

      const res = await app.request(`/files/${name}`, { headers: { 'If-None-Match': etag } });

      expect(res.status, name).toBe(304);
    }
  });

  it.each([
    'nope.html',
    'compositions',
    '%2e%2e%2findex.html',
    '..%2findex.html',
    'link/secret.txt',
    'a%00b.html',
  ])('answers 404 with the caller’s sentence for %s', async (name) => {
    const res = await app.request(`/files/${name}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MISSING });
  });
});
