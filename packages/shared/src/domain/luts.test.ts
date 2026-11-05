import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUILTIN_LUTS,
  type BuiltInLut,
  builtInLut,
  cancelLutStageResponseSchema,
  cleanLutName,
  deleteLutResponseSchema,
  freeLutName,
  isNewLut,
  LUT_FRAME_CREDITS,
  LUT_FRAME_LABELS,
  LUT_FRAME_SIZE,
  LUT_FRAMES,
  LUT_KIND_LABELS,
  LUT_KINDS,
  LUT_LIMITS,
  LUT_MESSAGES,
  LUT_PREVIEW_SIDES,
  LUT_SLUG_PATTERN,
  type LutDetail,
  type LutSummary,
  lutDetailSchema,
  lutImportRequestSchema,
  lutImportResponseSchema,
  lutKindGuess,
  lutListResponseSchema,
  lutNameKey,
  lutSizeLabel,
  lutSlug,
  lutStageFileSchema,
  lutStageResponseSchema,
  lutSummarySchema,
  lutUsedLabel,
  revealLutResponseSchema,
  updateLutRequestSchema,
} from './luts.ts';
import { makeBuiltInLutSummary, makeLutDetail, makeLutSummary } from './test-fixtures.ts';

describe('kinds, frames and limits', () => {
  it('has the three kinds with their words', () => {
    expect(LUT_KINDS).toEqual(['look', 'camera', 'fix']);
    expect(LUT_KINDS.map((kind) => LUT_KIND_LABELS[kind])).toEqual(['Look', 'Camera', 'Fix']);
  });

  it('has the three test frames, each with its label and the photo credit', () => {
    expect(LUT_FRAMES).toEqual(['person', 'street', 'interior']);
    expect(LUT_FRAMES.map((frame) => LUT_FRAME_LABELS[frame])).toEqual([
      'Person',
      'Street',
      'Interior',
    ]);
    expect(LUT_FRAMES.map((frame) => LUT_FRAME_CREDITS[frame])).toEqual([
      'Benjamin Combs, Unsplash',
      'Nicholas Swanson, Unsplash',
      'The Anchor, Unsplash',
    ]);
    expect(LUT_PREVIEW_SIDES).toEqual(['before', 'after']);
    expect(LUT_FRAME_SIZE).toEqual({ width: 396, height: 704 });
  });

  it('has the limits of the plan', () => {
    expect(LUT_LIMITS).toEqual({
      nameMax: 60,
      fileMaxBytes: 40 * 1024 * 1024,
      gridMin: 2,
      gridMax: 129,
      filesPerImport: 60,
      stageLifetimeMs: 3_600_000,
      newTagMs: 1_800_000,
    });
  });
});

describe('BUILTIN_LUTS', () => {
  it('has the 19 rows, sorted by name', () => {
    expect(BUILTIN_LUTS).toHaveLength(19);
    const names = BUILTIN_LUTS.map((lut) => lut.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('Cinematic');
    expect(names).toContain('S-Gamut3 to Cine');
  });

  it('gives every row the slug of its name, a valid one, and no slug twice', () => {
    for (const lut of BUILTIN_LUTS) {
      expect(lut.slug, lut.name).toBe(lutSlug(lut.name, 'ffffffffffff'));
      expect(lut.slug).toMatch(LUT_SLUG_PATTERN);
    }
    expect(new Set(BUILTIN_LUTS.map((lut) => lut.slug)).size).toBe(19);
  });

  it('has the Fix and Camera rows the skill has, and the rest are looks', () => {
    const byKind = (kind: string) =>
      BUILTIN_LUTS.filter((lut) => lut.kind === kind).map((lut) => lut.slug);
    expect(byKind('fix')).toEqual(['led-green-fix', 'red-skin-fix']);
    expect(byKind('camera')).toEqual(['s-gamut3-to-cine']);
    expect(byKind('look')).toHaveLength(16);
  });

  it('points every row at one file in correction_luts, except the Cinematic look', () => {
    for (const lut of BUILTIN_LUTS) {
      if (lut.slug === 'cinematic') {
        expect(lut.files).toEqual([]);
        expect(lut.look).toBe('cinematic');
      } else {
        expect(lut.files, lut.slug).toHaveLength(1);
        expect(lut.files[0]).toMatch(/^[a-z0-9_]+\.cube$/);
        expect(lut.look).toBeNull();
      }
    }
    expect(new Set(BUILTIN_LUTS.flatMap((lut) => lut.files)).size).toBe(18);
  });

  it('describes every row, and only the Fix rows carry a note', () => {
    for (const lut of BUILTIN_LUTS) {
      expect(lut.description, lut.slug).toMatch(/\.$/);
      expect(lut.note !== null, lut.slug).toBe(lut.kind === 'fix');
    }
  });

  it('says the cinematic look uses the Cinematic row and Film contrast', () => {
    expect(BUILTIN_LUTS.filter((lut) => lut.usedBy !== null).map((lut) => lut.slug)).toEqual([
      'cinematic',
      'film-contrast',
    ]);
  });

  it('finds a row by slug', () => {
    expect(builtInLut('film-contrast')?.name).toBe('Film contrast');
    expect(builtInLut('golden-hour-warm')).toBeUndefined();
    expectTypeOf(builtInLut('x')).toEqualTypeOf<BuiltInLut | undefined>();
  });
});

describe('lutSlug', () => {
  it.each([
    ['Golden Hour Warm', 'golden-hour-warm'],
    ['Sony S-Log3 to Rec709', 'sony-s-log3-to-rec709'],
    ['Film contrast (2)', 'film-contrast-2'],
    ['  --Teal & Orange!!  ', 'teal-orange'],
    ['Café Crème', 'cafe-creme'],
    ['LED green fix', 'led-green-fix'],
  ])('turns %j into %j', (name, slug) => {
    expect(lutSlug(name, '0123456789ab')).toBe(slug);
  });

  it('uses lut-<first 6 of the id> for a name with no letters or digits', () => {
    expect(lutSlug('מראה חם', 'ABCDEF123456')).toBe('lut-abcdef');
    expect(lutSlug('🎬', '0123456789ab')).toBe('lut-012345');
    expect(lutSlug('---', '0123456789ab')).toBe('lut-012345');
  });

  it('keeps the Latin part of a mixed name', () => {
    expect(lutSlug('מראה Warm 2', '0123456789ab')).toBe('warm-2');
  });

  it('is at most 60 characters and never ends in -', () => {
    const slug = lutSlug(`${'a'.repeat(59)} bbbb`, '0123456789ab');
    expect(slug).toBe('a'.repeat(59));
    expect(lutSlug('x'.repeat(100), '0123456789ab')).toHaveLength(60);
    expect(lutSlug('x'.repeat(100), '0123456789ab')).toMatch(LUT_SLUG_PATTERN);
  });
});

describe('cleanLutName', () => {
  it('trims, folds / and : into –, and drops control characters and leading dots', () => {
    expect(cleanLutName('  Warm / Cool: v2  ')).toBe('Warm – Cool– v2');
    expect(cleanLutName('a\tb\nc')).toBe('a b c');
    expect(cleanLutName('...hidden')).toBe('hidden');
    expect(cleanLutName(' . ')).toBe('');
    expect(cleanLutName('')).toBe('');
  });

  it('cuts to 60 characters, counting a Hebrew letter or an emoji once', () => {
    expect(cleanLutName('a'.repeat(80))).toHaveLength(60);
    expect(Array.from(cleanLutName('א'.repeat(80)))).toHaveLength(60);
    expect(Array.from(cleanLutName('🎬'.repeat(80)))).toHaveLength(60);
  });

  it('puts the name in NFC', () => {
    expect(cleanLutName('Café')).toBe('Café');
  });
});

describe('freeLutName', () => {
  it('keeps a free name', () => {
    expect(freeLutName('Soft pastel', ['Film contrast'])).toBe('Soft pastel');
    expect(freeLutName('Soft pastel', [])).toBe('Soft pastel');
  });

  it('adds (2), then (3), without regard to case', () => {
    expect(freeLutName('Film contrast', ['film CONTRAST'])).toBe('Film contrast (2)');
    expect(freeLutName('Film contrast', ['Film contrast', 'Film contrast (2)'])).toBe(
      'Film contrast (3)',
    );
  });

  it('cuts a long name so the number still fits', () => {
    const name = 'x'.repeat(60);
    const free = freeLutName(name, [name]);
    expect(free).toBe(`${'x'.repeat(56)} (2)`);
    expect(free).toHaveLength(60);
  });

  it('gives a slug the notes can use: film-contrast-2', () => {
    expect(lutSlug(freeLutName('Film contrast', ['Film contrast']), 'a'.repeat(12))).toBe(
      'film-contrast-2',
    );
  });

  it('compares names in NFC and lower case', () => {
    expect(lutNameKey('Café')).toBe(lutNameKey('CAFÉ'.toLowerCase()));
  });
});

describe('lutUsedLabel', () => {
  it('says how many jobs used it', () => {
    expect(lutUsedLabel(3)).toBe('3 jobs');
    expect(lutUsedLabel(1)).toBe('1 job');
    expect(lutUsedLabel(0)).toBe('Not used yet');
  });

  it('says a built-in LUT is used by the cinematic look until a job used it itself', () => {
    expect(lutUsedLabel(0, 'the cinematic look')).toBe('Used by the cinematic look');
    expect(lutUsedLabel(2, 'the cinematic look')).toBe('2 jobs');
  });
});

describe('lutSizeLabel', () => {
  it('writes the grid as the facts do', () => {
    expect(lutSizeLabel(33)).toBe('33 × 33 × 33');
    expect(lutSizeLabel(2)).toBe('2 × 2 × 2');
  });
});

describe('isNewLut', () => {
  const added = '2026-10-24T10:00:00.000Z';
  const at = (ms: number) => new Date(Date.parse(added) + ms);

  it('is new for 30 minutes after it was added', () => {
    expect(isNewLut(added, at(0))).toBe(true);
    expect(isNewLut(added, at(29 * 60_000 + 59_999))).toBe(true);
    expect(isNewLut(added, at(30 * 60_000))).toBe(false);
    expect(isNewLut(added, at(2 * 3_600_000))).toBe(false);
  });

  it('is not new when it has no added time, is in the future, or cannot be read', () => {
    expect(isNewLut(null, at(0))).toBe(false);
    expect(isNewLut(added, at(-1))).toBe(false);
    expect(isNewLut('yesterday', at(0))).toBe(false);
  });

  it('takes now as a Date, an ISO string or milliseconds', () => {
    expect(isNewLut(added, '2026-10-24T10:10:00.000Z')).toBe(true);
    expect(isNewLut(added, Date.parse(added) + 60_000)).toBe(true);
    expect(isNewLut(added, '2026-10-24T11:00:00.000Z')).toBe(false);
    expect(isNewLut(added, 'not a time')).toBe(false);
  });
});

describe('lutKindGuess', () => {
  it.each([
    'Sony S-Log3 to Rec709.cube',
    'S-Log2 to Rec.709.cube',
    'V-Log to V-709.cube',
    'Canon C-Log2.cube',
    'slog3_sgamut3.cube',
    'Arri LogC to Rec709.cube',
    'something_log.3dl',
    'REC709 contrast.cube',
    'Warm to cool.cube',
  ])('guesses Camera for %s', (name) => {
    expect(lutKindGuess(name)).toBe('camera');
  });

  it.each([
    'Golden Hour Warm.cube',
    'Teal Orange Soft.cube',
    'Moody Forest.cube',
    'Catalog look.cube',
    'Logo glow.cube',
    'Total contrast.cube',
    'Skin warm fix.cube',
    '',
  ])('guesses Look for %j', (name) => {
    expect(lutKindGuess(name)).toBe('look');
  });
});

describe('LUT_MESSAGES', () => {
  it('has one plain sentence ending in a period for each', () => {
    for (const [key, message] of Object.entries(LUT_MESSAGES)) {
      expect(message, key).toMatch(/^[A-Z].*\.$/);
      expect(message, key).not.toContain('\n');
    }
  });

  it('has the words the plan quotes', () => {
    expect(LUT_MESSAGES.off).toBe('LUTs are off.');
    expect(LUT_MESSAGES.noSize).toBe('Not a LUT: there is no LUT_3D_SIZE line.');
    expect(LUT_MESSAGES.oneD).toBe('That is a 1D LUT.');
    expect(LUT_MESSAGES.builtInMissing).toBe(
      'Built-in LUTs need the colour grade. Run pnpm color-grade:install.',
    );
  });
});

describe('wire shapes', () => {
  it('parses a summary, and each field is needed', () => {
    const summary = makeLutSummary();
    expect(lutSummarySchema.parse(summary)).toEqual(summary);
    expect(lutSummarySchema.parse(makeBuiltInLutSummary())).toEqual(makeBuiltInLutSummary());
    for (const key of Object.keys(summary)) {
      const { [key as keyof LutSummary]: _gone, ...rest } = summary;
      expect(lutSummarySchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it.each([
    ['a slug with capitals', { slug: 'Golden' }],
    ['an empty name', { name: '' }],
    ['an unknown kind', { kind: 'grade' }],
    ['a grid of 1', { size: 1 }],
    ['a grid of 130', { size: 130 }],
    ['an unknown owner', { owner: 'staged' }],
    ['a negative count', { used: -1 }],
    ['an added time that is not ISO', { addedAt: 'yesterday' }],
  ])('rejects a summary with %s', (_name, patch) => {
    expect(lutSummarySchema.safeParse({ ...makeLutSummary(), ...patch }).success).toBe(false);
  });

  it('parses a detail, with a null usedIn while lutsInEdits is off', () => {
    expect(lutDetailSchema.parse(makeLutDetail())).toEqual(makeLutDetail());
    const cinematic = makeLutDetail({ file: null, bytes: null, usedIn: 4 });
    expect(lutDetailSchema.parse(cinematic)).toEqual(cinematic);
    expectTypeOf<LutDetail>().toMatchTypeOf<LutSummary>();
  });

  it('parses the list answer with Built in empty when the skill is missing', () => {
    const empty = { yours: [], builtIn: [], builtInAvailable: false };
    expect(lutListResponseSchema.parse(empty)).toEqual(empty);
    const full = {
      yours: [makeLutSummary()],
      builtIn: [makeBuiltInLutSummary()],
      builtInAvailable: true,
    };
    expect(lutListResponseSchema.parse(full)).toEqual(full);
    expect(lutListResponseSchema.safeParse({ yours: [], builtIn: [] }).success).toBe(false);
  });

  it('needs a name or a kind to update', () => {
    expect(updateLutRequestSchema.parse({ name: 'New name' })).toEqual({ name: 'New name' });
    expect(updateLutRequestSchema.parse({ kind: 'fix' })).toEqual({ kind: 'fix' });
    expect(updateLutRequestSchema.parse({ name: 'x', kind: 'camera' })).toEqual({
      name: 'x',
      kind: 'camera',
    });
    expect(updateLutRequestSchema.safeParse({}).success).toBe(false);
    expect(updateLutRequestSchema.safeParse({ kind: 'grade' }).success).toBe(false);
  });

  it('parses a stage verdict, ok or broken', () => {
    const ok = {
      id: 'f1',
      name: 'Soft pastel.cube',
      ok: true,
      error: null,
      size: 33,
      bytes: 1_468_006,
      kindGuess: 'look',
    };
    const broken = {
      id: 'f2',
      name: 'Broken export.cube',
      ok: false,
      error: LUT_MESSAGES.noSize,
      size: null,
      bytes: 120,
      kindGuess: 'look',
    };
    expect(lutStageFileSchema.parse(ok)).toEqual(ok);
    expect(lutStageFileSchema.parse(broken)).toEqual(broken);
    const response = { stageId: 'abc', files: [ok, broken] };
    expect(lutStageResponseSchema.parse(response)).toEqual(response);
  });

  it('parses an import request of 1 to 60 files, each with a kind', () => {
    const item = { id: 'f1', kind: 'camera' };
    expect(lutImportRequestSchema.parse({ stageId: 's', items: [item] })).toEqual({
      stageId: 's',
      items: [item],
    });
    expect(lutImportRequestSchema.safeParse({ stageId: 's', items: [] }).success).toBe(false);
    expect(
      lutImportRequestSchema.safeParse({
        stageId: 's',
        items: Array.from({ length: 60 }, (_, n) => ({ id: `f${n}`, kind: 'look' })),
      }).success,
    ).toBe(true);
    expect(
      lutImportRequestSchema.safeParse({
        stageId: 's',
        items: Array.from({ length: 61 }, (_, n) => ({ id: `f${n}`, kind: 'look' })),
      }).success,
    ).toBe(false);
    expect(
      lutImportRequestSchema.safeParse({ stageId: 's', items: [{ id: 'f1', kind: 'x' }] }).success,
    ).toBe(false);
  });

  it('parses an import answer', () => {
    const answer = {
      imported: [makeLutSummary({ isNew: true })],
      failed: [{ id: 'f2', error: LUT_MESSAGES.ffmpegRefused }],
    };
    expect(lutImportResponseSchema.parse(answer)).toEqual(answer);
  });

  it('parses the small answers', () => {
    expect(cancelLutStageResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(revealLutResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(deleteLutResponseSchema.parse({ ok: true, where: '/Users/a/.Trash' })).toEqual({
      ok: true,
      where: '/Users/a/.Trash',
    });
    expect(deleteLutResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });
});
