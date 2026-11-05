import { z } from 'zod';
import { type Job, jobDeliverySchema } from './job.ts';

// A delivered video whose job is gone (CVP-204). Deleting a job's folder removes the job row but
// keeps its delivery for good (the Money page's past months keep their numbers), so a delivery can
// outlive its job. The owner decided such a video is still payable: it can be marked paid, or taken back
// (Not delivered yet), from the Jobs page, and it stays in the Money Ledger.
//
// The server never turns it into a job. It sends the delivery row as an `OrphanDelivery`; the web
// app shows it as a muted row by dressing it as a `FolderDeletedJob` (below), a ready, delivered
// `Job` with a marker, so the tabs, the search, the sort and the Mark paid dialog treat it like any
// other delivered video.

/**
 * A delivery whose job row is gone, as the server sends it: who it was for, and the delivery
 * itself (the price frozen when it was delivered, the day it was paid, `null` while it is not).
 */
export const orphanDeliverySchema = z.object({
  /** The deleted job's id: what the payment routes take. */
  id: z.string().min(1),
  clientId: z.string().min(1),
  client: z.string().min(1),
  name: z.string().min(1),
  /** `Client/Job`, as it was when the job was delivered. */
  relPath: z.string().min(1),
  delivery: jobDeliverySchema,
});
export type OrphanDelivery = z.infer<typeof orphanDeliverySchema>;

/** The orphan delivery as an editor may see it: no price, currency or pay date (money is the admin's). */
export function withoutOrphanMoney(orphan: OrphanDelivery): OrphanDelivery {
  return { ...orphan, delivery: { deliveredAt: orphan.delivery.deliveredAt } };
}

/**
 * A job as the Jobs page lists it for an unpaid delivery whose folder is gone: a ready job with
 * its delivery, plus the marker `folderDeleted`. Only the web app makes these (`orphanAsJob`); the
 * server's jobs never carry the marker.
 */
export type FolderDeletedJob = Job & { readonly folderDeleted: true };

/** Whether this is a video whose folder is gone (see {@link FolderDeletedJob}). */
export function isFolderDeleted(job: object): job is FolderDeletedJob {
  return (job as { folderDeleted?: unknown }).folderDeleted === true;
}

/**
 * The job a row of the Jobs page stands for. It is ready and delivered, so `jobStage` and
 * `groupOf` put it under Delivered (or Paid, once its delivery is); its name and client are the
 * delivery row's, and the times are the day it was delivered. Everything a folder would have
 * given it (inputs, output, preview, notes) is empty.
 */
export function orphanAsJob(orphan: OrphanDelivery): FolderDeletedJob {
  const { delivery } = orphan;
  return {
    id: orphan.id,
    clientId: orphan.clientId,
    client: orphan.client,
    name: orphan.name,
    relPath: orphan.relPath,
    state: 'ready',
    step: null,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 0, audio: 0, image: 0, doc: 0 },
    sizeBytes: 0,
    addedAt: delivery.deliveredAt,
    lastChangeAt: delivery.deliveredAt,
    settledAt: null,
    heldSettledAt: null,
    updatedAt: delivery.deliveredAt,
    output: null,
    note: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    archivedAt: null,
    runKind: 'render',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery,
    seriesId: null,
    episode: null,
    folderDeleted: true,
  };
}

/**
 * The jobs the Jobs page lists: the job list, and after it the videos whose folder is gone and
 * that are not paid yet. A paid one is left out (it leaves the page; the Ledger keeps it), and so
 * is one whose id the job list holds again (the folder was put back: the real job wins).
 */
export function withFolderDeleted(jobs: readonly Job[], orphans: readonly OrphanDelivery[]): Job[] {
  const ids = new Set(jobs.map((job) => job.id));
  return [
    ...jobs,
    ...orphans
      .filter((orphan) => orphan.delivery.paidOn === null && !ids.has(orphan.id))
      .map(orphanAsJob),
  ];
}
