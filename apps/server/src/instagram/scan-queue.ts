// The queue that runs the Instagram scans (Clients × Instagram, IG4): its own small queue, never the
// edit queue, with its own worker. It decides when the scanner of ./scanner.ts is called, for whom,
// and in what order:
//
//   - one scan at a time, across all clients (Apify is paid per run, and the Mac is shared with the
//     edits, so a Monday with nine clients is nine scans one after another)
//   - one place per client: a client that is waiting is not queued a second time
//   - two lines: the urgent one (Scan now, a saved account: the person is waiting for it) goes
//     before the scheduled one (the weekly check), each in the order it was asked in
//   - a check at start and then every 15 minutes (timers injected, as the ETA ticker's are) queues
//     the clients that are due (./scan-schedule.ts), so a Mac that slept through Monday 06:00 scans
//     at the next wake, and a scan that was stopped in the middle is made again
//   - `stop()` aborts the scan that runs, leaves the rest waiting, and resolves when the worker is done
//   - every check also settles the cost of the scans that ended a few minutes ago (C90): a scan writes
//     the cost Apify reported as its runs ended, which is early, and the settle reads the runs again
//     (./scan-costs.ts). It runs beside the scans, never holds one, and a scan stored before it
//     existed is corrected by the first check after the update.
//
// `isBusy(clientId)` is true from the moment a client is queued until its scan is over: the page's
// "scanning" and what a rename or a delete of the client waits for.
//
// `client-instagram` is published when a client is queued, when its scan starts and when it ends,
// so a page shows the first scan (S2) and fills in.

import type { ServerEvent } from '@studio/shared';
import type { InstagramRepository } from '../db/instagram-repository.js';
import type { WatcherLogger } from '../inbox/watcher.js';
import { type EtaTimers, systemEtaTimers } from '../pipeline/eta.js';
import { dueClients, lastCountingScan, nextScanAt, systemTimeZone } from './scan-schedule.js';
import type { InstagramScanner } from './scanner.js';

/** The interval timers of the check; the same shape as the ETA ticker's. Replaced in tests. */
export type ScanTimers = EtaTimers;

/** How often the check for clients that are due runs: also how late a scan can be after a wake. */
export const SCAN_CHECK_MS = 15 * 60 * 1000;

export interface InstagramScanQueueOptions {
  scanner: InstagramScanner;
  instagram: Pick<InstagramRepository, 'getAccount' | 'listAccounts' | 'recentScans'>;
  /**
   * The clients that are active (a job added or delivered in the last 60 days), or `null` for
   * every client with an account (Which clients: All). Asked at every check.
   */
  activeClients: () => ReadonlySet<string> | null;
  /** Whether the client still exists: the account of a client whose folder is gone is not scanned. Default: it does. */
  clientExists?: (clientId: string) => boolean;
  /** Tells the web: `client-instagram`. */
  publish: (event: ServerEvent) => void;
  /** The clock. Default: the system's. */
  clock?: () => Date;
  /** The time zone Monday 06:00 is read in. Default: the Mac's. */
  timeZone?: string;
  timers?: ScanTimers;
  /** Milliseconds between two checks. Default {@link SCAN_CHECK_MS}. */
  checkMs?: number;
  logger?: Pick<WatcherLogger, 'info' | 'warn' | 'error'>;
}

/** What {@link InstagramScanQueue.enqueue} did. */
export type EnqueueResult =
  /** The client was not waiting: it is now. */
  | 'queued'
  /** The client was waiting in the scheduled line and was asked for urgently: it moved up. */
  | 'moved'
  /** The client was waiting already, as urgently as asked for. */
  | 'waiting'
  /** The client's scan is running now: nothing was queued. */
  | 'running';

export interface InstagramScanQueue {
  /**
   * Queues the client's scan. `urgent` (Scan now, a saved account) puts it in front of the
   * scheduled ones, behind the urgent ones asked before it, and moves a client that waits in the
   * scheduled line up. A client whose scan is running is not queued again.
   */
  enqueue(clientId: string, options?: { urgent?: boolean }): EnqueueResult;
  /**
   * The account changed under a scan: stops the client's running scan, if any, and queues a new one
   * in front of the others. (A handle that was corrected, say; the scan that ran read the old one.)
   */
  restart(clientId: string): void;
  /** The client has no account any more: takes it out of the line and stops its running scan. */
  drop(clientId: string): void;
  /** True while the client waits or its scan runs. */
  isBusy(clientId: string): boolean;
  /** True while the client's scan runs. */
  isRunning(clientId: string): boolean;
  /** The clients waiting, in the order they will run (the one running is not in it). */
  waiting(): string[];
  /** When the next weekly scan is due. */
  nextScanAt(): Date;
  /**
   * Queues the clients that are due; returns the ones it queued. Run at start and every
   * {@link SCAN_CHECK_MS}. It also starts {@link InstagramScanQueue.settleCosts} (not waited for).
   */
  check(): string[];
  /**
   * Reads the runs of the scans that ended a few minutes ago again and writes what Apify really
   * charged for them (C90), then tells the web the money changed if a cost did. One pass at a time:
   * asked while one runs, it gives that one. Never rejects; Apify or the database failing is logged.
   */
  settleCosts(): Promise<void>;
  /** Runs a check now and then every {@link SCAN_CHECK_MS}. Does nothing if it runs already. */
  start(): void;
  /** Stops checking and stops the running scan; resolves when the worker is done. Safe to call twice. */
  stop(): Promise<void>;
  /** Resolves when nothing waits and nothing runs. */
  whenIdle(): Promise<void>;
}

const silentLogger: Pick<WatcherLogger, 'info' | 'warn' | 'error'> = {
  info() {},
  warn() {},
  error() {},
};

class ScanQueue implements InstagramScanQueue {
  private readonly options: InstagramScanQueueOptions;
  private readonly clock: () => Date;
  private readonly timeZone: string;
  private readonly timers: ScanTimers;
  private readonly checkMs: number;
  private readonly logger: Pick<WatcherLogger, 'info' | 'warn' | 'error'>;

  private readonly urgent: string[] = [];
  private readonly scheduled: string[] = [];
  private current: { clientId: string; controller: AbortController } | null = null;
  private worker: Promise<void> | null = null;
  private settling: { done: Promise<void>; controller: AbortController } | null = null;
  private idleWaiters: (() => void)[] = [];
  private handle: unknown = null;
  private stopped = false;

  constructor(options: InstagramScanQueueOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.timeZone = options.timeZone ?? systemTimeZone();
    this.timers = options.timers ?? systemEtaTimers;
    this.checkMs = options.checkMs ?? SCAN_CHECK_MS;
    this.logger = options.logger ?? silentLogger;
  }

  enqueue(clientId: string, { urgent = false }: { urgent?: boolean } = {}): EnqueueResult {
    if (this.current?.clientId === clientId) return 'running';
    const inUrgent = this.urgent.includes(clientId);
    const inScheduled = this.scheduled.includes(clientId);
    if (inUrgent || (inScheduled && !urgent)) return 'waiting';
    if (inScheduled) {
      this.scheduled.splice(this.scheduled.indexOf(clientId), 1);
      this.urgent.push(clientId);
      this.pump();
      return 'moved';
    }
    (urgent ? this.urgent : this.scheduled).push(clientId);
    this.tell(clientId);
    this.pump();
    return 'queued';
  }

  restart(clientId: string): void {
    // The running scan is over once its worker has gone round; the new one waits in front of the rest.
    if (this.current?.clientId === clientId) this.current.controller.abort();
    this.remove(clientId);
    if (this.stopped) return;
    this.urgent.unshift(clientId);
    this.tell(clientId);
    this.pump();
  }

  drop(clientId: string): void {
    // A scan that runs says it ended when it has; a client that waited says it does not any more.
    if (this.current?.clientId === clientId) this.current.controller.abort();
    if (this.remove(clientId)) this.tell(clientId);
  }

  isBusy(clientId: string): boolean {
    return (
      this.current?.clientId === clientId ||
      this.urgent.includes(clientId) ||
      this.scheduled.includes(clientId)
    );
  }

  isRunning(clientId: string): boolean {
    return this.current?.clientId === clientId;
  }

  waiting(): string[] {
    return [...this.urgent, ...this.scheduled];
  }

  nextScanAt(): Date {
    return nextScanAt(this.clock(), this.timeZone);
  }

  settleCosts(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.settling !== null) return this.settling.done;
    const { scanner } = this.options;
    if (scanner.settleCosts === undefined) return Promise.resolve();
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => scanner.settleCosts?.({ signal: controller.signal }) ?? 0)
      .then((changed) => {
        if (changed > 0) this.options.publish({ type: 'money.changed' });
      })
      .catch((error: unknown) => {
        // Never a reason to stop checking: the next check tries again.
        this.logger.error({ err: error }, 'could not settle the cost of the Instagram scans');
      })
      .finally(() => {
        this.settling = null;
      });
    this.settling = { done, controller };
    return done;
  }

  check(): string[] {
    if (this.stopped) return [];
    void this.settleCosts();
    const { instagram } = this.options;
    const queued: string[] = [];
    try {
      const exists = this.options.clientExists ?? (() => true);
      const accounts = instagram.listAccounts().filter((account) => exists(account.clientId));
      const lastScans = new Map<string, number>();
      for (const account of accounts) {
        const last = lastCountingScan(instagram.recentScans(account.clientId));
        if (last !== null) lastScans.set(account.clientId, last.startedAt);
      }
      const due = dueClients(
        this.clock(),
        this.timeZone,
        accounts,
        lastScans,
        this.options.activeClients(),
      );
      for (const clientId of due) {
        if (this.enqueue(clientId) === 'queued') queued.push(clientId);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'could not check which Instagram accounts are due');
    }
    return queued;
  }

  start(): void {
    if (this.handle !== null || this.stopped) return;
    this.check();
    this.handle = this.timers.setInterval(() => this.check(), this.checkMs);
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
    // What waits is left: the next boot's check finds it again.
    this.urgent.length = 0;
    this.scheduled.length = 0;
    this.current?.controller.abort();
    this.settling?.controller.abort();
    return Promise.all([this.worker, this.settling?.done]).then(() => undefined);
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // --- the worker -------------------------------------------------------------------------------

  private isIdle(): boolean {
    return this.worker === null && this.urgent.length === 0 && this.scheduled.length === 0;
  }

  /** Takes the client out of the line it waits in; whether it was waiting. */
  private remove(clientId: string): boolean {
    let removed = false;
    for (const line of [this.urgent, this.scheduled]) {
      const at = line.indexOf(clientId);
      if (at !== -1) {
        line.splice(at, 1);
        removed = true;
      }
    }
    return removed;
  }

  private tell(clientId: string): void {
    try {
      this.options.publish({ type: 'client-instagram', clientId });
    } catch (error) {
      // A listener that throws never stops a scan.
      this.logger.error(
        { err: error, clientId },
        'could not tell the page about an Instagram scan',
      );
    }
  }

  private pump(): void {
    if (this.worker !== null || this.stopped) return;
    // Not before the caller has its answer: asking for a scan never runs one in the same breath.
    this.worker = Promise.resolve()
      .then(() => this.work())
      .catch((error: unknown) => {
        // `work` handles everything a scan can throw: this is for what nobody foresaw.
        this.logger.error({ err: error }, 'the Instagram scan queue broke');
      })
      .finally(() => {
        this.worker = null;
        // Asked for between the last scan and here: no worker was running to take it.
        if (!this.stopped && (this.urgent.length > 0 || this.scheduled.length > 0)) this.pump();
        else if (this.isIdle()) for (const resolve of this.idleWaiters.splice(0)) resolve();
      });
  }

  /** Scans the clients in line, one after another, until the line is empty or the queue is stopped. */
  private async work(): Promise<void> {
    while (!this.stopped) {
      const clientId = this.urgent.shift() ?? this.scheduled.shift();
      if (clientId === undefined) return;
      await this.scan(clientId);
    }
  }

  private async scan(clientId: string): Promise<void> {
    let handle: string | null = null;
    try {
      handle = this.options.instagram.getAccount(clientId)?.handle ?? null;
    } catch (error) {
      this.logger.error({ err: error, clientId }, 'could not read an Instagram account to scan');
    }
    if (handle === null) {
      // Removed while it waited: nothing to read, and the page stops saying "scanning".
      this.tell(clientId);
      return;
    }

    const controller = new AbortController();
    this.current = { clientId, controller };
    this.tell(clientId);
    try {
      const result = await this.options.scanner.scan(clientId, handle, {
        signal: controller.signal,
      });
      const log = {
        clientId,
        handle,
        outcome: result.outcome,
        reelsRead: result.scan.reelsRead,
        costUsd: result.scan.costUsd,
      };
      if (result.outcome === 'ok') this.logger.info(log, 'Instagram scan finished');
      else if (result.cancelled) this.logger.info(log, 'Instagram scan stopped');
      else {
        this.logger.warn(
          { ...log, error: result.error },
          'Instagram scan did not read the account',
        );
      }
    } catch (error) {
      // The scanner only throws when the database does.
      this.logger.error({ err: error, clientId }, 'Instagram scan broke');
    } finally {
      this.current = null;
      this.tell(clientId);
    }
  }
}

/** The queue of the Instagram scans, not started: `start()` begins the weekly checks. */
export function createInstagramScanQueue(options: InstagramScanQueueOptions): InstagramScanQueue {
  return new ScanQueue(options);
}
