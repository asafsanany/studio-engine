import { JOB_STATES, type Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { makeJob } from '@/data/test-utils';
import { EFFORT_OPTIONS } from './effort-options';
import { type JobMenuEntry, type RowMenuSubmenu, rowMenuEntries } from './row-menu';

// "Effort ▸" of a job's right-click menu with Quick fixes on (board "Effort with Auto", "Right-click
// a job in Review"): a job in Review sets the level of its review rounds, and starts with Auto. Any
// other job keeps today's Effort ▸ for its edit.

const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };
const run = vi.fn();

function actions() {
  return { run, busy: false, setEffort: vi.fn(), setReviewEffort: vi.fn() };
}

const reviewJob = (overrides: Partial<Job> = {}) =>
  makeJob({ id: 'r1', state: 'review', preview: PREVIEW, placeInLine: null, ...overrides });

/** The Effort ▸ entry of a job's menu, with Quick fixes `on`. */
function effortOf(job: Job, a = actions(), on = true): RowMenuSubmenu {
  const entries: JobMenuEntry[] = rowMenuEntries(
    job,
    a,
    null,
    undefined,
    undefined,
    true,
    false,
    on,
  );
  const entry = entries.find((candidate) => candidate.id === 'effort');
  if (entry?.type !== 'submenu') throw new Error('no Effort submenu in the menu');
  return entry;
}

describe('Effort ▸ for a job in Review, with Quick fixes on', () => {
  it('stays in its place, right after the note and Rename… (a review job has nothing after it), and is open', () => {
    const entries = rowMenuEntries(
      reviewJob(),
      actions(),
      null,
      undefined,
      undefined,
      true,
      false,
      true,
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      'review',
      'review-separator',
      'note',
      'rename',
      'effort',
    ]);
    expect(effortOf(reviewJob()).disabled).toBe(false);
  });

  it('offers Auto (Default), a line, then Medium, High and Extra high, as the board draws it', () => {
    const entry = effortOf(reviewJob());
    expect(entry.options.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['auto', 'Auto', 'Default'],
      ['medium', 'Medium', ''],
      ['high', 'High', ''],
      ['xhigh', 'Extra high', ''],
    ]);
    expect(entry.options.filter((o) => o.separatorAfter).map((o) => o.id)).toEqual(['auto']);
  });

  it('checks Auto and draws sparkles, with nothing at the end, for a job on Auto', () => {
    const entry = effortOf(reviewJob({ reviewEffort: null }));
    expect(entry.value).toBe('auto');
    expect(entry.icon).toBe(effortIcon('auto'));
    expect(entry.trailing).toBeNull();
  });

  it.each([
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
  ] as const)('checks %s, draws its gauge and says "%s" at the end', (reviewEffort, label) => {
    const entry = effortOf(reviewJob({ reviewEffort }));
    expect(entry.value).toBe(reviewEffort);
    expect(entry.icon).toBe(gaugeIcon(reviewEffort));
    expect(entry.trailing).toBe(label);
  });

  it('follows the review effort, not the edit’s: a job on High with Auto in Review is on Auto', () => {
    const entry = effortOf(reviewJob({ effort: 'high', reviewEffort: null }));
    expect(entry.value).toBe('auto');
    expect(entry.icon).toBe(effortIcon('auto'));
  });

  it('gives each choice its icon for the phone’s list: sparkles for Auto, a gauge per level', () => {
    const icons = effortOf(reviewJob()).options.map((option) => option.icon);
    expect(icons).toEqual([
      effortIcon('auto'),
      gaugeIcon('medium'),
      gaugeIcon('high'),
      gaugeIcon('xhigh'),
    ]);
  });

  it('writes the review effort: null for Auto, the level for a level, and not the edit’s', () => {
    const a = actions();
    const entry = effortOf(reviewJob(), a);
    entry.onValueChange('high');
    entry.onValueChange('auto');
    entry.onValueChange('xhigh');
    expect(a.setReviewEffort.mock.calls).toEqual([['high'], [null], ['xhigh']]);
    expect(a.setEffort).not.toHaveBeenCalled();
  });

  it('says a line of help for the phone’s sub-view', () => {
    expect(effortOf(reviewJob()).help).toBe(
      'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
    );
  });
});

describe('Effort ▸ for any other job, or with Quick fixes off', () => {
  it.each(JOB_STATES.filter((state) => state !== 'review'))(
    'is today’s for a job that is %s, with Quick fixes on',
    (state) => {
      const a = actions();
      const entry = effortOf(makeJob({ state, preview: PREVIEW, effort: 'high' }), a);
      expect(entry.options).toBe(EFFORT_OPTIONS);
      expect(entry.value).toBe('high');
      expect(entry.icon).toBe(gaugeIcon('high'));
      expect(entry.help).toBeUndefined();
      entry.onValueChange('default');
      expect(a.setEffort).toHaveBeenCalledWith(null);
      expect(a.setReviewEffort).not.toHaveBeenCalled();
    },
  );

  it('is today’s for a job in Review while Quick fixes are off', () => {
    const a = actions();
    const entry = effortOf(reviewJob({ effort: 'medium', reviewEffort: 'high' }), a, false);
    expect(entry.options).toBe(EFFORT_OPTIONS);
    expect(entry.value).toBe('medium');
    expect(entry.disabled).toBe(false);
    entry.onValueChange('xhigh');
    expect(a.setEffort).toHaveBeenCalledWith('xhigh');
    expect(a.setReviewEffort).not.toHaveBeenCalled();
  });

  it('is today’s for a job in Review when the caller cannot set the review effort', () => {
    const { setReviewEffort: _unused, ...withoutReview } = actions();
    const entries = rowMenuEntries(
      reviewJob(),
      withoutReview,
      null,
      undefined,
      undefined,
      true,
      false,
      true,
    );
    const entry = entries.find((candidate) => candidate.id === 'effort');
    expect(entry?.type === 'submenu' && entry.options).toBe(EFFORT_OPTIONS);
  });

  it('is left out when the caller can set neither', () => {
    const entries = rowMenuEntries(
      reviewJob(),
      { run, busy: false },
      null,
      undefined,
      undefined,
      true,
      false,
      true,
    );
    expect(entries.map((entry) => entry.id)).not.toContain('effort');
  });
});
