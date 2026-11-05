import { type Job, type ServerEvent, withoutJobMoney } from '@studio/shared';
import type { EventBus } from './bus.js';

/** At most one `job.upsert` per job per this long on one stream (progress can be chatty). */
export const COALESCE_MS = 250;
/** A comment line goes out this often, so a proxy or the browser never sees an idle connection. */
export const HEARTBEAT_MS = 15_000;

/** Timer functions, injectable so tests can run a minute of heartbeats in no time. */
export interface StreamTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real timers, unreferenced: a stream's timers alone must not keep the process up. */
export const systemTimers: StreamTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * What one editor's stream may carry (Team plan, TM2). A stream without it belongs to an admin and
 * carries everything.
 */
export interface StreamScope {
  /** Whether the viewer may see the client (live: team.json is read on every question). */
  canSee(clientId: string): boolean;
  /** The client a job belongs to; null once the job is gone or for an unknown id. */
  clientOfJob(jobId: string): string | null;
  /** The jobs that exist as the stream opens: the viewer's visible set starts from them. */
  jobs(): Iterable<Pick<Job, 'id' | 'clientId'>>;
}

export interface ClientStreamOptions {
  bus: EventBus;
  /**
   * Who the stream is for. Given for an editor: the stream then drops every event about a client
   * that is not theirs, sends `money.changed` and the graphics events to nobody, and closes at
   * `access.changed` so the browser reconnects, gets `hello` and loads its lists again.
   */
  scope?: StreamScope;
  /**
   * Whether `access.changed` ends this stream. Default: when it has a `scope`. An admin who came
   * in through Tailscale is told to end it too when they are no longer an admin.
   */
  closeOnAccessChange?: () => boolean;
  /** Writes one event to the client (an SSE `data:` frame). Throwing closes the stream. */
  send(event: ServerEvent): void;
  /** Writes the heartbeat (an SSE comment). Throwing closes the stream. */
  ping(): void;
  /** Default {@link COALESCE_MS}. */
  coalesceMs?: number;
  /** Default {@link HEARTBEAT_MS}. */
  heartbeatMs?: number;
  timers?: StreamTimers;
  /** Milliseconds, any origin. Defaults to `Date.now`; tests pass the clock their timers use. */
  now?: () => number;
}

export interface ClientStream {
  /** Unsubscribes from the bus and clears every timer. Safe to call twice. */
  close(): void;
  readonly closed: boolean;
  /** Resolves once the stream is closed, by whoever closed it. */
  readonly whenClosed: Promise<void>;
}

/** What one job's slot remembers: when its last `job.upsert` went out and whether a newer one waits. */
interface Slot {
  lastSentAt: number;
  pending: Job | null;
  timer: unknown;
}

// Slots of jobs that have been quiet for a window are worthless; sweep them when there are many.
const SWEEP_ABOVE = 256;

/**
 * One SSE client's view of the bus (A2). Transport-agnostic: the route gives it `send` and `ping`.
 *
 * - Sends `hello` first, then every `job.upsert` / `job.remove`, `client.upsert`,
 *   `client.added` / `client.removed`, note, `money.changed`, `series.changed` /
 *   `series.removed`, `graphic.changed` / `graphic.removed`, `lut.changed` / `lut.removed` and
 *   `font.changed` / `font.removed` / `font.requested` / `font.request.dismissed`, `job.music`,
 *   `job.fix`, `job.generate` and `client-instagram` event the bus carries afterwards. (A
 *   `hello` on the bus is ignored: hello belongs to a connection, not to a job.)
 * - With a `scope` (an editor's stream) only what is about the viewer's clients goes out; see
 *   {@link StreamScope}.
 * - Coalesces per job: the first upsert of a quiet job goes out at once; further upserts of that
 *   job inside the next `coalesceMs` are held, and the latest of them goes out when the window
 *   ends (so a burst costs at most one frame per window and the last word is never lost). The
 *   coalescing never looks at `updatedAt`: an ETA tick changes `etaSec` without bumping it, and
 *   must still reach the screen.
 * - Never coalesces `job.remove`; it drops the removed job's held upsert. Note events are not
 *   coalesced either: each goes out as it comes, in order.
 * - A comment goes out every `heartbeatMs`.
 *
 * Coalescing is here and not on the bus on purpose: the inbox watcher listens on the same bus and
 * needs every upsert.
 */
export function openClientStream(options: ClientStreamOptions): ClientStream {
  const {
    bus,
    scope,
    closeOnAccessChange = () => scope !== undefined,
    send,
    ping,
    coalesceMs = COALESCE_MS,
    heartbeatMs = HEARTBEAT_MS,
    timers = systemTimers,
    now = Date.now,
  } = options;

  const slots = new Map<string, Slot>();
  // The ids of the jobs this stream's viewer sees, for the events that carry only an id
  // (`job.remove`). Kept from the jobs at open and from every `job.upsert`.
  const visibleJobs = new Set<string>();
  if (scope !== undefined) {
    for (const job of scope.jobs()) if (scope.canSee(job.clientId)) visibleJobs.add(job.id);
  }
  let closed = false;
  let heartbeat: unknown;
  let unsubscribe: (() => void) | undefined;
  let resolveClosed: () => void = () => {};
  const whenClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    timers.clearTimeout(heartbeat);
    for (const slot of slots.values()) {
      if (slot.timer !== null) timers.clearTimeout(slot.timer);
    }
    slots.clear();
    resolveClosed();
  }

  function write(action: () => void): void {
    if (closed) return;
    try {
      action();
    } catch {
      close();
    }
  }

  function sweep(at: number): void {
    if (slots.size <= SWEEP_ABOVE) return;
    for (const [id, slot] of slots) {
      if (slot.timer === null && at - slot.lastSentAt >= coalesceMs) slots.delete(id);
    }
  }

  /** Whether the viewer may see this job's events (always, for an admin's stream). */
  function jobVisible(jobId: string): boolean {
    if (scope === undefined) return true;
    const clientId = scope.clientOfJob(jobId);
    if (clientId === null) return visibleJobs.has(jobId);
    return scope.canSee(clientId);
  }

  /** Whether the viewer may see this client's events (always, for an admin's stream). */
  const clientVisible = (clientId: string): boolean =>
    scope === undefined || scope.canSee(clientId);

  function upsert(whole: Job): void {
    // An editor's stream carries no money: the delivery keeps only its date.
    const job = scope === undefined ? whole : withoutJobMoney(whole);
    if (scope !== undefined) {
      if (!scope.canSee(job.clientId)) {
        // A job the viewer had and may no longer see leaves their list; any other is not news.
        if (visibleJobs.has(job.id)) remove(job.id);
        return;
      }
      visibleJobs.add(job.id);
    }
    const at = now();
    const slot = slots.get(job.id);

    if (slot === undefined || at - slot.lastSentAt >= coalesceMs) {
      // A quiet job (or a window a late timer has not closed yet): this one goes now and
      // supersedes anything that was held.
      if (slot !== undefined && slot.timer !== null) timers.clearTimeout(slot.timer);
      slots.set(job.id, { lastSentAt: at, pending: null, timer: null });
      write(() => send({ type: 'job.upsert', job }));
      sweep(at);
      return;
    }

    slot.pending = job;
    if (slot.timer === null) {
      slot.timer = timers.setTimeout(() => flush(job.id), slot.lastSentAt + coalesceMs - at);
    }
  }

  /** The window of `id` ended: send what was held. */
  function flush(id: string): void {
    const slot = slots.get(id);
    if (closed || slot === undefined) return;
    slot.timer = null;
    if (slot.pending === null) return;

    const at = now();
    const wait = slot.lastSentAt + coalesceMs - at;
    if (wait > 0) {
      // The timer fired early; keep the promise of one frame per window.
      slot.timer = timers.setTimeout(() => flush(id), wait);
      return;
    }
    const job = slot.pending;
    slot.pending = null;
    slot.lastSentAt = at;
    write(() => send({ type: 'job.upsert', job }));
  }

  function remove(id: string): void {
    if (scope !== undefined) {
      // An id the viewer never had is not for them.
      if (!visibleJobs.delete(id)) return;
    }
    const slot = slots.get(id);
    if (slot !== undefined) {
      if (slot.timer !== null) timers.clearTimeout(slot.timer);
      slots.delete(id);
    }
    write(() => send({ type: 'job.remove', id }));
  }

  function beat(): void {
    if (closed) return;
    write(ping);
    if (!closed) heartbeat = timers.setTimeout(beat, heartbeatMs);
  }

  // Hello first, then listen: nothing can be published between the two (one synchronous run), and
  // the client's refetch on hello starts after every event it will receive from here on.
  write(() => send({ type: 'hello' }));
  if (!closed) {
    unsubscribe = bus.subscribe((event) => {
      if (event.type === 'job.upsert') upsert(event.job);
      else if (event.type === 'job.remove') remove(event.id);
      // A client's style changes rarely (a style run, not progress), so there is nothing to thin out.
      else if (event.type === 'client.upsert') {
        if (clientVisible(event.style.clientId)) write(() => send(event));
      }
      // A client folder coming or going is a click in Finder or in New client: nothing to thin out.
      else if (event.type === 'client.added' || event.type === 'client.removed') {
        if (clientVisible(event.clientId)) write(() => send(event));
      }
      // A note changes on a click or when its transcript lands, never in bursts: nothing to thin out,
      // and a note.remove must never overtake a held upsert of the same note.
      else if (event.type === 'note.upsert') {
        if (jobVisible(event.note.jobId)) write(() => send(event));
      } else if (event.type === 'note.remove') {
        if (jobVisible(event.jobId)) write(() => send(event));
      }
      // The Money page's numbers changed (a delivery, money.json, review time): the page loads them
      // again, so there is nothing to carry and nothing to thin out. Money is the admin's alone.
      else if (event.type === 'money.changed') {
        if (scope === undefined) write(() => send(event));
      }
      // A series is started, changed (a pass queued, installed or failed) or removed by a click
      // or a finished pass, never in bursts: nothing to thin out, and a removal must never
      // overtake the change before it.
      else if (event.type === 'series.changed') {
        if (clientVisible(event.series.clientId)) write(() => send(event));
      } else if (event.type === 'series.removed') {
        if (clientVisible(event.clientId)) write(() => send(event));
      }
      // A graphic changes on a click or when its run moves on (three steps, then done), never in
      // bursts: nothing to thin out, and a removal must never overtake the change before it. The
      // Graphics page is the admin's alone.
      else if (event.type === 'graphic.changed' || event.type === 'graphic.removed') {
        if (scope === undefined) write(() => send(event));
      }
      // A LUT changes on a click or when an import lands (and a job uses it), never in bursts:
      // nothing to thin out, and a removal must never overtake the change before it. The LUTs page
      // is the admin's alone.
      else if (event.type === 'lut.changed' || event.type === 'lut.removed') {
        if (scope === undefined) write(() => send(event));
      }
      // A font changes when an import lands or the owner drops files into _Fonts, never in bursts (the
      // index settles them first): nothing to thin out, and a removal must never overtake the
      // change before it. The Fonts page is the admin's alone.
      else if (event.type === 'font.changed' || event.type === 'font.removed') {
        if (scope === undefined) write(() => send(event));
      }
      // A note names a font the library lacks (FN16): once per name, job and round, never in bursts.
      // The banner is on the Fonts page, which is the admin's alone.
      else if (event.type === 'font.requested') {
        if (scope === undefined) write(() => send(event));
      }
      // "Not a font" was pressed on the bar (C52): once per press, admin only like the bar itself.
      else if (event.type === 'font.request.dismissed') {
        if (scope === undefined) write(() => send(event));
      }
      // A job's music changes on a click (Make another, Pick), when a make ends or when a run ends,
      // never in bursts: nothing to thin out, and "made" must never overtake "making".
      else if (event.type === 'job.music') {
        if (jobVisible(event.jobId)) write(() => send(event));
      }
      // A quick fix is queued, moves on a step (four of them), lands or ends: a few events a minute,
      // nothing to thin out, and "fixed" must never overtake "fixing" (QF3).
      else if (event.type === 'job.fix') {
        if (jobVisible(event.jobId)) write(() => send(event));
      }
      // A generated job's Generate stage moves on (Generated videos, GN0): a few events a minute
      // while it runs, each the whole state, so nothing to thin out, and a later one must never
      // overtake an earlier.
      else if (event.type === 'job.generate') {
        if (jobVisible(event.jobId)) write(() => send(event));
      }
      // A client's Instagram changes on a click or when a scan starts or ends, never in bursts: it
      // carries only whose, so there is nothing to thin out (Clients × Instagram, IG0).
      else if (event.type === 'client-instagram') {
        if (clientVisible(event.clientId)) write(() => send(event));
      }
      // Who may see what changed: the stream of an editor ends, and the browser connects again,
      // gets `hello` and loads its lists as they are now. Nothing is sent to the browser itself.
      else if (event.type === 'access.changed') {
        if (closeOnAccessChange()) close();
      }
    });
    heartbeat = timers.setTimeout(beat, heartbeatMs);
  }

  return {
    close,
    get closed() {
      return closed;
    },
    whenClosed,
  };
}
