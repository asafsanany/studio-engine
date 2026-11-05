import type { ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository, type InstagramScan } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import { createFakeInstagramScanner, loadFakeInstagramFixtures } from './fake-scanner.js';
import {
  createInstagramScanQueue,
  type InstagramScanQueue,
  type InstagramScanQueueOptions,
  SCAN_CHECK_MS,
  type ScanTimers,
} from './scan-queue.js';
import {
  type InstagramScanner,
  type InstagramScanOptions,
  type InstagramScanResult,
  SCAN_MESSAGES,
} from './scanner.js';

// The queue over a real (in-memory) database, with the fake scanner for what a scan writes and a
// hand-made scanner that waits to be told for what order and how many at a time. Time is the fake
// clock (the scanner writes its scan rows with it too) and the check's timer is fired by hand.

const JERUSALEM = 'Asia/Jerusalem';
const at = (iso: string) => Date.parse(iso);

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

/** Lets every promise that can settle without a timer do so, and the zero-delay timers after them. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The interval timers of the check, fired by hand. */
function fakeTimers() {
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: ScanTimers = {
    setInterval(callback, ms) {
      const id = next++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  return {
    timers,
    intervals,
    /** One tick of every interval that is set. */
    fire: () => {
      for (const { callback } of [...intervals.values()]) callback();
    },
  };
}

function scanRow(clientId: string, handle: string): InstagramScan {
  return {
    id: 1,
    clientId,
    handle,
    startedAt: 0,
    finishedAt: 0,
    outcome: 'ok',
    error: null,
    followers: null,
    following: null,
    posts: null,
    reelsRead: 0,
    costUsd: 0,
    apifyRunIds: [],
  };
}

/** A scanner that starts a scan when asked and ends it when the test says so (or its signal aborts). */
class GateScanner implements InstagramScanner {
  /** The clients, in the order their scans started. */
  readonly started: { clientId: string; handle: string }[] = [];
  /** How many scans run at the same moment, now and at the most. */
  active = 0;
  maxActive = 0;
  private readonly gates = new Map<string, (result: Partial<InstagramScanResult>) => void>();
  private readonly running = new Set<string>();

  scan(
    clientId: string,
    handle: string,
    options: InstagramScanOptions = {},
  ): Promise<InstagramScanResult> {
    this.started.push({ clientId, handle });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.running.add(clientId);
    return new Promise((resolve) => {
      const end = (patch: Partial<InstagramScanResult>) => {
        if (!this.gates.has(clientId)) return;
        this.gates.delete(clientId);
        this.running.delete(clientId);
        this.active -= 1;
        resolve({
          scan: scanRow(clientId, handle),
          outcome: 'ok',
          error: null,
          cancelled: false,
          photoSaved: false,
          ...patch,
        });
      };
      this.gates.set(clientId, end);
      options.signal?.addEventListener('abort', () =>
        end({ outcome: 'failed', error: SCAN_MESSAGES.stopped, cancelled: true }),
      );
    });
  }

  isScanning(clientId: string): boolean {
    return this.running.has(clientId);
  }

  /** How many times the cost check (C90) was asked for, and what it does: a test swaps `settle`. */
  settleCalls = 0;
  settle: (options: { signal?: AbortSignal }) => Promise<number> = async () => 0;

  settleCosts(options: { signal?: AbortSignal } = {}): Promise<number> {
    this.settleCalls += 1;
    return this.settle(options);
  }

  /** Ends the client's scan. */
  finish(clientId: string, patch: Partial<InstagramScanResult> = {}): void {
    const gate = this.gates.get(clientId);
    if (gate === undefined) throw new Error(`${clientId} is not being scanned`);
    gate(patch);
  }

  names(): string[] {
    return this.started.map((entry) => entry.clientId);
  }
}

function setup(
  options: {
    now?: string;
    /** Use the fake scanner (writes real scan rows) rather than the gate. */
    fake?: boolean;
    delayMs?: number;
    active?: ReadonlySet<string> | null;
    exists?: (clientId: string) => boolean;
    checkMs?: number;
  } = {},
) {
  const clock = fakeClock(options.now ?? '2026-10-30T10:00:00.000Z');
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  const gate = new GateScanner();
  const dataDir = makeTempDir('studio-instagram-queue-');
  const natgeo = loadFakeInstagramFixtures().natgeo;
  if (natgeo === undefined) throw new Error('the natgeo fixture is missing');
  // Every client reads the real profile and no reels: reels are keyed by shortcode, not by client.
  const fixtures = Object.fromEntries(
    ['alpha', 'beta', 'gamma', 'delta'].map((handle) => [
      handle,
      { profile: natgeo.profile, reels: [] },
    ]),
  );
  const scanner: InstagramScanner = options.fake
    ? createFakeInstagramScanner({
        instagram,
        dataDir,
        clock,
        fixtures,
        delayMs: options.delayMs ?? 0,
      })
    : gate;
  const events: ServerEvent[] = [];
  const timing = fakeTimers();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const queueOptions: InstagramScanQueueOptions = {
    scanner,
    instagram,
    activeClients: () => (options.active === undefined ? null : options.active),
    clientExists: options.exists,
    publish: (event) => events.push(event),
    clock,
    timeZone: JERUSALEM,
    timers: timing.timers,
    checkMs: options.checkMs,
    logger,
  };
  const queue = createInstagramScanQueue(queueOptions);
  /** An account, added a minute after the one before it. */
  let added = 0;
  const add = (clientId: string, handle = clientId) => {
    clock.tick(60_000);
    added += 1;
    return instagram.upsertAccount({
      clientId,
      client: `Client ${clientId}`,
      handle,
      addedAt: clock().getTime() - 365 * 24 * 3_600_000 + added,
    });
  };
  return { clock, db, instagram, gate, scanner, events, timing, logger, queue, add, dataDir };
}

const instagramEvents = (events: ServerEvent[], clientId: string) =>
  events.filter((event) => event.type === 'client-instagram' && event.clientId === clientId);

describe('the weekly check', () => {
  it('runs at start and then every 15 minutes, and stops when the queue does', async () => {
    const { queue, timing } = setup();
    queue.start();
    expect(timing.intervals.size).toBe(1);
    expect([...timing.intervals.values()][0]?.ms).toBe(SCAN_CHECK_MS);
    expect(SCAN_CHECK_MS).toBe(15 * 60 * 1000);

    queue.start();
    expect(timing.intervals.size).toBe(1);

    await queue.stop();
    expect(timing.intervals.size).toBe(0);
  });

  it('queues every client that is due at start, the account added first first', async () => {
    const { queue, add, gate } = setup();
    add('c1', 'alpha');
    add('c2', 'beta');
    add('c3', 'gamma');

    queue.start();
    await flush();

    // One runs, the others wait in order.
    expect(gate.names()).toEqual(['c1']);
    expect(queue.waiting()).toEqual(['c2', 'c3']);
    for (const id of ['c1', 'c2', 'c3']) expect(queue.isBusy(id)).toBe(true);
  });

  it('runs one scan at a time, across clients', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    add('c3');

    queue.start();
    await flush();
    gate.finish('c1');
    await flush();
    expect(gate.names()).toEqual(['c1', 'c2']);
    gate.finish('c2');
    await flush();
    gate.finish('c3');
    await queue.whenIdle();

    expect(gate.names()).toEqual(['c1', 'c2', 'c3']);
    expect(gate.maxActive).toBe(1);
    expect(queue.isBusy('c1')).toBe(false);
  });

  it('hands the scanner the handle the account has when its turn comes', async () => {
    const { queue, add, gate, instagram } = setup();
    add('c1', 'alpha');
    add('c2', 'beta');
    queue.start();
    await flush();
    // The second client's handle is corrected while it waits.
    instagram.upsertAccount({ clientId: 'c2', client: 'Client c2', handle: 'beta2' });
    gate.finish('c1');
    await flush();

    expect(gate.started).toEqual([
      { clientId: 'c1', handle: 'alpha' },
      { clientId: 'c2', handle: 'beta2' },
    ]);
  });

  it('does not scan a client twice in a week, and scans it again the next Monday', async () => {
    const { queue, add, timing, clock, instagram } = setup({ fake: true });
    add('c1', 'alpha');

    queue.start();
    await queue.whenIdle();
    expect(instagram.recentScans('c1')).toHaveLength(1);

    clock.tick(15 * 60_000);
    timing.fire();
    await queue.whenIdle();
    expect(instagram.recentScans('c1')).toHaveLength(1);

    // Monday 2 Nov 06:00 in Jerusalem (UTC+2) is 04:00Z.
    clock.tick(at('2026-11-02T04:00:00Z') - clock().getTime());
    timing.fire();
    await queue.whenIdle();
    expect(instagram.recentScans('c1')).toHaveLength(2);
  });

  it('scans a client the Mac slept through at the next check, not before', async () => {
    const { queue, add, timing, clock, instagram } = setup({
      fake: true,
      // Sunday evening: last Monday's scans are done, this Monday's are not due yet.
      now: '2026-10-25T20:00:00.000Z',
    });
    add('c1', 'alpha');
    // Scanned on Monday 19 Oct, 06:05 in Jerusalem (UTC+3).
    const lastWeek = instagram.startScan({
      clientId: 'c1',
      handle: 'alpha',
      startedAt: at('2026-10-19T03:05:00Z'),
    });
    instagram.finishScan(lastWeek.id, { outcome: 'ok' });

    queue.start();
    await queue.whenIdle();
    expect(instagram.recentScans('c1')).toHaveLength(1);

    // The Mac sleeps through Monday and wakes on Wednesday at 10:15: the next check scans.
    clock.tick(at('2026-10-28T07:15:00Z') - clock().getTime());
    timing.fire();
    await queue.whenIdle();
    const scans = instagram.recentScans('c1');
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({ outcome: 'ok', startedAt: at('2026-10-28T07:15:00Z') });
  });

  describe('across the end of daylight saving in Asia/Jerusalem (Monday 26 Oct 2026)', () => {
    it('scans at 06:00 on the new clock (04:00Z), not at 06:00 on the old one (03:00Z)', async () => {
      const { queue, add, timing, clock, instagram } = setup({
        fake: true,
        now: '2026-10-26T02:00:00.000Z',
      });
      add('c1', 'alpha');
      const last = instagram.startScan({
        clientId: 'c1',
        handle: 'alpha',
        startedAt: at('2026-10-19T03:05:00Z'),
      });
      instagram.finishScan(last.id, { outcome: 'ok' });

      queue.start();
      await queue.whenIdle();
      expect(instagram.recentScans('c1')).toHaveLength(1);

      // 05:30 in Jerusalem now: still last week's week.
      clock.tick(at('2026-10-26T03:30:00Z') - clock().getTime());
      timing.fire();
      await queue.whenIdle();
      expect(instagram.recentScans('c1')).toHaveLength(1);

      // 06:00.
      clock.tick(at('2026-10-26T04:00:00Z') - clock().getTime());
      timing.fire();
      await queue.whenIdle();
      expect(instagram.recentScans('c1')).toHaveLength(2);
    });
  });

  describe('Which clients', () => {
    it('skips a client that is not active under Active, and scans every client under All', async () => {
      const active = setup({ active: new Set(['busy']) });
      active.add('busy');
      active.add('quiet');
      // A client that is in no job's list, and whose account is old.
      active.queue.start();
      await flush();
      expect(active.gate.names()).toEqual(['busy']);
      active.gate.finish('busy');
      await active.queue.whenIdle();
      expect(active.gate.names()).toEqual(['busy']);

      const all = setup({ active: null });
      all.add('busy');
      all.add('quiet');
      all.queue.start();
      await flush();
      all.gate.finish('busy');
      await flush();
      all.gate.finish('quiet');
      await all.queue.whenIdle();
      expect(all.gate.names()).toEqual(['busy', 'quiet']);
    });

    it('still scans an account added in the last 60 days when its client is not active', async () => {
      const { queue, instagram, gate, clock } = setup({ active: new Set() });
      instagram.upsertAccount({
        clientId: 'fresh',
        client: 'Fresh',
        handle: 'alpha',
        addedAt: clock().getTime() - 3 * 86_400_000,
      });
      queue.start();
      await flush();
      expect(gate.names()).toEqual(['fresh']);
    });
  });

  it('leaves alone an account whose client is gone', async () => {
    const { queue, add, gate } = setup({ exists: (clientId) => clientId !== 'gone' });
    add('gone');
    add('here');
    queue.start();
    await flush();
    expect(gate.names()).toEqual(['here']);
    expect(queue.isBusy('gone')).toBe(false);
  });

  it('does not queue a client that is waiting or running already when a check comes round', async () => {
    const { queue, add, gate, timing } = setup();
    add('c1');
    add('c2');
    queue.start();
    await flush();
    timing.fire();
    timing.fire();
    await flush();
    expect(gate.names()).toEqual(['c1']);
    expect(queue.waiting()).toEqual(['c2']);
  });

  it('keeps going when the check itself breaks', async () => {
    const { queue, instagram, logger, timing } = setup();
    vi.spyOn(instagram, 'listAccounts').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    queue.start();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(queue.waiting()).toEqual([]);
    // The next tick is a fresh try.
    timing.fire();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('Scan now and a saved account', () => {
  it('goes before the scheduled scans, behind the ones asked for urgently before it', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    add('c3');
    add('c4');
    queue.start();
    await flush();
    expect(gate.names()).toEqual(['c1']);
    expect(queue.waiting()).toEqual(['c2', 'c3', 'c4']);

    // c4 was waiting in the scheduled line: Scan now moves it up.
    expect(queue.enqueue('c4', { urgent: true })).toBe('moved');
    expect(queue.waiting()).toEqual(['c4', 'c2', 'c3']);
    // c3 as well: behind c4, which asked first.
    expect(queue.enqueue('c3', { urgent: true })).toBe('moved');
    expect(queue.waiting()).toEqual(['c4', 'c3', 'c2']);

    gate.finish('c1');
    await flush();
    gate.finish('c4');
    await flush();
    gate.finish('c3');
    await flush();
    gate.finish('c2');
    await queue.whenIdle();
    expect(gate.names()).toEqual(['c1', 'c4', 'c3', 'c2']);
  });

  it('queues a client that was not waiting at the front of the scheduled ones', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    queue.start();
    await flush();
    add('c5');
    expect(queue.enqueue('c5', { urgent: true })).toBe('queued');
    expect(queue.waiting()).toEqual(['c5', 'c2']);
    gate.finish('c1');
    await flush();
    expect(gate.names()).toEqual(['c1', 'c5']);
  });

  it('gives one place per client', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    queue.start();
    await flush();

    expect(queue.enqueue('c1')).toBe('running');
    expect(queue.enqueue('c1', { urgent: true })).toBe('running');
    expect(queue.enqueue('c2')).toBe('waiting');
    expect(queue.enqueue('c2', { urgent: true })).toBe('moved');
    expect(queue.enqueue('c2', { urgent: true })).toBe('waiting');
    expect(queue.waiting()).toEqual(['c2']);

    gate.finish('c1');
    await flush();
    gate.finish('c2');
    await queue.whenIdle();
    expect(gate.names()).toEqual(['c1', 'c2']);
  });

  it('starts a scan at once when nothing else runs', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    expect(queue.enqueue('c1', { urgent: true })).toBe('queued');
    await flush();
    expect(gate.names()).toEqual(['c1']);
    expect(queue.isRunning('c1')).toBe(true);
  });

  it('starts the next scan after one ends in any way, a failure included', async () => {
    const { queue, add, gate, logger } = setup();
    add('c1');
    add('c2');
    add('c3');
    queue.start();
    await flush();
    gate.finish('c1', { outcome: 'no-credit', error: 'Apify refuses the run' });
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', outcome: 'no-credit' }),
      expect.any(String),
    );
    expect(gate.names()).toEqual(['c1', 'c2']);

    gate.finish('c2');
    await flush();
    expect(gate.names()).toEqual(['c1', 'c2', 'c3']);
  });

  it('survives a scanner that throws', async () => {
    const { instagram, events, clock } = setup();
    instagram.upsertAccount({ clientId: 'c1', client: 'C1', handle: 'alpha' });
    instagram.upsertAccount({ clientId: 'c2', client: 'C2', handle: 'beta' });
    let calls = 0;
    const scanner: InstagramScanner = {
      scan: async () => {
        calls += 1;
        throw new Error('database is locked');
      },
      isScanning: () => false,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const queue = createInstagramScanQueue({
      scanner,
      instagram,
      activeClients: () => null,
      publish: (event) => events.push(event),
      clock,
      timeZone: JERUSALEM,
      timers: fakeTimers().timers,
      logger,
    });

    queue.enqueue('c1');
    queue.enqueue('c2');
    await queue.whenIdle();

    expect(calls).toBe(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(queue.isBusy('c1')).toBe(false);
  });
});

describe('what the scan of one account says', () => {
  it('tells the page when a client is queued, when its scan starts and when it ends', async () => {
    const { queue, add, gate, events } = setup();
    add('c1');
    add('c2');
    queue.enqueue('c1');
    queue.enqueue('c2');
    // Queued: both, once.
    expect(instagramEvents(events, 'c1')).toHaveLength(1);
    expect(instagramEvents(events, 'c2')).toHaveLength(1);

    await flush();
    // c1 started.
    expect(instagramEvents(events, 'c1')).toHaveLength(2);
    expect(instagramEvents(events, 'c2')).toHaveLength(1);

    gate.finish('c1');
    await flush();
    // c1 ended, c2 started.
    expect(instagramEvents(events, 'c1')).toHaveLength(3);
    expect(instagramEvents(events, 'c2')).toHaveLength(2);
    expect(queue.isBusy('c1')).toBe(false);
    expect(events.every((event) => event.type === 'client-instagram')).toBe(true);
  });

  it('says it is no longer busy by the time the end is told', async () => {
    const { instagram, clock, gate } = setup();
    instagram.upsertAccount({ clientId: 'c1', client: 'C1', handle: 'alpha' });
    const busyWhenTold: boolean[] = [];
    const queue: InstagramScanQueue = createInstagramScanQueue({
      scanner: gate,
      instagram,
      activeClients: () => null,
      publish: () => busyWhenTold.push(queue.isBusy('c1')),
      clock,
      timeZone: JERUSALEM,
      timers: fakeTimers().timers,
    });
    queue.enqueue('c1');
    await flush();
    gate.finish('c1');
    await queue.whenIdle();
    // Queued, started, ended: the last one is told when the page can read "not scanning".
    expect(busyWhenTold).toEqual([true, true, false]);
  });

  it('never runs an account that was removed while it waited, and says so', async () => {
    const { queue, add, gate, instagram, events } = setup();
    add('c1');
    add('c2');
    queue.enqueue('c1');
    queue.enqueue('c2');
    await flush();
    instagram.removeAccount('c2');
    const before = instagramEvents(events, 'c2').length;
    gate.finish('c1');
    await queue.whenIdle();
    expect(gate.names()).toEqual(['c1']);
    expect(instagramEvents(events, 'c2').length).toBeGreaterThan(before);
    expect(queue.isBusy('c2')).toBe(false);
  });

  it('survives a listener that throws', async () => {
    const { instagram, clock, gate, logger } = setup();
    instagram.upsertAccount({ clientId: 'c1', client: 'C1', handle: 'alpha' });
    const queue = createInstagramScanQueue({
      scanner: gate,
      instagram,
      activeClients: () => null,
      publish: () => {
        throw new Error('socket closed');
      },
      clock,
      timeZone: JERUSALEM,
      timers: fakeTimers().timers,
      logger,
    });
    queue.enqueue('c1');
    await flush();
    gate.finish('c1');
    await queue.whenIdle();
    expect(gate.names()).toEqual(['c1']);
  });

  it('says when the next weekly scan is: Mon 2 Nov from Friday 30 Oct', () => {
    const { queue, clock } = setup();
    expect(queue.nextScanAt().toISOString()).toBe('2026-11-02T04:00:00.000Z');
    clock.tick(at('2026-11-02T04:00:00Z') - clock().getTime());
    expect(queue.nextScanAt().toISOString()).toBe('2026-11-09T04:00:00.000Z');
  });
});

describe('restart and drop', () => {
  it('restart stops the scan that runs and scans again in front of the others', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    add('c3');
    queue.start();
    await flush();
    expect(gate.names()).toEqual(['c1']);

    queue.restart('c1');
    await flush();
    // The first scan ended as stopped, and the second one is c1's again, before c2 and c3.
    expect(gate.names()).toEqual(['c1', 'c1']);
    expect(queue.waiting()).toEqual(['c2', 'c3']);
    expect(gate.maxActive).toBe(1);
  });

  it('restart of a client that waits moves it to the front', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    add('c3');
    queue.start();
    await flush();
    queue.restart('c3');
    expect(queue.waiting()).toEqual(['c3', 'c2']);
    gate.finish('c1');
    await flush();
    expect(gate.names()).toEqual(['c1', 'c3']);
  });

  it('drop takes a waiting client out of the line and stops a running one', async () => {
    const { queue, add, gate } = setup();
    add('c1');
    add('c2');
    add('c3');
    queue.start();
    await flush();

    queue.drop('c2');
    expect(queue.waiting()).toEqual(['c3']);
    expect(queue.isBusy('c2')).toBe(false);

    queue.drop('c1');
    await flush();
    // c1's scan was stopped and c3's is next.
    expect(gate.names()).toEqual(['c1', 'c3']);
    expect(queue.isBusy('c1')).toBe(false);
  });
});

describe('stop', () => {
  it('stops the running scan cleanly, leaves the rest unscanned and resolves', async () => {
    const { queue, add, gate, timing } = setup();
    add('c1');
    add('c2');
    queue.start();
    await flush();

    await queue.stop();

    expect(gate.names()).toEqual(['c1']);
    expect(gate.active).toBe(0);
    expect(queue.isBusy('c1')).toBe(false);
    expect(queue.waiting()).toEqual([]);
    expect(timing.intervals.size).toBe(0);
    // Nothing starts after it, whatever asks.
    expect(queue.check()).toEqual([]);
    queue.enqueue('c2', { urgent: true });
    await flush();
    expect(gate.names()).toEqual(['c1']);
    await queue.stop();
  });

  it('writes the stopped scan as a failed one that does not count, so the next boot scans again', async () => {
    const first = setup({ fake: true, delayMs: 60_000 });
    first.add('c1', 'alpha');
    first.queue.start();
    await flush();
    expect(first.queue.isRunning('c1')).toBe(true);

    await first.queue.stop();

    const [stopped] = first.instagram.recentScans('c1');
    expect(stopped).toMatchObject({ outcome: 'failed', error: SCAN_MESSAGES.stopped });
    expect(first.instagram.latestOkScan('c1')).toBeNull();

    // The engine boots again: the same database, a new queue, the same week.
    const second = createInstagramScanQueue({
      scanner: createFakeInstagramScanner({
        instagram: first.instagram,
        dataDir: first.dataDir,
        clock: first.clock,
        fixtures: Object.fromEntries([
          ['alpha', { profile: loadFakeInstagramFixtures().natgeo?.profile ?? [], reels: [] }],
        ]),
      }),
      instagram: first.instagram,
      activeClients: () => null,
      publish: () => undefined,
      clock: first.clock,
      timeZone: JERUSALEM,
      timers: fakeTimers().timers,
    });
    second.start();
    await second.whenIdle();
    expect(first.instagram.recentScans('c1')).toHaveLength(2);
    expect(first.instagram.latestOkScan('c1')).not.toBeNull();
  });

  it('does not count a real failure as a stopped scan: a failing account waits for next Monday', async () => {
    const first = setup({ fake: true });
    first.add('c1', 'no_such_account_anywhere');
    first.queue.start();
    await first.queue.whenIdle();
    const [failed] = first.instagram.recentScans('c1');
    // The fake answers an account it has no fixture for with "not found".
    expect(failed).toMatchObject({ outcome: 'not-found' });

    first.clock.tick(15 * 60_000);
    first.timing.fire();
    await first.queue.whenIdle();
    expect(first.instagram.recentScans('c1')).toHaveLength(1);
  });
});

describe('settling the cost of the scans (C90)', () => {
  it('asks the scanner to settle at start and at every check', async () => {
    const { queue, gate, timing } = setup();

    queue.start();
    await flush();
    expect(gate.settleCalls).toBe(1);

    timing.fire();
    await flush();
    expect(gate.settleCalls).toBe(2);
    await queue.stop();
  });

  it('tells the web the money changed when a cost did, and says nothing when none did', async () => {
    const { queue, gate, events } = setup();
    const moneyEvents = () => events.filter((event) => event.type === 'money.changed');

    await queue.settleCosts();
    expect(moneyEvents()).toHaveLength(0);

    gate.settle = async () => 2;
    await queue.settleCosts();
    expect(moneyEvents()).toHaveLength(1);
  });

  it('runs one pass at a time: asked while one runs, it gives that one', async () => {
    const { queue, gate, timing } = setup();
    let release: (changed: number) => void = () => undefined;
    gate.settle = () => new Promise<number>((resolve) => (release = resolve));

    const first = queue.settleCosts();
    const second = queue.settleCosts();
    queue.start();
    timing.fire();
    await flush();
    expect(gate.settleCalls).toBe(1);

    release(0);
    await Promise.all([first, second]);
    gate.settle = async () => 0;
    await queue.settleCosts();
    expect(gate.settleCalls).toBe(2);
    await queue.stop();
  });

  it('logs a pass that fails and goes on checking: scans still queue and the next pass runs', async () => {
    const { queue, gate, logger, add, timing } = setup();
    add('c1');
    gate.settle = async () => {
      throw new Error('the database is locked');
    };

    queue.start();
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'could not settle the cost of the Instagram scans',
    );
    expect(gate.names()).toEqual(['c1']);

    gate.settle = async () => 0;
    timing.fire();
    await flush();
    expect(gate.settleCalls).toBe(2);
    await queue.stop();
  });

  it('never holds a scan: a pass that is still reading does not stop the scans', async () => {
    const { queue, gate, add } = setup();
    add('c1');
    add('c2');
    // A pass that reads until it is stopped.
    gate.settle = (options) =>
      new Promise<number>((resolve) => options.signal?.addEventListener('abort', () => resolve(0)));

    queue.start();
    await flush();
    expect(gate.names()).toEqual(['c1']);
    gate.finish('c1');
    await flush();
    expect(gate.names()).toEqual(['c1', 'c2']);
    await queue.stop();
  });

  it('stop aborts a pass that is reading and waits for it', async () => {
    const { queue, gate } = setup();
    let signal: AbortSignal | undefined;
    gate.settle = (options) =>
      new Promise<number>((resolve) => {
        signal = options.signal;
        options.signal?.addEventListener('abort', () => resolve(0));
      });

    queue.start();
    await flush();
    expect(signal?.aborted).toBe(false);

    await queue.stop();

    expect(signal?.aborted).toBe(true);
    // A queue that is stopped settles nothing more.
    await queue.settleCosts();
    expect(gate.settleCalls).toBe(1);
  });

  it('is skipped for a scanner that has nothing to settle', async () => {
    const { queue, gate } = setup();
    // A scanner without the method (an older stand-in): the checks go on without it.
    (gate as { settleCosts?: unknown }).settleCosts = undefined;

    queue.start();
    await flush();
    await queue.settleCosts();

    expect(gate.settleCalls).toBe(0);
    await queue.stop();
  });
});
