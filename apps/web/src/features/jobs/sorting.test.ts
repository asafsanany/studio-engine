import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { compareSortValues, lastUpdatedOrder, tieBreakOrder, toMs } from './sorting';

describe('toMs', () => {
  it('reads an ISO timestamp as epoch milliseconds', () => {
    expect(toMs('2026-10-20T13:41:00.000Z')).toBe(Date.parse('2026-10-20T13:41:00.000Z'));
  });

  it('does not let an unparsable time poison a comparison with NaN: it is the oldest', () => {
    expect(toMs('not a time')).toBe(0);
    expect(toMs('')).toBe(0);
  });
});

describe('compareSortValues', () => {
  it('compares numbers as numbers (9 before 10)', () => {
    expect(compareSortValues(9, 10)).toBeLessThan(0);
    expect(compareSortValues(10, 9)).toBeGreaterThan(0);
    expect(compareSortValues(5, 5)).toBe(0);
  });

  it('compares text without regard to case or accents', () => {
    expect(compareSortValues('arc fitness', 'Arc Fitness')).toBe(0);
    expect(compareSortValues('Café', 'cafe')).toBe(0);
    expect(compareSortValues('Apartment', 'studio')).toBeLessThan(0);
  });

  it('puts "Clip 2" before "Clip 10"', () => {
    expect(compareSortValues('Clip 2', 'Clip 10')).toBeLessThan(0);
  });

  it('sorts Hebrew after Latin, and Hebrew names alphabetically among themselves', () => {
    expect(compareSortValues('Zeta', 'אלף')).toBeLessThan(0);
    expect(compareSortValues('אלף', 'בית')).toBeLessThan(0);
    const sorted = ['מרפאת מירה', 'Kova Coffee', 'טל נכסים', 'Arc Fitness'].sort(compareSortValues);
    expect(sorted).toEqual(['Arc Fitness', 'Kova Coffee', 'טל נכסים', 'מרפאת מירה']);
  });
});

describe('tieBreakOrder', () => {
  it('puts the job added last first, then orders by id', () => {
    const jobs = [
      makeJob({ id: 'b', addedAt: '2026-10-20T10:00:00.000Z' }),
      makeJob({ id: 'z', addedAt: '2026-10-20T12:00:00.000Z' }),
      makeJob({ id: 'a', addedAt: '2026-10-20T10:00:00.000Z' }),
    ];
    expect(tieBreakOrder(jobs).map((j) => j.id)).toEqual(['z', 'a', 'b']);
  });

  it('does not change the list it is given', () => {
    const jobs = [makeJob({ id: 'b' }), makeJob({ id: 'a' })];
    tieBreakOrder(jobs);
    expect(jobs.map((j) => j.id)).toEqual(['b', 'a']);
  });
});

describe('lastUpdatedOrder', () => {
  const at = (updatedAt: string) => ({ updatedAt });

  it('puts the job updated last first', () => {
    const jobs = [
      makeJob({ id: 'a', ...at('2026-10-20T10:00:00.000Z') }),
      makeJob({ id: 'b', ...at('2026-10-20T12:00:00.000Z') }),
      makeJob({ id: 'c', ...at('2026-10-20T11:00:00.000Z') }),
    ];
    expect(lastUpdatedOrder(jobs).map((j) => j.id)).toEqual(['b', 'c', 'a']);
  });

  it('keeps jobs updated at the same moment in the tie-break order: added last first, then id', () => {
    const same = at('2026-10-20T12:00:00.000Z');
    const jobs = [
      makeJob({ id: 'x1', addedAt: '2026-10-20T09:00:00.000Z', ...same }),
      makeJob({ id: 'x2', addedAt: '2026-10-20T10:00:00.000Z', ...same }),
      makeJob({ id: 'x3', addedAt: '2026-10-20T08:00:00.000Z', ...same }),
      makeJob({ id: 'x0', addedAt: '2026-10-20T09:00:00.000Z', ...same }),
    ];
    expect(lastUpdatedOrder(jobs).map((j) => j.id)).toEqual(['x2', 'x0', 'x1', 'x3']);
  });

  it('gives the same order whatever order the cache holds the jobs in', () => {
    const jobs = [
      makeJob({ id: 'a', addedAt: '2026-10-20T08:00:00.000Z', ...at('2026-10-20T10:00:00.000Z') }),
      makeJob({ id: 'b', addedAt: '2026-10-20T09:00:00.000Z', ...at('2026-10-20T10:00:00.000Z') }),
      makeJob({ id: 'c', addedAt: '2026-10-20T07:00:00.000Z', ...at('2026-10-20T11:00:00.000Z') }),
    ];
    const expected = ['c', 'b', 'a'];
    expect(lastUpdatedOrder(jobs).map((j) => j.id)).toEqual(expected);
    expect(lastUpdatedOrder([...jobs].reverse()).map((j) => j.id)).toEqual(expected);
  });

  it('puts a job with an unparsable time last, as the oldest', () => {
    const jobs = [
      makeJob({ id: 'a', ...at('not a time') }),
      makeJob({ id: 'b', ...at('2026-10-20T10:00:00.000Z') }),
    ];
    expect(lastUpdatedOrder(jobs).map((j) => j.id)).toEqual(['b', 'a']);
  });

  it('does not change the list it is given', () => {
    const jobs = [
      makeJob({ id: 'a', ...at('2026-10-20T10:00:00.000Z') }),
      makeJob({ id: 'b', ...at('2026-10-20T12:00:00.000Z') }),
    ];
    lastUpdatedOrder(jobs);
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b']);
  });
});
