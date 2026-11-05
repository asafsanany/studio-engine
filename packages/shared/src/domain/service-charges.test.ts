import { describe, expect, it } from 'vitest';
import { moneyFileSchema } from './money.ts';
import { computeMoney, type MoneyDelivery } from './money-compute.ts';
import {
  deriveServiceCharges,
  elevenLabsCreditPrice,
  musicCredits,
  type ServiceChargeGenerate,
  type ServiceChargeInstagramScan,
} from './service-charges.ts';
import type { UsageEntry } from './usage.ts';

const ZONE = 'Asia/Jerusalem';

const ELEVEN = {
  id: 'elevenlabs',
  name: 'ElevenLabs (Starter)',
  amount: 6,
  currency: 'USD',
  every: 'month',
  day: 20,
  since: '2026-10-20',
} as const;

const jobs = [{ id: 'job1', relPath: 'Pinewood/97 Window Ad' }];

function generated(overrides: Partial<ServiceChargeGenerate> = {}): ServiceChargeGenerate {
  return {
    jobId: 'job1',
    spendUsd: 3.128,
    elevenlabsChars: 150,
    updatedAt: '2026-10-26T00:12:00+02:00',
    ...overrides,
  };
}

function musicLine(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    at: '2026-10-25T21:48:17.530Z',
    from: null,
    source: 'app',
    tag: 'music',
    did: 'Made music v1 for Pinewood / 97 Window Ad (0:35)',
    session: null,
    client: 'Pinewood',
    job: { id: 'job1', name: '97 Window Ad' },
    usage: {},
    ...overrides,
  };
}

const subscriptions = moneyFileSchema.parse({ subscriptions: [ELEVEN] }).subscriptions;

describe('musicCredits', () => {
  it('takes 900 credits a minute', () => {
    expect(musicCredits(60)).toBe(900);
    expect(musicCredits(35)).toBe(525);
  });
});

describe('elevenLabsCreditPrice', () => {
  it('is the plan price over its credits, 30,000 unless the line says', () => {
    expect(elevenLabsCreditPrice(subscriptions)?.perCredit).toBeCloseTo(6 / 30_000, 10);
    const bigger = moneyFileSchema.parse({
      subscriptions: [{ ...ELEVEN, name: 'ElevenLabs (Creator)', amount: 22, credits: 100_000 }],
    }).subscriptions;
    expect(elevenLabsCreditPrice(bigger)?.perCredit).toBeCloseTo(0.00022, 10);
  });

  it('is null without an ElevenLabs plan in the money file', () => {
    expect(elevenLabsCreditPrice([])).toBeNull();
  });
});

describe('deriveServiceCharges', () => {
  it("makes Higgsfield's dollars a charge on the job, dated by the day the row last changed", () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [generated({ elevenlabsChars: 0 })],
      usage: [],
      subscriptions: [],
      timeZone: ZONE,
    });
    expect(charges).toEqual([
      {
        date: '2026-10-26',
        item: 'Higgsfield',
        what: 'Pictures and clips',
        amount: 3.128,
        currency: 'USD',
        job: 'Pinewood/97 Window Ad',
      },
    ]);
  });

  it("includes Higgsfield's dollars in the plan when money.json has a Higgsfield line (the plan's credits paid them)", () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [generated({ elevenlabsChars: 0 })],
      usage: [],
      subscriptions: [
        {
          id: 'higgsfield-starter',
          name: 'Higgsfield (Starter)',
          amount: 15,
          currency: 'USD',
          every: 'month',
          day: 3,
          since: '2026-10-03',
        },
      ],
      timeZone: ZONE,
    });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      item: 'Higgsfield',
      amount: 3.128,
      includedIn: 'higgsfield-starter',
    });
  });

  it("prices the voice's and the music's credits at the plan's rate, included in the plan", () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [generated({ spendUsd: 0 })],
      usage: [musicLine()],
      subscriptions,
      timeZone: ZONE,
    });
    expect(charges).toEqual([
      {
        date: '2026-10-26',
        item: 'ElevenLabs',
        what: 'Voice (150 credits)',
        amount: 0.03,
        currency: 'USD',
        job: 'Pinewood/97 Window Ad',
        includedIn: 'elevenlabs',
        credits: 150,
      },
      {
        date: '2026-10-25',
        item: 'ElevenLabs',
        what: 'Music v1 (525 credits)',
        amount: 0.105,
        currency: 'USD',
        job: 'Pinewood/97 Window Ad',
        includedIn: 'elevenlabs',
        credits: 525,
      },
    ]);
  });

  it('has no ElevenLabs charge without a plan to price a credit', () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [generated()],
      usage: [musicLine()],
      subscriptions: [],
      timeZone: ZONE,
    });
    expect(charges.map((charge) => charge.item)).toEqual(['Higgsfield']);
  });

  it('finds the job of a music line by its name when the job is gone', () => {
    const charges = deriveServiceCharges({
      jobs: [],
      generated: [],
      usage: [musicLine({ job: { id: 'gone', name: '97 Window Ad' } })],
      subscriptions,
      timeZone: ZONE,
    });
    expect(charges.map((charge) => charge.job)).toEqual(['Pinewood/97 Window Ad']);
  });

  it('skips a row of a job that does not exist and lines that are not made music', () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [generated({ jobId: 'other' })],
      usage: [
        musicLine({ did: 'Made music v1 for Pinewood / 97 Window Ad' }),
        musicLine({ tag: 'edit', did: 'Edited Pinewood / 97 Window Ad' }),
      ],
      subscriptions,
      timeZone: ZONE,
    });
    expect(charges).toEqual([]);
  });
});

describe('deriveServiceCharges: Instagram scans', () => {
  const scan = (
    overrides: Partial<ServiceChargeInstagramScan> = {},
  ): ServiceChargeInstagramScan => ({
    client: 'Falcon FPV',
    startedAt: Date.parse('2026-10-26T06:00:00+02:00'),
    costUsd: 0.1042,
    ...overrides,
  });
  const derive = (scans: ServiceChargeInstagramScan[]) =>
    deriveServiceCharges({
      jobs,
      generated: [],
      usage: [],
      subscriptions: [],
      timeZone: ZONE,
      instagramScans: scans,
    });

  it("makes a scan's cost an Apify payment in dollars with no job, named by the client", () => {
    expect(derive([scan()])).toEqual([
      {
        date: '2026-10-26',
        item: 'Apify',
        what: 'Instagram scan · Falcon FPV',
        amount: 0.1042,
        currency: 'USD',
      },
    ]);
  });

  it('puts a scan from the Apify plan’s first day on inside the plan, and counts one before it', () => {
    const charges = deriveServiceCharges({
      jobs,
      generated: [],
      usage: [],
      subscriptions: [
        {
          id: 'apify',
          name: 'Apify (Starter)',
          amount: 19,
          currency: 'USD',
          every: 'month',
          day: 30,
          since: '2026-10-30',
        },
      ],
      timeZone: ZONE,
      instagramScans: [
        scan({ startedAt: Date.parse('2026-10-29T19:00:00+02:00') }),
        scan({ startedAt: Date.parse('2026-10-30T20:40:00+02:00') }),
      ],
    });
    expect(charges).toEqual([
      expect.not.objectContaining({ includedIn: expect.anything() }),
      expect.objectContaining({ date: '2026-10-30', includedIn: 'apify' }),
    ]);
    expect(charges[0]?.date).toBe('2026-10-29');
  });

  it("dates it by the scan's local day, not the UTC one", () => {
    // 23:30 UTC on the 26th is 01:30 on the 27th in Israel
    const [charge] = derive([scan({ startedAt: Date.parse('2026-10-26T23:30:00Z') })]);
    expect(charge?.date).toBe('2026-10-27');
  });

  it('leaves out a scan that cost nothing', () => {
    expect(
      derive([scan({ costUsd: 0 }), scan({ costUsd: Number.NaN }), scan({ costUsd: 0.00001 })]),
    ).toEqual([]);
  });

  it('is exactly the old answer without scans', () => {
    expect(derive([])).toEqual([]);
    expect(
      deriveServiceCharges({
        jobs,
        generated: [generated({ elevenlabsChars: 0 })],
        usage: [],
        subscriptions: [],
        timeZone: ZONE,
      }),
    ).toHaveLength(1);
  });
});

describe('the Money page with service charges', () => {
  const delivery: MoneyDelivery = {
    jobId: 'job1',
    clientId: 'c1',
    client: 'Pinewood',
    name: '97 Window Ad',
    relPath: 'Pinewood/97 Window Ad',
    deliveredAt: Date.parse('2026-10-26T12:00:00+02:00'),
    price: 40,
    currency: 'ILS',
    reviewSec: 0,
    paidOn: null,
  };
  const money = moneyFileSchema.parse({ subscriptions: [ELEVEN], pricePerJob: 40 });
  const serviceCharges = deriveServiceCharges({
    jobs,
    generated: [generated()],
    usage: [musicLine()],
    subscriptions: money.subscriptions,
    timeZone: ZONE,
  });
  const now = Date.parse('2026-10-26T15:00:00+02:00');
  const answer = computeMoney({
    deliveries: [delivery],
    money,
    month: '2026-10',
    timeZone: ZONE,
    now,
    serviceCharges,
  });
  const without = computeMoney({
    deliveries: [delivery],
    money,
    month: '2026-10',
    timeZone: ZONE,
    now,
  });

  it("lists Higgsfield and ElevenLabs in the finished job's expenses", () => {
    const [job] = answer.ledger;
    expect(job?.charges.map((charge) => [charge.item, charge.amountLabel])).toEqual([
      ['ElevenLabs', '$0.11'],
      ['Higgsfield', '$3.13'],
      ['ElevenLabs', '$0.03'],
    ]);
    // 3.128 + 0.105 + 0.03 = 3.263 dollars at 3.7
    expect(job?.expenses).toBeCloseTo(12.07, 2);
    expect(job?.profit).toBeCloseTo(40 - 12.07, 2);
  });

  it('counts Higgsfield in the month and leaves out what the ElevenLabs plan already paid', () => {
    const higgsfield = 3.128 * 3.7;
    expect(answer.banners.expenses.value - without.banners.expenses.value).toBeCloseTo(
      higgsfield,
      2,
    );
    expect(answer.expenses.items.map((item) => item.name)).toEqual([
      'ElevenLabs (Starter)',
      'Higgsfield',
    ]);
    const higgsfieldItem = answer.expenses.items.find((item) => item.name === 'Higgsfield');
    expect(higgsfieldItem?.kind).toBe('Per use');
    expect(higgsfieldItem?.charges[0]?.job).toBe('Pinewood/97 Window Ad');
  });

  it("says how much of the plan the videos used in the plan's own item", () => {
    const plan = answer.expenses.items.find((item) => item.id === 'elevenlabs');
    expect(plan?.notes).toEqual(['Videos used 675 credits of the plan this month']);
    expect(plan?.ils).toBe(22.2);
  });

  it('marks a job’s share of a plan as included, and nothing else', () => {
    const [job] = answer.ledger;
    expect(job?.charges.map((charge) => [charge.item, charge.included])).toEqual([
      ['ElevenLabs', true],
      ['Higgsfield', undefined],
      ['ElevenLabs', true],
    ]);
  });

  it('is exactly the old answer without service charges', () => {
    expect(without.ledger[0]?.charges).toEqual([]);
    expect(without.banners.expenses.value).toBe(22.2);
  });
});

describe('the Money page with Instagram scans', () => {
  const money = moneyFileSchema.parse({ pricePerJob: 40 });
  const delivery: MoneyDelivery = {
    jobId: 'job1',
    clientId: 'c1',
    client: 'Pinewood',
    name: '97 Window Ad',
    relPath: 'Pinewood/97 Window Ad',
    deliveredAt: Date.parse('2026-10-26T12:00:00+02:00'),
    price: 40,
    currency: 'ILS',
    reviewSec: 0,
    paidOn: null,
  };
  const scans: ServiceChargeInstagramScan[] = [
    { client: 'Falcon FPV', startedAt: Date.parse('2026-10-26T06:00:00+02:00'), costUsd: 0.1042 },
    { client: 'Dana', startedAt: Date.parse('2026-10-26T06:05:00+02:00'), costUsd: 0.0731 },
    { client: 'Falcon FPV', startedAt: Date.parse('2026-11-02T06:00:00+02:00'), costUsd: 0.12 },
  ];
  const derived = (list: ServiceChargeInstagramScan[]) =>
    deriveServiceCharges({
      jobs,
      generated: [generated({ elevenlabsChars: 0 })],
      usage: [],
      subscriptions: [],
      timeZone: ZONE,
      instagramScans: list,
    });
  const month = (m: string, list: ServiceChargeInstagramScan[], now: string) =>
    computeMoney({
      deliveries: [delivery],
      money,
      month: m,
      timeZone: ZONE,
      now: Date.parse(now),
      serviceCharges: derived(list),
    });
  const october = month('2026-10', scans, '2026-10-27T10:00:00+02:00');
  const octoberWithout = month('2026-10', [], '2026-10-27T10:00:00+02:00');
  const apify = october.expenses.items.find((item) => item.name === 'Apify');

  it("lists the month's scans as one Apify per-use item, each with no job, in dollars and shekels", () => {
    expect(apify).toMatchObject({
      id: 'use:Apify',
      kind: 'Per use',
      billing: 'Per use',
      amountLabel: '2 scans',
      // $0.1042 and $0.0731 at 3.7, each to the agora: 0.39 and 0.27
      ils: 0.66,
    });
    expect(apify?.charges).toEqual([
      {
        date: '2026-10-26',
        item: 'Apify',
        what: 'Instagram scan · Falcon FPV',
        amountLabel: '$0.10',
        ils: 0.39,
        job: null,
      },
      {
        date: '2026-10-26',
        item: 'Apify',
        what: 'Instagram scan · Dana',
        amountLabel: '$0.07',
        ils: 0.27,
        job: null,
      },
    ]);
  });

  it('counts them once in the month, on top of what the month already paid', () => {
    expect(october.banners.expenses.value - octoberWithout.banners.expenses.value).toBeCloseTo(
      0.66,
      2,
    );
    expect(october.expenses.total - octoberWithout.expenses.total).toBeCloseTo(0.66, 2);
    expect(october.banners.profit.value).toBeCloseTo(octoberWithout.banners.profit.value - 0.66, 2);
    expect(october.expenses.charges.filter((charge) => charge.item === 'Apify')).toHaveLength(2);
  });

  it("is in no job's expenses: the delivered job lists and counts what it did before", () => {
    const [job] = october.ledger;
    const [before] = octoberWithout.ledger;
    expect(job?.charges.map((charge) => charge.item)).toEqual(['Higgsfield']);
    expect(job?.expenses).toBe(before?.expenses);
    expect(job?.profit).toBe(before?.profit);
  });

  it('puts a scan of another month in that month only, and lists the month', () => {
    const november = month('2026-11', scans, '2026-11-03T10:00:00+02:00');
    expect(november.expenses.items.map((item) => item.name)).toEqual(['Apify']);
    expect(november.expenses.items[0]).toMatchObject({ amountLabel: '1 scan', ils: 0.44 });
    expect(november.months).toEqual(['2026-11', '2026-10']);
    // October did not take November's scan
    expect(apify?.charges.map((charge) => charge.date)).toEqual(['2026-10-26', '2026-10-26']);
  });

  it('leaves a month without scans exactly as it was', () => {
    const september = (list: ServiceChargeInstagramScan[]) =>
      month('2026-09', list, '2026-10-27T10:00:00+02:00');
    const { months: withMonths, ...withScans } = september(scans);
    const { months: withoutMonths, ...withoutScans } = september([]);
    expect(withScans).toEqual(withoutScans);
    // the only difference is that November, which has a scan, is a month with data now
    expect(withoutMonths).toEqual(['2026-10']);
    expect(withMonths).toEqual(['2026-11', '2026-10']);
    expect(octoberWithout.expenses.items.map((item) => item.name)).toEqual(['Higgsfield']);
  });

  it('names the unit of one client scanned again and again (scan, not instagram)', () => {
    const weekly = month(
      '2026-10',
      [0, 7, 14].map((offset) => ({
        client: 'Falcon FPV',
        startedAt: Date.parse('2026-10-05T06:00:00+02:00') + offset * 24 * 60 * 60 * 1000,
        costUsd: 0.1,
      })),
      '2026-10-27T10:00:00+02:00',
    );
    expect(weekly.expenses.items.find((item) => item.name === 'Apify')).toMatchObject({
      billing: '$0.10 per scan',
      amountLabel: '3 scans',
    });
  });
});
