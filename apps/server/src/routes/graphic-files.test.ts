import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiErrorSchema, encodeGraphicVars, GRAPHIC_MESSAGES } from '@studio/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { GraphicRepository, type StudioDb } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { GRAPHICS_ASSETS_DIR, GSAP_ASSET_PATH } from '../graphics/graphic-assets.js';
import { createDisabledGraphicService } from '../graphics/graphic-service.js';
import type { VoiceTranscriber } from '../pipeline/voice-transcriber.js';
import { TIMELINE_REGISTRY_SCRIPT } from './composition-files.js';
import {
  createGraphicFilesRoutes,
  GRAPHIC_FILE_MISSING_MESSAGE,
  HOST_ADDRESS_MESSAGE,
  SAMPLE_FRAME_MISSING_MESSAGE,
} from './graphic-files.js';

// The real repository on an in-memory database, the real routes and a real inbox in a temp folder;
// `app.request` for the HTTP. The graphic is the tiny lower third in graphics/testdata/host-sample/.

const ID = '5a3e1c0de001';
const NAME = 'Name on a white pill';
const COMPOSITION = fileURLToPath(
  new URL(`../graphics/testdata/host-sample/compositions/lib-${ID}.html`, import.meta.url),
);
const FONT_BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

let inboxPath: string;
let outside: string;
let app: Hono;
let db: StudioDb;
let repo: GraphicRepository;

/** `<inbox>/_Graphics/<NAME>/<rel>`. */
function graphicPath(...rel: string[]): string {
  return join(inboxPath, '_Graphics', NAME, ...rel);
}

function put(rel: string, content: string | Buffer): void {
  const path = graphicPath(rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function aboutJson(lengthSec: number): string {
  return JSON.stringify({
    kind: 'lower-third',
    lengthSec,
    variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
    when: 'The first time a person is named on camera.',
    reply: 'Made it.',
  });
}

/** A whole version folder, as the worker leaves it. */
function writeVersion(version: number, lengthSec: number | null): void {
  const base = `versions/v${version}`;
  mkdirSync(graphicPath(base, 'compositions'), { recursive: true });
  mkdirSync(graphicPath(base, 'vendor'), { recursive: true });
  copyFileSync(COMPOSITION, graphicPath(base, 'compositions', `lib-${ID}.html`));
  copyFileSync(GSAP_ASSET_PATH, graphicPath(base, 'vendor', 'gsap.min.js'));
  put(`${base}/lib/${ID}/fonts/Heebo.woff2`, FONT_BYTES);
  put(`${base}/index.html`, '<!doctype html><html><head><title>host</title></head></html>');
  if (lengthSec !== null) put(`${base}/about.json`, aboutJson(lengthSec));
}

beforeAll(() => {
  inboxPath = mkdtempSync(join(tmpdir(), 'graphic-files-'));
  outside = mkdtempSync(join(tmpdir(), 'graphic-files-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');

  // v1 plays 3 s; v2 was lengthened to 5 s. v3 is on the row but its folder was never made.
  writeVersion(1, 3);
  writeVersion(2, 5);
  // v4 has no about.json: the row's length is used.
  writeVersion(4, null);
  symlinkSync(outside, graphicPath('versions', 'v1', 'escape'));
  symlinkSync(outside, graphicPath('versions', 'v5'));

  db = memoryDb();
  repo = new GraphicRepository(db);
  repo.create({ id: ID, name: NAME });
  repo.setVersion(ID, { version: 4, kind: 'lower-third', lengthSec: 2.5 });

  app = new Hono();
  app.route(
    '/api/graphics',
    createGraphicFilesRoutes({ graphics: repo, inboxPath, assetsDir: GRAPHICS_ASSETS_DIR }),
  );
});

afterAll(() => {
  db.close();
  rmSync(inboxPath, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

async function files(path: string, init?: RequestInit): Promise<Response> {
  return await app.request(`/api/graphics/${path}`, init);
}

describe('GET /assets/:file', () => {
  it.each(['9x16', '16x9', '1x1'])('sends the %s sample frame as an SVG', async (size) => {
    const res = await files(`assets/sample-${size}.svg`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const svg = await res.text();
    expect(svg).toBe(readFileSync(join(GRAPHICS_ASSETS_DIR, `sample-${size}.svg`), 'utf8'));
    expect(svg).toContain('<svg');
  });

  it('draws the frame like the board’s footage: a person, a window and one yellow word', async () => {
    const svg = await (await files('assets/sample-9x16.svg')).text();
    expect(svg).toContain('viewBox="0 0 1080 1920"');
    expect(svg).toContain('זה ');
    expect(svg).toContain('שעשינו');
    expect(svg).toMatch(/<tspan fill="#FACC15">מה<\/tspan>/);
    expect(svg).toContain('<circle'); // the head
    expect(await (await files('assets/sample-16x9.svg')).text()).toContain(
      'viewBox="0 0 1920 1080"',
    );
    expect(await (await files('assets/sample-1x1.svg')).text()).toContain(
      'viewBox="0 0 1080 1080"',
    );
  });

  it('answers 304 to the ETag it sent', async () => {
    const etag = (await files('assets/sample-1x1.svg', { method: 'HEAD' })).headers.get(
      'etag',
    ) as string;

    const res = await files('assets/sample-1x1.svg', { headers: { 'If-None-Match': etag } });

    expect(res.status).toBe(304);
  });

  it('sends the headers only for HEAD', async () => {
    const res = await files('assets/sample-1x1.svg', { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toBe('');
  });

  it.each([
    'assets/nope.svg',
    'assets/vendor',
    'assets/gsap.min.js',
    'assets/sample-1x1.svg.js',
    'assets/sample-1x1.png',
    'assets/..%2f..%2fpackage.json',
    'assets/%2e%2e',
    'assets/vendor%2fgsap.min.js',
  ])('refuses %s', async (path) => {
    const res = await files(path);

    expect(res.status).toBe(404);
  });

  it('says the sample frame is missing', async () => {
    expect(await expectError(await files('assets/nope.svg'), 404)).toBe(
      SAMPLE_FRAME_MISSING_MESSAGE,
    );
  });
});

describe('GET /:id/v/:n/host.html', () => {
  function hostUrl(version: number, query = ''): string {
    return `${ID}/v/${version}/host.html${query}`;
  }

  it('sends the host page as HTML, revalidated, with an ETag', async () => {
    const res = await files(hostUrl(1));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{27}"$/);
    const html = await res.text();
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(html));
    expect(html).toContain(`data-composition-src="compositions/lib-${ID}.html"`);
    expect(html).toContain(TIMELINE_REGISTRY_SCRIPT);
  });

  it('defaults to 9:16 over the sample frame with the graphic’s own text', async () => {
    const html = await (await files(hostUrl(1))).text();

    expect(html).toContain('data-width="1080"');
    expect(html).toContain('data-height="1920"');
    expect(html).toContain('url("/api/graphics/assets/sample-9x16.svg")');
    expect(html).toContain('data-variable-values="{}"');
  });

  it.each([
    ['9x16', 1080, 1920],
    ['16x9', 1920, 1080],
    ['1x1', 1080, 1080],
  ])('sizes the host for ?size=%s', async (size, width, height) => {
    const html = await (await files(hostUrl(1, `?size=${size}`))).text();

    expect(html).toContain(`data-width="${width}" data-height="${height}"`);
    expect(html).toContain(`url("/api/graphics/assets/sample-${size}.svg")`);
  });

  it('paints what ?bg says is behind', async () => {
    const checker = await (await files(hostUrl(1, '?bg=checker'))).text();
    const black = await (await files(hostUrl(1, '?bg=black'))).text();

    expect(checker).toContain('repeating-conic-gradient');
    expect(checker).not.toContain('.svg');
    expect(black).toContain('background: #000;');
  });

  it('fills the text fields from ?vars, Hebrew included', async () => {
    const vars = encodeGraphicVars({ name: 'נועה "כהן"', role: 'Founder & CEO' });

    const html = await (await files(hostUrl(1, `?vars=${vars}`))).text();

    expect(html).toContain(
      'data-variable-values="{&quot;name&quot;:&quot;נועה \\&quot;כהן\\&quot;&quot;,&quot;role&quot;:&quot;Founder &amp; CEO&quot;}"',
    );
  });

  it('plays a version for the length its own about.json says', async () => {
    expect(await (await files(hostUrl(1))).text()).toContain('data-duration="3.8"');
    expect(await (await files(hostUrl(2))).text()).toContain('data-duration="5.8"');
  });

  it('falls back to the graphic’s length when the version has no about.json', async () => {
    expect(await (await files(hostUrl(4))).text()).toContain('data-duration="3.3"');
  });

  it('answers 304 to the ETag it sent, and a different ETag for a different address', async () => {
    const first = await files(hostUrl(1, '?size=16x9'));
    const etag = first.headers.get('etag') as string;

    const again = await files(hostUrl(1, '?size=16x9'), { headers: { 'If-None-Match': etag } });
    const other = await files(hostUrl(1, '?size=1x1'));

    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it('sends the headers only for HEAD', async () => {
    const res = await files(hostUrl(1), { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  it.each([
    ['an unknown size', '?size=4x3'],
    ['an unknown background', '?bg=white'],
    ['vars that are not base64url', '?vars=%7B%7D'],
    ['vars that are not an object of strings', `?vars=${encodeGraphicVars(JSON.parse('{"a":1}'))}`],
    ['vars that are not JSON', '?vars=aGVsbG8'],
  ])('answers 400 for %s', async (_label, query) => {
    expect(await expectError(await files(hostUrl(1, query)), 400)).toBe(HOST_ADDRESS_MESSAGE);
  });

  it('answers 404 for a graphic it does not know, or an id that is not one', async () => {
    const unknown = await files('0123456789ab/v/1/host.html');
    const odd = await files('not-an-id/v/1/host.html');

    expect(await expectError(unknown, 404)).toBe(GRAPHIC_MESSAGES.notFound);
    expect(await expectError(odd, 404)).toBe(GRAPHIC_MESSAGES.notFound);
  });

  it.each([
    ['one the row has but no folder for', 3],
    ['one that is not a version', 0],
    ['one beyond the last', 9],
    ['a version folder that is a link out', 5],
  ])('answers 404 for %s', async (_label, version) => {
    expect(await expectError(await files(hostUrl(version)), 404)).toBe(
      GRAPHIC_MESSAGES.versionNotFound,
    );
  });

  it.each(['abc', '01', '-1', '1.5', '1e1', '1%2F2'])(
    'answers 404 for the version %s',
    async (n) => {
      expect(await expectError(await files(`${ID}/v/${n}/host.html`), 404)).toBe(
        GRAPHIC_MESSAGES.versionNotFound,
      );
    },
  );

  it('does not answer for a graphic that was deleted', async () => {
    const gone = repo.create({ id: '0123456789ab', name: 'Gone' });
    mkdirSync(join(inboxPath, '_Graphics', 'Gone', 'versions', 'v1'), { recursive: true });
    expect((await files(`${gone.id}/v/1/host.html`)).status).toBe(404);
    repo.softDelete(gone.id);

    expect(await expectError(await files(`${gone.id}/v/1/host.html`), 404)).toBe(
      GRAPHIC_MESSAGES.notFound,
    );
  });
});

describe('GET /:id/v/:n/<path>', () => {
  const composition = readFileSync(COMPOSITION);

  it('sends the graphic’s composition, revalidated, as HTML', async () => {
    const res = await files(`${ID}/v/1/compositions/lib-${ID}.html`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(composition);
  });

  it('sends GSAP and the files the graphic loads, with the right types', async () => {
    const gsap = await files(`${ID}/v/1/vendor/gsap.min.js`);
    const font = await files(`${ID}/v/1/lib/${ID}/fonts/Heebo.woff2`);

    expect(gsap.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(Buffer.from(await gsap.arrayBuffer())).toEqual(readFileSync(GSAP_ASSET_PATH));
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(Buffer.from(await font.arrayBuffer())).toEqual(FONT_BYTES);
  });

  it('answers a byte range with 206, so video and fonts can seek', async () => {
    const res = await files(`${ID}/v/1/lib/${ID}/fonts/Heebo.woff2`, {
      headers: { Range: 'bytes=10-19' },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FONT_BYTES.subarray(10, 20));
  });

  it('answers 304 for a file the client has', async () => {
    const path = `${ID}/v/1/vendor/gsap.min.js`;
    const etag = (await files(path, { method: 'HEAD' })).headers.get('etag') as string;

    const res = await files(path, { headers: { 'If-None-Match': etag } });

    expect(res.status).toBe(304);
  });

  it('sends the version’s own index.html with the timeline registry first in its head', async () => {
    const res = await files(`${ID}/v/1/index.html`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<head>${TIMELINE_REGISTRY_SCRIPT}<title>host</title>`);
  });

  it('serves each version from its own folder', async () => {
    const one = await (await files(`${ID}/v/1/about.json`)).json();
    const two = await (await files(`${ID}/v/2/about.json`)).json();

    expect(one).toMatchObject({ lengthSec: 3 });
    expect(two).toMatchObject({ lengthSec: 5 });
  });

  it('sends the headers only for HEAD', async () => {
    const res = await files(`${ID}/v/1/vendor/gsap.min.js`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('answers 404 with its own sentence for a file the version does not have', async () => {
    expect(await expectError(await files(`${ID}/v/1/nope.png`), 404)).toBe(
      GRAPHIC_FILE_MISSING_MESSAGE,
    );
    expect(await expectError(await files(`${ID}/v/1/lib`), 404)).toBe(GRAPHIC_FILE_MISSING_MESSAGE);
  });

  it('answers 404 for an unknown graphic or version', async () => {
    expect(await expectError(await files('0123456789ab/v/1/about.json'), 404)).toBe(
      GRAPHIC_MESSAGES.notFound,
    );
    expect(await expectError(await files(`${ID}/v/9/about.json`), 404)).toBe(
      GRAPHIC_MESSAGES.versionNotFound,
    );
  });

  it.each([
    '../v2/about.json',
    '%2e%2e/v2/about.json',
    '..%2fv2%2fabout.json',
    '..%2f..%2f..%2fGone%2fversions',
    'escape/secret.txt',
    '%2Fetc%2Fhosts',
  ])('refuses %s: nothing outside the version is readable', async (path) => {
    const res = await files(`${ID}/v/1/${path}`);

    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain('"lengthSec":5');
  });
});

describe('mounted in the app', () => {
  const transcriber: VoiceTranscriber = {
    kind: 'fake',
    enqueue: async () => ({ text: 'x' }),
    stop: async () => {},
  };

  function appWith(graphics: boolean): Hono {
    return createApp({
      graphics,
      graphicsRoutes: {
        graphics: { service: createDisabledGraphicService() },
        files: { graphics: repo, inboxPath, assetsDir: GRAPHICS_ASSETS_DIR },
        voice: { transcriber, dataDir: inboxPath },
      },
    });
  }

  it('answers under /api/graphics while the switch is on, next to the graphics routes', async () => {
    const on = appWith(true);

    const host = await on.request(`/api/graphics/${ID}/v/1/host.html?size=1x1`);
    const frame = await on.request('/api/graphics/assets/sample-1x1.svg');
    const file = await on.request(`/api/graphics/${ID}/v/1/vendor/gsap.min.js`);

    expect(host.status).toBe(200);
    expect(await host.text()).toContain(`data-composition-src="compositions/lib-${ID}.html"`);
    expect(frame.headers.get('content-type')).toBe('image/svg+xml');
    expect(await frame.text()).toContain('<svg');
    expect(file.status).toBe(200);
    await file.arrayBuffer();
  });

  it('says "Graphics are off." for all of it while the switch is off', async () => {
    const off = appWith(false);

    for (const path of [
      `${ID}/v/1/host.html`,
      'assets/sample-1x1.svg',
      `${ID}/v/1/vendor/gsap.min.js`,
    ]) {
      const res = await off.request(`/api/graphics/${path}`);
      expect(await expectError(res, 404), path).toBe(GRAPHIC_MESSAGES.off);
    }
  });
});
