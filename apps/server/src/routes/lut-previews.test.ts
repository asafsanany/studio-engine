import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LUT_MESSAGES, type LutKind } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { LutRepository, type StoredLut } from '../db/lut-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createFakeLutPreviews } from '../luts/fake-lut-previews.js';
import { createBuiltInLuts } from '../luts/lut-builtin.js';
import { lutFramePath } from '../luts/lut-frames.js';
import {
  createRealLutPreviews,
  fileSha256,
  type LutPreviews,
  lutPreviewVersion,
} from '../luts/lut-previews.js';
import { createDisabledLutService } from '../luts/lut-service.js';
import { cubeText, hasCommand, invert, jpegSize, writeFakeSkill } from '../luts/lut-test-utils.js';
import { makeTempDir } from '../test-temp.js';

const opened: ReturnType<typeof memoryDb>[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const IMMUTABLE = 'public, max-age=31536000, immutable';

function setup(options: { skill?: boolean; previews?: (dataDir: string) => LutPreviews } = {}) {
  const root = makeTempDir('studio-lut-route-');
  const inbox = join(root, 'inbox');
  const dataDir = join(root, 'data');
  mkdirSync(join(inbox, '_LUTs'), { recursive: true });
  const db = memoryDb();
  opened.push(db);
  const repo = new LutRepository(db);
  const skillDir =
    options.skill === false ? join(root, 'no-skill') : writeFakeSkill(join(root, 'skill'));
  const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });
  const previews = options.previews?.(dataDir) ?? createFakeLutPreviews({ dataDir });
  const app = createApp({
    luts: true,
    lutsRoutes: {
      luts: { service: createDisabledLutService() },
      previews: { luts: repo, builtIn, previews, inboxPath: inbox },
    },
  });

  /** Imports a LUT of Yours: its file in _LUTs and its row. */
  function addLut(name: string, kind: LutKind = 'look'): StoredLut {
    const file = `${name}.cube`;
    writeFileSync(join(inbox, '_LUTs', file), cubeText(9, invert));
    return repo.create({
      name,
      kind,
      size: 9,
      file,
      bytes: 100,
      sha256: `${name.length.toString(16).padStart(2, '0')}${'c0ffee'.repeat(10)}`,
      sourceName: file,
    });
  }
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers });
  return { app, repo, inbox, dataDir, skillDir, addLut, get };
}

describe('GET /api/luts/:slug/preview/:frame/:which.jpg', () => {
  it('answers a LUT of Yours: before is the frame, after is made through the LUT (the fake copies it)', async () => {
    const { addLut, get } = setup();
    addLut('Golden Hour Warm');

    const before = await get('/api/luts/golden-hour-warm/preview/person/before.jpg');
    const after = await get('/api/luts/golden-hour-warm/preview/street/after.jpg');

    expect(before.status).toBe(200);
    expect(before.headers.get('content-type')).toBe('image/jpeg');
    expect(
      Buffer.from(await before.arrayBuffer()).equals(readFileSync(lutFramePath('person'))),
    ).toBe(true);
    expect(after.status).toBe(200);
    expect(
      Buffer.from(await after.arrayBuffer()).equals(readFileSync(lutFramePath('street'))),
    ).toBe(true);
  });

  it('answers a built-in LUT from the skill, Cinematic included', async () => {
    const { get } = setup();

    for (const slug of [
      'film-contrast',
      'red-skin-fix',
      ...(hasCommand('python3', '--version') ? ['cinematic'] : []),
    ]) {
      const res = await get(`/api/luts/${slug}/preview/interior/after.jpg`);
      expect(res.status, slug).toBe(200);
      expect(res.headers.get('content-type'), slug).toBe('image/jpeg');
    }
  });

  it('shows a Camera LUT’s -log twin before and the plain frame after, with no ffmpeg run', async () => {
    const { addLut, get } = setup({
      previews: (dataDir) => createRealLutPreviews({ dataDir, ffmpegBin: '/no/such/ffmpeg' }),
    });
    addLut('Sony SLog3 to 709', 'camera');

    const before = await get('/api/luts/sony-slog3-to-709/preview/person/before.jpg');
    const after = await get('/api/luts/sony-slog3-to-709/preview/person/after.jpg');
    const builtIn = await get('/api/luts/s-gamut3-to-cine/preview/street/before.jpg');

    expect(
      Buffer.from(await before.arrayBuffer()).equals(readFileSync(lutFramePath('person', true))),
    ).toBe(true);
    expect(
      Buffer.from(await after.arrayBuffer()).equals(readFileSync(lutFramePath('person'))),
    ).toBe(true);
    expect(
      Buffer.from(await builtIn.arrayBuffer()).equals(readFileSync(lutFramePath('street', true))),
    ).toBe(true);
  });

  it('is 404 for a LUT that does not exist, with the sentence of the plan', async () => {
    const { get } = setup();

    const res = await get('/api/luts/no-such-lut/preview/person/before.jpg');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.notFound });
  });

  it('is 404 for a frame or a side that does not exist, and for an address without .jpg', async () => {
    const { addLut, get } = setup();
    addLut('Moody');
    for (const path of [
      '/api/luts/moody/preview/garden/after.jpg',
      '/api/luts/moody/preview/person/during.jpg',
      '/api/luts/moody/preview/person/after',
      '/api/luts/moody/preview/person/after.png',
      '/api/luts/moody/preview/Person/after.jpg',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: LUT_MESSAGES.previewNotFound });
    }
  });

  it('is 404 for a built-in LUT while the colour-grade skill is not installed', async () => {
    const { get } = setup({ skill: false });

    const res = await get('/api/luts/film-contrast/preview/person/after.jpg');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.notFound });
  });

  it('is 404 when the file of a LUT of Yours is not in _LUTs any more (but its before still shows)', async () => {
    const { addLut, get, inbox } = setup();
    const lut = addLut('Gone');
    rmSync(join(inbox, '_LUTs', lut.file));

    const after = await get('/api/luts/gone/preview/person/after.jpg');
    const before = await get('/api/luts/gone/preview/person/before.jpg');

    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ error: LUT_MESSAGES.fileMissing });
    expect(before.status).toBe(200);
  });

  it('answers a plain sentence, never the reason, when the still cannot be made', async () => {
    const failing: LutPreviews = {
      still: async () => {
        throw new Error('ffmpeg exploded at /Users/owner/secret');
      },
      warm: () => {},
    };
    const { addLut, get } = setup({ previews: () => failing });
    addLut('Broken');

    const res = await get('/api/luts/broken/preview/person/after.jpg');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.previewFailed });
  });
});

describe('the cache headers', () => {
  it('are public, a year, immutable only when the address carries the file’s hash (?v=previewKey)', async () => {
    const { addLut, get } = setup();
    const lut = addLut('Golden Hour Warm');
    const version = lutPreviewVersion(lut.sha256, lut.kind) as string;
    const base = '/api/luts/golden-hour-warm/preview/person/after.jpg';

    const withHash = await get(`${base}?v=${version}`);
    const without = await get(base);
    const stale = await get(`${base}?v=00000000`);

    expect(withHash.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(without.headers.get('cache-control')).toBe('no-cache');
    expect(stale.headers.get('cache-control')).toBe('no-cache');
    // The before of a Look is the same frame for every LUT, but its address is still the LUT's.
    const before = await get(`/api/luts/golden-hour-warm/preview/person/before.jpg?v=${version}`);
    expect(before.headers.get('cache-control')).toBe(IMMUTABLE);
  });

  it('use the previewKey the repository puts on the summary', async () => {
    const { addLut, repo, get } = setup();
    const lut = addLut('Golden Hour Warm');
    const { toLutSummary } = await import('../db/lut-repository.js');
    const key = toLutSummary(repo.getById(lut.id) as StoredLut, 0).previewKey;

    expect(key).toMatch(/^[0-9a-f]{8}$/);
    const res = await get(`/api/luts/golden-hour-warm/preview/person/after.jpg?v=${key}`);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
  });

  it('change with the kind: marking a LUT Camera makes the old address stale', async () => {
    const { addLut, repo, get } = setup();
    const lut = addLut('Golden Hour Warm');
    const oldKey = lutPreviewVersion(lut.sha256, 'look');
    repo.setKind(lut.id, 'camera');

    const res = await get(`/api/luts/golden-hour-warm/preview/person/before.jpg?v=${oldKey}`);

    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('give built-in LUTs the hash of the skill’s file (and Cinematic the hash of its baked chain)', async () => {
    const { get, skillDir } = setup();
    const sha = await fileSha256(join(skillDir, 'correction_luts', 'film_contrast.cube'));
    const version = lutPreviewVersion(sha, 'look');

    const res = await get(`/api/luts/film-contrast/preview/person/after.jpg?v=${version}`);

    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
  });

  it('send an ETag and answer 304 to a browser that has the still, without making it again', async () => {
    const make = vi.fn(async () => lutFramePath('person'));
    const { addLut, get } = setup({ previews: () => ({ still: make, warm: () => {} }) });
    addLut('Golden Hour Warm');
    const path = '/api/luts/golden-hour-warm/preview/person/after.jpg';

    const first = await get(path);
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^"[0-9a-f]{8}-person-after"$/);
    expect(make).toHaveBeenCalledTimes(1);
    const again = await get(path, { 'If-None-Match': etag });

    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('cache-control')).toBe('no-cache');
    expect(make).toHaveBeenCalledTimes(1);
    // Another frame is another tag.
    const other = await get(path.replace('person', 'street'), { 'If-None-Match': etag });
    expect(other.status).toBe(200);
  });
});

describe.skipIf(!hasCommand('ffmpeg'))('with the real ffmpeg', () => {
  it('serves a graded 396×704 JPEG for a LUT of Yours and for the built-in rows', async () => {
    const { addLut, get } = setup({
      previews: (dataDir) => createRealLutPreviews({ dataDir }),
    });
    addLut('Golden Hour Warm');

    for (const slug of ['golden-hour-warm', 'film-contrast']) {
      const res = await get(`/api/luts/${slug}/preview/person/after.jpg`);
      expect(res.status, slug).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(jpegSize(body), slug).toEqual({ width: 396, height: 704 });
      expect(body.equals(readFileSync(lutFramePath('person'))), slug).toBe(false);
    }
  });
});
