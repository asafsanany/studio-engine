import { describe, expect, it } from 'vitest';
import { nextScanAt, SCAN_HOUR, scanCutoff } from './instagram-schedule.ts';

const JERUSALEM = 'Asia/Jerusalem';
const iso = (date: Date) => date.toISOString();
const at = (value: string) => new Date(value);

describe('scanCutoff', () => {
  it('is the latest Monday 06:00 local time at or before now', () => {
    // Friday 30 Oct 2026, 12:00 in Jerusalem (UTC+2 since 25 Oct): last Monday was 26 Oct.
    expect(iso(scanCutoff(at('2026-10-30T10:00:00Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
    // Sunday evening is still the week that began on Monday.
    expect(iso(scanCutoff(at('2026-11-01T20:00:00Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
  });

  it('is now itself at exactly Monday 06:00, and the week before one second earlier', () => {
    expect(iso(scanCutoff(at('2026-11-02T04:00:00Z'), JERUSALEM))).toBe('2026-11-02T04:00:00.000Z');
    expect(iso(scanCutoff(at('2026-11-02T03:59:59Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
    expect(iso(scanCutoff(at('2026-11-02T04:00:01Z'), JERUSALEM))).toBe('2026-11-02T04:00:00.000Z');
  });

  it('counts Monday before 06:00 as last week', () => {
    // Monday 2 Nov 05:59 in Jerusalem is 03:59 UTC.
    expect(iso(scanCutoff(at('2026-11-02T03:59:00Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
  });

  it('takes the number of milliseconds as well as a Date', () => {
    expect(iso(scanCutoff(Date.parse('2026-10-30T10:00:00Z'), JERUSALEM))).toBe(
      '2026-10-26T04:00:00.000Z',
    );
  });

  describe('across the daylight-saving change of Asia/Jerusalem', () => {
    // Israel went back to UTC+2 on Sunday 25 Oct 2026: Monday 19 Oct 06:00 is 03:00Z (UTC+3),
    // Monday 26 Oct 06:00 is 04:00Z (UTC+2).
    it('is 06:00 on the old clock for the Monday before the change', () => {
      expect(iso(scanCutoff(at('2026-10-19T03:00:00Z'), JERUSALEM))).toBe(
        '2026-10-19T03:00:00.000Z',
      );
      expect(iso(scanCutoff(at('2026-10-19T02:59:59Z'), JERUSALEM))).toBe(
        '2026-10-12T03:00:00.000Z',
      );
    });

    it('is 06:00 on the new clock for the Monday after it, a 169 hour week later', () => {
      expect(iso(scanCutoff(at('2026-10-26T04:00:00Z'), JERUSALEM))).toBe(
        '2026-10-26T04:00:00.000Z',
      );
      // 03:30 UTC on the 26th is 05:30 in Jerusalem now: still the week of the 19th.
      expect(iso(scanCutoff(at('2026-10-26T03:30:00Z'), JERUSALEM))).toBe(
        '2026-10-19T03:00:00.000Z',
      );
      const week = Date.parse('2026-10-26T04:00:00Z') - Date.parse('2026-10-19T03:00:00Z');
      expect(week / 3_600_000).toBe(169);
    });

    it('is 06:00 on the old clock again in spring, a 167 hour week later', () => {
      // Israel went forward on Friday 27 Mar 2026: Monday 23 Mar 06:00 is 04:00Z (UTC+2),
      // Monday 30 Mar 06:00 is 03:00Z (UTC+3).
      expect(iso(scanCutoff(at('2026-03-30T03:00:00Z'), JERUSALEM))).toBe(
        '2026-03-30T03:00:00.000Z',
      );
      expect(iso(scanCutoff(at('2026-03-30T02:59:00Z'), JERUSALEM))).toBe(
        '2026-03-23T04:00:00.000Z',
      );
      const week = Date.parse('2026-03-30T03:00:00Z') - Date.parse('2026-03-23T04:00:00Z');
      expect(week / 3_600_000).toBe(167);
    });

    it('reads a Sunday after the change as the week that began on the Monday before it', () => {
      // Sunday 25 Oct 2026 at 12:00 UTC: the change happened that morning.
      expect(iso(scanCutoff(at('2026-10-25T12:00:00Z'), JERUSALEM))).toBe(
        '2026-10-19T03:00:00.000Z',
      );
    });
  });

  it('follows the zone it is given', () => {
    const now = at('2026-11-02T09:00:00Z');
    // 06:00 in Jerusalem (UTC+2) is 04:00Z: already passed.
    expect(iso(scanCutoff(now, JERUSALEM))).toBe('2026-11-02T04:00:00.000Z');
    // 06:00 in New York (UTC-5 since 1 Nov) is 11:00Z: not yet, so last Monday's (UTC-4): 10:00Z.
    expect(iso(scanCutoff(now, 'America/New_York'))).toBe('2026-10-26T10:00:00.000Z');
    // UTC has no change at all.
    expect(iso(scanCutoff(now, 'UTC'))).toBe('2026-11-02T06:00:00.000Z');
  });

  it('is the Monday of the local week even when the local day is not the UTC day', () => {
    // Sunday 1 Nov 2026 23:30 UTC is already Monday 2 Nov 01:30 in Jerusalem: before 06:00, so
    // still last week's cutoff. In Los Angeles it is Sunday 15:30.
    const now = at('2026-11-01T23:30:00Z');
    expect(iso(scanCutoff(now, JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
    expect(iso(scanCutoff(now, 'America/Los_Angeles'))).toBe('2026-10-26T13:00:00.000Z');
  });

  it('throws for a time zone that does not exist', () => {
    expect(() => scanCutoff(new Date(), 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});

describe('nextScanAt', () => {
  it('is the first Monday 06:00 after now: Mon 2 Nov from Friday 30 Oct', () => {
    expect(iso(nextScanAt(at('2026-10-30T10:00:00Z'), JERUSALEM))).toBe('2026-11-02T04:00:00.000Z');
  });

  it('is the one a week on at exactly Monday 06:00, and today at 05:59', () => {
    expect(iso(nextScanAt(at('2026-11-02T04:00:00Z'), JERUSALEM))).toBe('2026-11-09T04:00:00.000Z');
    expect(iso(nextScanAt(at('2026-11-02T03:59:59Z'), JERUSALEM))).toBe('2026-11-02T04:00:00.000Z');
  });

  it('keeps 06:00 local across the change in October', () => {
    // From Friday 23 Oct (UTC+3) the next scan is Monday 26 Oct, on the new clock.
    expect(iso(nextScanAt(at('2026-10-23T10:00:00Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
    // From Monday 19 Oct 06:00 itself (03:00Z) it is a 169 hour week later.
    expect(iso(nextScanAt(at('2026-10-19T03:00:00Z'), JERUSALEM))).toBe('2026-10-26T04:00:00.000Z');
  });

  it('keeps 06:00 local across the change in March', () => {
    expect(iso(nextScanAt(at('2026-03-27T10:00:00Z'), JERUSALEM))).toBe('2026-03-30T03:00:00.000Z');
    expect(iso(nextScanAt(at('2026-03-23T04:00:00Z'), JERUSALEM))).toBe('2026-03-30T03:00:00.000Z');
  });

  it('is always after now, within a week and an hour, and 06:00 on a Monday wall clock', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: JERUSALEM,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    /** "Mon 06:00": the weekday and the time on the wall in Jerusalem. */
    const wall = (ms: number): string => {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
      );
      return `${parts.weekday} ${parts.hour}:${parts.minute}`;
    };
    // Every 90 minutes for a year: across both changes and every weekday.
    for (let ms = start; ms < start + 365 * 86_400_000; ms += 90 * 60_000) {
      const next = nextScanAt(ms, JERUSALEM).getTime();
      expect(next).toBeGreaterThan(ms);
      expect(next - ms).toBeLessThanOrEqual(7 * 86_400_000 + 3_600_000);
      expect(wall(next)).toBe('Mon 06:00');
      const cutoff = scanCutoff(ms, JERUSALEM).getTime();
      expect(cutoff).toBeLessThanOrEqual(ms);
      expect(ms - cutoff).toBeLessThan(7 * 86_400_000 + 3_600_000);
      expect(wall(cutoff)).toBe('Mon 06:00');
    }
  });

  it('is the cutoff of the following week', () => {
    const now = at('2026-10-30T10:00:00Z');
    expect(scanCutoff(nextScanAt(now, JERUSALEM), JERUSALEM).getTime()).toBe(
      nextScanAt(now, JERUSALEM).getTime(),
    );
  });
});

it('names the hour the scan is due from', () => {
  expect(SCAN_HOUR).toBe(6);
});
