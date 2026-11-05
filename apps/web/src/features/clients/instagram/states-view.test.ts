import type { ClientInstagram, InstagramScan } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  isFirstScan,
  NO_ACCOUNT_TEXT,
  readingLine,
  scanProblem,
  unlinkedNotice,
} from './states-view';
import { FALCON_NOW, FALCON_TIME_ZONE, falconInstagram } from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

/** Falcon's page whose last scan ended another way, with the numbers of the scans before it. */
function afterScan(
  scan: Partial<InstagramScan>,
  overrides: Partial<ClientInstagram> = {},
): ClientInstagram {
  const data = falconInstagram();
  return {
    ...data,
    lastScan: {
      startedAt: '2026-10-26T04:00:00.000Z',
      finishedAt: '2026-10-26T04:01:00.000Z',
      outcome: 'failed',
      error: null,
      followers: null,
      following: null,
      posts: null,
      reelsRead: 0,
      costUsd: 0,
      ...scan,
    },
    ...overrides,
  };
}

/** The same without numbers: no scan has been able to read the page. */
const noNumbers = (scan: Partial<InstagramScan>) => afterScan(scan, { numbers: null, reels: [] });

describe('readingLine and the empty section', () => {
  it('says whose page is read and for how long, as board S2 does', () => {
    expect(readingLine('falcon.fpv')).toBe('Reading @falcon.fpv… about a minute');
  });

  it('has the words of board S8', () => {
    expect(NO_ACCOUNT_TEXT).toEqual({
      title: 'Add their Instagram to see how our videos do there.',
      detail: 'It’s read once a week, about $0.05.',
      add: 'Add Instagram',
    });
  });
});

describe('isFirstScan', () => {
  it('is true while the account has no numbers and a scan is queued or running', () => {
    expect(isFirstScan({ ...falconInstagram(), numbers: null, scanning: true })).toBe(true);
  });

  it('is true for an account that has not been scanned yet (the first scan is queued when it is saved)', () => {
    expect(isFirstScan({ ...falconInstagram(), numbers: null, lastScan: null })).toBe(true);
  });

  it('is true again for a scan that runs after one that could not read the page', () => {
    expect(isFirstScan({ ...noNumbers({ outcome: 'private' }), scanning: true })).toBe(true);
  });

  it('is false once there are numbers (a scan then is only "Scanning now" in the head)', () => {
    expect(isFirstScan({ ...falconInstagram(), scanning: true })).toBe(false);
  });

  it('is false for an account whose scan ended without reading the page', () => {
    expect(isFirstScan(noNumbers({ outcome: 'failed' }))).toBe(false);
  });
});

describe('scanProblem', () => {
  it('is nothing for a scan that read the page, for no scan, and while a scan runs', () => {
    expect(scanProblem(falconInstagram(), OPTIONS)).toBeNull();
    expect(scanProblem({ ...falconInstagram(), lastScan: null }, OPTIONS)).toBeNull();
    expect(
      scanProblem({ ...afterScan({ outcome: 'failed' }), scanning: true }, OPTIONS),
    ).toBeNull();
  });

  it('private: Edit account, with the board’s words', () => {
    expect(scanProblem(noNumbers({ outcome: 'private' }), OPTIONS)).toEqual({
      outcome: 'private',
      title: 'The account is private',
      detail: 'Ask them to make it public, or switch to a business account.',
      action: 'edit',
      actionLabel: 'Edit account',
      tone: 'muted',
      error: null,
    });
  });

  it('not found: names the handle, and Edit account', () => {
    const data = noNumbers({ outcome: 'not-found' });
    if (data.account === null) throw new Error('the fixture has an account');
    data.account.handle = 'falcon_fpv';
    expect(scanProblem(data, OPTIONS)).toMatchObject({
      outcome: 'not-found',
      title: 'No account called @falcon_fpv',
      detail: 'Check the name, or paste the link from their profile.',
      action: 'edit',
      actionLabel: 'Edit account',
    });
  });

  it('no token: How to, in amber, naming APIFY_TOKEN and .env', () => {
    expect(scanProblem(noNumbers({ outcome: 'no-token' }), OPTIONS)).toMatchObject({
      outcome: 'no-token',
      title: 'Apify isn’t set up',
      detail: 'APIFY_TOKEN is missing from .env.',
      action: 'how-to',
      actionLabel: 'How to',
      tone: 'warning',
    });
  });

  it('no credit: Open Apify, and says when the credit is back (the first of the next month)', () => {
    expect(scanProblem(noNumbers({ outcome: 'no-credit' }), OPTIONS)).toMatchObject({
      title: 'Apify’s credit is used up',
      detail: 'Scans pause until 1 Nov, or add credit on apify.com.',
      action: 'open-apify',
      actionLabel: 'Open Apify',
      tone: 'warning',
    });
  });

  it('no credit in December: the credit is back on 1 Jan of the next year', () => {
    const data = noNumbers({ outcome: 'no-credit', finishedAt: '2026-12-14T09:00:00.000Z' });
    expect(
      scanProblem(data, { ...OPTIONS, now: Date.parse('2026-12-15T09:00:00.000Z') })?.detail,
    ).toBe('Scans pause until 1 Jan 2027, or add credit on apify.com.');
  });

  it('failed: names the day of the scan and Retry, in red, and keeps what the scan said for a tooltip', () => {
    expect(
      scanProblem(noNumbers({ outcome: 'failed', error: 'Apify run FAILED' }), OPTIONS),
    ).toMatchObject({
      outcome: 'failed',
      title: 'The scan of Mon 26 Oct failed',
      detail: 'Instagram didn’t answer.',
      action: 'retry',
      actionLabel: 'Retry',
      tone: 'error',
      error: 'Apify run FAILED',
    });
  });

  it('says what day the numbers under it are from (the last scan that read the profile)', () => {
    const data = afterScan({ outcome: 'failed' });
    // Falcon's weekly scans run to Mon 26 Oct; the failed one is later than the last good one.
    if (data.numbers === null) throw new Error('the fixture has numbers');
    data.numbers.tiles.followers.line = data.numbers.tiles.followers.line.slice(0, -1);
    expect(scanProblem(data, OPTIONS)?.detail).toBe(
      'Instagram didn’t answer. The numbers are from Mon 19 Oct.',
    );
    expect(scanProblem(afterScan({ outcome: 'private' }), OPTIONS)?.detail).toBe(
      'Ask them to make it public, or switch to a business account. The numbers are from Mon 26 Oct.',
    );
  });

  it('leaves that sentence out when no scan has read the profile', () => {
    expect(scanProblem(noNumbers({ outcome: 'failed' }), OPTIONS)?.detail).toBe(
      'Instagram didn’t answer.',
    );
  });
});

describe('unlinkedNotice (S9)', () => {
  /** Falcon with no reel of their linked to a video, and these videos delivered. */
  function none(names: string[]): ClientInstagram {
    const data = falconInstagram();
    return {
      ...data,
      reels: data.reels.map((reel) => ({ ...reel, job: null })),
      linkableJobs: names.map((name, index) => ({
        jobId: `job-${index}`,
        name,
        deliveredAt: `2026-10-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`,
        stage: 'delivered' as const,
      })),
    };
  }

  it('counts and names the delivered videos, newest first, with where to link them', () => {
    expect(unlinkedNotice(none(['97 Window Ad', 'Window cleaning ad']))).toEqual({
      title: 'None of our videos is linked to a reel yet.',
      count: 2,
      names: ['Window cleaning ad', '97 Window Ad'],
      more: 0,
      after:
        'When they are up, right-click the reel below › Link to job. Their own reels show meanwhile.',
    });
  });

  it('names three and counts the rest', () => {
    const notice = unlinkedNotice(none(['A', 'B', 'C', 'D', 'E']));
    expect(notice).toMatchObject({ count: 5, names: ['E', 'D', 'C'], more: 2 });
  });

  it('is nothing once a reel is linked to a video', () => {
    expect(unlinkedNotice({ ...none(['A']), reels: falconInstagram().reels })).toBeNull();
  });

  it('is nothing when no video is delivered, or when the engine lists none (an editor cannot link)', () => {
    expect(unlinkedNotice(none([]))).toBeNull();
  });

  it('is nothing without numbers: the section has the first scan or a problem to say', () => {
    expect(unlinkedNotice({ ...none(['A']), numbers: null })).toBeNull();
  });
});
