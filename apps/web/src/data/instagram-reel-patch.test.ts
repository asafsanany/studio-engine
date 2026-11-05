import { describe, expect, it } from 'vitest';
import { withReelLinked, withReelUnlinked } from './instagram-reel-patch';
import { makeClientInstagram, makeInstagramReel } from './instagram-test-utils';

const THEIRS = 'C8aaBB11CcD';
const OURS = 'C9xYz12AbCd';
const WINTER = 'b2c3d4e5f6a1';

/** The test page, with a point in each chart for both reels. */
function page() {
  const data = makeClientInstagram();
  if (data.numbers === null) throw new Error('the fixture has numbers');
  data.numbers.plays = [
    {
      shortcode: OURS,
      postedAt: '2026-10-21T09:00:00.000Z',
      plays: 18_400,
      ours: true,
      job: 'Autumn run',
    },
    {
      shortcode: THEIRS,
      postedAt: '2026-10-14T09:00:00.000Z',
      plays: 7_000,
      ours: false,
      job: null,
    },
  ];
  data.numbers.engagement = [
    {
      shortcode: OURS,
      postedAt: '2026-10-21T09:00:00.000Z',
      ours: true,
      likes: 1,
      comments: 1,
      shares: 1,
    },
    {
      shortcode: THEIRS,
      postedAt: '2026-10-14T09:00:00.000Z',
      ours: false,
      likes: 1,
      comments: 1,
      shares: 1,
    },
  ];
  return data;
}

describe('withReelLinked', () => {
  it('turns the reel ours, with the job’s name from the Link to job list', () => {
    const next = withReelLinked(page(), THEIRS, WINTER);
    expect(next.reels.find((reel) => reel.shortcode === THEIRS)?.job).toEqual({
      id: WINTER,
      name: 'Winter reel',
    });
  });

  it('takes the name it is given over the list’s', () => {
    const next = withReelLinked(page(), THEIRS, WINTER, 'Another name');
    expect(next.reels.find((reel) => reel.shortcode === THEIRS)?.job?.name).toBe('Another name');
  });

  it('takes the job out of the Link to job list', () => {
    expect(withReelLinked(page(), THEIRS, WINTER).linkableJobs).toEqual([]);
  });

  it('turns the reel’s bar and band in the charts to ours', () => {
    const next = withReelLinked(page(), THEIRS, WINTER);
    expect(next.numbers?.plays.find((point) => point.shortcode === THEIRS)).toMatchObject({
      ours: true,
      job: 'Winter reel',
    });
    expect(next.numbers?.engagement.find((point) => point.shortcode === THEIRS)?.ours).toBe(true);
  });

  it('leaves every other reel and the rest of the page as it was', () => {
    const before = page();
    const next = withReelLinked(before, THEIRS, WINTER);
    expect(next.reels.find((reel) => reel.shortcode === OURS)).toBe(
      before.reels.find((reel) => reel.shortcode === OURS),
    );
    expect(next.numbers?.tiles).toBe(before.numbers?.tiles);
    expect(next.account).toBe(before.account);
    expect(before.reels.find((reel) => reel.shortcode === THEIRS)?.job).toBeNull();
  });

  it('works on a page with no numbers yet', () => {
    const next = withReelLinked({ ...page(), numbers: null }, THEIRS, WINTER);
    expect(next.numbers).toBeNull();
    expect(next.reels.find((reel) => reel.shortcode === THEIRS)?.job?.id).toBe(WINTER);
  });

  it('is the page itself when there is nothing to show', () => {
    const data = page();
    expect(withReelLinked(data, 'nope', WINTER)).toBe(data);
    expect(withReelLinked(data, THEIRS, 'unknown-job')).toBe(data);
    // A reel that is linked already is the server's to refuse.
    expect(withReelLinked(data, OURS, WINTER)).toBe(data);
  });
});

describe('withReelUnlinked', () => {
  it('turns the reel theirs, in the row and in both charts', () => {
    const next = withReelUnlinked(page(), OURS);
    expect(next.reels.find((reel) => reel.shortcode === OURS)?.job).toBeNull();
    expect(next.numbers?.plays.find((point) => point.shortcode === OURS)).toMatchObject({
      ours: false,
      job: null,
    });
    expect(next.numbers?.engagement.find((point) => point.shortcode === OURS)?.ours).toBe(false);
  });

  it('leaves the other reels as they were', () => {
    const before = page();
    const next = withReelUnlinked(before, OURS);
    expect(next.reels.find((reel) => reel.shortcode === THEIRS)).toBe(
      before.reels.find((reel) => reel.shortcode === THEIRS),
    );
  });

  it('is the page itself for a reel that has no job, or is not on the page', () => {
    const data = page();
    expect(withReelUnlinked(data, THEIRS)).toBe(data);
    expect(withReelUnlinked(data, 'nope')).toBe(data);
  });

  it('is undone by linking the same job again', () => {
    const data = makeClientInstagram({
      reels: [makeInstagramReel({ shortcode: OURS, job: { id: WINTER, name: 'Winter reel' } })],
      linkableJobs: [],
    });
    const back = withReelLinked(withReelUnlinked(data, OURS), OURS, WINTER, 'Winter reel');
    expect(back.reels).toEqual(data.reels);
  });
});
