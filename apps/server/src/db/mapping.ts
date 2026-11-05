// The one place that turns a database row into a `Job` and back. Nothing else in the server
// knows the column layout.

import {
  canArchive,
  canvasesOfFormats,
  type InputCounts,
  type Job,
  type JobDelivery,
  type JobEvent,
  jobFormatsOf,
  type OrphanDelivery,
  SETTLE_MS,
  settleTime,
} from '@studio/shared';
import { clientIdFor } from '../inbox/scan.js';
import type { Delivery } from './delivery-repository.js';
import type { InstagramReelLink } from './instagram-repository.js';
import type { JobRow } from './schema.js';

/** Bookkeeping the engine keeps per job but the web app never sees. */
export interface JobMeta {
  /** Seconds of video and audio in the inputs (what the ETA is based on). */
  footageSec: number;
  /** When the latest edit attempt started; `null` for a job that never has. */
  startedAt: string | null;
  /** When the latest edit attempt ended (ready, failed or cancelled). */
  finishedAt: string | null;
  /** 1 for the first attempt, +1 for every retry. */
  attempt: number;
  /** Seconds the owner spent in the Review dialog for this job (M3); copied into its delivery. */
  reviewSec: number;
  /** True once the owner picked the job's series by hand: the name rule then leaves it alone. */
  seriesPinned: boolean;
}

/**
 * A job as stored: the wire `Job` plus its bookkeeping. `transition` carries the extra fields
 * through untouched, so one object goes in and comes out.
 */
export type StoredJob = Job & JobMeta;

export type JobColumns = Omit<JobRow, 'id' | 'relKey'>;

export function toMs(iso: string): number {
  return Date.parse(iso);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

function toMsOrNull(iso: string | null): number | null {
  return iso === null ? null : toMs(iso);
}

/** Folder names compare equal across the NFC and NFD spellings macOS can hand out. */
export function relKeyOf(relPath: string): string {
  return relPath.normalize('NFC');
}

/**
 * The `Job.delivery` of a stored delivery: the time as ISO text, the rest as it is. `reel` is the
 * Instagram reel that links the job, when one does: its posted time is `uploadedAt`, its address
 * `reelUrl` and its plays `reelPlays` (the Uploaded row says them; left out for a reel whose plays
 * are not known), all left out otherwise. They are read from `instagram_reels` as the job is read
 * and never stored in the delivery, so they cannot go stale (Clients × Instagram, IG5).
 */
export function deliveryToJobDelivery(
  delivery: Delivery,
  reel: InstagramReelLink | null = null,
): JobDelivery {
  return {
    deliveredAt: toIso(delivery.deliveredAt),
    price: delivery.price,
    currency: delivery.currency,
    paidOn: delivery.paidOn,
    paidAmount: delivery.paidAmount,
    ...(reel === null
      ? {}
      : {
          uploadedAt: toIso(reel.postedAt),
          reelUrl: reel.url,
          ...(reel.plays === null ? {} : { reelPlays: reel.plays }),
        }),
  };
}

/** A delivery whose job is gone, as the API sends it (CVP-204). */
export function deliveryToOrphan(delivery: Delivery): OrphanDelivery {
  return {
    id: delivery.jobId,
    clientId: delivery.clientId,
    client: delivery.client,
    name: delivery.name,
    relPath: delivery.relPath,
    delivery: deliveryToJobDelivery(delivery),
  };
}

/** Values derived at read time; never stored on the job row. */
export interface Derived {
  placeInLine: number | null;
  etaSec: number | null;
  /** From the `deliveries` table: `null` for a job that was not marked delivered. */
  delivery: JobDelivery | null;
  /** From the `quick_fixes` table, only for a job in Review while the switch is on: the note being fixed. */
  fixing: Job['fixing'];
  /** Likewise: how many notes of the round are fixed. */
  fixedCount: number;
  /** From the job's `step_runs`, only for a job in Review while the switch is on: the range of its revise runs. */
  reviseMinutes: Job['reviseMinutes'];
}

export const NO_DERIVED: Derived = {
  placeInLine: null,
  etaSec: null,
  delivery: null,
  fixing: null,
  fixedCount: 0,
  reviseMinutes: null,
};

/**
 * The wire `Job` for a row. `settlesAt` follows from `lastChangeAt` and the settle delay
 * `settleMs` (default 60 s); the rest comes in `derived`.
 */
export function rowToJob(
  row: JobRow,
  derived: Derived = NO_DERIVED,
  settleMs: number = SETTLE_MS,
): Job {
  const lastChangeAt = toIso(row.lastChangeAt);
  // Formats (GN7): only a job with two or more carries the key, so every other job's shape is unchanged.
  const formats = jobFormatsOf(row.formats);
  return {
    id: row.id,
    // Derived, not stored: the same folder name always gives the same id (NFC or NFD).
    clientId: clientIdFor(row.client),
    client: row.client,
    name: row.name,
    relPath: row.relPath,
    state: row.state,
    step: row.step,
    subProgress: row.subProgress,
    etaSec: derived.etaSec,
    // Only an editing job carries it, so every other job's wire shape stays as it was.
    ...(row.state === 'editing' ? { runningSince: toIsoOrNull(row.startedAt) } : {}),
    placeInLine: derived.placeInLine,
    settlesAt: row.state === 'arriving' ? settleTime(lastChangeAt, settleMs) : null,
    failedAt: row.failedAt,
    error: row.error,
    stoppedAt: row.stoppedAt,
    inputs: row.inputs,
    sizeBytes: row.sizeBytes,
    addedAt: toIso(row.addedAt),
    lastChangeAt,
    settledAt: toIsoOrNull(row.settledAt),
    heldSettledAt: toIsoOrNull(row.heldSettledAt),
    updatedAt: toIso(row.updatedAt),
    output: row.output,
    note: row.note,
    effort: row.effort,
    reviewEffort: row.reviewEffort,
    reviseTier: row.reviseTier,
    fixing: derived.fixing,
    fixedCount: derived.fixedCount,
    reviseMinutes: derived.reviseMinutes,
    archivedAt: toIsoOrNull(row.archivedAt),
    runKind: row.runKind,
    round: row.round,
    preview: row.preview,
    approvedAt: toIsoOrNull(row.approvedAt),
    delivery: derived.delivery,
    seriesId: row.seriesId,
    episode: row.episode,
    ...(formats.length > 0 ? { formats } : {}),
  };
}

export function rowToMeta(row: JobRow): JobMeta {
  return {
    footageSec: row.footageSeconds,
    startedAt: toIsoOrNull(row.startedAt),
    finishedAt: toIsoOrNull(row.finishedAt),
    attempt: row.attempt,
    reviewSec: row.reviewSec,
    seriesPinned: row.seriesPinned,
  };
}

export function rowToStored(row: JobRow, settleMs: number = SETTLE_MS): StoredJob {
  return { ...rowToJob(row, NO_DERIVED, settleMs), ...rowToMeta(row) };
}

/**
 * Every stored column of a job (derived fields are left out), ready for insert or update.
 *
 * This is the one place a job leaves the archive on its own: a job in a state that cannot be
 * archived (arriving, queued, editing: `canArchive`) is stored with no `archivedAt`, whatever the
 * job carried in. Every save goes through here (`applyTransition`, `upsertFromScan`), so a retry,
 * a resume, a release, Start now, Send notes, Approve or new files in the folder cannot miss it.
 */
export function storedToColumns(job: StoredJob): JobColumns & { relKey: string } {
  return {
    client: job.client,
    name: job.name,
    relPath: job.relPath,
    relKey: relKeyOf(job.relPath),
    state: job.state,
    step: job.step,
    subProgress: job.subProgress,
    failedAt: job.failedAt,
    error: job.error,
    stoppedAt: job.stoppedAt,
    inputs: job.inputs,
    sizeBytes: job.sizeBytes,
    footageSeconds: job.footageSec,
    addedAt: toMs(job.addedAt),
    updatedAt: toMs(job.updatedAt),
    lastChangeAt: toMs(job.lastChangeAt),
    settledAt: toMsOrNull(job.settledAt),
    heldSettledAt: toMsOrNull(job.heldSettledAt),
    startedAt: toMsOrNull(job.startedAt),
    finishedAt: toMsOrNull(job.finishedAt),
    output: job.output,
    attempt: job.attempt,
    note: job.note,
    effort: job.effort,
    reviewEffort: job.reviewEffort,
    reviseTier: job.reviseTier,
    archivedAt: canArchive(job) ? toMsOrNull(job.archivedAt) : null,
    runKind: job.runKind,
    round: job.round,
    preview: job.preview,
    approvedAt: toMsOrNull(job.approvedAt),
    reviewSec: job.reviewSec,
    seriesId: job.seriesId,
    episode: job.episode,
    seriesPinned: job.seriesPinned,
    formats: canvasesOfFormats(job.formats),
  };
}

export function sameInputs(a: InputCounts, b: InputCounts): boolean {
  return a.video === b.video && a.audio === b.audio && a.image === b.image && a.doc === b.doc;
}

/**
 * The bookkeeping a state change implies, which the machine does not track: `START` begins an
 * attempt, `PREVIEW_READY`/`SUCCEED`/`FAIL`/`CANCEL` end it, `RETRY` starts the next one, and
 * `SEND_NOTES`/`APPROVE` start a new kind of run, which is a first attempt again.
 */
export function applyBookkeeping(job: StoredJob, event: JobEvent, at: string): StoredJob {
  switch (event.type) {
    case 'START':
      return { ...job, startedAt: at, finishedAt: null };
    case 'PREVIEW_READY':
    case 'SUCCEED':
    case 'FAIL':
    case 'CANCEL':
      return { ...job, finishedAt: at };
    case 'RETRY':
      return { ...job, attempt: job.attempt + 1 };
    case 'SEND_NOTES':
    case 'APPROVE':
      return { ...job, attempt: 1 };
    default:
      return job;
  }
}
