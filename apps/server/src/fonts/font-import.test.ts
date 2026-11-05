import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FONT_LIMITS,
  FONT_MESSAGES,
  type FontStageItem,
  fontConflictMessage,
  fontSameMessage,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontRepository } from '../db/font-repository.js';
import { memoryDb } from '../db/test-utils.js';
import type { FsEvent, Timers } from '../inbox/watcher.js';
import { cleanFolderName, type FontCopy, numberedFontName } from './font-import.js';
import {
  createDisabledFontService,
  createFontService,
  type FontEvent,
  type FontService,
  type FontServiceOptions,
} from './font-service.js';
import { fontStagingRoot, isFontFileName, type ReceivedFontFile } from './font-staging.js';
import { buildFont, fixtureFont } from './font-test-utils.js';
import { makeLibrary, makeStandardLibrary, type TempLibrary } from './library/test-utils.js';

// Import, end to end on a temp inbox (FN4): step 1 stages and judges an upload (new, adds, same,
// conflict, bad), step 3 copies the chosen items into `_Fonts` without ever touching a file that is
// there. Fonts are the fixtures of fixtures/fonts/ and small ones built here. Never the real folder.

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A font file with a family and a style, English or with the Hebrew letters. */
function font(
  family: string,
  options: { style?: string; weight?: number; hebrew?: boolean; italic?: boolean } = {},
): Buffer {
  const { style = 'Regular', weight = 400, hebrew = false, italic = false } = options;
  return buildFont({
    id1: family,
    id2: style,
    id16: family,
    id17: style,
    weightClass: weight,
    hebrew,
    italic,
  });
}

/** A copy of a font file that is not the same file but reads as the same face. */
function changed(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
  return copy;
}

interface Upload {
  name: string;
  data: Uint8Array;
  /** The size on the wire when it is not the data's. */
  bytes?: number;
}

function setup(
  options: Partial<FontServiceOptions> & { library?: TempLibrary; standard?: boolean } = {},
) {
  const { library: given, standard = false, ...rest } = options;
  const library = given ?? (standard ? makeStandardLibrary() : makeLibrary());
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-font-data-'));
  cleanups.push(() => {
    rmSync(dataDir, { recursive: true, force: true });
    library.cleanup();
  });
  const repo = new FontRepository(memoryDb());
  const published: FontEvent[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createFontService({
    repo,
    inboxPath: library.inbox,
    dataDir,
    publish: (event) => published.push(event),
    usedIn: true,
    logger,
    ...rest,
  });
  return { service, library, repo, published, logger, dataDir };
}

/** What an upload route does: a stage folder, each font written in it, then `service.stage`. */
async function stage(service: FontService, uploads: readonly Upload[]) {
  const made = await service.beginStage();
  const files: ReceivedFontFile[] = uploads.map((upload, index) => {
    const path = join(made.dir, `f${index}.upload`);
    const keep =
      isFontFileName(upload.name) &&
      (upload.bytes ?? upload.data.length) <= FONT_LIMITS.fileMaxBytes;
    if (keep) writeFileSync(path, upload.data);
    return { name: upload.name, path, bytes: upload.bytes ?? upload.data.length };
  });
  const outcome = await service.stage(made, files);
  if (!outcome.ok) throw new Error(outcome.error);
  return { stageId: made.stageId, dir: made.dir, items: outcome.body.items };
}

async function importIds(service: FontService, stageId: string, ids: readonly string[]) {
  const outcome = await service.importStaged(stageId, ids);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
}

const summary = (item: FontStageItem) => ({
  name: item.name,
  status: item.status,
  files: item.files,
  weights: item.weights,
  info: item.info,
});

/** Every file and folder under a folder, with '/' between parts, dot names too. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
    }
  };
  walk(dir, '');
  return out;
}

const readStandard = (name: string): Buffer => fixtureFont(name);

describe('stage: a new family', () => {
  it('is one item for the two files of a family, with the size and the script', async () => {
    const { service } = setup();

    const result = await stage(service, [
      { name: 'Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);

    expect(result.stageId).toMatch(/^[0-9a-f]{12}$/);
    expect(result.items).toEqual([
      {
        id: 'i0',
        name: 'Outfit',
        files: 2,
        he: false,
        weights: [400, 700],
        bytes: 47_844 + 48_340,
        status: 'new',
        info: '2 files · English only · 0.1 MB',
      },
    ]);
  });

  it('says Hebrew + English for a font that has the Hebrew letters', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'SecularOne-Regular.ttf', data: readStandard('SecularOne-Regular.ttf') },
    ]);
    expect(summary(result.items[0] as FontStageItem)).toEqual({
      name: 'Secular One',
      status: 'new',
      files: 1,
      weights: [400],
      info: '1 file · Hebrew + English · 0.1 MB',
    });
    expect(result.items[0]?.he).toBe(true);
  });

  it('copies nothing into _Fonts: the library is as it was until the import', async () => {
    const { service, library } = setup();
    await stage(service, [{ name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') }]);
    expect(tree(library.dir)).toEqual([]);
  });

  it('keeps the upload in <data>/font-staging/<stageId>/ under names of its own', async () => {
    const { service, dataDir } = setup();
    const result = await stage(service, [
      { name: 'Fonts/Outfit/Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    expect(result.dir).toBe(join(fontStagingRoot(dataDir), result.stageId));
    expect(tree(result.dir)).toEqual(['f0.upload']);
  });

  it('weighs a family by what is inside, not by its file names or folders', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Fonts/Oswald/Oswald-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Fonts/Outfit/x.ttf', data: readStandard('Oswald-Regular.ttf') },
    ]);
    expect(result.items.map((item) => [item.name, item.files])).toEqual([
      ['Oswald', 1],
      ['Outfit', 1],
    ]);
  });
});

describe('stage: adds, same, conflict', () => {
  it('adds the weights a family does not have yet', async () => {
    const { service } = setup({ standard: true });

    const result = await stage(service, [
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
      { name: 'Outfit-Thin.ttf', data: font('Outfit', { style: 'Thin', weight: 100 }) },
    ]);

    expect(result.items).toHaveLength(1);
    expect(summary(result.items[0] as FontStageItem)).toEqual({
      name: 'Outfit',
      status: 'adds',
      files: 2,
      weights: [100, 300],
      info: 'Adds 2 weights to Outfit.',
    });
  });

  it('writes the family the way the library already does', async () => {
    const { service } = setup({ standard: true });
    const result = await stage(service, [
      { name: 'x.ttf', data: font('OUTFIT', { style: 'Light', weight: 300 }) },
    ]);
    expect(result.items[0]).toMatchObject({
      name: 'Outfit',
      status: 'adds',
      info: 'Adds 1 weight to Outfit.',
    });
  });

  it('skips a family that is all here, byte for byte', async () => {
    const { service } = setup({ standard: true });

    const result = await stage(service, [
      { name: 'a.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'b.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);

    expect(result.items).toEqual([
      {
        id: 'i0',
        name: 'Outfit',
        files: 2,
        he: false,
        weights: [400, 700],
        bytes: 47_844 + 48_340,
        status: 'same',
        info: 'Already here with the same 2 weights. Skipped.',
      },
    ]);
    expect(result.items[0]?.info).toBe(fontSameMessage(2));
  });

  it('says "the same weight" for one', async () => {
    const { service } = setup({ standard: true });
    const result = await stage(service, [{ name: 'a.ttf', data: readStandard('Outfit-Bold.ttf') }]);
    expect(result.items[0]).toMatchObject({
      status: 'same',
      info: 'Already here with the same weight. Skipped.',
    });
  });

  it('knows a file is here by its bytes, wherever it is filed and whatever it is called', async () => {
    const library = makeLibrary();
    library.putFixture('Somewhere else/Deep/copy-of-bold.ttf', 'Outfit-Bold.ttf');
    const { service } = setup({ library });
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    expect(result.items[0]).toMatchObject({ name: 'Outfit', status: 'same' });
  });

  it('calls a face that is here as a different file a conflict, and imports the rest of the family', async () => {
    const { service } = setup({ standard: true });

    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: changed(readStandard('Outfit-Bold.ttf')) },
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);

    expect(result.items.map(summary)).toEqual([
      {
        name: 'Outfit',
        status: 'adds',
        files: 1,
        weights: [300],
        info: 'Adds 1 weight to Outfit.',
      },
      {
        name: 'Outfit',
        status: 'conflict',
        files: 1,
        weights: [700],
        info: fontConflictMessage('Outfit Bold'),
      },
    ]);
    expect(result.items[1]?.info).toBe(
      'You already have a different Outfit Bold. Delete it first to replace it.',
    );
  });

  it('is only a conflict when nothing else of the family is new', async () => {
    const { service } = setup({ standard: true });
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: changed(readStandard('Outfit-Bold.ttf')) },
      { name: 'Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
    ]);
    // The Regular is here byte for byte (same, say nothing more), the Bold is not.
    expect(result.items.map((item) => item.status)).toEqual(['same', 'conflict']);
  });

  it('puts several conflicts of one family on one line', async () => {
    const { service } = setup({ standard: true });
    const result = await stage(service, [
      { name: 'a.ttf', data: changed(readStandard('Outfit-Regular.ttf')) },
      { name: 'b.ttf', data: changed(readStandard('Outfit-Bold.ttf')) },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      status: 'conflict',
      files: 2,
      weights: [400, 700],
      info: 'You already have different files for Outfit and Outfit Bold. Delete them first to replace them.',
    });
  });

  it('counts the same bytes twice in one upload once', async () => {
    const { service } = setup();
    const bold = readStandard('Outfit-Bold.ttf');
    const result = await stage(service, [
      { name: 'one/Outfit-Bold.ttf', data: bold },
      { name: 'two/Outfit-Bold.ttf', data: bold },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'new', files: 1 });
  });

  it('names two different files for one face in an upload, and keeps the first', async () => {
    const { service } = setup();
    const bold = readStandard('Outfit-Bold.ttf');
    const result = await stage(service, [
      { name: 'one/Outfit-Bold.ttf', data: bold },
      { name: 'two/Outfit-Bold.ttf', data: changed(bold) },
    ]);
    expect(result.items.map(summary)).toEqual([
      {
        name: 'Outfit',
        status: 'new',
        files: 1,
        weights: [700],
        info: '1 file · English only · 0.1 MB',
      },
      {
        name: 'Outfit',
        status: 'conflict',
        files: 1,
        weights: [700],
        info: 'Two different files in this upload are Outfit Bold. Only the first one is imported.',
      },
    ]);
  });

  it('puts the spellings of one family together under the one most files use', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'a.ttf', data: font('rubik', { style: 'Light', weight: 300 }) },
      { name: 'b.ttf', data: font('Rubik') },
      { name: 'c.ttf', data: font('Rubik', { style: 'Bold', weight: 700 }) },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: 'Rubik', files: 3, weights: [300, 400, 700] });
  });

  it('turns a mixed folder of two families into two items, A to Z', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Pack/Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Pack/Oswald-Regular.ttf', data: readStandard('Oswald-Regular.ttf') },
      { name: 'Pack/Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    expect(result.items.map((item) => [item.id, item.name, item.files])).toEqual([
      ['i0', 'Oswald', 1],
      ['i1', 'Outfit', 2],
    ]);
  });

  it('reads a font the owner dropped into _Fonts by hand a moment ago', async () => {
    const { service, library } = setup();
    await service.list(); // the index has seen an empty folder
    library.putFixture('Dropped/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    expect(result.items[0]).toMatchObject({ status: 'same' });
  });

  it('answers an upload with nothing to check with no items, and keeps the stage for the page to delete', async () => {
    const { service } = setup();
    const result = await stage(service, []);
    expect(result.items).toEqual([]);
    expect(existsSync(result.dir)).toBe(true);
    expect((await service.cancelStage(result.stageId)).ok).toBe(true);
  });

  it('weighs a variable font by the weights it stands for', async () => {
    const variable = buildFont({
      id1: 'Outfit',
      id2: 'Regular',
      id16: 'Outfit',
      id17: 'Regular',
      fvar: { axes: [{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }] },
    });
    const empty = setup();
    const fresh = await stage(empty.service, [{ name: 'Outfit[wght].ttf', data: variable }]);
    expect(fresh.items[0]).toMatchObject({
      status: 'new',
      files: 1,
      weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    });

    // Outfit Regular is here as another file: the variable file is not a new weight.
    const full = setup({ standard: true });
    const clash = await stage(full.service, [{ name: 'Outfit[wght].ttf', data: variable }]);
    expect(clash.items[0]).toMatchObject({
      status: 'conflict',
      info: fontConflictMessage('Outfit'),
    });
  });
});

describe('stage: bad files', () => {
  it('names a file that is cut short, with the reader’s sentence', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Fonts/Broken export.ttf', data: readStandard('broken-cut-short.ttf') },
    ]);
    expect(result.items).toEqual([
      {
        id: 'i0',
        name: 'Broken export.ttf',
        files: 1,
        he: false,
        weights: [],
        bytes: 2048,
        status: 'bad',
        info: 'Not a font: the file is cut short.',
      },
    ]);
  });

  it('names a file with the wrong first bytes, a collection, a lone text file and a font that is too big', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'fake.ttf', data: Buffer.from('hello world, this is not a font at all') },
      { name: 'Pack/Helvetica.ttc', data: Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(60)]) },
      { name: 'notes.txt', data: Buffer.from('hello') },
      { name: 'Huge.ttf', data: new Uint8Array(0), bytes: FONT_LIMITS.fileMaxBytes + 1 },
    ]);
    expect(result.items.map((item) => [item.name, item.status, item.info])).toEqual([
      ['fake.ttf', 'bad', 'Not a font: it does not start like a font file.'],
      [
        'Helvetica.ttc',
        'bad',
        'A font collection (.ttc) holds several fonts in one file. Export them one by one.',
      ],
      ['notes.txt', 'bad', 'Not a font: only .ttf, .otf, .woff and .woff2 files.'],
      ['Huge.ttf', 'bad', 'Too big: over 30 MB.'],
    ]);
    expect(result.items.map((item) => item.bytes)).toEqual([
      38,
      64,
      5,
      FONT_LIMITS.fileMaxBytes + 1,
    ]);
  });

  it('puts bad files after the families, in the order they came, and one does not hide the others', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'a-broken.ttf', data: readStandard('broken-cut-short.ttf') },
      { name: 'Oswald-Regular.ttf', data: readStandard('Oswald-Regular.ttf') },
      { name: 'b-broken.otf', data: readStandard('broken-cut-short.ttf') },
    ]);
    expect(result.items.map((item) => [item.name, item.status])).toEqual([
      ['Oswald', 'new'],
      ['a-broken.ttf', 'bad'],
      ['b-broken.otf', 'bad'],
    ]);
  });

  it('reads a woff and a woff2 like a ttf', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Bold.woff', data: readStandard('Outfit-Bold.woff') },
    ]);
    expect(result.items[0]).toMatchObject({ name: 'Outfit', status: 'new', weights: [700] });
    const woff2 = await stage(service, [
      { name: 'Outfit-Bold.woff2', data: readStandard('Outfit-Bold.woff2') },
    ]);
    expect(woff2.items[0]).toMatchObject({ name: 'Outfit', status: 'new', weights: [700] });
  });
});

describe('import', () => {
  it('copies a new family into _Fonts/English only/<Family>/ with the names it came with', async () => {
    const { service, library, published } = setup();
    const result = await stage(service, [
      { name: 'Pack/Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Pack/Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);

    const done = await importIds(service, result.stageId, ['i0']);

    expect(done.status).toBe(201);
    expect(done.body.failed).toEqual([]);
    expect(done.body.imported).toHaveLength(1);
    expect(done.body.imported[0]).toMatchObject({
      slug: 'outfit',
      name: 'Outfit',
      he: false,
      weights: [400, 700],
      isNew: true,
    });
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Outfit/',
      'English only/Outfit/Outfit-Bold.ttf',
      'English only/Outfit/Outfit-Regular.ttf',
    ]);
    expect(readFileSync(library.path('English only/Outfit/Outfit-Bold.ttf'))).toEqual(
      readStandard('Outfit-Bold.ttf'),
    );
    expect(published).toContainEqual(
      expect.objectContaining({
        type: 'font.changed',
        family: expect.objectContaining({ slug: 'outfit', weights: [400, 700] }),
      }),
    );
  });

  it('files a font with the Hebrew letters under Hebrew + English', async () => {
    const { service, library } = setup();
    const result = await stage(service, [
      { name: 'SecularOne-Regular.ttf', data: readStandard('SecularOne-Regular.ttf') },
    ]);
    const done = await importIds(service, result.stageId, ['i0']);
    expect(done.body.imported[0]).toMatchObject({ name: 'Secular One', he: true });
    expect(tree(library.dir)).toEqual([
      'Hebrew + English/',
      'Hebrew + English/Secular One/',
      'Hebrew + English/Secular One/SecularOne-Regular.ttf',
    ]);
  });

  it('answers the families as the list shows them, and the list has them', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    const done = await importIds(service, result.stageId, ['i0']);
    const listed = await service.list();
    expect(listed.ok && listed.body.families).toEqual(done.body.imported);
  });

  it('puts the weights an existing family gains in the folder it already has, wherever that is', async () => {
    const library = makeLibrary();
    library.putFixture('Old filing/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('Old filing/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    const { service } = setup({ library });
    const result = await stage(service, [
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);
    expect(result.items[0]?.status).toBe('adds');

    const done = await importIds(service, result.stageId, ['i0']);

    expect(done.body.imported[0]).toMatchObject({ slug: 'outfit', weights: [300, 400, 700] });
    expect(tree(library.dir)).toEqual([
      'Old filing/',
      'Old filing/Outfit/',
      'Old filing/Outfit/Outfit-Bold.ttf',
      'Old filing/Outfit/Outfit-Light.ttf',
      'Old filing/Outfit/Outfit-Regular.ttf',
    ]);
  });

  it('puts them in _Fonts itself when that is where the family’s files are', async () => {
    const library = makeLibrary();
    library.putFixture('Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    const { service } = setup({ library });
    const result = await stage(service, [
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);
    await importIds(service, result.stageId, ['i0']);
    expect(tree(library.dir)).toEqual(['Outfit-Light.ttf', 'Outfit-Regular.ttf']);
  });

  it('gives a name taken by a different file " (2)" before the extension, then " (3)"', async () => {
    const { service, library } = setup({ standard: true });
    const first = await stage(service, [
      // Light, under the name Outfit's Bold already has in its folder
      { name: 'Outfit-Bold.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);
    await importIds(service, first.stageId, ['i0']);
    const second = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: font('Outfit', { style: 'Thin', weight: 100 }) },
    ]);
    await importIds(service, second.stageId, ['i0']);

    expect(tree(library.path('English only/Outfit'))).toEqual([
      'Outfit-Bold (2).ttf',
      'Outfit-Bold (3).ttf',
      'Outfit-Bold.ttf',
      'Outfit-Regular.ttf',
    ]);
    // The file that was there is untouched.
    expect(readFileSync(library.path('English only/Outfit/Outfit-Bold.ttf'))).toEqual(
      readStandard('Outfit-Bold.ttf'),
    );
    const listed = await service.list();
    expect(listed.ok && listed.body.families.find((f) => f.slug === 'outfit')?.weights).toEqual([
      100, 300, 400, 700,
    ]);
  });

  it('never replaces a file: a conflict is left out and the rest still goes in', async () => {
    const { service, library } = setup({ standard: true });
    const bold = changed(readStandard('Outfit-Bold.ttf'));
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: bold },
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);

    const done = await importIds(service, result.stageId, ['i0']);

    expect(done.body.failed).toEqual([]);
    expect(readFileSync(library.path('English only/Outfit/Outfit-Bold.ttf'))).toEqual(
      readStandard('Outfit-Bold.ttf'),
    );
    expect(tree(library.path('English only/Outfit'))).toEqual([
      'Outfit-Bold.ttf',
      'Outfit-Light.ttf',
      'Outfit-Regular.ttf',
    ]);
  });

  it('imports only the items it is told to, and the stage goes when nothing is left to retry', async () => {
    const { service, library, dataDir } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Oswald-Regular.ttf', data: readStandard('Oswald-Regular.ttf') },
    ]);
    expect(result.items.map((item) => item.name)).toEqual(['Oswald', 'Outfit']);

    const done = await importIds(service, result.stageId, ['i1']);

    expect(done.body.imported.map((family) => family.name)).toEqual(['Outfit']);
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Outfit/',
      'English only/Outfit/Outfit-Regular.ttf',
    ]);
    expect(existsSync(result.dir)).toBe(false);
    expect(readdirSync(fontStagingRoot(dataDir))).toEqual([]);
    const again = await service.importStaged(result.stageId, ['i0']);
    expect(again).toEqual({ ok: false, status: 404, error: FONT_MESSAGES.stageNotFound });
  });

  it('fails an id the stage does not have, and one that is not new or adds, without stopping the others', async () => {
    const { service, library } = setup({ standard: true });
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') }, // same
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) }, // adds
      { name: 'broken.ttf', data: readStandard('broken-cut-short.ttf') }, // bad
    ]);
    expect(result.items.map((item) => item.status)).toEqual(['adds', 'bad']);

    const done = await importIds(service, result.stageId, ['i1', 'nope', 'i0', 'i0']);

    expect(done.body.imported.map((family) => family.slug)).toEqual(['outfit']);
    expect(done.body.failed).toEqual([
      { id: 'i1', error: FONT_MESSAGES.badImportItem },
      { id: 'nope', error: FONT_MESSAGES.badImportItem },
    ]);
    expect(existsSync(library.path('English only/Outfit/Outfit-Light.ttf'))).toBe(true);
  });

  it('answers 200 with nothing imported when every item failed', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    const done = await importIds(service, result.stageId, ['nope']);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({
      imported: [],
      failed: [{ id: 'nope', error: FONT_MESSAGES.badImportItem }],
    });
  });

  it('settles the notes that asked for the family and for each new face', async () => {
    const { service, repo } = setup();
    const spy = vi.spyOn(repo, 'resolveRequests');
    repo.addRequest('Gotham Bold', 'job-a', 1);
    repo.addRequest('gotham', 'job-b', 0);
    repo.addRequest('Gotham Thin', 'job-b', 1);
    repo.addRequest('Proxima Nova', 'job-c', 1);
    const result = await stage(service, [
      { name: 'Gotham-Regular.ttf', data: font('Gotham') },
      { name: 'Gotham-Bold.ttf', data: font('Gotham', { style: 'Bold', weight: 700 }) },
    ]);
    expect(repo.openRequests(0)).toHaveLength(4);

    await importIds(service, result.stageId, ['i0']);

    expect(spy.mock.calls.map(([name]) => name).sort()).toEqual(['Gotham', 'Gotham Bold']);
    // Gotham and Gotham Bold are in the library now; Gotham Thin and Proxima Nova are not.
    expect(
      repo
        .openRequests(0)
        .map((request) => request.name)
        .sort(),
    ).toEqual(['Gotham Thin', 'Proxima Nova']);
  });

  it('FN16: the banner list no longer holds a request once a family named like it is imported', async () => {
    const { service, repo } = setup({
      jobName: (jobId) => (jobId === 'job-a' ? 'Demo · Horizon FPV' : null),
    });
    repo.addRequest('Gotham Bold', 'job-a', 1);
    const listed = async () => {
      const outcome = await service.list();
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.body.requests.map((request) => [request.name, request.jobName]);
    };
    expect(await listed()).toEqual([['Gotham Bold', 'Demo · Horizon FPV']]);

    const result = await stage(service, [
      { name: 'Gotham-Regular.ttf', data: font('Gotham') },
      { name: 'Gotham-Bold.ttf', data: font('Gotham', { style: 'Bold', weight: 700 }) },
    ]);
    await importIds(service, result.stageId, ['i0']);

    expect(await listed()).toEqual([]);
    expect(repo.openRequests(0)).toEqual([]);
  });

  it('settles the notes for the face an existing family gains', async () => {
    const { service, repo } = setup({ standard: true });
    repo.addRequest('Outfit Light', 'job-a', 1);
    repo.addRequest('Outfit Thin', 'job-a', 1);
    const result = await stage(service, [
      { name: 'Outfit-Light.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
    ]);
    await importIds(service, result.stageId, ['i0']);
    expect(repo.openRequests(0).map((request) => request.name)).toEqual(['Outfit Thin']);
  });

  it('C46: settles each name once and tells the page once, and the watcher that sees the same files later does neither', async () => {
    // A watcher whose events and timers the test drives.
    let emit: (event: FsEvent) => void = () => {};
    let fire: () => void = () => {};
    const timers: Timers = {
      setTimeout(run) {
        fire = run;
        return 1;
      },
      clearTimeout() {
        fire = () => {};
      },
    };
    const source = {
      async start(next: (event: FsEvent) => void) {
        emit = next;
      },
      async stop() {},
    };
    const { service, repo, published, library } = setup({ watcher: { source, timers } });
    await service.start();
    const spy = vi.spyOn(repo, 'resolveRequests');
    repo.addRequest('Gotham Bold', 'job-a', 1);
    repo.addRequest('Gotham', 'job-b', 0);
    const result = await stage(service, [
      { name: 'Gotham-Regular.ttf', data: font('Gotham') },
      { name: 'Gotham-Bold.ttf', data: font('Gotham', { style: 'Bold', weight: 700 }) },
    ]);

    await importIds(service, result.stageId, ['i0']);

    expect(spy.mock.calls.map(([name]) => name)).toEqual(['Gotham', 'Gotham Bold']);
    expect(repo.openRequests(0)).toEqual([]);
    expect(published.map((event) => event.type)).toEqual(['font.changed']);

    // The watcher hears about the files the import placed, and its refresh finds nothing new.
    for (const rel of tree(library.dir).filter((path) => path.endsWith('.ttf'))) {
      emit({ kind: 'add', path: library.path(rel) });
    }
    fire();
    // A refresh of its own, queued behind the watcher's, tells when the watcher's is done.
    await stage(service, []);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(published.map((event) => event.type)).toEqual(['font.changed']);
  });

  it('does not fail an import because the requests could not be settled', async () => {
    const { service, repo, logger } = setup();
    vi.spyOn(repo, 'resolveRequests').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    const done = await importIds(service, result.stageId, ['i0']);
    expect(done.body.imported).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('makes a folder name of the family without the characters a path is made of', async () => {
    const { service, library } = setup();
    const result = await stage(service, [
      { name: 'x.ttf', data: font('AC/DC: Sans\\Bold') },
      { name: 'y.ttf', data: font('.Hidden') },
    ]);
    await importIds(
      service,
      result.stageId,
      result.items.map((item) => item.id),
    );
    expect(
      tree(library.dir).filter((path) => path.split('/').length === 3 && path.endsWith('/')),
    ).toEqual(['English only/AC DC Sans Bold/', 'English only/Hidden/']);
  });

  it('imports two stages of one new family one after the other into the same folder', async () => {
    const { service, library } = setup();
    const a = await stage(service, [{ name: 'a.ttf', data: font('Rubik') }]);
    const b = await stage(service, [
      { name: 'b.ttf', data: font('Rubik', { style: 'Bold', weight: 700 }) },
    ]);
    expect(b.items[0]?.status).toBe('new');

    const [first, second] = await Promise.all([
      importIds(service, a.stageId, ['i0']),
      importIds(service, b.stageId, ['i0']),
    ]);

    expect(first.body.failed).toEqual([]);
    expect(second.body.failed).toEqual([]);
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Rubik/',
      'English only/Rubik/a.ttf',
      'English only/Rubik/b.ttf',
    ]);
  });

  it('looks at the library again at import: a face that has arrived meanwhile is a conflict, not a replacement', async () => {
    const { service, library } = setup();
    const bold = font('Rubik', { style: 'Bold', weight: 700 });
    const a = await stage(service, [{ name: 'a.ttf', data: bold }]);
    const b = await stage(service, [{ name: 'b.ttf', data: changed(bold) }]);
    await importIds(service, a.stageId, ['i0']);

    const done = await importIds(service, b.stageId, ['i0']);

    expect(done.body.imported).toEqual([]);
    expect(done.body.failed).toEqual([{ id: 'i0', error: fontConflictMessage('Rubik Bold') }]);
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Rubik/',
      'English only/Rubik/a.ttf',
    ]);
    // It could still be retried (a delete in between would free the face).
    expect(existsSync(b.dir)).toBe(true);
  });

  it('looks at the library again at import: a file that is here meanwhile is skipped as the same', async () => {
    const { service } = setup();
    const bold = font('Rubik', { style: 'Bold', weight: 700 });
    const a = await stage(service, [{ name: 'a.ttf', data: bold }]);
    const b = await stage(service, [{ name: 'b.ttf', data: bold }]);
    await importIds(service, a.stageId, ['i0']);

    const done = await importIds(service, b.stageId, ['i0']);

    expect(done.body.failed).toEqual([{ id: 'i0', error: fontSameMessage(1) }]);
  });
});

describe('import: a copy that fails', () => {
  /** A copy that writes part of the file and then breaks, on the nth call only. */
  function breakingCopy(breakAt: number): { copy: FontCopy; calls: () => number } {
    let calls = 0;
    const copy: FontCopy = async (from, to) => {
      calls += 1;
      if (calls === breakAt) {
        writeFileSync(to, readFileSync(from).subarray(0, 100));
        throw new Error('disk is full');
      }
      writeFileSync(to, readFileSync(from));
    };
    return { copy, calls: () => calls };
  }

  it('leaves no half file, no temp file and no empty folder, and does not stop the other items', async () => {
    const copy = breakingCopy(2);
    const { service, library, logger } = setup({ copy: copy.copy });
    const result = await stage(service, [
      { name: 'Oswald-Regular.ttf', data: readStandard('Oswald-Regular.ttf') },
      { name: 'Outfit-Regular.ttf', data: readStandard('Outfit-Regular.ttf') },
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    expect(result.items.map((item) => item.name)).toEqual(['Oswald', 'Outfit']);

    const done = await importIds(service, result.stageId, ['i1', 'i0']);

    // Outfit: its first file was placed, the second broke: both are taken back.
    expect(done.body.failed).toEqual([{ id: 'i1', error: FONT_MESSAGES.importFailed }]);
    // Oswald, the item after it, went in whole; nothing of Outfit is left, not even its folders.
    expect(done.body.imported.map((family) => family.name)).toEqual(['Oswald']);
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Oswald/',
      'English only/Oswald/Oswald-Regular.ttf',
    ]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('lets the items after it go in, and keeps the stage with the failed one for a retry', async () => {
    // The first copy (Oswald) breaks; every other works.
    const { service, library } = setup({ copy: breakingCopy(1).copy });
    const result = await stage(service, [
      { name: 'Oswald-Regular.ttf', data: readStandard('Oswald-Regular.ttf') },
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);

    const done = await importIds(service, result.stageId, ['i0', 'i1']);

    expect(done.body.failed).toEqual([{ id: 'i0', error: FONT_MESSAGES.importFailed }]);
    expect(done.body.imported.map((family) => family.name)).toEqual(['Outfit']);
    expect(tree(library.dir)).toEqual([
      'English only/',
      'English only/Outfit/',
      'English only/Outfit/Outfit-Bold.ttf',
    ]);
    // The stage stays, with only what is left.
    expect(existsSync(result.dir)).toBe(true);
    const gone = await service.importStaged(result.stageId, ['i1']);
    expect(gone.ok && gone.body.failed).toEqual([{ id: 'i1', error: FONT_MESSAGES.badImportItem }]);

    // The retry works: Oswald goes in and the stage goes.
    const retry = await importIds(service, result.stageId, ['i0']);
    expect(retry.body.failed).toEqual([]);
    expect(retry.body.imported.map((family) => family.name)).toEqual(['Oswald']);
    expect(existsSync(result.dir)).toBe(false);
    expect(tree(library.dir)).toContain('English only/Oswald/Oswald-Regular.ttf');
  });

  it('takes back what it placed in a folder that was already there, and leaves the rest alone', async () => {
    const copy = breakingCopy(2);
    const { service, library } = setup({ standard: true, copy: copy.copy });
    const before = tree(library.dir);
    const result = await stage(service, [
      { name: 'a.ttf', data: font('Outfit', { style: 'Light', weight: 300 }) },
      { name: 'b.ttf', data: font('Outfit', { style: 'Thin', weight: 100 }) },
    ]);

    const done = await importIds(service, result.stageId, ['i0']);

    expect(done.body.failed).toEqual([{ id: 'i0', error: FONT_MESSAGES.importFailed }]);
    expect(tree(library.dir)).toEqual(before);
    expect(copy.calls()).toBe(2);
  });
});

describe('cancel, the data folder and the switch', () => {
  it('throws a stage away, once', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);

    expect(await service.cancelStage(result.stageId)).toEqual({
      ok: true,
      status: 200,
      body: { ok: true },
    });
    expect(existsSync(result.dir)).toBe(false);
    expect(await service.cancelStage(result.stageId)).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.stageNotFound,
    });
    expect(await service.importStaged(result.stageId, ['i0'])).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.stageNotFound,
    });
  });

  it('does not know a stage id it was never given, or one that tries to leave the folder', async () => {
    const { service } = setup();
    for (const id of ['000000000000', '../..', '']) {
      expect(await service.cancelStage(id)).toMatchObject({ ok: false, status: 404 });
      expect(await service.importStaged(id, ['i0'])).toMatchObject({ ok: false, status: 404 });
    }
  });

  it('forgets a stage whose folder was reaped', async () => {
    const { service } = setup();
    const result = await stage(service, [
      { name: 'Outfit-Bold.ttf', data: readStandard('Outfit-Bold.ttf') },
    ]);
    rmSync(result.dir, { recursive: true });
    expect(await service.importStaged(result.stageId, ['i0'])).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.stageNotFound,
    });
  });

  it('reaps every stage at boot, and the old ones every hour, until it stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const library = makeLibrary();
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-font-data-'));
    cleanups.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      library.cleanup();
    });
    const left = join(fontStagingRoot(dataDir), 'aaaaaaaaaaaa');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'f0.upload'), 'x');
    const service = createFontService({
      repo: new FontRepository(memoryDb()),
      inboxPath: library.inbox,
      dataDir,
      publish: () => {},
      usedIn: false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      watcher: { source: { start: async () => {}, stop: async () => {} } },
    });

    await service.start();
    await vi.waitFor(() => expect(existsSync(left)).toBe(false));

    const old = join(fontStagingRoot(dataDir), 'bbbbbbbbbbbb');
    mkdirSync(old);
    const then = new Date(Date.now() - 2 * FONT_LIMITS.stageLifetimeMs);
    utimesSync(old, then, then);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(existsSync(old)).toBe(false));

    await service.stop();
    mkdirSync(old);
    utimesSync(old, then, then);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(existsSync(old)).toBe(true);
  });

  it('has no stage without a data folder', async () => {
    const { service } = setup({ dataDir: undefined });
    await expect(service.beginStage()).rejects.toThrow('no data folder');
  });

  it('is refused by the disabled service, which makes no folder', async () => {
    const service = createDisabledFontService();
    await expect(service.beginStage()).rejects.toThrow(FONT_MESSAGES.off);
    const off = { ok: false, status: 404, error: FONT_MESSAGES.off };
    expect(await service.stage({ stageId: 'a', dir: '/nowhere' }, [])).toEqual(off);
    expect(await service.cancelStage('a')).toEqual(off);
    expect(await service.importStaged('a', ['i0'])).toEqual(off);
  });
});

describe('the helpers', () => {
  it('names a family’s folder without path characters, dots at the start or control characters', () => {
    expect(cleanFolderName('Heebo')).toBe('Heebo');
    expect(cleanFolderName('  IBM Plex Sans Hebrew ')).toBe('IBM Plex Sans Hebrew');
    expect(cleanFolderName('AC/DC')).toBe('AC DC');
    expect(cleanFolderName('a\\b:c')).toBe('a b c');
    expect(cleanFolderName('.hidden')).toBe('hidden');
    expect(cleanFolderName('..')).toBe('Fonts');
    expect(cleanFolderName('')).toBe('Fonts');
    expect(cleanFolderName('Name.')).toBe('Name');
    expect(cleanFolderName('a\u0000b')).toBe('a b');
    expect(cleanFolderName('אלף בית')).toBe('אלף בית');
    expect(Array.from(cleanFolderName('x'.repeat(300))).length).toBe(100);
  });

  it('numbers a file name before its extension', () => {
    expect(numberedFontName('Heebo-Bold.ttf', 1)).toBe('Heebo-Bold.ttf');
    expect(numberedFontName('Heebo-Bold.ttf', 2)).toBe('Heebo-Bold (2).ttf');
    expect(numberedFontName('Heebo-Bold.TTF', 10)).toBe('Heebo-Bold (10).TTF');
    expect(numberedFontName('Heebo', 3)).toBe('Heebo (3)');
    expect(numberedFontName('a.b.woff2', 2)).toBe('a.b (2).woff2');
  });
});
