import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_CAP,
  ENGAGEMENT_LEGEND,
  ENGAGEMENT_SERIES,
  ENGAGEMENT_TICKS,
  engagementChartView,
  engagementFigure,
  spreadNames,
} from './engagement-view';
import { COMMENTS, LIKES, SHARES, VIEWS } from './instagram-colors';
import { FALCON_NOW, FALCON_TIME_ZONE, falconNumbers, falconReels } from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

describe('Views, likes, comments and shares (E1) with the board’s numbers', () => {
  const view = engagementChartView(falconNumbers('since'), falconReels(), OPTIONS);

  it('has a column for each reel of the range, oldest first', () => {
    expect(view.hasData).toBe(true);
    expect(view.rows).toHaveLength(22);
    expect(view.rows.at(-1)?.id).toBe('Falcon21');
    expect(view.labels.filter((label) => label)).toEqual(['Aug', 'Sep', 'Oct']);
  });

  it('draws one axis: 0, 1, 5, 10 and 15 times, capped at 15', () => {
    expect(ENGAGEMENT_TICKS).toEqual([0, 1, 5, 10, 15]);
    expect(ENGAGEMENT_CAP).toBe(15);
  });

  it('colours views green, likes blue, comments orange and shares pale yellow', () => {
    expect(ENGAGEMENT_SERIES.map(({ key, color }) => [key, color])).toEqual([
      ['plays', VIEWS],
      ['likes', LIKES],
      ['comments', COMMENTS],
      ['shares', SHARES],
    ]);
    expect(LIKES).toBe('#3B82F6');
    expect(COMMENTS).toBe('#F97316');
    expect(SHARES).toBe('#FDE68A');
    expect(VIEWS).toBe('#34D399');
    expect(ENGAGEMENT_LEGEND.map((item) => item.label)).toEqual([
      'Views',
      'Likes',
      'Comments',
      'Shares',
      'Our reel',
    ]);
  });

  it('gives each reel its views, likes, comments and shares as a multiple of their usual', () => {
    const granite = view.rows.at(-1);
    expect(granite?.times.plays).toBeCloseTo(9800 / 6100, 5);
    expect(granite?.times.likes).toBeCloseTo(610 / 406, 5);
    expect(granite?.times.comments).toBeCloseTo(22 / 17, 5);
    expect(granite?.times.shares).toBeCloseTo(140 / 88, 5);
    expect(granite?.likes).toBe(granite?.times.likes);
  });

  it('puts a pale band behind our reels only', () => {
    expect(view.rows.filter((row) => row.band !== null)).toHaveLength(7);
    expect(view.rows.every((row) => (row.band !== null) === row.ours)).toBe(true);
    expect(view.rows.find((row) => row.ours)?.band).toBe(15);
  });

  it('draws what goes above 15 times at 15 and tells the card so', () => {
    const wide = falconNumbers('since');
    const first = wide.engagement[0];
    if (first === undefined) throw new Error('the fixture has reels');
    first.shares = 40;
    const capped = engagementChartView(wide, falconReels(), OPTIONS);
    expect(capped.rows[0]?.shares).toBe(15);
    expect(capped.rows[0]?.times.shares).toBe(40);
    expect(capped.capped).toBe(true);
    expect(view.capped).toBe(false);
  });

  it('names the since day, not the first scan, when the account is ours since before it', () => {
    const numbers = { ...falconNumbers('since'), sinceUs: '2026-10-23' };
    expect(engagementChartView(numbers, falconReels(), OPTIONS).subtitle).toContain(
      'Every reel since us (23 Oct), each against',
    );
  });

  it('says the range, their usual reel and the bands in the subtitle', () => {
    expect(view.subtitle).toBe(
      'Every reel since us (3 Aug), each against their usual reel (views 6,100, likes 406, comments 17, shares 88) · blue bands are our reels',
    );
    expect(engagementChartView(falconNumbers('90'), falconReels(), OPTIONS).subtitle).toContain(
      'Every reel of the last 90 days, each against',
    );
  });

  it('names the reel in the hover card: its caption and who it is', () => {
    const positano = view.rows.find((row) => row.id === 'Falcon17');
    expect(positano?.title).toBe('Positano from above');
    expect(positano?.note).toBe('Ours · סרטון אינסטגרם חוף · Wed 14 Oct');
  });

  it('writes the multiple and the count of each series for the hover card', () => {
    const positano = view.rows.find((row) => row.id === 'Falcon17');
    if (positano === undefined) throw new Error('the fixture has the reel');
    expect(engagementFigure(positano, 'plays')).toEqual({ value: '6.8×', note: '41,200 views' });
    expect(engagementFigure(positano, 'likes')).toEqual({ value: '5.7×', note: '2,310 likes' });
    expect(engagementFigure(positano, 'comments')).toEqual({ value: '5.6×', note: '96 comments' });
    expect(engagementFigure(positano, 'shares')).toEqual({ value: '14×', note: '1,240 shares' });
  });
});

describe('Views, likes, comments and shares when something is missing', () => {
  it('has no data with no reel in the range', () => {
    const numbers = { ...falconNumbers('since'), engagement: [] };
    expect(engagementChartView(numbers, falconReels(), OPTIONS).hasData).toBe(false);
  });

  it('leaves a series out of the hover card when there is no multiple, and breaks the line there', () => {
    const numbers = falconNumbers('since');
    const last = numbers.engagement.at(-1);
    if (last === undefined) throw new Error('the fixture has reels');
    last.shares = null;
    const view = engagementChartView(numbers, falconReels(), OPTIONS);
    const row = view.rows.at(-1);
    expect(row?.shares).toBeNull();
    if (row === undefined) throw new Error('has a last row');
    expect(engagementFigure(row, 'shares')).toBeNull();
    expect(engagementFigure(row, 'likes')).not.toBeNull();
  });

  it('writes no count when the page does not have the reel', () => {
    const view = engagementChartView(falconNumbers('since'), [], OPTIONS);
    const row = view.rows.at(-1);
    if (row === undefined) throw new Error('has a last row');
    expect(engagementFigure(row, 'likes')?.note).toBeUndefined();
    expect(row.title).toBe('Reel of Sun 25 Oct');
  });

  it('has no views line for an answer without views', () => {
    const numbers = falconNumbers('since');
    for (const point of numbers.engagement) delete point.plays;
    const row = engagementChartView(numbers, falconReels(), OPTIONS).rows.at(-1);
    if (row === undefined) throw new Error('has a last row');
    expect(row.plays).toBeNull();
    expect(engagementFigure(row, 'plays')).toBeNull();
  });

  it('leaves what their usual is out of the subtitle when there is none', () => {
    const numbers = falconNumbers('since');
    numbers.usual = { plays: null, likes: null, comments: null, shares: null };
    expect(engagementChartView(numbers, falconReels(), OPTIONS).subtitle).toBe(
      'Every reel since us (3 Aug), each against their usual reel · blue bands are our reels',
    );
  });
});

describe('the names at the line ends', () => {
  it('leaves each name on its line when the lines end apart', () => {
    expect(spreadNames([40, 200, 120], 13)).toEqual([40, 200, 120]);
  });

  it('stacks names that would touch around the middle of their lines, in their lines’ order', () => {
    // Likes and shares end 4 px apart: one name 6.5 px above their middle, one 6.5 px below.
    expect(spreadNames([100, 300, 104], 13)).toEqual([95.5, 300, 108.5]);
  });

  it('stacks a third name onto two that already touch', () => {
    expect(spreadNames([200, 201, 202, 50], 13)).toEqual([188, 201, 214, 50]);
  });
});
