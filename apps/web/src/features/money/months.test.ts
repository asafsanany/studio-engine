import { describe, expect, it } from 'vitest';
import { monthOptions } from './months';

describe('monthOptions', () => {
  it('lists the server months, newest first', () => {
    expect(monthOptions('2026-10', ['2026-08', '2026-10', '2026-09'])).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
    ]);
  });

  it('is just the month shown before the list has arrived', () => {
    expect(monthOptions('2026-10', undefined)).toEqual(['2026-10']);
  });

  it('adds the month shown when the server does not list it, in its place, once', () => {
    expect(monthOptions('2026-11', ['2026-10', '2026-09'])).toEqual([
      '2026-11',
      '2026-10',
      '2026-09',
    ]);
    expect(monthOptions('2026-09', ['2026-10', '2026-09'])).toEqual(['2026-10', '2026-09']);
  });

  it('sorts across a year', () => {
    expect(monthOptions('2026-01', ['2025-12', '2026-01'])).toEqual(['2026-01', '2025-12']);
  });
});
