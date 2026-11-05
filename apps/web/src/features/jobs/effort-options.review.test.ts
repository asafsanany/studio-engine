import { describe, expect, it } from 'vitest';
import {
  EFFORT_OPTIONS,
  REVIEW_EFFORT_OPTIONS,
  REVIEW_EFFORT_WORDS,
  REVIEW_ROW_EFFORT_OPTIONS,
  reviewChoiceOf,
  reviewEffortOf,
  shownEffort,
} from './effort-options';

// The Effort choices with Auto (Quick fixes; design canvas, page "Quick fixes", boards QFEffort
// and QFReview). The words are the board's, so a change here is a change of the design.

describe('REVIEW_EFFORT_OPTIONS (Review’s Effort button and the phone’s sheet)', () => {
  it('is Auto, a line, then Medium, High and Extra high, each waiting for Send', () => {
    expect(REVIEW_EFFORT_OPTIONS.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['auto', 'Auto', 'Default'],
      ['medium', 'Medium', 'waits for Send'],
      ['high', 'High', 'waits for Send'],
      ['xhigh', 'Extra high', 'waits for Send'],
    ]);
    expect(REVIEW_EFFORT_OPTIONS.filter((o) => o.separatorAfter).map((o) => o.id)).toEqual([
      'auto',
    ]);
  });

  it('says under Auto what it does, and nowhere else', () => {
    expect(REVIEW_EFFORT_OPTIONS.map((option) => option.sub)).toEqual([
      'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps its words in one place', () => {
    expect(REVIEW_EFFORT_WORDS).toEqual({
      auto: 'Auto',
      autoHint: 'Default',
      autoSub:
        'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
      levelHint: 'waits for Send',
    });
  });
});

describe('REVIEW_ROW_EFFORT_OPTIONS (the row’s Effort ▸ for a job in Review)', () => {
  it('is Auto (Default), a line, then the levels with nothing after them, as the board draws it', () => {
    expect(REVIEW_ROW_EFFORT_OPTIONS.map((o) => [o.id, o.label, o.hint, o.sub])).toEqual([
      ['auto', 'Auto', 'Default', undefined],
      ['medium', 'Medium', '', undefined],
      ['high', 'High', '', undefined],
      ['xhigh', 'Extra high', '', undefined],
    ]);
    expect(REVIEW_ROW_EFFORT_OPTIONS.filter((o) => o.separatorAfter).map((o) => o.id)).toEqual([
      'auto',
    ]);
  });
});

describe('today’s EFFORT_OPTIONS (Quick fixes off)', () => {
  it('stay Default and the three levels with their hints', () => {
    expect(EFFORT_OPTIONS.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['default', 'Default', 'Extra high'],
      ['medium', 'Medium', 'quickest'],
      ['high', 'High', 'slower'],
      ['xhigh', 'Extra high', 'slowest'],
    ]);
    expect(EFFORT_OPTIONS.some((option) => option.sub !== undefined)).toBe(false);
  });
});

describe('reviewChoiceOf / reviewEffortOf', () => {
  it('map the job’s review effort to the choice and back: null is Auto', () => {
    expect(reviewChoiceOf(null)).toBe('auto');
    expect(reviewChoiceOf('medium')).toBe('medium');
    expect(reviewChoiceOf('xhigh')).toBe('xhigh');
    expect(reviewEffortOf('auto')).toBeNull();
    expect(reviewEffortOf('high')).toBe('high');
  });

  it('refuse a choice that does not exist', () => {
    expect(() => reviewEffortOf('default')).toThrow();
  });
});

describe('shownEffort', () => {
  const job = (state: string) => ({
    state,
    effort: 'high' as const,
    reviewEffort: 'medium' as const,
  });

  it('is the review effort for a job in Review while Quick fixes are on', () => {
    expect(shownEffort(job('review'), true)).toBe('medium');
    expect(shownEffort({ ...job('review'), reviewEffort: null }, true)).toBeNull();
  });

  it('is the edit’s effort for a job in any other state, and for every job while Quick fixes are off', () => {
    expect(shownEffort(job('queued'), true)).toBe('high');
    expect(shownEffort(job('editing'), true)).toBe('high');
    expect(shownEffort(job('review'), false)).toBe('high');
  });
});
