import { describe, expect, it } from 'vitest';
import {
  buildTopicsPrompt,
  NOTE_TEXT_MAX,
  parseTopicsAnswer,
  type TopicNote,
} from './note-topics-prompt.js';

const NOTES: TopicNote[] = [
  { id: 'n1', client: 'Kova Coffee', text: 'The intro is too long.' },
  { id: 'n2', client: 'Kova Coffee', text: 'הכותרת יורדת מהר מדי.\nלהשאיר אותה עוד שנייה. "תודה"' },
];

describe('buildTopicsPrompt', () => {
  it('gives the notes as one JSON object per line, Hebrew and line breaks intact', () => {
    const prompt = buildTopicsPrompt(NOTES, []);
    const lines = prompt.split('\n');
    const at = lines.indexOf('Notes, one JSON object per line:');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1).map((line) => JSON.parse(line))).toEqual(NOTES);
  });

  it('says what a topic is, to reuse the ones in use and what to answer with', () => {
    const prompt = buildTopicsPrompt(NOTES, ['intro too long', 'music too loud']);
    expect(prompt).toContain('2 to 4 lowercase words');
    expect(prompt).toContain('in English');
    expect(prompt).toContain('Reuse a topic from the list below whenever it fits');
    expect(prompt).toContain('[{"id":"<the note\'s id, exactly as given>","topic":"<its topic>"}]');
    expect(prompt).toContain('Topics already in use:\n- intro too long\n- music too loud\n');
  });

  it('says so when there are no topics yet', () => {
    expect(buildTopicsPrompt(NOTES, [])).toContain('Topics already in use:\n(none yet)\n');
  });

  it('cuts a long note', () => {
    const prompt = buildTopicsPrompt(
      [{ id: 'n1', client: 'A', text: 'x'.repeat(NOTE_TEXT_MAX + 100) }],
      [],
    );
    const note = JSON.parse(prompt.split('\n').at(-1) ?? '') as TopicNote;
    expect(note.text).toHaveLength(NOTE_TEXT_MAX);
  });
});

const IDS = new Set(['n1', 'n2', 'n3']);

describe('parseTopicsAnswer', () => {
  it('takes a JSON array of id and topic', () => {
    expect(
      parseTopicsAnswer(
        '[{"id":"n1","topic":"intro too long"},{"id":"n2","topic":"title timing"}]',
        IDS,
      ),
    ).toEqual({ ok: true, topics: { n1: 'intro too long', n2: 'title timing' }, dropped: 0 });
  });

  it('tidies a topic and accepts a code fence round the whole answer', () => {
    expect(
      parseTopicsAnswer('```json\n[{"id":"n1","topic":" Intro TOO long. "}]\n```', IDS),
    ).toEqual({ ok: true, topics: { n1: 'intro too long' }, dropped: 0 });
  });

  it('keeps only valid ids, once each, and counts what it dropped', () => {
    const answer = parseTopicsAnswer(
      JSON.stringify([
        { id: 'n1', topic: 'intro too long' },
        { id: 'n1', topic: 'a second topic for n1' },
        { id: 'zzz', topic: 'not in the batch' },
        { id: 'toString', topic: 'not an own id' },
        { id: 'n2', topic: 'הכותרת מהירה' },
        { id: 'n3' },
        { topic: 'no id' },
        'n3',
        null,
      ]),
      IDS,
    );
    expect(answer).toEqual({ ok: true, topics: { n1: 'intro too long' }, dropped: 8 });
  });

  it('fails on an answer that is not a JSON array', () => {
    expect(parseTopicsAnswer('Here are the topics: n1 is intro too long', IDS)).toEqual({
      ok: false,
      error: 'the answer is not JSON',
    });
    expect(parseTopicsAnswer('{"n1":"intro too long"}', IDS)).toEqual({
      ok: false,
      error: 'the answer is not a list',
    });
    expect(parseTopicsAnswer('', IDS).ok).toBe(false);
  });

  it('fails when no entry is usable', () => {
    expect(parseTopicsAnswer('[]', IDS)).toEqual({
      ok: false,
      error: 'the answer has no usable topic for these notes',
    });
    expect(parseTopicsAnswer('[{"id":"zzz","topic":"intro too long"}]', IDS).ok).toBe(false);
  });
});
