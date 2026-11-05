import { FONT_LIMITS, FONT_MESSAGES, faceName } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { checkFontFile, type FontInfo, faceWeights, readFont } from './font-reader.js';
import { buildFont, fixtureFont, toWoff, toWoff2 } from './font-test-utils.js';

/** A font that must read: the result without the `ok` narrowing noise. */
function read(bytes: Uint8Array): FontInfo {
  const result = readFont(bytes);
  if (!result.ok) throw new Error(`expected a font, got: ${result.error}`);
  return result;
}

const SENTENCES: string[] = [
  FONT_MESSAGES.cutShort,
  FONT_MESSAGES.notFontFile,
  FONT_MESSAGES.collection,
  FONT_MESSAGES.tooLarge,
  FONT_MESSAGES.badExtension,
];

// The six real fixtures and what fixtures/fonts/README.md says each one is.
const FIXTURES = [
  { file: 'SecularOne-Regular.ttf', family: 'Secular One', weight: 400, he: true },
  { file: 'Bellefair-Regular.ttf', family: 'Bellefair', weight: 400, he: true },
  { file: 'VarelaRound-Regular.ttf', family: 'Varela Round', weight: 400, he: true },
  { file: 'Outfit-Regular.ttf', family: 'Outfit', weight: 400, he: false },
  { file: 'Outfit-Bold.ttf', family: 'Outfit', weight: 700, he: false },
  { file: 'Oswald-Regular.ttf', family: 'Oswald', weight: 400, he: false },
] as const;

describe('readFont: the real fixtures', () => {
  it.each(FIXTURES)('$file is $family $weight, Hebrew $he', ({ file, family, weight, he }) => {
    const font = read(fixtureFont(file));
    expect(font).toMatchObject({
      ok: true,
      family,
      weight,
      he,
      italic: false,
      variable: false,
      axes: null,
      namedInstances: null,
      format: 'ttf',
    });
    expect(font.subfamily).toBe(weight === 700 ? 'Bold' : 'Regular');
  });

  it('names the faces the way the README says', () => {
    const names = FIXTURES.map(({ file }) => {
      const font = read(fixtureFont(file));
      return faceName(font.family, font.weight, font.italic);
    });
    expect(names).toEqual([
      'Secular One',
      'Bellefair',
      'Varela Round',
      'Outfit',
      'Outfit Bold',
      'Oswald',
    ]);
  });

  it('reads the panose numbers of a file that has them, and null for all zeros', () => {
    expect(read(fixtureFont('Bellefair-Regular.ttf')).panose).toEqual([
      0, 0, 5, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(read(fixtureFont('Outfit-Regular.ttf')).panose).toBeNull();
  });
});

describe('readFont: .woff and .woff2', () => {
  const ttf = read(fixtureFont('Outfit-Bold.ttf'));

  it('reads a committed .woff (zlib per table) the same as its .ttf', () => {
    expect(read(fixtureFont('Outfit-Bold.woff'))).toEqual({ ...ttf, format: 'woff' });
  });

  it('reads a committed .woff2 made by a real encoder (glyf transformed) the same as its .ttf', () => {
    expect(read(fixtureFont('Outfit-Bold.woff2'))).toEqual({ ...ttf, format: 'woff2' });
  });

  it('reads a woff and a woff2 made from a Hebrew font, with the Hebrew still found', () => {
    const font = buildFont({ id1: 'Heebo', id2: 'Regular', hebrew: true });
    expect(read(toWoff(font))).toMatchObject({ family: 'Heebo', he: true, format: 'woff' });
    expect(read(toWoff2(font))).toMatchObject({ family: 'Heebo', he: true, format: 'woff2' });
  });
});

describe('checkFontFile: a good file', () => {
  it.each([
    ['SecularOne-Regular.ttf', 'ttf'],
    ['Outfit-Bold.woff', 'woff'],
    ['Outfit-Bold.woff2', 'woff2'],
  ] as const)('accepts %s as %s', (file, format) => {
    expect(checkFontFile(file, fixtureFont(file))).toEqual({ ok: true, format });
  });

  it('judges the format by the first bytes, not the extension, and ignores the case of the extension', () => {
    expect(checkFontFile('LOUD.TTF', fixtureFont('Outfit-Bold.ttf'))).toEqual({
      ok: true,
      format: 'ttf',
    });
    expect(checkFontFile('x.otf', buildFont({ magic: 'OTTO' }))).toEqual({
      ok: true,
      format: 'otf',
    });
    expect(checkFontFile('x.ttf', buildFont({ magic: 'OTTO' }))).toEqual({
      ok: true,
      format: 'otf',
    });
    expect(checkFontFile('x.ttf', buildFont({ magic: 'true' }))).toEqual({
      ok: true,
      format: 'ttf',
    });
  });

  it('accepts a file of exactly 30 MB and refuses one byte more, by the size given or the bytes', () => {
    const font = fixtureFont('Outfit-Bold.ttf');
    expect(checkFontFile('a.ttf', font, FONT_LIMITS.fileMaxBytes)).toEqual({
      ok: true,
      format: 'ttf',
    });
    expect(checkFontFile('a.ttf', font, FONT_LIMITS.fileMaxBytes + 1)).toEqual({
      ok: false,
      error: FONT_MESSAGES.tooLarge,
    });
    // A real over-size buffer (zeros) is refused by size before anything else is looked at.
    expect(checkFontFile('a.ttf', Buffer.alloc(FONT_LIMITS.fileMaxBytes + 1))).toEqual({
      ok: false,
      error: 'Too big: over 30 MB.',
    });
  });
});

describe('checkFontFile: a file that is not a good font', () => {
  const outfit = fixtureFont('Outfit-Bold.ttf');

  it('refuses a broken file that ends before its tables do', () => {
    const broken = fixtureFont('broken-cut-short.ttf');
    expect(checkFontFile('broken-cut-short.ttf', broken)).toEqual({
      ok: false,
      error: 'Not a font: the file is cut short.',
    });
    expect(readFont(broken)).toEqual({ ok: false, error: FONT_MESSAGES.cutShort });
  });

  it('refuses a table directory that runs past the end of the file', () => {
    // 12-byte header + 8 bytes: far fewer than the 16 bytes per table the header promises.
    expect(checkFontFile('a.ttf', outfit.subarray(0, 20)).ok).toBe(false);
    expect(checkFontFile('a.ttf', outfit.subarray(0, 20))).toEqual({
      ok: false,
      error: FONT_MESSAGES.cutShort,
    });
    // Only the four magic bytes.
    expect(checkFontFile('a.ttf', outfit.subarray(0, 4))).toEqual({
      ok: false,
      error: FONT_MESSAGES.cutShort,
    });
  });

  it('refuses a cut-short .woff and .woff2 (directory and body)', () => {
    const woff = fixtureFont('Outfit-Bold.woff');
    const woff2 = fixtureFont('Outfit-Bold.woff2');
    for (const [name, bytes] of [
      ['a.woff', woff.subarray(0, 30)],
      ['a.woff', woff.subarray(0, woff.length - 100)],
      ['a.woff2', woff2.subarray(0, 30)],
      ['a.woff2', woff2.subarray(0, 60)],
      ['a.woff2', woff2.subarray(0, woff2.length - 100)],
    ] as const) {
      expect(checkFontFile(name, bytes)).toEqual({ ok: false, error: FONT_MESSAGES.cutShort });
    }
  });

  it('refuses a font collection with the collection sentence, whatever the extension', () => {
    const ttc = Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(60)]);
    const sentence =
      'A font collection (.ttc) holds several fonts in one file. Export them one by one.';
    expect(checkFontFile('Cambria.ttc', ttc)).toEqual({ ok: false, error: sentence });
    expect(checkFontFile('Cambria.otc', ttc)).toEqual({ ok: false, error: sentence });
    expect(checkFontFile('Cambria.ttf', ttc)).toEqual({ ok: false, error: sentence });
    expect(readFont(ttc)).toEqual({ ok: false, error: sentence });
  });

  it('refuses a wrong magic with "does not start like a font file"', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(300),
    ]);
    const sentence = 'Not a font: it does not start like a font file.';
    expect(checkFontFile('logo.ttf', png)).toEqual({ ok: false, error: sentence });
    expect(checkFontFile('empty.ttf', Buffer.alloc(0))).toEqual({ ok: false, error: sentence });
    expect(checkFontFile('three.otf', Buffer.from([0, 1, 0]))).toEqual({
      ok: false,
      error: sentence,
    });
    expect(readFont(png)).toEqual({ ok: false, error: sentence });
  });

  it('refuses a file that is not one of the four extensions', () => {
    const sentence = 'Not a font: only .ttf, .otf, .woff and .woff2 files.';
    expect(checkFontFile('LICENSE.txt', Buffer.from('SIL OFL'))).toEqual({
      ok: false,
      error: sentence,
    });
    expect(checkFontFile('font.eot', outfit)).toEqual({ ok: false, error: sentence });
    expect(checkFontFile('noextension', outfit)).toEqual({ ok: false, error: sentence });
    // A .ttc that is not a collection is not a font file either.
    expect(checkFontFile('x.ttc', outfit)).toEqual({ ok: false, error: sentence });
  });

  it('refuses a file over 30 MB with "Too big"', () => {
    expect(checkFontFile('huge.ttf', outfit, 31 * 1024 * 1024)).toEqual({
      ok: false,
      error: 'Too big: over 30 MB.',
    });
  });

  it.each(['name', 'cmap', 'OS/2', 'head'])('refuses a font with no %s table', (tag) => {
    const font = buildFont({ id1: 'Plain', id2: 'Regular', omit: [tag] });
    expect(checkFontFile('a.ttf', font)).toEqual({ ok: false, error: FONT_MESSAGES.notFontFile });
    expect(checkFontFile('a.woff', toWoff(font))).toEqual({
      ok: false,
      error: FONT_MESSAGES.notFontFile,
    });
    expect(checkFontFile('a.woff2', toWoff2(font))).toEqual({
      ok: false,
      error: FONT_MESSAGES.notFontFile,
    });
    expect(readFont(font).ok).toBe(false);
  });

  it('never throws and always answers with one of the sentences, whatever the bytes', () => {
    const sources = [
      outfit,
      fixtureFont('Outfit-Bold.woff'),
      fixtureFont('Outfit-Bold.woff2'),
      buildFont({ id1: 'X', id2: 'Regular', hebrew: true }),
    ];
    for (const source of sources) {
      for (let cut = 0; cut < source.length; cut += 61) {
        const bytes = source.subarray(0, cut);
        for (const name of ['a.ttf', 'a.woff', 'a.woff2']) {
          const check = checkFontFile(name, bytes);
          if (!check.ok) expect(SENTENCES).toContain(check.error);
        }
        const font = readFont(bytes);
        if (!font.ok) expect(SENTENCES).toContain(font.error);
      }
      // The same file with a stretch of garbage in the middle.
      const damaged = Buffer.from(source);
      damaged.fill(0xff, Math.floor(source.length / 3), Math.floor(source.length / 2));
      const font = readFont(damaged);
      if (!font.ok) expect(SENTENCES).toContain(font.error);
    }
  });
});

describe('readFont: family and weight rules found in the real library', () => {
  it('takes the family from name ID 16 and the style from ID 17 when they are there', () => {
    const font = read(
      buildFont({
        id1: 'Heebo Black',
        id2: 'Regular',
        id16: 'Heebo',
        id17: 'Black',
        weightClass: 900,
      }),
    );
    expect(font).toMatchObject({ family: 'Heebo', subfamily: 'Black', weight: 900 });
  });

  it('takes the family from ID 1 for a Regular or Bold file with no ID 16', () => {
    expect(read(buildFont({ id1: 'Alef', id2: 'Bold', weightClass: 700 }))).toMatchObject({
      family: 'Alef',
      subfamily: 'Bold',
      weight: 700,
    });
  });

  it('takes a weight word off ID 1 when there is no ID 16 ("Lato Black", subfamily Regular)', () => {
    const lato = read(buildFont({ id1: 'Lato Black', id2: 'Regular', weightClass: 900 }));
    expect(lato).toMatchObject({ family: 'Lato', subfamily: 'Black', weight: 900 });
    const plex = read(
      buildFont({ id1: 'IBM Plex Sans Hebrew ExtraLight', id2: 'Regular', weightClass: 200 }),
    );
    expect(plex).toMatchObject({ family: 'IBM Plex Sans Hebrew', weight: 200 });
    const medium = read(buildFont({ id1: 'David Libre Medium', id2: 'Regular', weightClass: 500 }));
    expect(medium).toMatchObject({ family: 'David Libre', weight: 500 });
    const spaced = read(
      buildFont({ id1: 'Foo Extra Light Italic', id2: 'Italic', weightClass: 200, italic: true }),
    );
    expect(spaced).toMatchObject({ family: 'Foo', weight: 200, italic: true });
  });

  it('leaves ID 1 alone when the word does not agree with the weight class, or the file is Regular 400', () => {
    // A family really named "Rubik Black Sheep" ... the class is 400, so the word is part of the name.
    expect(read(buildFont({ id1: 'Foo Light', id2: 'Regular', weightClass: 400 })).family).toBe(
      'Foo Light',
    );
    expect(read(buildFont({ id1: 'Foo Black', id2: 'Regular', weightClass: 300 })).family).toBe(
      'Foo Black',
    );
    // The subfamily is Bold: ID 1 is the family as it stands.
    expect(read(buildFont({ id1: 'Foo Light', id2: 'Bold', weightClass: 700 })).family).toBe(
      'Foo Light',
    );
    // No weight word at all.
    expect(read(buildFont({ id1: 'Rubik Glitch', id2: 'Regular' })).family).toBe('Rubik Glitch');
  });

  it('keeps Thin and ExtraLight apart when both have OS/2 class 250 (DM Sans, Heebo, Inter …)', () => {
    const thin = read(
      buildFont({
        id1: 'Heebo Thin',
        id2: 'Regular',
        id16: 'Heebo',
        id17: 'Thin',
        weightClass: 250,
      }),
    );
    const extraLight = read(
      buildFont({
        id1: 'Heebo ExtraLight',
        id2: 'Regular',
        id16: 'Heebo',
        id17: 'ExtraLight',
        weightClass: 250,
      }),
    );
    const light = read(
      buildFont({
        id1: 'Heebo Light',
        id2: 'Regular',
        id16: 'Heebo',
        id17: 'Light',
        weightClass: 300,
      }),
    );
    expect([thin.weight, extraLight.weight, light.weight]).toEqual([100, 200, 300]);
  });

  it('reads class 250 and 275 with no ID 16 from the word in ID 1 (Lato Hairline, Poppins ExtraLight)', () => {
    expect(
      read(buildFont({ id1: 'Lato Hairline', id2: 'Regular', weightClass: 250 })),
    ).toMatchObject({
      family: 'Lato',
      weight: 100,
    });
    expect(
      read(buildFont({ id1: 'Poppins ExtraLight', id2: 'Regular', weightClass: 275 })),
    ).toMatchObject({
      family: 'Poppins',
      weight: 200,
    });
    expect(
      read(buildFont({ id1: 'Poppins Thin', id2: 'Regular', weightClass: 250 })),
    ).toMatchObject({
      family: 'Poppins',
      weight: 100,
    });
  });

  it('snaps a class that is not a hundred and has no style word to the nearest hundred', () => {
    expect(read(buildFont({ id1: 'Odd', id2: null, weightClass: 350 })).weight).toBe(400);
    expect(read(buildFont({ id1: 'Odd', id2: null, weightClass: 460 })).weight).toBe(500);
    expect(read(buildFont({ id1: 'Odd', id2: 'Italic', weightClass: 1000 })).weight).toBe(900);
    // A plain "Regular" is only filler next to a class far from 400: 250 snaps to 300, not 400 ...
    expect(read(buildFont({ id1: 'Odd', id2: 'Regular', weightClass: 250 })).weight).toBe(300);
    // ... but next to a class near 400 it is the weight.
    expect(read(buildFont({ id1: 'Odd', id2: 'Regular', weightClass: 460 })).weight).toBe(400);
  });

  it('decides a class that is not a hundred by the style word when it has one', () => {
    expect(read(buildFont({ id1: 'Odd', id2: 'Light', weightClass: 350 })).weight).toBe(300);
    expect(
      read(buildFont({ id1: 'Odd', id16: 'Odd', id17: 'Semi Bold', weightClass: 650 })).weight,
    ).toBe(600);
    // "Heavy" is Black (the weight word comes from the number).
    expect(
      read(buildFont({ id1: 'Odd', id16: 'Odd', id17: 'Heavy', weightClass: 850 })).weight,
    ).toBe(900);
  });

  it('takes a clean class as it stands, whatever the style text says', () => {
    expect(read(buildFont({ id1: 'Odd', id2: 'Bold', weightClass: 600 })).weight).toBe(600);
  });

  it('has no class at all (0): Bold if the file says bold, else Regular', () => {
    expect(read(buildFont({ id1: 'Odd', id2: null, weightClass: 0 })).weight).toBe(400);
    expect(read(buildFont({ id1: 'Odd', id2: null, weightClass: 0, macBold: true })).weight).toBe(
      700,
    );
    expect(read(buildFont({ id1: 'Odd', id2: 'Light', weightClass: 0 })).weight).toBe(300);
  });

  it('reads italic from OS/2 fsSelection bit 0 or head macStyle bit 1', () => {
    expect(read(buildFont({ id1: 'A', id2: 'Italic', italic: true })).italic).toBe(true);
    expect(read(buildFont({ id1: 'A', id2: 'Italic', macItalic: true })).italic).toBe(true);
    expect(read(buildFont({ id1: 'A', id2: 'Regular' })).italic).toBe(false);
    expect(faceName('Merriweather', 400, true)).toBe('Merriweather Italic');
  });

  it('reads the panose numbers when there are any', () => {
    expect(read(buildFont({ id1: 'A', panose: [2, 11, 6, 3, 0, 0, 0, 0, 0, 0] })).panose).toEqual([
      2, 11, 6, 3, 0, 0, 0, 0, 0, 0,
    ]);
    expect(read(buildFont({ id1: 'A' })).panose).toBeNull();
  });
});

describe('readFont: the name table', () => {
  const win = (id: number, value: string, language = 0x409) => ({
    platform: 3,
    encoding: 1,
    language,
    id,
    value,
  });

  it('prefers the English Windows name over another language', () => {
    const font = read(
      buildFont({ id1: null, names: [win(1, 'אלף', 0x40d), win(1, 'Alef'), win(2, 'Regular')] }),
    );
    expect(font.family).toBe('Alef');
  });

  it('reads a name in Hebrew letters (UTF-16) when that is the only one', () => {
    expect(read(buildFont({ id1: null, names: [win(1, 'דוד', 0x40d)] })).family).toBe('דוד');
  });

  it('reads a Mac Roman name when there is no Windows one', () => {
    const font = read(
      buildFont({
        id1: null,
        names: [
          {
            platform: 1,
            encoding: 0,
            language: 0,
            id: 1,
            value: Buffer.from([0x43, 0x61, 0x66, 0x8e]),
          },
          { platform: 1, encoding: 0, language: 0, id: 2, value: 'Regular' },
        ],
      }),
    );
    expect(font).toMatchObject({ family: 'Café', subfamily: 'Regular' });
  });

  it('falls back to the full name (ID 4) when there is no family name, and refuses a font with no name at all', () => {
    expect(read(buildFont({ id1: null, names: [win(4, 'Full Name Bold')] })).family).toBe(
      'Full Name Bold',
    );
    expect(readFont(buildFont({ id1: null }))).toEqual({
      ok: false,
      error: FONT_MESSAGES.notFontFile,
    });
  });
});

describe('readFont: Hebrew is read from the cmap, in every format', () => {
  const cmaps = ['format4', 'format12', 'format6', 'format13'] as const;

  it.each(cmaps)('finds all 27 letters in a %s cmap', (cmap) => {
    expect(read(buildFont({ id1: 'A', cmap, hebrew: true })).he).toBe(true);
    expect(read(buildFont({ id1: 'A', cmap })).he).toBe(false);
  });

  it.each(cmaps)('wants all 27: 26 letters in a %s cmap is not Hebrew', (cmap) => {
    expect(read(buildFont({ id1: 'A', cmap, hebrew: 'partial' })).he).toBe(false);
  });

  it('reads a Unicode-platform cmap too, and the same through .woff and .woff2', () => {
    const font = buildFont({ id1: 'A', hebrew: true, cmapPlatform: 'unicode', cmap: 'format12' });
    expect(read(font).he).toBe(true);
    expect(read(toWoff(font)).he).toBe(true);
    expect(read(toWoff2(font)).he).toBe(true);
  });

  it('does not count a code point that maps to glyph 0 (.notdef)', () => {
    expect(read(buildFont({ id1: 'A', cmap: 'format12', hebrew: true, notdef: true })).he).toBe(
      false,
    );
  });

  it('is not fooled by Hebrew-looking code points elsewhere', () => {
    // Latin letters and the Hebrew points (U+05B0…) but not the letters themselves.
    const points = [0x41, 0x42, 0x5b0, 0x5b1, 0x5bf];
    expect(read(buildFont({ id1: 'A', codePoints: points })).he).toBe(false);
  });
});

describe('readFont: variable fonts', () => {
  const weightAxis = { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 };

  it('detects the axis and lists its named instances as the weights', () => {
    const font = read(
      buildFont({
        id1: 'Inter',
        id2: 'Regular',
        weightClass: 400,
        fvar: {
          axes: [weightAxis],
          instances: [
            { name: 'Thin', coordinates: [100] },
            { name: 'Regular', coordinates: [400] },
            { name: 'Bold', coordinates: [700] },
            { name: 'Bold Again', coordinates: [700] },
          ],
        },
      }),
    );
    expect(font.variable).toBe(true);
    expect(font.axes).toEqual([{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }]);
    expect(font.namedInstances).toEqual([100, 400, 700]);
    expect(font).toMatchObject({ family: 'Inter', weight: 400 });
  });

  it('lists the standard hundreds inside the range when it has no named instances', () => {
    const font = read(
      buildFont({ id1: 'Var', fvar: { axes: [{ ...weightAxis, min: 300, max: 700 }] } }),
    );
    expect(font.namedInstances).toEqual([300, 400, 500, 600, 700]);
  });

  it('falls back to the default weight when the range holds no hundred', () => {
    const font = read(
      buildFont({
        id1: 'Var',
        id2: 'Regular',
        fvar: { axes: [{ tag: 'wght', name: 'Weight', min: 410, default: 420, max: 480 }] },
      }),
    );
    expect(font.namedInstances).toEqual([400]);
  });

  it('keeps instances at 250 apart by their names (Thin 100, ExtraLight 200)', () => {
    const font = read(
      buildFont({
        id1: 'Var',
        fvar: {
          axes: [{ ...weightAxis, min: 250, default: 400, max: 900 }],
          instances: [
            { name: 'ExtraLight', coordinates: [250] },
            { name: 'Thin', coordinates: [250] },
          ],
        },
      }),
    );
    expect(font.namedInstances).toEqual([100, 200]);
  });

  it('knows every axis and finds the weight axis among several', () => {
    const font = read(
      buildFont({
        id1: 'Var',
        fvar: {
          axes: [{ tag: 'wdth', name: 'Width', min: 75, default: 100, max: 125 }, weightAxis],
          instances: [
            { name: 'Condensed Light', coordinates: [75, 300] },
            { name: 'Bold', coordinates: [100, 700] },
          ],
        },
      }),
    );
    expect(font.axes?.map((axis) => axis.tag)).toEqual(['wdth', 'wght']);
    expect(font.namedInstances).toEqual([300, 700]);
  });

  it('is variable but has no weights to list when there is no weight axis', () => {
    const font = read(
      buildFont({
        id1: 'Var',
        fvar: { axes: [{ tag: 'wdth', name: 'Width', min: 75, default: 100, max: 125 }] },
      }),
    );
    expect(font.variable).toBe(true);
    expect(font.axes).toHaveLength(1);
    expect(font.namedInstances).toBeNull();
  });

  it('reads the same through .woff and .woff2', () => {
    const font = buildFont({
      id1: 'Inter',
      id2: 'Regular',
      fvar: { axes: [weightAxis], instances: [{ name: 'Black', coordinates: [900] }] },
    });
    const ttf = read(font);
    expect(read(toWoff(font))).toEqual({ ...ttf, format: 'woff' });
    expect(read(toWoff2(font))).toEqual({ ...ttf, format: 'woff2' });
  });

  it('lists the faces a file stands for: its instances when variable, else its one weight', () => {
    const variable = read(
      buildFont({
        id1: 'Inter',
        fvar: {
          axes: [weightAxis],
          instances: [
            { name: 'Thin', coordinates: [100] },
            { name: 'Bold', coordinates: [700] },
          ],
        },
      }),
    );
    expect(faceWeights(variable)).toEqual([100, 700]);
    expect(faceWeights(read(fixtureFont('Outfit-Bold.ttf')))).toEqual([700]);
    // A variable font with no weight axis is one face at its own weight.
    const width = read(
      buildFont({
        id1: 'Var',
        fvar: { axes: [{ tag: 'wdth', name: 'Width', min: 75, default: 100, max: 125 }] },
      }),
    );
    expect(faceWeights(width)).toEqual([400]);
  });

  it('says a static font is not variable', () => {
    const font = read(fixtureFont('Outfit-Regular.ttf'));
    expect([font.variable, font.axes, font.namedInstances]).toEqual([false, null, null]);
  });
});
