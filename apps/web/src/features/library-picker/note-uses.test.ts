import { describe, expect, it } from 'vitest';
import { type FontPickerCatalog, fontPickerCatalog } from './font-picker';
import {
  entryLabel,
  noteSavedLines,
  noteUseKey,
  type ReadNote,
  readNote,
  removeNoteUse,
  removeUseLabel,
} from './note-uses';
import { FONT_LIST, libraryItems } from './test-helpers';

// What a note names once fonts are in it (board FOReview: `parse()`, the chips' `remove`, the
// posted note's lines), over the 40 real families of the owner's library (FONT_LIST) and the sample LUTs
// and graphics. Plain functions; the markup is in LibraryUsesFonts.test.tsx.

const fonts: FontPickerCatalog = fontPickerCatalog(FONT_LIST);
const items = libraryItems();
const sources = { fonts, items };

/** The names the note's uses carry, in order. */
function usesOf(text: string, from = sources): string[] {
  return readNote(text, from).uses.map((use) => use.entry.name);
}

/** The scopes the note's fonts are for, in order. */
function scopesOf(text: string): (string | null)[] {
  return readNote(text, sources).uses.map((use) => use.scope);
}

function lines(text: string, timeLabel: string | null = '0:12'): string[] {
  return noteSavedLines(readNote(text, sources), timeLabel);
}

describe('readNote: what a text names', () => {
  it('names nothing for a text with no @, and for an empty one', () => {
    expect(readNote('just words', sources)).toEqual({
      uses: [],
      parts: [{ text: 'just words' }],
      spans: [],
      missing: [],
    });
    expect(readNote('', sources)).toEqual({ uses: [], parts: [], spans: [], missing: [] });
  });

  it('finds one font by its full name: "Make the captions @Heebo Bold "', () => {
    const read = readNote('Make the captions @Heebo Bold ', sources);
    expect(read.uses).toHaveLength(1);
    const use = read.uses[0];
    expect(use?.entry.type).toBe('font');
    expect(use?.entry.name).toBe('Heebo Bold');
    expect(use?.key).toBe('font:heebo bold');
    expect(use?.scope).toBe('captions');
  });

  it('finds two fonts, in the order they are written, each with the text it is for', () => {
    const text = 'Titles in @Rubik Black and captions in @Heebo Medium ';
    expect(usesOf(text)).toEqual(['Rubik Black', 'Heebo Medium']);
    expect(scopesOf(text)).toEqual(['titles', 'captions']);
  });

  it('names Regular by the family alone, and a longer name wins: @Heebo is not @Heebo Bold', () => {
    expect(usesOf('use @Heebo please')).toEqual(['Heebo']);
    expect(usesOf('use @Heebo Bold please')).toEqual(['Heebo Bold']);
    expect(usesOf('@Heebo and @Heebo Bold')).toEqual(['Heebo', 'Heebo Bold']);
  });

  it('reads a name without regard to case or doubled spaces, and shows it as the library has it', () => {
    expect(usesOf('the captions in @HEEBO   bold')).toEqual(['Heebo Bold']);
    expect(readNote('@heebo bold', sources).parts).toEqual([
      { text: '@heebo bold', entry: expect.objectContaining({ name: 'Heebo Bold' }) },
    ]);
  });

  it('lists a font once however often it is written, with the scope of its first mention', () => {
    const text = 'Captions in @Heebo Bold, and again the titles in @Heebo Bold';
    const read = readNote(text, sources);
    expect(read.uses).toHaveLength(1);
    expect(read.uses[0]?.scope).toBe('captions');
    expect(read.spans).toHaveLength(2);
  });

  it('finds a font in a Hebrew note, after a hyphen or a maqaf: "ל-@Heebo Bold"', () => {
    expect(usesOf('תשנה את הכתוביות ל-@Heebo Bold ')).toEqual(['Heebo Bold']);
    expect(usesOf('תשנה את הכתוביות ל־@Heebo Bold')).toEqual(['Heebo Bold']);
    expect(scopesOf('תשנה את הכתוביות ל-@Heebo Bold ')).toEqual(['captions']);
    expect(scopesOf('תשנה את הכותרות ל-@Heebo Bold ')).toEqual(['titles']);
  });

  it('is not fooled by an address: "owner@heebo.com" names nothing', () => {
    expect(usesOf('mail owner@heebo.com')).toEqual([]);
  });

  it('leaves a name the library does not have as text: "@Gotham" and "@Gotham Bold"', () => {
    for (const text of ['Make the captions @Gotham', 'Make the captions @Gotham Bold ']) {
      const read = readNote(text, sources);
      expect(read.uses, text).toEqual([]);
      expect(read.parts, text).toEqual([{ text }]);
    }
  });

  it('names fonts, LUTs and graphics together, each kind once', () => {
    const text =
      'Captions in @Heebo Bold, grade @luts/cinematic, and @graphics/follow-card at the end';
    const read = readNote(text, sources);
    expect(read.uses.map((use) => [use.entry.type, use.entry.name])).toEqual([
      ['font', 'Heebo Bold'],
      ['lut', 'Cinematic'],
      ['graphic', 'Follow card'],
    ]);
    expect(read.uses.map((use) => use.scope)).toEqual(['captions', null, null]);
    expect(read.uses.map((use) => use.key)).toEqual([
      'font:heebo bold',
      'luts/cinematic',
      'graphics/follow-card',
    ]);
  });

  it('reads a LUT after a hyphen too ("ל-@luts/cinematic"), which LU8’s reader does not', () => {
    expect(usesOf('תשים ל-@luts/cinematic')).toEqual(['Cinematic']);
  });

  it('leaves LUT and graphic tokens as text while those cannot be named (no items)', () => {
    const none = { fonts, items: [] };
    expect(usesOf('@luts/cinematic and @Heebo Bold', none)).toEqual(['Heebo Bold']);
    expect(readNote('@luts/cinematic', none).parts).toEqual([{ text: '@luts/cinematic' }]);
  });

  it('cuts the text into parts that join back into it', () => {
    const text = 'Titles in @Rubik Black and captions in @Heebo Medium please';
    const read = readNote(text, sources);
    expect(read.parts.map((part) => part.text).join('')).toBe(text);
    expect(read.parts.map((part) => ('entry' in part ? 'token' : 'text'))).toEqual([
      'text',
      'token',
      'text',
      'token',
      'text',
    ]);
    expect(read.spans.map((span) => text.slice(span.start, span.end))).toEqual([
      '@Rubik Black',
      '@Heebo Medium',
    ]);
  });

  it('gives the same item for the same face every time (a stable row for React)', () => {
    const a = readNote('@Heebo Bold', sources).uses[0]?.entry;
    const b = readNote('and @Heebo Bold again', sources).uses[0]?.entry;
    expect(a).toBe(b);
  });

  it('reads nothing when the library is not in yet (an empty catalog)', () => {
    const empty = { fonts: fontPickerCatalog(undefined), items: [] };
    expect(usesOf('Make the captions @Heebo Bold ', empty)).toEqual([]);
  });
});

describe('what a chip says', () => {
  const heebo = readNote('@Heebo Bold', sources).uses[0]?.entry;
  const lut = items.find((item) => item.type === 'lut');
  const graphic = items.find((item) => item.type === 'graphic');

  it('says a font as @Heebo Bold, and a LUT or a graphic with its @', () => {
    if (heebo === undefined || lut === undefined || graphic === undefined) throw new Error('setup');
    expect(entryLabel(heebo)).toBe('@Heebo Bold');
    expect(entryLabel(lut)).toBe('@luts/cinematic');
    expect(entryLabel(graphic)).toBe('@graphics/name-on-a-white-pill');
  });

  it('names what the × removes', () => {
    if (heebo === undefined || lut === undefined) throw new Error('setup');
    expect(removeUseLabel(heebo)).toBe('Remove @Heebo Bold from the note');
    expect(removeUseLabel(lut)).toBe('Remove @luts/cinematic from the note');
  });

  it('tells the Regular and the Bold of a family apart', () => {
    const regular = readNote('@Heebo', sources).uses[0]?.entry;
    if (heebo === undefined || regular === undefined) throw new Error('setup');
    expect(noteUseKey(regular)).not.toBe(noteUseKey(heebo));
  });
});

describe('removeNoteUse: the × of a chip', () => {
  const key = (text: string, name: string): string => {
    const use = readNote(text, sources).uses.find((one) => one.entry.name === name);
    if (use === undefined) throw new Error(`${name} is not in ${text}`);
    return use.key;
  };
  const remove = (text: string, name: string): string =>
    removeNoteUse(text, sources, key(text, name));

  it('takes the token and the one space after it', () => {
    expect(remove('Make the captions @Heebo Bold please', 'Heebo Bold')).toBe(
      'Make the captions please',
    );
    expect(remove('Make the captions @Heebo Bold ', 'Heebo Bold')).toBe('Make the captions ');
  });

  it('takes the space before it when nothing follows', () => {
    expect(remove('Make the captions @Heebo Bold', 'Heebo Bold')).toBe('Make the captions');
  });

  it('empties a note that was only the token', () => {
    expect(remove('@Heebo Bold ', 'Heebo Bold')).toBe('');
    expect(remove('@Heebo Bold', 'Heebo Bold')).toBe('');
  });

  it('takes every mention of it and leaves the other fonts', () => {
    expect(
      remove('@Heebo Bold for captions, @Rubik Black for titles, @Heebo Bold', 'Heebo Bold'),
    ).toBe('for captions, @Rubik Black for titles,');
  });

  it('removes the Regular without eating the Bold that starts with the same words', () => {
    // The board's regex would cut "@Heebo" out of "@Heebo Bold" too; positions do not.
    expect(remove('@Heebo and @Heebo Bold ', 'Heebo')).toBe('and @Heebo Bold ');
    expect(remove('@Heebo and @Heebo Bold ', 'Heebo Bold')).toBe('@Heebo and ');
  });

  it('removes a font written in a Hebrew note, and keeps the hyphen’s Hebrew', () => {
    expect(remove('תשנה את הכתוביות ל-@Heebo Bold ', 'Heebo Bold')).toBe('תשנה את הכתוביות ל-');
  });

  it('removes a LUT and a graphic the same way', () => {
    const text = 'grade @luts/cinematic and place @graphics/follow-card ';
    expect(removeNoteUse(text, sources, 'luts/cinematic')).toBe(
      'grade and place @graphics/follow-card ',
    );
    expect(removeNoteUse(text, sources, 'graphics/follow-card')).toBe(
      'grade @luts/cinematic and place ',
    );
  });

  it('changes nothing for a key the text does not name', () => {
    expect(removeNoteUse('Make it @Heebo Bold', sources, 'font:rubik black')).toBe(
      'Make it @Heebo Bold',
    );
  });
});

describe('noteSavedLines: the lines under a sent note', () => {
  it('says what the next edit does with one font, for the text it names', () => {
    expect(lines('Make the captions @Heebo Bold')).toEqual([
      'Saved. The next edit uses Heebo Bold for the captions.',
    ]);
  });

  it('says it for two fonts: "Saved…" first, then "It also…", each with its own text', () => {
    expect(lines('Titles in @Rubik Black and captions in @Heebo Medium ')).toEqual([
      'Saved. The next edit uses Rubik Black for the titles.',
      'It also uses Heebo Medium for the captions.',
    ]);
  });

  it('says "all the text it adds" for a font whose note names no text', () => {
    expect(lines('Use @Heebo Bold')).toEqual([
      'Saved. The next edit uses Heebo Bold for all the text it adds.',
    ]);
  });

  it('writes one line for a font named twice', () => {
    expect(lines('Captions in @Heebo Bold and again @Heebo Bold')).toHaveLength(1);
  });

  it('reads the scope from Hebrew words too: כתוביות and כותרות', () => {
    expect(lines('תשנה את הכתוביות ל-@Heebo Bold')).toEqual([
      'Saved. The next edit uses Heebo Bold for the captions.',
    ]);
    expect(lines('הכותרות ב-@Secular One')).toEqual([
      'Saved. The next edit uses Secular One for the titles.',
    ]);
  });

  it('keeps the words LU8 already says for a LUT and a graphic, in the same count', () => {
    expect(
      lines('Captions in @Heebo Bold, grade @luts/cinematic, place @graphics/follow-card'),
    ).toEqual([
      'Saved. The next edit uses Heebo Bold for the captions.',
      'It also uses Cinematic on the whole video.',
      'It also places Follow card at 0:12.',
    ]);
    expect(lines('@luts/cinematic')).toEqual([
      'Saved. The next edit uses Cinematic on the whole video.',
    ]);
    expect(lines('@graphics/follow-card', null)).toEqual([
      'Saved. The next edit places Follow card where it fits.',
    ]);
  });

  it('writes nothing for a note that names nothing', () => {
    expect(lines('brighter please')).toEqual([]);
    expect(lines('write to owner@heebo.com')).toEqual([]);
    expect(lines('a ל-@ b')).toEqual([]);
  });

  it('is built from a read note, so a caller reads the text once', () => {
    const read: ReadNote = readNote('Captions in @Heebo Bold', sources);
    expect(noteSavedLines(read, '0:12')).toHaveLength(1);
  });
});

// C51: a name the library does not have is saved all the same (the edit does not wait and uses the
// closest font it has); the line under the note says so, after the lines of what it does name.
describe('the lines for a font the library does not have', () => {
  const GOTHAM = 'Gotham Bold isn’t in your library, so the edit will use the closest font it has.';

  it('is one dim sentence, after the usual lines', () => {
    expect(lines('Make the title @Gotham Bold')).toEqual([GOTHAM]);
    expect(lines('Make the title @Gotham Bold and the lower third in @Secular One')).toEqual([
      'Saved. The next edit uses Secular One for the titles.',
      GOTHAM,
    ]);
  });

  it('comes after every usual line, a LUT and a graphic too, whatever the order the note writes them', () => {
    expect(
      lines('@Gotham Bold on @luts/cinematic and @graphics/follow-card, captions in @Heebo'),
    ).toEqual([
      'Saved. The next edit uses Cinematic on the whole video.',
      'It also places Follow card at 0:12.',
      'It also uses Heebo for the captions.',
      GOTHAM,
    ]);
  });

  it('is one line for each name, in the order the note writes them, once each', () => {
    expect(
      lines('Titles in @Avenir Next, captions in @Gotham Bold, and again @GOTHAM  Bold'),
    ).toEqual([
      'Avenir Next isn’t in your library, so the edit will use the closest font it has.',
      GOTHAM,
    ]);
  });

  it('says the name as written, up to three capitalised words, even with no weight word', () => {
    expect(lines('Make the captions @Gotham')).toEqual([
      'Gotham isn’t in your library, so the edit will use the closest font it has.',
    ]);
    expect(lines('titles in @Proxima Nova Bold please')).toEqual([
      'Proxima Nova Bold isn’t in your library, so the edit will use the closest font it has.',
    ]);
  });

  it('reads a name after a Hebrew hyphen too: ל-@Gotham Bold', () => {
    expect(lines('תשנה את הכתוביות ל-@Gotham Bold')).toEqual([GOTHAM]);
  });

  it('does not report a name the library resolves, @Heebo Bold Italic (Heebo Bold) included', () => {
    expect(readNote('Captions in @Heebo Bold Italic', sources).missing).toEqual([]);
    expect(lines('Captions in @Heebo Bold Italic')).toEqual([
      'Saved. The next edit uses Heebo Bold for the captions.',
    ]);
    expect(readNote('@heebo   bold and @HEEBO', sources).missing).toEqual([]);
  });

  it('does not take a LUT or a graphic for a font, found or not', () => {
    expect(
      readNote('@luts/nope and @graphics/missing and @luts/cinematic', sources).missing,
    ).toEqual([]);
    // With LUTs and graphics off (no items) their tokens are not fonts either.
    const fontsOnly = { fonts, items: [] };
    expect(
      readNote('grade @luts/cinematic, place @graphics/follow-card', fontsOnly).missing,
    ).toEqual([]);
    expect(noteSavedLines(readNote('grade @luts/cinematic', fontsOnly), '0:12')).toEqual([]);
    expect(lines('@luts/nope')).toEqual([]);
  });

  it('says nothing until the font list is in: an empty catalog cannot say what is missing', () => {
    const empty = { fonts: fontPickerCatalog(undefined), items };
    expect(readNote('Captions in @Heebo Bold', empty).missing).toEqual([]);
    expect(noteSavedLines(readNote('Captions in @Gotham Bold', empty), '0:12')).toEqual([]);
  });

  it('is in the read note for a caller that wants the names, and the LUT and font uses are as before', () => {
    const read = readNote('@Gotham Bold and @Heebo Bold', sources);
    expect(read.missing).toEqual(['Gotham Bold']);
    expect(read.uses.map((use) => use.entry.name)).toEqual(['Heebo Bold']);
    expect(read.parts.map((part) => part.text).join('')).toBe('@Gotham Bold and @Heebo Bold');
  });
});
