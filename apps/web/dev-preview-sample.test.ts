import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTENT_TYPES,
  decideRange,
  PREVIEW_SAMPLE_BASE,
  previewSamplePlugin,
  resolveSampleFile,
} from './dev-preview-sample.ts';

const ROOT = resolve('/sample-root');

describe('resolveSampleFile', () => {
  it('serves index.html for the mount itself', () => {
    expect(resolveSampleFile(ROOT, '')).toBe(join(ROOT, 'index.html'));
    expect(resolveSampleFile(ROOT, '/')).toBe(join(ROOT, 'index.html'));
    expect(resolveSampleFile(ROOT, '/?r=2')).toBe(join(ROOT, 'index.html'));
  });

  it('drops the query and the hash', () => {
    expect(resolveSampleFile(ROOT, '/cut.mp4?x=1')).toBe(join(ROOT, 'cut.mp4'));
    expect(resolveSampleFile(ROOT, '/cut.mp4#t=2')).toBe(join(ROOT, 'cut.mp4'));
    expect(resolveSampleFile(ROOT, '/cut.mp4?x=1#top')).toBe(join(ROOT, 'cut.mp4'));
  });

  it('finds files in folders, and decodes percent escapes', () => {
    expect(resolveSampleFile(ROOT, '/compositions/badge.html')).toBe(
      join(ROOT, 'compositions', 'badge.html'),
    );
    expect(resolveSampleFile(ROOT, '/assets/fonts/a%20b.woff2')).toBe(
      join(ROOT, 'assets', 'fonts', 'a b.woff2'),
    );
  });

  it('keeps a path that wanders but ends up inside', () => {
    expect(resolveSampleFile(ROOT, '/a/../index.html')).toBe(join(ROOT, 'index.html'));
  });

  it('refuses a path that leaves the folder, however it is written', () => {
    expect(resolveSampleFile(ROOT, '/../package.json')).toBeNull();
    expect(resolveSampleFile(ROOT, '/%2e%2e/x.html')).toBeNull();
    expect(resolveSampleFile(ROOT, '/..%2Fx.html')).toBeNull();
    expect(resolveSampleFile(ROOT, '//etc/passwd.txt')).toBeNull();
  });

  it('refuses a malformed escape, a NUL byte and an unknown extension', () => {
    expect(resolveSampleFile(ROOT, '/%E0%A4%A.html')).toBeNull();
    expect(resolveSampleFile(ROOT, '/index.html%00.png')).toBeNull();
    expect(resolveSampleFile(ROOT, '/notes.txt')).toBeNull();
    expect(resolveSampleFile(ROOT, '/noextension')).toBeNull();
  });

  it('knows a content type for every extension it serves', () => {
    for (const [extension, type] of Object.entries(CONTENT_TYPES)) {
      expect(resolveSampleFile(ROOT, `/file.${extension}`), extension).toBe(
        join(ROOT, `file.${extension}`),
      );
      expect(type).toMatch(/^[a-z]+\/[a-z0-9.+-]+/);
    }
    expect(CONTENT_TYPES.html).toBe('text/html; charset=utf-8');
    expect(CONTENT_TYPES.mp4).toBe('video/mp4');
    expect(CONTENT_TYPES.woff2).toBe('font/woff2');
  });
});

// The same cases as decideRange in apps/server/src/routes/download.test.ts: this is a copy of it.
describe('decideRange', () => {
  const size = 1000;
  const partial = (start: number, end: number) => ({ kind: 'partial', range: { start, end } });

  it('sends the whole file when there is no Range header', () => {
    expect(decideRange(undefined, size)).toEqual({ kind: 'full' });
    expect(decideRange(null, size)).toEqual({ kind: 'full' });
  });

  it('reads first-last, first- and -suffix', () => {
    expect(decideRange('bytes=0-99', size)).toEqual(partial(0, 99));
    expect(decideRange('bytes=500-', size)).toEqual(partial(500, 999));
    expect(decideRange('bytes=-100', size)).toEqual(partial(900, 999));
    expect(decideRange('bytes=999-999', size)).toEqual(partial(999, 999));
  });

  it('cuts a last byte past the end back to the end of the file', () => {
    expect(decideRange('bytes=990-5000', size)).toEqual(partial(990, 999));
    expect(decideRange('bytes=0-99999999999999999999', size)).toEqual(partial(0, 999));
  });

  it('gives the whole file for a suffix longer than the file', () => {
    expect(decideRange('bytes=-5000', size)).toEqual(partial(0, 999));
  });

  it('tolerates case and spaces', () => {
    expect(decideRange('  Bytes = 10-19 ', size)).toEqual(partial(10, 19));
  });

  it('is unsatisfiable when it starts at or past the end', () => {
    expect(decideRange('bytes=1000-', size)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=2000-3000', size)).toEqual({ kind: 'unsatisfiable' });
  });

  it('is unsatisfiable when it is backwards, empty or not a range', () => {
    for (const header of [
      'bytes=5-2',
      'bytes=-0',
      'bytes=-',
      'bytes=',
      'bytes=abc',
      'bytes=1-2-3',
    ]) {
      expect(decideRange(header, size), header).toEqual({ kind: 'unsatisfiable' });
    }
  });

  it('is unsatisfiable for any range of an empty file', () => {
    expect(decideRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a unit it does not know and several ranges at once', () => {
    expect(decideRange('items=0-5', size)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=0-5,10-15', size)).toEqual({ kind: 'full' });
  });
});

describe('previewSamplePlugin', () => {
  it('is dev only, and touches no file when it is created', () => {
    const plugin = previewSamplePlugin('/x');
    expect(plugin.apply).toBe('serve');
    expect(plugin.name).toBe('studio-preview-sample');
  });
});

// A real Vite dev server (middleware mode, SPA fallback on, as in `pnpm dev`) with the plugin, over
// a temp sample folder: what matters is how the mount behaves next to Vite's own middlewares.
describe('the /__dev/preview-sample/ route in a Vite dev server', () => {
  let base: string;
  let sampleDir: string;
  let appDir: string;
  let port: number;
  let front: http.Server;
  let closeVite: () => Promise<void>;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'studio-preview-sample-'));
    sampleDir = join(base, 'sample');
    appDir = join(base, 'app');
    mkdirSync(sampleDir);
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><html><body>APP</body></html>');
    // Exactly 1000 bytes.
    writeFileSync(join(sampleDir, 'index.html'), `<p>SAMPLE</p>${'x'.repeat(1000 - 13)}`);
    writeFileSync(join(sampleDir, 'clip.mp4'), Buffer.alloc(2000, 7));

    const vite = await createViteServer({
      configFile: false,
      root: appDir,
      logLevel: 'silent',
      appType: 'spa',
      optimizeDeps: { noDiscovery: true },
      plugins: [previewSamplePlugin(sampleDir)],
      server: { middlewareMode: true, ws: false, watch: null },
    });
    front = http.createServer(vite.middlewares);
    await new Promise<void>((done) => front.listen(0, '127.0.0.1', done));
    port = (front.address() as AddressInfo).port;
    closeVite = async () => {
      front.closeAllConnections();
      await new Promise<void>((done) => front.close(() => done()));
      await vite.close();
    };
  });

  afterAll(async () => {
    await closeVite();
    rmSync(base, { recursive: true, force: true });
  });

  interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }

  function request(
    path: string,
    { method = 'GET', headers = {} }: { method?: string; headers?: http.OutgoingHttpHeaders } = {},
  ): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolveReply({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const mount = (path: string) => `${PREVIEW_SAMPLE_BASE}${path}`;

  it('serves index.html with its type, no-cache and byte-range support', async () => {
    const reply = await request(mount('/index.html'));
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-cache');
    expect(reply.headers['accept-ranges']).toBe('bytes');
    expect(reply.headers['content-length']).toBe('1000');
    expect(reply.body.toString()).toContain('SAMPLE');
  });

  it('serves the mount itself as index.html', async () => {
    const reply = await request(`${mount('/')}?r=1`);
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain('SAMPLE');
  });

  it('answers a byte range with 206 and Content-Range', async () => {
    const reply = await request(mount('/index.html'), { headers: { Range: 'bytes=0-9' } });
    expect(reply.status).toBe(206);
    expect(reply.headers['content-range']).toBe('bytes 0-9/1000');
    expect(reply.headers['content-length']).toBe('10');
    expect(reply.body).toHaveLength(10);

    const tail = await request(mount('/clip.mp4'), { headers: { Range: 'bytes=1990-' } });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-type']).toBe('video/mp4');
    expect(tail.headers['content-range']).toBe('bytes 1990-1999/2000');
    expect(tail.body).toHaveLength(10);
  });

  it('answers a range past the end with 416', async () => {
    const reply = await request(mount('/index.html'), { headers: { Range: 'bytes=2000-' } });
    expect(reply.status).toBe(416);
    expect(reply.headers['content-range']).toBe('bytes */1000');
    expect(reply.body).toHaveLength(0);
  });

  it('answers a missing file with 404, never with the app (no SPA fallback under the mount)', async () => {
    for (const path of ['/missing.html', '/gone.mp4', '/notes.txt', '/../x.html']) {
      const reply = await request(mount(path));
      expect(reply.status, path).toBe(404);
      expect(reply.headers['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(reply.body.toString(), path).toBe('Not found');
      expect(reply.body.toString(), path).not.toContain('APP');
    }
  });

  it('still lets the app have everything outside the mount', async () => {
    const reply = await request('/some/page');
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain('APP');
  });

  it('sends the headers only for HEAD', async () => {
    const reply = await request(mount('/index.html'), { method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-length']).toBe('1000');
    expect(reply.body).toHaveLength(0);

    const missing = await request(mount('/missing.html'), { method: 'HEAD' });
    expect(missing.status).toBe(404);
    expect(missing.body).toHaveLength(0);
  });

  it('refuses anything but GET and HEAD with 405', async () => {
    const reply = await request(mount('/index.html'), { method: 'POST' });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET, HEAD');
  });
});
