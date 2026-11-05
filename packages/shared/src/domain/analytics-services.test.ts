import { describe, expect, it } from 'vitest';
import { analyticsServicesSchema } from './analytics.ts';
import { computeAnalyticsServices } from './analytics-services.ts';
import { type MoneyServiceCharge, moneyFileSchema } from './money.ts';
import { SERVICES } from './services.ts';
import type { UsageEntry } from './usage.ts';

const ZONE = 'Asia/Jerusalem';
const NOW = Date.parse('2026-10-26T15:00:00+02:00');

const money = moneyFileSchema.parse({
  subscriptions: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      amount: 899.9,
      currency: 'ILS',
      every: 'month',
      day: 1,
      since: '2026-10-01',
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      amount: 69.9,
      currency: 'ILS',
      every: 'month',
      day: 1,
      since: '2026-10-01',
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs (Starter)',
      amount: 6,
      currency: 'USD',
      every: 'month',
      day: 20,
      since: '2026-10-20',
    },
  ],
});

const charges: MoneyServiceCharge[] = [
  {
    date: '2026-10-26',
    item: 'Higgsfield',
    what: 'Pictures and clips',
    amount: 3.128,
    currency: 'USD',
    job: 'Pinewood/97 Window Ad',
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
];

function line(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    at: '2026-10-25T10:00:00.000Z',
    from: null,
    source: 'app',
    tag: 'edit',
    did: 'Edited A / B',
    session: 's',
    usage: {
      'claude-sonnet-5-5': { requests: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
    ...overrides,
  };
}

const usage = [
  line({}),
  line({ at: '2026-10-26T08:00:00.000Z', tag: 'transcribe', session: null, usage: {} }),
  line({ at: '2026-08-01T08:00:00.000Z' }),
  line({ source: 'session', tag: 'development' }),
];

const answer = computeAnalyticsServices({
  now: NOW,
  period: 'month',
  timeZone: ZONE,
  money,
  serviceCharges: charges,
  usage,
});
const row = (id: string) => {
  const found = answer.rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

describe('computeAnalyticsServices', () => {
  it('lists every service of the registry, paid ones first', () => {
    expect(answer.rows.map((r) => r.id).sort()).toEqual(SERVICES.map((s) => s.id).sort());
    const costs = answer.rows.map((r) => r.cost);
    expect(costs.indexOf('free')).toBeGreaterThan(costs.lastIndexOf('paid'));
    expect(analyticsServicesSchema.safeParse(answer).success).toBe(true);
  });

  it("shows ElevenLabs' plan from money.json, what it cost and what the videos used", () => {
    const eleven = row('elevenlabs');
    expect(eleven.plans).toEqual([{ name: 'ElevenLabs (Starter)', price: '$6.00 a month' }]);
    expect(eleven.planMissing).toBe(false);
    // the Oct 20 renewal, $6 at 3.7; the plan-included music adds nothing on top
    expect(eleven.ils).toBe(22.2);
    expect(eleven.uses).toBe('525 credits on videos · 1 voice note');
    expect(eleven.gap).toBeNull();
  });

  it("shows Higgsfield's use and money, and that its plan is not in money.json yet", () => {
    const higgsfield = row('higgsfield');
    expect(higgsfield.plans).toEqual([]);
    expect(higgsfield.planMissing).toBe(true);
    expect(higgsfield.ils).toBe(11.57);
    expect(higgsfield.uses).toBe('1 video · $3.13 of shots');
  });

  it("shows Higgsfield's plan once money.json has it", () => {
    const withPlan = computeAnalyticsServices({
      now: NOW,
      period: 'month',
      timeZone: ZONE,
      money: moneyFileSchema.parse({
        subscriptions: [
          {
            id: 'hf',
            name: 'Higgsfield Starter',
            amount: 15,
            currency: 'USD',
            every: 'month',
            day: 3,
            since: '2026-10-03',
          },
        ],
      }),
      serviceCharges: charges,
      usage: [],
    });
    const higgsfield = withPlan.rows.find((r) => r.id === 'higgsfield');
    expect(higgsfield?.plans).toEqual([{ name: 'Higgsfield Starter', price: '$15.00 a month' }]);
    expect(higgsfield?.planMissing).toBe(false);
    // $15 at 3.7 and the $3.128 of shots at 3.7
    expect(higgsfield?.ils).toBe(67.07);
  });

  it('counts only the period: the week leaves out what is older than 7 days', () => {
    const week = computeAnalyticsServices({
      now: NOW,
      period: 'week',
      timeZone: ZONE,
      money,
      serviceCharges: charges,
      usage,
    });
    const eleven = week.rows.find((r) => r.id === 'elevenlabs');
    // the Oct 20 renewal is 6 days back: in; the Oct 1 Claude renewal is not
    expect(eleven?.ils).toBe(22.2);
    expect(week.rows.find((r) => r.id === 'anthropic')?.ils).toBe(0);
    expect(row('anthropic').ils).toBe(899.9);
  });

  it("counts the app's Claude runs, not the sessions or runs outside the period", () => {
    expect(row('anthropic').uses).toBe('1 run');
  });

  it('marks free services free, with no cost and no gap', () => {
    for (const id of ['openverse', 'unsplash', 'youtube', 'itunes', 'spotify', 'web-push']) {
      expect(row(id)).toMatchObject({ cost: 'free', ils: null, gap: null, planMissing: false });
    }
  });

  it('says Pay per use, not a missing plan, for a paid service that has no plan to add', () => {
    expect(row('apify')).toMatchObject({ planMissing: false, plans: [] });
  });

  it('says what part of a paid service is not connected to Money yet', () => {
    expect(row('apify').gap).toBe(
      "Songs' runs (reading a song) cost about $0.003 to $0.008 each and are not recorded yet",
    );
  });

  it("says what Apify is used for, the clients' Instagram scans included", () => {
    expect(row('apify').forWhat).toBe(
      "Reading the song of an Instagram or TikTok link, the trending sounds, and each client's weekly Instagram scan",
    );
  });

  it("adds the Instagram scans' dollars to Apify's cost, in shekels, inside the period only", () => {
    const withScans = computeAnalyticsServices({
      now: NOW,
      period: 'month',
      timeZone: ZONE,
      money,
      serviceCharges: [
        ...charges,
        {
          date: '2026-10-26',
          item: 'Apify',
          what: 'Instagram scan · Falcon FPV',
          amount: 0.1,
          currency: 'USD',
        },
        {
          date: '2026-08-03',
          item: 'Apify',
          what: 'Instagram scan · Falcon FPV',
          amount: 5,
          currency: 'USD',
        },
      ],
      usage: [],
    });
    const apify = withScans.rows.find((r) => r.id === 'apify');
    // $0.10 at 3.7; August is outside the 30 days
    expect(apify?.ils).toBe(0.37);
    expect(row('apify').ils).toBe(0);
    expect(withScans.totalIls).toBeCloseTo(answer.totalIls + 0.37, 2);
  });

  it("lists the subscriptions that are no service's plan, and totals everything paid", () => {
    expect(answer.otherPlans).toEqual([{ name: 'ChatGPT', price: '₪69.90 a month', ils: 69.9 }]);
    expect(answer.totalIls).toBe(Math.round((899.9 + 22.2 + 11.57 + 69.9) * 100) / 100);
  });
});
