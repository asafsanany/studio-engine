import { describe, expect, it } from 'vitest';
import {
  FONT_EMPTY_LIBRARY_LIMIT,
  FONT_FAMILY_ROWS_MAX,
  type FontPickerCatalog,
  type FontPickerItem,
  fontPickerCatalog,
  heeboFaceFor,
  insertEntry,
  matchFontItems,
  type NotePickerSources,
  type NoteQuery,
  notePickerView,
  openNoteQuery,
  pointAtText,
  recentFontItems,
  usedInText,
  visibleFontFaces,
} from './font-picker';
import { moveHighlight } from './picker-items';
import { pickerKeyAction } from './picker-keys';
import { FONT_LIST, libraryItems } from './test-helpers';

// The board FOReview, sequence by sequence, as plain functions: when the box opens the picker (the
// open rule), which rows a query shows (`hits()`), what picking writes (`insert()`). The markup of
// the list and the box is in LibraryPickerFonts.test.tsx; the keys and the mouse in a real browser:
// e2e/fonts-picker.spec.ts.

const catalog: FontPickerCatalog = fontPickerCatalog(FONT_LIST);
const items = libraryItems();
const withLibrary: NotePickerSources = { fonts: catalog, items, library: true };
const fontsOnly: NotePickerSources = { fonts: catalog, items: [], library: false };

/** The query a note ends in, with the LUTs and graphics on (as in Review with both switches on). */
function query(text: string, library = true): NoteQuery {
  const found = openNoteQuery(text, library);
  if (found === null) throw new Error(`no open query in ${JSON.stringify(text)}`);
  return found;
}

/** The view for a note, or `null` when the picker is closed. */
function viewOf(text: string, sources: NotePickerSources = withLibrary) {
  const found = openNoteQuery(text, sources.library);
  return found === null ? null : notePickerView(sources, found);
}

/** The names of the rows the keys walk, in order. */
function names(text: string, sources: NotePickerSources = withLibrary): string[] {
  const view = viewOf(text, sources);
  if (view === null) throw new Error(`closed for ${JSON.stringify(text)}`);
  return view.flat.map((entry) => entry.name);
}

function fontRows(text: string, sources: NotePickerSources = withLibrary): FontPickerItem[] {
  const view = viewOf(text, sources);
  if (view === null) throw new Error(`closed for ${JSON.stringify(text)}`);
  return view.flat.filter((entry): entry is FontPickerItem => entry.type === 'font');
}

describe('the catalog', () => {
  it('has a face for every weight of the 40 families', () => {
    expect(catalog.families).toHaveLength(40);
    const faces = FONT_LIST.families.reduce((sum, family) => sum + family.weights.length, 0);
    expect(catalog.faces).toHaveLength(faces);
    expect(catalog.names.has('heebo bold')).toBe(true);
    expect(catalog.names.has('heebo')).toBe(true);
    expect(catalog.names.has('heebo bolder')).toBe(false);
  });

  it('is empty before the list has come', () => {
    const empty = fontPickerCatalog(undefined);
    expect(empty.faces).toHaveLength(0);
    expect(empty.families).toHaveLength(0);
  });

  it('leaves out a face whose family the list does not have', () => {
    const lonely = fontPickerCatalog({
      families: FONT_LIST.families.filter((family) => family.name === 'Heebo'),
      catalog: FONT_LIST.catalog.filter(
        (face) => face.family === 'Heebo' || face.family === 'Poppins',
      ),
      requests: [],
    });
    expect(new Set(lonely.faces.map((entry) => entry.face.family))).toEqual(new Set(['Heebo']));
  });
});

describe('when the box asks (the open rule)', () => {
  it('opens on "@" alone and on "@" at the start of a line', () => {
    expect(query('@')).toMatchObject({ start: 0, library: null, typed: '' });
    expect(query('one\n@')).toMatchObject({ start: 4, typed: '' });
  });

  it('opens on "@" after whitespace, a hyphen, a maqaf or "("', () => {
    for (const before of ['Make the captions ', 'ל-', 'ל־', '(', 'a\t', 'a ']) {
      const text = `${before}@hee`;
      expect(query(text), JSON.stringify(text)).toMatchObject({
        start: before.length,
        typed: 'hee',
      });
    }
  });

  it('does not open on an "@" inside a word, as in an address', () => {
    for (const text of ['owner@he', 'mail@', 'a.b@heebo', '5@he', 'ל@he']) {
      expect(openNoteQuery(text, true), text).toBeNull();
    }
  });

  it('reads the query up to the end: spaces, capitals and Hebrew letters stay', () => {
    expect(query('@Heebo Bold')).toMatchObject({ typed: 'Heebo Bold', query: 'heebo bold' });
    expect(query('תשנה את הכתוביות ל-@Heebo Bold ')).toMatchObject({ typed: 'Heebo Bold ' });
    expect(query('x @ב')).toMatchObject({ typed: 'ב' });
  });

  it('is the last "@" of the line', () => {
    expect(query('Titles in @Rubik Black and captions in @he')).toMatchObject({
      start: 'Titles in @Rubik Black and captions in '.length,
      typed: 'he',
    });
    expect(openNoteQuery('@he\nand more', true)).toBeNull();
  });

  it('closes when the query is longer than 40 characters', () => {
    expect(openNoteQuery(`@${'a'.repeat(40)}`, true)).not.toBeNull();
    expect(openNoteQuery(`@${'a'.repeat(41)}`, true)).toBeNull();
  });

  it('keeps LU7’s rule for luts/ and graphics/: letters, digits and "-" only', () => {
    expect(query('@luts/ci')).toMatchObject({ library: 'luts', query: 'ci', typed: 'ci' });
    expect(query('Make it @GRAPHICS/Na')).toMatchObject({
      library: 'graphics',
      query: 'na',
      typed: 'Na',
    });
    expect(openNoteQuery('@luts/cinematic ', true)).toBeNull();
    expect(openNoteQuery('@luts/ci!', true)).toBeNull();
    // With LUTs and graphics off there is no such library: it is a bare query.
    expect(query('@luts/ci', false)).toMatchObject({ library: null, typed: 'luts/ci' });
  });
});

describe('what a query shows (hits)', () => {
  it('"@" leads with the five most used families, each in its Bold, then 3 LUTs and 3 graphics', () => {
    const view = viewOf('@');
    expect(view?.groups.map((group) => group.head)).toEqual(['Fonts · recent', 'LUTs', 'Graphics']);
    expect(view?.groups.map((group) => group.items.length)).toEqual([
      5,
      FONT_EMPTY_LIBRARY_LIMIT,
      FONT_EMPTY_LIBRARY_LIMIT,
    ]);
    // Heebo 14 jobs, Assistant 9, Rubik 6, Secular One 3 (one weight: its Regular), then the 2s.
    expect(view?.groups[0]?.items.map((entry) => entry.name)).toEqual([
      'Heebo Bold',
      'Assistant Bold',
      'Rubik Bold',
      'Secular One',
      'Montserrat Bold',
    ]);
    expect(view?.groups[1]?.items.map((entry) => entry.name)).toEqual([
      'Cinematic',
      'Film contrast',
      'Golden warm',
    ]);
    expect(view?.flat).toHaveLength(11);
    expect(view?.none).toBeNull();
  });

  it('"@" with a space after it is the empty query too', () => {
    expect(names('@ ', withLibrary)).toEqual(names('@', withLibrary));
  });

  it('leads with the first five families A to Z, under "Fonts", before anything is used', () => {
    const unused = fontPickerCatalog({
      ...FONT_LIST,
      families: FONT_LIST.families.map((family) => ({
        ...family,
        used: 0,
        usedLabel: 'Not used yet',
      })),
    });
    const recent = recentFontItems(unused);
    expect(recent.recent).toBe(false);
    expect(recent.items.map((entry) => entry.name)).toEqual([
      'Alef Bold',
      'Amatic SC Bold',
      'Arimo Bold',
      'Assistant Bold',
      'Bellefair',
    ]);
    const view = notePickerView({ ...fontsOnly, fonts: unused }, query('@', false));
    expect(view?.groups[0]?.head).toBe('Fonts');
  });

  it('"@" with fonts only shows only the fonts', () => {
    const view = viewOf('@', fontsOnly);
    expect(view?.groups.map((group) => group.head)).toEqual(['Fonts · recent']);
    expect(view?.flat).toHaveLength(5);
  });

  it('"@he" is three families, one row each, in their Regular: Heebo first (it starts with he)', () => {
    const rows = fontRows('Make the captions @he');
    expect(rows.map((row) => row.name)).toEqual([
      'Heebo',
      'Noto Sans Hebrew',
      'IBM Plex Sans Hebrew',
    ]);
    expect(rows.every((row) => row.collapsed)).toBe(true);
    expect(rows.map((row) => row.right)).toEqual(['9 weights', '9 weights', '7 weights']);
    expect(rows.map((row) => row.insertName)).toEqual([
      'Heebo',
      'Noto Sans Hebrew',
      'IBM Plex Sans Hebrew',
    ]);
    expect(rows.map((row) => row.face.weight)).toEqual([400, 400, 400]);
  });

  it('"@heebo" is the nine faces of Heebo: Regular first, Bold second, then by weight', () => {
    const rows = fontRows('@heebo');
    expect(rows.map((row) => row.name)).toEqual([
      'Heebo',
      'Heebo Bold',
      'Heebo Thin',
      'Heebo ExtraLight',
      'Heebo Light',
      'Heebo Medium',
      'Heebo SemiBold',
      'Heebo ExtraBold',
      'Heebo Black',
    ]);
    expect(rows.every((row) => !row.collapsed)).toBe(true);
    expect(rows.map((row) => row.right)).toEqual(Array(9).fill('Hebrew + English'));
  });

  it('"@heebo b" is Bold and Black', () => {
    expect(fontRows('@heebo b').map((row) => row.name)).toEqual(['Heebo Bold', 'Heebo Black']);
  });

  it('"@Heebo Bold" is Heebo Bold alone', () => {
    expect(fontRows('@Heebo Bold').map((row) => row.name)).toEqual(['Heebo Bold']);
  });

  it('ignores case and the number of spaces', () => {
    expect(fontRows('@HEEBO   BOLD').map((row) => row.name)).toEqual(['Heebo Bold']);
    // "noto sans h" can only be Noto Sans Hebrew: one family, so its nine faces, Regular first.
    const hebrew = fontRows('@noto sans h').map((row) => row.name);
    expect(hebrew).toHaveLength(9);
    expect(hebrew.slice(0, 2)).toEqual(['Noto Sans Hebrew', 'Noto Sans Hebrew Bold']);
  });

  it('matches a word anywhere in the name, as long as each word of the query starts one', () => {
    expect(fontRows('@hebrew', fontsOnly).map((row) => row.name)).toEqual([
      'Noto Sans Hebrew',
      'IBM Plex Sans Hebrew',
    ]);
  });

  it('shows at most ten families', () => {
    const rows = fontRows('@s', fontsOnly);
    expect(rows).toHaveLength(FONT_FAMILY_ROWS_MAX);
    expect(rows.every((row) => row.collapsed)).toBe(true);
  });

  it('ranks the fonts that start with the query first, then the most used', () => {
    // Rubik (6 jobs), Rubik Glitch and Rubik Spray Paint start with "ru"; Frank Ruhl Libre has a
    // word that does (and 1 job) but starts with an F.
    expect(fontRows('@ru', fontsOnly).map((row) => row.name)).toEqual([
      'Rubik',
      'Rubik Glitch',
      'Rubik Spray Paint',
      'Frank Ruhl Libre',
    ]);
  });

  it('picks the face nearest to Regular for the family row of a family that has no Regular', () => {
    const odd = fontPickerCatalog({
      families: FONT_LIST.families.filter(
        (family) => family.name === 'Open Sans' || family.name === 'Noto Sans',
      ),
      catalog: FONT_LIST.catalog.filter(
        (face) =>
          (face.family === 'Noto Sans' || face.family === 'Open Sans') &&
          !(face.family === 'Open Sans' && face.weight === 400),
      ),
      requests: [],
    });
    const rows = matchFontItems(odd, 'sans');
    const open = rows.find((row) => row.name === 'Open Sans');
    expect(open?.collapsed).toBe(true);
    // @Open Sans would name nothing (there is no Regular): the row names the nearest face, and a
    // tie goes to the lighter one, as in the Fonts pane.
    expect(open?.insertName).toBe('Open Sans Light');
    expect(rows.find((row) => row.name === 'Noto Sans')?.insertName).toBe('Noto Sans');
  });

  it('adds the LUTs and graphics whose name or slug holds the query, up to four of each', () => {
    const view = viewOf('@lu');
    expect(view?.groups.map((group) => group.head)).toEqual(['LUTs']);
    expect(view?.groups[0]?.items).toHaveLength(4);
    const cine = viewOf('@cine');
    expect(cine?.groups.map((group) => group.head)).toContain('LUTs');
    expect(cine?.flat.map((entry) => entry.name)).toContain('Cinematic');
  });

  it('puts fonts before LUTs before graphics in the order the keys walk', () => {
    const view = viewOf('@s');
    const order = view?.groups.map((group) => group.library);
    expect(order?.indexOf('fonts')).toBe(0);
    const flat = view?.flat.map((entry) => entry.type) ?? [];
    const lastFont = flat.lastIndexOf('font');
    const firstOther = flat.findIndex((type) => type !== 'font');
    expect(firstOther === -1 || lastFont < firstOther).toBe(true);
  });

  it('"@luts/ci" is the LUTs alone, as LU8 had it', () => {
    const view = viewOf('Make it @luts/ci');
    expect(view?.groups.map((group) => group.head)).toEqual(['LUTs']);
    expect(view?.flat.map((entry) => entry.name)).toEqual(['Cinematic', 'Cinema dark']);
    expect(view?.groups[0]?.library).toBe('luts');
  });

  it('works in a Hebrew note: "ל-@he" shows the same three families', () => {
    expect(names('תשנה את הכתוביות ל-@he', fontsOnly)).toEqual([
      'Heebo',
      'Noto Sans Hebrew',
      'IBM Plex Sans Hebrew',
    ]);
    expect(names('ל־@he', fontsOnly)).toHaveLength(3);
  });
});

describe('when the list closes', () => {
  it('"@Heebo Bold and bigger" is closed: the name is done, nothing matches, and it has a space', () => {
    expect(viewOf('@Heebo Bold and bigger')).toBeNull();
  });

  it('"Make it @Heebo Bold " is closed: a space follows a complete face name', () => {
    expect(viewOf('Make it @Heebo Bold ')).toBeNull();
    expect(viewOf('@Heebo ')).toBeNull();
    expect(viewOf('@HEEBO bold ')).toBeNull();
    expect(viewOf('ל-@Heebo Bold ')).toBeNull();
  });

  it('stays open on "@Heebo Bold" without the space, and on a space after something that is not a complete name', () => {
    expect(names('@Heebo Bold')).toEqual(['Heebo Bold']);
    expect(names('@Noto ', fontsOnly)).toContain('Noto Sans Hebrew');
    expect(names('@Open ')).toContain('Open Sans');
    // "Noto Sans" is a complete name: a space after it ends the name (type on, and the list returns).
    expect(viewOf('@Noto Sans ', fontsOnly)).toBeNull();
    expect(names('@Noto Sans H', fontsOnly)).toContain('Noto Sans Hebrew');
  });

  it('"@xyz abc" is closed: it has a space and matches nothing', () => {
    expect(viewOf('@xyz abc')).toBeNull();
    expect(viewOf('@xyz ')).toBeNull();
  });

  it('"@xyz" opens the small panel: nothing matches and there is no space yet', () => {
    const view = viewOf('@xyz');
    expect(view?.flat).toHaveLength(0);
    expect(view?.groups).toHaveLength(0);
    expect(view?.none).toEqual({
      message: 'Nothing in Fonts, LUTs or Graphics is called “xyz”.',
      action: { label: 'Open Fonts to import one', to: '/fonts' },
    });
  });

  it('names only Fonts when LUTs and graphics are off', () => {
    expect(viewOf('Make the captions @Gotham', fontsOnly)?.none?.message).toBe(
      'Nothing in Fonts is called “Gotham”.',
    );
  });

  it('keeps the words of LU8 for a named library with nothing in it', () => {
    expect(viewOf('@luts/zzz')?.none).toEqual({
      message: 'No LUT called “zzz”.',
      action: { label: 'Open LUTs to import one', to: '/luts' },
    });
    expect(viewOf('@graphics/zzz')?.none?.message).toBe('No graphic called “zzz”.');
  });

  it('is closed for a text that does not end in a query', () => {
    expect(viewOf('Make the captions bigger')).toBeNull();
    expect(viewOf('')).toBeNull();
    expect(viewOf('@he\nbigger')).toBeNull();
  });
});

describe('picking', () => {
  it('writes the face’s name and a space in place of the query: "@Heebo Bold "', () => {
    const text = 'Make the captions @hee';
    const bold = fontRows('@heebo').find((row) => row.name === 'Heebo Bold');
    if (bold === undefined) throw new Error('no Heebo Bold');
    expect(insertEntry(text, query(text), bold)).toBe('Make the captions @Heebo Bold ');
  });

  it('writes "@Heebo " for Regular and for a family row', () => {
    const text = 'Make the captions @he';
    const [family] = fontRows(text);
    if (family === undefined) throw new Error('no row');
    expect(family.collapsed).toBe(true);
    expect(insertEntry(text, query(text), family)).toBe('Make the captions @Heebo ');
    const regular = fontRows('@heebo')[0];
    if (regular === undefined) throw new Error('no row');
    expect(insertEntry('@heebo', query('@heebo'), regular)).toBe('@Heebo ');
  });

  it('keeps everything before the "@", Hebrew and the hyphen included', () => {
    const text = 'תשנה את הכתוביות ל-@he';
    const [family] = fontRows(text, fontsOnly);
    if (family === undefined) throw new Error('no row');
    expect(insertEntry(text, query(text, false), family)).toBe('תשנה את הכתוביות ל-@Heebo ');
  });

  it('writes the LUT and graphic tokens as before, even after a hyphen', () => {
    const view = viewOf('ל-@lu');
    const lut = view?.flat.find((entry) => entry.type === 'lut');
    if (lut === undefined) throw new Error('no LUT');
    expect(insertEntry('ל-@lu', query('ל-@lu'), lut)).toBe('ל-@luts/cinematic ');
    const graphic = viewOf('@graphics/')?.flat[0];
    if (graphic === undefined) throw new Error('no graphic');
    expect(insertEntry('@graphics/', query('@graphics/'), graphic)).toBe(
      '@graphics/name-on-a-white-pill ',
    );
  });

  it('replaces a longer query whole, spaces and all', () => {
    const text = 'Titles in @Rubik Black and captions in @heebo b';
    const bold = fontRows(text)[0];
    if (bold === undefined) throw new Error('no row');
    expect(insertEntry(text, query(text), bold)).toBe(
      'Titles in @Rubik Black and captions in @Heebo Bold ',
    );
  });

  it('closes after the insert, the way the board does', () => {
    const text = 'Make it @Heebo Bold ';
    expect(viewOf(text)).toBeNull();
  });
});

describe('the keys and the highlight', () => {
  const key = (name: string) => ({
    key: name,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
  });

  it('↓ ↑ wrap around the rows, Enter and Tab insert, Esc closes', () => {
    const count = viewOf('@heebo')?.flat.length ?? 0;
    expect(count).toBe(9);
    expect(pickerKeyAction(key('ArrowDown'), count)).toBe('next');
    expect(moveHighlight(8, count, 1)).toBe(0);
    expect(moveHighlight(0, count, -1)).toBe(8);
    expect(pickerKeyAction(key('Enter'), count)).toBe('insert');
    expect(pickerKeyAction(key('Tab'), count)).toBe('insert');
    expect(pickerKeyAction(key('Escape'), count)).toBe('close');
  });

  it('leaves Enter and Tab to the box while the small panel shows', () => {
    const count = viewOf('@xyz')?.flat.length ?? -1;
    expect(count).toBe(0);
    expect(pickerKeyAction(key('Enter'), count)).toBeNull();
    expect(pickerKeyAction(key('Tab'), count)).toBeNull();
    expect(pickerKeyAction(key('Escape'), count)).toBe('close');
  });
});

describe('the files the open list needs', () => {
  it('are the rows’ faces, once each', () => {
    const view = viewOf('@heebo', fontsOnly);
    const faces = visibleFontFaces(view?.flat ?? [], view?.flat[0], catalog);
    expect(faces).toHaveLength(9);
    expect(new Set(faces.map((face) => face.fileId)).size).toBe(9);
  });

  it('add Heebo’s nearest weight for a highlighted font with no Hebrew', () => {
    const view = viewOf('@poppins bold', fontsOnly);
    const row = view?.flat[0];
    expect(row?.name).toBe('Poppins Bold');
    const faces = visibleFontFaces(view?.flat ?? [], row, catalog);
    expect(faces.map((face) => face.name)).toEqual(['Poppins Bold', 'Heebo Bold']);
    expect(heeboFaceFor(catalog, 690)?.name).toBe('Heebo Bold');
    expect(heeboFaceFor(fontPickerCatalog(undefined), 400)).toBeNull();
  });

  it('are nothing for LUTs and graphics', () => {
    const view = viewOf('@luts/', withLibrary);
    expect(visibleFontFaces(view?.flat ?? [], view?.flat[0], catalog)).toEqual([]);
  });
});

describe('the words', () => {
  it('says what @ points at', () => {
    expect(pointAtText(false, true)).toBe('a LUT or a graphic');
    expect(pointAtText(true, true)).toBe('a font, a LUT or a graphic');
    expect(pointAtText(true, false)).toBe('a font');
  });

  it('says how much a font was used', () => {
    expect(usedInText(0)).toBe('not used yet');
    expect(usedInText(1)).toBe('used in 1 job');
    expect(usedInText(14)).toBe('used in 14 jobs');
  });
});
