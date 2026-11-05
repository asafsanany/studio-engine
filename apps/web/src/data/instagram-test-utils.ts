// Helpers for the Instagram tests of the data layer (Clients × Instagram). Not imported by the app.

import type { ClientInstagram, InstagramReel } from '@studio/shared';

/** A reel linked to a video: ours. Tests start from this and override what they care about. */
export function makeInstagramReel(overrides: Partial<InstagramReel> = {}): InstagramReel {
  return {
    shortcode: 'C9xYz12AbCd',
    url: 'https://www.instagram.com/reel/C9xYz12AbCd/',
    postedAt: '2026-10-21T09:00:00.000Z',
    caption: 'Autumn run #fpv',
    durationSec: 31.4,
    plays: 18_400,
    likes: 1_210,
    comments: 38,
    shares: 96,
    sound: 'Original audio',
    coauthors: [],
    hashtags: ['fpv'],
    pinned: false,
    paidPartnership: false,
    job: { id: 'a1b2c3d4e5f6', name: 'Autumn run' },
    timesUsual: 1.8,
    ...overrides,
  };
}

/** A client page with an account, one scan, numbers, an ours and a theirs reel and a linkable job. */
export function makeClientInstagram(overrides: Partial<ClientInstagram> = {}): ClientInstagram {
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
      reelsRead: 2,
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
            { at: '2026-10-30T10:05:00.000Z', followers: 12_400, ours: false },
          ],
        },
        playsPerReel: { ours: 14_000, theirs: 8_000, ratio: 1.75 },
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
      ],
      engagement: [
        {
          shortcode: 'C9xYz12AbCd',
          postedAt: '2026-10-21T09:00:00.000Z',
          ours: true,
          plays: 2.6,
          likes: 1.7,
          comments: 1.9,
          shares: 2.4,
        },
      ],
    },
    reels: [
      makeInstagramReel(),
      makeInstagramReel({
        shortcode: 'C8aaBB11CcD',
        url: 'https://www.instagram.com/reel/C8aaBB11CcD/',
        postedAt: '2026-10-14T09:00:00.000Z',
        shares: null,
        job: null,
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
    ],
    ...overrides,
  };
}
