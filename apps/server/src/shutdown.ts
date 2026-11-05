// Closing the HTTP server without waiting for browsers.
//
// `server.close()` stops listening and then waits for every connection to end. A browser that is
// connected keeps one open twice over: the event stream (/api/events), which the engine ends at
// `stop()`, and the keep-alive connection that every finished response leaves behind (Node closes
// those only after `keepAliveTimeout`, 5 s). Node closes the idle connections once, when `close()`
// is called, and the event streams are not idle then: their responses end a moment later. So a
// restart with a browser open waited out the whole grace period for nothing (CVP-89).
//
// `closeServer` keeps closing the idle connections until the server is closed, so each connection
// goes the moment its last response has ended. A connection that is busy for real (a download in
// progress) is left alone until the grace period is over; then everything is closed by force.

import type { Server } from 'node:http';

/** How often the idle connections are closed while the server closes. */
export const IDLE_SWEEP_MS = 25;

export interface CloseServerOptions {
  /** The most the connections that are still busy get; then they are closed by force. */
  graceMs: number;
  /** Called when the grace period is over, just before the remaining connections are closed. */
  onGraceOver?: () => void;
  /** Default {@link IDLE_SWEEP_MS}. */
  sweepMs?: number;
}

/**
 * Stops the server accepting connections and closes it as soon as no connection is left.
 * Resolves once it is closed; rejects with the error `server.close()` reports (for example when
 * it was not running). The timers never keep the process alive on their own.
 */
export function closeServer(server: Server, options: CloseServerOptions): Promise<void> {
  const { graceMs, onGraceOver, sweepMs = IDLE_SWEEP_MS } = options;

  return new Promise<void>((resolve, reject) => {
    let sweeper: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const stopTimers = (): void => {
      clearInterval(sweeper);
      clearTimeout(grace);
    };

    server.close((err) => {
      stopTimers();
      if (err) reject(err);
      else resolve();
    });

    // Idle now (close() does this too since Node 19; older versions do not).
    server.closeIdleConnections();
    sweeper = setInterval(() => server.closeIdleConnections(), sweepMs);
    sweeper.unref();
    grace = setTimeout(() => {
      onGraceOver?.();
      server.closeAllConnections();
    }, graceMs);
    grace.unref();
  });
}
