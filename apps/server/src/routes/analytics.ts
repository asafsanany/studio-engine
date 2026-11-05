// The Analytics page's numbers (Analytics plan), mounted at /api/analytics while the Analytics
// switch is on:
//
//   GET /?period=week|month   everything the page shows (`AnalyticsResponse`): the Jobs tiles and
//           charts, A typical job, Reviews and Claude use. Missing data is `null` in the answer,
//           never 0. `month` (the default) compares the last 30 days with the 30 before and draws
//           the charts by week; `week` compares the last 7 days with the 7 before and draws them by
//           day. The answer says which period it is. 400 for anything else, as the Money page's
//           month does.
//
// The route only gathers the inputs, every job with its bookkeeping, the timed step runs, the sent
// review notes, the deliveries, the usage log, the limits log and the note topics, and hands them
// to `computeAnalytics`, which holds the maths (packages/shared). The page loads this again when a
// job or the money changes, so nothing here is cached.
//
// The `services` of the answer (every API, paid or free, with its plan and its cost) is added here,
// not in `computeAnalytics`: it needs money.json and what the videos cost the services, which the
// Money page reads too (money/service-charges.ts).
//
// Asking for the page also pokes the plan probe, which reads the Max plan's limits in the background
// when the newest reading is stale (plan-probe.ts).
//
// The three logs are read by thunks that can fail without taking the page down: a log that cannot
// be read counts as empty, and the cards that depend on it show a gap. A model in the usage log
// that has no API price (api-prices.ts) counts as $0 in the page; the route says so in the log, once
// per model, so a new model is noticed rather than silently undercounted.

import {
  type AnalyticsJob,
  type AnalyticsResponse,
  computeAnalytics,
  computeAnalyticsServices,
  DEFAULT_ANALYTICS_PERIOD,
  isAnalyticsPeriod,
  type LimitSnapshot,
  type MoneyFile,
  type UsageEntry,
  unknownModelsOf,
} from '@studio/shared';
import { Hono } from 'hono';
import type {
  DeliveryRepository,
  JobRepository,
  NoteRepository,
  StepRunRepository,
} from '../db/index.js';
import { logger } from '../logger.js';
import type { ServiceChargeReader } from '../money/service-charges.js';
import { machineTimeZone } from './money.js';

type Maybe<T> = T | Promise<T>;

export interface AnalyticsRouteOptions {
  /** Every job (archived ones too) and its bookkeeping: footage length and start and finish times. */
  jobs: Pick<JobRepository, 'getAll' | 'getMeta'>;
  /** The timed steps of every job. */
  stepRuns: Pick<StepRunRepository, 'listAll'>;
  /** The review notes that were sent. */
  notes: Pick<NoteRepository, 'listAllSent'>;
  /** Every job marked delivered. */
  deliveries: Pick<DeliveryRepository, 'list'>;
  /** The lines of usage.jsonl, oldest first (`readUsageLog(dataDir)`). */
  usage: () => Maybe<readonly UsageEntry[]>;
  /** The readings of Claude's rate limits, oldest first (limits.jsonl; none until the limits log exists). */
  limits: () => Maybe<readonly LimitSnapshot[]>;
  /** The topic of each sent note that has one, by note id (note-topics.json; none until the topic pass exists). */
  noteTopics: () => Maybe<Readonly<Record<string, string>>>;
  /**
   * The plan probe (analytics/plan-probe.ts): poked on every request, it starts a tiny background
   * run when the newest plan reading is stale. It never delays the answer. None: no probe.
   */
  planProbe?: { poke(): void } | null;
  /**
   * The services section (CLAUDE.md › APIs and services): money.json as it is now, and what the
   * services cost the jobs (money/service-charges.ts). Without them the answer has no `services`
   * and the page hides the section.
   */
  services?: { money: () => MoneyFile; charges: ServiceChargeReader };
  /** The IANA time zone whose calendar decides what day and week a moment is in. Default: the machine's. */
  timeZone?: () => string;
  /** The clock for "now": the end of the last 30 days and of this week. Default: the system clock. */
  clock?: () => Date;
}

/** The jobs with the bookkeeping the page never sees, for the maths. */
function analyticsJobs(jobs: AnalyticsRouteOptions['jobs']): AnalyticsJob[] {
  return jobs.getAll().flatMap((job) => {
    const meta = jobs.getMeta(job.id);
    if (meta === null) return [];
    return [
      {
        ...job,
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt,
        footageSec: meta.footageSec,
      },
    ];
  });
}

/** A log that cannot be read counts as empty: the page shows gaps, not an error. */
async function readOrEmpty<T>(what: string, read: () => Maybe<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    logger.warn({ err }, `Analytics: could not read ${what}; counting it as empty`);
    return empty;
  }
}

export function createAnalyticsRoutes({
  jobs,
  stepRuns,
  notes,
  deliveries,
  usage,
  limits,
  noteTopics,
  services,
  planProbe = null,
  timeZone = machineTimeZone,
  clock = () => new Date(),
}: AnalyticsRouteOptions): Hono {
  const routes = new Hono();
  const warnedModels = new Set<string>();

  routes.get('/', async (c) => {
    const asked = c.req.query('period');
    if (asked !== undefined && !isAnalyticsPeriod(asked)) {
      return c.json({ error: 'Send the period as week or month, like ?period=week.' }, 400);
    }
    // The reading below is the one there is; a fresher one, if the probe gets it, is for the next load.
    planProbe?.poke();
    const usageLines = await readOrEmpty('the usage log', usage, []);
    for (const model of unknownModelsOf(usageLines)) {
      if (warnedModels.has(model)) continue;
      warnedModels.add(model);
      logger.warn(
        { model },
        `Analytics: no API price for ${model}; its use counts as $0 (add it to api-prices.ts)`,
      );
    }
    const now = clock().getTime();
    const period = asked ?? DEFAULT_ANALYTICS_PERIOD;
    const zone = timeZone();
    const body: AnalyticsResponse = computeAnalytics({
      now,
      period,
      timeZone: zone,
      jobs: analyticsJobs(jobs),
      stepRuns: stepRuns.listAll(),
      sentNotes: notes.listAllSent(),
      deliveries: deliveries.list(),
      usage: usageLines,
      limits: await readOrEmpty('the limits log', limits, []),
      noteTopics: await readOrEmpty('the note topics', noteTopics, {}),
    });
    if (services !== undefined) {
      const money = services.money();
      body.services = computeAnalyticsServices({
        now,
        period,
        timeZone: zone,
        money,
        serviceCharges: await readOrEmpty(
          'what the services cost the jobs',
          () => services.charges({ money, timeZone: zone }),
          [],
        ),
        usage: usageLines,
      });
    }
    return c.json(body);
  });

  return routes;
}
