import {
  type AnalyticsResponse,
  analyticsResponseSchema,
  type ComputeAnalyticsInput,
  type LimitSnapshot,
  moneyFileSchema,
  type UsageEntry,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/job-repository.js';
import { NoteRepository } from '../db/note-repository.js';
import { StepRunRepository } from '../db/step-run-repository.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { logger } from '../logger.js';
import type { AnalyticsRouteOptions } from './analytics.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real route and the real repositories on an in-memory database; the logs are values the test
// holds. `computeAnalytics` has its own tests, so these check what the route adds: the inputs it
// gathers and hands over (watched through a spy), the clock and the time zone, the logs that
// cannot be read, and that the route is only there while the switch is on.

const compute = vi.hoisted(() => ({ calls: [] as ComputeAnalyticsInput[] }));

vi.mock('@studio/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@studio/shared')>();
  return {
    ...shared,
    computeAnalytics: (input: ComputeAnalyticsInput): AnalyticsResponse => {
      compute.calls.push(input);
      return shared.computeAnalytics(input);
    },
  };
});

const opened: StudioDb[] = [];

afterEach(() => {
  compute.calls.length = 0;
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const ZONE = 'Asia/Jerusalem';
/** The 22nd of October 2026, 09:00 in Israel. */
const NOW = new Date('2026-10-22T09:00:00+03:00');

function setup(options: Partial<AnalyticsRouteOptions> = {}, switchedOn = true) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const stepRuns = new StepRunRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const app = createApp({
    analytics: switchedOn,
    analyticsRoutes: {
      jobs,
      stepRuns,
      notes,
      deliveries,
      usage: () => [],
      limits: () => [],
      noteTopics: () => ({}),
      timeZone: () => ZONE,
      clock: () => NOW,
      ...options,
    },
  });
  return { app, clock, jobs, stepRuns, notes, deliveries };
}

async function get(app: ReturnType<typeof setup>['app'], query = ''): Promise<AnalyticsResponse> {
  const res = await app.request(`/api/analytics${query}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return analyticsResponseSchema.parse(await res.json());
}

function lastInput(): ComputeAnalyticsInput {
  const input = compute.calls.at(-1);
  if (input === undefined) throw new Error('computeAnalytics was not called');
  return input;
}

describe('GET /api/analytics', () => {
  it('answers a valid, empty response when nothing has happened', async () => {
    const { app } = setup();

    const body = await get(app);

    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.timeZone).toBe(ZONE);
    expect(body.period).toBe('month');
    expect(body.jobs.tiles).toHaveLength(5);
    expect(body.jobs.deliveredPerDay).toHaveLength(91);
    expect(body.jobs.footage).toHaveLength(12);
    expect(body.typicalJob.stages).toHaveLength(10);
    expect(body.reviews.approvedFirstTime).toHaveLength(12);
    expect(body.claudeUse.busiest).toHaveLength(8);
    expect(lastInput()).toMatchObject({
      now: NOW.getTime(),
      period: 'month',
      timeZone: ZONE,
      jobs: [],
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: [],
      limits: [],
      noteTopics: {},
    });
  });

  it('hands over every job with its footage and its start and finish', async () => {
    const { app, jobs, clock } = setup();
    const a = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu', { footageSec: 540 }));
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Intro'));
    jobs.applyTransition(a.job.id, { type: 'SETTLED' });
    clock.tick(1_000);
    jobs.applyTransition(a.job.id, { type: 'START' });

    await get(app);

    const sent = lastInput().jobs;
    expect(sent.map((job) => job.name).sort()).toEqual(['Intro', 'Spring menu']);
    const spring = sent.find((job) => job.name === 'Spring menu');
    expect(spring).toMatchObject({
      id: a.job.id,
      client: 'Northwind Bakery',
      state: 'editing',
      footageSec: 540,
      startedAt: '2026-10-20T10:00:01.000Z',
      finishedAt: null,
    });
    const intro = sent.find((job) => job.name === 'Intro');
    expect(intro).toMatchObject({ startedAt: null, finishedAt: null });
  });

  it('includes archived jobs', async () => {
    const { app, jobs } = setup();
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Old job'));
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'HOLD' });
    jobs.archive([job.id]);

    await get(app);

    expect(lastInput().jobs.map((j) => [j.name, j.archivedAt !== null])).toEqual([
      ['Old job', true],
    ]);
  });

  it('hands over the timed steps with their job ids, the sent notes and the deliveries', async () => {
    const { app, jobs, stepRuns, notes, deliveries, clock } = setup();
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    stepRuns.start(job.id, 1);
    clock.tick(5_000);
    stepRuns.end(job.id, 1);
    notes.create({ id: 'n1', jobId: job.id, kind: 'text', atSec: 3, text: 'Cut the intro.' });
    notes.create({ id: 'n2', jobId: job.id, kind: 'text', atSec: 4, text: 'Not sent' });
    notes.markSent(job.id, ['n1'], 1, '2026-10-20T11:00:00.000Z');
    deliveries.record({
      jobId: job.id,
      clientId: job.clientId,
      client: job.client,
      name: job.name,
      relPath: job.relPath,
      deliveredAt: Date.parse('2026-10-21T12:00:00+03:00'),
      price: 200,
      currency: 'ILS',
    });

    await get(app);

    const input = lastInput();
    expect(input.stepRuns).toEqual([
      {
        jobId: job.id,
        step: 1,
        runKind: 'edit',
        round: 0,
        startedAt: '2026-10-20T10:00:00.000Z',
        endedAt: '2026-10-20T10:00:05.000Z',
      },
    ]);
    expect(input.sentNotes.map((note) => note.id)).toEqual(['n1']);
    expect(input.deliveries.map((delivery) => delivery.jobId)).toEqual([job.id]);
  });

  it('reads the usage log, the limits log and the note topics on every request', async () => {
    const usage: UsageEntry[] = [];
    const limits: LimitSnapshot[] = [];
    const topics: Record<string, string> = {};
    const { app } = setup({ usage: () => usage, limits: () => limits, noteTopics: () => topics });

    await get(app);
    expect(lastInput()).toMatchObject({ usage: [], limits: [], noteTopics: {} });

    usage.push({
      at: '2026-10-21T10:00:00.000Z',
      from: null,
      source: 'app',
      tag: 'edit',
      did: 'Edited Spring menu',
      session: null,
      usage: {},
    });
    limits.push({
      at: '2026-10-21T10:00:00.000Z',
      status: 'allowed',
      fiveHour: null,
      sevenDay: { utilization: 0.4, resetsAt: '2026-10-25T06:00:00.000Z' },
    });
    topics.n1 = 'intro too long';
    await get(app);

    expect(lastInput().usage).toHaveLength(1);
    expect(lastInput().limits).toHaveLength(1);
    expect(lastInput().noteTopics).toEqual({ n1: 'intro too long' });
  });

  it('waits for a log that is read asynchronously', async () => {
    const { app } = setup({
      usage: async () => [
        {
          at: '2026-10-21T10:00:00.000Z',
          from: null,
          source: 'session',
          tag: 'development',
          did: 'Built a thing',
          session: 's1',
          usage: {},
        },
      ],
    });

    await get(app);

    expect(lastInput().usage.map((entry) => entry.did)).toEqual(['Built a thing']);
  });

  it('counts a log that cannot be read as empty, and still answers', async () => {
    const { app } = setup({
      usage: () => {
        throw new Error('EACCES');
      },
      limits: () => Promise.reject(new Error('bad json')),
      noteTopics: () => {
        throw new Error('EIO');
      },
    });

    const body = await get(app);

    expect(body.jobs.tiles).toHaveLength(5);
    expect(lastInput()).toMatchObject({ usage: [], limits: [], noteTopics: {} });
  });

  it('says in the log, once, that a model has no API price and so counts as $0', async () => {
    const tokens = { requests: 1, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
    const entry = (usage: UsageEntry['usage']): UsageEntry => ({
      at: '2026-10-21T10:00:00.000Z',
      from: null,
      source: 'app',
      tag: 'edit',
      did: 'Edited Spring menu',
      session: null,
      usage,
    });
    const { app } = setup({
      usage: () => [
        entry({ 'claude-sonnet-5-5': tokens, 'claude-mystery-9': tokens }),
        entry({ 'claude-mystery-9': tokens }),
      ],
    });
    vi.mocked(logger.warn).mockClear();

    await get(app);
    await get(app);

    const warned = vi
      .mocked(logger.warn)
      .mock.calls.filter(([fields]) => (fields as { model?: string }).model !== undefined);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[0]).toEqual({ model: 'claude-mystery-9' });
    expect(String(warned[0]?.[1])).toContain('claude-mystery-9');
  });

  it('is quiet about models it has a price for', async () => {
    const tokens = { requests: 1, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
    const { app } = setup({
      usage: () => [
        {
          at: '2026-10-21T10:00:00.000Z',
          from: null,
          source: 'app',
          tag: 'edit',
          did: 'Edited Spring menu',
          session: null,
          usage: { 'claude-sonnet-5-5': tokens, 'claude-opus-5-5[1m]': tokens },
        },
      ],
    });
    vi.mocked(logger.warn).mockClear();

    await get(app);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses the time zone and the clock it is given, at each request', async () => {
    let zone = 'Asia/Jerusalem';
    let now = NOW;
    const { app } = setup({ timeZone: () => zone, clock: () => now });

    const first = await get(app);
    zone = 'America/New_York';
    now = new Date('2026-10-24T22:30:00-04:00');
    const second = await get(app);

    expect(first.timeZone).toBe('Asia/Jerusalem');
    expect(second.timeZone).toBe('America/New_York');
    expect(second.generatedAt).toBe(now.toISOString());
    // Saturday night in New York: still the week of the 18th there.
    expect(second.jobs.footage.at(-1)?.start).toBe('2026-10-18');
  });

  describe('the plan probe', () => {
    it('is poked on every request, and does not hold the answer back', async () => {
      const poke = vi.fn();
      const { app } = setup({ planProbe: { poke } });

      await get(app);
      await get(app, '?period=week');

      expect(poke).toHaveBeenCalledTimes(2);
    });

    it('is not poked for a request that is refused', async () => {
      const poke = vi.fn();
      const { app } = setup({ planProbe: { poke } });

      const res = await app.request('/api/analytics?period=year');

      expect(res.status).toBe(400);
      expect(poke).not.toHaveBeenCalled();
    });

    it('answers all the same when there is no probe', async () => {
      const { app } = setup({ planProbe: null });
      expect((await get(app)).claudeUse.plan.lastReadingAt).toBeNull();
    });
  });

  describe('the budgets', () => {
    it('answers the credits and the plan from the usage and limits logs', async () => {
      const usage: UsageEntry[] = [
        {
          at: '2026-10-22T10:00:00.000Z',
          from: null,
          source: 'app',
          tag: 'revise',
          did: 'Re-edit',
          session: 's',
          usage: {
            'claude-opus-5-5': {
              requests: 1,
              input: 0,
              output: 500_000,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ];
      const limits: LimitSnapshot[] = [
        {
          at: '2026-10-22T05:00:00.000Z',
          status: 'allowed',
          fiveHour: null,
          sevenDay: { utilization: 0.4, resetsAt: '2026-10-24T18:00:00.000Z' },
        },
      ];
      const { app } = setup({ usage: () => usage, limits: () => limits });

      const { claudeUse } = await get(app);

      // Before the app moved to the API key (23 Oct), its runs are not API credits.
      expect(claudeUse.credits.spentUsd).toBe(0);
      expect(claudeUse.plan.week?.utilization).toBe(0.4);
      expect(claudeUse.plan.lastReadingAt).toBe('2026-10-22T05:00:00.000Z');
    });
  });

  describe('the period', () => {
    it('is the month when none is asked for, and the month when it is asked for', async () => {
      const { app } = setup();

      expect((await get(app)).period).toBe('month');
      expect((await get(app, '?period=month')).period).toBe('month');
      expect(lastInput().period).toBe('month');
    });

    it('is the week when it is asked for: the same answer in days, 14 of them', async () => {
      const { app } = setup();

      const week = await get(app, '?period=week');

      expect(week.period).toBe('week');
      expect(lastInput().period).toBe('week');
      expect(week.jobs.tiles.map((tile) => tile.series.length)).toEqual([14, 14, 14, 14, 14]);
      expect(week.jobs.footage).toHaveLength(14);
      expect(week.reviews.approvedFirstTime).toHaveLength(14);
      expect(week.claudeUse.busiest).toHaveLength(14);
      expect(week.claudeUse.apiValuePerFinishedMinute).toHaveLength(14);
      // The delivery calendar is the same 91 days either way.
      expect(week.jobs.deliveredPerDay).toHaveLength(91);
      // Days run to today, on the calendar of the time zone.
      expect(week.jobs.footage.at(-1)?.start).toBe('2026-10-22');
      expect(week.jobs.footage[0]?.start).toBe('2026-10-09');
    });

    it('reads the same inputs for both periods and does not cache one for the other', async () => {
      const { app, jobs } = setup();
      jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));

      await get(app, '?period=week');
      const week = lastInput();
      await get(app, '?period=month');
      const month = lastInput();

      expect(week.jobs).toEqual(month.jobs);
      expect(week.period).toBe('week');
      expect(month.period).toBe('month');
    });

    it.each([
      ['a period that does not exist', 'year'],
      ['a capital', 'Week'],
      ['words', 'this%20week'],
      ['plural', 'weeks'],
      ['a number', '7'],
      ['nothing', ''],
    ])('answers 400 for %s', async (_name, period) => {
      const { app } = setup();

      const res = await app.request(`/api/analytics?period=${period}`);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Send the period as week or month, like ?period=week.',
      });
      expect(compute.calls).toHaveLength(0);
    });

    it('ignores parameters it does not know', async () => {
      const { app } = setup();

      const body = await get(app, '?period=week&month=2026-09&format=csv');

      expect(body.period).toBe('week');
    });
  });

  it('is not cached: a new job shows in the next answer', async () => {
    const { app, jobs } = setup();

    await get(app);
    expect(lastInput().jobs).toHaveLength(0);
    jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    await get(app);

    expect(lastInput().jobs).toHaveLength(1);
  });
});

describe('GET /api/analytics services', () => {
  const money = moneyFileSchema.parse({
    subscriptions: [
      {
        id: 'elevenlabs',
        name: 'ElevenLabs (Starter)',
        amount: 6,
        currency: 'USD',
        every: 'month',
        day: 20,
        since: '2026-10-01',
      },
    ],
  });

  it('has no services without the money file', async () => {
    const { app } = setup();

    expect((await get(app)).services).toBeUndefined();
  });

  it('lists every service with the plans of money.json and what the videos cost', async () => {
    const asked: string[] = [];
    const { app } = setup({
      services: {
        money: () => money,
        charges: async ({ timeZone }) => {
          asked.push(timeZone);
          return [
            {
              date: '2026-10-20',
              item: 'Higgsfield',
              what: 'Pictures and clips',
              amount: 3,
              currency: 'USD',
              job: 'Pinewood/97 Window Ad',
            },
          ];
        },
      },
    });

    const { services } = await get(app);

    expect(asked).toEqual([ZONE]);
    expect(services?.rows.map((row) => row.id)).toContain('higgsfield');
    expect(services?.rows.find((row) => row.id === 'elevenlabs')?.plans).toEqual([
      { name: 'ElevenLabs (Starter)', price: '$6.00 a month' },
    ]);
    expect(services?.rows.find((row) => row.id === 'higgsfield')).toMatchObject({
      ils: 11.1,
      uses: '1 video · $3.00 of shots',
      planMissing: true,
    });
  });

  it('still lists the services when what the videos cost cannot be worked out', async () => {
    const { app } = setup({
      services: { money: () => money, charges: () => Promise.reject(new Error('torn')) },
    });

    const { services } = await get(app);

    expect(services?.rows.find((row) => row.id === 'higgsfield')?.ils).toBe(0);
    expect(services?.rows.find((row) => row.id === 'elevenlabs')?.ils).toBe(22.2);
  });
});

describe('the Analytics switch', () => {
  it('leaves /api/analytics out while it is off', async () => {
    const { app } = setup({}, false);

    const res = await app.request('/api/analytics');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(compute.calls).toHaveLength(0);
  });

  it('has no route when the switch is on but the app was not given its inputs', async () => {
    const res = await createApp({ analytics: true }).request('/api/analytics');

    expect(res.status).toBe(404);
  });

  it('only answers GET', async () => {
    const { app } = setup();

    const res = await app.request('/api/analytics', { method: 'POST' });

    expect(res.status).toBe(404);
  });
});
