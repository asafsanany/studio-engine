import type { InstagramLinkableJob } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  EVERY_VIDEO_LINKED,
  JOB_SHEET_OFF,
  labelText,
  linkableJobItems,
  linkableWhen,
  type ReelMenuContext,
  type ReelMenuEntry,
  type ReelMenuSubmenu,
  reelMenuEntries,
} from './reel-menu';
import { FALCON_TIME_ZONE } from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: Date.parse('2026-10-28T10:00:00.000Z') };

const orchard: InstagramLinkableJob = {
  jobId: 'orchard-crunch',
  name: 'Orchard crunch',
  deliveredAt: '2026-10-21T10:00:00.000Z',
  stage: 'delivered',
};
const google: InstagramLinkableJob = {
  jobId: 'google-search',
  name: 'Maps Search',
  deliveredAt: '2026-10-16T10:00:00.000Z',
  stage: 'delivered',
};
const paid: InstagramLinkableJob = {
  jobId: 'old-one',
  name: 'Old one',
  deliveredAt: '2026-10-12T10:00:00.000Z',
  stage: 'paid',
};

function context(overrides: Partial<ReelMenuContext> = {}): ReelMenuContext {
  return {
    clientName: 'Falcon FPV',
    linkableJobs: [orchard, google],
    linkedJobIds: new Set(),
    admin: true,
    canOpenJob: true,
    ...overrides,
  };
}

const THEIRS = { job: null };
const OURS = { job: { id: 'job-rooftop', name: 'Rooftop Run' } };

/** Each entry in one piece of text: items by their label, a submenu as "Link to job ▸". */
function words(entries: readonly ReelMenuEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'separator') return '—';
    if (entry.type === 'submenu') return `${labelText(entry.label)} ▸`;
    return labelText(entry.label);
  });
}

function submenuOf(entries: readonly ReelMenuEntry[]): ReelMenuSubmenu {
  const found = entries.find((entry) => entry.type === 'submenu');
  if (found === undefined || found.type !== 'submenu') throw new Error('the menu has no submenu');
  return found;
}

describe('the menu of a reel with no video (board S5)', () => {
  it('is Open on Instagram, Link to job ▸ and Copy link', () => {
    expect(words(reelMenuEntries(THEIRS, context(), OPTIONS))).toEqual([
      'Open on Instagram',
      'Link to job ▸',
      'Copy link',
    ]);
  });

  it('heads the list "Delivered to <client>, not linked yet"', () => {
    const { heading } = submenuOf(reelMenuEntries(THEIRS, context(), OPTIONS));
    expect(`${heading.before}${heading.name}${heading.after}`).toBe(
      'Delivered to Falcon FPV, not linked yet',
    );
  });

  it('says "this client" until the client list has arrived', () => {
    const { heading } = submenuOf(reelMenuEntries(THEIRS, context({ clientName: null }), OPTIONS));
    expect(heading.name).toBe('this client');
  });

  it('lists the client’s videos with when they were delivered, newest first', () => {
    const { jobs } = submenuOf(
      // The page lists them newest first; the menu does not depend on it.
      reelMenuEntries(THEIRS, context({ linkableJobs: [google, orchard] }), OPTIONS),
    );
    expect(jobs).toEqual([
      { jobId: 'orchard-crunch', name: 'Orchard crunch', when: 'Delivered 21 Oct' },
      { jobId: 'google-search', name: 'Maps Search', when: 'Delivered 16 Oct' },
    ]);
  });

  it('says Paid for a video that is paid', () => {
    const { jobs } = submenuOf(
      reelMenuEntries(THEIRS, context({ linkableJobs: [orchard, paid] }), OPTIONS),
    );
    expect(jobs.map((job) => job.when)).toEqual(['Delivered 21 Oct', 'Paid 12 Oct']);
  });

  it('never offers a video that a reel links already', () => {
    const { jobs } = submenuOf(
      reelMenuEntries(THEIRS, context({ linkedJobIds: new Set(['orchard-crunch']) }), OPTIONS),
    );
    expect(jobs.map((job) => job.jobId)).toEqual(['google-search']);
  });

  it('has a disabled line that says every video is linked when none is left', () => {
    const everyLinked = submenuOf(reelMenuEntries(THEIRS, context({ linkableJobs: [] }), OPTIONS));
    expect(everyLinked.jobs).toEqual([]);
    expect(everyLinked.emptyLabel).toBe(EVERY_VIDEO_LINKED);
    expect(EVERY_VIDEO_LINKED).toBe('Every delivered video is linked');

    const allLinkedByReels = submenuOf(
      reelMenuEntries(
        THEIRS,
        context({ linkedJobIds: new Set(['orchard-crunch', 'google-search']) }),
        OPTIONS,
      ),
    );
    expect(allLinkedByReels.jobs).toEqual([]);
  });

  it('has no Link to job for an editor, who cannot link', () => {
    expect(words(reelMenuEntries(THEIRS, context({ admin: false }), OPTIONS))).toEqual([
      'Open on Instagram',
      'Copy link',
    ]);
  });
});

describe('the menu of a linked reel (board S4)', () => {
  it('is Open on Instagram, Open job, Unlink from the job, a line and Copy link', () => {
    expect(words(reelMenuEntries(OURS, context(), OPTIONS))).toEqual([
      'Open on Instagram',
      'Open job · Rooftop Run',
      'Unlink from Rooftop Run',
      '—',
      'Copy link',
    ]);
  });

  it('keeps the video’s name apart, so it keeps its own direction', () => {
    const entries = reelMenuEntries(
      { job: { id: 'job-it', name: 'סרטון אינסטגרם חוף' } },
      context(),
      OPTIONS,
    );
    const open = entries.find((entry) => entry.type === 'item' && entry.id === 'open-job');
    expect(open?.type === 'item' && open.label).toEqual({
      before: 'Open job · ',
      name: 'סרטון אינסטגרם חוף',
    });
  });

  it('has no Link to job: the reel has its video', () => {
    expect(
      reelMenuEntries(OURS, context(), OPTIONS).some((entry) => entry.type === 'submenu'),
    ).toBe(false);
  });

  it('has no Unlink for an editor, who cannot link', () => {
    expect(words(reelMenuEntries(OURS, context({ admin: false }), OPTIONS))).toEqual([
      'Open on Instagram',
      'Open job · Rooftop Run',
      '—',
      'Copy link',
    ]);
  });

  it('disables Open job, and says why, while the job sheet is off', () => {
    const entries = reelMenuEntries(OURS, context({ canOpenJob: false }), OPTIONS);
    const open = entries.find((entry) => entry.type === 'item' && entry.id === 'open-job');
    expect(open).toMatchObject({ disabled: true, disabledReason: JOB_SHEET_OFF });
    const enabled = reelMenuEntries(OURS, context(), OPTIONS).find(
      (entry) => entry.type === 'item' && entry.id === 'open-job',
    );
    expect(enabled).toMatchObject({ disabled: false });
  });
});

describe('linkableWhen and linkableJobItems', () => {
  it('writes the day of the delivery in the viewer’s zone, with its year when it is not this one', () => {
    expect(linkableWhen(orchard, OPTIONS)).toBe('Delivered 21 Oct');
    expect(linkableWhen(paid, OPTIONS)).toBe('Paid 12 Oct');
    expect(linkableWhen({ ...paid, deliveredAt: '2025-12-30T10:00:00.000Z' }, OPTIONS)).toBe(
      'Paid 30 Dec 2025',
    );
  });

  it('puts the newest delivery first without changing the list it was given', () => {
    const given = [paid, google, orchard];
    const items = linkableJobItems(given, new Set(), OPTIONS);
    expect(items.map((item) => item.jobId)).toEqual(['orchard-crunch', 'google-search', 'old-one']);
    expect(given.map((job) => job.jobId)).toEqual(['old-one', 'google-search', 'orchard-crunch']);
  });
});
