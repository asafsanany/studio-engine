import { describe, expect, it } from 'vitest';
import {
  graphicSlug,
  LIBRARY_TOKEN,
  libraryTokenText,
  lutSlug,
  openPickerQuery,
  parseLibraryTokens,
  removeToken,
  replacePickerQuery,
  splitByTokens,
} from './index.ts';

const slugs = (text: string, unique = false) =>
  parseLibraryTokens(text, { unique }).map((t) => `${t.library}/${t.slug}`);

describe('parseLibraryTokens', () => {
  it('finds a token at the start, with its position', () => {
    expect(parseLibraryTokens('@luts/cinematic')).toEqual([
      { library: 'luts', slug: 'cinematic', start: 0, end: 15 },
    ]);
  });

  it('finds tokens after a space and after a newline or tab', () => {
    expect(slugs('Make it @luts/cinematic please')).toEqual(['luts/cinematic']);
    expect(slugs('Make it\n@graphics/intro\t@luts/a')).toEqual(['graphics/intro', 'luts/a']);
    const [token] = parseLibraryTokens('Make it @luts/cinematic');
    expect(token).toMatchObject({ start: 8, end: 23 });
  });

  it('works in Hebrew text', () => {
    const text = 'תן לזה מראה @luts/cinematic ואז @graphics/intro בשנייה 12';
    expect(slugs(text)).toEqual(['luts/cinematic', 'graphics/intro']);
    const [first] = parseLibraryTokens(text);
    expect(text.slice(first?.start, first?.end)).toBe('@luts/cinematic');
  });

  it('ends at the first character that is not a slug character', () => {
    expect(slugs('@luts/a-b!')).toEqual(['luts/a-b']);
    expect(slugs('(@luts/a)')).toEqual([]);
    expect(slugs('@luts/a, then @graphics/b.')).toEqual(['luts/a', 'graphics/b']);
    expect(slugs('@luts/a?')).toEqual(['luts/a']);
    expect(slugs('@luts/a_b')).toEqual(['luts/a']);
    expect(slugs('@luts/a—b')).toEqual(['luts/a']);
    expect(slugs('@luts/סרט')).toEqual([]);
  });

  it('is not fooled by an email-like or glued text', () => {
    expect(slugs('mail@luts/x')).toEqual([]);
    expect(slugs('me@graphics/x and a@luts/y')).toEqual([]);
    expect(slugs('x@luts/x @luts/y')).toEqual(['luts/y']);
    expect(slugs('http://a/@luts/x')).toEqual([]);
  });

  it('needs a library name, a slash and a slug that starts with a letter or digit', () => {
    expect(slugs('@luts')).toEqual([]);
    expect(slugs('@luts/')).toEqual([]);
    expect(slugs('@luts/-a')).toEqual([]);
    expect(slugs('@fonts/a')).toEqual([]);
    expect(slugs('@LUTS/a')).toEqual([]);
    expect(slugs('@luts/Cinematic')).toEqual([]);
    expect(slugs('@luts/9')).toEqual(['luts/9']);
  });

  it('takes a slug of 60 characters and nothing longer', () => {
    const sixty = `a${'b'.repeat(59)}`;
    expect(slugs(`@luts/${sixty} x`)).toEqual([`luts/${sixty}`]);
    expect(slugs(`@luts/${sixty}b x`)).toEqual([]);
    expect(slugs(`@luts/${sixty}!`)).toEqual([`luts/${sixty}`]);
  });

  it('lists a token as often as it is written, or once with unique', () => {
    const text = '@luts/a @graphics/a @luts/a again @luts/a';
    expect(slugs(text)).toEqual(['luts/a', 'graphics/a', 'luts/a', 'luts/a']);
    expect(slugs(text, true)).toEqual(['luts/a', 'graphics/a']);
    expect(parseLibraryTokens(text, { unique: true })[0]?.start).toBe(0);
  });

  it('is repeatable (no state left in the exported regex)', () => {
    expect(LIBRARY_TOKEN.flags).toContain('g');
    expect(slugs('@luts/a @luts/b')).toEqual(['luts/a', 'luts/b']);
    expect(slugs('@luts/a @luts/b')).toEqual(['luts/a', 'luts/b']);
    expect(parseLibraryTokens('')).toEqual([]);
  });
});

describe('openPickerQuery', () => {
  it('opens on a bare @, at the start or after whitespace', () => {
    expect(openPickerQuery('@')).toEqual({ start: 0, library: null, query: '' });
    expect(openPickerQuery('Make it @')).toEqual({ start: 8, library: null, query: '' });
    expect(openPickerQuery('line\n@')).toEqual({ start: 5, library: null, query: '' });
  });

  it('reads the query typed before a library is named', () => {
    expect(openPickerQuery('@lu')).toEqual({ start: 0, library: null, query: 'lu' });
    expect(openPickerQuery('a @cin')).toEqual({ start: 2, library: null, query: 'cin' });
  });

  it('reads the library once it is named, and what follows', () => {
    expect(openPickerQuery('@luts/')).toEqual({ start: 0, library: 'luts', query: '' });
    expect(openPickerQuery('Make it @luts/cin')).toEqual({
      start: 8,
      library: 'luts',
      query: 'cin',
    });
    expect(openPickerQuery('x @graphics/na')).toEqual({
      start: 2,
      library: 'graphics',
      query: 'na',
    });
    expect(openPickerQuery('@graphics/lower-th')).toMatchObject({ query: 'lower-th' });
  });

  it('ignores case and answers in lower case', () => {
    expect(openPickerQuery('@LUTS/Cin')).toEqual({ start: 0, library: 'luts', query: 'cin' });
  });

  it('is closed when the text does not end in a query', () => {
    expect(openPickerQuery('')).toBeNull();
    expect(openPickerQuery('Make it')).toBeNull();
    expect(openPickerQuery('@ ')).toBeNull();
    expect(openPickerQuery('@luts/cinematic ')).toBeNull();
    expect(openPickerQuery('@luts/cinematic more')).toBeNull();
    expect(openPickerQuery('mail@')).toBeNull();
    expect(openPickerQuery('mail@luts/x')).toBeNull();
    expect(openPickerQuery('@fonts/x')).toBeNull();
    expect(openPickerQuery('@luts/a/b')).toBeNull();
    expect(openPickerQuery('@luts/a!')).toBeNull();
  });

  it('opens on the last @ of a text with finished tokens before it', () => {
    expect(openPickerQuery('@luts/a and @gr')).toEqual({ start: 12, library: null, query: 'gr' });
  });
});

describe('replacePickerQuery', () => {
  const at = (text: string, slug: string, library: 'luts' | 'graphics' = 'luts') => {
    const query = openPickerQuery(text);
    if (query === null) throw new Error('no open query');
    return replacePickerQuery(text, query, { library, slug });
  };

  it('puts the token and a trailing space in the query’s place', () => {
    expect(at('Make it @lu', 'cinematic')).toBe('Make it @luts/cinematic ');
  });

  it('works from a bare @, from the start, and from a library prefix', () => {
    expect(at('@', 'a')).toBe('@luts/a ');
    expect(at('Hi\n@luts/ci', 'cinematic')).toBe('Hi\n@luts/cinematic ');
    expect(at('see @graphics/na', 'name-card', 'graphics')).toBe('see @graphics/name-card ');
    expect(at('@luts/a and @gr', 'intro', 'graphics')).toBe('@luts/a and @graphics/intro ');
  });

  it('uses the current query when the one it was given is stale', () => {
    const stale = openPickerQuery('Make it @lu');
    if (stale === null) throw new Error('no open query');
    expect(
      replacePickerQuery('Hello there @ci', stale, { library: 'luts', slug: 'cinematic' }),
    ).toBe('Hello there @luts/cinematic ');
  });

  it('leaves a text with no open query alone', () => {
    const stale = openPickerQuery('@lu');
    if (stale === null) throw new Error('no open query');
    expect(replacePickerQuery('done', stale, { library: 'luts', slug: 'a' })).toBe('done');
  });

  it('makes a text whose token is found and whose picker is closed', () => {
    const text = at('x @', 'a');
    expect(slugs(text)).toEqual(['luts/a']);
    expect(openPickerQuery(text)).toBeNull();
  });
});

describe('removeToken', () => {
  const luts = (slug: string) => ({ library: 'luts' as const, slug });

  it('removes a token in the middle with the space after it', () => {
    expect(removeToken('Make it @luts/a warmer', luts('a'))).toBe('Make it warmer');
  });

  it('removes a token at the end with the space before it', () => {
    expect(removeToken('Make it @luts/a', luts('a'))).toBe('Make it');
  });

  it('removes a token at the start with the space after it', () => {
    expect(removeToken('@luts/a make it warmer', luts('a'))).toBe('make it warmer');
  });

  it('empties a text that is only the token', () => {
    expect(removeToken('@luts/a', luts('a'))).toBe('');
    expect(removeToken('@luts/a ', luts('a'))).toBe('');
    expect(removeToken('\n@luts/a', luts('a'))).toBe('');
  });

  it('keeps a newline next to the token', () => {
    expect(removeToken('one\n@luts/a', luts('a'))).toBe('one\n');
    expect(removeToken('@luts/a\ntwo', luts('a'))).toBe('\ntwo');
  });

  it('removes every copy, and only that token', () => {
    expect(removeToken('@luts/a x @luts/a y @luts/ab @graphics/a', luts('a'))).toBe(
      'x y @luts/ab @graphics/a',
    );
    expect(removeToken('@luts/a @graphics/a', { library: 'graphics', slug: 'a' })).toBe('@luts/a');
  });

  it('removes a token that ends at punctuation without touching it', () => {
    expect(removeToken('Use @luts/a, ok', luts('a'))).toBe('Use, ok');
  });

  it('leaves a text without the token as it is', () => {
    expect(removeToken('nothing here', luts('a'))).toBe('nothing here');
    expect(removeToken('mail@luts/a', luts('a'))).toBe('mail@luts/a');
    expect(removeToken('  ', luts('a'))).toBe('  ');
  });
});

describe('splitByTokens', () => {
  it('cuts text and tokens in order', () => {
    expect(splitByTokens('Make it @luts/a, then @graphics/b')).toEqual([
      { text: 'Make it ' },
      { token: { library: 'luts', slug: 'a', start: 8, end: 15 } },
      { text: ', then ' },
      { token: { library: 'graphics', slug: 'b', start: 22, end: 33 } },
    ]);
  });

  it('has no empty parts and gives the text back when joined', () => {
    for (const text of [
      '',
      '@luts/a',
      'x @luts/a',
      '@luts/a y',
      'mail@luts/a',
      '@luts/a @luts/b',
    ]) {
      const parts = splitByTokens(text);
      for (const part of parts) {
        if ('text' in part) expect(part.text).not.toBe('');
      }
      const joined = parts
        .map((p) => ('text' in p ? p.text : text.slice(p.token.start, p.token.end)))
        .join('');
      expect(joined).toBe(text);
    }
    expect(splitByTokens('')).toEqual([]);
    expect(splitByTokens('plain')).toEqual([{ text: 'plain' }]);
    expect(splitByTokens('@luts/a')).toHaveLength(1);
  });

  it('shows Hebrew around a token', () => {
    const parts = splitByTokens('שלום @luts/a');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: 'שלום ' });
  });
});

describe('libraryTokenText', () => {
  it('writes the token', () => {
    expect(libraryTokenText({ library: 'graphics', slug: 'intro' })).toBe('@graphics/intro');
  });
});

describe('graphicSlug', () => {
  it('makes a kebab-case slug from the name', () => {
    expect(graphicSlug('Lower Third', 'abc123def456')).toBe('lower-third');
    expect(graphicSlug('  Intro: Big Title!! ', 'abc123def456')).toBe('intro-big-title');
    expect(graphicSlug('Café Ñandú', 'abc123def456')).toBe('cafe-nandu');
    expect(graphicSlug('Title 2', 'abc123def456')).toBe('title-2');
  });

  it('falls back to graphic-<first 6 of the id> when the name has no letters or digits', () => {
    expect(graphicSlug('כותרת', 'ABC123def456')).toBe('graphic-abc123');
    expect(graphicSlug('!!!', '0123456789ab')).toBe('graphic-012345');
    expect(graphicSlug('', '0123456789ab')).toBe('graphic-012345');
  });

  it('cuts to 60 characters without a trailing dash', () => {
    expect(graphicSlug(`${'a'.repeat(59)} b${'c'.repeat(20)}`, 'abc123def456')).toBe(
      'a'.repeat(59),
    );
    expect(graphicSlug('x'.repeat(100), 'abc123def456')).toHaveLength(60);
  });

  it('follows the same rules as lutSlug', () => {
    for (const name of [
      'Film Contrast',
      'Sunset Amber (v2)',
      'À la carte',
      '---a---',
      'a'.repeat(80),
      'ab '.repeat(30),
      'שלום',
      'a1 b2',
      '😀 smile',
    ]) {
      expect(graphicSlug(name, 'abc123def456').replace(/^graphic-/, 'lut-')).toBe(
        lutSlug(name, 'abc123def456'),
      );
    }
  });

  it('makes a slug that is a token', () => {
    for (const name of ['Lower Third', 'x'.repeat(100), 'כותרת']) {
      const slug = graphicSlug(name, 'abc123def456');
      expect(slugs(`@graphics/${slug}`)).toEqual([`graphics/${slug}`]);
    }
  });
});
