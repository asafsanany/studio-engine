// Which clients' Instagram accounts are due for their weekly scan (Clients × Instagram, IG4). Pure:
// the clock, the time zone and what the database says are passed in, so the tests can walk through
// a week and a daylight-saving change without waiting for either.
//
//   a client is due when its last scan that counts started before the latest Monday 06:00 local
//   time (`scanCutoff`, in @studio/shared, so the page and the engine agree on the week)
//
// Which scans count:
//   - one that ended any way Apify or the account decided: ok, private, not-found, no-token,
//     no-credit, or failed. A failing account is tried again on the next Monday, not every 15 minutes.
//   - not one that was stopped (`The scan was stopped`: the engine shut down, or the account was
//     removed, mid-scan), and not one that never ended (the engine died mid-scan). Those read nothing,
//     so a Mac that shut down in the middle of a scan scans again at the next check.
//
// Which clients are looked at (Settings › Instagram › Which clients): `all`, or the active ones, a
// job added or delivered in the last 60 days. A client whose account was added in the last 60 days is
// active too, so a new account is scanned even when its client has had no job lately.

import { INSTAGRAM_ACTIVE_DAYS, type ScheduleTime, scanCutoff } from '@studio/shared';
import type { InstagramScan } from '../db/instagram-repository.js';
import { SCAN_MESSAGES } from './scanner.js';

export { nextScanAt, scanCutoff } from '@studio/shared';

/** How long ago, in milliseconds, a job or a new account makes its client active. */
export const ACTIVE_WINDOW_MS = INSTAGRAM_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

/** The Mac's time zone, e.g. `Asia/Jerusalem`: the one Monday 06:00 is read in. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** What it takes to tell whether a scan was this week's. */
export type ScanStamp = Pick<InstagramScan, 'startedAt' | 'finishedAt' | 'outcome' | 'error'>;

/**
 * Whether the scan counts as the client's scan of its week: it ended, and it was not stopped.
 * See the top of this file.
 */
export function countsForTheWeek(scan: ScanStamp): boolean {
  if (scan.finishedAt === null || scan.outcome === null) return false;
  return !(scan.outcome === 'failed' && scan.error === SCAN_MESSAGES.stopped);
}

/** The newest scan of `recent` (newest first, as `recentScans` gives them) that counts; `null` when none does. */
export function lastCountingScan<T extends ScanStamp>(recent: readonly T[]): T | null {
  return recent.find(countsForTheWeek) ?? null;
}

/** What `dueClients` needs of an account. */
export interface ScheduledAccount {
  clientId: string;
  /** When the account was added (ms): a new account scans even for a client that is not active. */
  addedAt: number;
}

/**
 * The ids of the clients that are due, in the order to scan them: the ones never scanned first
 * (the account added first first), then the one scanned longest ago.
 *
 * `lastScans` is, by client id, when the client's last counting scan started (see
 * {@link countsForTheWeek}); a client that has none is not in it. `activeClientIds` is the clients
 * with a job added or delivered in the last 60 days ({@link activeClientIds}), or `null` for every
 * client (Which clients: All).
 */
export function dueClients(
  now: ScheduleTime,
  timeZone: string,
  accounts: readonly ScheduledAccount[],
  lastScans: ReadonlyMap<string, number>,
  activeClientIds: ReadonlySet<string> | null,
): string[] {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const cutoff = scanCutoff(nowMs, timeZone).getTime();
  const due = accounts.filter((account) => {
    const last = lastScans.get(account.clientId);
    if (last !== undefined && last >= cutoff) return false;
    return (
      activeClientIds === null ||
      activeClientIds.has(account.clientId) ||
      account.addedAt >= nowMs - ACTIVE_WINDOW_MS
    );
  });
  // Never scanned (no entry) counts as the oldest scan there is.
  const lastOf = (account: ScheduledAccount): number =>
    lastScans.get(account.clientId) ?? Number.NEGATIVE_INFINITY;
  due.sort((a, b) => {
    const [lastA, lastB] = [lastOf(a), lastOf(b)];
    if (lastA !== lastB) return lastA < lastB ? -1 : 1;
    return a.addedAt - b.addedAt || a.clientId.localeCompare(b.clientId);
  });
  return due.map((account) => account.clientId);
}

/**
 * The clients with a job added or delivered in the last 60 days. `addedAt` of a job is the ISO
 * time the engine found it; `deliveredAt` of a delivery is in milliseconds. A delivery counts
 * after its job's folder is gone.
 */
export function activeClientIds(
  now: ScheduleTime,
  jobs: readonly { clientId: string; addedAt: string }[],
  deliveries: readonly { clientId: string; deliveredAt: number }[],
): Set<string> {
  const since = (typeof now === 'number' ? now : now.getTime()) - ACTIVE_WINDOW_MS;
  const active = new Set<string>();
  for (const job of jobs) {
    if (Date.parse(job.addedAt) >= since) active.add(job.clientId);
  }
  for (const delivery of deliveries) {
    if (delivery.deliveredAt >= since) active.add(delivery.clientId);
  }
  return active;
}
