// The cost check of Clients × Instagram (C90): what a scan's Apify runs really cost.
//
// A scan writes the cost it read as its runs ended (`runActor`'s `costUsd`). Apify tallies a
// pay-per-event run's charges a few seconds after the run ends, so that number is early and low: two
// real scans wrote $0.001 each where the runs say $0.0348 and $0.027. The Money page and Analytics read
// the scan rows, so they under-counted by the same amount.
//
// This check reads the runs of each scan again, some minutes after the scan ended, and writes what
// Apify says now. It is the one mechanism for every scan:
//
//   - a new scan is checked at the first check of the scan queue after `COST_SETTLE_AFTER_MS` (the
//     queue checks at start and every 15 minutes);
//   - a scan stored before the check existed has no `cost_settled_at`, so the first check after the
//     update finds it too and corrects it: no hand edit, no special case;
//   - the check never holds or fails a scan: it runs on its own, on scans that have already ended.
//
// What it does with what it reads:
//
//   - the cost only ever goes up: the new cost is the larger of the one stored and the sum of the
//     runs it could read. A run it cannot read (Apify no longer has it, or says no number) keeps the
//     stored number;
//   - a read that breaks the way a network does (no answer, 5xx, 429, a run still going) is tried
//     again at the next check, until the scan is `COST_GIVE_UP_MS` old; then the scan keeps the cost
//     it has;
//   - an Apify key that is missing, or Apify not answering at all, ends the pass: the scans that are
//     left wait for the next check instead of each waiting for its own timeout.
//
// `readRunCost` is injected, so tests (and the fake scanner) never reach Apify.

import type { InstagramRepository } from '../db/instagram-repository.js';
import { ApifyError, type ReadRunCostOptions, type RunCostReading } from './apify.js';

/**
 * How long after a scan ended its cost is read again. Apify's charges arrive seconds after a run
 * ends; this leaves minutes. A scan younger than this is left to the next check.
 */
export const COST_SETTLE_AFTER_MS = 3 * 60_000;

/** A scan whose runs still cannot be read this long after it ended keeps the cost it has. */
export const COST_GIVE_UP_MS = 7 * 24 * 60 * 60_000;

/** Reads one Apify run: `readRunCost` of ./apify.ts, or a stand-in for it. */
export type RunCostReader = (
  runId: string,
  options?: ReadRunCostOptions,
) => Promise<RunCostReading>;

export interface SettleScanCostsOptions {
  instagram: Pick<InstagramRepository, 'scansToSettle' | 'settleScanCost'>;
  readRunCost: RunCostReader;
  /** The clock. Default: the system's. */
  clock?: () => Date;
  /** Stops the pass (what is checked so far is kept). */
  signal?: AbortSignal;
}

export interface SettleScanCostsResult {
  /** Scans whose cost was written (checked, or given up on). */
  settled: number;
  /** Of those, the ones whose cost changed. */
  changed: number;
  /** Scans left for the next check (a read broke, or a run is still going). */
  waiting: number;
}

/** Rounds to a millionth of a dollar, as the scan's own sum is. */
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * What a failed read means: Apify's answer will not change (`gone`), the read may work later
 * (`transient`), or nothing can be read now (`stop`: no key, or Apify gave no answer at all).
 */
function kindOfFailure(error: unknown): 'gone' | 'transient' | 'stop' {
  if (!(error instanceof ApifyError)) return 'transient';
  if (error.code === 'no-token') return 'stop';
  const { status } = error;
  // No answer at all (the network broke, or the read timed out): the next scan would fare the same.
  if (status === null) return 'stop';
  // Apify answered and the answer is "no" (a run it does not have, a bad id): asking again is no use.
  if (error.code === 'failed' && status >= 400 && status < 500) {
    return status === 408 || status === 429 ? 'transient' : 'gone';
  }
  return 'transient';
}

/**
 * One pass of the check: reads again the runs of every scan that ended at least
 * {@link COST_SETTLE_AFTER_MS} ago and has not been checked, one scan after another, and writes what
 * they cost. Never throws for Apify (a failed read is a scan that waits); it throws only when the
 * database does.
 */
export async function settleScanCosts(
  options: SettleScanCostsOptions,
): Promise<SettleScanCostsResult> {
  const { instagram, readRunCost, signal } = options;
  const clock = options.clock ?? (() => new Date());
  const result: SettleScanCostsResult = { settled: 0, changed: 0, waiting: 0 };

  const scans = instagram.scansToSettle(clock().getTime() - COST_SETTLE_AFTER_MS);
  for (const [position, scan] of scans.entries()) {
    if (signal?.aborted) return result;

    let known = 0;
    let transient = false;
    let stop = false;
    for (const runId of scan.apifyRunIds) {
      try {
        const reading = await readRunCost(runId, { signal });
        if (!reading.finished) transient = true;
        else if (reading.costUsd !== null) known += reading.costUsd;
        // No number from a finished run: nothing more to learn from it, it keeps what is stored.
      } catch (error) {
        if (signal?.aborted) return result;
        const kind = kindOfFailure(error);
        if (kind === 'stop') stop = true;
        if (kind !== 'gone') transient = true;
      }
      if (stop) break;
    }

    const now = clock().getTime();
    if (transient && now - scan.finishedAt < COST_GIVE_UP_MS) {
      // This scan waits for the next check, and so do the rest when nothing can be read now.
      result.waiting += stop ? scans.length - position : 1;
      if (stop) return result;
      continue;
    }
    // The cost only goes up: a run that could not be read keeps its share of the stored number.
    const changed = instagram.settleScanCost(scan.id, round(Math.max(scan.costUsd, known)), now);
    result.settled += 1;
    if (changed) result.changed += 1;
    if (stop) {
      // The key or the network is gone and this scan was too old to wait for it: the rest wait.
      result.waiting += scans.length - position - 1;
      return result;
    }
  }
  return result;
}
