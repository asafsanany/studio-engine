import type { AnalyticsNoteTopic } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { NO_NOTES_YET, noteTopicRows, notGroupedText } from './note-topics-view';

const topics: AnalyticsNoteTopic[] = [
  {
    topic: 'intro too long',
    count: 8,
    clients: [
      { client: 'Kova Coffee', count: 4 },
      { client: 'Arc Fitness', count: 3 },
      { client: 'Lumen Yoga', count: 1 },
    ],
  },
  {
    topic: 'logo late',
    count: 4,
    clients: [
      { client: 'Arc Fitness', count: 2 },
      { client: 'מאפיית הצפון', count: 2 },
    ],
  },
  { topic: 'volume dip', count: 1, clients: [{ client: 'מרפאת מירה', count: 1 }] },
];

describe('noteTopicRows', () => {
  const rows = noteTopicRows(topics);

  it('keeps the order it is given, with the count of each', () => {
    expect(rows.map((row) => [row.topic, row.count])).toEqual([
      ['intro too long', 8],
      ['logo late', 4],
      ['volume dip', 1],
    ]);
  });

  it('draws the bars against the biggest topic: the first is full, the rest in proportion', () => {
    expect(rows.map((row) => row.barPercent)).toEqual([100, 50, 12.5]);
  });

  it('names the clients most notes first, in the words of the board, Hebrew untouched', () => {
    expect(rows.map((row) => row.clients)).toEqual([
      'Kova Coffee, Arc Fitness, Lumen Yoga',
      'Arc Fitness, מאפיית הצפון',
      'מרפאת מירה',
    ]);
  });

  it('puts the topic, its count and each client’s count in the hover text', () => {
    expect(rows[0]?.title).toBe(
      'intro too long: 8 notes · Kova Coffee 4 · Arc Fitness 3 · Lumen Yoga 1',
    );
    expect(rows[2]?.title).toBe('volume dip: 1 note · מרפאת מירה 1');
  });

  it('rounds a bar to a tenth of a percent', () => {
    const [row] = noteTopicRows([
      { topic: 'a', count: 1, clients: [] },
      { topic: 'b', count: 3, clients: [] },
    ]);
    expect(row?.barPercent).toBe(33.3);
  });

  it('is no rows for no topics, and a topic with no client names says nothing under its bar', () => {
    expect(noteTopicRows([])).toEqual([]);
    expect(noteTopicRows([{ topic: 'logo late', count: 2, clients: [] }])[0]).toMatchObject({
      clients: '',
      barPercent: 100,
      title: 'logo late: 2 notes',
    });
  });
});

describe('notGroupedText', () => {
  it('says how many notes have no topic yet', () => {
    expect(notGroupedText(9)).toBe('9 notes not grouped yet');
    expect(notGroupedText(2)).toBe('2 notes not grouped yet');
  });

  it('says "note" for one', () => {
    expect(notGroupedText(1)).toBe('1 note not grouped yet');
  });

  it('says nothing when every note has a topic', () => {
    expect(notGroupedText(0)).toBeNull();
  });
});

describe('NO_NOTES_YET', () => {
  it('is the words of the empty state', () => {
    expect(NO_NOTES_YET).toBe('No review notes yet');
  });
});
