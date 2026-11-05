// "Can't reach your Mac" on the phone: the engine link's second, longer threshold.
//
// The link (job-events.ts) turns "Reconnecting to the engine..." on after 2 s of bad news, which
// the Mac layout shows as a small notice above a list that is still on screen. The phone has no
// room for that, and a list that has stopped being live is worse than none: it says "Editing" for
// a job that finished an hour ago. So when the engine stays out of reach for more than 5 s the
// phone swaps the page for a full-screen message, until the link says the engine answered (any
// frame of the events stream, or a fetch of the list that went through).

import { type EngineLink, engineLink, type ReconnectTimers } from './job-events';

/**
 * How long the engine has to stay out of reach, counted from the first bad news, before the phone
 * says "Can't reach your Mac". A longer break than the link's own 2 s on purpose: a quick sleep and
 * wake, or a tunnel that takes a moment to come back, should not blank the page.
 */
export const OFFLINE_AFTER_MS = 5_000;

/** Whether the phone should show its offline screen. Observable, for `useSyncExternalStore`. */
export interface EngineOffline {
  /** True from {@link OFFLINE_AFTER_MS} of bad news until the engine answers again. */
  isOffline(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface EngineOfflineOptions {
  /** Default {@link OFFLINE_AFTER_MS}. */
  afterMs?: number;
  /** Default: the global timers. Tests pass their own. */
  timers?: ReconnectTimers;
  /** The clock, which must be the link's. Default `Date.now`. */
  now?: () => number;
}

const globalTimers: ReconnectTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Watches `link` and reports offline once it has been reconnecting (its 2 s wait is over) and the
 * first bad news is `afterMs` old. The link's own wait is not repeated: this starts when the link
 * says the engine is out of reach and only waits for what is left of `afterMs`. A short outage
 * never shows, and the screen goes away the moment the link says the engine answered.
 */
export function createEngineOffline(
  link: EngineLink,
  { afterMs = OFFLINE_AFTER_MS, timers = globalTimers, now = Date.now }: EngineOfflineOptions = {},
): EngineOffline {
  let offline = false;
  let pending: unknown = null;
  const listeners = new Set<() => void>();

  function setOffline(next: boolean): void {
    if (next === offline) return;
    offline = next;
    for (const listener of [...listeners]) listener();
  }

  function cancel(): void {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  }

  function sync(): void {
    if (!link.isReconnecting()) {
      cancel();
      setOffline(false);
      return;
    }
    if (offline || pending !== null) return;
    const outageStart = link.downSince() ?? now();
    pending = timers.setTimeout(
      () => {
        pending = null;
        if (link.isReconnecting()) setOffline(true);
      },
      Math.max(0, afterMs - (now() - outageStart)),
    );
  }

  link.subscribe(sync);

  return {
    isOffline: () => offline,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app's one watch, over the app's one link. */
export const engineOffline: EngineOffline = createEngineOffline(engineLink);
