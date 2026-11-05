// What the client page and the Clients list know of a client's Instagram (IG6): the stored account,
// scans, reels and reads, turned into the shared answers by the pure functions of
// `@studio/shared` (domain/instagram-numbers.ts). Nothing here writes: the scan (IG3) and the link
// (IG5) write the tables, this reads them.

import {
  type ClientInstagram,
  type ClientInstagramSummary,
  clientInstagramSummary,
  computeInstagramNumbers,
  DEFAULT_INSTAGRAM_RANGE,
  type InstagramLinkableJob,
  type InstagramNumbersRead,
  type InstagramRange,
  instagramReelRows,
  instagramUsual,
  nextScanAt,
  noClientInstagram,
  sharesReadPairs,
} from '@studio/shared';
import type { InstagramRepository, InstagramScan } from '../db/index.js';

/** A scan that has no end after this long is taken for one the engine lost, not one still running. */
export const SCAN_STALE_AFTER_MS = 30 * 60_000;

export interface ClientInstagramContext {
  /** Milliseconds since the epoch. */
  now: number;
  /** An IANA name: whose wall clock the days and the scan's Monday 06:00 are on. */
  timeZone: string;
}

export interface ReadClientInstagramOptions extends ClientInstagramContext {
  /** An editor sees no money: no scan cost and no jobs to link (linking is the admin's). */
  editor: boolean;
  /** A scan of the client is queued or waiting to start right now (the schedule's queue, IG4). */
  scanQueued?: boolean;
}

/** The scan as the page shows it: `null` cost for whoever may not see money. */
function wireScan(scan: InstagramScan, editor: boolean): ClientInstagram['lastScan'] {
  if (scan.finishedAt === null) return null;
  return {
    startedAt: new Date(scan.startedAt).toISOString(),
    finishedAt: new Date(scan.finishedAt).toISOString(),
    outcome: scan.outcome ?? 'failed',
    error: scan.error === null || scan.error === '' ? null : scan.error,
    followers: scan.followers,
    following: scan.following,
    posts: scan.posts,
    reelsRead: scan.reelsRead,
    costUsd: editor ? null : scan.costUsd,
  };
}

/**
 * The jobs the Link to job menu offers for a client: its delivered and paid jobs that no reel links,
 * the newest delivery first. The delivery record decides, not the stage names of the Jobs page.
 */
export function linkableJobs(repo: InstagramRepository, clientId: string): InstagramLinkableJob[] {
  return repo.linkableDeliveries(clientId).map((delivery) => ({
    jobId: delivery.jobId,
    name: delivery.name,
    deliveredAt: new Date(delivery.deliveredAt).toISOString(),
    stage: delivery.paid ? 'paid' : 'delivered',
  }));
}

/**
 * The reads that "Shares a week" is worked out from: what the scans of the two newest weeks and
 * the scans of the tile's line read of each reel, each scan fetched once.
 */
function sharesReads(
  repo: InstagramRepository,
  input: Parameters<typeof sharesReadPairs>[0],
): InstagramNumbersRead[] {
  const ids = new Set(sharesReadPairs(input).flatMap(([older, newer]) => [older.id, newer.id]));
  return ids.size === 0 ? [] : repo.readsOfScans(...ids);
}

/**
 * `GET /api/clients/:clientId/instagram`: everything the client page's Instagram section shows. A
 * client with no account gets {@link noClientInstagram}, whatever an account it had before left
 * behind (removing an account keeps its scans and reels, so adding it again brings them back).
 */
export function readClientInstagram(
  repo: InstagramRepository,
  clientId: string,
  range: InstagramRange,
  options: ReadClientInstagramOptions,
): ClientInstagram {
  const account = repo.getAccount(clientId);
  if (account === null) return noClientInstagram();

  const { now, timeZone, editor } = options;
  const scans = repo.listOkScans(clientId);
  const reels = repo.listReels(clientId);
  const jobNames = repo.deliveryNames(
    reels.flatMap((reel) => (reel.jobId === null ? [] : [reel.jobId])),
  );
  const basis = {
    range,
    now,
    timeZone,
    since: account.since,
    firstDeliveryAt: repo.firstDeliveryAt(clientId),
    scans,
  };
  const numbers = computeInstagramNumbers({
    ...basis,
    reels,
    reads: sharesReads(repo, basis),
    jobNames,
  });

  const latest = repo.latestScan(clientId);
  const running =
    latest !== null && latest.finishedAt === null && now - latest.startedAt < SCAN_STALE_AFTER_MS;
  const ended = repo.latestEndedScan(clientId);

  return {
    account: {
      handle: account.handle,
      since: account.since,
      addedAt: new Date(account.addedAt).toISOString(),
      fullName: account.fullName,
      bio: account.biography,
      private: account.private,
      photoSavedAt:
        account.photoSavedAt === null ? null : new Date(account.photoSavedAt).toISOString(),
    },
    lastScan: ended === null ? null : wireScan(ended, editor),
    scanning: running || options.scanQueued === true,
    // The next weekly check (IG4's schedule): a client whose scan is overdue is scanned at the
    // engine's next check, so the page names the Monday after now.
    nextScanAt: nextScanAt(now, timeZone).toISOString(),
    numbers,
    reels: instagramReelRows(
      reels,
      numbers?.usual ?? instagramUsual(reels, now, timeZone),
      jobNames,
    ),
    linkableJobs: editor ? [] : linkableJobs(repo, clientId),
  };
}

/**
 * The Clients list's short form of a client's Instagram (L1): `null` for a client with no account.
 * The numbers are those of the default range (since us); the shares are not needed, so their reads
 * are not fetched.
 */
export function readClientInstagramSummary(
  repo: InstagramRepository,
  clientId: string,
  context: ClientInstagramContext,
): ClientInstagramSummary | null {
  const account = repo.getAccount(clientId);
  if (account === null) return null;
  const numbers = computeInstagramNumbers({
    range: DEFAULT_INSTAGRAM_RANGE,
    now: context.now,
    timeZone: context.timeZone,
    since: account.since,
    firstDeliveryAt: repo.firstDeliveryAt(clientId),
    scans: repo.listOkScans(clientId),
    reels: repo.listReels(clientId),
  });
  return clientInstagramSummary(account, numbers);
}
