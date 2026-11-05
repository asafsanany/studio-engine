import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  activeClientIds,
  countsForTheWeek,
  dueClients,
  lastCountingScan,
  nextScanAt,
  type ScanStamp,
  scanCutoff,
  systemTimeZone,
} from './scan-schedule.js';
import { SCAN_MESSAGES } from './scanner.js';

const JERUSALEM = 'Asia/Jerusalem';
const at = (iso: string) => Date.parse(iso);
const DAY = 24 * 60 * 60 * 1000;

const ended = (startedAt: string, patch: Partial<ScanStamp> = {}): ScanStamp => ({
  startedAt: at(startedAt),
  finishedAt: at(startedAt) + 30_000,
  outcome: 'ok',
  error: null,
  ...patch,
});

describe('which scans count as the week’s', () => {
  it('counts every way a scan can end, a real failure included', () => {
    for (const outcome of ['ok', 'private', 'not-found', 'no-token', 'no-credit'] as const) {
      expect(countsForTheWeek(ended('2026-10-26T04:10:00Z', { outcome })), outcome).toBe(true);
    }
    expect(
      countsForTheWeek(
        ended('2026-10-26T04:10:00Z', { outcome: 'failed', error: SCAN_MESSAGES.noAnswer }),
      ),
    ).toBe(true);
    expect(
      countsForTheWeek(
        ended('2026-10-26T04:10:00Z', { outcome: 'failed', error: SCAN_MESSAGES.accountChanged }),
      ),
    ).toBe(true);
  });

  it('does not count a scan that was stopped, so the next check scans again', () => {
    expect(
      countsForTheWeek(
        ended('2026-10-26T04:10:00Z', { outcome: 'failed', error: SCAN_MESSAGES.stopped }),
      ),
    ).toBe(false);
  });

  it('does not count a scan that never ended (the engine died in the middle of it)', () => {
    expect(
      countsForTheWeek(
        ended('2026-10-26T04:10:00Z', { finishedAt: null, outcome: null, error: null }),
      ),
    ).toBe(false);
  });

  it('finds the newest scan that counts among the recent ones', () => {
    const stopped = ended('2026-10-28T09:00:00Z', {
      outcome: 'failed',
      error: SCAN_MESSAGES.stopped,
    });
    const unfinished = ended('2026-10-27T09:00:00Z', {
      finishedAt: null,
      outcome: null,
      error: null,
    });
    const monday = ended('2026-10-26T04:10:00Z');
    const before = ended('2026-10-19T03:10:00Z');
    expect(lastCountingScan([stopped, unfinished, monday, before])).toBe(monday);
    expect(lastCountingScan([stopped, unfinished])).toBeNull();
    expect(lastCountingScan([])).toBeNull();
  });
});

describe('dueClients', () => {
  const account = (clientId: string, addedAt = at('2026-01-05T10:00:00Z')) => ({
    clientId,
    addedAt,
  });
  const lastScans = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([id, iso]) => [id, at(iso)]));

  it('is a client whose last scan started before the latest Monday 06:00 local time', () => {
    // Friday 30 Oct 2026: the cut-off is Monday 26 Oct 06:00 in Jerusalem (04:00Z).
    const now = at('2026-10-30T10:00:00Z');
    const due = dueClients(
      now,
      JERUSALEM,
      [account('last-week'), account('this-week'), account('new')],
      lastScans({ 'last-week': '2026-10-19T03:05:00Z', 'this-week': '2026-10-26T04:10:00Z' }),
      null,
    );
    expect(due).toEqual(['new', 'last-week']);
  });

  it('is not a client scanned at the cut-off itself, but is one scanned a second before it', () => {
    const now = at('2026-10-27T10:00:00Z');
    expect(
      dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-26T04:00:00Z' }), null),
    ).toEqual([]);
    expect(
      dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-26T03:59:59Z' }), null),
    ).toEqual(['a']);
  });

  it('is nobody on Monday before 06:00 who was scanned in the week before', () => {
    // Monday 26 Oct 05:59 in Jerusalem (03:59Z): the week of the 19th is still the week.
    const now = at('2026-10-26T03:59:00Z');
    expect(
      dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-19T03:05:00Z' }), null),
    ).toEqual([]);
  });

  describe('across the end of daylight saving in Asia/Jerusalem (25 Oct 2026)', () => {
    // Monday 19 Oct 06:00 is 03:00Z (UTC+3); Monday 26 Oct 06:00 is 04:00Z (UTC+2).
    it('is not due at 05:30 on Monday 26 Oct, which a fixed UTC+3 clock would call 06:30', () => {
      const now = at('2026-10-26T03:30:00Z');
      expect(
        dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-19T03:05:00Z' }), null),
      ).toEqual([]);
    });

    it('is due at 06:00 on Monday 26 Oct, 04:00Z', () => {
      const now = at('2026-10-26T04:00:00Z');
      expect(
        dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-19T03:05:00Z' }), null),
      ).toEqual(['a']);
    });

    it('counts a scan at 06:30 local on the 19th, 03:30Z, as the 19th’s, which a fixed UTC+2 clock would not', () => {
      const now = at('2026-10-21T10:00:00Z');
      expect(
        dueClients(now, JERUSALEM, [account('a')], lastScans({ a: '2026-10-19T03:30:00Z' }), null),
      ).toEqual([]);
    });

    it('does the same in spring (27 Mar 2026): Monday 30 Mar 06:00 is 03:00Z', () => {
      const scanned = lastScans({ a: '2026-03-23T04:05:00Z' });
      expect(
        dueClients(at('2026-03-30T02:30:00Z'), JERUSALEM, [account('a')], scanned, null),
      ).toEqual([]);
      expect(
        dueClients(at('2026-03-30T03:00:00Z'), JERUSALEM, [account('a')], scanned, null),
      ).toEqual(['a']);
    });
  });

  it('scans a client the Mac slept through at the next check: the missed Monday is still the cut-off', () => {
    // Asleep from Sunday to Wednesday: the Monday 06:00 scan did not happen.
    const scanned = lastScans({ a: '2026-10-19T03:05:00Z' });
    expect(
      dueClients(at('2026-10-25T20:00:00Z'), JERUSALEM, [account('a')], scanned, null),
    ).toEqual([]);
    expect(
      dueClients(at('2026-10-28T07:15:00Z'), JERUSALEM, [account('a')], scanned, null),
    ).toEqual(['a']);
  });

  it('puts the clients never scanned first, then the one scanned longest ago', () => {
    const now = at('2026-10-30T10:00:00Z');
    const accounts = [
      account('older', at('2026-09-01T10:00:00Z')),
      account('oldest', at('2026-09-02T10:00:00Z')),
      account('never-b', at('2026-10-20T10:00:00Z')),
      account('never-a', at('2026-10-10T10:00:00Z')),
    ];
    expect(
      dueClients(
        now,
        JERUSALEM,
        accounts,
        lastScans({ older: '2026-10-19T03:05:00Z', oldest: '2026-10-12T03:05:00Z' }),
        null,
      ),
    ).toEqual(['never-a', 'never-b', 'oldest', 'older']);
  });

  describe('Which clients', () => {
    const now = at('2026-10-30T10:00:00Z');
    const old = at('2026-01-05T10:00:00Z');

    it('skips a client with no job in the last 60 days under Active', () => {
      const active = new Set(['busy']);
      expect(
        dueClients(
          now,
          JERUSALEM,
          [account('busy', old), account('quiet', old)],
          lastScans({}),
          active,
        ),
      ).toEqual(['busy']);
    });

    it('scans every client under All', () => {
      expect(
        dueClients(
          now,
          JERUSALEM,
          [account('busy', old), account('quiet', old)],
          lastScans({}),
          null,
        ),
      ).toEqual(['busy', 'quiet']);
    });

    it('still scans an account added in the last 60 days under Active, so a new account scans', () => {
      const added = (daysAgo: number) => account('new', now - daysAgo * DAY);
      expect(dueClients(now, JERUSALEM, [added(0)], lastScans({}), new Set())).toEqual(['new']);
      expect(dueClients(now, JERUSALEM, [added(59)], lastScans({}), new Set())).toEqual(['new']);
      expect(dueClients(now, JERUSALEM, [added(61)], lastScans({}), new Set())).toEqual([]);
    });

    it('does not scan a client twice in a week, active or not', () => {
      expect(
        dueClients(
          now,
          JERUSALEM,
          [account('busy', old)],
          lastScans({ busy: '2026-10-26T04:10:00Z' }),
          new Set(['busy']),
        ),
      ).toEqual([]);
    });
  });

  it('takes a Date as well as milliseconds', () => {
    expect(
      dueClients(new Date('2026-10-30T10:00:00Z'), JERUSALEM, [account('a')], new Map(), null),
    ).toEqual(['a']);
  });
});

describe('activeClientIds', () => {
  const now = at('2026-10-30T10:00:00Z');

  it('has the clients with a job added or a delivery in the last 60 days', () => {
    const active = activeClientIds(
      now,
      [
        { clientId: 'added-lately', addedAt: '2026-10-01T10:00:00.000Z' },
        { clientId: 'added-long-ago', addedAt: '2026-04-01T10:00:00.000Z' },
        { clientId: 'edge', addedAt: new Date(now - ACTIVE_WINDOW_MS).toISOString() },
        { clientId: 'just-over', addedAt: new Date(now - ACTIVE_WINDOW_MS - 1).toISOString() },
      ],
      [
        { clientId: 'delivered-lately', deliveredAt: now - 5 * DAY },
        { clientId: 'delivered-long-ago', deliveredAt: now - 90 * DAY },
      ],
    );
    expect([...active].sort()).toEqual(['added-lately', 'delivered-lately', 'edge']);
  });

  it('is empty when nothing is recent', () => {
    expect(activeClientIds(now, [], []).size).toBe(0);
  });
});

describe('what scan-schedule hands on', () => {
  it('re-exports the week from @studio/shared', () => {
    const now = at('2026-10-30T10:00:00Z');
    expect(scanCutoff(now, JERUSALEM).toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(nextScanAt(now, JERUSALEM).toISOString()).toBe('2026-11-02T04:00:00.000Z');
  });

  it('names a time zone the Intl API knows', () => {
    expect(() => scanCutoff(new Date(), systemTimeZone())).not.toThrow();
  });
});
