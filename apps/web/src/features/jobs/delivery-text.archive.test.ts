import { describe, expect, it } from 'vitest';
import { archivedDay } from './delivery-text';

// 21 October 12:00 UTC is the 21st in every zone from UTC-12 to UTC+11.
describe('archivedDay: the browser’s local day a job was archived', () => {
  it('names the day and the month in English, “21 Oct”', () => {
    expect(archivedDay('2026-10-21T12:00:00.000Z', 'UTC')).toBe('21 Oct');
    expect(archivedDay('2026-11-05T09:00:00.000Z', 'UTC')).toBe('5 Nov');
  });

  it('moves with the zone, like a delivery’s day', () => {
    const late = '2026-10-21T23:30:00.000Z';
    expect(archivedDay(late, 'America/New_York')).toBe('21 Oct');
    expect(archivedDay(late, 'Asia/Jerusalem')).toBe('22 Oct');
  });

  it('uses the browser’s own zone when none is given', () => {
    const at = new Date('2026-10-21T12:00:00.000Z');
    expect(archivedDay(at.toISOString())).toBe(`${at.getDate()} Oct`);
  });

  it('says nothing for a time it cannot read', () => {
    expect(archivedDay('not a time', 'UTC')).toBe('');
  });
});
