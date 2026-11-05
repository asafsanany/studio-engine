import { createHash } from 'node:crypto';
import { chmodSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_SLUG_PATTERN } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AppearedFontNames,
  appearedFontNames,
  compareFamilyNames,
  createFontIndex,
  type FontIndex,
  type FontIndexChange,
  fontVersion,
  panoseStyle,
} from './font-index.js';
import { buildFont, fixtureFont } from './font-test-utils.js';
import { resolveNoteFonts } from './font-tokens.js';
import { makeLibrary, makeStandardLibrary, type TempLibrary } from './library/test-utils.js';

// The font index (FN3): the files in `_Fonts` grouped into families by what is inside them. Tests
// copy fixtures/fonts/ (and build small fonts) into a temp inbox, never the real folder.

const libraries: TempLibrary[] = [];
afterEach(() => {
  for (const library of libraries.splice(0)) library.cleanup();
});

const standard = (): TempLibrary => {
  const library = makeStandardLibrary();
  libraries.push(library);
  return library;
};
const empty = (): TempLibrary => {
  const library = makeLibrary();
  libraries.push(library);
  return library;
};

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A font file with a family and a style, English or with the Hebrew letters. */
function font(
  family: string,
  options: { style?: string; weight?: number; hebrew?: boolean; panose?: number[] } = {},
): Buffer {
  const { style = 'Regular', weight = 400, hebrew = false, panose } = options;
  return buildFont({
    id1: family,
    id2: style,
    id16: family,
    id17: style,
    weightClass: weight,
    hebrew,
    ...(panose === undefined ? {} : { panose }),
  });
}

/** A file's modified time set to a whole number of seconds, so it compares exactly. */
function touch(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds);
}

const idOf = (rel: string): string => createHash('sha1').update(rel).digest('hex').slice(0, 12);

function indexOf(
  library: TempLibrary,
  onChange?: (change: FontIndexChange, appeared: AppearedFontNames) => void,
  log = logger(),
): FontIndex {
  return createFontIndex({ dir: library.dir, logger: log, onChange });
}

describe('grouping the files into families', () => {
  it('makes one family per name inside the files, A to Z, with the rest read from the files', async () => {
    const index = indexOf(standard());
    await index.ready();

    const families = index.families();

    expect(families.map((family) => family.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Secular One',
      'Varela Round',
    ]);
    expect(families.map((family) => family.slug)).toEqual([
      'bellefair',
      'oswald',
      'outfit',
      'secular-one',
      'varela-round',
    ]);
    expect(families.map((family) => [family.name, family.he])).toEqual([
      ['Bellefair', true],
      ['Oswald', false],
      ['Outfit', false],
      ['Secular One', true],
      ['Varela Round', true],
    ]);
    expect(families.map((family) => family.style)).toEqual([
      'Serif',
      'Condensed',
      'Sans',
      'Display',
      'Rounded',
    ]);
    expect(index.family('secular-one')?.name).toBe('Secular One');
    expect(index.family('nothing')).toBeUndefined();
  });

  it('gives a family with two weights two faces, one file each', async () => {
    const library = standard();
    const index = indexOf(library);
    await index.ready();

    const outfit = index.family('outfit');

    expect(outfit?.weights).toEqual([400, 700]);
    expect(outfit?.faces.map((face) => [face.name, face.weight, face.italic])).toEqual([
      ['Outfit', 400, false],
      ['Outfit Bold', 700, false],
    ]);
    expect(outfit?.files).toBe(2);
    expect(outfit?.bytes).toBe(47_844 + 48_340);
    expect(outfit?.folder).toBe('English only/Outfit');
    expect(outfit?.paths).toEqual([
      'English only/Outfit/Outfit-Bold.ttf',
      'English only/Outfit/Outfit-Regular.ttf',
    ]);
    const bold = outfit?.faces[1];
    expect(bold).toMatchObject({
      family: 'Outfit',
      fileId: idOf('English only/Outfit/Outfit-Bold.ttf'),
      bytes: 48_340,
      format: 'ttf',
      file: 'English only/Outfit/Outfit-Bold.ttf',
      he: false,
      version: fontVersion(statSync(library.path('English only/Outfit/Outfit-Bold.ttf')).mtimeMs),
    });
  });

  it('says a family has Hebrew only when every face has it', async () => {
    const library = empty();
    library.put('Mixed/Mixed-Regular.ttf', font('Mixed', { hebrew: true }));
    library.put('Mixed/Mixed-Bold.ttf', font('Mixed', { style: 'Bold', weight: 700 }));
    library.put('Both/Both-Regular.ttf', font('Both', { hebrew: true }));
    library.put('Both/Both-Bold.ttf', font('Both', { style: 'Bold', weight: 700, hebrew: true }));
    const index = indexOf(library);
    await index.ready();

    expect(index.family('mixed')?.he).toBe(false);
    expect(index.family('both')?.he).toBe(true);
    // The catalog tells each face's own file.
    expect(
      index
        .catalog()
        .faces.filter((face) => face.family === 'Mixed')
        .map((face) => [face.name, face.he]),
    ).toEqual([
      ['Mixed', true],
      ['Mixed Bold', false],
    ]);
  });

  it('reads the script from the file, not from the folder it sits in', async () => {
    const library = empty();
    library.putFixture('English only/Secular One/SecularOne-Regular.ttf', 'SecularOne-Regular.ttf');
    library.putFixture('Hebrew + English/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    const index = indexOf(library);
    await index.ready();

    expect(index.family('secular-one')?.he).toBe(true);
    expect(index.family('outfit')?.he).toBe(false);
  });

  it('puts a family whose files are in two folders together, with the folder that has most of them', async () => {
    const library = empty();
    library.putFixture('English only/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('Hebrew + English/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    library.putFixture('Hebrew + English/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    const index = indexOf(library);
    await index.ready();

    const outfit = index.family('outfit');

    expect(index.families()).toHaveLength(1);
    expect(outfit?.faces.map((face) => face.name)).toEqual(['Outfit', 'Outfit Bold']);
    expect(outfit?.files).toBe(3);
    expect(outfit?.folder).toBe('Hebrew + English/Outfit');
    // The second file for Outfit Bold gives no face of its own, but the family still has it.
    expect(outfit?.paths).toContain('Hebrew + English/Outfit/Outfit-Bold.woff');
    expect(outfit?.bytes).toBe(
      statSync(library.path('English only/Outfit/Outfit-Regular.ttf')).size +
        statSync(library.path('Hebrew + English/Outfit/Outfit-Bold.ttf')).size +
        statSync(library.path('Hebrew + English/Outfit/Outfit-Bold.woff')).size,
    );
  });

  it('reads files at any depth, and leaves out dot names, partial downloads and other files', async () => {
    const library = empty();
    library.putFixture('a/b/c/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    library.put('.DS_Store', 'x');
    library.putFixture('._Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    library.putFixture('Oswald-Regular.ttf.crdownload', 'Oswald-Regular.ttf');
    library.putFixture('.hidden/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    library.put('licence.txt', 'OFL');
    const index = indexOf(library);
    await index.ready();

    expect(index.families().map((family) => family.name)).toEqual(['Outfit']);
    expect(index.family('outfit')?.files).toBe(2);
  });

  it('puts "Heebo" and "HEEBO" in one family, named as most of its files spell it', async () => {
    const library = empty();
    library.put('H/a.ttf', font('Heebo', { weight: 300, style: 'Light' }));
    library.put('H/b.ttf', font('HEEBO', { weight: 400 }));
    library.put('H/c.ttf', font('Heebo', { weight: 700, style: 'Bold' }));
    const index = indexOf(library);
    await index.ready();

    expect(index.families()).toHaveLength(1);
    expect(index.families()[0]?.name).toBe('Heebo');
    expect(index.families()[0]?.faces.map((face) => face.name)).toEqual([
      'Heebo Light',
      'Heebo',
      'Heebo Bold',
    ]);
  });

  it('orders the families A to Z without regard to case', async () => {
    const library = empty();
    for (const name of ['beta', 'Gamma', 'alpha', 'Delta']) {
      library.put(`${name}/${name}.ttf`, font(name));
    }
    const index = indexOf(library);
    await index.ready();

    expect(index.families().map((family) => family.name)).toEqual([
      'alpha',
      'beta',
      'Delta',
      'Gamma',
    ]);
    expect(['b', 'A', 'c'].sort(compareFamilyNames)).toEqual(['A', 'b', 'c']);
  });

  it('dates a family by the earliest modified time of its files', async () => {
    const library = empty();
    const bold = library.putFixture('Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    const regular = library.putFixture('Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
    touch(bold, 1_700_000_500);
    touch(regular, 1_700_000_100);
    const index = indexOf(library);
    await index.ready();

    expect(index.family('outfit')?.addedAt).toBe(1_700_000_100_000);
  });

  it('turns a variable font into one face per weight, all pointing at the one file', async () => {
    const library = empty();
    library.put(
      'Variable/Var[wght].ttf',
      buildFont({
        id1: 'Variable Test',
        id2: 'Regular',
        id16: 'Variable Test',
        id17: 'Regular',
        weightClass: 400,
        fvar: { axes: [{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }] },
      }),
    );
    const index = indexOf(library);
    await index.ready();

    const family = index.family('variable-test');

    expect(family?.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(family?.faces.map((face) => face.name)).toEqual([
      'Variable Test Thin',
      'Variable Test ExtraLight',
      'Variable Test Light',
      'Variable Test',
      'Variable Test Medium',
      'Variable Test SemiBold',
      'Variable Test Bold',
      'Variable Test ExtraBold',
      'Variable Test Black',
    ]);
    expect(new Set(family?.faces.map((face) => face.fileId))).toEqual(
      new Set([idOf('Variable/Var[wght].ttf')]),
    );
    expect(family?.files).toBe(1);
    expect(family?.bytes).toBe(statSync(library.path('Variable/Var[wght].ttf')).size);
  });

  it('tells italics from upright faces of the same weight', async () => {
    const library = empty();
    library.put('M/r.ttf', font('Merri'));
    library.put(
      'M/i.ttf',
      buildFont({
        id1: 'Merri',
        id2: 'Italic',
        id16: 'Merri',
        id17: 'Italic',
        weightClass: 400,
        italic: true,
      }),
    );
    const index = indexOf(library);
    await index.ready();

    const merri = index.family('merri');

    expect(merri?.faces.map((face) => [face.name, face.italic])).toEqual([
      ['Merri', false],
      ['Merri Italic', true],
    ]);
    // An italic of the same weight is not another weight.
    expect(merri?.weights).toEqual([400]);
  });

  it('knows nothing of a folder that is not there', async () => {
    const library = empty();
    const index = createFontIndex({ dir: join(library.inbox, 'nowhere'), logger: logger() });

    await index.ready();

    expect(index.families()).toEqual([]);
    expect(index.catalog()).toEqual({ faces: [] });
  });
});

describe('the style of a family', () => {
  it('comes from the table of the known families, whatever the file says', async () => {
    const library = empty();
    library.put('H/Heebo-Regular.ttf', font('Heebo', { panose: [4, 0, 5, 0, 0, 0, 0, 0, 0, 0] }));
    const index = indexOf(library);
    await index.ready();

    expect(index.family('heebo')?.style).toBe('Sans');
  });

  it('is guessed from panose for a family that is not in the table, else Sans', async () => {
    const library = empty();
    library.put('A/a.ttf', font('Hand Maker', { panose: [3, 0, 5, 0, 0, 0, 0, 0, 0, 0] }));
    library.put('B/b.ttf', font('Plain Maker', { panose: [2, 6, 5, 2, 0, 0, 0, 0, 0, 0] }));
    library.put('C/c.ttf', font('No Panose'));
    const index = indexOf(library);
    await index.ready();

    expect(index.family('hand-maker')?.style).toBe('Handwriting');
    expect(index.family('plain-maker')?.style).toBe('Slab');
    expect(index.family('no-panose')?.style).toBe('Sans');
  });

  it('is guessed from the panose numbers one rule at a time', () => {
    expect(panoseStyle(null)).toBeNull();
    expect(panoseStyle([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(panoseStyle([3, 0, 5, 0, 0, 0, 0, 0, 0, 0])).toBe('Handwriting');
    expect(panoseStyle([4, 0, 5, 0, 0, 0, 0, 0, 0, 0])).toBe('Display');
    expect(panoseStyle([5, 0, 5, 0, 0, 0, 0, 0, 0, 0])).toBe('Display');
    expect(panoseStyle([2, 11, 5, 2, 0, 0, 0, 0, 0, 0])).toBe('Sans');
    expect(panoseStyle([2, 15, 5, 2, 0, 0, 0, 0, 0, 0])).toBe('Rounded');
    expect(panoseStyle([2, 2, 5, 3, 0, 0, 0, 0, 0, 0])).toBe('Serif');
    expect(panoseStyle([2, 6, 5, 3, 0, 0, 0, 0, 0, 0])).toBe('Slab');
    expect(panoseStyle([2, 11, 5, 6, 0, 0, 0, 0, 0, 0])).toBe('Condensed');
    expect(panoseStyle([2, 2, 5, 8, 0, 0, 0, 0, 0, 0])).toBe('Condensed');
    expect(panoseStyle([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe('the address (slug) of a family', () => {
  it('keeps two different names that make one slug apart with a number, the first keeping the plain one', async () => {
    const library = empty();
    touch(library.put('A/a.ttf', font('Heebo Sans')), 1_700_000_100);
    touch(library.put('B/b.ttf', font('Heebo-Sans')), 1_700_000_200);
    const index = indexOf(library);
    await index.ready();

    expect(index.families().map((family) => [family.name, family.slug])).toEqual([
      ['Heebo Sans', 'heebo-sans'],
      ['Heebo-Sans', 'heebo-sans-2'],
    ]);
    expect(FONT_SLUG_PATTERN.test('heebo-sans-2')).toBe(true);
  });

  it('never moves a slug a family already has, even when a newcomer is older', async () => {
    const library = empty();
    touch(library.put('A/a.ttf', font('Heebo Sans')), 1_700_000_200);
    touch(library.put('B/b.ttf', font('Heebo-Sans')), 1_700_000_300);
    const index = indexOf(library);
    await index.ready();
    expect(index.family('heebo-sans')?.name).toBe('Heebo Sans');

    // A copy that kept an older time (Finder does) must not take the plain slug.
    touch(library.put('C/c.ttf', font('Heebo.Sans')), 1_600_000_000);
    await index.refresh();

    expect(index.families().map((family) => [family.name, family.slug])).toEqual([
      ['Heebo Sans', 'heebo-sans'],
      ['Heebo-Sans', 'heebo-sans-2'],
      ['Heebo.Sans', 'heebo-sans-3'],
    ]);

    // And when the first goes, the others keep what they had.
    library.remove('A/a.ttf');
    await index.refresh();
    expect(index.families().map((family) => family.slug)).toEqual(['heebo-sans-2', 'heebo-sans-3']);
  });

  it('gives a name with no Latin letters a slug of its own, and keeps long names within the limit', async () => {
    const library = empty();
    library.put('A/a.ttf', font('שלום'));
    library.put('B/b.ttf', font('עולם'));
    const long = 'Very Long Family Name '.repeat(5).trim();
    touch(library.put('C/c.ttf', font(long)), 1_700_000_100);
    touch(library.put('D/d.ttf', font(`${long}!`)), 1_700_000_200);
    const index = indexOf(library);
    await index.ready();

    const slugs = index.families().map((family) => family.slug);

    expect(new Set(slugs).size).toBe(4);
    for (const slug of slugs) expect(FONT_SLUG_PATTERN.test(slug), slug).toBe(true);
    expect(slugs.filter((slug) => slug.startsWith('font-'))).toHaveLength(2);
    expect(slugs.filter((slug) => slug.startsWith('very-long'))).toHaveLength(2);
  });
});

describe('the id of a file', () => {
  it('is a short hash of its path inside _Fonts, found in the index only', async () => {
    const library = standard();
    const index = indexOf(library);
    await index.ready();
    const rel = 'English only/Outfit/Outfit-Bold.ttf';

    const file = index.file(idOf(rel));

    expect(file).toEqual({
      file: rel,
      path: library.path(rel),
      format: 'ttf',
      mtimeMs: Math.trunc(statSync(library.path(rel)).mtimeMs),
      bytes: 48_340,
    });
    expect(index.file('../../etc/passwd')).toBeUndefined();
    expect(index.file(library.path(rel))).toBeUndefined();
    expect(idOf(rel)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('serves a file that gives no face of its own (a repeat of a face)', async () => {
    const library = empty();
    library.putFixture('Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    library.putFixture('Outfit/Outfit-Bold.woff2', 'Outfit-Bold.woff2');
    const index = indexOf(library);
    await index.ready();

    expect(index.family('outfit')?.faces).toHaveLength(1);
    expect(index.family('outfit')?.faces[0]?.file).toBe('Outfit/Outfit-Bold.ttf');
    expect(index.file(idOf('Outfit/Outfit-Bold.woff2'))?.format).toBe('woff2');
  });

  it('is the same after another refresh', async () => {
    const index = indexOf(standard());
    await index.ready();
    const before = index.families().flatMap((family) => family.faces.map((face) => face.fileId));

    await index.refresh();

    expect(index.families().flatMap((family) => family.faces.map((face) => face.fileId))).toEqual(
      before,
    );
  });
});

describe('refresh()', () => {
  it('tells nobody about the first build, then only what differs', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));

    await index.ready();
    expect(changes).toEqual([]);

    const same = await index.refresh();
    expect(same).toEqual({ changed: [], removed: [] });
    expect(changes).toEqual([]);

    library.putFixture('Hebrew + English/Oswald2/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    library.put('English only/Fresh/Fresh-Regular.ttf', font('Fresh Face'));
    await index.refresh();

    // Oswald gets a second file (so it changed), Outfit a repeat of Bold (a file more), Fresh Face is new.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed.map((family) => family.name)).toEqual([
      'Fresh Face',
      'Oswald',
      'Outfit',
    ]);
    expect(changes[0]?.removed).toEqual([]);
  });

  it('C46: tells which family and face names are new, and never a name the library already had', async () => {
    const library = standard();
    const appeared: AppearedFontNames[] = [];
    const index = indexOf(library, (_change, names) => appeared.push(names));
    await index.ready();
    // The first build is the starting point: every name in it is old.
    expect(appeared).toEqual([]);

    // A new family with two faces: its name once, then the faces' names (Regular is the family's).
    library.put('English only/Gotham/Gotham-Regular.ttf', font('Gotham'));
    library.put(
      'English only/Gotham/Gotham-Bold.ttf',
      font('Gotham', { style: 'Bold', weight: 700 }),
    );
    // A repeat of a face the library has, and a new weight for a family it has.
    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');
    library.put(
      'English only/Outfit/Outfit-Light.ttf',
      font('Outfit', { style: 'Light', weight: 300 }),
    );
    await index.refresh();
    expect(appeared).toEqual([['Gotham', 'Gotham Bold', 'Outfit Light']]);

    // A file that is touched is a change but brings no new name; a name that goes and comes back
    // is new again when it comes back.
    touch(library.path('English only/Gotham/Gotham-Bold.ttf'), 1_700_000_000);
    await index.refresh();
    expect(appeared.at(-1)).toEqual([]);
    library.remove('English only/Gotham/Gotham-Bold.ttf');
    await index.refresh();
    expect(appeared.at(-1)).toEqual([]);
    library.put(
      'English only/Gotham/Gotham-Bold.ttf',
      font('Gotham', { style: 'Bold', weight: 700 }),
    );
    await index.refresh();
    expect(appeared.at(-1)).toEqual(['Gotham Bold']);
    expect(appeared).toHaveLength(4);
  });

  it('notices a file that vanished: the family changes, and when the last file goes it is removed', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));
    await index.ready();

    library.remove('English only/Outfit/Outfit-Bold.ttf');
    await index.refresh();

    expect(changes[0]?.changed.map((family) => [family.name, family.weights])).toEqual([
      ['Outfit', [400]],
    ]);
    expect(changes[0]?.removed).toEqual([]);

    library.remove('English only/Outfit/Outfit-Regular.ttf');
    await index.refresh();

    expect(changes[1]).toEqual({ changed: [], removed: ['outfit'] });
    expect(index.family('outfit')).toBeUndefined();
    expect(index.families().map((family) => family.name)).not.toContain('Outfit');
  });

  it('re-reads a replaced file (a new time), and its address changes with it', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));
    const rel = 'English only/Outfit/Outfit-Bold.ttf';
    touch(library.path(rel), 1_700_000_000);
    await index.ready();
    const before = index.family('outfit')?.faces.find((face) => face.weight === 700);
    expect(before?.version).toBe('1700000000000');

    // The same path, another font in it, and a later time.
    library.put(rel, font('Outfit', { style: 'ExtraBold', weight: 800 }));
    touch(library.path(rel), 1_700_000_600);
    await index.refresh();

    const outfit = index.family('outfit');
    expect(outfit?.weights).toEqual([400, 800]);
    expect(outfit?.faces.find((face) => face.weight === 800)).toMatchObject({
      name: 'Outfit ExtraBold',
      fileId: before?.fileId,
      version: '1700000600000',
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed.map((family) => family.name)).toEqual(['Outfit']);
    expect(index.file(before?.fileId ?? '')?.mtimeMs).toBe(1_700_000_600_000);
  });

  it('a file with a new time and the same bytes is a change too (the page must ask for it again)', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));
    const rel = 'Hebrew + English/Secular One/SecularOne-Regular.ttf';
    touch(library.path(rel), 1_700_000_000);
    await index.ready();

    touch(library.path(rel), 1_700_000_900);
    await index.refresh();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed.map((family) => family.name)).toEqual(['Secular One']);
    expect(index.family('secular-one')?.faces[0]?.version).toBe('1700000900000');
  });

  it('reads only the files that are new or changed (a parse cache keyed by path, time and size)', async () => {
    const library = standard();
    const log = logger();
    const index = indexOf(library, undefined, log);
    const rel = 'English only/Outfit/Outfit-Bold.ttf';
    touch(library.path(rel), 1_700_000_000);
    await index.ready();
    const size = statSync(library.path(rel)).size;

    // Garbage of the same size with the same time: the index cannot tell, so it does not read it.
    writeFileSync(library.path(rel), Buffer.alloc(size, 0x41));
    touch(library.path(rel), 1_700_000_000);
    const unchanged = await index.refresh();
    expect(unchanged).toEqual({ changed: [], removed: [] });
    expect(index.family('outfit')?.weights).toEqual([400, 700]);
    expect(log.warn).not.toHaveBeenCalled();

    // A new time: now it is read, and found not to be a font.
    touch(library.path(rel), 1_700_000_100);
    await index.refresh();
    expect(index.family('outfit')?.weights).toEqual([400]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('leaves out a file that is not a font, logs it once, and never throws', async () => {
    const library = standard();
    const log = logger();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change), log);
    library.putFixture('English only/Broken/broken-cut-short.ttf', 'broken-cut-short.ttf');
    library.put('English only/Text/not-a-font.ttf', 'this is a text file');
    library.put('English only/Empty/empty.otf', '');

    await index.ready();
    await index.refresh();
    await index.refresh();

    expect(index.families().map((family) => family.name)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit',
      'Secular One',
      'Varela Round',
    ]);
    // Once per file, not once per refresh; and a bad file is no change.
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn.mock.calls.map((call) => (call[0] as { file: string }).file).sort()).toEqual([
      'English only/Broken/broken-cut-short.ttf',
      'English only/Empty/empty.otf',
      'English only/Text/not-a-font.ttf',
    ]);
    expect(changes).toEqual([]);
  });

  it('brings a file in once it is a font (a copy that was not finished is read again when it grows)', async () => {
    const library = empty();
    const whole = fixtureFont('Outfit-Regular.ttf');
    const log = logger();
    const index = indexOf(library, undefined, log);
    library.put('Outfit/Outfit-Regular.ttf', whole.subarray(0, 1_000));
    await index.ready();
    expect(index.families()).toEqual([]);

    library.put('Outfit/Outfit-Regular.ttf', whole);
    await index.refresh();

    expect(index.families().map((family) => family.name)).toEqual(['Outfit']);
  });

  it('keeps what it had when the folder cannot be listed, and says so', async () => {
    const library = standard();
    const log = logger();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change), log);
    await index.ready();

    // No permission to list it (not "it is not there"): the page must not go empty for that.
    chmodSync(library.dir, 0o000);
    try {
      const result = await index.refresh();
      expect(result).toEqual({ changed: [], removed: [] });
    } finally {
      chmodSync(library.dir, 0o755);
    }

    expect(index.families()).toHaveLength(5);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
  });

  it('empties when the folder is gone altogether (the files are the truth)', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));
    await index.ready();

    rmSync(library.dir, { recursive: true });
    await index.refresh();

    expect(index.families()).toEqual([]);
    expect(changes[0]?.removed).toHaveLength(5);
  });

  it('runs overlapping refreshes one after the other', async () => {
    const library = standard();
    const changes: FontIndexChange[] = [];
    const index = indexOf(library, (change) => changes.push(change));
    await index.ready();
    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');

    const results = await Promise.all([index.refresh(), index.refresh(), index.refresh()]);

    // The first one saw the new file; the others found nothing more to say.
    expect(results.map((result) => result.changed.length)).toEqual([1, 0, 0]);
    expect(changes).toHaveLength(1);
  });

  it('survives a listener that throws', async () => {
    const library = standard();
    const log = logger();
    const index = indexOf(
      library,
      () => {
        throw new Error('boom');
      },
      log,
    );
    await index.ready();
    library.putFixture('English only/Outfit/Outfit-Bold.woff', 'Outfit-Bold.woff');

    await expect(index.refresh()).resolves.toMatchObject({ changed: [{ name: 'Outfit' }] });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('waits for the first build in ready(), however many ask', async () => {
    const index = indexOf(standard());

    await Promise.all([index.ready(), index.ready(), index.refresh()]);

    expect(index.families()).toHaveLength(5);
  });
});

describe('appearedFontNames()', () => {
  it('compares names without regard to case and spaces, once each, family before its faces', async () => {
    const before = standard();
    const after = standard();
    after.put('English only/Gotham/Gotham-Regular.ttf', font('Gotham'));
    after.put(
      'English only/Gotham/Gotham-Bold.ttf',
      font('Gotham', { style: 'Bold', weight: 700 }),
    );
    // The same name in other letters is the name the library had.
    after.put(
      'English only/OUTFIT/Outfit-Black.ttf',
      font('OUTFIT', { style: 'Black', weight: 900 }),
    );
    const first = indexOf(before);
    const second = indexOf(after);
    await first.ready();
    await second.ready();

    expect(appearedFontNames(first.families(), second.families())).toEqual([
      'Gotham',
      'Gotham Bold',
      'Outfit Black',
    ]);
    expect(appearedFontNames(second.families(), first.families())).toEqual([]);
    expect(appearedFontNames(second.families(), second.families())).toEqual([]);
  });
});

describe('catalog()', () => {
  it('gives every face in the shape the note parser wants, with its file inside _Fonts', async () => {
    const index = indexOf(standard());
    await index.ready();

    const { faces } = index.catalog();

    expect(faces).toHaveLength(6);
    expect(faces.find((face) => face.name === 'Outfit Bold')).toEqual({
      name: 'Outfit Bold',
      family: 'Outfit',
      weight: 700,
      italic: false,
      file: 'English only/Outfit/Outfit-Bold.ttf',
      he: false,
    });
    expect(faces.find((face) => face.name === 'Secular One')).toMatchObject({
      file: 'Hebrew + English/Secular One/SecularOne-Regular.ttf',
      he: true,
    });
  });

  it('is what resolveNoteFonts reads a note against', async () => {
    const index = indexOf(standard());
    await index.ready();

    const noted = resolveNoteFonts(
      'The titles in @Secular One and the captions in @outfit bold, maybe @Gotham Bold.',
      index.catalog(),
    );

    expect(noted.fonts.map((found) => [found.face, found.file, found.he])).toEqual([
      ['Secular One', 'Hebrew + English/Secular One/SecularOne-Regular.ttf', true],
      ['Outfit Bold', 'English only/Outfit/Outfit-Bold.ttf', false],
    ]);
    expect(noted.unresolved).toEqual(['Gotham Bold']);
  });
});
