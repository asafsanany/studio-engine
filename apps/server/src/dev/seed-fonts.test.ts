import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FontFamilyDetail,
  type FontsListResponse,
  fontsListResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { renameFontFamily } from '../fonts/font-test-rename.js';
import { startCanvasServer } from './seed-canvas.js';
import {
  FONT_FIXTURES_DIR,
  FONT_SEED_REQUESTS,
  FONT_SEED_SPECS,
  fontSeedTime,
} from './seed-fonts.js';

// `pnpm seed:canvas --fonts` (CVP-343): the test fonts copied into the seed inbox's _Fonts with
// added times and "used by" rows, over the real service, index, watcher and routes. Since FN23 the
// fontsInNotes switch is on by default, so `--fonts` shows the counts as the live page does;
// `--fonts-in-notes` is the same as an explicit flag and `--no-fonts-in-notes` (fontsInNotes: false)
// is the look with notes off.

const NOW = '2026-10-24T12:00:00.000Z';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('the Fonts library (--fonts)', () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ now: NOW, webDist, ...options });
    stops.push(server.stop);
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`${server.url}${path}`)).json()) as T;
    return { server, get };
  }

  it('is off without the option: no Fonts route, and the health says so', async () => {
    const { server, get } = await boot();
    expect(await get('/api/health')).toMatchObject({ fonts: false, fontsInNotes: false });
    expect((await fetch(`${server.url}/api/fonts`)).status).toBe(404);
    expect(server.fontsRepo).toBeNull();
    expect(await exists(join(server.inboxPath, '_Fonts'))).toBe(false);
  });

  it('turns the Fonts switch on, with fontsInNotes on as in the app, and the other libraries stay as they were', async () => {
    const { get } = await boot({ fonts: true });
    expect(await get('/api/health')).toMatchObject({
      fonts: true,
      fontsInNotes: true,
      graphics: false,
      graphicsInEdits: false,
      luts: false,
      lutsInEdits: false,
    });
  });

  it('--fonts-in-notes is the explicit flag: the same as --fonts (and implies fonts)', async () => {
    const { server, get } = await boot({ fontsInNotes: true });
    expect(await get('/api/health')).toMatchObject({
      fonts: true,
      fontsInNotes: true,
      graphics: false,
      luts: false,
    });
    expect(server.fontsRepo).not.toBeNull();
    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));
    expect(list.families).toHaveLength(5);
  });

  it('--no-fonts-in-notes turns the fontsInNotes switch off with fonts on', async () => {
    const { server, get } = await boot({ fontsInNotes: false });
    expect(await get('/api/health')).toMatchObject({ fonts: true, fontsInNotes: false });
    expect(server.fontsRepo).not.toBeNull();
    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));
    expect(list.families).toHaveLength(5);
  });

  it('counts the sample use with --fonts alone, as the live page does', async () => {
    const { get } = await boot({ fonts: true });
    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));
    const by = new Map(list.families.map((family) => [family.name, family]));
    expect(by.get('Secular One')).toMatchObject({ used: 3, usedLabel: '3 jobs' });
    expect(by.get('Outfit')).toMatchObject({ used: 1, usedLabel: '1 job' });
    expect((await get<FontFamilyDetail>('/api/fonts/outfit')).usedIn).toBe(1);
  });

  it('counts no use while fontsInNotes is off, as the engine does', async () => {
    const { get } = await boot({ fonts: true, fontsInNotes: false });
    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));
    expect(list.families.map((family) => [family.used, family.usedLabel])).toEqual(
      Array(5).fill([0, 'Not used yet']),
    );
    expect((await get<FontFamilyDetail>('/api/fonts/outfit')).usedIn).toBeNull();
  });

  it('lists the five families, the new one first, with the sample used counts (fontsInNotes on)', async () => {
    const { get } = await boot({ fontsInNotes: true });
    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));
    expect(list.families.map((family) => family.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Secular One',
      'Varela Round',
    ]);
    const by = new Map(list.families.map((family) => [family.name, family]));
    expect(by.get('Secular One')).toMatchObject({
      he: true,
      usedLabel: '3 jobs',
      isNew: false,
      weightsLabel: '1 weight',
    });
    expect(by.get('Outfit')).toMatchObject({
      he: false,
      usedLabel: '1 job',
      weights: [400, 700],
      weightsLabel: '2 weights',
    });
    expect(by.get('Oswald')).toMatchObject({ he: false, usedLabel: 'Not used yet', isNew: true });
    for (const name of ['Bellefair', 'Varela Round']) {
      expect(by.get(name)).toMatchObject({ he: true, usedLabel: 'Not used yet', isNew: false });
    }
    // 3 with Hebrew, 2 without; the six files are six faces
    expect(list.families.filter((family) => family.he)).toHaveLength(3);
    expect(list.catalog).toHaveLength(6);
    expect(list.requests).toEqual([]);
  });

  it('--fonts-missing N turns fontsInNotes on and asks for N fonts the library lacks, newest first, named by "Client · Job"', async () => {
    const { server, get } = await boot({ fontsMissing: 3 });
    expect(await get('/api/health')).toMatchObject({ fonts: true, fontsInNotes: true });
    expect(server.fontsRepo).not.toBeNull();

    const list = fontsListResponseSchema.parse(await get<FontsListResponse>('/api/fonts'));

    expect(list.requests.map((request) => request.name)).toEqual(
      FONT_SEED_REQUESTS.map((request) => request.name),
    );
    for (const request of list.requests) expect(request.jobName).toContain(' · ');
    // The first request is the board's: five minutes old.
    expect(Date.parse(NOW) - Date.parse(list.requests[0]?.at ?? '')).toBe(5 * 60_000);
  });

  it('--fonts-missing 1 asks for the one font; without it the page has no request', async () => {
    const one = await boot({ fontsMissing: 1 });
    const list = fontsListResponseSchema.parse(await one.get<FontsListResponse>('/api/fonts'));
    expect(list.requests.map((request) => request.name)).toEqual(['Gotham Bold']);

    const none = await boot({ fontsInNotes: true });
    const empty = fontsListResponseSchema.parse(await none.get<FontsListResponse>('/api/fonts'));
    expect(empty.requests).toEqual([]);
  });

  it('files copies of the fixtures in the two folders, and nothing else from the fixtures folder', async () => {
    const { server } = await boot({ fonts: true });
    const root = join(server.inboxPath, '_Fonts');
    expect((await readdir(root)).sort()).toEqual(['English only', 'Hebrew + English']);
    expect((await readdir(join(root, 'Hebrew + English'))).sort()).toEqual([
      'Bellefair',
      'Secular One',
      'Varela Round',
    ]);
    expect((await readdir(join(root, 'English only'))).sort()).toEqual(['Oswald', 'Outfit']);
    expect((await readdir(join(root, 'English only', 'Outfit'))).sort()).toEqual([
      'Outfit-Bold.ttf',
      'Outfit-Regular.ttf',
    ]);
    // a copy, byte for byte, and not the repo's own file
    const copy = join(root, 'Hebrew + English', 'Secular One', 'SecularOne-Regular.ttf');
    expect(await readFile(copy)).toEqual(
      await readFile(join(FONT_FIXTURES_DIR, 'SecularOne-Regular.ttf')),
    );
    // the broken file and the web-font samples of the fixtures folder are not seeded
    for (const spec of FONT_SEED_SPECS) {
      expect(spec.files.every((file) => file.endsWith('.ttf'))).toBe(true);
      expect(spec.files).not.toContain('broken-cut-short.ttf');
    }
  });

  it('gives each family its added time as the files’ modified time', async () => {
    const { server } = await boot({ fonts: true });
    const oswald = join(server.inboxPath, '_Fonts', 'English only', 'Oswald', 'Oswald-Regular.ttf');
    expect((await stat(oswald)).mtimeMs).toBe(Date.parse(NOW) - 2 * 60_000);
    const secular = join(
      server.inboxPath,
      '_Fonts',
      'Hebrew + English',
      'Secular One',
      'SecularOne-Regular.ttf',
    );
    expect((await stat(secular)).mtimeMs).toBe(
      fontSeedTime(Date.parse(NOW), { daysAgo: 3, hour: 15 }),
    );
  });

  it('serves a family’s pane with its faces; with fontsInNotes on "Used in" is the sample count', async () => {
    const { get } = await boot({ fontsInNotes: true });
    const detail = await get<FontFamilyDetail>('/api/fonts/outfit');
    expect(detail.faces.map((face) => face.name)).toEqual(['Outfit', 'Outfit Bold']);
    expect(detail.usedIn).toBe(1);
  });

  it('changes no job rows: the twelve are there as before', async () => {
    const { get } = await boot({ fonts: true });
    expect((await get<unknown[]>('/api/jobs')).length).toBe(12);
  });

  it('--fonts-empty switches Fonts on with an empty _Fonts', async () => {
    const { server, get } = await boot({ fontsEmpty: true });
    expect(await get('/api/health')).toMatchObject({ fonts: true, fontsInNotes: true });
    const list = await get<FontsListResponse>('/api/fonts');
    expect(list.families).toEqual([]);
    expect(await readdir(join(server.inboxPath, '_Fonts'))).toEqual([]);
  });

  it('sees a font copied into _Fonts while it runs, without a restart', async () => {
    const { server, get } = await boot({ fonts: true });
    const folder = join(server.inboxPath, '_Fonts', 'Hebrew + English', 'Karantina');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'Karantina-Regular.ttf'),
      renameFontFamily(
        await readFile(join(FONT_FIXTURES_DIR, 'Bellefair-Regular.ttf')),
        'Bellefair',
        'Karantina',
      ),
    );
    // The watcher waits half a second after the last change before it reads the folder.
    await expect
      .poll(
        async () =>
          (await get<FontsListResponse>('/api/fonts')).families.map((family) => family.name),
        { timeout: 8_000, interval: 200 },
      )
      .toContain('Karantina');
  });

  it('has Show in Finder recorded, not done', async () => {
    const { server } = await boot({ fonts: true });
    const res = await fetch(`${server.url}/api/fonts/secular-one/reveal`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(server.finder.files).toEqual([
      join(server.inboxPath, '_Fonts', 'Hebrew + English', 'Secular One'),
    ]);
  });

  it('moves a deleted family to the seed’s own Trash, not the real one', async () => {
    const { server, get } = await boot({ fonts: true });
    const res = await fetch(`${server.url}/api/fonts/oswald`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await exists(join(server.dir, 'home', '.Trash', 'Oswald', 'Oswald-Regular.ttf'))).toBe(
      true,
    );
    expect(await exists(join(server.inboxPath, '_Fonts', 'English only', 'Oswald'))).toBe(false);
    const list = await get<FontsListResponse>('/api/fonts');
    expect(list.families.map((family) => family.name)).not.toContain('Oswald');
  });
});

describe('the seed’s own helpers', () => {
  it('puts "3 days ago" on a calendar day and "2 minutes ago" back from now', () => {
    const now = Date.parse(NOW);
    expect(fontSeedTime(now, { minutesAgo: 2 })).toBe(now - 120_000);
    const day = new Date(fontSeedTime(now, { daysAgo: 3, hour: 15 }));
    expect(day.getHours()).toBe(15);
    expect(Math.round((now - day.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(2);
  });
});
