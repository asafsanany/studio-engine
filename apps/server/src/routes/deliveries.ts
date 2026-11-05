// The delivery and payment routes (Phase 4 §3): the Jobs page's Mark delivered, Not delivered yet,
// Mark paid and Not paid yet.
//
//   POST /api/jobs/:id/deliver     body: none; the job once delivered. 404 unknown job, 409 unless
//                                  the job is ready (approved) and has no delivery yet, and 409 while
//                                  money.json is invalid with no good version to price from (a default
//                                  price is never frozen into a delivery). Writes the delivery with the
//                                  client's price from now (`recordDelivery`).
//   POST /api/jobs/:id/undeliver   body: none; the job back to approved. 404 unknown job, 409 unless
//                                  the job has a delivery and it is not paid, and 409 { error, reason:
//                                  "uploaded" } while a reel is linked to the job (its delivery has
//                                  `uploadedAt`): unlink it on the client page first. Deletes the
//                                  delivery.
//   POST /api/payments             body { jobIds: string[] (1-200, none twice), paidOn: "YYYY-MM-DD",
//                                  amounts?: { [jobId]: number ≥ 0 } } (what was paid for each video;
//                                  one left out was paid its price); { jobs, orphans } once marked
//                                  paid. 400 for a body that does not fit, 404 when a job is unknown, 409 { error, refused } when any job
//                                  has no delivery or is paid already: then nothing is changed at all.
//   POST /api/payments/undo        body { jobIds }; { jobs, orphans } with their payment cleared. 404
//                                  unknown job, 409 { error, refused } unless every job is paid.
//   GET  /api/deliveries/unpaid-without-job
//                                  { orphans }: the unpaid deliveries whose job is gone.
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`). Whether a job may move on is
// the delivery's call, not the job state machine's: a job leaves Approved by having a delivery row.
// Only Mark delivered looks at the job's state, since only a ready job can be delivered; the other
// three go by the delivery row alone, so a job that left ready (a retry, a new run) and still
// carries a delivery can be taken back or paid like any other.
//
// A delivery outlives its job: deleting the job's folder removes the job row and keeps the
// delivery (CVP-204). Such a video is still payable and can still be taken back, so Not delivered
// yet, Mark paid and Not paid yet take a job id that exists only in `deliveries`; an id that is in
// neither is the 404. Mark delivered still needs a real ready job. A video without a job answers in
// `orphans` (`{ removed }` for Not delivered yet, which deletes its delivery: there is no job to go
// back to approved) and has no `job.upsert` to publish.
//
// A change never touches the job row or its `updatedAt`, so the routes publish what the job now
// shows themselves: after each change a `job.upsert` for every job it touched (re-read, so the job
// carries its new `delivery`), then one `money.changed`: the Money page's numbers moved. The Jobs
// page reloads its videos without a job on `money.changed`.

import {
  type Job,
  type MarkPaidRequest,
  markPaidRequestSchema,
  type OrphanDeliveriesResponse,
  type OrphanDelivery,
  type PaymentRefusal,
  type PaymentRefusedResponse,
  type PaymentResponse,
  type UndeliverRefusedResponse,
  type UndeliverResponse,
  undoPaidRequestSchema,
  withoutOrphanMoney,
} from '@studio/shared';
import { Hono } from 'hono';
import { type DeliveryRepository, deliveryToOrphan, type JobRepository } from '../db/index.js';
import { logger } from '../logger.js';
import { type CanSee, clientFilter } from '../team/viewer-scope.js';

export interface DeliveryRouteOptions {
  /** Which clients a viewer sees (Team plan); the app passes it. An editor's orphan list holds only theirs. */
  canSee?: CanSee;
  jobs: Pick<JobRepository, 'get'>;
  deliveries: Pick<
    DeliveryRepository,
    'get' | 'getMany' | 'remove' | 'markPaid' | 'unmarkPaid' | 'listUnpaidWithoutJob'
  >;
  /**
   * Writes the delivery of a job (`createRecordDelivery`): the client's price from now, the review
   * time copied. False when the job had one already. It must not tell the Money page: this route
   * sends `money.changed` itself, after the `job.upsert`.
   */
  recordDelivery: (job: Job) => boolean;
  /**
   * False when money.json is invalid and there is no good version to take the price from
   * (`MoneyFileLoader.hasGoodValues`): Mark delivered is then refused with a 409. Default: always
   * true, for tests that do not care about the price.
   */
  moneyIsValid?: () => boolean;
  /**
   * Called with a job after a change to its delivery or payment. The boot wiring publishes it as
   * `job.upsert`. A listener that throws is logged and ignored.
   */
  onJobChanged?: (job: Job) => void;
  /**
   * Called once after every change, after the jobs were told about. The boot wiring publishes
   * `money.changed`. A listener that throws is logged and ignored.
   */
  onMoneyChanged?: () => void;
}

/** How a refusal reads in a 409: "<job> is <this>". */
const REFUSAL_WORDS: Record<PaymentRefusal['reason'], string> = {
  'not-delivered': 'not delivered yet',
  'already-paid': 'paid already',
  'not-paid': 'not paid',
};

const MONEY_INVALID = { error: 'money.json is invalid – run pnpm run doctor' };

/** Not delivered yet while a reel is linked to the video: the reel goes first. */
const UPLOADED_REFUSAL = {
  error: 'This video is on Instagram: unlink the reel on the client page first.',
  reason: 'uploaded',
} as const satisfies UndeliverRefusedResponse;

const BAD_PAYMENT_BODY = {
  error:
    'Send the payment as JSON: { "jobIds": ["…"], "paidOn": "2026-10-23", "amounts": { "…": 40 } }, one to 200 different videos, a real day and, if you send amounts, zero or more for videos in the payment.',
};
const BAD_UNDO_BODY = {
  error: 'Send the videos as JSON: { "jobIds": ["…"] }, one to 200 different videos.',
};

/**
 * Tells the listeners after a change, and re-reads what it touched. Shared by the four routes.
 * `jobs` are the videos that still have a job, each told as `job.upsert`; `orphans` are the ones
 * whose job is gone, which have no job to tell (`money.changed` is their news).
 */
function announcer({ jobs, deliveries, onJobChanged, onMoneyChanged }: DeliveryRouteOptions) {
  return (ids: readonly string[]): { jobs: Job[]; orphans: OrphanDelivery[] } => {
    const changed = ids.flatMap((id) => jobs.get(id) ?? []);
    for (const job of changed) {
      try {
        onJobChanged?.(job);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'onJobChanged listener threw');
      }
    }
    try {
      onMoneyChanged?.();
    } catch (err) {
      logger.error({ err }, 'onMoneyChanged listener threw');
    }
    const withJob = new Set(changed.map((job) => job.id));
    const kept = deliveries.getMany(ids.filter((id) => !withJob.has(id)));
    return {
      jobs: changed,
      orphans: ids.flatMap((id) => {
        const delivery = kept.get(id);
        return delivery === undefined ? [] : deliveryToOrphan(delivery);
      }),
    };
  };
}

const notFound = (id: string) => ({ error: `Job ${id} not found` });

/** `POST /api/jobs/:id/deliver` and `…/undeliver`. Mount at `/jobs`. */
export function createDeliveryRoutes(options: DeliveryRouteOptions): Hono {
  const { jobs, deliveries, recordDelivery } = options;
  const announce = announcer(options);
  const routes = new Hono();

  routes.post('/:id/deliver', (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json(notFound(id), 404);
    if (job.state !== 'ready') {
      return c.json(
        {
          error: `Cannot mark a job delivered that is ${job.state}: only an approved video can be.`,
        },
        409,
      );
    }
    const alreadyDelivered = { error: 'This video is marked delivered already.' };
    if (job.delivery !== null) return c.json(alreadyDelivered, 409);
    if (options.moneyIsValid?.() === false) return c.json(MONEY_INVALID, 409);
    if (!recordDelivery(job)) return c.json(alreadyDelivered, 409);

    const [after] = announce([id]).jobs;
    return after === undefined ? c.json(notFound(id), 404) : c.json(after);
  });

  routes.post('/:id/undeliver', (c) => {
    const id = c.req.param('id');
    // The delivery row is what counts, and it outlives the job (its folder may be deleted).
    const delivery = deliveries.get(id);
    if (delivery === null) {
      return jobs.get(id) === null
        ? c.json(notFound(id), 404)
        : c.json({ error: 'This video is not marked delivered.' }, 409);
    }
    if (delivery.paidOn !== null) {
      return c.json({ error: 'This video is marked paid: mark it not paid first.' }, 409);
    }
    // A reel linked to the job (its delivery has `uploadedAt`) is why it is Uploaded: unlink first.
    if (jobs.get(id)?.delivery?.uploadedAt !== undefined) return c.json(UPLOADED_REFUSAL, 409);
    if (!deliveries.remove(id))
      return c.json({ error: 'This video is not marked delivered.' }, 409);

    const [after] = announce([id]).jobs;
    // No job left to go back to approved: the delivery that was taken off is the answer.
    const answer: UndeliverResponse = after ?? { removed: deliveryToOrphan(delivery) };
    return c.json(answer);
  });

  return routes;
}

/** `POST /api/payments` and `POST /api/payments/undo`. Mount at `/payments`. */
export function createPaymentRoutes(options: DeliveryRouteOptions): Hono {
  const { jobs, deliveries } = options;
  const announce = announcer(options);
  const routes = new Hono();

  /** The request's JSON body, or `undefined` when there is none. */
  async function readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  }

  /**
   * The 404 for videos the engine does not know, or `null` when every one exists. A video whose
   * job is gone but whose delivery is kept (its folder was deleted) is known.
   */
  function unknownJobs(ids: readonly string[]): { error: string } | null {
    const kept = deliveries.getMany(ids);
    const missing = ids.filter((id) => jobs.get(id) === null && !kept.has(id));
    const [first] = missing;
    if (first === undefined) return null;
    return missing.length === 1
      ? notFound(first)
      : { error: `Jobs not found: ${missing.join(', ')}` };
  }

  /** The 409 for the jobs that were in the wrong stage, with their names and why. */
  function refusal(refused: PaymentRefusal[]): PaymentRefusedResponse {
    const lines = refused.map(({ jobId, reason }) => {
      const name = jobs.get(jobId)?.name ?? deliveries.get(jobId)?.name ?? jobId;
      return `${name} is ${REFUSAL_WORDS[reason]}`;
    });
    return { error: `Nothing was changed: ${lines.join('; ')}.`, refused };
  }

  routes.post('/', async (c) => {
    const parsed = markPaidRequestSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return c.json(BAD_PAYMENT_BODY, 400);
    const { jobIds, paidOn, amounts }: MarkPaidRequest = parsed.data;

    const missing = unknownJobs(jobIds);
    if (missing !== null) return c.json(missing, 404);
    const result = deliveries.markPaid(jobIds, paidOn, amounts);
    if (!result.ok) return c.json(refusal(result.refused), 409);

    return c.json(announce(jobIds) satisfies PaymentResponse);
  });

  routes.post('/undo', async (c) => {
    const parsed = undoPaidRequestSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return c.json(BAD_UNDO_BODY, 400);
    const { jobIds } = parsed.data;

    const missing = unknownJobs(jobIds);
    if (missing !== null) return c.json(missing, 404);
    const result = deliveries.unmarkPaid(jobIds);
    if (!result.ok) return c.json(refusal(result.refused), 409);

    return c.json(announce(jobIds) satisfies PaymentResponse);
  });

  return routes;
}

/**
 * `GET /api/deliveries/unpaid-without-job`: the delivered videos that are not paid and whose job
 * is gone, newest delivery first. Mount at `/deliveries`.
 */
export function createDeliveryListRoutes({ deliveries, canSee }: DeliveryRouteOptions): Hono {
  const routes = new Hono();
  routes.get('/unpaid-without-job', (c) => {
    // An editor sees the videos of their own clients only (Team plan, TM2).
    const visible = clientFilter(c, canSee);
    const orphans = deliveries.listUnpaidWithoutJob().map(deliveryToOrphan);
    return c.json({
      // ...with no price or pay date: money is the admin's alone.
      orphans:
        visible === null
          ? orphans
          : orphans.filter((orphan) => visible(orphan.clientId)).map(withoutOrphanMoney),
    } satisfies OrphanDeliveriesResponse);
  });
  return routes;
}
