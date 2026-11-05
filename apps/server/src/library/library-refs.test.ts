import { BUILTIN_LUTS, graphicSlug } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import type { StoredGraphic, StoredLut } from '../db/index.js';
import { type LibrarySources, resolveLibraryRefs } from './library-refs.js';

function lut(overrides: Partial<StoredLut> = {}): StoredLut {
  return {
    id: 'a1b2c3d4e5f6',
    slug: 'my-look',
    name: 'My look',
    kind: 'look',
    size: 33,
    file: 'My look.cube',
    bytes: 1000,
    sha256: 'f'.repeat(64),
    sourceName: 'my_look.cube',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function graphic(overrides: Partial<StoredGraphic> = {}): StoredGraphic {
  return {
    id: '0123456789ab',
    name: 'Lower Third',
    folder: 'Lower Third',
    kind: 'lower-third',
    lengthSec: 3,
    variables: [],
    when: '',
    whenEdited: false,
    version: 2,
    uses: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const sources = (overrides: Partial<LibrarySources> = {}): LibrarySources => ({
  luts: [],
  graphics: [],
  builtIn: BUILTIN_LUTS,
  ...overrides,
});

describe('resolveLibraryRefs: LUTs', () => {
  it('finds one of Yours by its slug, with its file', () => {
    const row = lut({ kind: 'camera' });
    const refs = resolveLibraryRefs('Use @luts/my-look', sources({ luts: [row] }));
    expect(refs).toEqual({
      luts: [
        { slug: 'my-look', kind: 'camera', owner: 'yours', file: 'My look.cube', look: null, row },
      ],
      graphics: [],
      missing: [],
    });
  });

  it('finds a built-in LUT with its file in the skill', () => {
    const refs = resolveLibraryRefs('@luts/film-contrast', sources());
    expect(refs.luts).toHaveLength(1);
    expect(refs.luts[0]).toMatchObject({
      slug: 'film-contrast',
      owner: 'builtIn',
      file: 'film_contrast.cube',
      look: null,
    });
    expect(refs.luts[0]?.row).toBe(BUILTIN_LUTS.find((l) => l.slug === 'film-contrast'));
    expect(refs.missing).toEqual([]);
  });

  it('resolves the built-in Cinematic to the look, with no file', () => {
    const refs = resolveLibraryRefs('Make it @luts/cinematic', sources());
    expect(refs.luts).toHaveLength(1);
    expect(refs.luts[0]).toMatchObject({
      slug: 'cinematic',
      owner: 'builtIn',
      file: null,
      look: 'cinematic',
    });
  });

  it('takes Yours before built-in when both have the slug', () => {
    const row = lut({ slug: 'cinematic', name: 'Cinematic', file: 'Cinematic.cube' });
    const refs = resolveLibraryRefs('@luts/cinematic', sources({ luts: [row] }));
    expect(refs.luts[0]).toMatchObject({ owner: 'yours', file: 'Cinematic.cube', look: null });
  });

  it('counts a deleted LUT as missing', () => {
    const row = lut({ deletedAt: '2026-10-02T10:00:00.000Z' });
    const refs = resolveLibraryRefs('@luts/my-look', sources({ luts: [row] }));
    expect(refs).toEqual({
      luts: [],
      graphics: [],
      missing: [{ library: 'luts', slug: 'my-look' }],
    });
  });

  it('uses a live LUT when a deleted one has the same slug', () => {
    const dead = lut({ id: 'dead00000000', deletedAt: '2026-10-02T10:00:00.000Z' });
    const live = lut({ id: 'live00000000' });
    const refs = resolveLibraryRefs('@luts/my-look', sources({ luts: [dead, live] }));
    expect(refs.luts[0]?.row).toBe(live);
  });

  it('counts an unknown slug as missing, and a built-in one as missing while the grade is not installed', () => {
    expect(resolveLibraryRefs('@luts/nope', sources()).missing).toEqual([
      { library: 'luts', slug: 'nope' },
    ]);
    const refs = resolveLibraryRefs('@luts/cinematic', sources({ builtIn: [] }));
    expect(refs.luts).toEqual([]);
    expect(refs.missing).toEqual([{ library: 'luts', slug: 'cinematic' }]);
  });

  it('does not find a graphic by a LUT token, or the other way round', () => {
    const refs = resolveLibraryRefs(
      '@luts/lower-third @graphics/my-look',
      sources({ luts: [lut()], graphics: [graphic()] }),
    );
    expect(refs.luts).toEqual([]);
    expect(refs.graphics).toEqual([]);
    expect(refs.missing).toEqual([
      { library: 'luts', slug: 'lower-third' },
      { library: 'graphics', slug: 'my-look' },
    ]);
  });
});

describe('resolveLibraryRefs: graphics', () => {
  it('finds a graphic by the slug its name makes, with the version edits use', () => {
    const refs = resolveLibraryRefs(
      'Put @graphics/lower-third at 0:12',
      sources({ graphics: [graphic()] }),
    );
    expect(refs).toEqual({
      luts: [],
      graphics: [{ slug: 'lower-third', id: '0123456789ab', name: 'Lower Third', version: 2 }],
      missing: [],
    });
  });

  it('finds a graphic whose name has no Latin letters by graphic-<id>', () => {
    const g = graphic({ id: 'abcdef012345', name: 'כותרת' });
    expect(graphicSlug(g.name, g.id)).toBe('graphic-abcdef');
    const refs = resolveLibraryRefs('@graphics/graphic-abcdef', sources({ graphics: [g] }));
    expect(refs.graphics[0]).toMatchObject({ id: 'abcdef012345', name: 'כותרת' });
  });

  it('counts a deleted graphic, or one with no version yet, as missing', () => {
    const refs = resolveLibraryRefs(
      '@graphics/gone @graphics/new-graphic',
      sources({
        graphics: [
          graphic({ id: 'dead00000000', name: 'Gone', deletedAt: '2026-10-02T10:00:00.000Z' }),
          graphic({ id: 'new000000000', name: 'New graphic', version: null }),
        ],
      }),
    );
    expect(refs.graphics).toEqual([]);
    expect(refs.missing).toEqual([
      { library: 'graphics', slug: 'gone' },
      { library: 'graphics', slug: 'new-graphic' },
    ]);
  });

  it('resolves a tie by the exact name, else the oldest', () => {
    const spaced = graphic({
      id: 'aaaaaaaaaaaa',
      name: 'A B',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    const dashed = graphic({
      id: 'bbbbbbbbbbbb',
      name: 'a-b',
      createdAt: '2026-10-05T10:00:00.000Z',
    });
    expect(graphicSlug(spaced.name, spaced.id)).toBe(graphicSlug(dashed.name, dashed.id));
    // The token is exactly the second one's name, whatever the order of the rows.
    expect(
      resolveLibraryRefs('@graphics/a-b', sources({ graphics: [spaced, dashed] })).graphics[0]?.id,
    ).toBe('bbbbbbbbbbbb');
    expect(
      resolveLibraryRefs('@graphics/a-b', sources({ graphics: [dashed, spaced] })).graphics[0]?.id,
    ).toBe('bbbbbbbbbbbb');
    // Neither is exactly the slug: the older one.
    const x = graphic({ id: 'cccccccccccc', name: 'X Y', createdAt: '2026-10-03T10:00:00.000Z' });
    const y = graphic({ id: 'dddddddddddd', name: 'X  Y', createdAt: '2026-10-02T10:00:00.000Z' });
    expect(resolveLibraryRefs('@graphics/x-y', sources({ graphics: [x, y] })).graphics[0]?.id).toBe(
      'dddddddddddd',
    );
  });
});

describe('resolveLibraryRefs: the text', () => {
  it('returns each row once, in the order the text names them, and each missing token once', () => {
    const refs = resolveLibraryRefs(
      '@luts/cinematic @graphics/lower-third @luts/zzz @luts/my-look @luts/cinematic @luts/zzz @graphics/lower-third',
      sources({ luts: [lut()], graphics: [graphic()] }),
    );
    expect(refs.luts.map((l) => l.slug)).toEqual(['cinematic', 'my-look']);
    expect(refs.graphics.map((g) => g.slug)).toEqual(['lower-third']);
    expect(refs.missing).toEqual([{ library: 'luts', slug: 'zzz' }]);
  });

  it('answers empty for a text with no tokens, and ignores text that only looks like one', () => {
    const empty = { luts: [], graphics: [], missing: [] };
    expect(resolveLibraryRefs('', sources())).toEqual(empty);
    expect(resolveLibraryRefs('make it warmer', sources())).toEqual(empty);
    expect(resolveLibraryRefs('mail@luts/cinematic', sources())).toEqual(empty);
  });

  it('reads tokens in Hebrew text', () => {
    const refs = resolveLibraryRefs('תוסיף @luts/cinematic לכל הסרטון', sources());
    expect(refs.luts.map((l) => l.slug)).toEqual(['cinematic']);
  });
});
