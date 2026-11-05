import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import { ApifyError, type FetchLike, type RunCostReading } from './apify.js';
import { createFakeInstagramScanner } from './fake-scanner.js';
import {
  COST_GIVE_UP_MS,
  COST_SETTLE_AFTER_MS,
  type RunCostReader,
  settleScanCosts,
} from './scan-costs.js';
import { createInstagramScanQueue } from './scan-queue.js';
import { createInstagramScanner } from './scanner.js';

// The scan's cost check (C90) over a real (in-memory) database. Apify is a fake everywhere: a
// reader answered from a script for the check itself, and a stateful fake `fetch` (its run objects
// tally their charges a while after the run ends, as Apify's do) for the scan that writes the early
// cost and the check that corrects it. Nothing here reaches the network or needs a key.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLIENT = 'c-falcon';
const HANDLE = 'falcon.fpv';

/** The numbers of the first two live scans (30 Oct, v0.63.16): what they stored and what Apify says. */
const LIVE = {
  falcon: { stored: 0.001, runs: { WyEPcvSheL00CIhy5: 0.0026, '1QpsgCch2e0zmSMqQ': 0.0322 } },
  hillside: { stored: 0.001, runs: { NndRNTgmdB68pfADq: 0.0026, UosBChF4U98hfDmdH: 0.0244 } },
};

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  instagram.upsertAccount({ clientId: CLIENT, client: 'Falcon FPV', handle: HANDLE });
  return { clock, db, instagram };
}

/** A scan that ended `ago` milliseconds before the clock's now, with the cost it wrote early. */
function endedScan(
  { clock, instagram }: ReturnType<typeof setup>,
  costUsd: number,
  apifyRunIds: string[],
  ago = HOUR,
  outcome: 'ok' | 'failed' = 'ok',
) {
  const now = clock().getTime();
  const started = instagram.startScan({
    clientId: CLIENT,
    handle: HANDLE,
    startedAt: now - ago - MINUTE,
  });
  return instagram.finishScan(started.id, {
    outcome,
    costUsd,
    apifyRunIds,
    finishedAt: now - ago,
  });
}

type Answer = Partial<RunCostReading> | Error;

/** A reader answered from a script: the answer of each run, or an error to throw; every read is recorded. */
function scriptedReader(script: Record<string, Answer | Answer[]>) {
  const reads: string[] = [];
  const reader: RunCostReader = async (runId) => {
    reads.push(runId);
    const entry = script[runId];
    if (entry === undefined) throw new ApifyError('failed', 'Apify answered 404', { status: 404 });
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no answer');
    return { status: 'SUCCEEDED', finished: true, costUsd: null, ...answer };
  };
  return { reader, reads };
}

const rounded = (usd: number) => Math.round(usd * 1e6) / 1e6;

describe('settleScanCosts', () => {
  it('writes what the runs cost once Apify has tallied it: a run whose cost arrives late', async () => {
    const t = setup();
    // The scan wrote the early number; Apify's run answers 0.001 first (the start event) and the
    // real total later.
    const scan = endedScan(t, 0.001, ['profile', 'reels']);
    const { reader, reads } = scriptedReader({
      profile: { costUsd: 0.0026 },
      reels: [{ costUsd: 0.0322 }],
    });

    const result = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(result).toEqual({ settled: 1, changed: 1, waiting: 0 });
    expect(reads).toEqual(['profile', 'reels']);
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0348);
    // The Money page reads the same number.
    expect(t.instagram.listScanCosts().map((row) => row.costUsd)).toEqual([0.0348]);
  });

  it('reads a scan once: a settled scan is not read again', async () => {
    const t = setup();
    endedScan(t, 0.001, ['profile', 'reels']);
    const { reader, reads } = scriptedReader({
      profile: { costUsd: 0.0026 },
      reels: { costUsd: 0.0322 },
    });

    await settleScanCosts({ instagram: t.instagram, readRunCost: reader, clock: t.clock });
    reads.length = 0;
    const again = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(again).toEqual({ settled: 0, changed: 0, waiting: 0 });
    expect(reads).toEqual([]);
  });

  it('leaves a scan that ended a moment ago to a later pass', async () => {
    const t = setup();
    const scan = endedScan(t, 0.001, ['profile'], COST_SETTLE_AFTER_MS - 1);
    const { reader, reads } = scriptedReader({ profile: { costUsd: 0.0026 } });

    const early = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });
    expect(early).toEqual({ settled: 0, changed: 0, waiting: 0 });
    expect(reads).toEqual([]);
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.001);

    t.clock.tick(2);
    const later = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });
    expect(later.changed).toBe(1);
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0026);
  });

  it('keeps the number it has for a run whose cost never arrives, and still settles the scan', async () => {
    const t = setup();
    const scan = endedScan(t, 0.0123, ['profile', 'reels']);
    // Both runs are over and Apify says no number for either.
    const { reader } = scriptedReader({ profile: { costUsd: null }, reels: { costUsd: null } });

    const result = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(result).toEqual({ settled: 1, changed: 0, waiting: 0 });
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0123);
    expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('keeps the stored number for a run Apify no longer has, and raises it by the runs it can read', async () => {
    const t = setup();
    const scan = endedScan(t, 0.001, ['profile', 'gone']);
    // The profile run answers; the other is a 404 (the default of an unscripted run).
    const { reader } = scriptedReader({ profile: { costUsd: 0.0026 } });

    const result = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(result).toEqual({ settled: 1, changed: 1, waiting: 0 });
    // Never below what is stored, and never guessing the run that cannot be read.
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0026);
  });

  it('never lowers a cost: a reading under what is stored changes nothing', async () => {
    const t = setup();
    const scan = endedScan(t, 0.05, ['profile']);
    const { reader } = scriptedReader({ profile: { costUsd: 0.0026 } });

    const result = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(result).toEqual({ settled: 1, changed: 0, waiting: 0 });
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.05);
  });

  it('settles a scan that started no run without asking Apify', async () => {
    const t = setup();
    const scan = endedScan(t, 0, [], HOUR, 'failed');
    const { reader, reads } = scriptedReader({});

    const result = await settleScanCosts({
      instagram: t.instagram,
      readRunCost: reader,
      clock: t.clock,
    });

    expect(result).toEqual({ settled: 1, changed: 0, waiting: 0 });
    expect(reads).toEqual([]);
    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0);
  });

  it('counts a failed scan too: Apify billed the run that started', async () => {
    const t = setup();
    const scan = endedScan(t, 0.001, ['reels'], HOUR, 'failed');
    const { reader } = scriptedReader({ reels: { costUsd: 0.0105 } });

    await settleScanCosts({ instagram: t.instagram, readRunCost: reader, clock: t.clock });

    expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0105);
  });

  describe('when Apify cannot be reached', () => {
    it('keeps the cost, settles nothing, and stops at the first scan: the rest would fail the same', async () => {
      const t = setup();
      const first = endedScan(t, 0.001, ['a'], 2 * HOUR);
      const second = endedScan(t, 0.001, ['b'], HOUR);
      const { reader, reads } = scriptedReader({
        a: new ApifyError('failed', 'Apify could not be reached: fetch failed (ENOTFOUND)'),
        b: { costUsd: 0.03 },
      });

      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
      });

      expect(result).toEqual({ settled: 0, changed: 0, waiting: 2 });
      expect(reads).toEqual(['a']);
      expect(t.instagram.getScan(first.id)?.costUsd).toBe(0.001);
      expect(t.instagram.getScan(second.id)?.costUsd).toBe(0.001);
      expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toHaveLength(2);
    });

    it('settles them at a later pass, once Apify answers', async () => {
      const t = setup();
      const scan = endedScan(t, 0.001, ['a']);
      const down = scriptedReader({
        a: new ApifyError('timeout', 'The Apify run took longer than 30 s'),
      });
      await settleScanCosts({ instagram: t.instagram, readRunCost: down.reader, clock: t.clock });

      t.clock.tick(15 * MINUTE);
      const up = scriptedReader({ a: { costUsd: 0.0322 } });
      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: up.reader,
        clock: t.clock,
      });

      expect(result).toEqual({ settled: 1, changed: 1, waiting: 0 });
      expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0322);
    });

    it('waits on an Apify error (5xx, 429, a run still going) and does not stop the pass', async () => {
      const t = setup();
      const broken = endedScan(t, 0.001, ['broken'], 3 * HOUR);
      const busy = endedScan(t, 0.001, ['busy'], 2 * HOUR);
      const limited = endedScan(t, 0.001, ['limited'], 90 * MINUTE);
      const fine = endedScan(t, 0.001, ['fine'], HOUR);
      const { reader, reads } = scriptedReader({
        broken: new ApifyError('failed', 'Apify answered 502', { status: 502 }),
        busy: { status: 'RUNNING', finished: false, costUsd: 0.001 },
        limited: new ApifyError('failed', 'Apify answered 429', { status: 429 }),
        fine: { costUsd: 0.02 },
      });

      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
      });

      expect(reads).toEqual(['broken', 'busy', 'limited', 'fine']);
      expect(result).toEqual({ settled: 1, changed: 1, waiting: 3 });
      expect(t.instagram.getScan(fine.id)?.costUsd).toBe(0.02);
      for (const scan of [broken, busy, limited]) {
        expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.001);
      }
      expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER).map((scan) => scan.id)).toEqual([
        broken.id,
        busy.id,
        limited.id,
      ]);
    });

    it('gives up on a scan whose runs cannot be read after a week, and keeps its cost', async () => {
      const t = setup();
      const scan = endedScan(t, 0.0123, ['a'], COST_GIVE_UP_MS + MINUTE);
      const { reader } = scriptedReader({
        a: new ApifyError('failed', 'Apify answered 500', { status: 500 }),
      });

      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
      });

      expect(result).toEqual({ settled: 1, changed: 0, waiting: 0 });
      expect(t.instagram.getScan(scan.id)?.costUsd).toBe(0.0123);
      expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it('ends the pass when there is no key, and the scans wait', async () => {
      const t = setup();
      endedScan(t, 0.001, ['a'], 2 * HOUR);
      endedScan(t, 0.001, ['b'], HOUR);
      const { reader, reads } = scriptedReader({
        a: new ApifyError('no-token', 'There is no Apify key: add APIFY_TOKEN to .env'),
      });

      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
      });

      expect(result).toEqual({ settled: 0, changed: 0, waiting: 2 });
      expect(reads).toEqual(['a']);
    });

    it('stops when its signal aborts, keeping what it checked', async () => {
      const t = setup();
      const first = endedScan(t, 0.001, ['a'], 2 * HOUR);
      const second = endedScan(t, 0.001, ['b'], HOUR);
      const controller = new AbortController();
      const reader: RunCostReader = async (runId) => {
        if (runId === 'a') {
          controller.abort();
          return { status: 'SUCCEEDED', finished: true, costUsd: 0.04 };
        }
        throw new Error('a stopped pass reads nothing more');
      };

      await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
        signal: controller.signal,
      });

      expect(t.instagram.getScan(first.id)?.costUsd).toBe(0.04);
      expect(t.instagram.getScan(second.id)?.costUsd).toBe(0.001);
      expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER).map((scan) => scan.id)).toEqual([
        second.id,
      ]);
    });
  });

  describe('a scan stored before the check existed', () => {
    it('is corrected by the first pass: the two live scans', async () => {
      const t = setup();
      // Ids 1 and 2 of the live database: cost 0.001, finished a day ago, never checked (the new
      // column is null for rows that were there before the migration).
      const falcon = endedScan(t, LIVE.falcon.stored, Object.keys(LIVE.falcon.runs), 26 * HOUR);
      const hillside = endedScan(
        t,
        LIVE.hillside.stored,
        Object.keys(LIVE.hillside.runs),
        25 * HOUR,
      );
      expect([falcon.id, hillside.id]).toEqual([1, 2]);
      expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toHaveLength(2);
      const { reader, reads } = scriptedReader({
        ...Object.fromEntries(
          Object.entries(LIVE.falcon.runs).map(([id, usd]) => [id, { costUsd: usd }]),
        ),
        ...Object.fromEntries(
          Object.entries(LIVE.hillside.runs).map(([id, usd]) => [id, { costUsd: usd }]),
        ),
      });

      const result = await settleScanCosts({
        instagram: t.instagram,
        readRunCost: reader,
        clock: t.clock,
      });

      expect(result).toEqual({ settled: 2, changed: 2, waiting: 0 });
      expect(reads).toEqual([
        'WyEPcvSheL00CIhy5',
        '1QpsgCch2e0zmSMqQ',
        'NndRNTgmdB68pfADq',
        'UosBChF4U98hfDmdH',
      ]);
      expect(t.instagram.getScan(1)?.costUsd).toBe(rounded(0.0026 + 0.0322));
      expect(t.instagram.getScan(1)?.costUsd).toBe(0.0348);
      expect(t.instagram.getScan(2)?.costUsd).toBe(0.027);
      // What the Money page sums for them: 0.0348 + 0.027 where it showed 0.002.
      expect(t.instagram.listScanCosts().map((row) => row.costUsd)).toEqual([0.0348, 0.027]);
    });
  });
});

// --- a scan and its check, through the real client against a fake Apify that tallies late -----------

describe('a scan whose cost Apify tallies late', () => {
  const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
  const fixture = (name: string): unknown[] =>
    JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), 'utf8')) as unknown[];
  const TOKEN = 'apify_api_TESTKEY0123456789';

  /**
   * A tiny Apify. Each run's `usageTotalUsd` is `early` for the first `earlyReads` reads of it (the
   * ones a scan makes while it waits for the run) and `final` after that: the charges are tallied.
   * Every request is recorded.
   */
  class LateApify {
    readonly calls: string[] = [];
    /** Reads of a run object so far. */
    private readonly reads = new Map<string, number>();
    down = false;
    runs: Record<string, { early: number; final: number | undefined; earlyReads: number }> = {
      p1: { early: 0.001, final: 0.0026, earlyReads: 1 },
      r1: { early: 0.001, final: 0.0322, earlyReads: 1 },
    };

    readonly fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const route = `${method} ${url.host}${url.pathname}`;
      this.calls.push(route);
      if (url.host.endsWith('cdninstagram.com')) {
        return new Response('JPEG', { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (this.down && route.startsWith('GET api.apify.com/v2/actor-runs/')) {
        throw new TypeError('fetch failed');
      }
      const run = (id: string, dataset: string) => {
        const spec = this.runs[id];
        const count = (this.reads.get(id) ?? 0) + 1;
        this.reads.set(id, count);
        const usage = count <= (spec?.earlyReads ?? 1) ? spec?.early : spec?.final;
        return json({
          data: {
            id,
            status: 'SUCCEEDED',
            defaultDatasetId: dataset,
            ...(usage === undefined ? {} : { usageTotalUsd: usage }),
          },
        });
      };
      switch (route) {
        case 'POST api.apify.com/v2/acts/apify~instagram-profile-scraper/runs':
          return json({ data: { id: 'p1', status: 'READY', defaultDatasetId: 'dp' } }, 201);
        case 'POST api.apify.com/v2/acts/apify~instagram-reel-scraper/runs':
          return json({ data: { id: 'r1', status: 'READY', defaultDatasetId: 'dr' } }, 201);
        case 'GET api.apify.com/v2/actor-runs/p1':
          return run('p1', 'dp');
        case 'GET api.apify.com/v2/actor-runs/r1':
          return run('r1', 'dr');
        case 'GET api.apify.com/v2/datasets/dp/items':
          return json(fixture('profile'));
        case 'GET api.apify.com/v2/datasets/dr/items':
          return json(fixture('reels'));
        default:
          throw new Error(`no answer for ${route}`);
      }
    };
  }

  function scannerSetup() {
    const t = setup();
    const apify = new LateApify();
    const scanner = createInstagramScanner({
      instagram: t.instagram,
      dataDir: makeTempDir('studio-instagram-costs-'),
      clock: t.clock,
      fetch: apify.fetch,
      token: TOKEN,
      pollGapMs: 0,
    });
    return { ...t, apify, scanner };
  }

  it('writes the early cost with the scan, and the real one when the check runs later', async () => {
    const t = scannerSetup();

    const result = await t.scanner.scan(CLIENT, HANDLE);

    // What the scan read as the runs ended: the profile's 0.001 and the reels' 0.001, not the charges.
    expect(result.outcome).toBe('ok');
    expect(result.scan.costUsd).toBe(0.002);
    expect(result.scan.apifyRunIds).toEqual(['p1', 'r1']);
    expect(t.instagram.listScanCosts().map((row) => row.costUsd)).toEqual([0.002]);

    // Too soon: nothing is read and nothing changes.
    const callsBefore = t.apify.calls.length;
    expect(await t.scanner.settleCosts?.()).toBe(0);
    expect(t.apify.calls).toHaveLength(callsBefore);

    // Minutes later Apify has tallied the runs.
    t.clock.tick(COST_SETTLE_AFTER_MS + MINUTE);
    expect(await t.scanner.settleCosts?.()).toBe(1);
    expect(t.instagram.getScan(result.scan.id)?.costUsd).toBe(0.0348);
    expect(t.instagram.listScanCosts().map((row) => row.costUsd)).toEqual([0.0348]);
    expect(t.apify.calls.slice(callsBefore)).toEqual([
      'GET api.apify.com/v2/actor-runs/p1',
      'GET api.apify.com/v2/actor-runs/r1',
    ]);

    // Once is enough.
    const callsAfter = t.apify.calls.length;
    expect(await t.scanner.settleCosts?.()).toBe(0);
    expect(t.apify.calls).toHaveLength(callsAfter);
  });

  it('ends the scan ok and keeps its cost when Apify never says what a run cost', async () => {
    const t = scannerSetup();
    // The runs never get a `usageTotalUsd`, neither as they end nor later.
    t.apify.runs = {
      p1: { early: 0, final: undefined, earlyReads: 0 },
      r1: { early: 0, final: undefined, earlyReads: 0 },
    };

    const result = await t.scanner.scan(CLIENT, HANDLE);
    expect(result.outcome).toBe('ok');
    expect(result.scan.costUsd).toBe(0);

    t.clock.tick(HOUR);
    expect(await t.scanner.settleCosts?.()).toBe(0);
    expect(t.instagram.getScan(result.scan.id)).toMatchObject({ outcome: 'ok', costUsd: 0 });
    expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('resolves and changes nothing when Apify cannot be reached, then corrects the scan when it can', async () => {
    const t = scannerSetup();
    const result = await t.scanner.scan(CLIENT, HANDLE);
    t.clock.tick(HOUR);

    t.apify.down = true;
    await expect(t.scanner.settleCosts?.()).resolves.toBe(0);
    expect(t.instagram.getScan(result.scan.id)).toMatchObject({ outcome: 'ok', costUsd: 0.002 });

    t.apify.down = false;
    await expect(t.scanner.settleCosts?.()).resolves.toBe(1);
    expect(t.instagram.getScan(result.scan.id)?.costUsd).toBe(0.0348);
  });

  it('resolves and changes nothing without an Apify key', async () => {
    const t = setup();
    const { instagram, clock } = t;
    const noKey = createInstagramScanner({
      instagram,
      dataDir: makeTempDir('studio-instagram-costs-'),
      clock,
      env: {},
      envFile: join(makeTempDir('studio-instagram-nokey-'), 'no.env'),
    });
    const scan = endedScan(t, 0.001, ['p1', 'r1']);

    await expect(noKey.settleCosts?.()).resolves.toBe(0);
    expect(instagram.getScan(scan.id)?.costUsd).toBe(0.001);
  });
});

// --- the engine's boot: the queue corrects the scans stored before the check existed -----------------

describe('the scan queue', () => {
  it('corrects the two live scans at start, with no hand edit, and tells the web the money changed', async () => {
    const t = setup();
    endedScan(t, LIVE.falcon.stored, Object.keys(LIVE.falcon.runs), 26 * HOUR);
    endedScan(t, LIVE.hillside.stored, Object.keys(LIVE.hillside.runs), 25 * HOUR);
    const usage: Record<string, number> = { ...LIVE.falcon.runs, ...LIVE.hillside.runs };
    const asked: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = new URL(input);
      const id = url.pathname.replace('/v2/actor-runs/', '');
      asked.push(`${url.host}${url.pathname}`);
      const costUsd = usage[id];
      if (url.pathname.startsWith('/v2/actor-runs/') && costUsd !== undefined) {
        return new Response(
          JSON.stringify({ data: { id, status: 'SUCCEEDED', usageTotalUsd: costUsd } }),
        );
      }
      throw new Error(`no answer for ${url.pathname}`);
    };
    const events: ServerEvent[] = [];
    const queue = createInstagramScanQueue({
      scanner: createInstagramScanner({
        instagram: t.instagram,
        dataDir: makeTempDir('studio-instagram-costs-'),
        clock: t.clock,
        fetch,
        token: 'apify_api_TESTKEY0123456789',
        pollGapMs: 0,
      }),
      instagram: t.instagram,
      activeClients: () => null,
      // The account's folder is gone in this test: nothing is queued to scan, only the cost check runs.
      clientExists: () => false,
      publish: (event) => events.push(event),
      clock: t.clock,
      timeZone: 'Asia/Jerusalem',
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    });

    queue.start();
    await queue.settleCosts();
    await queue.stop();

    expect(t.instagram.getScan(1)?.costUsd).toBe(0.0348);
    expect(t.instagram.getScan(2)?.costUsd).toBe(0.027);
    expect(asked).toEqual([
      'api.apify.com/v2/actor-runs/WyEPcvSheL00CIhy5',
      'api.apify.com/v2/actor-runs/1QpsgCch2e0zmSMqQ',
      'api.apify.com/v2/actor-runs/NndRNTgmdB68pfADq',
      'api.apify.com/v2/actor-runs/UosBChF4U98hfDmdH',
    ]);
    expect(events.filter((event) => event.type === 'money.changed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'client-instagram')).toEqual([]);
  });

  it('does not break when Apify cannot be reached: the scans keep their cost and wait for the next check', async () => {
    const t = setup();
    endedScan(t, 0.001, ['a', 'b'], 26 * HOUR);
    const events: ServerEvent[] = [];
    const errors: unknown[] = [];
    const queue = createInstagramScanQueue({
      scanner: createInstagramScanner({
        instagram: t.instagram,
        dataDir: makeTempDir('studio-instagram-costs-'),
        clock: t.clock,
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
        token: 'apify_api_TESTKEY0123456789',
        pollGapMs: 0,
      }),
      instagram: t.instagram,
      activeClients: () => null,
      clientExists: () => false,
      publish: (event) => events.push(event),
      clock: t.clock,
      timeZone: 'Asia/Jerusalem',
      timers: { setInterval: () => 1, clearInterval: () => undefined },
      logger: { info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
    });

    queue.start();
    await queue.settleCosts();
    await queue.stop();

    expect(t.instagram.getScan(1)?.costUsd).toBe(0.001);
    expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('the fake scanner', () => {
  it('settles against its own made-up runs and never reaches Apify', async () => {
    const t = setup();
    t.instagram.upsertAccount({ clientId: CLIENT, client: 'Falcon FPV', handle: 'natgeo' });
    const scanner = createFakeInstagramScanner({
      instagram: t.instagram,
      dataDir: makeTempDir('studio-instagram-costs-'),
      clock: t.clock,
    });

    const result = await scanner.scan(CLIENT, 'natgeo');
    expect(result.scan.apifyRunIds).toEqual(['fake-run-1', 'fake-run-2']);
    expect(result.scan.costUsd).toBeGreaterThan(0);
    t.clock.tick(HOUR);

    // The runs are known to it and cost what they cost: nothing to correct, but the scan is checked.
    expect(await scanner.settleCosts?.()).toBe(0);
    expect(t.instagram.getScan(result.scan.id)?.costUsd).toBe(result.scan.costUsd);
    expect(t.instagram.scansToSettle(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('keeps the cost of a scan from before a restart, whose runs it does not know', async () => {
    const t = setup();
    const scanner = createFakeInstagramScanner({
      instagram: t.instagram,
      dataDir: makeTempDir('studio-instagram-costs-'),
      clock: t.clock,
    });
    const old = endedScan(t, 0.0123, ['fake-run-1', 'fake-run-2']);

    expect(await scanner.settleCosts?.()).toBe(0);
    expect(t.instagram.getScan(old.id)?.costUsd).toBe(0.0123);
  });
});
