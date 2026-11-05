import { describe, expect, it } from 'vitest';
import {
  compareWords,
  numberWords,
  ordinalWords,
  spellNumbers,
  tokens,
} from '../../assets/generate/voice-text.mjs';

// The word comparison of `make-voice.mjs check`: both the script's text and the heard words go
// through the same steps, so only a word that was really dropped, added or changed is reported.

const norms = (text: string): string[] => tokens(text).map((token) => token.norm);

describe('numberWords', () => {
  it.each([
    [0, 'zero'],
    [7, 'seven'],
    [13, 'thirteen'],
    [20, 'twenty'],
    [97, 'ninety seven'],
    [100, 'one hundred'],
    [101, 'one hundred one'],
    [999, 'nine hundred ninety nine'],
    [1000, 'one thousand'],
    [1250, 'one thousand two hundred fifty'],
    [45_000, 'forty five thousand'],
    [2_000_001, 'two million one'],
  ])('%s is %s', (n, words) => {
    expect(numberWords(n)).toBe(words);
  });

  it('is the ordinal for ordinalWords', () => {
    expect(ordinalWords(1)).toBe('first');
    expect(ordinalWords(2)).toBe('second');
    expect(ordinalWords(3)).toBe('third');
    expect(ordinalWords(4)).toBe('fourth');
    expect(ordinalWords(12)).toBe('twelfth');
    expect(ordinalWords(21)).toBe('twenty first');
    expect(ordinalWords(40)).toBe('fortieth');
  });
});

describe('tokens', () => {
  it('ignores case, punctuation, hyphens and apostrophes', () => {
    expect(norms('Don’t you KNOW what’s in your windows?!')).toEqual([
      'dont',
      'you',
      'know',
      'whats',
      'in',
      'your',
      'windows',
    ]);
  });

  it('spells numbers, money and percents the same way however they are written', () => {
    const want = ['ninety', 'seven', 'dollars'];
    expect(norms('$97')).toEqual(want);
    expect(norms('97 dollars')).toEqual(want);
    expect(norms('ninety-seven dollars')).toEqual(want);
    expect(norms('Ninety seven Dollars.')).toEqual(want);
    expect(norms('50%')).toEqual(['fifty', 'percent']);
    expect(norms('1,250')).toEqual(['one', 'thousand', 'two', 'hundred', 'fifty']);
    expect(norms('4.5')).toEqual(['four', 'point', 'five']);
    expect(norms('the 3rd')).toEqual(['the', 'third']);
    expect(spellNumbers('save $97 today').trim()).toBe('save  ninety seven dollars  today');
  });

  it('treats "one hundred and one" and "one hundred one" alike, and "and" elsewhere as a word', () => {
    expect(norms('one hundred and one')).toEqual(norms('101'));
    expect(norms('you and me')).toEqual(['you', 'and', 'me']);
    expect(norms('Doors & skylights')).toEqual(['doors', 'and', 'skylights']);
  });

  it('keeps the word as written for the report', () => {
    expect(tokens('But it gets worse.').map((token) => token.surface)).toEqual([
      'But',
      'it',
      'gets',
      'worse',
    ]);
  });

  it('reads other alphabets', () => {
    expect(norms('שלום, עולם!')).toEqual(['שלום', 'עולם']);
  });
});

describe('compareWords', () => {
  const script = 'But it gets worse, and it costs ninety-seven dollars.';

  it('matches when every word was heard, whatever the case or punctuation', () => {
    expect(
      compareWords(script, ['but', 'it', 'gets', 'worse', 'and', 'it', 'costs', '97', 'dollars']),
    ).toEqual({ match: true, missing: [], extra: [] });
    expect(compareWords('$97', ['Ninety-seven', 'dollars.']).match).toBe(true);
  });

  it('shows a dropped word in missing, as the script wrote it', () => {
    const words = ['it', 'gets', 'worse', 'and', 'it', 'costs', 'ninety-seven', 'dollars'];
    expect(compareWords(script, words)).toEqual({ match: false, missing: ['But'], extra: [] });
  });

  it('shows a word that was added in extra', () => {
    const words = ['But', 'it', 'really', 'gets', 'worse', 'and', 'it', 'costs', '$97'];
    expect(compareWords(script, words)).toEqual({ match: false, missing: [], extra: ['really'] });
  });

  it('shows a word said wrong as one missing and one extra', () => {
    const words = ['But', 'it', 'gets', 'worst', 'and', 'it', 'costs', '$97'];
    expect(compareWords(script, words)).toEqual({
      match: false,
      missing: ['worse'],
      extra: ['worst'],
    });
  });

  it('shows what is missing at the start, the end and in a run', () => {
    expect(compareWords('one two three four five', ['two', 'three'])).toEqual({
      match: false,
      missing: ['one', 'four', 'five'],
      extra: [],
    });
    expect(compareWords('one two', ['zero', 'one', 'two', 'three'])).toEqual({
      match: false,
      missing: [],
      extra: ['zero', 'three'],
    });
  });

  it('does not count a filler the speaker added, and calls silence all missing', () => {
    expect(compareWords('Hi there', ['um', 'Hi', 'uh', 'there']).match).toBe(true);
    expect(compareWords('Hi there', [])).toEqual({
      match: false,
      missing: ['Hi', 'there'],
      extra: [],
    });
    expect(compareWords('', [])).toEqual({ match: true, missing: [], extra: [] });
  });

  it('keeps a repeated word where it belongs', () => {
    expect(compareWords('no no no way', ['no', 'no', 'way'])).toEqual({
      match: false,
      missing: ['no'],
      extra: [],
    });
  });
});
