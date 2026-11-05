import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthResponseSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const INDEX_HTML = '<!doctype html><title>Studio Engine</title><div id="root"></div>';
const ASSET_JS = 'console.log("studio");';
const MANIFEST = '{"name":"Studio Engine","display":"standalone"}';
// The first bytes of a PNG, which is all the server needs to tell it from index.html.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

let webDist: string;
let app: Hono;

beforeAll(() => {
  webDist = mkdtempSync(join(tmpdir(), 'studio-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), INDEX_HTML);
  writeFileSync(join(webDist, 'assets', 'x-abc123.js'), ASSET_JS);
  writeFileSync(join(webDist, 'manifest.webmanifest'), MANIFEST);
  for (const icon of ['apple-touch-icon.png', 'icon-192.png', 'icon-maskable-512.png']) {
    writeFileSync(join(webDist, icon), PNG);
  }
  app = createApp({ webDist });
});

afterAll(() => {
  rmSync(webDist, { recursive: true, force: true });
});

describe('production web app', () => {
  it('still serves /api/health', async () => {
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json())).toMatchObject({ ok: true });
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('falls back to index.html for a deep link with no-cache', async () => {
    const res = await app.request('/jobs/123');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('serves hashed assets with a long immutable cache', async () => {
    const res = await app.request('/assets/x-abc123.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(ASSET_JS);
  });

  it('serves the web app manifest as application/manifest+json, revalidated on each load', async () => {
    const res = await app.request('/manifest.webmanifest');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(MANIFEST);
  });

  it.each(['/apple-touch-icon.png', '/icon-192.png', '/icon-maskable-512.png'])(
    'serves %s as the image itself, with a long cache, not the SPA shell',
    async (path) => {
      const res = await app.request(path);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=2592000');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    },
  );

  it('returns 404, not index.html, for a missing /assets file', async () => {
    const res = await app.request('/assets/x-old999.js');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
    expect(await res.text()).not.toContain('Studio Engine');
  });

  it.each(['/assets/missing', '/missing.js', '/missing.png', '/sw-old.js', '/jobs/123.map'])(
    'returns 404 for %s, which is not a client-side route',
    async (path) => {
      const res = await app.request(path);

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    },
  );

  it.each(['/jobs', '/clients/abc123def456', '/graphics/new'])(
    'still falls back to index.html for the extension-less route %s',
    async (path) => {
      const res = await app.request(path);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    },
  );

  it('keeps unknown /api paths as a JSON 404, never the SPA shell', async () => {
    const res = await app.request('/api/nope');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('does not fall back to index.html for non-GET requests', async () => {
    const res = await app.request('/jobs/123', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('when the web app is not built', () => {
  it('keeps /api working and does not serve the SPA', async () => {
    const api = createApp({ webDist: join(webDist, 'missing') });

    const health = await api.request('/api/health');
    expect(health.status).toBe(200);

    const root = await api.request('/');
    expect(root.status).toBe(404);
  });
});
