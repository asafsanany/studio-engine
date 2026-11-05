// Link a reel to a job and unlink it (Clients × Instagram, IG5), mounted by `createInstagramRoutes`
// beside the rest of the Instagram routes (the same switch: off, they answer 404):
//
//   POST   /instagram/reels/:shortcode/link   body { jobId }: the reel as it is now (200). Linking
//          the pair that is linked already changes nothing. 400 for a body that is not { jobId },
//          404 { error } for a job that does not exist, and 409 { error, reason } when it is
//          refused, in this order:
//            no-reel          there is no reel with this shortcode
//            not-this-client  the reel is not on the job's client's page (its own reels, and the
//                             collab reels its scans read: see `InstagramRepository.listReels`)
//            not-delivered    the job has no delivery (Delivered or Paid is what may be linked)
//            reel-linked      the reel is linked to another job: unlink it first
//            job-linked       another reel is linked to the job: one reel, one job
//   DELETE /instagram/reels/:shortcode/link   the reel as it is now, theirs again (200). 404 { error }
//          for a reel that links no job, 404 { error, reason: "no-reel" } for no such reel.
//
// A change is two pieces of news: the job's update (its delivery gained or lost `uploadedAt` and
// `reelUrl`, so the Jobs page changes at once: the same news as Mark delivered) and
// `client-instagram { clientId }` for the reel's owner and the job's client (their pages' reels
// changed). Both are the boot wiring's to publish. The admin links, as the admin marks delivered (team/route-policies.ts).
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import {
  INSTAGRAM_LINK_MESSAGES,
  INSTAGRAM_MESSAGES,
  type InstagramLinkRefusal,
  type InstagramLinkRefusalReason,
  instagramLinkRequestSchema,
  type Job,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { InstagramLinkError, type InstagramRepository, type JobRepository } from '../db/index.js';
import { toWireReel } from '../instagram/reel-wire.js';
import { logger } from '../logger.js';

export interface InstagramLinkRouteOptions {
  /** The jobs: whose a job is, whether it has a delivery, its name. */
  jobs: Pick<JobRepository, 'get'>;
  instagram: Pick<InstagramRepository, 'getReel' | 'linkReel' | 'unlinkReel' | 'reelIsOnPageOf'>;
  /**
   * Called with the job after its reel was linked or unlinked, re-read, so that it carries (or no
   * longer carries) `uploadedAt` and `reelUrl`. The boot wiring publishes it as `job.upsert`. A
   * listener that throws is logged and ignored.
   */
  onJobChanged?: (job: Job) => void;
  /**
   * Called with the reel's owner after a link or an unlink, and with the job's client when it is
   * another (a collab reel). The boot wiring publishes it as `client-instagram`. A listener that
   * throws is logged and ignored.
   */
  onClientInstagramChanged?: (clientId: string) => void;
}

/** The request's JSON body, or `undefined` when it is not JSON. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** How the repository's refusals read in the contract's reasons. */
const REASON_OF: Record<InstagramLinkError['reason'], InstagramLinkRefusalReason> = {
  'reel-not-found': 'no-reel',
  'reel-linked': 'reel-linked',
  'job-linked': 'job-linked',
};

/** The 409 of a link that is refused: the words of the reason, and the reason. */
function refusal(reason: InstagramLinkRefusalReason): InstagramLinkRefusal {
  return { error: INSTAGRAM_LINK_MESSAGES[reason], reason };
}

/** `POST` and `DELETE /instagram/reels/:shortcode/link`. Mount at `/`. */
export function createInstagramLinkRoutes({
  jobs,
  instagram,
  onJobChanged,
  onClientInstagramChanged,
}: InstagramLinkRouteOptions): Hono {
  const routes = new Hono();

  /**
   * Tells the job's page and the client pages the reel is on (its owner's and the job's client's),
   * after a change; a listener that throws is only logged.
   */
  function announce(jobId: string, ownerId: string): void {
    const job = jobs.get(jobId);
    if (job !== null) {
      try {
        onJobChanged?.(job);
      } catch (err) {
        logger.error({ err, jobId }, 'onJobChanged listener threw');
      }
    }
    for (const clientId of new Set([ownerId, job?.clientId ?? ownerId])) {
      try {
        onClientInstagramChanged?.(clientId);
      } catch (err) {
        logger.error({ err, clientId }, 'onClientInstagramChanged listener threw');
      }
    }
  }

  routes.post('/instagram/reels/:shortcode/link', async (c) => {
    const body = instagramLinkRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: INSTAGRAM_MESSAGES.linkBody }, 400);
    const shortcode = c.req.param('shortcode');
    const { jobId } = body.data;

    const reel = instagram.getReel(shortcode);
    if (reel === null) return c.json(refusal('no-reel'), 409);
    const job = jobs.get(jobId);
    if (job === null) return c.json({ error: `Job ${jobId} not found` }, 404);
    if (!instagram.reelIsOnPageOf(shortcode, job.clientId)) {
      return c.json(refusal('not-this-client'), 409);
    }
    if (job.delivery === null) return c.json(refusal('not-delivered'), 409);

    let linked: ReturnType<InstagramRepository['linkReel']>;
    try {
      linked = instagram.linkReel(shortcode, jobId);
    } catch (err) {
      if (err instanceof InstagramLinkError) return c.json(refusal(REASON_OF[err.reason]), 409);
      throw err;
    }
    // The pair was linked already: nothing changed, so there is nothing to tell.
    if (reel.jobId !== jobId) announce(jobId, reel.clientId);
    return c.json(toWireReel(linked, { id: job.id, name: job.name }));
  });

  routes.delete('/instagram/reels/:shortcode/link', (c) => {
    const reel = instagram.getReel(c.req.param('shortcode'));
    if (reel === null) return c.json(refusal('no-reel'), 404);
    const { jobId } = reel;
    if (jobId === null) return c.json({ error: INSTAGRAM_MESSAGES.notLinked }, 404);

    const unlinked = instagram.unlinkReel(reel.shortcode);
    if (unlinked === null) return c.json(refusal('no-reel'), 404);
    announce(jobId, reel.clientId);
    return c.json(toWireReel(unlinked, null));
  });

  return routes;
}
