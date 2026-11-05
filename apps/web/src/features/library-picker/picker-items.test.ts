import { BUILTIN_LUTS, type LutListResponse, openPickerQuery } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeBuiltInLutSummary, makeGraphicSummary, makeLutSummary } from '@/data/test-utils';
import {
  clampHighlight,
  findItem,
  graphicPickerItems,
  graphicUseLine,
  itemMeta,
  lutPickerItems,
  lutPreviewAlt,
  moveHighlight,
  namedItems,
  PICKER_TEXT,
  type PickerItem,
  pickerView,
  placedLine,
  removeChipLabel,
  sentNoteLines,
  sentNoteParts,
} from './picker-items';

function builtIn(slug: string, overrides = {}) {
  const row = BUILTIN_LUTS.find((r) => r.slug === slug);
  return makeBuiltInLutSummary({
    slug,
    name: row?.name ?? slug,
    kind: row?.kind ?? 'look',
    ...overrides,
  });
}

/** The 19 built-in rows in the page's order (by name), Yours newest first. */
function library(yours = [makeLutSummary()]): LutListResponse {
  return {
    yours,
    builtIn: BUILTIN_LUTS.map((row) => builtIn(row.slug)),
    builtInAvailable: true,
  };
}

const graphics = [
  makeGraphicSummary({ id: 'a00000000001', name: 'Name on a white pill' }),
  makeGraphicSummary({
    id: 'a00000000002',
    name: 'Hours saved counter',
    kind: 'callout',
    lengthSec: 4,
  }),
  makeGraphicSummary({ id: 'a00000000003', name: 'Follow card', kind: 'end-card', lengthSec: 5 }),
  makeGraphicSummary({ id: 'a00000000004', name: 'Opening title', kind: 'title' }),
  makeGraphicSummary({ id: 'a00000000005', name: 'Fifth one', kind: 'other', lengthSec: null }),
];

function items(): PickerItem[] {
  return [...lutPickerItems(library()), ...graphicPickerItems(graphics)];
}

const query = (text: string) => {
  const q = openPickerQuery(text);
  if (q === null) throw new Error(`no query in ${text}`);
  return q;
};
const tokens = (view: ReturnType<typeof pickerView>) => view.flat.map((item) => item.token);

describe('lutPickerItems', () => {
  it('leads with Cinematic, Film contrast and Golden warm, then Yours, then the rest of Built in', () => {
    const slugs = lutPickerItems(library()).map((item) => item.slug);
    expect(slugs.slice(0, 5)).toEqual([
      'cinematic',
      'film-contrast',
      'golden-warm',
      'golden-hour-warm',
      'black-crush',
    ]);
  });

  it('leaves camera LUTs out, of Yours and of Built in', () => {
    const list = library([
      makeLutSummary({ slug: 'my-log', name: 'My log', kind: 'camera' }),
      makeLutSummary({ slug: 'fixer', name: 'Fixer', kind: 'fix' }),
    ]);
    const slugs = lutPickerItems(list).map((item) => item.slug);
    expect(slugs).not.toContain('my-log');
    expect(slugs).not.toContain('s-gamut3-to-cine');
    expect(slugs).toContain('fixer');
  });

  it('says what each is: the token, the kind, the owner, the built-in line and the preview key', () => {
    const [cinematic, , , mine] = lutPickerItems(
      library([makeLutSummary({ previewKey: 'abcd1234' })]),
    );
    expect(cinematic).toMatchObject({
      type: 'lut',
      library: 'luts',
      slug: 'cinematic',
      token: 'luts/cinematic',
      name: 'Cinematic',
      kind: 'look',
      owner: 'builtIn',
      description: 'Film contrast plus a light golden warmth.',
      previewKey: null,
    });
    expect(mine).toMatchObject({ owner: 'yours', description: '', previewKey: 'abcd1234' });
  });

  it('offers none before the list is in', () => {
    expect(lutPickerItems(undefined)).toEqual([]);
  });
});

describe('graphicPickerItems', () => {
  it('offers the ones with a version, with the token from the name', () => {
    const list = [
      ...graphics.slice(0, 1),
      makeGraphicSummary({
        id: 'b00000000001',
        name: 'Not made yet',
        version: null,
        kind: null,
        lengthSec: null,
      }),
    ];
    expect(graphicPickerItems(list)).toEqual([
      {
        type: 'graphic',
        library: 'graphics',
        slug: 'name-on-a-white-pill',
        token: 'graphics/name-on-a-white-pill',
        name: 'Name on a white pill',
        kind: 'lower-third',
        kindLabel: 'Lower third',
        lengthSec: 3,
      },
    ]);
  });

  it('gives a Hebrew name graphic-<first 6 of the id>, and keeps one of two names that make the same slug', () => {
    const list = [
      makeGraphicSummary({ id: 'abcdef012345', name: 'שלום' }),
      makeGraphicSummary({ id: 'c00000000001', name: 'Big Title' }),
      makeGraphicSummary({ id: 'c00000000002', name: 'big-title' }),
    ];
    expect(graphicPickerItems(list).map((item) => item.slug)).toEqual([
      'graphic-abcdef',
      'big-title',
    ]);
  });

  it('uses the plain "Graphic" for one with no kind', () => {
    const [item] = graphicPickerItems([makeGraphicSummary({ kind: null })]);
    expect(item).toMatchObject({ kind: 'other', kindLabel: 'Graphic' });
  });
});

describe('pickerView', () => {
  it('shows two groups of four for an empty query: LUTs, then Graphics', () => {
    const view = pickerView(items(), query('@'));
    expect(view.groups.map((g) => g.head)).toEqual(['LUTs', 'Graphics']);
    expect(tokens(view)).toEqual([
      'luts/cinematic',
      'luts/film-contrast',
      'luts/golden-warm',
      'luts/golden-hour-warm',
      'graphics/name-on-a-white-pill',
      'graphics/hours-saved-counter',
      'graphics/follow-card',
      'graphics/opening-title',
    ]);
    expect(view.none).toBeNull();
  });

  it('filters a bare query across the slug and the name, without regard to case', () => {
    expect(tokens(pickerView(items(), query('@WARM')))).toEqual([
      'luts/golden-warm',
      'luts/golden-hour-warm',
      'luts/warm-shift',
    ]);
    // A bare query reaches into the library word too: "@graph" is every graphic (4 shown).
    expect(pickerView(items(), query('@graph')).groups.map((g) => g.head)).toEqual(['Graphics']);
    expect(pickerView(items(), query('@graph')).flat).toHaveLength(4);
    // The name, not only the slug: "pill" finds the graphic, and "hours" the counter.
    expect(tokens(pickerView(items(), query('@pill')))).toEqual(['graphics/name-on-a-white-pill']);
  });

  it('shows only the LUTs for luts/, every match, in order', () => {
    const view = pickerView(items(), query('@luts/'));
    expect(view.groups.map((g) => g.head)).toEqual(['LUTs']);
    expect(view.flat).toHaveLength(items().filter((i) => i.type === 'lut').length);
    expect(view.flat.length).toBeGreaterThan(4);
  });

  it('shows only the graphics for graphics/, every match', () => {
    const view = pickerView(items(), query('@graphics/'));
    expect(view.groups.map((g) => g.head)).toEqual(['Graphics']);
    expect(view.flat).toHaveLength(5);
  });

  it('filters inside a named library by slug and by name', () => {
    expect(tokens(pickerView(items(), query('@luts/ci')))).toEqual([
      'luts/cinematic',
      'luts/cinema-dark',
    ]);
    expect(tokens(pickerView(items(), query('@luts/FILM')))).toEqual([
      'luts/film-contrast',
      'luts/studio-film',
    ]);
    expect(tokens(pickerView(items(), query('@graphics/hours')))).toEqual([
      'graphics/hours-saved-counter',
    ]);
    // "ts" is in the word "luts/", which the slug does not contain.
    expect(tokens(pickerView(items(), query('@luts/ts')))).toEqual([]);
  });

  it('leaves a group out when its library has no rows', () => {
    const onlyLuts = items().filter((i) => i.type === 'lut');
    const view = pickerView(onlyLuts, query('@'));
    expect(view.groups.map((g) => g.head)).toEqual(['LUTs']);
  });

  it('says there is no LUT called “zzz”, with the button to the LUTs page', () => {
    const view = pickerView(items(), query('Make it @luts/zzz'));
    expect(view.flat).toEqual([]);
    expect(view.none).toEqual({
      message: 'No LUT called “zzz”.',
      action: { label: 'Open LUTs to import one', to: '/luts' },
    });
  });

  it('says there is no graphic called “zzz”, with the button to the Graphics page', () => {
    const view = pickerView(items(), query('@graphics/zzz'));
    expect(view.none).toEqual({
      message: 'No graphic called “zzz”.',
      action: { label: 'Open Graphics to add one', to: '/graphics' },
    });
  });

  it('says nothing in LUTs or Graphics is called “qqq” for a bare query, with no button', () => {
    expect(pickerView(items(), query('@qqq')).none).toEqual({
      message: 'Nothing in LUTs or Graphics is called “qqq”.',
      action: null,
    });
  });

  it('has its own sentences for libraries that are empty', () => {
    expect(pickerView([], query('@')).none?.message).toBe(PICKER_TEXT.nothingYet);
    expect(pickerView([], query('@luts/')).none?.message).toBe(PICKER_TEXT.noLutsYet);
    expect(pickerView([], query('@graphics/')).none?.message).toBe(PICKER_TEXT.noGraphicsYet);
  });
});

describe('the highlight', () => {
  it('wraps around both ways', () => {
    expect(moveHighlight(0, 3, 1)).toBe(1);
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
    expect(moveHighlight(5, 3, 1)).toBe(0);
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });

  it('stays inside a list that got shorter', () => {
    expect(clampHighlight(7, 3)).toBe(2);
    expect(clampHighlight(-1, 3)).toBe(0);
    expect(clampHighlight(4, 0)).toBe(0);
  });
});

describe('namedItems', () => {
  it('lists the items a text names, once each, in the order written', () => {
    const text =
      'Use @graphics/follow-card then @luts/cinematic and @luts/cinematic again, @luts/film-contrast';
    expect(namedItems(text, items()).map((i) => i.token)).toEqual([
      'graphics/follow-card',
      'luts/cinematic',
      'luts/film-contrast',
    ]);
  });

  it('leaves out a token that points at nothing', () => {
    expect(namedItems('@luts/zzz and @luts/cinematic', items()).map((i) => i.slug)).toEqual([
      'cinematic',
    ]);
    expect(namedItems('@luts/zzz', items())).toEqual([]);
    expect(namedItems('no tokens', items())).toEqual([]);
  });

  it('does not take a token that is only part of a word', () => {
    expect(namedItems('mail@luts/cinematic', items())).toEqual([]);
  });

  it('finds an item by its reference', () => {
    expect(findItem(items(), { library: 'graphics', slug: 'follow-card' })?.name).toBe(
      'Follow card',
    );
    expect(findItem(items(), { library: 'luts', slug: 'follow-card' })).toBeUndefined();
  });
});

describe('the words', () => {
  it('says what a preview is: Look or Fix and who owns it; a graphic’s kind and length', () => {
    const all = items();
    expect(itemMeta(all[0] as PickerItem)).toBe('Look · built in');
    expect(
      itemMeta(findItem(all, { library: 'luts', slug: 'golden-hour-warm' }) as PickerItem),
    ).toBe('Look · yours');
    expect(itemMeta(findItem(all, { library: 'luts', slug: 'red-skin-fix' }) as PickerItem)).toBe(
      'Fix · built in',
    );
    expect(
      itemMeta(findItem(all, { library: 'graphics', slug: 'name-on-a-white-pill' }) as PickerItem),
    ).toBe('Lower third · 3 s');
    expect(itemMeta(findItem(all, { library: 'graphics', slug: 'fifth-one' }) as PickerItem)).toBe(
      'Graphic',
    );
  });

  it('names a chip’s × and the graphic line', () => {
    expect(removeChipLabel({ token: 'luts/cinematic' })).toBe(
      'Remove luts/cinematic from the note',
    );
    expect(graphicUseLine('0:12')).toBe('A graphic is placed at 0:12.');
  });

  it('says "where it fits" where no time is known (the Brief’s note, the note for the editor)', () => {
    expect(graphicUseLine(null)).toBe('A graphic is placed where it fits.');
    expect(placedLine('0:12')).toBe('Placed at 0:12');
    expect(placedLine(null)).toBe('Placed where it fits.');
    const cinematic = findItem(items(), { library: 'luts', slug: 'cinematic' }) as PickerItem;
    if (cinematic.type !== 'lut') throw new Error('a LUT');
    expect(lutPreviewAlt(cinematic, '0:12')).toBe(
      'Before and after: Cinematic on the frame at 0:12',
    );
    expect(lutPreviewAlt(cinematic, null)).toBe('Before and after: Cinematic on the test frame');
  });
});

describe('sent notes', () => {
  it('says a LUT applies to the whole video and a graphic is placed at the note’s time', () => {
    expect(sentNoteLines('Make it @luts/cinematic', items(), '0:12')).toEqual([
      'Saved. The next edit uses Cinematic on the whole video.',
    ]);
    expect(sentNoteLines('Add @graphics/name-on-a-white-pill', items(), '0:12')).toEqual([
      'Saved. The next edit places Name on a white pill at 0:12.',
    ]);
  });

  it('says "It also" for the second and the next', () => {
    expect(
      sentNoteLines('@luts/cinematic @graphics/follow-card @luts/film-contrast', items(), '0:07'),
    ).toEqual([
      'Saved. The next edit uses Cinematic on the whole video.',
      'It also places Follow card at 0:07.',
      'It also uses Film contrast on the whole video.',
    ]);
  });

  it('says a graphic goes where it fits when the note has no time', () => {
    expect(sentNoteLines('@luts/cinematic @graphics/follow-card', items(), null)).toEqual([
      'Saved. The next edit uses Cinematic on the whole video.',
      'It also places Follow card where it fits.',
    ]);
    expect(sentNoteLines('@graphics/follow-card', items(), null)).toEqual([
      'Saved. The next edit places Follow card where it fits.',
    ]);
  });

  it('has no line for a note that names nothing, or only things that are gone', () => {
    expect(sentNoteLines('Make it brighter', items(), '0:12')).toEqual([]);
    expect(sentNoteLines('@luts/zzz', items(), '0:12')).toEqual([]);
  });

  it('cuts the text into text and chips, and the parts join back to the text', () => {
    const text = 'Make it @luts/cinematic, then @luts/zzz please';
    const parts = sentNoteParts(text, items());
    expect(parts.map((p) => ('item' in p ? `[${p.item.token}]` : p.text))).toEqual([
      'Make it ',
      '[luts/cinematic]',
      ', then @luts/zzz please',
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(text);
  });

  it('is one part for a note with no chip', () => {
    expect(sentNoteParts('just words', items())).toEqual([{ text: 'just words' }]);
    expect(sentNoteParts('', items())).toEqual([]);
  });
});
