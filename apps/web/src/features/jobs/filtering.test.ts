import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { STATUS_TABS } from '@/stores/jobs-ui';
import { filterJobs, matchesSearch, matchesTab, tabCounts } from './filtering';
import { CANVAS_JOBS, DELIVERY_ROW_JOBS, REVIEW_ROW_JOBS } from './test-jobs';

const ids = (jobs: readonly { id: string }[]) => jobs.map((j) => j.id);

describe('matchesSearch', () => {
  const job = makeJob({ name: 'Spring Menu', client: 'Northwind Bakery' });

  it('matches everything for an empty or blank query', () => {
    expect(matchesSearch(job, '')).toBe(true);
    expect(matchesSearch(job, '   ')).toBe(true);
  });

  it('finds the job name, case-insensitively', () => {
    expect(matchesSearch(job, 'spring')).toBe(true);
    expect(matchesSearch(job, 'SPRING MENU')).toBe(true);
    expect(matchesSearch(job, 'ring me')).toBe(true);
  });

  it('finds the client, case-insensitively', () => {
    expect(matchesSearch(job, 'northwind')).toBe(true);
    expect(matchesSearch(job, 'BAKERY')).toBe(true);
  });

  it('needs every word to be somewhere in the name or the client', () => {
    expect(matchesSearch(job, 'bakery spring')).toBe(true);
    expect(matchesSearch(job, 'spring bakery coffee')).toBe(false);
  });

  it('does not search the other fields', () => {
    expect(matchesSearch(job, 'queued')).toBe(false);
    expect(matchesSearch(job, job.id)).toBe(false);
  });

  it('works for Hebrew names and clients', () => {
    const hebrew = makeJob({ name: 'סרטון גיוס – Hiring video', client: 'מאפיית הצפון' });
    expect(matchesSearch(hebrew, 'גיוס')).toBe(true);
    expect(matchesSearch(hebrew, 'מאפיית')).toBe(true);
    expect(matchesSearch(hebrew, 'hiring')).toBe(true);
    expect(matchesSearch(hebrew, 'HIRING גיוס')).toBe(true);
    expect(matchesSearch(hebrew, 'ירושלים')).toBe(false);
  });

  it('ignores Hebrew vowel points and invisible direction marks', () => {
    const pointed = makeJob({ name: 'שָׁלוֹם', client: 'Kova' });
    expect(matchesSearch(pointed, 'שלום')).toBe(true);
    expect(matchesSearch(makeJob({ name: 'שלום', client: 'Kova' }), 'שָׁלוֹם')).toBe(true);
    expect(matchesSearch(makeJob({ name: 'Arc\u200F Fitness', client: 'X' }), 'arc fitness')).toBe(
      true,
    );
    expect(matchesSearch(makeJob({ name: 'Arc\u200FFitness', client: 'X' }), 'arcfitness')).toBe(
      true,
    );
  });

  it('finds a mixed name by its whole title, with the dash typed as a plain hyphen', () => {
    const mixed = makeJob({ name: 'סרטון גיוס – Hiring video', client: 'מאפיית הצפון' });
    expect(matchesSearch(mixed, 'סרטון גיוס – Hiring video')).toBe(true);
    expect(matchesSearch(mixed, 'גיוס - hiring')).toBe(true);
    expect(matchesSearch(mixed, 'גיוס \u2014 hiring')).toBe(true);
    expect(matchesSearch(makeJob({ name: 'Q4 - plan', client: 'X' }), 'q4 \u2013 plan')).toBe(true);
    expect(matchesSearch(makeJob({ name: 'עין־גדי', client: 'X' }), 'עין-גדי')).toBe(true);
  });

  it('treats look-alike apostrophes and quotes as the same (geresh, gershayim, curly)', () => {
    expect(matchesSearch(makeJob({ name: "ג'ינס", client: 'X' }), 'ג\u05F3ינס')).toBe(true);
    expect(matchesSearch(makeJob({ name: 'ג\u05F3ינס', client: 'X' }), "ג'ינס")).toBe(true);
    expect(matchesSearch(makeJob({ name: 'צה"ל', client: 'X' }), 'צה\u05F4ל')).toBe(true);
    expect(matchesSearch(makeJob({ name: "Joe's cafe", client: 'X' }), 'joe\u2019s')).toBe(true);
  });

  it('still tells different words apart', () => {
    const mixed = makeJob({ name: 'סרטון גיוס – Hiring video', client: 'מאפיית הצפון' });
    expect(matchesSearch(mixed, 'סרטון תדמית')).toBe(false);
    expect(matchesSearch(mixed, 'hiring videos')).toBe(false);
  });

  it('treats composed and decomposed accents alike', () => {
    expect(matchesSearch(makeJob({ name: 'Cafe\u0301 tour', client: 'X' }), 'caf\u00E9')).toBe(
      true,
    );
  });
});

describe('matchesTab', () => {
  it('All takes every state', () => {
    for (const job of CANVAS_JOBS) expect(matchesTab(job, 'all')).toBe(true);
  });

  it('matches a review job under All and Review only', () => {
    const review = makeJob({ state: 'review', step: 7, placeInLine: null });
    expect(matchesTab(review, 'all')).toBe(true);
    expect(matchesTab(review, 'review')).toBe(true);
    for (const tab of STATUS_TABS.filter((tab) => tab !== 'all' && tab !== 'review')) {
      expect(matchesTab(review, tab), tab).toBe(false);
    }
  });

  it('sorts states into the groups: a ready job is Approved until it is delivered', () => {
    const states = (tab: 'progress' | 'review' | 'approved' | 'delivered' | 'paid' | 'attention') =>
      [...new Set(CANVAS_JOBS.filter((j) => matchesTab(j, tab)).map((j) => j.state))].sort();
    expect(states('progress')).toEqual(['arriving', 'editing', 'queued']);
    expect(states('review')).toEqual([]);
    expect(states('approved')).toEqual(['ready']);
    expect(states('delivered')).toEqual([]);
    expect(states('paid')).toEqual([]);
    expect(states('attention')).toEqual(['cancelled', 'failed', 'held']);
  });

  it('puts a ready job under the tab of its stage, and nowhere else', () => {
    const tabsOf = (id: string) => {
      const job = DELIVERY_ROW_JOBS.find((candidate) => candidate.id === id);
      if (!job) throw new Error(`no job ${id}`);
      return STATUS_TABS.filter((tab) => matchesTab(job, tab));
    };
    expect(tabsOf('d3')).toEqual(['all', 'approved']);
    expect(tabsOf('d6')).toEqual(['all', 'delivered']);
    expect(tabsOf('d9')).toEqual(['all', 'paid']);
  });

  it('puts a delivered job with a reel linked to it under Uploaded, not Delivered', () => {
    const uploaded = makeJob({
      state: 'ready',
      placeInLine: null,
      delivery: {
        deliveredAt: '2026-10-19T09:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelUrl: 'https://www.instagram.com/reel/C-up/',
      },
    });
    expect(STATUS_TABS.filter((tab) => matchesTab(uploaded, tab))).toEqual(['all', 'uploaded']);
    // Paid, it goes under Paid, linked or not.
    const paid = makeJob({
      state: 'ready',
      placeInLine: null,
      delivery: {
        ...uploaded.delivery,
        deliveredAt: '2026-10-19T09:00:00.000Z',
        paidOn: '2026-10-22',
      },
    });
    expect(STATUS_TABS.filter((tab) => matchesTab(paid, tab))).toEqual(['all', 'paid']);
  });

  it('counts a job under Uploaded and nowhere else but All', () => {
    const uploaded = makeJob({
      state: 'ready',
      placeInLine: null,
      delivery: {
        deliveredAt: '2026-10-19T09:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
        uploadedAt: '2026-10-20T09:30:00.000Z',
      },
    });
    expect(tabCounts([uploaded], false)).toEqual({
      all: 1,
      progress: 0,
      review: 0,
      approved: 0,
      delivered: 0,
      uploaded: 1,
      paid: 0,
      attention: 0,
    });
  });

  it('leaves a job that left ready under its state’s tab, whatever delivery it still carries', () => {
    const retried = makeJob({
      state: 'editing',
      step: 3,
      placeInLine: null,
      delivery: {
        deliveredAt: '2026-10-19T09:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
      },
    });
    expect(matchesTab(retried, 'progress')).toBe(true);
    expect(matchesTab(retried, 'delivered')).toBe(false);
  });
});

describe('filterJobs', () => {
  it('applies the tab and the search together and keeps the order', () => {
    expect(ids(filterJobs(CANVAS_JOBS, { tab: 'all', search: '', showArchived: false }))).toEqual(
      ids(CANVAS_JOBS),
    );
    expect(
      ids(filterJobs(CANVAS_JOBS, { tab: 'attention', search: '', showArchived: false })),
    ).toEqual(['j3', 'j7', 'j8']);
    expect(
      ids(filterJobs(CANVAS_JOBS, { tab: 'all', search: 'arc', showArchived: false })),
    ).toEqual(['j2', 'j5', 'j10']);
    expect(
      ids(filterJobs(CANVAS_JOBS, { tab: 'approved', search: 'arc', showArchived: false })),
    ).toEqual(['j10']);
    expect(
      ids(filterJobs(CANVAS_JOBS, { tab: 'attention', search: 'arc', showArchived: false })),
    ).toEqual([]);
  });

  it('filters the Phase 4 board by stage', () => {
    const filter = (tab: Parameters<typeof filterJobs>[1]['tab']) =>
      ids(filterJobs(DELIVERY_ROW_JOBS, { tab, search: '', showArchived: false }));
    expect(filter('approved')).toEqual(['d3', 'd4', 'd5']);
    expect(filter('delivered')).toEqual(['d6', 'd7', 'd8']);
    expect(filter('paid')).toEqual(['d9', 'd10']);
    expect(
      ids(filterJobs(DELIVERY_ROW_JOBS, { tab: 'delivered', search: 'rgm', showArchived: false })),
    ).toEqual(['d6']);
  });

  it('finds the Hebrew client "מאפיית הצפון" by a few of its letters', () => {
    expect(
      ids(filterJobs(CANVAS_JOBS, { tab: 'all', search: 'מאפי', showArchived: false })),
    ).toEqual(['j1', 'j3', 'j12']);
  });
});

describe('tabCounts', () => {
  it('counts the jobs of every tab, All included', () => {
    expect(tabCounts(CANVAS_JOBS, false)).toEqual({
      all: 12,
      progress: 4,
      review: 0,
      approved: 5,
      delivered: 0,
      uploaded: 0,
      paid: 0,
      attention: 3,
    });
  });

  it('counts the Phase 4 board by stage: 3 approved, 3 delivered, 2 paid', () => {
    expect(tabCounts(DELIVERY_ROW_JOBS, false)).toEqual({
      all: 10,
      progress: 1,
      review: 1,
      approved: 3,
      delivered: 3,
      uploaded: 0,
      paid: 2,
      attention: 0,
    });
  });

  it('counts every job once under All and once under exactly one other tab', () => {
    const counts = tabCounts([...CANVAS_JOBS, ...REVIEW_ROW_JOBS, ...DELIVERY_ROW_JOBS], false);
    const { all, ...groups } = counts;
    expect(Object.values(groups).reduce((sum, n) => sum + n, 0)).toBe(all);
  });

  it('counts the Phase 3 rows: one in Review, the revise and render runs in progress', () => {
    expect(tabCounts([...CANVAS_JOBS, ...REVIEW_ROW_JOBS], false)).toEqual({
      all: 15,
      progress: 6,
      review: 1,
      approved: 5,
      delivered: 0,
      uploaded: 0,
      paid: 0,
      attention: 3,
    });
  });

  it('counts a review job under All and Review', () => {
    const review = makeJob({
      id: 'review-one',
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });

    const counts = tabCounts([...CANVAS_JOBS, review], false);

    expect(counts).toEqual({
      all: 13,
      progress: 4,
      review: 1,
      approved: 5,
      delivered: 0,
      uploaded: 0,
      paid: 0,
      attention: 3,
    });
    expect(Object.keys(counts)).toEqual([
      'all',
      'progress',
      'review',
      'approved',
      'delivered',
      'uploaded',
      'paid',
      'attention',
    ]);
  });

  it('is all zeros for no jobs', () => {
    expect(tabCounts([], false)).toEqual({
      all: 0,
      progress: 0,
      review: 0,
      approved: 0,
      delivered: 0,
      uploaded: 0,
      paid: 0,
      attention: 0,
    });
  });
});
