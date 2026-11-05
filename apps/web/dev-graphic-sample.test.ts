import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GRAPHIC_SAMPLE_BASE,
  GRAPHIC_SAMPLE_ID,
  GRAPHIC_SAMPLE_LENGTH_SEC,
  type GraphicHostRenderer,
  graphicSampleMiddleware,
  graphicSamplePlugin,
  readVars,
} from './dev-graphic-sample.ts';

// The canned graphic's route, over a real HTTP server and two temp folders. The host renderer is a
// stub that echoes what it was asked for; the real one is graphics/graphic-host.ts, loaded by Vite.

describe('readVars', () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it('reads the values as encodeGraphicVars writes them, Hebrew included', () => {
    expect(readVars(encode({ name: 'דנה לוי', role: '' }))).toEqual({ name: 'דנה לוי', role: '' });
  });

  it('is no values for no parameter', () => {
    expect(readVars(null)).toEqual({});
    expect(readVars('')).toEqual({});
  });

  it.each([
    ['not an object', encode(['a'])],
    ['text that is not an object', encode('a')],
    ['a value that is not text', encode({ a: 1 })],
    ['not JSON', 'aGVsbG8'],
  ])('is null for %s', (_label, vars) => {
    expect(readVars(vars)).toBeNull();
  });
});

describe('graphicSamplePlugin', () => {
  it('is dev only, and touches no file when it is created', () => {
    const plugin = graphicSamplePlugin({ sampleDir: '/x', assetsDir: '/y', hostModule: '/z' });
    expect(plugin.apply).toBe('serve');
    expect(plugin.name).toBe('studio-graphic-sample');
  });

  it('is mounted where the gallery looks for it', () => {
    expect(GRAPHIC_SAMPLE_BASE).toBe('/__dev/graphic-sample');
    expect(GRAPHIC_SAMPLE_ID).toMatch(/^[0-9a-f]{12}$/);
    expect(GRAPHIC_SAMPLE_LENGTH_SEC).toBe(3);
  });
});

describe('the /__dev/graphic-sample/ route', () => {
  let sampleDir: string;
  let assetsDir: string;
  let server: http.Server;
  let base: string;
  const asked: Array<Parameters<GraphicHostRenderer['renderGraphicHost']>[0]> = [];

  beforeAll(async () => {
    sampleDir = mkdtempSync(join(tmpdir(), 'graphic-sample-'));
    assetsDir = mkdtempSync(join(tmpdir(), 'graphic-assets-'));
    mkdirSync(join(sampleDir, 'compositions'));
    writeFileSync(
      join(sampleDir, 'compositions', `lib-${GRAPHIC_SAMPLE_ID}.html`),
      '<template>x</template>',
    );
    mkdirSync(join(assetsDir, 'vendor'));
    writeFileSync(join(assetsDir, 'vendor', 'gsap.min.js'), 'gsap');
    writeFileSync(join(assetsDir, 'sample-9x16.svg'), '<svg/>');

    const middleware = graphicSampleMiddleware({
      sampleDir,
      assetsDir,
      loadHost: async () => ({
        renderGraphicHost(options) {
          asked.push(options);
          return `<html>${options.id} ${options.size} ${options.background}</html>`;
        },
      }),
    });
    server = http.createServer((req, res) => {
      // As connect does for a mount: the path without the mount.
      req.url = (req.url ?? '/').replace(GRAPHIC_SAMPLE_BASE, '') || '/';
      void middleware(req, res, () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${GRAPHIC_SAMPLE_BASE}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sampleDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  const hostPath = (query = '', version = 3) =>
    `${base}/${GRAPHIC_SAMPLE_ID}/v/${version}/host.html${query}`;

  it('makes the host page with the real renderer, for any version', async () => {
    asked.length = 0;
    const res = await fetch(hostPath('?size=16x9&bg=checker', 7));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(`<html>${GRAPHIC_SAMPLE_ID} 16x9 checker</html>`);
    expect(asked[0]).toEqual({
      id: GRAPHIC_SAMPLE_ID,
      lengthSec: 3,
      size: '16x9',
      background: 'checker',
      values: {},
      assetsBase: `${GRAPHIC_SAMPLE_BASE}/assets`,
    });
  });

  it('defaults to 9:16 over the sample frame, and passes the text values on', async () => {
    asked.length = 0;
    const vars = Buffer.from(JSON.stringify({ name: 'דנה' }), 'utf8').toString('base64url');

    await fetch(hostPath(`?vars=${vars}`));

    expect(asked[0]).toMatchObject({ size: '9x16', background: 'frame', values: { name: 'דנה' } });
  });

  it.each(['?size=4x3', '?bg=white', '?vars=aGVsbG8'])('answers 400 for %s', async (query) => {
    expect((await fetch(hostPath(query))).status).toBe(400);
  });

  it('serves the sample frames and GSAP from the engine’s assets', async () => {
    const frame = await fetch(`${base}/assets/sample-9x16.svg`);
    const gsap = await fetch(`${base}/${GRAPHIC_SAMPLE_ID}/v/1/vendor/gsap.min.js`);

    expect(frame.headers.get('content-type')).toBe('image/svg+xml');
    expect(await frame.text()).toBe('<svg/>');
    expect(await gsap.text()).toBe('gsap');
  });

  it('serves the canned graphic’s own files', async () => {
    const res = await fetch(
      `${base}/${GRAPHIC_SAMPLE_ID}/v/2/compositions/lib-${GRAPHIC_SAMPLE_ID}.html`,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<template>x</template>');
  });

  it('answers 404 for another graphic, a bad version and a missing file', async () => {
    expect((await fetch(`${base}/0123456789ab/v/1/host.html`)).status).toBe(404);
    expect((await fetch(`${base}/${GRAPHIC_SAMPLE_ID}/v/0/host.html`)).status).toBe(404);
    expect((await fetch(`${base}/${GRAPHIC_SAMPLE_ID}/v/1/nope.html`)).status).toBe(404);
    expect((await fetch(`${base}/assets/nope.svg`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it('answers only GET and HEAD', async () => {
    const post = await fetch(hostPath(), { method: 'POST' });
    const head = await fetch(hostPath(), { method: 'HEAD' });

    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
