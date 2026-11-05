import { describe, expect, it } from 'vitest';
import {
  type FontScope,
  faceName,
  fontScope,
  fontScopeOfToken,
  type NoteCatalog,
  type NoteCatalogFace,
  parseLibraryTokens,
  parseNoteTokens,
  removeSpans,
  removeToken,
} from './index.ts';

const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** The faces of a family the way the index names them. */
function family(name: string, weights: number[], italics: number[] = []): NoteCatalogFace[] {
  return [
    ...weights.map((weight) => ({
      name: faceName(name, weight, false),
      family: name,
      weight,
      italic: false,
    })),
    ...italics.map((weight) => ({
      name: faceName(name, weight, true),
      family: name,
      weight,
      italic: true,
    })),
  ];
}

const catalog: NoteCatalog = {
  faces: [
    ...family('Heebo', ALL_WEIGHTS),
    ...family('Rubik', [300, 400, 500, 600, 700, 800, 900]),
    ...family('Rubik Glitch', [400]),
    ...family('Secular One', [400]),
    ...family('Poppins', ALL_WEIGHTS),
    ...family('Merriweather', [300, 400, 700], [400, 700]),
    ...family('Noto Sans', [400, 700]),
    ...family('Noto Sans Hebrew', [400, 700]),
    ...family('Open Sans', [400, 600, 700, 800]),
  ],
  luts: [{ slug: 'cinematic' }, { slug: 'golden-warm' }],
  graphics: [{ slug: 'lower-third' }],
};

/** What a text names, in short: `Heebo Bold`, `lut:cinematic`, `graphic:lower-third`. */
function names(text: string, cat: NoteCatalog = catalog): string[] {
  return parseNoteTokens(text, cat).tokens.map((token) => {
    if (token.kind === 'font') return token.face.name;
    return token.kind === 'lut' ? `lut:${token.lut.slug}` : `graphic:${token.graphic.slug}`;
  });
}

const raws = (text: string): string[] => parseNoteTokens(text, catalog).tokens.map((t) => t.raw);
const unresolved = (text: string, cat: NoteCatalog = catalog): string[] =>
  parseNoteTokens(text, cat).unresolved.map((u) => u.name);

describe('parseNoteTokens: font tokens', () => {
  // [what it checks, the text, the tokens it finds, the raw text of each token]
  const cases: [string, string, string[], string[]][] = [
    ['the family alone is the Regular face', '@Heebo', ['Heebo'], ['@Heebo']],
    ['a weight word picks the face', '@Heebo Bold and bigger', ['Heebo Bold'], ['@Heebo Bold']],
    ['no weight word: Regular, then the rest is text', '@Heebo and bigger', ['Heebo'], ['@Heebo']],
    ['a Hebrew letter and a hyphen before the @', 'ל-@Heebo Bold', ['Heebo Bold'], ['@Heebo Bold']],
    ['a maqaf before the @', 'ל־@Heebo Bold', ['Heebo Bold'], ['@Heebo Bold']],
    [
      'an opening bracket before the @',
      'the font (@Heebo Bold) please',
      ['Heebo Bold'],
      ['@Heebo Bold'],
    ],
    ['an email address is no token', 'owner@heebo.com', [], []],
    [
      'an email address with the family capitalised is no token',
      'write to owner@Heebo.com',
      [],
      [],
    ],
    [
      'two fonts in one note',
      'Titles in @Rubik Black and captions in @Heebo Medium',
      ['Rubik Black', 'Heebo Medium'],
      ['@Rubik Black', '@Heebo Medium'],
    ],
    ['a family with no weight word in its other faces', '@Poppins', ['Poppins'], ['@Poppins']],
    ['a comma ends the name', '@Heebo Bold,', ['Heebo Bold'], ['@Heebo Bold']],
    ['a full stop ends the name', 'Use @Heebo Bold.', ['Heebo Bold'], ['@Heebo Bold']],
    ['a closing bracket ends the name', '(@Heebo)', ['Heebo'], ['@Heebo']],
    ['an underscore ends the name', '@Heebo_Bold', ['Heebo'], ['@Heebo']],
    ['a hyphen ends the name', '@Heebo-Bold', ['Heebo'], ['@Heebo']],
    ['a doubled space inside the name', '@Heebo  Bold', ['Heebo Bold'], ['@Heebo  Bold']],
    ['a tab inside the name', '@Heebo\tBold', ['Heebo Bold'], ['@Heebo\tBold']],
    ['a no-break space inside the name', '@Heebo Bold', ['Heebo Bold'], ['@Heebo Bold']],
    ['a line break ends the name', '@Heebo\nBold', ['Heebo'], ['@Heebo']],
    ['upper case', '@HEEBO BOLD', ['Heebo Bold'], ['@HEEBO BOLD']],
    ['lower case', 'use @heebo bold now', ['Heebo Bold'], ['@heebo bold']],
    ['mixed case with a doubled space', '@hEEbo   bOLD', ['Heebo Bold'], ['@hEEbo   bOLD']],
    [
      'the longer name wins: Rubik Glitch over Rubik',
      '@Rubik Glitch',
      ['Rubik Glitch'],
      ['@Rubik Glitch'],
    ],
    [
      'the shorter name when the longer one is not there',
      '@Rubik Bold',
      ['Rubik Bold'],
      ['@Rubik Bold'],
    ],
    ['Rubik alone is Rubik', '@Rubik', ['Rubik'], ['@Rubik']],
    ['Rubik before a word that is no face', '@Rubik and more', ['Rubik'], ['@Rubik']],
    [
      'a name longer than the catalog has stays at the catalog',
      '@Rubik Glitch Bold',
      ['Rubik Glitch'],
      ['@Rubik Glitch'],
    ],
    ['an italic', '@Merriweather Italic', ['Merriweather Italic'], ['@Merriweather Italic']],
    [
      'a bold italic',
      '@Merriweather Bold Italic please',
      ['Merriweather Bold Italic'],
      ['@Merriweather Bold Italic'],
    ],
    ['Noto Sans is not Noto Sans Hebrew', '@Noto Sans', ['Noto Sans'], ['@Noto Sans']],
    [
      'Noto Sans Hebrew is not Noto Sans',
      '@Noto Sans Hebrew',
      ['Noto Sans Hebrew'],
      ['@Noto Sans Hebrew'],
    ],
    [
      'Noto Sans Hebrew Bold',
      '@Noto Sans Hebrew Bold',
      ['Noto Sans Hebrew Bold'],
      ['@Noto Sans Hebrew Bold'],
    ],
    ['Noto Sans Bold, not Hebrew', '@Noto Sans Bold', ['Noto Sans Bold'], ['@Noto Sans Bold']],
    ['a family of two words', '@Secular One', ['Secular One'], ['@Secular One']],
    [
      'a weight word of one word',
      '@Open Sans ExtraBold',
      ['Open Sans ExtraBold'],
      ['@Open Sans ExtraBold'],
    ],
    ['a longer word that starts with the name is not it', '@Heebo Boldly', ['Heebo'], ['@Heebo']],
    ['letters glued to the name are not it', '@HeeboBold', [], []],
    ['digits glued to the name are not it', '@Heebo2', [], []],
    [
      'a Hebrew letter glued to the name ends it',
      '@Heebo Boldבדיקה',
      ['Heebo Bold'],
      ['@Heebo Bold'],
    ],
    [
      'Hebrew text around a token',
      'תשנה את הכתוביות ל-@Heebo Bold כדי שיהיה ברור',
      ['Heebo Bold'],
      ['@Heebo Bold'],
    ],
    [
      'Hebrew text around two tokens',
      'כותרות ב-@Secular One וכתוביות ב-@Heebo Black',
      ['Secular One', 'Heebo Black'],
      ['@Secular One', '@Heebo Black'],
    ],
    [
      'the same font twice is two tokens',
      '@Heebo and @Heebo',
      ['Heebo', 'Heebo'],
      ['@Heebo', '@Heebo'],
    ],
    ['a token after a newline', 'Make it\n@Heebo Bold', ['Heebo Bold'], ['@Heebo Bold']],
    ['a token at the end of the text', 'use @Poppins Bold', ['Poppins Bold'], ['@Poppins Bold']],
    [
      'a token right after another with a hyphen between',
      '@Heebo-@Rubik',
      ['Heebo', 'Rubik'],
      ['@Heebo', '@Rubik'],
    ],
    ['a second @ glued to a name is no token', '@Heebo@Rubik', ['Heebo'], ['@Heebo']],
    [
      'a name that is a face of a family with the weight missing',
      '@Poppins Bold Italic',
      ['Poppins Bold'],
      ['@Poppins Bold'],
    ],
  ];

  it.each(cases)('%s', (_label, text, expected, expectedRaw) => {
    expect(names(text)).toEqual(expected);
    expect(raws(text)).toEqual(expectedRaw);
  });

  it('has at least 40 cases in the table', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it('gives the position of each token, from the @ to the end of the name', () => {
    const text = 'Make it @Heebo Bold now, then @Rubik.';
    const { tokens } = parseNoteTokens(text, catalog);
    expect(tokens.map(({ start, end }) => [start, end])).toEqual([
      [8, 19],
      [30, 36],
    ]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.raw);
  });

  it('gives the catalog row of the face, as it was given', () => {
    const rich = {
      faces: [
        { name: 'Heebo', family: 'Heebo', weight: 400, italic: false, file: 'Heebo-Regular.ttf' },
        { name: 'Heebo Bold', family: 'Heebo', weight: 700, italic: false, file: 'Heebo-Bold.ttf' },
      ],
    };
    const { tokens } = parseNoteTokens('x @heebo bold', rich);
    const [token] = tokens;
    expect(token?.kind).toBe('font');
    expect(token?.face?.file).toBe('Heebo-Bold.ttf');
    expect(token?.face?.weight).toBe(700);
    expect(token?.lut).toBeUndefined();
    expect(token?.graphic).toBeUndefined();
  });

  it('compares names the way fontNameKey does: a catalog name with odd spacing still matches', () => {
    const odd = {
      faces: [{ name: '  Open   Sans  Bold ', family: 'Open Sans', weight: 700, italic: false }],
    };
    expect(names('@open sans bold!', odd)).toEqual(['  Open   Sans  Bold ']);
  });

  it('is repeatable and keeps no state between calls', () => {
    expect(names('@Heebo Bold @Rubik')).toEqual(['Heebo Bold', 'Rubik']);
    expect(names('@Heebo Bold @Rubik')).toEqual(['Heebo Bold', 'Rubik']);
  });

  it('answers nothing for a text with no @, an empty text and an empty catalog', () => {
    expect(parseNoteTokens('', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(parseNoteTokens('Heebo Bold', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(names('@Heebo', {})).toEqual([]);
    expect(names('@Heebo', { faces: [], luts: [], graphics: [] })).toEqual([]);
    expect(unresolved('@Heebo', {})).toEqual(['Heebo']);
    expect(parseNoteTokens('@Heebo')).toEqual({
      tokens: [],
      unresolved: [{ kind: 'font', start: 0, end: 6, name: 'Heebo' }],
    });
  });

  it('is no token: an @ alone, an @ at the end, an @ and a space', () => {
    expect(parseNoteTokens('@', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(parseNoteTokens('Make it @', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(parseNoteTokens('@ Heebo', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(parseNoteTokens('@@Heebo', catalog)).toEqual({ tokens: [], unresolved: [] });
    expect(parseNoteTokens('Make it @\n@Heebo', catalog).tokens).toHaveLength(1);
  });
});

describe('parseNoteTokens: LUTs and graphics', () => {
  it('finds a LUT and a graphic in the catalog', () => {
    expect(names('@luts/cinematic')).toEqual(['lut:cinematic']);
    expect(names('Add @graphics/lower-third at 0:12')).toEqual(['graphic:lower-third']);
    const { tokens } = parseNoteTokens('Make it @luts/golden-warm.', catalog);
    expect(tokens).toEqual([
      { kind: 'lut', lut: { slug: 'golden-warm' }, start: 8, end: 25, raw: '@luts/golden-warm' },
    ]);
  });

  it('returns a slug that is not in the catalog as unresolved, with its prefix', () => {
    expect(parseNoteTokens('@luts/nope', catalog)).toEqual({
      tokens: [],
      unresolved: [{ kind: 'lut', start: 0, end: 10, name: 'luts/nope' }],
    });
    expect(parseNoteTokens('see @graphics/nope!', catalog).unresolved).toEqual([
      { kind: 'graphic', start: 4, end: 18, name: 'graphics/nope' },
    ]);
  });

  it('does not take a LUT slug for a graphic or the other way round', () => {
    expect(names('@graphics/cinematic')).toEqual([]);
    expect(unresolved('@graphics/cinematic')).toEqual(['graphics/cinematic']);
    expect(names('@luts/lower-third')).toEqual([]);
  });

  it('ends a slug at the first character that is not a slug character', () => {
    expect(names('@luts/cinematic, then @graphics/lower-third.')).toEqual([
      'lut:cinematic',
      'graphic:lower-third',
    ]);
    expect(names('@luts/cinematic?')).toEqual(['lut:cinematic']);
    expect(names('@luts/cinematicסרט')).toEqual(['lut:cinematic']);
  });

  it('has the same openers as a font token', () => {
    expect(names('ל-@luts/cinematic')).toEqual(['lut:cinematic']);
    expect(names('(@luts/cinematic)')).toEqual(['lut:cinematic']);
    expect(names('ל־@graphics/lower-third')).toEqual(['graphic:lower-third']);
    expect(names('mail@luts/cinematic')).toEqual([]);
    expect(unresolved('mail@luts/nope')).toEqual([]);
  });

  it('takes a slug of 60 characters and nothing longer', () => {
    const sixty = `a${'b'.repeat(59)}`;
    const long = { luts: [{ slug: sixty }] };
    expect(names(`@luts/${sixty} x`, long)).toEqual([`lut:${sixty}`]);
    expect(parseNoteTokens(`@luts/${sixty}b x`, long)).toEqual({ tokens: [], unresolved: [] });
  });

  it('names nothing for a prefix with no valid slug, and no font either', () => {
    // A lower-case "@luts" is no font name (it starts with a lower-case letter); "@LUTS/…" and
    // "@Graphics/…" are prefixes in the wrong case, which a note never means as a font.
    const texts = [
      '@luts',
      '@luts/',
      '@luts/-a',
      '@luts/Cinematic',
      '@LUTS/cinematic',
      '@Graphics/',
      '@graphics/סרט',
    ];
    for (const text of texts) {
      expect(parseNoteTokens(text, catalog), text).toEqual({ tokens: [], unresolved: [] });
    }
  });

  it('mixes the three kinds in the order they are written', () => {
    const text =
      'Make it @luts/cinematic, the captions in @Heebo Bold and @graphics/lower-third at 0:12';
    expect(names(text)).toEqual(['lut:cinematic', 'Heebo Bold', 'graphic:lower-third']);
  });

  it('reads the LUTs and graphics LU7 reads, in the same places', () => {
    const texts = [
      '@luts/cinematic',
      'Make it @luts/cinematic please',
      'Make it\n@graphics/lower-third\t@luts/golden-warm',
      'תן לזה מראה @luts/cinematic ואז @graphics/lower-third בשנייה 12',
      '@luts/cinematic, then @graphics/lower-third.',
      'x@luts/cinematic @luts/golden-warm',
    ];
    for (const text of texts) {
      const old = parseLibraryTokens(text).map((t) => [t.start, t.end]);
      const now = parseNoteTokens(text, catalog).tokens.map((t) => [t.start, t.end]);
      expect(now).toEqual(old);
    }
  });
});

describe('parseNoteTokens: names that point at nothing', () => {
  it('takes up to three capitalised words', () => {
    expect(unresolved('@Gotham Bold and bigger')).toEqual(['Gotham Bold']);
    expect(unresolved('@Gotham')).toEqual(['Gotham']);
    expect(unresolved('@Gotham Bold Italic Condensed')).toEqual(['Gotham Bold Italic']);
    expect(unresolved('@IBM Plex Sans Hebrew')).toEqual(['IBM Plex Sans']);
  });

  it('stops at the first lower-case word, punctuation or the end', () => {
    expect(unresolved('@Gotham bold')).toEqual(['Gotham']);
    expect(unresolved('@Gotham, Bold')).toEqual(['Gotham']);
    expect(unresolved('@Gotham. Bold')).toEqual(['Gotham']);
    expect(unresolved('@Gotham-Bold')).toEqual(['Gotham']);
    expect(unresolved('Make it @Gotham Bold')).toEqual(['Gotham Bold']);
    expect(unresolved('@Gotham Bold\nBig')).toEqual(['Gotham Bold']);
  });

  it('takes a digit as the start of a word', () => {
    expect(unresolved('@Gotham 2')).toEqual(['Gotham 2']);
    expect(unresolved('@42 Dots')).toEqual(['42 Dots']);
  });

  it('is no name when the first word starts with a lower-case letter', () => {
    expect(unresolved('@gotham')).toEqual([]);
    expect(unresolved('@gotham Bold')).toEqual([]);
    expect(parseNoteTokens('@gotham', catalog)).toEqual({ tokens: [], unresolved: [] });
  });

  it('says the name with single spaces and where it is written', () => {
    expect(parseNoteTokens('Use @Gotham  Bold now', catalog).unresolved).toEqual([
      { kind: 'font', start: 4, end: 17, name: 'Gotham Bold' },
    ]);
  });

  it('ends at a Hebrew letter', () => {
    expect(unresolved('ל-@Gotham Boldבדיקה')).toEqual(['Gotham Bold']);
    expect(unresolved('ל-@Gothamכתוביות')).toEqual(['Gotham']);
  });

  it('is nothing for an email address', () => {
    expect(unresolved('owner@Gotham.com')).toEqual([]);
  });

  it('keeps finding tokens after the unresolved name', () => {
    const parsed = parseNoteTokens('Titles in @Gotham Bold and captions in @Heebo Medium', catalog);
    expect(parsed.unresolved.map((u) => u.name)).toEqual(['Gotham Bold']);
    expect(parsed.tokens.map((t) => t.raw)).toEqual(['@Heebo Medium']);
  });

  it('lists an unresolved name each time it is written', () => {
    expect(unresolved('@Gotham and @Gotham')).toEqual(['Gotham', 'Gotham']);
  });

  it('tells a LUT or graphic from a font with the kind', () => {
    const parsed = parseNoteTokens('@Gotham @luts/nope @graphics/nope', catalog);
    expect(parsed.unresolved.map((u) => [u.kind, u.name])).toEqual([
      ['font', 'Gotham'],
      ['lut', 'luts/nope'],
      ['graphic', 'graphics/nope'],
    ]);
  });
});

describe('fontScope', () => {
  const cases: [string, string, string, FontScope][] = [
    ['captions before', 'Make the captions ', '', 'captions'],
    ['subtitles before', 'Make the subtitles ', '', 'captions'],
    ['a subtitle is a caption, not a title', 'the subtitle ', '', 'captions'],
    ['titles before', 'Titles in ', ' and more', 'titles'],
    ['headings before', 'Set the headings in ', '', 'titles'],
    [
      'the closer one before wins: captions after titles',
      'Titles are great, captions in ',
      '',
      'captions',
    ],
    [
      'the closer one before wins: titles after captions',
      'Captions are fine, titles in ',
      '',
      'titles',
    ],
    [
      'a caption word before beats a title word after',
      'the captions in ',
      ' not the titles',
      'captions',
    ],
    [
      'a title word before beats a caption word after',
      'the titles in ',
      ' not the captions',
      'titles',
    ],
    ['nothing before, captions after', 'Use ', ' for the captions', 'captions'],
    ['nothing before, titles after', 'Use ', ' for the titles', 'titles'],
    ['nothing before, subtitles after', 'Use ', ' for the subtitles', 'captions'],
    ['both after: the first wins (captions)', 'Use ', ' for captions and titles', 'captions'],
    ['both after: the first wins (titles)', 'Use ', ' for titles and captions', 'titles'],
    ['neither', 'Use ', ' everywhere', 'all'],
    ['an empty note', '', '', 'all'],
    ['upper case', 'THE CAPTIONS IN ', '', 'captions'],
    ['Hebrew captions before', 'תשנה את הכתוביות ל-', '', 'captions'],
    ['Hebrew titles before', 'שנה את הכותרת ל-', '', 'titles'],
    ['Hebrew captions after', 'תשתמש ב-', ' בשביל הכתוביות', 'captions'],
    ['Hebrew titles after', 'תשתמש ב-', ' בשביל הכותרות', 'titles'],
    ['Hebrew: the closer one before wins', 'כותרות גדולות, כתוביות ב-', '', 'captions'],
  ];

  it.each(cases)('%s', (_label, before, after, expected) => {
    expect(fontScope(before, after)).toBe(expected);
  });
});

describe('fontScopeOfToken', () => {
  const scopes = (text: string): FontScope[] => {
    const { tokens } = parseNoteTokens(text, catalog);
    return tokens.map((_, i) => fontScopeOfToken(text, tokens, i));
  };

  it('reads each token between its neighbours', () => {
    expect(scopes('Titles in @Rubik Black and captions in @Heebo Medium')).toEqual([
      'titles',
      'captions',
    ]);
  });

  it('reads a first token from the start and a last one to the end of the text', () => {
    expect(scopes('The captions in @Heebo Bold')).toEqual(['captions']);
    expect(scopes('@Heebo Bold for the titles')).toEqual(['titles']);
    expect(scopes('Make @Heebo Bold')).toEqual(['all']);
  });

  it('does not look past the token before it', () => {
    expect(scopes('The captions in @Heebo Bold and @Rubik Black everywhere')).toEqual([
      'captions',
      'all',
    ]);
  });

  it('treats a LUT token between two fonts as a boundary', () => {
    expect(
      scopes('Captions in @Heebo Bold, grade @luts/cinematic, then @Rubik for titles'),
    ).toEqual(['captions', 'all', 'titles']);
  });

  it('is all for a token that is not there', () => {
    expect(fontScopeOfToken('x', [], 0)).toBe('all');
  });
});

describe('removeSpans (the × of a chip, for any kind of token)', () => {
  /** The places of the tokens `parseNoteTokens` finds for one font. */
  const spansOf = (text: string, name: string) =>
    parseNoteTokens(text, catalog).tokens.filter((t) => t.kind === 'font' && t.face.name === name);

  it('takes each span and the space after it', () => {
    const text = 'Make the captions @Heebo Bold please';
    expect(removeSpans(text, spansOf(text, 'Heebo Bold'))).toBe('Make the captions please');
  });

  it('takes the space before a span that has none after it', () => {
    const text = 'Make the captions @Heebo Bold';
    expect(removeSpans(text, spansOf(text, 'Heebo Bold'))).toBe('Make the captions');
  });

  it('takes several spans, in any order, and keeps a line break', () => {
    const text = '@Heebo Bold for the captions,\n@Heebo Bold for the titles';
    const spans = spansOf(text, 'Heebo Bold');
    expect(spans).toHaveLength(2);
    expect(removeSpans(text, spans)).toBe('for the captions,\nfor the titles');
    expect(removeSpans(text, [...spans].reverse())).toBe('for the captions,\nfor the titles');
  });

  it('keeps the Hebrew and its hyphen: "ל-@Heebo Bold " becomes "ל-"', () => {
    const text = 'תשנה ל-@Heebo Bold ';
    expect(removeSpans(text, spansOf(text, 'Heebo Bold'))).toBe('תשנה ל-');
  });

  it('answers an empty text when only whitespace is left, and the text itself with no span', () => {
    expect(removeSpans('@Heebo Bold ', spansOf('@Heebo Bold ', 'Heebo Bold'))).toBe('');
    expect(removeSpans('  ', [])).toBe('  ');
    expect(removeSpans('words', [])).toBe('words');
  });

  it('is what removeToken does for a LUT (LU7’s edit, now shared)', () => {
    const text = 'grade @luts/a-b and @luts/a-b';
    expect(removeToken(text, { library: 'luts', slug: 'a-b' })).toBe('grade and');
    expect(removeToken('@luts/a ', { library: 'luts', slug: 'a' })).toBe('');
  });
});
