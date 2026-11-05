import { describe, expect, it } from 'vitest';
import {
  addMonths,
  chargesBetween,
  DEFAULT_MONEY,
  DEFAULT_PRICE_PER_JOB,
  DEFAULT_USD_TO_ILS,
  daysInMonth,
  isCalendarDay,
  isMonth,
  localMonthOf,
  type MoneyFile,
  type MoneySubscription,
  moneyFileSchema,
  monthRange,
  monthSchema,
  priceForClient,
  roundIls,
  subscriptionCharges,
  toIls,
} from './money.ts';

/** Parses a hand-written file the way the loader does, so the tests use real defaults. */
function money(input: unknown = {}): MoneyFile {
  return moneyFileSchema.parse(input);
}

function subscription(overrides: Partial<MoneySubscription> = {}): MoneySubscription {
  return {
    id: 'claude',
    name: 'Claude Max plan',
    amount: 200,
    currency: 'USD',
    every: 'month',
    day: 12,
    since: '2026-08-12',
    ...overrides,
  };
}

const dates = (lines: { date: string }[]) => lines.map((line) => line.date);

describe('moneyFileSchema', () => {
  it('accepts {} and fills in every default', () => {
    expect(money({})).toEqual({
      currency: 'ILS',
      usdToIls: 3.7,
      pricePerJob: 200,
      clientPrices: {},
      subscriptions: [],
      charges: [],
    });
    expect(DEFAULT_MONEY).toEqual(money({}));
    expect(DEFAULT_USD_TO_ILS).toBe(3.7);
    expect(DEFAULT_PRICE_PER_JOB).toBe(200);
  });

  it('accepts the full example', () => {
    const file = money({
      currency: 'ILS',
      usdToIls: 3.6,
      pricePerJob: 250,
      clientPrices: { 'Lumen Yoga': 300 },
      subscriptions: [
        {
          id: 'claude',
          name: 'Claude Max plan',
          amount: 200,
          currency: 'USD',
          every: 'month',
          day: 12,
          since: '2026-08-12',
        },
        {
          id: 'domain',
          name: 'Domain',
          amount: 40,
          currency: 'USD',
          every: 'year',
          day: 3,
          month: 2,
          since: '2026-02-03',
          until: '2028-02-03',
        },
      ],
      charges: [
        {
          date: '2026-10-14',
          item: 'Stock footage',
          what: 'Clip licence #4831',
          amount: 7.5,
          currency: 'ILS',
          job: 'Lumen Yoga/Retreat teaser',
        },
      ],
    });
    expect(file.subscriptions).toHaveLength(2);
    expect(file.charges[0]?.job).toBe('Lumen Yoga/Retreat teaser');
  });

  it('refuses unknown keys at every level', () => {
    expect(moneyFileSchema.safeParse({ pricePerjob: 200 }).success).toBe(false);
    expect(
      moneyFileSchema.safeParse({ subscriptions: [{ ...subscription(), extra: 1 }] }).success,
    ).toBe(false);
    expect(
      moneyFileSchema.safeParse({
        charges: [
          { date: '2026-10-14', item: 'a', what: 'b', amount: 1, currency: 'ILS', jobb: 'x/y' },
        ],
      }).success,
    ).toBe(false);
  });

  it('only allows ILS as the file currency', () => {
    expect(moneyFileSchema.safeParse({ currency: 'USD' }).success).toBe(false);
  });

  it('needs a positive rate and non-negative amounts', () => {
    expect(moneyFileSchema.safeParse({ usdToIls: 0 }).success).toBe(false);
    expect(moneyFileSchema.safeParse({ usdToIls: -3.7 }).success).toBe(false);
    expect(moneyFileSchema.safeParse({ pricePerJob: -1 }).success).toBe(false);
    expect(moneyFileSchema.safeParse({ pricePerJob: '200' }).success).toBe(false);
    expect(moneyFileSchema.safeParse({ clientPrices: { A: -5 } }).success).toBe(false);
    expect(
      moneyFileSchema.safeParse({ subscriptions: [subscription({ amount: -1 })] }).success,
    ).toBe(false);
  });

  it('accepts only real calendar days', () => {
    const charge = (date: string) => ({ date, item: 'a', what: 'b', amount: 1, currency: 'ILS' });
    expect(moneyFileSchema.safeParse({ charges: [charge('2026-02-28')] }).success).toBe(true);
    expect(moneyFileSchema.safeParse({ charges: [charge('2028-02-29')] }).success).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-1-5',
      '14/10/2026',
      '',
    ]) {
      expect(moneyFileSchema.safeParse({ charges: [charge(bad)] }).success, bad).toBe(false);
    }
  });

  it('keeps day within 1-31 and month within 1-12', () => {
    const parse = (overrides: Partial<MoneySubscription>) =>
      moneyFileSchema.safeParse({ subscriptions: [subscription(overrides)] }).success;
    expect(parse({ day: 0 })).toBe(false);
    expect(parse({ day: 32 })).toBe(false);
    expect(parse({ day: 1.5 })).toBe(false);
    expect(parse({ day: 31 })).toBe(true);
    expect(parse({ every: 'year', month: 0 })).toBe(false);
    expect(parse({ every: 'year', month: 13 })).toBe(false);
    expect(parse({ every: 'year', month: 12 })).toBe(true);
  });

  it('needs a month for a yearly subscription and refuses one on a monthly', () => {
    const yearlyNoMonth = moneyFileSchema.safeParse({
      subscriptions: [subscription({ every: 'year' })],
    });
    expect(yearlyNoMonth.success).toBe(false);
    expect(yearlyNoMonth.error?.issues[0]?.path).toEqual(['subscriptions', 0, 'month']);
    expect(
      moneyFileSchema.safeParse({ subscriptions: [subscription({ every: 'month', month: 3 })] })
        .success,
    ).toBe(false);
  });

  it('refuses an until before since, and a currency other than ILS or USD', () => {
    expect(
      moneyFileSchema.safeParse({ subscriptions: [subscription({ until: '2026-08-11' })] }).success,
    ).toBe(false);
    expect(
      moneyFileSchema.safeParse({ subscriptions: [subscription({ until: '2026-08-12' })] }).success,
    ).toBe(true);
    expect(
      moneyFileSchema.safeParse({ subscriptions: [{ ...subscription(), currency: 'EUR' }] })
        .success,
    ).toBe(false);
  });

  it('refuses two subscriptions with the same id, pointing at the second', () => {
    const result = moneyFileSchema.safeParse({
      subscriptions: [subscription(), subscription({ name: 'Other' })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['subscriptions', 1, 'id']);
  });

  it('wants a job as Client/Job', () => {
    const charge = (job: string) => ({
      date: '2026-10-14',
      item: 'a',
      what: 'b',
      amount: 1,
      currency: 'ILS',
      job,
    });
    expect(
      moneyFileSchema.safeParse({ charges: [charge('Lumen Yoga/Retreat teaser')] }).success,
    ).toBe(true);
    for (const bad of ['Lumen Yoga', 'Lumen Yoga/', '/Retreat', 'A/B/C', '']) {
      expect(moneyFileSchema.safeParse({ charges: [charge(bad)] }).success, bad).toBe(false);
    }
  });
});

describe('calendar days', () => {
  it('knows the length of every month, leap years included', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it('recognises calendar days', () => {
    expect(isCalendarDay('2026-10-21')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-10-21T00:00:00Z')).toBe(false);
  });
});

describe('roundIls', () => {
  it('rounds to the agora, halves away from zero, and drops float noise', () => {
    expect(roundIls(740.0000000000001)).toBe(740);
    expect(roundIls(1.005)).toBe(1.01);
    expect(roundIls(2.675)).toBe(2.68);
    expect(roundIls(-1.005)).toBe(-1.01);
    expect(roundIls(0.004)).toBe(0);
    expect(Object.is(roundIls(-0.004), 0)).toBe(true);
    expect(roundIls(1e-9)).toBe(0);
    expect(roundIls(1e21)).toBe(1e21);
  });
});

describe('toIls', () => {
  const file = money({ usdToIls: 3.7 });

  it('leaves shekels as they are', () => {
    expect(toIls(49, 'ILS', file)).toBe(49);
    expect(toIls(7.5, 'ILS', file)).toBe(7.5);
  });

  it('converts dollars at usdToIls', () => {
    expect(toIls(200, 'USD', file)).toBe(740);
    expect(toIls(22, 'USD', file)).toBe(81.4);
    expect(toIls(1, 'USD', money({ usdToIls: 3.65 }))).toBe(3.65);
  });

  it('rounds a converted amount to the agora', () => {
    expect(toIls(9.99, 'USD', money({ usdToIls: 3.7 }))).toBe(36.96);
    expect(toIls(0, 'USD', file)).toBe(0);
  });
});

describe('priceForClient', () => {
  const file = money({ pricePerJob: 200, clientPrices: { 'Lumen Yoga': 250, Free: 0 } });

  it('uses the client price when there is one', () => {
    expect(priceForClient(file, 'Lumen Yoga')).toBe(250);
  });

  it('falls back to pricePerJob', () => {
    expect(priceForClient(file, 'Someone Else')).toBe(200);
    expect(priceForClient(money(), 'Anyone')).toBe(200);
  });

  it('honours a price of 0', () => {
    expect(priceForClient(file, 'Free')).toBe(0);
  });

  it('matches names case-sensitively', () => {
    expect(priceForClient(file, 'lumen yoga')).toBe(200);
  });

  it('does not mistake object keys for clients', () => {
    expect(priceForClient(file, 'constructor')).toBe(200);
    expect(priceForClient(file, 'toString')).toBe(200);
  });

  it('matches a precomposed and a decomposed spelling of the same name', () => {
    const precomposed = 'Café Bonjour';
    const decomposed = 'Café Bonjour';
    expect(precomposed).not.toBe(decomposed);
    const priced = money({ clientPrices: { [precomposed]: 300 } });
    expect(priceForClient(priced, decomposed)).toBe(300);
    expect(priceForClient(money({ clientPrices: { [decomposed]: 300 } }), precomposed)).toBe(300);
  });
});

describe('subscriptionCharges', () => {
  it('gives one charge per month on the renewal day', () => {
    const file = money({ subscriptions: [subscription()] });
    const lines = subscriptionCharges(file, '2026-08-01', '2026-11-30');
    expect(dates(lines)).toEqual(['2026-08-12', '2026-09-12', '2026-10-12', '2026-11-12']);
    expect(lines[0]).toEqual({
      date: '2026-08-12',
      item: 'Claude Max plan',
      what: 'Monthly subscription',
      amount: 200,
      currency: 'USD',
      ils: 740,
      subscriptionId: 'claude',
    });
  });

  it('includes both ends of the range', () => {
    const file = money({ subscriptions: [subscription()] });
    expect(dates(subscriptionCharges(file, '2026-09-12', '2026-10-12'))).toEqual([
      '2026-09-12',
      '2026-10-12',
    ]);
    expect(subscriptionCharges(file, '2026-09-13', '2026-10-11')).toEqual([]);
  });

  it('gives nothing before since, and since itself counts', () => {
    const file = money({ subscriptions: [subscription({ since: '2026-08-12' })] });
    expect(subscriptionCharges(file, '2026-01-01', '2026-08-11')).toEqual([]);
    expect(dates(subscriptionCharges(file, '2026-01-01', '2026-08-12'))).toEqual(['2026-08-12']);
  });

  it("skips the first month when since is after that month's renewal day", () => {
    const file = money({ subscriptions: [subscription({ since: '2026-08-20' })] });
    expect(dates(subscriptionCharges(file, '2026-08-01', '2026-10-31'))).toEqual([
      '2026-09-12',
      '2026-10-12',
    ]);
  });

  it('gives nothing after until, and until itself counts', () => {
    const file = money({ subscriptions: [subscription({ until: '2026-10-12' })] });
    expect(dates(subscriptionCharges(file, '2026-08-01', '2027-12-31'))).toEqual([
      '2026-08-12',
      '2026-09-12',
      '2026-10-12',
    ]);
    const early = money({ subscriptions: [subscription({ until: '2026-10-11' })] });
    expect(dates(subscriptionCharges(early, '2026-08-01', '2027-12-31'))).toEqual([
      '2026-08-12',
      '2026-09-12',
    ]);
  });

  it('moves day 31 to the last day of a shorter month', () => {
    const file = money({ subscriptions: [subscription({ day: 31, since: '2026-01-01' })] });
    expect(dates(subscriptionCharges(file, '2026-01-01', '2026-06-30'))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    expect(dates(subscriptionCharges(file, '2028-02-01', '2028-02-29'))).toEqual(['2028-02-29']);
  });

  it('moves day 30 and 29 in February too', () => {
    const thirty = money({ subscriptions: [subscription({ day: 30, since: '2026-01-01' })] });
    expect(dates(subscriptionCharges(thirty, '2026-02-01', '2026-02-28'))).toEqual(['2026-02-28']);
    const twentyNine = money({ subscriptions: [subscription({ day: 29, since: '2026-01-01' })] });
    expect(dates(subscriptionCharges(twentyNine, '2027-02-01', '2027-02-28'))).toEqual([
      '2027-02-28',
    ]);
  });

  it('does not clamp into the range from a renewal that falls outside it', () => {
    const file = money({ subscriptions: [subscription({ day: 31, since: '2026-01-01' })] });
    expect(subscriptionCharges(file, '2026-02-01', '2026-02-27')).toEqual([]);
  });

  it('renews a yearly subscription on its month and day', () => {
    const yearly = subscription({
      id: 'domain',
      name: 'Domain',
      currency: 'ILS',
      amount: 120,
      every: 'year',
      month: 3,
      day: 5,
      since: '2026-01-01',
    });
    const file = money({ subscriptions: [yearly] });
    expect(dates(subscriptionCharges(file, '2025-01-01', '2029-12-31'))).toEqual([
      '2026-03-05',
      '2027-03-05',
      '2028-03-05',
      '2029-03-05',
    ]);
    expect(subscriptionCharges(file, '2026-03-06', '2027-03-04')).toEqual([]);
    expect(subscriptionCharges(file, '2026-01-01', '2026-03-04')).toEqual([]);
  });

  it('starts a yearly subscription only on or after since, and ends it at until', () => {
    const yearly = subscription({
      every: 'year',
      month: 8,
      day: 12,
      since: '2026-08-13',
      until: '2028-08-12',
    });
    const file = money({ subscriptions: [yearly] });
    expect(dates(subscriptionCharges(file, '2026-01-01', '2030-12-31'))).toEqual([
      '2027-08-12',
      '2028-08-12',
    ]);
  });

  it('moves a yearly 29 February to the 28th in other years', () => {
    const yearly = subscription({ every: 'year', month: 2, day: 29, since: '2026-01-01' });
    const file = money({ subscriptions: [yearly] });
    expect(dates(subscriptionCharges(file, '2026-01-01', '2028-12-31'))).toEqual([
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('converts dollars with the file rate', () => {
    const file = money({ usdToIls: 4, subscriptions: [subscription({ amount: 22 })] });
    expect(subscriptionCharges(file, '2026-08-12', '2026-08-12')[0]?.ils).toBe(88);
  });

  it('merges several subscriptions, oldest first', () => {
    const file = money({
      subscriptions: [
        subscription(),
        subscription({ id: 'eleven', name: 'ElevenLabs', amount: 22, day: 3, since: '2026-08-03' }),
        subscription({
          id: 'music',
          name: 'Music library',
          amount: 49,
          currency: 'ILS',
          day: 12,
          since: '2026-08-01',
        }),
      ],
    });
    const lines = subscriptionCharges(file, '2026-09-01', '2026-09-30');
    expect(lines.map((line) => [line.date, line.subscriptionId])).toEqual([
      ['2026-09-03', 'eleven'],
      ['2026-09-12', 'claude'],
      ['2026-09-12', 'music'],
    ]);
  });

  it('works across a year boundary', () => {
    const file = money({ subscriptions: [subscription({ day: 15 })] });
    expect(dates(subscriptionCharges(file, '2026-11-20', '2027-02-10'))).toEqual([
      '2026-12-15',
      '2027-01-15',
    ]);
  });

  it('gives nothing for an empty or reversed range, and without subscriptions', () => {
    const file = money({ subscriptions: [subscription()] });
    expect(subscriptionCharges(file, '2026-10-20', '2026-10-01')).toEqual([]);
    expect(subscriptionCharges(money(), '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('rejects dates that are not calendar days', () => {
    const file = money({ subscriptions: [subscription()] });
    expect(() => subscriptionCharges(file, '2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => subscriptionCharges(file, '2026-03-01', 'tomorrow')).toThrow(RangeError);
  });
});

describe('chargesBetween', () => {
  const file = money({
    usdToIls: 3.7,
    subscriptions: [
      subscription(),
      subscription({ id: 'eleven', name: 'ElevenLabs', amount: 22, day: 3, since: '2026-08-03' }),
    ],
    charges: [
      {
        date: '2026-10-14',
        item: 'Stock footage',
        what: 'Clip licence #4831',
        amount: 7.5,
        currency: 'ILS',
        job: 'Lumen Yoga/Retreat teaser',
      },
      { date: '2026-10-03', item: 'Music', what: 'One track', amount: 10, currency: 'USD' },
      { date: '2026-09-30', item: 'Fonts', what: 'Licence', amount: 30, currency: 'ILS' },
      { date: '2026-11-01', item: 'Later', what: 'Next month', amount: 5, currency: 'ILS' },
    ],
  });

  it('merges renewals and charges, oldest first', () => {
    const lines = chargesBetween(file, '2026-10-01', '2026-10-31');
    expect(lines.map((line) => [line.date, line.item])).toEqual([
      ['2026-10-03', 'ElevenLabs'],
      ['2026-10-03', 'Music'],
      ['2026-10-12', 'Claude Max plan'],
      ['2026-10-14', 'Stock footage'],
    ]);
  });

  it('puts a renewal before an entry on the same day', () => {
    const lines = chargesBetween(file, '2026-10-03', '2026-10-03');
    expect(lines.map((line) => line.subscriptionId)).toEqual(['eleven', undefined]);
  });

  it('gives each line its amount in shekels', () => {
    const lines = chargesBetween(file, '2026-10-01', '2026-10-31');
    expect(lines.map((line) => line.ils)).toEqual([81.4, 37, 740, 7.5]);
  });

  it('keeps the job on a charge, and leaves it off a renewal', () => {
    const lines = chargesBetween(file, '2026-10-01', '2026-10-31');
    expect(lines.find((line) => line.item === 'Stock footage')?.job).toBe(
      'Lumen Yoga/Retreat teaser',
    );
    expect(lines.find((line) => line.item === 'Claude Max plan')).not.toHaveProperty('job');
  });

  it('includes charges dated on either end and leaves out the rest', () => {
    const lines = chargesBetween(file, '2026-09-30', '2026-11-01');
    expect(lines.map((line) => line.item)).toContain('Fonts');
    expect(lines.map((line) => line.item)).toContain('Later');
    const inner = chargesBetween(file, '2026-10-01', '2026-10-31');
    expect(inner.map((line) => line.item)).not.toContain('Fonts');
    expect(inner.map((line) => line.item)).not.toContain('Later');
  });

  it('is empty for a file with nothing in it', () => {
    expect(chargesBetween(money(), '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('rejects dates that are not calendar days', () => {
    expect(() => chargesBetween(file, '2026-10-01', '2026-10-32')).toThrow(RangeError);
  });
});

describe('months', () => {
  it('recognises months written YYYY-MM', () => {
    for (const good of ['2026-10', '2026-01', '2026-12', '1999-07']) {
      expect(isMonth(good), good).toBe(true);
      expect(monthSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of [
      '2026-13',
      '2026-00',
      '2026-1',
      '26-10',
      '2026-10-01',
      '2026/10',
      '',
      'Oct',
    ]) {
      expect(isMonth(bad), bad).toBe(false);
      expect(monthSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('gives the first and the last day of a month, leap years included', () => {
    expect(monthRange('2026-10')).toEqual({ first: '2026-10-01', last: '2026-10-31' });
    expect(monthRange('2026-04')).toEqual({ first: '2026-04-01', last: '2026-04-30' });
    expect(monthRange('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });

  it('feeds chargesBetween the whole month, both ends included', () => {
    const file = money({
      charges: [
        { date: '2026-10-01', item: 'First', what: 'a', amount: 1, currency: 'ILS' },
        { date: '2026-10-31', item: 'Last', what: 'b', amount: 1, currency: 'ILS' },
        { date: '2026-11-01', item: 'Next', what: 'c', amount: 1, currency: 'ILS' },
      ],
    });
    const { first, last } = monthRange('2026-10');
    expect(chargesBetween(file, first, last).map((line) => line.item)).toEqual(['First', 'Last']);
  });

  it('moves by months across the new year, both ways', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -7)).toBe('2026-03');
    expect(addMonths('2026-03', -7)).toBe('2025-08');
    expect(addMonths('2026-10', 30)).toBe('2029-04');
    expect(() => addMonths('October', 1)).toThrow(RangeError);
  });

  describe('localMonthOf', () => {
    // 22:30 UTC on the 30th of September: past midnight in Israel (UTC+3 until the 25th of October).
    const lateSeptember = Date.parse('2026-09-30T22:30:00Z');

    it('reads the month on the calendar of the time zone', () => {
      expect(localMonthOf(lateSeptember, 'UTC')).toBe('2026-09');
      expect(localMonthOf(lateSeptember, 'America/New_York')).toBe('2026-09');
      expect(localMonthOf(lateSeptember, 'Pacific/Pago_Pago')).toBe('2026-09');
      expect(localMonthOf(lateSeptember, 'Asia/Jerusalem')).toBe('2026-10');
      expect(localMonthOf(lateSeptember, 'Pacific/Auckland')).toBe('2026-10');
      expect(localMonthOf(lateSeptember, 'Pacific/Kiritimati')).toBe('2026-10');
    });

    it('switches at local midnight, on either side of a clock change', () => {
      const at = (iso: string) => localMonthOf(Date.parse(iso), 'Asia/Jerusalem');
      // Summer time in Israel: midnight on the 1st of October is 21:00 UTC.
      expect(at('2026-09-30T20:59:59.999Z')).toBe('2026-09');
      expect(at('2026-09-30T21:00:00.000Z')).toBe('2026-10');
      // Winter time since the 25th: midnight on the 1st of November is 22:00 UTC.
      expect(at('2026-10-31T21:59:59.999Z')).toBe('2026-10');
      expect(at('2026-10-31T22:00:00.000Z')).toBe('2026-11');
    });

    it('reads the new year and a leap day', () => {
      expect(localMonthOf(Date.parse('2026-12-31T23:30:00Z'), 'UTC')).toBe('2026-12');
      expect(localMonthOf(Date.parse('2026-12-31T23:30:00Z'), 'Asia/Jerusalem')).toBe('2027-01');
      expect(localMonthOf(Date.parse('2028-02-29T12:00:00Z'), 'Asia/Jerusalem')).toBe('2028-02');
    });

    it('refuses a time zone it does not know', () => {
      expect(() => localMonthOf(lateSeptember, 'Mars/Olympus')).toThrow(RangeError);
    });
  });
});
