import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LutDetail, type LutListResponse, lutListResponseSchema } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLutText } from '../luts/lut-check.js';
import { startCanvasServer } from './seed-canvas.js';
import { LUT_SEED_SPECS, lutSeedTime, SEED_LUT_SIZE, seedCubeText } from './seed-luts.js';

// `pnpm seed:canvas --luts` (CVP-307): four LUTs of Yours with files in _LUTs, used counts and added
// times, over the real service and routes, with the fake preview maker.

const NOW = '2026-10-24T12:00:00.000Z';

describe('the LUTs library (--luts)', () => {
  const stops: Array<() => Promise<void>> = [];
  const savedSkill = process.env.STUDIO_COLOR_GRADE_DIR;

  beforeEach(() => {
    // Not what is installed on this Mac: no colour-grade skill, so Built in is the one-line hint.
    process.env.STUDIO_COLOR_GRADE_DIR = join(tmpdir(), 'studio-no-such-skill');
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    if (savedSkill === undefined) delete process.env.STUDIO_COLOR_GRADE_DIR;
    else process.env.STUDIO_COLOR_GRADE_DIR = savedSkill;
  });

  async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ now: NOW, webDist, lutPreviews: 'fake', ...options });
    stops.push(server.stop);
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`${server.url}${path}`)).json()) as T;
    return { server, get };
  }

  it('is off without the option: no LUTs route, and the health says so', async () => {
    const { server, get } = await boot();
    expect(await get('/api/health')).toMatchObject({ luts: false, lutsInEdits: false });
    expect((await fetch(`${server.url}/api/luts`)).status).toBe(404);
    expect(server.lutsRepo).toBeNull();
  });

  it('turns the switch on and lists the four LUTs of Yours, newest first', async () => {
    const { get } = await boot({ luts: true });
    expect(await get('/api/health')).toMatchObject({ luts: true, lutsInEdits: false });

    const list = lutListResponseSchema.parse(await get<LutListResponse>('/api/luts'));
    expect(list.builtInAvailable).toBe(false);
    expect(list.yours.map((l) => l.name)).toEqual([
      'Soft Pastel',
      'Golden Hour Warm',
      'Teal Orange Soft',
      'Sony S-Log3 to Rec709',
    ]);
    const by = new Map(list.yours.map((l) => [l.name, l]));
    expect(by.get('Soft Pastel')).toMatchObject({ isNew: true, usedLabel: 'Not used yet' });
    expect(by.get('Golden Hour Warm')).toMatchObject({ isNew: false, usedLabel: '3 jobs' });
    expect(by.get('Teal Orange Soft')).toMatchObject({ kind: 'look', usedLabel: 'Not used yet' });
    expect(by.get('Sony S-Log3 to Rec709')).toMatchObject({ kind: 'camera', usedLabel: '1 job' });
    for (const lut of list.yours) expect(lut.size).toBe(SEED_LUT_SIZE);
  });

  it('writes a valid .cube for each LUT into _LUTs, and the pane can read it', async () => {
    const { server, get } = await boot({ luts: true });
    const files = (await readdir(join(server.inboxPath, '_LUTs'))).sort();
    expect(files).toEqual(LUT_SEED_SPECS.map((spec) => `${spec.name}.cube`).sort());
    const text = await readFile(join(server.inboxPath, '_LUTs', 'Golden Hour Warm.cube'), 'utf8');
    expect(checkLutText('Golden Hour Warm.cube', text, Buffer.byteLength(text))).toMatchObject({
      ok: true,
      size: 17,
    });

    const detail = await get<LutDetail>('/api/luts/golden-hour-warm');
    expect(detail).toMatchObject({ file: 'Golden Hour Warm.cube', owner: 'yours', usedIn: null });
    expect(detail.bytes).toBe(Buffer.byteLength(text));
    const still = await fetch(`${server.url}/api/luts/golden-hour-warm/preview/person/after.jpg`);
    expect(still.status).toBe(200);
    expect(still.headers.get('content-type')).toBe('image/jpeg');
  });

  it('changes no job rows: the twelve are there as before', async () => {
    const { get } = await boot({ luts: true });
    expect((await get<unknown[]>('/api/jobs')).length).toBe(12);
  });

  it('--luts-empty switches LUTs on with nothing of Yours', async () => {
    const { server, get } = await boot({ lutsEmpty: true });
    const list = await get<LutListResponse>('/api/luts');
    expect(list.yours).toEqual([]);
    expect(server.lutsRepo?.list()).toEqual([]);
  });

  it('has Show in Finder recorded, not done', async () => {
    const { server } = await boot({ luts: true });
    const res = await fetch(`${server.url}/api/luts/golden-hour-warm/reveal`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(server.finder.files).toEqual([join(server.inboxPath, '_LUTs', 'Golden Hour Warm.cube')]);
  });
});

describe('the seed’s own helpers', () => {
  it('makes the identity plus a tint that follows the brightness', () => {
    const text = seedCubeText('Test', [0.1, 0, -0.1]);
    const rows = text
      .split('\n')
      .filter((line) => /^[\d.]/.test(line))
      .map((line) => line.split(' ').map(Number));
    expect(rows).toHaveLength(SEED_LUT_SIZE ** 3);
    // black stays near black, white gets the tint (clamped)
    expect(rows[0]).toEqual([0.04, 0, 0]);
    expect(rows.at(-1)).toEqual([1, 1, 0.9]);
  });

  it('puts "2 days ago" on a calendar day and "2 minutes ago" back from now', () => {
    const now = Date.parse(NOW);
    expect(lutSeedTime(now, { minutesAgo: 2 })).toBe(now - 120_000);
    const day = new Date(lutSeedTime(now, { daysAgo: 2, hour: 14 }));
    expect(day.getHours()).toBe(14);
    expect(Math.round((now - day.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(1);
  });
});
