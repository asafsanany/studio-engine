import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { InstagramRepository } from './instagram-repository.js';
import { fakeClock, memoryDb } from './test-utils.js';

// What each scan cost, as the Money page reads it (IG7): every scan with a cost above 0, whatever
// its outcome, named by its client's account row.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const T0 = Date.parse('2026-10-26T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function setup() {
  const db = memoryDb();
  opened.push(db);
  return new InstagramRepository(db, { clock: fakeClock() });
}

describe('listScanCosts', () => {
  it('lists the scans that cost something, the oldest first, named by their client', () => {
    const instagram = setup();
    instagram.upsertAccount({ clientId: 'c-falcon', client: 'Falcon FPV', handle: 'falcon.fpv' });
    instagram.upsertAccount({ clientId: 'c-dana', client: 'Dana', handle: 'dana' });
    const later = instagram.startScan({ clientId: 'c-dana', handle: 'dana', startedAt: T0 + HOUR });
    const first = instagram.startScan({
      clientId: 'c-falcon',
      handle: 'falcon.fpv',
      startedAt: T0,
    });
    instagram.finishScan(later.id, { outcome: 'ok', costUsd: 0.0731 });
    instagram.finishScan(first.id, { outcome: 'ok', costUsd: 0.1042 });

    expect(instagram.listScanCosts()).toEqual([
      {
        id: first.id,
        clientId: 'c-falcon',
        client: 'Falcon FPV',
        handle: 'falcon.fpv',
        startedAt: T0,
        costUsd: 0.1042,
      },
      {
        id: later.id,
        clientId: 'c-dana',
        client: 'Dana',
        handle: 'dana',
        startedAt: T0 + HOUR,
        costUsd: 0.0731,
      },
    ]);
  });

  it('counts a failed or stopped scan that cost something, and leaves out the ones that did not', () => {
    const instagram = setup();
    instagram.upsertAccount({ clientId: 'c-falcon', client: 'Falcon FPV', handle: 'falcon.fpv' });
    const scan = (outcome: 'ok' | 'failed' | 'private' | 'no-credit', costUsd?: number) => {
      const started = instagram.startScan({ clientId: 'c-falcon', handle: 'falcon.fpv' });
      return instagram.finishScan(started.id, {
        outcome,
        ...(costUsd === undefined ? {} : { costUsd }),
      });
    };
    const failed = scan('failed', 0.04);
    scan('private', 0);
    const noCredit = scan('no-credit');
    const stillRunning = instagram.startScan({ clientId: 'c-falcon', handle: 'falcon.fpv' });
    const ok = scan('ok', 0.1);

    const listed = instagram.listScanCosts().map((cost) => cost.id);
    expect(listed).toEqual([failed.id, ok.id]);
    expect(listed).not.toContain(noCredit.id);
    expect(listed).not.toContain(stillRunning.id);
  });

  it('has no name for a client whose account was removed, and keeps its scans', () => {
    const instagram = setup();
    instagram.upsertAccount({ clientId: 'c-falcon', client: 'Falcon FPV', handle: 'falcon.fpv' });
    const scan = instagram.startScan({ clientId: 'c-falcon', handle: 'falcon.fpv', startedAt: T0 });
    instagram.finishScan(scan.id, { outcome: 'ok', costUsd: 0.1 });

    instagram.removeAccount('c-falcon');

    expect(instagram.listScanCosts()).toMatchObject([
      { clientId: 'c-falcon', client: null, handle: 'falcon.fpv', costUsd: 0.1 },
    ]);
  });

  it('is empty before any scan', () => {
    expect(setup().listScanCosts()).toEqual([]);
  });
});

// The cost check (C90): a scan writes the cost Apify reported as its runs ended, which is early. The
// check reads the scans that were never checked, reads their runs again and writes what Apify says.

describe('scansToSettle and settleScanCost', () => {
  function endedScan(
    instagram: InstagramRepository,
    options: { finishedAt: number; costUsd?: number; runs?: string[]; running?: boolean },
  ) {
    const started = instagram.startScan({
      clientId: 'c-falcon',
      handle: 'falcon.fpv',
      startedAt: options.finishedAt - 60_000,
    });
    if (options.running === true) return started;
    return instagram.finishScan(started.id, {
      outcome: 'ok',
      costUsd: options.costUsd ?? 0.001,
      apifyRunIds: options.runs ?? ['run-a', 'run-b'],
      finishedAt: options.finishedAt,
    });
  }

  it('lists the scans that ended before the time and were never checked, the oldest first, with their runs', () => {
    const instagram = setup();
    const second = endedScan(instagram, { finishedAt: T0 + 2 * HOUR, runs: ['c', 'd'] });
    const first = endedScan(instagram, { finishedAt: T0 + HOUR, costUsd: 0.002 });
    endedScan(instagram, { finishedAt: T0 + 5 * HOUR });
    endedScan(instagram, { finishedAt: T0, running: true });

    const listed = instagram.scansToSettle(T0 + 3 * HOUR);

    // The first one ended first but was written second: ordered by id, as they were written.
    expect(listed).toEqual([
      { id: second.id, finishedAt: T0 + 2 * HOUR, costUsd: 0.001, apifyRunIds: ['c', 'd'] },
      { id: first.id, finishedAt: T0 + HOUR, costUsd: 0.002, apifyRunIds: ['run-a', 'run-b'] },
    ]);
  });

  it('leaves out a scan that is still running, and one that ended at the time or later', () => {
    const instagram = setup();
    endedScan(instagram, { finishedAt: T0, running: true });
    const edge = endedScan(instagram, { finishedAt: T0 + HOUR });

    expect(instagram.scansToSettle(T0 + HOUR)).toEqual([]);
    expect(instagram.scansToSettle(T0 + HOUR + 1).map((scan) => scan.id)).toEqual([edge.id]);
  });

  it('writes the cost and notes the check, so the scan is not listed again', () => {
    const instagram = setup();
    const scan = endedScan(instagram, { finishedAt: T0 });

    expect(instagram.settleScanCost(scan.id, 0.0348, T0 + HOUR)).toBe(true);

    expect(instagram.getScan(scan.id)?.costUsd).toBe(0.0348);
    expect(instagram.scansToSettle(T0 + 10 * HOUR)).toEqual([]);
    // What the Money page reads.
    expect(instagram.listScanCosts().map((cost) => cost.costUsd)).toEqual([0.0348]);
  });

  it('says false when the cost stayed the same, but still notes the check', () => {
    const instagram = setup();
    const scan = endedScan(instagram, { finishedAt: T0, costUsd: 0.05 });

    expect(instagram.settleScanCost(scan.id, 0.05, T0 + HOUR)).toBe(false);

    expect(instagram.scansToSettle(T0 + 10 * HOUR)).toEqual([]);
  });

  it('leaves a scan that is not there alone', () => {
    expect(setup().settleScanCost(99, 0.1, T0)).toBe(false);
  });

  it("does not show the check's column on the scan the page reads", () => {
    const instagram = setup();
    const scan = endedScan(instagram, { finishedAt: T0 });
    instagram.settleScanCost(scan.id, 0.03, T0 + HOUR);

    expect(instagram.getScan(scan.id)).not.toHaveProperty('costSettledAt');
    expect(instagram.latestScan('c-falcon')).not.toHaveProperty('costSettledAt');
  });

  it('does not touch what else the scan row says', () => {
    const instagram = setup();
    const scan = endedScan(instagram, { finishedAt: T0, runs: ['x'] });
    const before = instagram.getScan(scan.id);

    instagram.settleScanCost(scan.id, 0.03, T0 + HOUR);

    expect(instagram.getScan(scan.id)).toEqual({ ...before, costUsd: 0.03 });
  });
});
