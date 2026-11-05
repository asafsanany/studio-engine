// The Money page's numbers (Phase 4 plan, §4), mounted at /api/money:
//
//   GET /?month=YYYY-MM   everything the page shows for that month (`MoneyResponse`): the three
//                         banners with the previous month and eight months of history, the month's
//                         jobs, the subscriptions charged, and the expenses as items and as charges.
//                         The month is a calendar month of the machine's time zone and defaults to
//                         this month; 400 for anything that is not YYYY-MM.
//   GET /price?client=<name>
//                         what Mark delivered would charge that client now and the month it would
//                         count in (`MoneyPriceResponse`): the price a delivery is recorded with
//                         (`priceFor`) and this month on the machine's calendar. The phone's
//                         "Sent it to <client>?" says it before the job is delivered. 400 without
//                         a client.
//
// The route only gathers the inputs, the deliveries and the money file as it is right now (with
// whether it has a mistake: `moneyFile`), and hands them to `computeMoney`, which holds the maths
// (packages/shared). The page loads this again when `money.changed` arrives, so nothing here is
// cached.

import {
  computeMoney,
  isMonth,
  localMonthOf,
  type MoneyFile,
  type MoneyPriceResponse,
  type MoneyResponse,
  type MoneyServiceCharge,
  priceForClient,
} from '@studio/shared';
import { Hono } from 'hono';
import type { DeliveryRepository, JobRepository } from '../db/index.js';
import type { PriceFor } from '../deliveries/deliveries.js';
import { logger } from '../logger.js';
import type { MoneyFileLoader } from '../money/money-file.js';

export interface MoneyRouteOptions {
  deliveries: Pick<DeliveryRepository, 'list'>;
  /**
   * Every job. The ones without a delivery are listed in the month they were added: they already
   * cost money (the services, stock clips) before they earn any (U25). Default: none.
   */
  jobs?: Pick<JobRepository, 'getAll'>;
  /**
   * The money file as it is now, and how it is doing (`fileState`, for the Money page's warning
   * line); read on every request, so an edit shows at once. Without `fileState` the file is fine.
   */
  money: Pick<MoneyFileLoader, 'get'> & Partial<Pick<MoneyFileLoader, 'fileState'>>;
  /** The IANA time zone whose calendar decides what month a delivery is in. Default: the machine's. */
  timeZone?: () => string;
  /** The clock for "this month". Default: the system clock. */
  clock?: () => Date;
  /**
   * The ids of the jobs archived now, read on every request: their deliveries are not "not paid
   * yet" (CVP-210). Default: none.
   */
  archivedJobIds?: () => ReadonlySet<string>;
  /**
   * What a client's job costs now: the engine's `priceFor`, the one Mark delivered records the
   * delivery with, so `/price` says what a delivery would get. Default: the money file's price for
   * the client (`priceForClient`).
   */
  priceFor?: PriceFor;
  /**
   * What the services cost the jobs now: Higgsfield's dollars and ElevenLabs' credits, worked out
   * from what the engine recorded (money/service-charges.ts). Read on every request; one that
   * cannot be read counts as none, so the page still opens. Default: none.
   */
  serviceCharges?: (input: {
    money: MoneyFile;
    timeZone: string;
  }) => MoneyServiceCharge[] | Promise<MoneyServiceCharge[]>;
}

/** The time zone this machine's clock is set to. Read per request, so changing it needs no restart. */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function createMoneyRoutes({
  deliveries,
  jobs,
  money,
  timeZone = machineTimeZone,
  clock = () => new Date(),
  archivedJobIds,
  priceFor,
  serviceCharges,
}: MoneyRouteOptions): Hono {
  const routes = new Hono();
  const priceOf: PriceFor =
    priceFor ??
    ((client) => {
      const file = money.get();
      return { price: priceForClient(file, client), currency: file.currency };
    });

  routes.get('/', async (c) => {
    const now = clock().getTime();
    const zone = timeZone();
    const asked = c.req.query('month');
    if (asked !== undefined && !isMonth(asked)) {
      return c.json({ error: 'Send the month as YYYY-MM, like ?month=2026-10.' }, 400);
    }
    const month = asked ?? localMonthOf(now, zone);
    const file = money.get();
    let charges: MoneyServiceCharge[] = [];
    try {
      charges = (await serviceCharges?.({ money: file, timeZone: zone })) ?? [];
    } catch (err) {
      logger.warn({ err }, 'Money: could not work out what the services cost; showing none');
    }

    const delivered = deliveries.list();
    const deliveredIds = new Set(delivered.map((delivery) => delivery.jobId));
    const body: MoneyResponse = computeMoney({
      deliveries: delivered,
      undelivered: (jobs?.getAll() ?? [])
        .filter((job) => !deliveredIds.has(job.id))
        .map((job) => ({
          jobId: job.id,
          clientId: job.clientId,
          client: job.client,
          name: job.name,
          relPath: job.relPath,
          addedAt: Date.parse(job.addedAt),
        })),
      money: file,
      serviceCharges: charges,
      moneyFile: money.fileState?.(),
      month,
      timeZone: zone,
      now,
      archivedJobIds: archivedJobIds?.(),
    });
    return c.json(body);
  });

  routes.get('/price', (c) => {
    const client = c.req.query('client')?.trim() ?? '';
    if (client === '') {
      return c.json({ error: 'Send the client, like ?client=Northwind%20Bakery.' }, 400);
    }
    const { price, currency } = priceOf(client);
    const body: MoneyPriceResponse = {
      client,
      price,
      currency,
      month: localMonthOf(clock().getTime(), timeZone()),
    };
    return c.json(body);
  });

  return routes;
}
