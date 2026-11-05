import { describe, expect, it } from 'vitest';
import {
  normalizeLanguage,
  tidyTranscript,
  transcriptPathFor,
  transcriptText,
  VOICE_TRANSCRIPTS_DIR,
} from './voice-transcript.js';

// Golden cases for the joining rules (see the header of voice-transcript.ts). Hebrew is written
// as UTF-8 literals; the invisible direction marks only as escapes.

const word = (text: string) => ({ text, type: 'word' });
const spacing = () => ({ text: ' ', type: 'spacing' });
const event = (text: string) => ({ text, type: 'audio_event' });

/** Words with a spacing entry between every two, as Scribe returns them. */
function spaced(...entries: { text: string; type: string }[]) {
  return entries.flatMap((entry, index) => (index === 0 ? [entry] : [spacing(), entry]));
}

describe('transcriptText', () => {
  it('joins English words and leaves spacing and audio events out', () => {
    const json = {
      text: 'The title goes (laughs) too fast.',
      words: spaced(
        word('The'),
        word('title'),
        word('goes'),
        event('(laughs)'),
        word('too'),
        word('fast.'),
      ),
    };
    expect(transcriptText(json)).toBe('The title goes too fast.');
  });

  it('joins Hebrew words with spacing entries between them', () => {
    const json = {
      language_code: 'heb',
      words: spaced(
        word('הכותרת'),
        word('יורדת'),
        word('מהר'),
        word('מדי.'),
        word('להשאיר'),
        word('אותה'),
        word('עוד'),
        word('שנייה.'),
      ),
    };
    expect(transcriptText(json)).toBe('הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.');
  });

  it('handles mixed text: a standalone comma, a Hebrew audio event, an English phrase', () => {
    const json = {
      text: 'כאן [מוזיקה קצבית] ה-CTA אומר Shop now , לא קנו עכשיו.',
      words: spaced(
        word('כאן'),
        event('[מוזיקה קצבית]'),
        word('ה-CTA'),
        word('אומר'),
        word('Shop'),
        word('now'),
        word(','),
        word('לא'),
        word('קנו'),
        word('עכשיו.'),
      ),
    };
    expect(transcriptText(json)).toBe('כאן ה-CTA אומר Shop now, לא קנו עכשיו.');
  });

  it('closes up brackets and the Hebrew maqaf', () => {
    expect(transcriptText({ words: [word('('), word('בשקט'), word(')')] })).toBe('(בשקט)');
    expect(transcriptText({ words: [word('בית־'), word('ספר')] })).toBe('בית־ספר');
    expect(
      transcriptText({ words: [word('('), word('בשקט'), word(')'), word('בית־'), word('ספר')] }),
    ).toBe('(בשקט) בית־ספר');
  });

  it('counts a missing type as a word and collapses whitespace inside tokens', () => {
    expect(transcriptText({ words: [{ text: ' שלום\n' }, { text: 'עולם' }] })).toBe('שלום עולם');
  });

  it('skips entries that are not objects and words without text', () => {
    const words = [
      null,
      3,
      'x',
      { type: 'word' },
      { text: 4, type: 'word' },
      word('  '),
      word('ok'),
    ];
    expect(transcriptText({ words })).toBe('ok');
  });

  it('removes direction marks', () => {
    const json = { words: [word('‏שלום'), word('world‎')] };
    expect(transcriptText(json)).toBe('שלום world');
  });

  it('gives an empty string, not the top-level text, when the words are only audio events', () => {
    const json = { text: '[מוזיקה]', words: [event('[מוזיקה]')] };
    expect(transcriptText(json)).toBe('');
    expect(transcriptText({ text: '(music)', words: [] })).toBe('');
  });

  it('uses the top-level text only when there is no words array', () => {
    expect(transcriptText({ text: '  Hello ,  world  ' })).toBe('Hello, world');
    expect(transcriptText({ text: 'Hello', words: 'nope' })).toBe('Hello');
    expect(transcriptText({ text: 3 })).toBe('');
    expect(transcriptText({})).toBe('');
  });

  it.each([null, [], 'x', 3, undefined])('gives an empty string for %j', (value) => {
    expect(transcriptText(value)).toBe('');
  });

  it('turns the fake transcript words back into the fake text', () => {
    const text = '[voice note, fake transcript]';
    expect(transcriptText({ words: text.split(' ').map(word) })).toBe(text);
  });

  it('does not cut a long note', () => {
    const long = Array.from({ length: 600 }, (_, i) => word(`word${i}`));
    expect(transcriptText({ words: long }).length).toBeGreaterThan(2000);
  });
});

describe('tidyTranscript', () => {
  it('normalises to NFC', () => {
    expect(tidyTranscript('é')).toBe('é');
  });

  it('leaves quotes and hyphens alone', () => {
    expect(tidyTranscript('ה-CTA "טוב" - כן')).toBe('ה-CTA "טוב" - כן');
  });

  it('removes the spaces before punctuation and after an opening bracket', () => {
    expect(tidyTranscript('a , b ; c : d ! e ? f … [ g ] { h }')).toBe('a, b; c: d! e? f… [g] {h}');
  });
});

describe('transcriptPathFor', () => {
  it('names the transcript after the recording stem, under transcripts/', () => {
    expect(transcriptPathFor('/a/n2.webm', '/j/edit/review/voice')).toBe(
      '/j/edit/review/voice/transcripts/n2.json',
    );
    expect(transcriptPathFor('/a/a.b.m4a', '/j/edit/review/voice')).toBe(
      `/j/edit/review/voice/${VOICE_TRANSCRIPTS_DIR}/a.b.json`,
    );
  });
});

describe('normalizeLanguage', () => {
  it('keeps a two-letter lower-case code', () => {
    expect(normalizeLanguage('he')).toBe('he');
  });

  it.each(['HE', 'heb', 'he-IL', '', null, undefined, 3])('turns %j into null', (value) => {
    expect(normalizeLanguage(value)).toBeNull();
  });
});
