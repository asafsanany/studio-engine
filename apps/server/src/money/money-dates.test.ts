// The money maths counts in calendar days (YYYY-MM-DD), never in moments. These tests run it with
// the Mac's time zone set to extremes, across a daylight-saving change, to catch a Date creeping
// into it. (They live here, not next to the maths in @studio/shared, because that package is
// built without Node's types and needs `process.env.TZ`.)

import {
  chargesBetween,
  type MoneyFile,
  type MoneySubscription,
  moneyFileSchema,
  subscriptionCharges,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';

/** Each zone with what `new Date(2026, 5, 1).getTimezoneOffset()` says in it, to prove it took. */
const ZONES = [
  ['UTC', 0],
  ['Pacific/Kiritimati', -840], // UTC+14, the first place to reach a new day
  ['Pacific/Pago_Pago', 660], // UTC-11, the last
  ['Asia/Jerusalem', -180], // where the owner is; its summer time ends 2026-10-25
  ['America/New_York', 240],
] as const;

const original = process.env.TZ;

afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const subscription = (overrides: Partial<MoneySubscription>): MoneySubscription => ({
  id: 'claude',
  name: 'Claude Max plan',
  amount: 200,
  currency: 'USD',
  every: 'month',
  day: 1,
  since: '2026-01-01',
  ...overrides,
});

function inEveryZone(check: (zone: string) => void) {
  for (const [zone, offset] of ZONES) {
    process.env.TZ = zone;
    expect(new Date(2026, 5, 1).getTimezoneOffset(), `${zone} took effect`).toBe(offset);
    check(zone);
  }
}

describe('money dates do not depend on the time zone', () => {
  const file: MoneyFile = moneyFileSchema.parse({
    subscriptions: [
      subscription({ id: 'first', day: 1 }),
      subscription({ id: 'last', day: 31 }),
      subscription({ id: 'yearly', every: 'year', month: 10, day: 25 }),
    ],
    charges: [
      { date: '2026-10-25', item: 'Stock', what: 'Clip', amount: 5, currency: 'ILS' },
      { date: '2026-03-27', item: 'Stock', what: 'Clip', amount: 5, currency: 'ILS' },
    ],
  });

  it('puts every renewal of a year on the same days', () => {
    inEveryZone((zone) => {
      const lines = subscriptionCharges(file, '2026-01-01', '2026-12-31');
      expect(
        lines.filter((line) => line.subscriptionId === 'last').map((line) => line.date),
        zone,
      ).toEqual([
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
        '2026-05-31',
        '2026-06-30',
        '2026-07-31',
        '2026-08-31',
        '2026-09-30',
        '2026-10-31',
        '2026-11-30',
        '2026-12-31',
      ]);
      expect(
        lines.filter((line) => line.subscriptionId === 'first').map((line) => line.date),
        zone,
      ).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`));
      expect(
        lines.filter((line) => line.subscriptionId === 'yearly').map((line) => line.date),
        zone,
      ).toEqual(['2026-10-25']);
    });
  });

  it('keeps the days either side of a daylight-saving change apart', () => {
    inEveryZone((zone) => {
      // Israel's summer time started on 2026-03-27 and ended on 2026-10-25.
      const lines = chargesBetween(file, '2026-03-27', '2026-03-27');
      expect(
        lines.map((line) => line.date),
        zone,
      ).toEqual(['2026-03-27']);
      const autumn = chargesBetween(file, '2026-10-24', '2026-10-26');
      expect(
        autumn.map((line) => line.date),
        zone,
      ).toEqual(['2026-10-25', '2026-10-25']);
      expect(
        chargesBetween(file, '2026-10-26', '2026-10-31').map((l) => l.date),
        zone,
      ).toEqual(['2026-10-31']);
    });
  });
});
