import type { ServerEvent } from '@studio/shared';

/** Receives every event published after it subscribed. */
export type BusListener = (event: ServerEvent) => void;

/**
 * The in-process channel that carries job changes from whoever makes them (the watcher, the
 * worker, the API) to whoever shows them (the inbox watcher's settle timers, the SSE streams of
 * `GET /api/events`). Events are the wire `ServerEvent`s, so a subscriber can forward them as
 * they are.
 *
 * Who publishes (architecture §7 "realtime"): whoever writes a job publishes the result after the
 * write is committed, at the call site: the jobs routes and the queue worker through
 * `onJobChanged`, the inbox watcher and the start-up reconcile directly. Besides them, the review
 * service publishes `note.upsert` / `note.remove` when a review note changes, is deleted or is
 * sent, `followQueuePlaces` republishes the queued jobs whose `placeInLine` moved, and the ETA
 * ticks (E5) publish `job.upsert` for a job whose estimate changed. The engine publishes
 * `money.changed` (the Money page's numbers moved) when a delivery is recorded, when money.json
 * changes and when review time is added. The bus delivers every one of these to
 * every listener, none dropped or merged: coalescing is the business of each SSE stream
 * (`openClientStream`), because the watcher needs every upsert.
 *
 * Delivery is synchronous and in order: when a top-level `publish` returns, every listener has seen
 * the event. A listener that throws is skipped and cannot stop the others or the publisher.
 *
 * An event published from inside a listener (a re-entrant `publish`) is delivered once the event
 * being delivered has reached all its listeners, so every listener sees the same global order.
 * That `publish` returns before delivery.
 */
export interface EventBus {
  publish(event: ServerEvent): void;
  /** Starts delivering events to `listener`. Returns the function that stops it (safe to call twice). */
  subscribe(listener: BusListener): () => void;
}

export interface EventBusOptions {
  /** Called with whatever a listener threw. Defaults to ignoring it. */
  onListenerError?: (error: unknown, event: ServerEvent) => void;
}

/** What {@link createEventBus} returns: an `EventBus` that can also say how many listeners it has. */
export interface MemoryEventBus extends EventBus {
  /** Listeners subscribed right now. For tests and diagnostics: a closed stream must not be counted. */
  listenerCount(): number;
}

/** A bus that keeps its listeners in memory. */
export function createEventBus({ onListenerError }: EventBusOptions = {}): MemoryEventBus {
  const listeners = new Set<BusListener>();
  const queue: ServerEvent[] = [];
  let delivering = false;

  function deliver(event: ServerEvent): void {
    // A copy, so a listener that (un)subscribes while it is called does not change this round.
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        try {
          onListenerError?.(error, event);
        } catch {
          // The error handler is not allowed to break delivery either.
        }
      }
    }
  }

  return {
    publish(event) {
      queue.push(event);
      if (delivering) return;
      delivering = true;
      try {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) deliver(next);
      } finally {
        delivering = false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}

/** A bus that drops everything and never calls anyone. For code that needs an `EventBus` but no events. */
export const noopEventBus: EventBus = {
  publish() {},
  subscribe() {
    return () => {};
  },
};
