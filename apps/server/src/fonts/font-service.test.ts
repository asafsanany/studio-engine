import { statSync, unlinkSync, utimesSync } from 'node:fs';
import {
  FONT_MESSAGES,
  fontFaceSchema,
  fontFamilyDetailSchema,
  fontsListResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontRepository } from '../db/font-repository.js';
import { memoryDb } from '../db/test-utils.js';
import type { FsEvent, Timers } from '../inbox/watcher.js';
import {
  createDisabledFontService,
  createFontService,
  type FontEvent,
  type FontService,
  type FontServiceOptions,
} from './font-service.js';
import { buildFont } from './font-test-utils.js';
import type { FontEventSource } from './font-watcher.js';
import { makeStandardLibrary, type TempLibrary } from './library/test-utils.js';

// The Fonts service on a real `_Fonts` (FN3): the list with its numbers, one family, a file, the
// events a change sends, and the start/stop the engine drives. The watcher's source and timers are
// the test's own.

const NOW = new Date('2026-10-25T12:00:00.000Z');
const secondsAgo = (seconds: number): number => NOW.getTime() / 1000 - seconds;

const libraries: TempLibrary[] = [];
afterEach(() => {
  for (const library of libraries.splice(0)) library.cleanup();
});

function manualTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const timers: Timers = {
    setTimeout(run) {
      const id = nextId;
      nextId += 1;
      pending.set(id, run);
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    fire() {
      for (const [id, run] of [...pending]) {
        pending.delete(id);
        run();
      }
    },
  };
}

function setup(options: Partial<FontServiceOptions> = {}) {
  const library = makeStandardLibrary();
  libraries.push(library);
  // Outfit was added ten minutes ago; everything else three days ago.
  for (const rel of [
    'Hebrew + English/Secular One/SecularOne-Regular.ttf',
    'Hebrew + English/Bellefair/Bellefair-Regular.ttf',
    'Hebrew + English/Varela Round/VarelaRound-Regular.ttf',
    'English only/Oswald/Oswald-Regular.ttf',
  ]) {
    utimesSync(library.path(rel), secondsAgo(3 * 86_400), secondsAgo(3 * 86_400));
  }
  for (const rel of [
    'English only/Outfit/Outfit-Regular.ttf',
    'English only/Outfit/Outfit-Bold.ttf',
  ]) {
    utimesSync(library.path(rel), secondsAgo(600), secondsAgo(600));
  }
  const repo = new FontRepository(memoryDb());
  const published: FontEvent[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = manualTimers();
  let emit: (event: FsEvent) => void = () => {};
  const source: FontEventSource & { starts: number; stops: number } = {
    starts: 0,
    stops: 0,
    async start(next) {
      source.starts += 1;
      emit = next;
    },
    async stop() {
      source.stops += 1;
    },
  };
  const service = createFontService({
    repo,
    inboxPath: library.inbox,
    publish: (event) => published.push(event),
    usedIn: true,
    jobName: (jobId) => ({ 'job-a': 'Horizon FPV', 'job-b': 'Spring Sale' })[jobId] ?? null,
    watcher: { source, timers: clock.timers },
    logger,
    clock: () => NOW,
    ...options,
  });
  return {
    service,
    library,
    repo,
    published,
    logger,
    clock,
    source,
    send: (kind: FsEvent['kind'], rel: string) => emit({ kind, path: library.path(rel) }),
  };
}

async function listed(service: FontService) {
  const outcome = await service.list();
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.body;
}

const use = (family: string, jobId: string) => ({
  family,
  weight: 700,
  italic: false,
  jobId,
  round: 1,
  source: 'token' as const,
});

describe('list()', () => {
  it('lists the families A to Z with the numbers a row shows', async () => {
    const { service } = setup();

    const { families } = await listed(service);

    expect(families.map((family) => family.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Secular One',
      'Varela Round',
    ]);
    expect(families.find((family) => family.slug === 'outfit')).toEqual({
      slug: 'outfit',
      name: 'Outfit',
      he: false,
      style: 'Sans',
      weights: [400, 700],
      weightsLabel: '2 weights',
      used: 0,
      usedLabel: 'Not used yet',
      addedAt: new Date(secondsAgo(600) * 1000).toISOString(),
      isNew: true,
    });
    expect(families.find((family) => family.slug === 'secular-one')).toMatchObject({
      he: true,
      style: 'Display',
      weights: [400],
      weightsLabel: '1 weight',
      isNew: false,
    });
  });

  it('counts the jobs that used a family, without regard to case, once per job', async () => {
    const { service, repo } = setup();
    repo.addUse(use('Outfit', 'job-a'));
    repo.addUse({ ...use('outfit', 'job-a'), weight: 400 });
    repo.addUse(use('OUTFIT', 'job-b'));
    repo.addUse(use('Oswald', 'job-b'));

    const { families } = await listed(service);

    expect(families.map((family) => [family.name, family.used, family.usedLabel])).toEqual([
      ['Bellefair', 0, 'Not used yet'],
      ['Oswald', 1, '1 job'],
      ['Outfit', 2, '2 jobs'],
      ['Secular One', 0, 'Not used yet'],
      ['Varela Round', 0, 'Not used yet'],
    ]);
  });

  it('counts nothing while uses are not recorded (fontsInNotes off), whatever the table holds', async () => {
    const { service, repo } = setup({ usedIn: false });
    repo.addUse(use('Outfit', 'job-a'));

    const { families } = await listed(service);

    expect(
      families.every((family) => family.used === 0 && family.usedLabel === 'Not used yet'),
    ).toBe(true);
  });

  it('lists every face in the catalog: family by family, light to heavy, as the contract says', async () => {
    const { service, library } = setup();

    const { catalog } = await listed(service);

    expect(catalog.map((face) => face.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Outfit Bold',
      'Secular One',
      'Varela Round',
    ]);
    const bold = catalog.find((face) => face.name === 'Outfit Bold');
    expect(bold).toEqual({
      name: 'Outfit Bold',
      family: 'Outfit',
      weight: 700,
      italic: false,
      fileId: expect.stringMatching(/^[0-9a-f]{12}$/),
      bytes: 48_340,
      format: 'ttf',
      version: String(
        Math.trunc(statSync(library.path('English only/Outfit/Outfit-Bold.ttf')).mtimeMs),
      ),
    });
    // The path and the Hebrew flag are the engine's own; they do not go to the browser.
    for (const face of catalog)
      expect(Object.keys(face).sort()).toEqual(Object.keys(bold ?? {}).sort());
    expect(fontFaceSchema.parse(bold)).toEqual(bold);
  });

  it('answers what the shared schema says a list is', async () => {
    const { service } = setup();
    const body = await listed(service);
    expect(fontsListResponseSchema.parse(body)).toEqual(body);
  });

  it('lists the requests for a missing font from the last 7 days, with the job names', async () => {
    const { service, repo } = setup();
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    repo.addRequest('Gotham Bold', 'job-a', 1, days(2));
    repo.addRequest('Avenir', 'job-b', 0, days(1));
    repo.addRequest('Too Old', 'job-a', 0, days(8));
    repo.addRequest('Nobody Asked', 'gone-job', 0, days(1));
    const resolved = repo.addRequest('Resolved', 'job-a', 2, days(1));
    repo.resolveRequests('Resolved', days(0));

    const { requests } = await listed(service);

    expect(requests).toEqual([
      {
        id: expect.any(String),
        name: 'Avenir',
        jobId: 'job-b',
        jobName: 'Spring Sale',
        round: 0,
        at: days(1),
      },
      {
        id: expect.any(String),
        name: 'Gotham Bold',
        jobId: 'job-a',
        jobName: 'Horizon FPV',
        round: 1,
        at: days(2),
      },
    ]);
    expect(requests.map((request) => request.id)).not.toContain(resolved.id);
  });

  it('lists no request while notes cannot name a font (fontsInNotes off), even one made earlier', async () => {
    const { service, repo } = setup({ usedIn: false });
    repo.addRequest('Gotham Bold', 'job-a', 1, new Date(NOW.getTime() - 86_400_000).toISOString());

    expect((await listed(service)).requests).toEqual([]);
  });

  it('lists the newest request first, and each request once per name, job and round', async () => {
    const { service, repo } = setup();
    const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
    repo.addRequest('Gotham Bold', 'job-a', 1, minutes(30));
    repo.addRequest('gotham bold', 'job-a', 1, minutes(20));
    repo.addRequest('Avenir', 'job-b', 0, minutes(10));
    repo.addRequest('Gotham Bold', 'job-b', 0, minutes(5));

    const { requests } = await listed(service);

    expect(requests.map((request) => [request.name, request.jobName, request.round])).toEqual([
      ['Gotham Bold', 'Spring Sale', 0],
      ['Avenir', 'Spring Sale', 0],
      ['Gotham Bold', 'Horizon FPV', 1],
    ]);
  });

  it('builds the index by itself when it is asked before start()', async () => {
    const { service, source } = setup();

    const { families } = await listed(service);

    expect(families).toHaveLength(5);
    expect(source.starts).toBe(0);
  });
});

describe('get()', () => {
  it('answers a family with the faces, files, size and the jobs that used it', async () => {
    const { service, repo } = setup();
    repo.addUse(use('Outfit', 'job-a'));

    const outcome = await service.get('outfit');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(fontFamilyDetailSchema.parse(outcome.body)).toEqual(outcome.body);
    expect(outcome.body).toMatchObject({
      slug: 'outfit',
      name: 'Outfit',
      weights: [400, 700],
      used: 1,
      usedLabel: '1 job',
      files: 2,
      bytes: 47_844 + 48_340,
      usedIn: 1,
    });
    expect(outcome.body.faces.map((face) => face.name)).toEqual(['Outfit', 'Outfit Bold']);
  });

  it('has usedIn null while uses are not recorded', async () => {
    const { service } = setup({ usedIn: false });
    const outcome = await service.get('outfit');
    expect(outcome.ok && outcome.body.usedIn).toBeNull();
  });

  it('refuses a slug it does not know with 404 and the message', async () => {
    const { service } = setup();
    expect(await service.get('gotham')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.notFound,
    });
  });
});

describe('file()', () => {
  it('answers the path, the format and the modified time for an id the index gave', async () => {
    const { service, library } = setup();
    const { catalog } = await listed(service);
    const bold = catalog.find((face) => face.name === 'Outfit Bold');

    const outcome = await service.file(bold?.fileId ?? '');

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      body: {
        path: library.path('English only/Outfit/Outfit-Bold.ttf'),
        format: 'ttf',
        mtimeMs: Math.round(secondsAgo(600) * 1000),
      },
    });
    expect(bold?.version).toBe(String(Math.round(secondsAgo(600) * 1000)));
  });

  it('refuses an id the index does not know, and never takes a path', async () => {
    const { service, library } = setup();
    const refusal = { ok: false, status: 404, error: FONT_MESSAGES.fileNotFound };

    expect(await service.file('0123456789ab')).toEqual(refusal);
    expect(await service.file(library.path('English only/Outfit/Outfit-Bold.ttf'))).toEqual(
      refusal,
    );
    expect(await service.file('English only/Outfit/Outfit-Bold.ttf')).toEqual(refusal);
    expect(await service.file('../../../etc/passwd')).toEqual(refusal);
  });

  it('refuses a file that went away since the index looked', async () => {
    const { service, library } = setup();
    const { catalog } = await listed(service);
    unlinkSync(library.path('English only/Oswald/Oswald-Regular.ttf'));

    expect(
      await service.file(catalog.find((face) => face.name === 'Oswald')?.fileId ?? ''),
    ).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.fileNotFound,
    });
  });

  it('judges the version against the file as it is now', async () => {
    const { service, library } = setup();
    const { catalog } = await listed(service);
    const oswald = catalog.find((face) => face.name === 'Oswald');
    utimesSync(
      library.path('English only/Oswald/Oswald-Regular.ttf'),
      1_800_000_000,
      1_800_000_000,
    );

    const outcome = await service.file(oswald?.fileId ?? '');

    expect(outcome.ok && outcome.body.mtimeMs).toBe(1_800_000_000_000);
  });
});

describe('catalog()', () => {
  it('gives the index in the note parser’s shape, after the first build', async () => {
    const { service } = setup();

    const catalog = await service.catalog();

    expect(catalog.faces.map((face) => face.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Outfit Bold',
      'Secular One',
      'Varela Round',
    ]);
    expect(catalog.faces[0]).toEqual({
      name: 'Bellefair',
      family: 'Bellefair',
      weight: 400,
      italic: false,
      file: 'Hebrew + English/Bellefair/Bellefair-Regular.ttf',
      he: true,
    });
  });
});

describe('a change in _Fonts', () => {
  it('goes out as font.changed with the family as the list shows it, and font.removed when it is gone', async () => {
    const { service, library, repo, published, clock, send, source } = setup();
    repo.addUse(use('Outfit', 'job-a'));
    await service.start();
    expect(source.starts).toBe(1);
    // Starting is the baseline: it tells nobody.
    expect(published).toEqual([]);

    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    library.putFixture('Hebrew + English/Bellefair/Bellefair-Copy.ttf', 'Bellefair-Regular.ttf');
    send('add', 'English only/Outfit/Outfit-Bold.woff');
    send('add', 'Hebrew + English/Bellefair/Bellefair-Copy.ttf');
    expect(clock.pending()).toBe(1);
    clock.fire();
    // The refresh is asynchronous: wait for it to tell.
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    expect(published.map((event) => event.type)).toEqual(['font.changed', 'font.changed']);
    const outfit = published.find(
      (event) => event.type === 'font.changed' && event.family.slug === 'outfit',
    );
    expect(outfit).toMatchObject({ family: { name: 'Outfit', used: 1, usedLabel: '1 job' } });
    expect(
      published.find((event) => event.type === 'font.changed' && event.family.name === 'Bellefair'),
    ).toBeDefined();

    published.length = 0;
    library.remove('English only/Oswald/Oswald-Regular.ttf');
    send('unlink', 'English only/Oswald/Oswald-Regular.ttf');
    clock.fire();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    expect(published).toEqual([{ type: 'font.removed', slug: 'oswald' }]);
  });

  it('is told once for a burst of events', async () => {
    const { service, library, published, clock, send } = setup();
    await service.start();

    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    for (let i = 0; i < 5; i += 1) send('change', 'English only/Outfit/Outfit-Bold.woff');
    expect(clock.pending()).toBe(1);
    clock.fire();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    expect(published).toHaveLength(1);
  });
});

/** A font file with a family and a style, English only. */
function font(family: string, style = 'Regular', weight = 400): Buffer {
  return buildFont({ id1: family, id2: style, id16: family, id17: style, weightClass: weight });
}

describe('C46: a font that arrives in _Fonts answers the notes that asked for it', () => {
  /** Copies Gotham Regular and Bold into `_Fonts` as Finder would, and lets the watcher hear it. */
  async function dropGotham(context: ReturnType<typeof setup>, published = context.published) {
    const { library, clock, send } = context;
    library.put('English only/Gotham/Gotham-Regular.ttf', font('Gotham'));
    library.put('English only/Gotham/Gotham-Bold.ttf', font('Gotham', 'Bold', 700));
    send('add', 'English only/Gotham/Gotham-Regular.ttf');
    send('add', 'English only/Gotham/Gotham-Bold.ttf');
    clock.fire();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
  }

  const requestNames = async (service: FontService) =>
    (await listed(service)).requests.map((request) => request.name).sort();

  it('settles the request for a face the watcher sees, and the list no longer returns it', async () => {
    const context = setup();
    const { service, repo, published } = context;
    repo.addRequest('Gotham Bold', 'job-a', 1, NOW.toISOString());
    repo.addRequest('gotham', 'job-b', 0, NOW.toISOString());
    await service.start();
    expect(await requestNames(service)).toEqual(['Gotham Bold', 'gotham']);
    const resolving = vi.spyOn(repo, 'resolveRequests');

    await dropGotham(context);

    expect(await requestNames(service)).toEqual([]);
    expect(repo.openRequests(0)).toEqual([]);
    // The family's name and the face's, once each, in one go.
    expect(resolving.mock.calls.map(([name]) => name)).toEqual(['Gotham', 'Gotham Bold']);
    // The page hears about the family once, after the requests were settled.
    expect(published).toMatchObject([{ type: 'font.changed', family: { name: 'Gotham' } }]);
  });

  it('leaves open a request for a name that did not arrive', async () => {
    const context = setup();
    const { service, repo } = context;
    repo.addRequest('Gotham Bold', 'job-a', 1, NOW.toISOString());
    repo.addRequest('Gotham Thin', 'job-a', 1, NOW.toISOString());
    repo.addRequest('Proxima Nova', 'job-b', 0, NOW.toISOString());
    await service.start();

    await dropGotham(context);

    expect(await requestNames(service)).toEqual(['Gotham Thin', 'Proxima Nova']);
    expect(
      repo
        .openRequests(0)
        .map((request) => request.name)
        .sort(),
    ).toEqual(['Gotham Thin', 'Proxima Nova']);
  });

  it('settles the request for the face a family gains, not for the family it had', async () => {
    const context = setup();
    const { service, repo, library, clock, send, published } = context;
    repo.addRequest('Outfit Light', 'job-a', 1, NOW.toISOString());
    repo.addRequest('Outfit Thin', 'job-a', 1, NOW.toISOString());
    await service.start();
    const resolving = vi.spyOn(repo, 'resolveRequests');

    library.put('English only/Outfit/Outfit-Light.ttf', font('Outfit', 'Light', 300));
    send('add', 'English only/Outfit/Outfit-Light.ttf');
    clock.fire();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    expect(resolving.mock.calls.map(([name]) => name)).toEqual(['Outfit Light']);
    expect(await requestNames(service)).toEqual(['Outfit Thin']);
  });

  it('never settles a request because of a font that was already there', async () => {
    const context = setup();
    const { service, repo, library, clock, send, published } = context;
    // A request for a name the library already has (made by a run that read an old catalog).
    repo.addRequest('Outfit Bold', 'job-a', 1, NOW.toISOString());
    await service.start();
    const resolving = vi.spyOn(repo, 'resolveRequests');

    // A copy of Outfit Bold: the family changes (a file more), but no name is new.
    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    send('add', 'English only/Outfit/Outfit-Bold.woff');
    clock.fire();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    expect(published).toMatchObject([{ type: 'font.changed', family: { name: 'Outfit' } }]);
    expect(resolving).not.toHaveBeenCalled();
    expect(await requestNames(service)).toEqual(['Outfit Bold']);
  });

  it('does not settle anything at start-up, whatever is already in the folder', async () => {
    const { service, repo } = setup();
    repo.addRequest('Outfit Bold', 'job-a', 1, NOW.toISOString());
    const resolving = vi.spyOn(repo, 'resolveRequests');

    await service.start();

    expect(resolving).not.toHaveBeenCalled();
    expect(repo.openRequests(0)).toHaveLength(1);
  });

  it('settles quietly while notes cannot name a font (fontsInNotes off), and still tells the page', async () => {
    const context = setup({ usedIn: false });
    const { service, repo, published } = context;
    repo.addRequest('Gotham Bold', 'job-a', 1, NOW.toISOString());
    await service.start();

    await dropGotham(context);

    expect(repo.openRequests(0)).toEqual([]);
    expect(published).toMatchObject([{ type: 'font.changed', family: { name: 'Gotham' } }]);
  });

  it('tells the page and warns, and does not fail, when the requests cannot be settled', async () => {
    const context = setup();
    const { service, repo, published, logger } = context;
    repo.addRequest('Gotham Bold', 'job-a', 1, NOW.toISOString());
    vi.spyOn(repo, 'resolveRequests').mockImplementation(() => {
      throw new Error('database is locked');
    });
    await service.start();

    await dropGotham(context);

    expect(published).toMatchObject([{ type: 'font.changed', family: { name: 'Gotham' } }]);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('start() and stop()', () => {
  it('builds the index, starts one watcher however often it is called, and stop() lets go', async () => {
    const { service, source } = setup();

    await service.start();
    await service.start();
    expect(source.starts).toBe(1);
    expect(await listed(service)).toMatchObject({ families: expect.any(Array) });

    await service.stop();
    expect(source.stops).toBe(1);
  });

  it('starts no watcher when stop() came while the first build was going on', async () => {
    const { service, source } = setup();

    const starting = service.start();
    await service.stop();
    await starting;

    expect(source.starts).toBe(0);
  });

  it('does not throw when the folder cannot be watched', async () => {
    const failing: FontEventSource = {
      start: vi.fn().mockRejectedValue(new Error('no folder')),
      stop: vi.fn(async () => {}),
    };
    const { service, logger } = setup({ watcher: { source: failing } });

    await expect(service.start()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect((await listed(service)).families).toHaveLength(5);
  });
});

describe('dismissRequest() ("Not a font", C52)', () => {
  const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
  const names = async (service: FontService) =>
    (await listed(service)).requests.map((request) => request.name);

  function threeRequests() {
    const made = setup();
    made.repo.addRequest('Falcon', 'job-a', 0, minutes(30));
    made.repo.addRequest('Gotham Bold', 'job-a', 0, minutes(20));
    made.repo.addRequest('Avenir', 'job-b', 0, minutes(10));
    return made;
  }

  async function idOf(service: FontService, name: string): Promise<string> {
    const found = (await listed(service)).requests.find((request) => request.name === name);
    if (found === undefined) throw new Error(`no request for ${name}`);
    return found.id;
  }

  it('dismisses one of three requests: the list returns the other two, and the browsers are told', async () => {
    const { service, published } = threeRequests();
    const id = await idOf(service, 'Falcon');

    const outcome = await service.dismissRequest(id);

    expect(outcome).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(await names(service)).toEqual(['Avenir', 'Gotham Bold']);
    expect(published).toEqual([{ type: 'font.request.dismissed', id }]);
  });

  it('dismisses the newest one too, and the bar moves on to the next', async () => {
    const { service } = threeRequests();

    await service.dismissRequest(await idOf(service, 'Avenir'));
    expect(await names(service)).toEqual(['Gotham Bold', 'Falcon']);
    await service.dismissRequest(await idOf(service, 'Gotham Bold'));
    expect(await names(service)).toEqual(['Falcon']);
  });

  it('takes the job’s other open requests for the same name with it', async () => {
    const { service, repo } = setup();
    repo.addRequest('Falcon', 'job-a', 0, minutes(30));
    repo.addRequest('falcon', 'job-a', 2, minutes(20));
    repo.addRequest('Falcon', 'job-b', 0, minutes(10));

    await service.dismissRequest(await idOf(service, 'falcon'));

    expect((await listed(service)).requests.map((request) => request.jobName)).toEqual([
      'Spring Sale',
    ]);
  });

  it('says the same and tells nobody twice when the request is dismissed already', async () => {
    const { service, published } = threeRequests();
    const id = await idOf(service, 'Falcon');
    await service.dismissRequest(id);

    const again = await service.dismissRequest(id);

    expect(again).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(published).toHaveLength(1);
  });

  it('does not bring the name back for that job in a later round, but does for another job', async () => {
    const { service, repo, published } = threeRequests();
    await service.dismissRequest(await idOf(service, 'Falcon'));
    published.length = 0;

    expect(repo.recordRequest('Falcon', 'job-a', 1).added).toBe(false);
    expect(repo.recordRequest('Falcon', 'job-a', 5).added).toBe(false);
    expect(await names(service)).toEqual(['Avenir', 'Gotham Bold']);

    expect(repo.recordRequest('Falcon', 'job-b', 0).added).toBe(true);
    expect(await names(service)).toContain('Falcon');
  });

  it('refuses a request it does not know with 404, and tells nobody', async () => {
    const { service, published } = threeRequests();

    const outcome = await service.dismissRequest('0123456789ab');

    expect(outcome).toEqual({ ok: false, status: 404, error: FONT_MESSAGES.requestNotFound });
    expect(await service.dismissRequest('not an id')).toEqual(outcome);
    expect(published).toEqual([]);
    expect(await names(service)).toHaveLength(3);
  });

  it('refuses while notes cannot name a font (fontsInNotes off), and leaves the request alone', async () => {
    const { service, repo } = setup({ usedIn: false });
    const request = repo.addRequest('Falcon', 'job-a', 0, minutes(30));

    const outcome = await service.dismissRequest(request.id);

    expect(outcome).toEqual({ ok: false, status: 404, error: FONT_MESSAGES.requestNotFound });
    expect(repo.openRequests(0).map((open) => open.id)).toEqual([request.id]);
  });
});

describe('the service while the switch is off', () => {
  it('starts nothing, knows no font, and refuses the rest like every disabled method', async () => {
    const service = createDisabledFontService();
    expect(await service.dismissRequest('0123456789ab')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.off,
    });

    await expect(service.start()).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();
    expect(await service.catalog()).toEqual({ faces: [] });
    expect(service.enabled).toBe(false);
    expect(await service.list()).toEqual({ ok: false, status: 404, error: FONT_MESSAGES.off });
  });
});
