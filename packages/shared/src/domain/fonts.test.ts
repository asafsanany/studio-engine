import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  cancelFontStageResponseSchema,
  deleteFontResponseSchema,
  dismissFontRequestResponseSchema,
  FONT_DEFAULT_STYLE,
  FONT_EXTENSIONS,
  FONT_FORMATS,
  FONT_FRAME_CREDITS,
  FONT_FRAME_LABELS,
  FONT_FRAMES,
  FONT_LIMITS,
  FONT_MESSAGES,
  FONT_MIME_TYPES,
  FONT_SAMPLE_TEXT,
  FONT_SCRIPT_LABELS,
  FONT_SLUG_PATTERN,
  FONT_STAGE_FIELD,
  FONT_STAGE_STATUSES,
  FONT_STYLE_BY_FAMILY,
  FONT_STYLES,
  FONT_USE_SOURCES,
  FONT_WEIGHT_NAMES,
  FONT_WEIGHTS,
  type FontFaceInfo,
  type FontFamilyDetail,
  type FontFamilySummary,
  type FontRequest,
  type FontStageItem,
  faceName,
  familySlug,
  fontAddsMessage,
  fontBytesLabel,
  fontConflictMessage,
  fontFaceSchema,
  fontFamilyDetailSchema,
  fontFamilySummarySchema,
  fontFilesLabel,
  fontFilesWord,
  fontFormatOf,
  fontImportRequestSchema,
  fontImportResponseSchema,
  fontNameKey,
  fontNewMessage,
  fontRequestSchema,
  fontSameMessage,
  fontScriptLabel,
  fontStageItemSchema,
  fontStageResponseSchema,
  fontStyleFor,
  fontsListResponseSchema,
  fontUsedLabel,
  fontUseSourceSchema,
  fontWeightName,
  fontWeightSchema,
  HEBREW_FALLBACK_FONT,
  isNewFont,
  normalizeFontWeight,
  revealFontResponseSchema,
  weightCountLabel,
  weightRangeLabel,
  weightsLabel,
} from './fonts.ts';
import {
  makeFontFace,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
  makeFontStageItem,
} from './test-fixtures.ts';

describe('weights, scripts, styles and test frames', () => {
  it('names the nine weights from the number', () => {
    expect(FONT_WEIGHTS).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(FONT_WEIGHTS.map((weight) => FONT_WEIGHT_NAMES[weight])).toEqual([
      'Thin',
      'ExtraLight',
      'Light',
      'Regular',
      'Medium',
      'SemiBold',
      'Bold',
      'ExtraBold',
      'Black',
    ]);
  });

  it('rounds a weight to one of the nine', () => {
    expect(normalizeFontWeight(400)).toBe(400);
    expect(normalizeFontWeight(450)).toBe(500);
    expect(normalizeFontWeight(349)).toBe(300);
    expect(normalizeFontWeight(0)).toBe(100);
    expect(normalizeFontWeight(1000)).toBe(900);
    expect(normalizeFontWeight(Number.NaN)).toBe(400);
    expect(fontWeightName(800)).toBe('ExtraBold');
    expect(fontWeightName(950)).toBe('Black');
  });

  it('accepts a weight from 100 to 900 in steps of 100 and nothing else', () => {
    for (const weight of FONT_WEIGHTS)
      expect(fontWeightSchema.safeParse(weight).success).toBe(true);
    for (const bad of [0, 50, 450, 1000, 400.5, '400', null]) {
      expect(fontWeightSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('has the two script labels, which are also the two folders of an import', () => {
    expect(FONT_SCRIPT_LABELS).toEqual({ hebrew: 'Hebrew + English', english: 'English only' });
    expect(fontScriptLabel(true)).toBe('Hebrew + English');
    expect(fontScriptLabel(false)).toBe('English only');
  });

  it('has the seven styles, and a style for each of the 40 known families', () => {
    expect(FONT_STYLES).toEqual([
      'Sans',
      'Serif',
      'Slab',
      'Rounded',
      'Condensed',
      'Display',
      'Handwriting',
    ]);
    expect(FONT_DEFAULT_STYLE).toBe('Sans');
    const families = Object.keys(FONT_STYLE_BY_FAMILY);
    expect(families).toHaveLength(40);
    expect(new Set(families.map(fontNameKey)).size).toBe(40);
    for (const style of Object.values(FONT_STYLE_BY_FAMILY)) expect(FONT_STYLES).toContain(style);
  });

  it('files the known families as the design does', () => {
    expect(FONT_STYLE_BY_FAMILY).toMatchObject({
      Heebo: 'Sans',
      'Amatic SC': 'Handwriting',
      Bellefair: 'Serif',
      Fredoka: 'Rounded',
      'Rubik Glitch': 'Display',
      'Secular One': 'Display',
      Oswald: 'Condensed',
      'Roboto Condensed': 'Condensed',
      'Roboto Slab': 'Slab',
      Nunito: 'Rounded',
      'Varela Round': 'Rounded',
    });
  });

  it('finds the style of a known family without regard to case, and null for the rest', () => {
    expect(fontStyleFor('Heebo')).toBe('Sans');
    expect(fontStyleFor('  secular   ONE ')).toBe('Display');
    expect(fontStyleFor('Roboto Slab')).toBe('Slab');
    expect(fontStyleFor('Gotham')).toBeNull();
    expect(fontStyleFor('')).toBeNull();
  });

  it('compares names without regard to case, spaces at the ends or doubled spaces', () => {
    expect(fontNameKey('Heebo')).toBe(fontNameKey(' heebo '));
    expect(fontNameKey('Noto  Sans Hebrew')).toBe('noto sans hebrew');
    expect(fontNameKey('Noto Sans')).not.toBe(fontNameKey('Noto Sans Hebrew'));
    // NFC: a composed and a decomposed é are one name.
    expect(fontNameKey('Café')).toBe(fontNameKey('Café'));
  });

  it('has the three test frames, the same photos as the LUTs page, with their credits', () => {
    expect(FONT_FRAMES).toEqual(['person', 'street', 'interior']);
    expect(FONT_FRAMES.map((frame) => FONT_FRAME_LABELS[frame])).toEqual([
      'Person',
      'Street',
      'Interior',
    ]);
    expect(FONT_FRAMES.map((frame) => FONT_FRAME_CREDITS[frame])).toEqual([
      'Benjamin Combs, Unsplash',
      'Nicholas Swanson, Unsplash',
      'The Anchor, Unsplash',
    ]);
  });

  it('keeps the approved sample copy, Hebrew included', () => {
    expect(FONT_SAMPLE_TEXT.lineEnglish).toBe('Every great edit starts with a cut');
    expect(FONT_SAMPLE_TEXT.lineHebrew).toBe('כל עריכה טובה מתחילה בחיתוך');
    expect(FONT_SAMPLE_TEXT.captionHebrew).toBe('ככה הכול התחיל');
    expect(FONT_SAMPLE_TEXT.captionEnglish).toBe('That’s how it all started');
    expect(FONT_SAMPLE_TEXT.titleHebrew).toBe('הבית ליד הים');
    expect(FONT_SAMPLE_TEXT.glyphsEnglish).toBe('Aa');
    expect(FONT_SAMPLE_TEXT.glyphsHebrew).toBe('אב');
  });
});

describe('limits and formats', () => {
  it('has the limits of the plan', () => {
    expect(FONT_LIMITS).toEqual({
      fileMaxBytes: 30 * 1024 * 1024,
      filesPerImport: 400,
      stageMaxBytes: 400 * 1024 * 1024,
      stageLifetimeMs: 60 * 60 * 1000,
      newTagMs: 30 * 60 * 1000,
      missingBannerMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('falls back to Heebo for Hebrew words in a font with no Hebrew', () => {
    expect(HEBREW_FALLBACK_FONT).toBe('Heebo');
  });

  it('accepts four extensions, each with a format and a Content-Type', () => {
    expect(FONT_EXTENSIONS).toEqual(['.ttf', '.otf', '.woff', '.woff2']);
    expect(FONT_FORMATS).toEqual(['ttf', 'otf', 'woff', 'woff2']);
    expect(FONT_MIME_TYPES).toEqual({
      ttf: 'font/ttf',
      otf: 'font/otf',
      woff: 'font/woff',
      woff2: 'font/woff2',
    });
    expect(FONT_STAGE_FIELD).toBe('files[]');
  });

  it('reads the format from a file name, without regard to case', () => {
    expect(fontFormatOf('Heebo-Bold.ttf')).toBe('ttf');
    expect(fontFormatOf('Heebo-Bold.TTF')).toBe('ttf');
    expect(fontFormatOf('a.b.OTF')).toBe('otf');
    expect(fontFormatOf('x.woff')).toBe('woff');
    expect(fontFormatOf('x.woff2')).toBe('woff2');
    expect(fontFormatOf('x.ttc')).toBeNull();
    expect(fontFormatOf('LICENSE.txt')).toBeNull();
    expect(fontFormatOf('.DS_Store')).toBeNull();
    expect(fontFormatOf('ttf')).toBeNull();
  });
});

describe('faceName', () => {
  it('is the family alone for Regular upright', () => {
    expect(faceName('Heebo', 400, false)).toBe('Heebo');
    expect(faceName('Noto Sans Hebrew', 400, false)).toBe('Noto Sans Hebrew');
  });

  it('adds the weight word for every other weight', () => {
    expect(faceName('Heebo', 100, false)).toBe('Heebo Thin');
    expect(faceName('Heebo', 200, false)).toBe('Heebo ExtraLight');
    expect(faceName('Heebo', 300, false)).toBe('Heebo Light');
    expect(faceName('Heebo', 500, false)).toBe('Heebo Medium');
    expect(faceName('Heebo', 600, false)).toBe('Heebo SemiBold');
    expect(faceName('Heebo', 700, false)).toBe('Heebo Bold');
    expect(faceName('Heebo', 800, false)).toBe('Heebo ExtraBold');
    expect(faceName('Heebo', 900, false)).toBe('Heebo Black');
  });

  it('adds Italic for an italic, after the weight word', () => {
    expect(faceName('Merriweather', 400, true)).toBe('Merriweather Italic');
    expect(faceName('Heebo', 700, true)).toBe('Heebo Bold Italic');
  });

  it('names a weight that is not one of the nine by the nearest', () => {
    expect(faceName('Inter', 450, false)).toBe('Inter Medium');
    expect(faceName('Inter', 1000, false)).toBe('Inter Black');
  });
});

describe('familySlug', () => {
  it('is the name in kebab-case', () => {
    expect(familySlug('Heebo')).toBe('heebo');
    expect(familySlug('IBM Plex Sans Hebrew')).toBe('ibm-plex-sans-hebrew');
    expect(familySlug('DM Sans')).toBe('dm-sans');
    expect(familySlug('Rubik 80s Fade')).toBe('rubik-80s-fade');
    expect(familySlug('Nunito Sans')).toBe('nunito-sans');
  });

  it('drops accents and turns anything else into one dash, none at the ends', () => {
    expect(familySlug('Jost*')).toBe('jost');
    expect(familySlug('Café & Crème')).toBe('cafe-creme');
    expect(familySlug('  --Big   Shoulders--  ')).toBe('big-shoulders');
  });

  it('is the same for names that differ only in case', () => {
    expect(familySlug('HEEBO')).toBe(familySlug('Heebo'));
  });

  it('gives a name with no Latin letters a stable font-<6 hex> slug', () => {
    const slug = familySlug('דוד');
    expect(slug).toMatch(/^font-[0-9a-f]{6}$/);
    expect(familySlug('דוד')).toBe(slug);
    expect(familySlug(' דוד ')).toBe(slug);
    expect(familySlug('שלום')).not.toBe(slug);
    expect(familySlug('')).toMatch(/^font-[0-9a-f]{6}$/);
  });

  it('cuts a long name to 60 characters, always matching the slug pattern', () => {
    const slug = familySlug(`${'Very Long Family Name '.repeat(6)}`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(FONT_SLUG_PATTERN);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('matches the slug pattern for every known family', () => {
    for (const family of Object.keys(FONT_STYLE_BY_FAMILY)) {
      expect(familySlug(family), family).toMatch(FONT_SLUG_PATTERN);
    }
  });

  it('is different for each of the 40 known families', () => {
    const slugs = Object.keys(FONT_STYLE_BY_FAMILY).map(familySlug);
    expect(new Set(slugs).size).toBe(40);
  });
});

describe('weight labels', () => {
  it('counts weights in words', () => {
    expect(weightCountLabel(9)).toBe('9 weights');
    expect(weightCountLabel(1)).toBe('1 weight');
    expect(weightCountLabel(2)).toBe('2 weights');
    expect(weightsLabel([100, 200, 300, 400, 500, 600, 700, 800, 900])).toBe('9 weights');
    expect(weightsLabel([400])).toBe('1 weight');
    expect(weightsLabel([400, 700])).toBe('2 weights');
  });

  it('counts a weight once, even when it comes twice (an italic of the same weight)', () => {
    expect(weightsLabel([400, 400, 700])).toBe('2 weights');
  });

  it('says a single weight by its word', () => {
    expect(weightRangeLabel([400])).toBe('Regular');
    expect(weightRangeLabel([700])).toBe('Bold');
  });

  it('lists up to three weights, lowest first', () => {
    expect(weightRangeLabel([400, 700])).toBe('Regular, Bold');
    expect(weightRangeLabel([700, 300, 400])).toBe('Light, Regular, Bold');
    expect(weightRangeLabel([400, 500, 700])).toBe('Regular, Medium, Bold');
  });

  it('says four or more weights as a range with an en dash', () => {
    expect(weightRangeLabel([100, 200, 300, 400, 500, 600, 700, 800, 900])).toBe('Thin–Black');
    expect(weightRangeLabel([200, 300, 400, 500, 600, 700, 800])).toBe('ExtraLight–ExtraBold');
    expect(weightRangeLabel([100, 300, 400, 700, 900])).toBe('Thin–Black');
    expect(weightRangeLabel([300, 400, 500, 700])).toBe('Light–Bold');
  });

  it('counts a repeated weight once in the range too, and says nothing for none', () => {
    expect(weightRangeLabel([400, 400, 400])).toBe('Regular');
    expect(weightRangeLabel([])).toBe('');
  });
});

describe('fontUsedLabel and isNewFont', () => {
  it('says how many jobs used a family', () => {
    expect(fontUsedLabel(14)).toBe('14 jobs');
    expect(fontUsedLabel(2)).toBe('2 jobs');
    expect(fontUsedLabel(1)).toBe('1 job');
    expect(fontUsedLabel(0)).toBe('Not used yet');
  });

  it('is new for 30 minutes after it was added', () => {
    const addedAt = '2026-10-25T10:00:00.000Z';
    const at = (minutes: number) => new Date(Date.parse(addedAt) + minutes * 60_000);
    expect(isNewFont(addedAt, at(0))).toBe(true);
    expect(isNewFont(addedAt, at(29))).toBe(true);
    expect(isNewFont(addedAt, at(29.99))).toBe(true);
    expect(isNewFont(addedAt, at(30))).toBe(false);
    expect(isNewFont(addedAt, at(60 * 24))).toBe(false);
  });

  it('takes the time as a Date, an ISO string or milliseconds', () => {
    const addedAt = '2026-10-25T10:00:00.000Z';
    const ms = Date.parse(addedAt) + 60_000;
    expect(isNewFont(addedAt, ms)).toBe(true);
    expect(isNewFont(addedAt, new Date(ms).toISOString())).toBe(true);
    expect(isNewFont(addedAt, new Date(ms))).toBe(true);
  });

  it('is not new when it is in the future, null, or cannot be read', () => {
    const now = new Date('2026-10-25T10:00:00.000Z');
    expect(isNewFont('2026-10-25T10:05:00.000Z', now)).toBe(false);
    expect(isNewFont(null, now)).toBe(false);
    expect(isNewFont('not a time', now)).toBe(false);
    expect(isNewFont('2026-10-25T09:59:00.000Z', Number.NaN)).toBe(false);
  });

  it('uses the clock when no time is given', () => {
    expect(isNewFont(new Date().toISOString())).toBe(true);
    expect(isNewFont('2020-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('FONT_MESSAGES and the verdict sentences', () => {
  it('is one plain sentence each, ending in a period', () => {
    for (const [key, message] of Object.entries(FONT_MESSAGES)) {
      expect(message.length, key).toBeGreaterThan(0);
      expect(message.endsWith('.'), key).toBe(true);
      expect(message.trim(), key).toBe(message);
    }
  });

  it('has the words of the plan', () => {
    expect(FONT_MESSAGES.off).toBe('Fonts are off.');
    expect(FONT_MESSAGES.cutShort).toBe('Not a font: the file is cut short.');
    expect(FONT_MESSAGES.notFontFile).toBe('Not a font: it does not start like a font file.');
    expect(FONT_MESSAGES.collection).toBe(
      'A font collection (.ttc) holds several fonts in one file. Export them one by one.',
    );
    expect(FONT_MESSAGES.tooLarge).toBe('Too big: over 30 MB.');
    expect(FONT_MESSAGES.badExtension).toBe('Not a font: only .ttf, .otf, .woff and .woff2 files.');
    expect(FONT_MESSAGES.notFound).toBe('There is no such font.');
    expect(FONT_MESSAGES.requestNotFound).toBe('There is no such request.');
  });

  it('keeps the numbers in the messages in step with the limits', () => {
    expect(FONT_MESSAGES.tooLarge).toContain(`${FONT_LIMITS.fileMaxBytes / (1024 * 1024)} MB`);
    expect(FONT_MESSAGES.stageTooLarge).toContain(
      `${FONT_LIMITS.stageMaxBytes / (1024 * 1024)} MB`,
    );
    expect(FONT_MESSAGES.tooManyFiles).toContain(String(FONT_LIMITS.filesPerImport));
  });

  it('says the verdict "same"', () => {
    expect(fontSameMessage(9)).toBe('Already here with the same 9 weights. Skipped.');
    expect(fontSameMessage(2)).toBe('Already here with the same 2 weights. Skipped.');
    expect(fontSameMessage(1)).toBe('Already here with the same weight. Skipped.');
  });

  it('says the verdict "adds"', () => {
    expect(fontAddsMessage(2, 'Rubik')).toBe('Adds 2 weights to Rubik.');
    expect(fontAddsMessage(1, 'Noto Sans Hebrew')).toBe('Adds 1 weight to Noto Sans Hebrew.');
  });

  it('says the verdict "conflict" with the face name', () => {
    expect(fontConflictMessage(faceName('Rubik', 700, false))).toBe(
      'You already have a different Rubik Bold. Delete it first to replace it.',
    );
  });

  it('says the verdict "new"', () => {
    expect(fontNewMessage(3, true, 210_000)).toBe('3 files · Hebrew + English · 0.2 MB');
    expect(fontNewMessage(1, false, 100_000)).toBe('1 file · English only · 0.1 MB');
  });

  it('counts files in words', () => {
    expect(fontFilesWord(1)).toBe('1 file');
    expect(fontFilesWord(0)).toBe('0 files');
    expect(fontFilesWord(237)).toBe('237 files');
  });

  it('says a size in megabytes: one decimal under 10, whole from 10, never 0.0', () => {
    const mb = 1024 * 1024;
    expect(fontBytesLabel(0)).toBe('0.1 MB');
    expect(fontBytesLabel(1)).toBe('0.1 MB');
    expect(fontBytesLabel(62_548)).toBe('0.1 MB');
    expect(fontBytesLabel(0.2 * mb)).toBe('0.2 MB');
    expect(fontBytesLabel(7.3 * mb)).toBe('7.3 MB');
    expect(fontBytesLabel(9.94 * mb)).toBe('9.9 MB');
    expect(fontBytesLabel(10 * mb)).toBe('10 MB');
    expect(fontBytesLabel(42.4 * mb)).toBe('42 MB');
    expect(fontBytesLabel(-5)).toBe('0.1 MB');
  });

  it('says the "Files" fact: how many files, their format and their size', () => {
    const mb = 1024 * 1024;
    const nine = Array.from({ length: 9 }, (_, i) =>
      makeFontFace({ fileId: `f${i}`, bytes: Math.round((0.4 * mb) / 9) }),
    );
    expect(fontFilesLabel(nine)).toBe('9 TTF · 0.4 MB');
    expect(fontFilesLabel([makeFontFace({ bytes: 62_548 })])).toBe('1 TTF · 0.1 MB');
    expect(
      fontFilesLabel([
        makeFontFace({ fileId: 'a', bytes: 1000 }),
        makeFontFace({ fileId: 'b', bytes: 1000, format: 'otf' }),
        makeFontFace({ fileId: 'c', bytes: 1000 }),
      ]),
    ).toBe('2 TTF + 1 OTF · 0.1 MB');
  });

  it('counts a file once when a variable font’s instances share it', () => {
    const shared = [
      makeFontFace({ name: 'Inter Thin', weight: 100, fileId: 'one', bytes: 1024 * 1024 }),
      makeFontFace({ name: 'Inter', weight: 400, fileId: 'one', bytes: 1024 * 1024 }),
      makeFontFace({ name: 'Inter Black', weight: 900, fileId: 'one', bytes: 1024 * 1024 }),
    ];
    expect(fontFilesLabel(shared)).toBe('1 TTF · 1.0 MB');
  });
});

describe('a font on the wire', () => {
  it('parses a face, a family summary and a family detail', () => {
    const face = makeFontFace();
    expect(fontFaceSchema.parse(face)).toEqual(face);
    const summary = makeFontFamilySummary();
    expect(fontFamilySummarySchema.parse(summary)).toEqual(summary);
    const detail = makeFontFamilyDetail();
    expect(fontFamilyDetailSchema.parse(detail)).toEqual(detail);
  });

  it('keeps the fields of the plan on a face', () => {
    expect(Object.keys(makeFontFace()).sort()).toEqual(
      ['bytes', 'family', 'fileId', 'format', 'italic', 'name', 'version', 'weight'].sort(),
    );
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), format: 'ttc' }).success).toBe(false);
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), weight: 450 }).success).toBe(false);
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), bytes: -1 }).success).toBe(false);
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), fileId: '' }).success).toBe(false);
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), italic: 'no' }).success).toBe(false);
    // The version is optional: a face without one still parses, an empty one does not.
    const { version: _version, ...withoutVersion } = makeFontFace();
    expect(fontFaceSchema.safeParse(withoutVersion).success).toBe(true);
    expect(fontFaceSchema.safeParse({ ...makeFontFace(), version: '' }).success).toBe(false);
  });

  it('keeps the fields of the plan on a summary', () => {
    expect(Object.keys(makeFontFamilySummary()).sort()).toEqual(
      [
        'addedAt',
        'he',
        'isNew',
        'name',
        'slug',
        'style',
        'used',
        'usedLabel',
        'weights',
        'weightsLabel',
      ].sort(),
    );
  });

  it('refuses a summary with a bad slug, style, weight list or time', () => {
    const summary = makeFontFamilySummary();
    for (const bad of [
      { slug: 'Heebo' },
      { slug: '' },
      { slug: 'a b' },
      { slug: '-heebo' },
      { style: 'Script' },
      { weights: [] },
      { weights: [450] },
      { used: -1 },
      { used: 1.5 },
      { usedLabel: '' },
      { addedAt: 'yesterday' },
      { addedAt: null },
      { he: 'yes' },
    ]) {
      expect(
        fontFamilySummarySchema.safeParse({ ...summary, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('parses a detail with no usage while the notes switch is off', () => {
    const detail = makeFontFamilyDetail({ usedIn: null });
    expect(fontFamilyDetailSchema.parse(detail)).toEqual(detail);
    expect(fontFamilyDetailSchema.safeParse({ ...detail, faces: [] }).success).toBe(false);
    expect(fontFamilyDetailSchema.safeParse({ ...detail, files: 0 }).success).toBe(false);
    expect(fontFamilyDetailSchema.safeParse({ ...detail, usedIn: -1 }).success).toBe(false);
  });

  it('parses a request for a font the library does not have', () => {
    const request = makeFontRequest();
    expect(fontRequestSchema.parse(request)).toEqual(request);
    expect(fontRequestSchema.parse(makeFontRequest({ round: 0 })).round).toBe(0);
    expect(fontRequestSchema.safeParse({ ...request, round: -1 }).success).toBe(false);
    expect(fontRequestSchema.safeParse({ ...request, name: '' }).success).toBe(false);
    expect(fontRequestSchema.safeParse({ ...request, at: 12345 }).success).toBe(false);
  });

  it('parses the list: families, the catalog of faces and the requests', () => {
    const list = {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace(), makeFontFace({ name: 'Heebo', weight: 400, fileId: 'aa11' })],
      requests: [makeFontRequest()],
    };
    expect(fontsListResponseSchema.parse(list)).toEqual(list);
    expect(fontsListResponseSchema.parse({ families: [], catalog: [], requests: [] })).toEqual({
      families: [],
      catalog: [],
      requests: [],
    });
    expect(fontsListResponseSchema.safeParse({ families: [], catalog: [] }).success).toBe(false);
  });

  it('infers its shapes', () => {
    expectTypeOf<FontFamilySummary['weights']>().toEqualTypeOf<number[]>();
    expectTypeOf<FontFamilySummary['style']>().toEqualTypeOf<
      'Sans' | 'Serif' | 'Slab' | 'Rounded' | 'Condensed' | 'Display' | 'Handwriting'
    >();
    expectTypeOf<FontFamilyDetail['usedIn']>().toEqualTypeOf<number | null>();
    expectTypeOf<FontFaceInfo['format']>().toEqualTypeOf<'ttf' | 'otf' | 'woff' | 'woff2'>();
    expectTypeOf<FontRequest['round']>().toEqualTypeOf<number>();
    expectTypeOf<FontStageItem['status']>().toEqualTypeOf<
      'new' | 'adds' | 'same' | 'conflict' | 'bad'
    >();
  });
});

describe('import: stage, then import', () => {
  it('has the five verdicts', () => {
    expect(FONT_STAGE_STATUSES).toEqual(['new', 'adds', 'same', 'conflict', 'bad']);
  });

  it('parses a stage item of every status', () => {
    const items: FontStageItem[] = [
      makeFontStageItem(),
      makeFontStageItem({
        id: 'rubik',
        name: 'Rubik',
        files: 2,
        status: 'adds',
        info: fontAddsMessage(2, 'Rubik'),
      }),
      makeFontStageItem({
        id: 'heebo',
        name: 'Heebo',
        files: 9,
        weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
        status: 'same',
        info: fontSameMessage(9),
      }),
      makeFontStageItem({
        id: 'rubik-conflict',
        name: 'Rubik',
        files: 1,
        weights: [700],
        status: 'conflict',
        info: fontConflictMessage('Rubik Bold'),
      }),
      makeFontStageItem({
        id: 'broken',
        name: 'Broken export.ttf',
        files: 1,
        he: false,
        weights: [],
        bytes: 2048,
        status: 'bad',
        info: FONT_MESSAGES.cutShort,
      }),
    ];
    for (const item of items) expect(fontStageItemSchema.parse(item)).toEqual(item);
  });

  it('refuses a stage item with no info, a bad status or no files', () => {
    const item = makeFontStageItem();
    expect(fontStageItemSchema.safeParse({ ...item, info: '' }).success).toBe(false);
    expect(fontStageItemSchema.safeParse({ ...item, status: 'skipped' }).success).toBe(false);
    expect(fontStageItemSchema.safeParse({ ...item, files: 0 }).success).toBe(false);
    expect(fontStageItemSchema.safeParse({ ...item, weights: [450] }).success).toBe(false);
  });

  it('parses the stage answer', () => {
    const response = { stageId: 'a1b2c3', items: [makeFontStageItem()] };
    expect(fontStageResponseSchema.parse(response)).toEqual(response);
    expect(fontStageResponseSchema.parse({ stageId: 'a1b2c3', items: [] }).items).toEqual([]);
    expect(fontStageResponseSchema.safeParse({ stageId: '', items: [] }).success).toBe(false);
  });

  it('parses an import request: the stage and the ids of the items to add', () => {
    const request = { stageId: 'a1b2c3', items: ['karantina', 'bebas-neue'] };
    expect(fontImportRequestSchema.parse(request)).toEqual(request);
    expect(fontImportRequestSchema.safeParse({ stageId: 'a1b2c3', items: [] }).success).toBe(false);
    expect(fontImportRequestSchema.safeParse({ stageId: '', items: ['x'] }).success).toBe(false);
    expect(fontImportRequestSchema.safeParse({ stageId: 'a', items: [''] }).success).toBe(false);
    expect(fontImportRequestSchema.safeParse({ stageId: 'a', items: [{ id: 'x' }] }).success).toBe(
      false,
    );
    const many = Array.from({ length: FONT_LIMITS.filesPerImport }, (_, i) => `f${i}`);
    expect(fontImportRequestSchema.safeParse({ stageId: 'a', items: many }).success).toBe(true);
    expect(
      fontImportRequestSchema.safeParse({ stageId: 'a', items: [...many, 'one-too-many'] }).success,
    ).toBe(false);
  });

  it('parses an import answer: the families and the failures', () => {
    const response = {
      imported: [makeFontFamilySummary({ isNew: true })],
      failed: [{ id: 'bebas-neue', error: FONT_MESSAGES.importFailed }],
    };
    expect(fontImportResponseSchema.parse(response)).toEqual(response);
    expect(
      fontImportResponseSchema.safeParse({ imported: [], failed: [{ id: 'x' }] }).success,
    ).toBe(false);
  });

  it('parses the small answers', () => {
    expect(cancelFontStageResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(cancelFontStageResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(revealFontResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(dismissFontRequestResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(dismissFontRequestResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(deleteFontResponseSchema.parse({ ok: true, where: '/Users/a/.Trash' })).toEqual({
      ok: true,
      where: '/Users/a/.Trash',
    });
    expect(deleteFontResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('where a recorded use of a font came from', () => {
  it('is a note that named it, or a finished composition', () => {
    expect(FONT_USE_SOURCES).toEqual(['token', 'composition']);
    expect(fontUseSourceSchema.parse('token')).toBe('token');
    expect(fontUseSourceSchema.parse('composition')).toBe('composition');
    expect(fontUseSourceSchema.safeParse('guess').success).toBe(false);
    expect(fontUseSourceSchema.safeParse('').success).toBe(false);
  });
});
