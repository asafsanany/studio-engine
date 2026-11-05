import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ClientInstagram,
  clientInstagramSchema,
  clientInstagramSummarySchema,
  DEFAULT_INSTAGRAM_RANGE,
  deleteClientInstagramResponseSchema,
  INSTAGRAM_HANDLE_MAX_LENGTH,
  INSTAGRAM_LINK_MESSAGES,
  INSTAGRAM_LINK_REFUSALS,
  INSTAGRAM_RANGES,
  INSTAGRAM_SCAN_OUTCOMES,
  type InstagramReel,
  instagramHandleSchema,
  instagramLinkRefusalSchema,
  instagramLinkRequestSchema,
  instagramLinkResponseSchema,
  instagramRangeSchema,
  instagramReelSchema,
  jobReelResponseSchema,
  noClientInstagram,
  normalizeInstagramHandle,
  setClientInstagramRequestSchema,
} from './instagram.ts';

const reel = (overrides: Partial<InstagramReel> = {}): InstagramReel => ({
  shortcode: 'C9xYz12AbCd',
  url: 'https://www.instagram.com/reel/C9xYz12AbCd/',
  postedAt: '2026-10-21T09:00:00.000Z',
  caption: 'Autumn run #fpv #drone',
  durationSec: 31.4,
  plays: 18_400,
  likes: 1_210,
  comments: 38,
  shares: 96,
  sound: 'Original audio',
  coauthors: ['yael.edits'],
  hashtags: ['fpv', 'drone'],
  pinned: false,
  paidPartnership: false,
  job: { id: 'a1b2c3d4e5f6', name: 'Autumn run' },
  timesUsual: 1.8,
  ...overrides,
});

/** A client page with an account, one scan, one linked reel and one the client made alone. */
function fullAnswer(): ClientInstagram {
  const oursTheirs = { ours: 14_000, theirs: 8_000 };
  return {
    account: {
      handle: 'falcon.fpv',
      since: '2026-09-14',
      addedAt: '2026-10-30T10:00:00.000Z',
      fullName: 'Falcon FPV',
      bio: 'FPV pilot. Tel Aviv.',
      private: false,
      photoSavedAt: '2026-10-30T10:05:00.000Z',
    },
    lastScan: {
      startedAt: '2026-10-30T10:01:00.000Z',
      finishedAt: '2026-10-30T10:05:00.000Z',
      outcome: 'ok',
      error: null,
      followers: 12_400,
      following: 310,
      posts: 188,
      reelsRead: 14,
      costUsd: 0.12,
    },
    scanning: false,
    nextScanAt: '2026-11-02T04:00:00.000Z',
    numbers: {
      range: 'since',
      from: '2026-09-14',
      sinceUs: '2026-09-14',
      usual: { plays: 9_000, likes: 700, comments: 20, shares: 40 },
      tiles: {
        followers: {
          now: 12_400,
          thisWeek: 120,
          sinceUs: 640,
          line: [
            { at: '2026-10-23T04:00:00.000Z', followers: 12_280, ours: false },
            { at: '2026-10-30T10:05:00.000Z', followers: 12_400, ours: true },
          ],
        },
        playsPerReel: { ...oursTheirs, ratio: 1.75 },
        likesPerReel: { ours: 900, theirs: null, ratio: null },
        sharesAWeek: {
          thisWeek: { ours: 30, theirs: 12 },
          weekBefore: { ours: null, theirs: null },
          line: [{ at: '2026-10-30T10:05:00.000Z', shares: 42 }],
        },
      },
      plays: [
        {
          shortcode: 'C9xYz12AbCd',
          postedAt: '2026-10-21T09:00:00.000Z',
          plays: 18_400,
          ours: true,
        },
        {
          shortcode: 'C8aaBB11CcD',
          postedAt: '2026-10-14T09:00:00.000Z',
          plays: 7_100,
          ours: false,
        },
      ],
      engagement: [
        {
          shortcode: 'C9xYz12AbCd',
          postedAt: '2026-10-21T09:00:00.000Z',
          ours: true,
          likes: 1.7,
          comments: 1.9,
          shares: 2.4,
        },
        {
          shortcode: 'C8aaBB11CcD',
          postedAt: '2026-10-14T09:00:00.000Z',
          ours: false,
          likes: 0.8,
          comments: 0.5,
          shares: null,
        },
      ],
    },
    reels: [
      reel(),
      reel({
        shortcode: 'C8aaBB11CcD',
        url: 'https://www.instagram.com/reel/C8aaBB11CcD/',
        postedAt: '2026-10-14T09:00:00.000Z',
        shares: null,
        job: null,
        coauthors: [],
        timesUsual: 0.8,
      }),
    ],
    linkableJobs: [
      {
        jobId: 'b2c3d4e5f6a1',
        name: 'Winter reel',
        deliveredAt: '2026-10-28T12:00:00.000Z',
        stage: 'delivered',
      },
      {
        jobId: 'c3d4e5f6a1b2',
        name: 'Gear review',
        deliveredAt: '2026-10-02T12:00:00.000Z',
        stage: 'paid',
      },
    ],
  };
}

/** The answer with the value at `path` (`reels.0.plays`) replaced. */
function set(answer: ClientInstagram, path: string, value: unknown): ClientInstagram {
  const copy: ClientInstagram = JSON.parse(JSON.stringify(answer));
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  let target: Record<string, unknown> = copy as unknown as Record<string, unknown>;
  for (const key of keys) target = target[key] as Record<string, unknown>;
  target[last] = value;
  return copy;
}

describe('normalizeInstagramHandle', () => {
  it.each([
    ['falcon.fpv', 'falcon.fpv'],
    ['@Falcon.FPV', 'falcon.fpv'],
    ['  @falcon.fpv  ', 'falcon.fpv'],
    ['FALCON_FPV', 'falcon_fpv'],
    ['a', 'a'],
    ['a'.repeat(INSTAGRAM_HANDLE_MAX_LENGTH), 'a'.repeat(INSTAGRAM_HANDLE_MAX_LENGTH)],
    ['instagram.com/falcon.fpv', 'falcon.fpv'],
    ['www.instagram.com/Falcon.FPV/', 'falcon.fpv'],
    ['https://instagram.com/falcon.fpv', 'falcon.fpv'],
    ['https://www.instagram.com/falcon.fpv/', 'falcon.fpv'],
    ['http://m.instagram.com/falcon.fpv', 'falcon.fpv'],
    ['https://www.instagram.com/falcon.fpv/?igsh=MWx3cDRhZ2o&utm_source=qr', 'falcon.fpv'],
    ['https://www.instagram.com/falcon.fpv#top', 'falcon.fpv'],
    ['https://www.instagram.com/falcon.fpv/reels/', 'falcon.fpv'],
    ['https://www.instagram.com/_u/falcon.fpv', 'falcon.fpv'],
    ['https://instagr.am/falcon.fpv', 'falcon.fpv'],
    ['https://www.instagram.com/@falcon.fpv', 'falcon.fpv'],
  ])('reads %j as %j', (input, handle) => {
    expect(normalizeInstagramHandle(input)).toEqual({ ok: true, handle });
  });

  it.each([
    ['', 'Give the client’s Instagram handle or profile link.'],
    ['   ', 'Give the client’s Instagram handle or profile link.'],
    ['@', 'Give the client’s Instagram handle or profile link.'],
    ['falcon fpv', 'An Instagram handle has no spaces.'],
    ['falcon-fpv', 'An Instagram handle has only letters, numbers, dots and underscores.'],
    ['@falcon!', 'An Instagram handle has only letters, numbers, dots and underscores.'],
    ['מאור', 'An Instagram handle has only letters, numbers, dots and underscores.'],
    ['a'.repeat(INSTAGRAM_HANDLE_MAX_LENGTH + 1), 'An Instagram handle has at most 30 characters.'],
    ['https://www.tiktok.com/@falcon.fpv', 'That is not an Instagram profile link.'],
    ['https://example.com/falcon.fpv', 'That is not an Instagram profile link.'],
    ['https://www.instagram.com/', 'That link has no profile in it.'],
    ['instagram.com', 'That link has no profile in it.'],
    ['https://www.instagram.com/?hl=en', 'That link has no profile in it.'],
    [
      'https://www.instagram.com/reel/C9xYz12AbCd/',
      'That link is a post, not a profile. Paste the profile’s link or handle.',
    ],
    [
      'https://www.instagram.com/p/C9xYz12AbCd/?img_index=1',
      'That link is a post, not a profile. Paste the profile’s link or handle.',
    ],
    [
      'https://www.instagram.com/explore/tags/fpv/',
      'That link is a post, not a profile. Paste the profile’s link or handle.',
    ],
  ])('refuses %j with a sentence to show', (input, error) => {
    expect(normalizeInstagramHandle(input)).toEqual({ ok: false, error });
  });
});

describe('instagramHandleSchema', () => {
  it('gives the handle, lowercased', () => {
    expect(instagramHandleSchema.parse('@Falcon.FPV')).toBe('falcon.fpv');
    expect(instagramHandleSchema.parse('https://www.instagram.com/Falcon.FPV/')).toBe('falcon.fpv');
  });

  it('fails with the sentence to show', () => {
    const result = instagramHandleSchema.safeParse('falcon fpv');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'An Instagram handle has no spaces.',
    ]);
    expect(instagramHandleSchema.safeParse(42).success).toBe(false);
  });
});

describe('GET /api/clients/:clientId/instagram', () => {
  it('parses a client page with an account, a scan, numbers, reels and linkable jobs', () => {
    const answer = fullAnswer();
    expect(clientInstagramSchema.parse(answer)).toEqual(answer);
  });

  it('parses the empty answer of a client with no account', () => {
    expect(clientInstagramSchema.parse(noClientInstagram())).toEqual({
      account: null,
      lastScan: null,
      scanning: false,
      nextScanAt: null,
      numbers: null,
      reels: [],
      linkableJobs: [],
    });
  });

  it('parses an account before its first scan, and a scan that failed', () => {
    const account = fullAnswer().account;
    if (account === null) throw new Error('the full answer has an account');
    const first: ClientInstagram = {
      ...noClientInstagram(),
      account: { ...account, fullName: null, bio: null, photoSavedAt: null },
      scanning: true,
    };
    expect(clientInstagramSchema.parse(first)).toEqual(first);

    const failed: ClientInstagram = {
      ...first,
      scanning: false,
      lastScan: {
        startedAt: '2026-10-30T10:01:00.000Z',
        finishedAt: '2026-10-30T10:01:40.000Z',
        outcome: 'no-credit',
        error: 'Apify has no credit left this month.',
        followers: null,
        following: null,
        posts: null,
        reelsRead: 0,
        costUsd: null,
      },
    };
    expect(clientInstagramSchema.parse(failed)).toEqual(failed);
  });

  it('has a place for every outcome of a scan', () => {
    expect(INSTAGRAM_SCAN_OUTCOMES).toEqual([
      'ok',
      'private',
      'not-found',
      'no-token',
      'no-credit',
      'failed',
    ]);
  });

  it.each<[string, (answer: ClientInstagram) => unknown]>([
    [
      'an account with a handle that is not lowercase',
      (a) => set(a, 'account.handle', 'Falcon.FPV'),
    ],
    ['an account with a handle with an @', (a) => set(a, 'account.handle', '@falcon.fpv')],
    ['an account with a bad day', (a) => set(a, 'account.since', '14/09/2026')],
    ['a scan with an unknown outcome', (a) => set(a, 'lastScan.outcome', 'banned')],
    ['a reel without a job field', (a) => set(a, 'reels.0.job', undefined)],
    ['a reel with negative plays', (a) => set(a, 'reels.0.plays', -1)],
    ['a reel that is not a link', (a) => set(a, 'reels.0.url', 'C9xYz12AbCd')],
    ['a linkable job at an unfinished stage', (a) => set(a, 'linkableJobs.0.stage', 'approved')],
    ['numbers with an unknown range', (a) => set(a, 'numbers.range', '7')],
  ])('rejects %s', (_label, change) => {
    expect(clientInstagramSchema.safeParse(change(fullAnswer())).success).toBe(false);
  });

  it('rejects an answer that leaves a field out', () => {
    for (const key of Object.keys(noClientInstagram())) {
      const answer: Record<string, unknown> = { ...noClientInstagram() };
      delete answer[key];
      expect(clientInstagramSchema.safeParse(answer).success, key).toBe(false);
    }
  });

  it('has the three ranges, since us first', () => {
    expect(INSTAGRAM_RANGES).toEqual(['since', '90', '30']);
    expect(DEFAULT_INSTAGRAM_RANGE).toBe('since');
    expect(instagramRangeSchema.parse('90')).toBe('90');
    expect(instagramRangeSchema.safeParse('7').success).toBe(false);
    expect(instagramRangeSchema.safeParse(90).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<ClientInstagram['account']>().toEqualTypeOf<{
      handle: string;
      since: string | null;
      addedAt: string;
      fullName: string | null;
      bio: string | null;
      private: boolean;
      photoSavedAt: string | null;
    } | null>();
    expectTypeOf<ClientInstagram['reels']>().toEqualTypeOf<InstagramReel[]>();
    expectTypeOf<ClientInstagram['scanning']>().toEqualTypeOf<boolean>();
  });
});

describe('Plays of every reel (IG6)', () => {
  it('names the job of an ours reel, or null for theirs, and still parses a point without it', () => {
    const answer = fullAnswer();
    const withJob = set(answer, 'numbers.plays.0.job', 'Autumn run');
    expect(clientInstagramSchema.parse(withJob).numbers?.plays[0]?.job).toBe('Autumn run');
    const theirs = set(answer, 'numbers.plays.1.job', null);
    expect(clientInstagramSchema.parse(theirs).numbers?.plays[1]?.job).toBeNull();
    // fullAnswer's points have no `job` at all: an older stand-in.
    expect(clientInstagramSchema.parse(answer).numbers?.plays[0]?.job).toBeUndefined();
    expect(clientInstagramSchema.safeParse(set(answer, 'numbers.plays.0.job', '')).success).toBe(
      false,
    );
  });
});

describe('the Clients list summary (IG6)', () => {
  const summary = {
    handle: 'falcon.fpv',
    followers: 12_480,
    weekChange: 312,
    oursVsTheirs: 3.6,
    photoAt: '2026-10-26T06:01:00.000Z',
  };

  it('has the handle, the followers, this week, ours ÷ theirs and when the photo was saved', () => {
    expect(clientInstagramSummarySchema.parse(summary)).toEqual(summary);
  });

  it('has null for what no scan has read, and a change that can be negative', () => {
    const unread = {
      ...summary,
      followers: null,
      weekChange: null,
      oursVsTheirs: null,
      photoAt: null,
    };
    expect(clientInstagramSummarySchema.parse(unread)).toEqual(unread);
    expect(clientInstagramSummarySchema.parse({ ...summary, weekChange: -12 }).weekChange).toBe(
      -12,
    );
  });

  it.each([
    ['a handle with a capital', { handle: 'Falcon.FPV' }],
    ['a fractional follower count', { followers: 1.5 }],
    ['a negative ratio', { oursVsTheirs: -1 }],
    ['a photo time that is not ISO', { photoAt: 'yesterday' }],
  ])('rejects %s', (_label, change) => {
    expect(clientInstagramSummarySchema.safeParse({ ...summary, ...change }).success).toBe(false);
  });
});

describe('a reel', () => {
  it('has shares or null, and a job or null', () => {
    const theirs = reel({ shares: null, job: null, timesUsual: null });
    expect(instagramReelSchema.parse(theirs)).toEqual(theirs);
  });

  it('is what a link answers', () => {
    const linked = reel();
    expect(instagramLinkResponseSchema.parse(linked)).toEqual(linked);
  });
});

describe('PUT /api/clients/:clientId/instagram body', () => {
  it('reads the handle as typed and the day, and takes the first delivery when there is no day', () => {
    expect(
      setClientInstagramRequestSchema.parse({ handle: '@Falcon.FPV', since: '2026-09-14' }),
    ).toEqual({ handle: 'falcon.fpv', since: '2026-09-14' });
    expect(setClientInstagramRequestSchema.parse({ handle: 'falcon.fpv', since: null })).toEqual({
      handle: 'falcon.fpv',
      since: null,
    });
    expect(setClientInstagramRequestSchema.parse({ handle: 'falcon.fpv' })).toEqual({
      handle: 'falcon.fpv',
      since: null,
    });
  });

  it('refuses a handle with the sentence to show, and a day that is not one', () => {
    const bad = setClientInstagramRequestSchema.safeParse({ handle: 'falcon fpv' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe('An Instagram handle has no spaces.');
    expect(
      setClientInstagramRequestSchema.safeParse({ handle: 'falcon.fpv', since: '2026-02-31' })
        .success,
    ).toBe(false);
    expect(setClientInstagramRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('DELETE /api/clients/:clientId/instagram', () => {
  it('answers { ok: true }', () => {
    expect(deleteClientInstagramResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(deleteClientInstagramResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('the link of a reel to a job', () => {
  it('takes { jobId }', () => {
    expect(instagramLinkRequestSchema.parse({ jobId: 'a1b2c3d4e5f6' })).toEqual({
      jobId: 'a1b2c3d4e5f6',
    });
    expect(instagramLinkRequestSchema.safeParse({}).success).toBe(false);
    expect(instagramLinkRequestSchema.safeParse({ jobId: '' }).success).toBe(false);
  });

  it('has five refusals, each with its words', () => {
    expect(INSTAGRAM_LINK_REFUSALS).toEqual([
      'not-this-client',
      'not-delivered',
      'job-linked',
      'reel-linked',
      'no-reel',
    ]);
    for (const reason of INSTAGRAM_LINK_REFUSALS) {
      const refusal = { error: INSTAGRAM_LINK_MESSAGES[reason], reason };
      expect(INSTAGRAM_LINK_MESSAGES[reason]).toMatch(/\.$/);
      expect(instagramLinkRefusalSchema.parse(refusal)).toEqual(refusal);
    }
    expect(instagramLinkRefusalSchema.safeParse({ error: 'x', reason: 'busy' }).success).toBe(
      false,
    );
    expect(instagramLinkRefusalSchema.safeParse({ error: 'x' }).success).toBe(false);
  });
});

describe('the reel of a job (GET /api/jobs/:jobId/reel)', () => {
  const linked = {
    shortcode: 'C9xYz12AbCd',
    url: 'https://www.instagram.com/reel/C9xYz12AbCd/',
    postedAt: '2026-10-20T09:30:00.000Z',
    plays: 27_500,
    likes: 1_640,
    comments: 71,
    shares: 820,
  };

  it('has the reel with its numbers', () => {
    const body = { jobId: 'a1b2c3d4e5f6', reel: linked };
    expect(jobReelResponseSchema.parse(body)).toEqual(body);
  });

  it('has no reel for a job none links, and unread shares as null', () => {
    expect(jobReelResponseSchema.parse({ jobId: 'a1b2c3d4e5f6', reel: null }).reel).toBeNull();
    expect(
      jobReelResponseSchema.parse({ jobId: 'a1b2c3d4e5f6', reel: { ...linked, shares: null } }).reel
        ?.shares,
    ).toBeNull();
  });

  it('refuses a reel without a number, a fraction of a play or a job with no id', () => {
    const { plays: _plays, ...noPlays } = linked;
    expect(jobReelResponseSchema.safeParse({ jobId: 'a', reel: noPlays }).success).toBe(false);
    expect(
      jobReelResponseSchema.safeParse({ jobId: 'a', reel: { ...linked, plays: 1.5 } }).success,
    ).toBe(false);
    expect(jobReelResponseSchema.safeParse({ jobId: '', reel: null }).success).toBe(false);
  });
});
