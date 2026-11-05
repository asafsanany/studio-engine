import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  clientListResponseSchema,
  FONT_MESSAGES,
  fontsListResponseSchema,
  healthResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import { buildFont, FIXTURE_FONTS } from './fonts/font-test-utils.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The Fonts switches in the boot composition (FN0, FN1, FN11, FN23): Fonts and fontsInNotes both on
// by default, told to the web in /api/health; with STUDIO_FONTS=0 the engine has no Fonts route; on, it
// answers GET /api/fonts (FN1: an empty library until FN3), and `_Fonts` in the inbox is never a
// client. The real inbox side runs on a temp inbox.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-fonts-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

function boot(config: Config): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    // Not what is installed on this Mac: no colour-grade skill, so the engine does not start the
    // built-in LUT stills in the background (ffmpeg writing into the temp home while `afterEach`
    // removes it failed a random test of this file with ENOTEMPTY).
    builtInLuts: noBuiltInLuts(),
  });
  engines.push(engine);
  return engine;
}

/** The jobs the first inbox scan registered: waits for them rather than reading right after `start()`. */
async function jobsOf(engine: Engine, count: number) {
  await waitFor(() => engine.jobs.getAll().length >= count);
  return engine.jobs.getAll();
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the Fonts switches in the engine', () => {
  it('are Fonts and fontsInNotes both on by default, and /api/health says so', async () => {
    const config = tempConfig();
    expect(config).toMatchObject({ fonts: true, fontsInNotes: true });
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ fonts: true, fontsInNotes: true });
  });

  it('are told off in /api/health when STUDIO_FONTS=0 (the notes switch stays as it was)', async () => {
    const off = boot(tempConfig({ STUDIO_FONTS: '0' }));
    await off.start();
    expect(await health(off)).toMatchObject({ fonts: false, fontsInNotes: true });
  });

  it('are told in /api/health when STUDIO_FONTS and STUDIO_FONTS_IN_NOTES are both off', async () => {
    const none = boot(tempConfig({ STUDIO_FONTS: '0', STUDIO_FONTS_IN_NOTES: '0' }));
    await none.start();
    expect(await health(none)).toMatchObject({ fonts: false, fontsInNotes: false });
  });

  it('move apart: each switch alone tells only itself', async () => {
    const fonts = boot(tempConfig({ STUDIO_FONTS_IN_NOTES: '0' }));
    await fonts.start();
    expect(await health(fonts)).toMatchObject({ fonts: true, fontsInNotes: false });

    const inNotes = boot(tempConfig({ STUDIO_FONTS: '0' }));
    await inNotes.start();
    expect(await health(inNotes)).toMatchObject({ fonts: false, fontsInNotes: true });
  });
});

describe('the Fonts switch off (STUDIO_FONTS=0)', () => {
  it('leaves the engine as it was: no Fonts route, the disabled service, health says off', async () => {
    const config = tempConfig({ STUDIO_FONTS: '0' });
    const engine = boot(config);

    await engine.start();

    expect(engine.fonts.enabled).toBe(false);
    for (const [method, path] of [
      ['GET', '/api/fonts'],
      ['GET', '/api/fonts/heebo'],
      ['GET', '/api/fonts/file/3f9a1c7e5b20'],
      ['POST', '/api/fonts/heebo/reveal'],
      ['DELETE', '/api/fonts/heebo'],
      ['POST', '/api/fonts/stage'],
      ['POST', '/api/fonts/import'],
    ] as const) {
      const res = await engine.app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.off });
    }
  });

  it('keeps fontsInNotes (on by default) on its own from turning anything on', async () => {
    const engine = boot(tempConfig({ STUDIO_FONTS: '0' }));

    await engine.start();

    expect(engine.fonts.enabled).toBe(false);
    expect((await engine.app.request('/api/fonts')).status).toBe(404);
  });

  it('still never makes a client of the _Fonts folder, which it has always made at boot', async () => {
    const config = tempConfig({ STUDIO_FONTS: '0' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const engine = boot(config);

    await engine.start();

    expect(statSync(join(config.inboxPath, '_Fonts')).isDirectory()).toBe(true);
    expect(engine.clientFolders.list()).toEqual(['Acme']);
    expect((await jobsOf(engine, 1)).map((job) => job.client)).toEqual(['Acme']);
  });
});

describe('the Fonts switch on (STUDIO_FONTS=1)', () => {
  it('answers GET /api/fonts with an empty library', async () => {
    const engine = boot(tempConfig({ STUDIO_FONTS: '1' }));
    await engine.start();

    expect(engine.fonts.enabled).toBe(true);
    const res = await engine.app.request('/api/fonts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ families: [], catalog: [], requests: [] });
    expect(
      fontsListResponseSchema.parse(await (await engine.app.request('/api/fonts')).json()),
    ).toEqual({ families: [], catalog: [], requests: [] });
  });

  it('makes _Fonts in the inbox, which is never a client or a job', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const engine = boot(config);

    await engine.start();

    expect(statSync(join(config.inboxPath, '_Fonts')).isDirectory()).toBe(true);
    expect(engine.clientFolders.list()).toEqual(['Acme']);
    const clients = clientListResponseSchema.parse(
      await (await engine.app.request('/api/clients')).json(),
    );
    expect(clients.map((row) => row.client)).toEqual(['Acme']);
    expect((await jobsOf(engine, 1)).map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('keeps what is in _Fonts, and a family folder dropped there later is no client either', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    mkdirSync(join(config.inboxPath, '_Fonts', 'Hebrew + English', 'Heebo'), { recursive: true });
    writeFileSync(
      join(config.inboxPath, '_Fonts', 'Hebrew + English', 'Heebo', 'Heebo-Bold.ttf'),
      'not a font',
    );
    const engine = boot(config);

    await engine.start();

    expect(readdirSync(join(config.inboxPath, '_Fonts'))).toEqual(['Hebrew + English']);
    expect(engine.clientFolders.list()).toEqual([]);
    expect(engine.jobs.getAll()).toEqual([]);
  });

  it('stages, checks and imports a font through the engine, and reaps the leftovers of an earlier run at boot', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    // An upload an earlier run left behind: nothing waits across a restart.
    const left = join(config.dataDir, 'font-staging', 'aaaaaaaaaaaa');
    mkdirSync(left, { recursive: true });
    const engine = boot(config);
    const events = fontEvents(engine);
    await engine.start();
    await vi.waitFor(() => expect(existsSync(left)).toBe(false));

    const form = new FormData();
    form.append(
      'files[]',
      new Blob([readFileSync(join(FIXTURE_FONTS, 'Outfit-Bold.ttf'))]),
      'Fonts/Outfit/Outfit-Bold.ttf',
    );
    form.append('files[]', new Blob(['junk']), 'Fonts/.DS_Store');
    const staged = await engine.app.request('/api/fonts/stage', { method: 'POST', body: form });
    expect(staged.status).toBe(200);
    const { stageId, items } = (await staged.json()) as {
      stageId: string;
      items: { id: string; name: string; status: string }[];
    };
    expect(items.map((item) => [item.name, item.status])).toEqual([['Outfit', 'new']]);
    expect(existsSync(join(config.dataDir, 'font-staging', stageId))).toBe(true);

    const imported = await engine.app.request('/api/fonts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId, items: ['i0'] }),
    });

    expect(imported.status).toBe(201);
    expect(
      existsSync(join(config.inboxPath, '_Fonts', 'English only', 'Outfit', 'Outfit-Bold.ttf')),
    ).toBe(true);
    expect(existsSync(join(config.dataDir, 'font-staging', stageId))).toBe(false);
    const list = (await (await engine.app.request('/api/fonts')).json()) as {
      families: { slug: string; isNew: boolean }[];
    };
    expect(list.families).toMatchObject([{ slug: 'outfit', isNew: true }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'font.changed',
        family: expect.objectContaining({ slug: 'outfit' }),
      }),
    );
  });

  it('answers the import routes 404 "Fonts are off." while the switch is off', async () => {
    const engine = boot(tempConfig({ STUDIO_FONTS: '0' }));
    await engine.start();
    for (const [method, path] of [
      ['POST', '/api/fonts/stage'],
      ['DELETE', '/api/fonts/stage/aaaaaaaaaaaa'],
      ['POST', '/api/fonts/import'],
    ] as const) {
      const res = await engine.app.request(path, { method });
      expect([res.status, await res.json()]).toEqual([404, { error: FONT_MESSAGES.off }]);
    }
  });

  it('answers 404 with the message for a family and a file it does not know', async () => {
    const engine = boot(tempConfig({ STUDIO_FONTS: '1' }));
    await engine.start();

    const family = await engine.app.request('/api/fonts/heebo');
    const file = await engine.app.request('/api/fonts/file/0123456789ab');

    expect([family.status, await family.json()]).toEqual([404, { error: FONT_MESSAGES.notFound }]);
    expect([file.status, await file.json()]).toEqual([404, { error: FONT_MESSAGES.fileNotFound }]);
  });

  it('records a use and a request in the tables, and tells the browsers nothing yet', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    const engine = boot(config);
    const events: ServerEvent[] = [];
    engine.bus.subscribe((event) => events.push(event));
    engine.fontsRepo.addUse({
      family: 'Heebo',
      weight: 700,
      italic: false,
      jobId: 'job-a',
      round: 0,
      source: 'token',
    });
    engine.fontsRepo.addRequest('Gotham Bold', 'job-a', 1);
    await engine.start();

    expect(engine.fontsRepo.usedCount('heebo')).toBe(1);
    expect(engine.fontsRepo.openRequests(0)).toHaveLength(1);
    expect(existsSync(join(config.inboxPath, '_Fonts'))).toBe(true);
    expect(events.filter((event) => event.type.startsWith('font.'))).toEqual([]);
  });
});

// --- the font index in the engine (FN3) -------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Copies a fixture font into `_Fonts` of a config's inbox, filing it under `rel`. */
function putFont(config: Config, rel: string, fixture: string): string {
  const target = join(config.inboxPath, '_Fonts', ...rel.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  copyFileSync(join(FIXTURE_FONTS, fixture), target);
  return target;
}

function fontEvents(engine: Engine): ServerEvent[] {
  const events: ServerEvent[] = [];
  engine.bus.subscribe((event) => {
    if (event.type.startsWith('font.')) events.push(event);
  });
  return events;
}

describe('the font index in the engine (STUDIO_FONTS=1)', () => {
  it('lists the fonts in _Fonts, and serves a font file by its id', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    putFont(config, 'English only/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    const bold = putFont(config, 'English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    putFont(
      config,
      'Hebrew + English/Secular One/SecularOne-Regular.ttf',
      'SecularOne-Regular.ttf',
    );
    const engine = boot(config);
    await engine.start();

    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );

    expect(list.families.map((family) => [family.slug, family.he, family.weightsLabel])).toEqual([
      ['outfit', false, '2 weights'],
      ['secular-one', true, '1 weight'],
    ]);
    const face = list.catalog.find((entry) => entry.name === 'Outfit Bold');
    const file = await engine.app.request(`/api/fonts/file/${face?.fileId}?v=${face?.version}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await file.arrayBuffer()).length).toBe(statSync(bold).size);
    // The engine's own catalog is what a note is read against (FN15).
    expect((await engine.fonts.catalog()).faces.map((entry) => entry.name)).toEqual([
      'Outfit',
      'Outfit Bold',
      'Secular One',
    ]);
  });

  it('names the job of an open request for a font it does not have', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring Sale'), { recursive: true });
    const engine = boot(config);
    await engine.start();
    const job = (await jobsOf(engine, 1))[0];
    expect(job?.name).toBe('Spring Sale');
    engine.fontsRepo.addRequest('Gotham Bold', job?.id ?? '', 1);
    engine.fontsRepo.addRequest('Lost Job Font', 'a-job-that-is-gone', 0);

    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );

    expect(list.requests.map((request) => [request.name, request.jobName])).toEqual([
      ['Gotham Bold', 'Acme · Spring Sale'],
    ]);
  });

  it('shows no request while the notes switch is off, even one made earlier', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '0' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring Sale'), { recursive: true });
    const engine = boot(config);
    await engine.start();
    const job = (await jobsOf(engine, 1))[0];
    engine.fontsRepo.addRequest('Gotham Bold', job?.id ?? '', 1);

    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );

    expect(list.requests).toEqual([]);
  });

  it('notices fonts dropped into and taken out of _Fonts, and tells the bus', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    const oswald = putFont(config, 'English only/Oswald/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    const engine = boot(config);
    const events = fontEvents(engine);
    await engine.start();
    expect((await engine.fonts.catalog()).faces).toHaveLength(1);

    // start() does not wait for the watcher to be listening: touch the file until it hears.
    const deadline = Date.now() + 15_000;
    const bytes = readFileSync(oswald);
    while (events.length === 0) {
      if (Date.now() > deadline) throw new Error('the watcher never told the bus');
      writeFileSync(oswald, bytes);
      // Longer than the watcher's 500 ms wait, which every new event would start over.
      await sleep(1_000);
    }
    expect(events[0]).toMatchObject({ type: 'font.changed', family: { slug: 'oswald' } });

    // A touch that was still on its way when the first event came may tell the bus once more:
    // from here on look at the family the test adds.
    const about = (slug: string) =>
      events.filter((event) =>
        event.type === 'font.changed'
          ? event.family.slug === slug
          : event.type === 'font.removed' && event.slug === slug,
      );
    const dropped = join(
      config.inboxPath,
      '_Fonts',
      'English only',
      'Dropped',
      'Dropped-Regular.ttf',
    );
    mkdirSync(join(dropped, '..'), { recursive: true });
    writeFileSync(
      dropped,
      buildFont({ id1: 'Dropped Font', id2: 'Regular', id16: 'Dropped Font', id17: 'Regular' }),
    );
    await waitFor(() => about('dropped-font').length > 0);
    expect(about('dropped-font')).toMatchObject([
      { type: 'font.changed', family: { slug: 'dropped-font', name: 'Dropped Font', isNew: true } },
    ]);

    unlinkSync(dropped);
    await waitFor(() => about('dropped-font').length > 1);
    expect(about('dropped-font').at(-1)).toEqual({ type: 'font.removed', slug: 'dropped-font' });
    expect((await engine.fonts.catalog()).faces.map((face) => face.name)).toEqual(['Oswald']);
  }, 40_000);

  it('C46: a font copied into _Fonts in Finder answers the note that asked for it, and the banner list drops it', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring Sale'), { recursive: true });
    const engine = boot(config);
    const events = fontEvents(engine);
    await engine.start();
    const job = (await jobsOf(engine, 1))[0];
    engine.fontsRepo.addRequest('Gotham Bold', job?.id ?? '', 1);
    engine.fontsRepo.addRequest('Gotham Thin', job?.id ?? '', 1);
    await engine.fonts.catalog();
    const requests = async () =>
      fontsListResponseSchema
        .parse(await (await engine.app.request('/api/fonts')).json())
        .requests.map((request) => request.name)
        .sort();
    expect(await requests()).toEqual(['Gotham Bold', 'Gotham Thin']);

    // Gotham, with a Bold, dropped by hand. start() does not wait for the watcher to be listening:
    // write the files again until it hears.
    const regular = join(
      config.inboxPath,
      '_Fonts',
      'English only',
      'Gotham',
      'Gotham-Regular.ttf',
    );
    const bold = join(config.inboxPath, '_Fonts', 'English only', 'Gotham', 'Gotham-Bold.ttf');
    mkdirSync(join(regular, '..'), { recursive: true });
    const deadline = Date.now() + 25_000;
    while (engine.fontsRepo.openRequests(0).length > 1) {
      if (Date.now() > deadline) throw new Error('the watcher never settled the request');
      writeFileSync(
        regular,
        buildFont({ id1: 'Gotham', id2: 'Regular', id16: 'Gotham', id17: 'Regular' }),
      );
      writeFileSync(
        bold,
        buildFont({
          id1: 'Gotham',
          id2: 'Bold',
          id16: 'Gotham',
          id17: 'Bold',
          weightClass: 700,
        }),
      );
      await sleep(1_000);
    }

    expect(await requests()).toEqual(['Gotham Thin']);
    expect(events[0]).toMatchObject({ type: 'font.changed', family: { name: 'Gotham' } });
  }, 40_000);

  it('lets go of the watcher when the engine stops', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    const oswald = putFont(config, 'English only/Oswald/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    const engine = boot(config);
    const events = fontEvents(engine);
    await engine.start();
    await engine.fonts.catalog();
    await sleep(600);

    await engine.stop();
    // A write the watcher would have heard (and waited 500 ms to tell the bus about).
    writeFileSync(oswald, readFileSync(oswald));
    await sleep(1_200);

    expect(events).toEqual([]);
  });
});

describe('the font index with the Fonts switch off', () => {
  it('reads nothing and watches nothing: fonts in _Fonts send no event, and the routes stay off', async () => {
    const config = tempConfig({ STUDIO_FONTS: '0' });
    const oswald = putFont(config, 'English only/Oswald/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    const engine = boot(config);
    const events = fontEvents(engine);
    await engine.start();
    await sleep(600);

    writeFileSync(oswald, readFileSync(oswald));
    putFont(config, 'English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    await sleep(1_500);

    expect(events).toEqual([]);
    expect(engine.fonts.enabled).toBe(false);
    expect(await engine.fonts.catalog()).toEqual({ faces: [] });
    expect((await engine.app.request('/api/fonts')).status).toBe(404);
    // The jobs' own copy of the fonts does not depend on the switch.
    expect(existsSync(join(config.inboxPath, '_Fonts', 'English only', 'Oswald'))).toBe(true);
  });
});

async function waitFor(read: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(25);
  }
}
