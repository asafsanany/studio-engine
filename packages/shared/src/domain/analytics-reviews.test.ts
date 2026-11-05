import { describe, expect, it } from 'vitest';
import { ANALYTICS_SIZES, analyticsResponseSchema } from './analytics.ts';
import {
  type AnalyticsJob,
  type ComputeAnalyticsInput,
  computeAnalytics,
} from './analytics-compute.ts';
import { computeReviewsSection } from './analytics-reviews.ts';
import { makeJob, makeReviewNote } from './test-fixtures.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel: this week started on Sunday 18 October. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');

function input(overrides: Partial<ComputeAnalyticsInput> = {}): ComputeAnalyticsInput {
  return {
    now: NOW,
    timeZone: ZONE,
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [],
    limits: [],
    noteTopics: {},
    ...overrides,
  };
}

let nextJob = 0;
function job(overrides: Partial<AnalyticsJob> = {}): AnalyticsJob {
  nextJob += 1;
  return {
    ...makeJob({ id: `job${nextJob}` }),
    startedAt: null,
    finishedAt: null,
    footageSec: 0,
    ...overrides,
  };
}

/** A job approved at `approvedAt` after `round` rounds of notes. */
function approved(approvedAt: string, round = 0, overrides: Partial<AnalyticsJob> = {}) {
  return job({ state: 'ready', approvedAt, round, ...overrides });
}

function sent(id: string, jobId: string, sentAt = '2026-10-20T10:00:00.000Z') {
  return makeReviewNote({ id, jobId, round: 1, sentAt });
}

describe('Approved first time, by week', () => {
  it('is 12 weeks ending with this one, each with no approvals and no share, when nothing is approved', () => {
    const weeks = computeReviewsSection(input()).approvedFirstTime;

    expect(weeks).toHaveLength(ANALYTICS_SIZES.month.approval);
    expect(weeks[0]?.start).toBe('2026-08-02');
    expect(weeks.at(-1)?.start).toBe('2026-10-18');
    for (const week of weeks) {
      expect(week).toMatchObject({ share: null, firstTime: 0, approved: 0 });
    }
  });

  it('is the share of the week’s approvals that were round 0', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [
          approved('2026-10-12T08:00:00+03:00'),
          approved('2026-10-13T08:00:00+03:00'),
          approved('2026-10-14T08:00:00+03:00'),
          approved('2026-10-15T08:00:00+03:00', 2),
        ],
      }),
    ).approvedFirstTime;

    expect(weeks.at(-2)).toEqual({
      start: '2026-10-11',
      share: 0.75,
      firstTime: 3,
      approved: 4,
      medianReruns: 0,
    });
  });

  it('counts a round 1 or later approval as approved, not as first time', () => {
    const weeks = computeReviewsSection(
      input({ jobs: [approved('2026-10-12T08:00:00+03:00', 1)] }),
    ).approvedFirstTime;

    expect(weeks.at(-2)).toMatchObject({ share: 0, firstTime: 0, approved: 1 });
  });

  it('keeps a real 0% (approvals, none first time) apart from a week with no approvals (null)', () => {
    const weeks = computeReviewsSection(
      input({ jobs: [approved('2026-10-05T08:00:00+03:00', 3)] }),
    ).approvedFirstTime;

    expect(weeks.at(-3)).toMatchObject({ start: '2026-10-04', share: 0, approved: 1 });
    expect(weeks.at(-2)).toMatchObject({ start: '2026-10-11', share: null, approved: 0 });
  });

  it('counts this week as far as it has got', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [approved('2026-10-19T08:00:00+03:00'), approved('2026-10-21T08:00:00+03:00', 1)],
      }),
    ).approvedFirstTime;

    expect(weeks.at(-1)).toEqual({
      start: '2026-10-18',
      share: 0.5,
      firstTime: 1,
      approved: 2,
      medianReruns: 0.5,
    });
  });

  it('leaves out jobs that are not approved, and approvals older than the 12 weeks', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [
          job({ state: 'review', approvedAt: null }),
          job({ state: 'ready', approvedAt: null }),
          // The Saturday before the first of the 12 weeks (Sunday 2 August).
          approved('2026-08-01T20:00:00+03:00'),
        ],
      }),
    ).approvedFirstTime;

    expect(weeks.reduce((sum, week) => sum + week.approved, 0)).toBe(0);
  });

  it('counts the oldest of the 12 weeks, from its first moment', () => {
    const weeks = computeReviewsSection(
      input({ jobs: [approved('2026-08-02T00:00:00+03:00')] }),
    ).approvedFirstTime;

    expect(weeks[0]).toMatchObject({
      start: '2026-08-02',
      approved: 1,
      firstTime: 1,
      share: 1,
    });
  });

  it('counts archived jobs: the approval happened', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [
          approved('2026-10-13T08:00:00+03:00', 0, { archivedAt: '2026-10-20T00:00:00.000Z' }),
        ],
      }),
    ).approvedFirstTime;

    expect(weeks.at(-2)).toMatchObject({ approved: 1, firstTime: 1 });
  });

  it('puts an approval in the week of its local day: Saturday night and Sunday morning are two weeks', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [approved('2026-10-17T23:30:00+03:00'), approved('2026-10-18T00:30:00+03:00', 1)],
      }),
    ).approvedFirstTime;

    expect(weeks.at(-2)).toMatchObject({ start: '2026-10-11', approved: 1, firstTime: 1 });
    expect(weeks.at(-1)).toMatchObject({ start: '2026-10-18', approved: 1, firstTime: 0 });
  });

  it('follows the time zone it is given', () => {
    // 00:30 on Sunday 18 October in Israel is still Saturday evening (17:30) in New York.
    const jobs = [approved('2026-10-18T00:30:00+03:00')];
    const israel = computeReviewsSection(input({ jobs, timeZone: ZONE }));
    const newYork = computeReviewsSection(input({ jobs, timeZone: 'America/New_York' }));

    expect(israel.approvedFirstTime.at(-1)).toMatchObject({
      start: '2026-10-18',
      approved: 1,
    });
    expect(newYork.approvedFirstTime.at(-1)).toMatchObject({
      start: '2026-10-18',
      approved: 0,
    });
    expect(newYork.approvedFirstTime.at(-2)).toMatchObject({
      start: '2026-10-11',
      approved: 1,
    });
  });

  it('ignores an approval time that cannot be read', () => {
    const weeks = computeReviewsSection(
      input({ jobs: [approved('not a date')] }),
    ).approvedFirstTime;

    expect(weeks.every((week) => week.approved === 0)).toBe(true);
  });
});

describe('What your notes are about', () => {
  const kova = job({ id: 'kova1', client: 'Kova Coffee' });
  const kovaTwo = job({ id: 'kova2', client: 'Kova Coffee' });
  const arc = job({ id: 'arc1', client: 'Arc Fitness' });
  const bakery = job({ id: 'bak1', client: 'מאפיית הצפון' });
  const jobs = [kova, kovaTwo, arc, bakery];

  it('is empty, with no notes waiting, when no note was sent', () => {
    const { noteTopics, notGroupedYet, notesSince } = computeReviewsSection(input({ jobs }));

    expect(noteTopics).toEqual([]);
    expect(notGroupedYet).toBe(0);
    expect(notesSince).toBeNull();
  });

  it('counts every note as not grouped yet when no topic is known', () => {
    const answer = computeReviewsSection(
      input({ jobs, sentNotes: [sent('n1', 'kova1'), sent('n2', 'arc1'), sent('n3', 'bak1')] }),
    );

    expect(answer.noteTopics).toEqual([]);
    expect(answer.notGroupedYet).toBe(3);
  });

  it('groups the notes by topic, most notes first, with each topic’s clients most notes first', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [
          sent('n1', 'kova1'),
          sent('n2', 'kova2'),
          sent('n3', 'kova1'),
          sent('n4', 'arc1'),
          sent('n5', 'arc1'),
          sent('n6', 'bak1'),
          sent('n7', 'kova1'),
        ],
        noteTopics: {
          n1: 'intro too long',
          n2: 'intro too long',
          n3: 'intro too long',
          n4: 'intro too long',
          n5: 'captions too small',
          n6: 'logo late',
          n7: 'captions too small',
        },
      }),
    );

    expect(answer.noteTopics).toEqual([
      {
        topic: 'intro too long',
        count: 4,
        clients: [
          { client: 'Kova Coffee', count: 3 },
          { client: 'Arc Fitness', count: 1 },
        ],
      },
      {
        topic: 'captions too small',
        count: 2,
        clients: [
          { client: 'Arc Fitness', count: 1 },
          { client: 'Kova Coffee', count: 1 },
        ],
      },
      { topic: 'logo late', count: 1, clients: [{ client: 'מאפיית הצפון', count: 1 }] },
    ]);
    expect(answer.notGroupedYet).toBe(0);
  });

  it('puts the notes of a client’s several jobs together under the client', () => {
    const { noteTopics } = computeReviewsSection(
      input({
        jobs,
        sentNotes: [sent('n1', 'kova1'), sent('n2', 'kova2')],
        noteTopics: { n1: 'music too loud', n2: 'music too loud' },
      }),
    );

    expect(noteTopics).toEqual([
      { topic: 'music too loud', count: 2, clients: [{ client: 'Kova Coffee', count: 2 }] },
    ]);
  });

  it('breaks a tie by the words, whatever order the notes come in', () => {
    const notes = [sent('n1', 'kova1'), sent('n2', 'arc1'), sent('n3', 'bak1')];
    const topics = { n1: 'pause before CTA', n2: 'logo late', n3: 'music too loud' };
    const forward = computeReviewsSection(input({ jobs, sentNotes: notes, noteTopics: topics }));
    const backward = computeReviewsSection(
      input({ jobs: [...jobs].reverse(), sentNotes: [...notes].reverse(), noteTopics: topics }),
    );

    expect(forward.noteTopics.map((entry) => entry.topic)).toEqual([
      'logo late',
      'music too loud',
      'pause before CTA',
    ]);
    expect(backward).toEqual(forward);
  });

  it('counts a note without a topic as not grouped yet, next to the grouped ones', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [sent('n1', 'kova1'), sent('n2', 'arc1'), sent('n3', 'bak1')],
        noteTopics: { n1: 'logo late' },
      }),
    );

    expect(answer.noteTopics.map((entry) => [entry.topic, entry.count])).toEqual([
      ['logo late', 1],
    ]);
    expect(answer.notGroupedYet).toBe(2);
  });

  it('counts an empty topic as not grouped, and trims the space around the others', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [sent('n1', 'kova1'), sent('n2', 'arc1'), sent('n3', 'bak1')],
        noteTopics: { n1: '   ', n2: ' logo late ', n3: 'logo late' },
      }),
    );

    expect(answer.noteTopics).toEqual([
      {
        topic: 'logo late',
        count: 2,
        clients: [
          { client: 'Arc Fitness', count: 1 },
          { client: 'מאפיית הצפון', count: 1 },
        ],
      },
    ]);
    expect(answer.notGroupedYet).toBe(1);
  });

  it('ignores topics of notes that were not sent, and never reads a note id off the prototype', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [sent('constructor', 'kova1'), sent('toString', 'arc1')],
        noteTopics: { ghost: 'not a note' },
      }),
    );

    expect(answer.noteTopics).toEqual([]);
    expect(answer.notGroupedYet).toBe(2);
  });

  it('counts a note whose job is not known for its topic, with no client to name', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [sent('n1', 'gone'), sent('n2', 'arc1')],
        noteTopics: { n1: 'logo late', n2: 'logo late' },
      }),
    );

    expect(answer.noteTopics).toEqual([
      { topic: 'logo late', count: 2, clients: [{ client: 'Arc Fitness', count: 1 }] },
    ]);
  });

  it('leaves out a note that was never sent', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [makeReviewNote({ id: 'draft', jobId: 'kova1', round: null, sentAt: null })],
        noteTopics: { draft: 'logo late' },
      }),
    );

    expect(answer.noteTopics).toEqual([]);
    expect(answer.notGroupedYet).toBe(0);
    expect(answer.notesSince).toBeNull();
  });

  it('says the day the first note was sent, on the local calendar', () => {
    const answer = computeReviewsSection(
      input({
        jobs,
        sentNotes: [
          sent('n1', 'kova1', '2026-10-20T10:00:00.000Z'),
          // 22:30 UTC on 2 September is already 3 September in Israel.
          sent('n2', 'arc1', '2026-09-02T22:30:00.000Z'),
          sent('n3', 'bak1', '2026-10-01T10:00:00.000Z'),
        ],
        noteTopics: { n2: 'logo late' },
      }),
    );

    expect(answer.notesSince).toBe('2026-09-03');
  });

  it('counts the date of a note that has no topic yet too', () => {
    const answer = computeReviewsSection(
      input({ jobs, sentNotes: [sent('n1', 'kova1', '2026-09-10T10:00:00.000Z')] }),
    );

    expect(answer.notesSince).toBe('2026-09-10');
    expect(answer.notGroupedYet).toBe(1);
  });

  it('does not change what it is given', () => {
    const sentNotes = [sent('n2', 'arc1'), sent('n1', 'kova1')];
    const noteTopics = { n1: 'logo late', n2: 'logo late' };
    const before = JSON.stringify({ jobs, sentNotes, noteTopics });

    computeReviewsSection(input({ jobs, sentNotes, noteTopics }));

    expect(JSON.stringify({ jobs, sentNotes, noteTopics })).toBe(before);
  });
});

describe('the whole answer with reviews in it', () => {
  it('is a valid response and survives a trip through JSON', () => {
    const jobs = [
      approved('2026-10-13T08:00:00+03:00'),
      job({ id: 'arc1', client: 'Arc Fitness' }),
    ];
    const answer = computeAnalytics(
      input({
        jobs,
        sentNotes: [sent('n1', 'arc1'), sent('n2', 'arc1')],
        noteTopics: { n1: 'logo late' },
      }),
    );

    expect(analyticsResponseSchema.parse(answer)).toEqual(answer);
    expect(analyticsResponseSchema.parse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
    expect(answer.reviews.notGroupedYet).toBe(1);
    expect(answer.reviews.noteTopics).toHaveLength(1);
  });
});

describe('Re-runs per approved job, by week', () => {
  it('is the median round of the jobs approved in a week, and null with none', () => {
    const weeks = computeReviewsSection(
      input({
        jobs: [
          approved('2026-10-20T10:00:00.000Z', 0),
          approved('2026-10-20T11:00:00.000Z', 1),
          approved('2026-10-21T10:00:00.000Z', 4),
          approved('2026-10-13T10:00:00.000Z', 2),
        ],
      }),
    ).approvedFirstTime;

    expect(weeks.at(-1)?.medianReruns).toBe(1);
    expect(weeks.at(-2)?.medianReruns).toBe(2);
    expect(weeks.at(-3)?.medianReruns).toBeNull();
  });
});
