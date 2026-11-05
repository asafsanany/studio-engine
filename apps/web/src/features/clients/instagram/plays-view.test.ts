import { describe, expect, it } from 'vitest';
import { OURS, TYPICAL_THEIRS } from './instagram-colors';
import { playsChartView } from './plays-view';
import { FALCON_NOW, FALCON_TIME_ZONE, falconNumbers, falconReels } from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

describe('Plays of every reel with the board’s numbers', () => {
  const view = playsChartView(falconNumbers('since'), falconReels(), OPTIONS);

  it('has a bar for each reel of the range, oldest first, ours and theirs told apart', () => {
    expect(view.hasData).toBe(true);
    expect(view.rows).toHaveLength(22);
    expect(view.rows[0]).toMatchObject({ plays: 3_200, ours: false });
    expect(view.rows.at(-1)).toMatchObject({ plays: 9_800, ours: true });
    expect(view.rows.filter((row) => row.ours)).toHaveLength(7);
  });

  it('says the range, the reels and how many of them are ours', () => {
    expect(view.subtitle).toBe('Since us (3 Aug) · 22 reels, 7 of them ours');
    expect(view.ariaLabel).toBe('Plays of the 22 reels, since us (3 Aug), ours in blue');
    expect(playsChartView(falconNumbers('90'), falconReels(), OPTIONS).subtitle).toBe(
      'Last 90 days · 22 reels, 7 of them ours',
    );
    expect(playsChartView(falconNumbers('30'), falconReels(), OPTIONS).subtitle).toBe(
      'Last 30 days · 10 reels, 5 of them ours',
    );
  });

  it('names the since day, not the first scan, when the account is ours since before it', () => {
    // Ours since 23 Oct, first scan 30 Oct: the reels of 26 and 28 Oct are under Since us.
    const numbers = {
      ...falconNumbers('since'),
      sinceUs: '2026-10-23',
      plays: falconNumbers('since').plays.slice(-2),
    };
    const since = playsChartView(numbers, falconReels(), OPTIONS);
    expect(since.subtitle).toMatch(/^Since us \(23 Oct\) · 2 reels, /);
    expect(since.ariaLabel).toBe(`Plays of the 2 reels, since us (23 Oct), ours in blue`);
  });

  it('draws a dashed line at the typical reel of each side, with its words', () => {
    expect(view.lines).toEqual([
      { value: 18_400, color: OURS, text: 'Ours, typical 18.4K' },
      { value: 5_100, color: TYPICAL_THEIRS, text: 'Theirs, typical 5.1K' },
    ]);
  });

  it('puts the month’s name under the first reel of each month', () => {
    const named = view.labels.map((label, index) => [index, label]).filter(([, label]) => label);
    expect(named).toEqual([
      [0, 'Aug'],
      [7, 'Sep'],
      [14, 'Oct'],
    ]);
    expect(view.labels).toHaveLength(22);
  });

  it('has a grid from 0 up past the tallest bar', () => {
    expect(view.scale.ticks[0]).toBe(0);
    expect(view.scale.max).toBeGreaterThanOrEqual(41_200);
    expect(view.scale.ticks.at(-1)).toBe(view.scale.max);
  });

  it('makes the hover card from the reel’s caption and what it says about it', () => {
    const granite = view.rows.at(-1);
    expect(granite?.title).toBe('Granite Fiber, one take through the warehouse');
    expect(granite?.note).toBe('Ours · Granite · Sun 25 Oct · 1.6× their usual');
    const practice = view.rows.at(-2);
    expect(practice?.note).toBe('Theirs · Thu 22 Oct · 0.7× their usual');
  });
});

describe('Plays of every reel when something is missing', () => {
  it('has no data with no reel in the range', () => {
    const numbers = { ...falconNumbers('since'), plays: [] };
    const view = playsChartView(numbers, falconReels(), OPTIONS);
    expect(view.hasData).toBe(false);
    expect(view.subtitle).toBe('Since us (3 Aug) · 0 reels, none of them ours');
  });

  it('leaves out the line of a side with no typical reel', () => {
    const numbers = falconNumbers('since');
    numbers.tiles.playsPerReel = { ours: null, theirs: 5_100, ratio: null };
    expect(playsChartView(numbers, falconReels(), OPTIONS).lines.map((line) => line.text)).toEqual([
      'Theirs, typical 5.1K',
    ]);
  });

  it('gives the grid room for a typical line above the tallest bar', () => {
    const numbers = falconNumbers('since');
    numbers.plays = numbers.plays.slice(0, 2);
    numbers.tiles.playsPerReel = { ours: 90_000, theirs: 1_000, ratio: 90 };
    expect(playsChartView(numbers, falconReels(), OPTIONS).scale.max).toBeGreaterThanOrEqual(
      90_000,
    );
  });

  it('says "all ours" and "1 reel" when that is true', () => {
    const numbers = falconNumbers('since');
    numbers.plays = numbers.plays.filter((point) => point.ours).slice(0, 1);
    expect(playsChartView(numbers, falconReels(), OPTIONS).subtitle).toBe(
      'Since us (3 Aug) · 1 reel, all ours',
    );
  });

  it('makes a heading from the date for a reel the page does not have, and leaves out "their usual" without one', () => {
    const numbers = falconNumbers('since');
    numbers.usual = { plays: null, likes: null, comments: null, shares: null };
    const view = playsChartView(numbers, [], OPTIONS);
    expect(view.rows.at(-1)).toMatchObject({
      title: 'Reel of Sun 25 Oct',
      note: 'Ours · Sun 25 Oct',
    });
  });

  it('cuts a long caption and puts it on one line', () => {
    const reels = falconReels();
    const granite = reels[0];
    if (granite === undefined) throw new Error('the fixture has reels');
    granite.caption = `Line one\n\n${'long '.repeat(40)}`;
    const title = playsChartView(falconNumbers('since'), reels, OPTIONS).rows.at(-1)?.title ?? '';
    expect(title.startsWith('Line one long long')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title).not.toContain('\n');
  });
});
