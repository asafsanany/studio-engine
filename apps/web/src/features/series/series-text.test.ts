import { describe, expect, it } from 'vitest';
import { makeSeriesSummary } from '@/data/test-utils';
import { episodesText, orderSeries, seriesCountText, seriesDay } from './series-text';

describe('episodesText', () => {
  it('counts episodes, one in the singular', () => {
    expect(episodesText(0)).toBe('0 episodes');
    expect(episodesText(1)).toBe('1 episode');
    expect(episodesText(4)).toBe('4 episodes');
  });
});

describe('seriesCountText', () => {
  it('says "series" for one and for many', () => {
    expect(seriesCountText(1)).toBe('1 series');
    expect(seriesCountText(2)).toBe('2 series');
  });
});

describe('seriesDay', () => {
  it('writes the day and the short month, as the archive does', () => {
    expect(seriesDay('2026-10-21T10:00:00.000Z', 'UTC')).toBe('21 Oct');
    expect(seriesDay('2026-03-05T10:00:00.000Z', 'UTC')).toBe('5 Mar');
  });

  it('is empty for a time it cannot read', () => {
    expect(seriesDay('not a time')).toBe('');
  });
});

describe('orderSeries', () => {
  const myth = makeSeriesSummary({
    id: 'a',
    name: 'מיתוס או אמת',
    lastEpisodeAt: '2026-10-21T11:00:00.000Z',
  });
  const faq = makeSeriesSummary({
    id: 'b',
    name: 'שאלות נפוצות',
    lastEpisodeAt: '2026-10-21T10:55:00.000Z',
  });
  const empty = makeSeriesSummary({ id: 'c', name: 'Aaa', lastEpisodeAt: null });

  it('puts the series with the newest episode first, and one without episodes last', () => {
    expect(orderSeries([empty, faq, myth]).map((one) => one.id)).toEqual(['a', 'b', 'c']);
    expect(orderSeries([myth, empty, faq]).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a tie by name, then by id, whatever order they came in', () => {
    const same = '2026-10-21T11:00:00.000Z';
    const x = makeSeriesSummary({ id: 'x', name: 'Beta', lastEpisodeAt: same });
    const y = makeSeriesSummary({ id: 'y', name: 'Alpha', lastEpisodeAt: same });
    const z = makeSeriesSummary({ id: 'z', name: 'Alpha', lastEpisodeAt: same });
    expect(orderSeries([x, z, y]).map((one) => one.id)).toEqual(['y', 'z', 'x']);
    expect(orderSeries([y, x, z]).map((one) => one.id)).toEqual(['y', 'z', 'x']);
  });

  it('leaves the list it was given as it is', () => {
    const list = [faq, myth];
    orderSeries(list);
    expect(list.map((one) => one.id)).toEqual(['b', 'a']);
  });
});
