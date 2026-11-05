import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  deleteFontResponseSchema,
  FONT_MESSAGES,
  revealFontResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { FontRepository } from '../db/font-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { isRemovableFontFolder } from './font-family-files.js';
import {
  createDisabledFontService,
  createFontService,
  type FontEvent,
  type FontService,
} from './font-service.js';
import { makeLibrary, makeStandardLibrary, type TempLibrary } from './library/test-utils.js';

// Delete a family and show it in Finder (FN5), on a real temp `_Fonts`, a temp home with its own
// Trash and a fake Finder. Nothing here can reach ~/Studio Inbox/_Fonts or the real Trash.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const OUTFIT_FILES = [
  'English only/Outfit/Outfit-Bold.ttf',
  'English only/Outfit/Outfit-Regular.ttf',
  'English only/Outfit/static/Outfit-Bold.ttf',
];

/** The standard library, with Outfit made three files (the third repeats Bold, in a subfolder). */
function outfitOfThree(): TempLibrary {
  const library = makeStandardLibrary();
  library.putFixture('English only/Outfit/static/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
  return library;
}

function setup(library: TempLibrary = outfitOfThree(), withData = true) {
  const root = mkdtempSync(join(tmpdir(), 'studio-fonts-home-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(join(home, '.Trash'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(
    () => library.cleanup(),
    () => {
      // A test may have taken the permissions away.
      for (const path of [join(home, '.Trash')]) {
        try {
          chmodSync(path, 0o700);
        } catch {
          // gone or a file
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  );
  const published: FontEvent[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const openFolder = vi.fn(async (_path: string) => {});
  const service = createFontService({
    repo: new FontRepository(memoryDb()),
    inboxPath: library.inbox,
    publish: (event) => published.push(event),
    usedIn: false,
    openFolder,
    home,
    ...(withData ? { dataDir } : {}),
    logger,
  });
  const app = createApp({ fonts: true, fontsRoutes: { service } });
  const trash = join(home, '.Trash');
  return { service, library, published, logger, openFolder, home, trash, dataDir, root, app };
}

const names = (dir: string): string[] => readdirSync(dir).sort();

async function familyNames(service: FontService): Promise<string[]> {
  const outcome = await service.list();
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.body.families.map((family) => family.name);
}

describe('remove(slug)', () => {
  it('moves a family of three files to the Trash, takes its folder, tells the browsers once and leaves the others', async () => {
    const { service, library, published, trash } = setup();
    expect((await service.get('outfit')).ok).toBe(true);

    const outcome = await service.remove('outfit');

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, where: join(trash, 'Outfit') },
    });
    // Every file of the family is in one folder of the Trash, the repeated name numbered.
    expect(names(join(trash, 'Outfit'))).toEqual([
      'Outfit-Bold (1).ttf',
      'Outfit-Bold.ttf',
      'Outfit-Regular.ttf',
    ]);
    // Its files, its subfolder and its folder are gone; the parent folder is not.
    for (const rel of OUTFIT_FILES) expect(existsSync(library.path(rel))).toBe(false);
    expect(existsSync(library.path('English only/Outfit'))).toBe(false);
    expect(existsSync(library.path('English only'))).toBe(true);
    // The other families are exactly where they were, and still listed.
    expect(existsSync(library.path('English only/Oswald/Oswald-Regular.ttf'))).toBe(true);
    expect(existsSync(library.path('Hebrew + English/Secular One/SecularOne-Regular.ttf'))).toBe(
      true,
    );
    expect(await familyNames(service)).toEqual([
      'Bellefair',
      'Oswald',
      'Secular One',
      'Varela Round',
    ]);
    // One font.removed, and nothing about anyone else.
    expect(published).toEqual([{ type: 'font.removed', slug: 'outfit' }]);
    expect((await service.get('outfit')).ok).toBe(false);
  });

  it('takes the last family of a folder and keeps the two parent folders', async () => {
    const { service, library, published } = setup();

    expect((await service.remove('outfit')).ok).toBe(true);
    expect((await service.remove('oswald')).ok).toBe(true);

    expect(existsSync(library.path('English only/Oswald'))).toBe(false);
    // "English only" is empty now and stays, so does "Hebrew + English" and `_Fonts` itself.
    expect(existsSync(library.path('English only'))).toBe(true);
    expect(readdirSync(library.path('English only'))).toEqual([]);
    expect(existsSync(library.path('Hebrew + English'))).toBe(true);
    expect(existsSync(library.dir)).toBe(true);
    expect(published).toEqual([
      { type: 'font.removed', slug: 'outfit' },
      { type: 'font.removed', slug: 'oswald' },
    ]);
  });

  it('never removes a parent folder even when the family lies directly in it', async () => {
    const library = makeLibrary();
    library.putFixture('English only/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    library.putFixture('Hebrew + English/Bellefair-Regular.ttf', 'Bellefair-Regular.ttf');
    const { service, trash } = setup(library);

    const outcome = await service.remove('oswald');

    expect(outcome).toMatchObject({ ok: true, body: { where: join(trash, 'Oswald') } });
    expect(readdirSync(library.path('English only'))).toEqual([]);
    expect(existsSync(library.path('Hebrew + English/Bellefair-Regular.ttf'))).toBe(true);
  });

  it('never touches `_Fonts` itself when the family lies directly in it', async () => {
    const library = makeLibrary();
    library.putFixture('Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    library.putFixture('Loose/Bellefair-Regular.ttf', 'Bellefair-Regular.ttf');
    const { service } = setup(library);

    expect((await service.remove('oswald')).ok).toBe(true);

    expect(existsSync(library.dir)).toBe(true);
    expect(existsSync(library.path('Oswald-Regular.ttf'))).toBe(false);
    // A folder of the owner's own outside the family stays too.
    expect(existsSync(library.path('Loose/Bellefair-Regular.ttf'))).toBe(true);
  });

  it('removes a folder with only Finder’s .DS_Store left in it', async () => {
    const { service, library } = setup();
    library.put('English only/Oswald/.DS_Store', 'finder');

    expect((await service.remove('oswald')).ok).toBe(true);

    expect(existsSync(library.path('English only/Oswald'))).toBe(false);
  });

  it('keeps the folder, and what is in it, when it holds anything that is not the family’s', async () => {
    const { service, library } = setup();
    library.put('English only/Outfit/LICENSE.txt', 'OFL');

    expect((await service.remove('outfit')).ok).toBe(true);

    expect(existsSync(library.path('English only/Outfit/Outfit-Regular.ttf'))).toBe(false);
    expect(existsSync(library.path('English only/Outfit/static'))).toBe(false);
    expect(readdirSync(library.path('English only/Outfit'))).toEqual(['LICENSE.txt']);
  });

  it('keeps a folder another family shares', async () => {
    const library = makeLibrary();
    library.putFixture('Mixed/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('Mixed/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    const { service } = setup(library);

    expect((await service.remove('outfit')).ok).toBe(true);

    expect(readdirSync(library.path('Mixed'))).toEqual(['Oswald-Regular.ttf']);
    expect(await familyNames(service)).toEqual(['Oswald']);
  });

  it('leaves a folder of the family’s that lies outside its own folder, and clears nothing above it', async () => {
    const library = makeLibrary();
    library.putFixture('English only/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    library.putFixture('Old/Fonts/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    const { service } = setup(library);

    expect((await service.remove('outfit')).ok).toBe(true);

    // Its own folder is gone; the stray copy went, its empty folders are not the family's folder.
    expect(existsSync(library.path('English only/Outfit'))).toBe(false);
    expect(existsSync(library.path('Old/Fonts/Outfit-Bold.ttf'))).toBe(false);
    expect(existsSync(library.path('Old/Fonts'))).toBe(true);
  });

  it('answers 404 with the message for an unknown family and touches nothing', async () => {
    const { service, library, published, trash } = setup();

    for (const slug of ['gotham', 'outfit-2', '', '..', '../Outfit', 'English only/Outfit']) {
      expect(await service.remove(slug), slug).toEqual({
        ok: false,
        status: 404,
        error: FONT_MESSAGES.notFound,
      });
    }

    for (const rel of OUTFIT_FILES) expect(existsSync(library.path(rel))).toBe(true);
    expect(readdirSync(trash)).toEqual([]);
    expect(published).toEqual([]);
  });

  it('takes a file dropped into the family’s folder a moment ago, before the index heard of it', async () => {
    const { service, library, published, trash } = setup();
    expect((await service.get('outfit')).ok).toBe(true);
    library.putFixture('English only/Outfit/Outfit-Late.ttf', 'Outfit-Bold.ttf');

    const outcome = await service.remove('outfit');

    expect(outcome.ok).toBe(true);
    expect(names(join(trash, 'Outfit'))).toContain('Outfit-Late.ttf');
    expect(existsSync(library.path('English only/Outfit'))).toBe(false);
    // The look at the folder first finds the newcomer (the family changed), then it is all gone.
    expect(published.map((event) => event.type)).toEqual(['font.changed', 'font.removed']);
    expect(published.at(-1)).toEqual({ type: 'font.removed', slug: 'outfit' });
  });

  it('answers the second of two deletes of one family with 404, and tells once', async () => {
    const { service, published, trash } = setup();

    const [first, second] = await Promise.all([service.remove('outfit'), service.remove('outfit')]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, status: 404, error: FONT_MESSAGES.notFound });
    expect(published).toEqual([{ type: 'font.removed', slug: 'outfit' }]);
    expect(readdirSync(trash)).toEqual(['Outfit']);
  });

  it('numbers the Trash folder when the Trash already has a Outfit, as Finder does', async () => {
    const { service, trash } = setup();
    mkdirSync(join(trash, 'Outfit'));
    writeFileSync(join(trash, 'Outfit', 'old.ttf'), 'an earlier delete');

    const outcome = await service.remove('outfit');

    expect(outcome).toMatchObject({ ok: true, body: { where: join(trash, 'Outfit 2') } });
    expect(names(join(trash, 'Outfit'))).toEqual(['old.ttf']);
  });

  it('leaves the jobs’ own copies of the font alone', async () => {
    const { service, library } = setup();
    const copy = join(
      library.inbox,
      'Acme',
      'Spring Sale',
      'edit',
      'fonts',
      'English only',
      'Outfit',
      'Outfit-Bold.ttf',
    );
    mkdirSync(join(copy, '..'), { recursive: true });
    writeFileSync(copy, 'the job’s copy');

    expect((await service.remove('outfit')).ok).toBe(true);

    expect(existsSync(copy)).toBe(true);
  });

  it('keeps the files aside in the data folder when the Trash will not take them', async () => {
    const { service, library, published, trash, dataDir, logger } = setup();
    rmSync(trash, { recursive: true });
    writeFileSync(trash, 'not a folder');

    const outcome = await service.remove('outfit');

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, where: join(dataDir, 'deleted-fonts', 'Outfit') },
    });
    expect(names(join(dataDir, 'deleted-fonts', 'Outfit'))).toHaveLength(3);
    expect(existsSync(library.path('English only/Outfit'))).toBe(false);
    expect(published).toEqual([{ type: 'font.removed', slug: 'outfit' }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses with the plain message, moving nothing, when nothing can take the files', async () => {
    const { service, library, published, trash, logger } = setup(outfitOfThree(), false);
    rmSync(trash, { recursive: true });
    writeFileSync(trash, 'not a folder');

    const outcome = await service.remove('outfit');

    expect(outcome).toEqual({ ok: false, status: 500, error: FONT_MESSAGES.deleteFailed });
    for (const rel of OUTFIT_FILES) expect(existsSync(library.path(rel))).toBe(true);
    expect(published).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
    expect(await familyNames(service)).toContain('Outfit');
  });

  it('is answered 404 "Fonts are off." by the disabled service, which touches nothing', async () => {
    const library = outfitOfThree();
    cleanups.push(() => library.cleanup());
    const service = createDisabledFontService();

    expect(await service.remove('outfit')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.off,
    });
    expect(await service.reveal('outfit')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.off,
    });
    for (const rel of OUTFIT_FILES) expect(existsSync(library.path(rel))).toBe(true);
  });
});

describe('reveal(slug)', () => {
  it('asks Finder to show the family’s folder', async () => {
    const { service, library, openFolder } = setup();

    const outcome = await service.reveal('outfit');

    expect(outcome).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledWith(library.path('English only/Outfit'));
  });

  it('shows the folder that holds most of a family’s files', async () => {
    const library = makeLibrary();
    library.putFixture('Old/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    library.putFixture('New/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('New/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    const { service, openFolder } = setup(library);

    await service.reveal('outfit');

    expect(openFolder).toHaveBeenCalledWith(library.path('New'));
  });

  it('shows the file itself when the family lies directly in `_Fonts`, which is no folder of its own', async () => {
    const library = makeLibrary();
    library.putFixture('Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    const { service, openFolder } = setup(library);

    expect((await service.reveal('oswald')).ok).toBe(true);

    expect(openFolder).toHaveBeenCalledWith(library.path('Oswald-Regular.ttf'));
  });

  it('answers 404 for an unknown family without opening Finder', async () => {
    const { service, openFolder } = setup();

    expect(await service.reveal('gotham')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.notFound,
    });
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('answers 500 with the plain message when Finder cannot be asked', async () => {
    const { service, openFolder, logger } = setup();
    openFolder.mockRejectedValueOnce(new Error('open: no such app'));

    expect(await service.reveal('outfit')).toEqual({
      ok: false,
      status: 500,
      error: FONT_MESSAGES.revealFailed,
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('answers 404 "files are not in _Fonts" when the folder went away since the index looked, and lets the page catch up', async () => {
    const { service, library, openFolder, published } = setup();
    expect((await service.get('oswald')).ok).toBe(true);
    rmSync(library.path('English only/Oswald'), { recursive: true });

    expect(await service.reveal('oswald')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.fileMissing,
    });
    expect(openFolder).not.toHaveBeenCalled();
    expect(published).toEqual([{ type: 'font.removed', slug: 'oswald' }]);
  });
});

describe('the routes', () => {
  it('DELETE /api/fonts/:slug answers { ok, where } and the family is gone from the list', async () => {
    const { app, trash, published } = setup();

    const res = await app.request('/api/fonts/outfit', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(deleteFontResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      where: join(trash, 'Outfit'),
    });
    const list = (await (await app.request('/api/fonts')).json()) as {
      families: Array<{ slug: string }>;
    };
    expect(list.families.map((family) => family.slug)).not.toContain('outfit');
    expect(published).toEqual([{ type: 'font.removed', slug: 'outfit' }]);
  });

  it('DELETE of an unknown family answers 404 with the message', async () => {
    const { app } = setup();

    const res = await app.request('/api/fonts/gotham', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.notFound });
  });

  it('a slug that spells a path deletes nothing', async () => {
    const { app, library } = setup();

    const res = await app.request(`/api/fonts/${encodeURIComponent('../_Fonts')}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(existsSync(library.path('English only/Oswald/Oswald-Regular.ttf'))).toBe(true);
  });

  it('POST /api/fonts/:slug/reveal answers { ok: true } and opens the folder', async () => {
    const { app, library, openFolder } = setup();

    const res = await app.request('/api/fonts/oswald/reveal', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(revealFontResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(openFolder).toHaveBeenCalledWith(library.path('English only/Oswald'));
  });

  it('POST reveal of an unknown family answers 404 with the message', async () => {
    const { app } = setup();

    const res = await app.request('/api/fonts/gotham/reveal', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.notFound });
  });

  it('both answer 404 "Fonts are off." with the switch off, and never open Finder or move a file', async () => {
    const { service, library, openFolder, trash } = setup();
    const off = createApp({ fonts: false, fontsRoutes: { service } });

    for (const [method, path] of [
      ['DELETE', '/api/fonts/outfit'],
      ['POST', '/api/fonts/outfit/reveal'],
    ] as const) {
      const res = await off.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.off });
    }

    expect(openFolder).not.toHaveBeenCalled();
    expect(readdirSync(trash)).toEqual([]);
    for (const rel of OUTFIT_FILES) expect(existsSync(library.path(rel))).toBe(true);
  });
});

describe('isRemovableFontFolder', () => {
  it('refuses `_Fonts` itself and the two parent folders, however they are spelled', () => {
    expect(isRemovableFontFolder('')).toBe(false);
    expect(isRemovableFontFolder('Hebrew + English')).toBe(false);
    expect(isRemovableFontFolder('English only')).toBe(false);
    expect(isRemovableFontFolder('english  ONLY')).toBe(false);
  });

  it('allows every other folder, and a folder of the same name further down', () => {
    expect(isRemovableFontFolder('Heebo')).toBe(true);
    expect(isRemovableFontFolder('English only/Heebo')).toBe(true);
    expect(isRemovableFontFolder('Heebo/English only')).toBe(true);
    expect(isRemovableFontFolder('Hebrew + English/Heebo/static')).toBe(true);
  });
});
