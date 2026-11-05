import { ANALYTICS_TILES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CARDS,
  ANALYTICS_SECTIONS,
  ANALYTICS_TILE_COPY,
  NO_DATA_YET,
  noteTopicsSubtitle,
} from './analytics-copy';

describe('the words of the board', () => {
  it('has a title and a subtitle for each of the five tiles, in the order of the contract', () => {
    expect(Object.keys(ANALYTICS_TILE_COPY)).toEqual(ANALYTICS_TILES.map((tile) => tile.key));
    expect(ANALYTICS_TILE_COPY['files-in-ready']).toEqual({
      title: 'Files in → ready',
      subtitle: 'Typical job, last 30 days',
    });
    expect(ANALYTICS_TILE_COPY['editing-time'].subtitle).toBe('The editor’s time on a typical job');
    expect(ANALYTICS_TILE_COPY.clients.subtitle).toBe('With a job finished, last 30 days');
  });

  it('has the titles of the twelve cards, the budgets of Claude use in the board’s order', () => {
    expect(Object.values(ANALYTICS_CARDS).map((card) => card.title)).toEqual([
      'Jobs delivered per day',
      'Footage edited per week',
      'A typical job, step by step',
      'Re-runs per approved job, by week',
      'Approved first time, by week',
      'What your notes are about',
      'API credits',
      'Max plan, this week',
      'What the API credits paid for',
      'What used the plan this week',
      'API credits and plan through the month',
      'Busiest week, last 8 weeks',
    ]);
  });

  it('says the two budgets in the Claude use subtitle', () => {
    expect(ANALYTICS_SECTIONS.claudeUse.subtitle).toBe(
      'Two budgets: API credits pay for the app’s own runs, and your Claude plan covers your Claude Code sessions',
    );
  });

  it('has the three section headings', () => {
    expect(Object.values(ANALYTICS_SECTIONS).map((section) => section.title)).toEqual([
      'Jobs',
      'Reviews',
      'Claude use',
    ]);
  });

  it('leaves no title or subtitle empty or with stray space', () => {
    const all = [
      ...Object.values(ANALYTICS_SECTIONS),
      ...Object.values(ANALYTICS_TILE_COPY),
      ...Object.values(ANALYTICS_CARDS),
    ];
    for (const { title, subtitle } of all) {
      expect(title).toBe(title.trim());
      expect(subtitle).toBe(subtitle.trim());
      expect(title.length).toBeGreaterThan(0);
      expect(subtitle.length).toBeGreaterThan(0);
    }
  });

  it('says "No data yet" for a card with nothing to show', () => {
    expect(NO_DATA_YET).toBe('No data yet');
  });
});

describe('noteTopicsSubtitle', () => {
  it('names the month of the oldest note, as the board does', () => {
    expect(noteTopicsSubtitle('2026-09-03')).toBe(
      'Your review notes since September, most common first, with who got them',
    );
    expect(noteTopicsSubtitle('2026-01-31')).toContain('since January,');
    expect(noteTopicsSubtitle('2026-12-01')).toContain('since December,');
  });

  it('leaves the month out when there are no notes yet', () => {
    expect(noteTopicsSubtitle(null)).toBe(
      'Your review notes, most common first, with who got them',
    );
    expect(noteTopicsSubtitle(null)).toBe(ANALYTICS_CARDS.noteTopics.subtitle);
  });

  it('leaves the month out for a day it cannot read', () => {
    expect(noteTopicsSubtitle('soon')).toBe(ANALYTICS_CARDS.noteTopics.subtitle);
    expect(noteTopicsSubtitle('2026-13-01')).toBe(ANALYTICS_CARDS.noteTopics.subtitle);
  });
});
