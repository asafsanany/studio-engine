import type { InstagramNumbers } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeClientInstagram } from '@/data/instagram-test-utils';
import { FALCON_NOW, FALCON_TIME_ZONE, falconNumbers } from './test-instagram';
import { tilesView } from './tiles-view';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

/** The small answer of the data layer's helpers: two scans, ours only for plays. */
function small(): InstagramNumbers {
  const numbers = makeClientInstagram().numbers;
  if (numbers === null) throw new Error('the helper has numbers');
  return numbers;
}

describe("the tiles with the board's numbers", () => {
  const view = tilesView(falconNumbers('since'), OPTIONS);

  it('Followers: the number, the line of the scans and the change this week and since us', () => {
    expect(view.followers.title).toBe('Followers');
    expect(view.followers.subtitle).toBe('Weekly scan');
    expect(view.followers.value).toBe('12,480');
    expect(view.followers.change).toBe('+312 this week · +1,930 since us');
    expect(view.followers.tone).toBe('better');
    expect(view.followers.rows).toHaveLength(13);
    expect(view.followers.rows.at(-1)).toEqual({
      id: '2026-10-26T04:00:00.000Z',
      title: 'Mon 26 Oct',
      value: 12_480,
      marked: true,
    });
  });

  it("Followers: a dot on each scan after which one of our reels was posted, the board's six", () => {
    const marked = view.followers.rows.flatMap((row, index) => (row.marked ? [index] : []));
    expect(marked).toEqual([3, 6, 8, 9, 11, 12]);
    expect(view.followers.rows[0]?.marked).toBe(false);
  });

  it('names the since day on the reel tiles, and no day on the followers tile', () => {
    // An account ours since 23 Oct whose first scan was later: the engine names 23 Oct.
    const since = tilesView({ ...falconNumbers('since'), sinceUs: '2026-10-23' }, OPTIONS);
    expect(since.plays.subtitle).toBe('Typical reel, since us (23 Oct)');
    expect(since.likes.subtitle).toBe('Typical reel, since us (23 Oct)');
    expect(since.followers.subtitle).toBe('Weekly scan');
    expect(since.followers.change).toBe('+312 this week · +1,930 since us');
  });

  it('Plays per reel: ours next to theirs and the ratio, in green', () => {
    expect(view.plays.title).toBe('Plays per reel');
    expect(view.plays.subtitle).toBe('Typical reel, since us (3 Aug)');
    expect(view.plays.ours).toBe('18.4K');
    expect(view.plays.theirs).toBe('5.1K');
    expect(view.plays.ratio).toBe('3.6× theirs');
    expect(view.plays.tone).toBe('better');
  });

  it('Likes per reel: the same, with likes', () => {
    expect(view.likes.title).toBe('Likes per reel');
    expect(view.likes.ours).toBe('980');
    expect(view.likes.theirs).toBe('296');
    expect(view.likes.ratio).toBe('3.3× theirs');
  });

  it('Shares a week: all of them, ours · theirs, and the change on the week before', () => {
    expect(view.shares.title).toBe('Shares a week');
    expect(view.shares.subtitle).toBe('New shares on all their reels since Mon 19 Oct');
    expect(view.shares.value).toBe('2,140');
    expect(view.shares.split).toBe('Ours 1,610 · theirs 530');
    expect(view.shares.change).toBe('+38% on the week before');
    expect(view.shares.tone).toBe('better');
  });

  it("Shares a week: a line of the board's 8 weeks, ending on the number of the tile", () => {
    expect(view.shares.rows.map((row) => row.value)).toEqual([
      980, 1_210, 860, 1_400, 1_150, 1_550, 1_551, 2_140,
    ]);
    expect(view.shares.rows.at(-1)).toEqual({
      id: '2026-10-26T04:00:00.000Z',
      title: 'To Mon 26 Oct',
      value: 2_140,
    });
    // No dots on this one: only the Followers line marks weeks.
    expect(view.shares.rows.some((row) => row.marked !== undefined)).toBe(false);
  });

  it('names the last 90 days in the 90 range and the last 30 days in the 30 range', () => {
    expect(tilesView(falconNumbers('90'), OPTIONS).plays.subtitle).toBe(
      'Typical reel, last 90 days',
    );
    expect(tilesView(falconNumbers('30'), OPTIONS).likes.subtitle).toBe(
      'Typical reel, last 30 days',
    );
  });
});

describe('the tiles when something is missing', () => {
  it('writes "—" for a side with no reels and leaves the ratio line out', () => {
    const view = tilesView(small(), OPTIONS);
    expect(view.likes.ours).toBe('900');
    expect(view.likes.theirs).toBe('—');
    expect(view.likes.ratio).toBe('');
    expect(view.likes.tone).toBe('same');
  });

  it('shows the followers of a scan that is the only one, with no change line', () => {
    const numbers = small();
    numbers.tiles.followers = { now: 9_000, thisWeek: null, sinceUs: null, line: [] };
    const { followers } = tilesView(numbers, OPTIONS);
    expect(followers.value).toBe('9,000');
    expect(followers.change).toBe('');
    expect(followers.tone).toBe('same');
    expect(followers.rows).toEqual([]);
  });

  it('writes "—" for followers before the first scan has read the profile', () => {
    const numbers = small();
    numbers.tiles.followers = { now: null, thisWeek: null, sinceUs: null, line: [] };
    expect(tilesView(numbers, OPTIONS).followers.value).toBe('—');
  });

  it('writes only the part of the change it knows', () => {
    const numbers = small();
    numbers.tiles.followers = { now: 100, thisWeek: null, sinceUs: 40, line: [] };
    expect(tilesView(numbers, OPTIONS).followers.change).toBe('+40 since us');
    numbers.tiles.followers = { now: 100, thisWeek: 5, sinceUs: null, line: [] };
    expect(tilesView(numbers, OPTIONS).followers.change).toBe('+5 this week');
  });

  it('shows a drop in followers as worse, with the minus sign', () => {
    const numbers = small();
    numbers.tiles.followers = { now: 100, thisWeek: -12, sinceUs: 40, line: [] };
    const { followers } = tilesView(numbers, OPTIONS);
    expect(followers.change).toBe('−12 this week · +40 since us');
    expect(followers.tone).toBe('worse');
  });

  it('shows the ratio below 1 as worse', () => {
    const numbers = small();
    numbers.tiles.playsPerReel = { ours: 2_000, theirs: 5_000, ratio: 0.4 };
    const { plays } = tilesView(numbers, OPTIONS);
    expect(plays.ratio).toBe('0.4× theirs');
    expect(plays.tone).toBe('worse');
  });

  it('calls a ratio that rounds to 1.0× the same', () => {
    const numbers = small();
    numbers.tiles.playsPerReel = { ours: 5_040, theirs: 5_000, ratio: 1.008 };
    expect(tilesView(numbers, OPTIONS).plays.tone).toBe('same');
  });

  it('shares: says "this week" with one scan, and leaves the change out with no week before', () => {
    const { shares } = tilesView(small(), OPTIONS);
    expect(shares.subtitle).toBe('New shares on all their reels since Fri 23 Oct');
    expect(shares.value).toBe('42');
    expect(shares.split).toBe('Ours 30 · theirs 12');
    expect(shares.change).toBe('');

    const one = small();
    one.tiles.followers.line = one.tiles.followers.line.slice(0, 1);
    expect(tilesView(one, OPTIONS).shares.subtitle).toBe('New shares on all their reels this week');
  });

  it('shares: writes "—" when neither side is known', () => {
    const numbers = small();
    numbers.tiles.sharesAWeek = {
      thisWeek: { ours: null, theirs: null },
      weekBefore: { ours: null, theirs: null },
      line: [],
    };
    const { shares } = tilesView(numbers, OPTIONS);
    expect(shares.value).toBe('—');
    expect(shares.split).toBe('');
    expect(shares.change).toBe('');
  });

  it('shares: a drop is worse with the minus sign, and no change is "Same as the week before"', () => {
    const numbers = small();
    numbers.tiles.sharesAWeek = {
      thisWeek: { ours: 50, theirs: 50 },
      weekBefore: { ours: 100, theirs: 100 },
      line: [],
    };
    expect(tilesView(numbers, OPTIONS).shares).toMatchObject({
      change: '−50% on the week before',
      tone: 'worse',
    });
    numbers.tiles.sharesAWeek.weekBefore = { ours: 50, theirs: 50 };
    expect(tilesView(numbers, OPTIONS).shares).toMatchObject({
      change: 'Same as the week before',
      tone: 'same',
    });
  });

  it('shares: counts the side it knows when the other is missing', () => {
    const numbers = small();
    numbers.tiles.sharesAWeek = {
      thisWeek: { ours: 30, theirs: null },
      weekBefore: { ours: null, theirs: null },
      line: [],
    };
    const { shares } = tilesView(numbers, OPTIONS);
    expect(shares.value).toBe('30');
    expect(shares.split).toBe('Ours 30 · theirs —');
  });
});

describe('the lines of the tiles with little to draw', () => {
  it('Followers: a scan with no reel of ours before it has no dot, and one that has gets it', () => {
    const numbers = small();
    numbers.tiles.followers.line = [
      { at: '2026-10-16T04:00:00.000Z', followers: 100, ours: false },
      { at: '2026-10-23T04:00:00.000Z', followers: 110, ours: true },
      { at: '2026-10-30T04:00:00.000Z', followers: 120, ours: false },
    ];
    expect(tilesView(numbers, OPTIONS).followers.rows.map((row) => row.marked)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('Followers: no scan, no line and no dots', () => {
    const numbers = small();
    numbers.tiles.followers = { now: null, thisWeek: null, sinceUs: null, line: [] };
    expect(tilesView(numbers, OPTIONS).followers.rows).toEqual([]);
  });

  it('Shares a week: one scan has no line, and the tile still says "—"', () => {
    const numbers = small();
    numbers.tiles.sharesAWeek = {
      thisWeek: { ours: null, theirs: null },
      weekBefore: { ours: null, theirs: null },
      line: [],
    };
    const { shares } = tilesView(numbers, OPTIONS);
    expect(shares.rows).toEqual([]);
    expect(shares.value).toBe('—');
  });

  it('Shares a week: a week the scans cannot tell is a break in the line, not a 0', () => {
    const numbers = small();
    numbers.tiles.sharesAWeek.line = [
      { at: '2026-10-16T04:00:00.000Z', shares: 10 },
      { at: '2026-10-23T04:00:00.000Z', shares: null },
      { at: '2026-10-30T04:00:00.000Z', shares: 42 },
    ];
    const { shares } = tilesView(numbers, OPTIONS);
    expect(shares.rows.map((row) => row.value)).toEqual([10, null, 42]);
    expect(shares.rows.map((row) => row.title)).toEqual([
      'To Fri 16 Oct',
      'To Fri 23 Oct',
      'To Fri 30 Oct',
    ]);
  });
});
