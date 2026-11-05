// The live stream (architecture §7), mounted at /api/events (an editor's stream carries only their
// clients' events, and ends when access changes; see openClientStream):
//
//   GET /     Server-Sent Events. `data: {"type":"hello"}` on connect, then one
//             `data: <ServerEvent as JSON>` per job, note or money change, and an `event: ping`
//             every 15 s.
//
// There are no event ids and no replay: a client that (re)connects gets `hello`, reloads
// GET /api/jobs, and applies what follows. What each stream sends, and how bursts of progress are
// thinned out, is `openClientStream`; this file is the HTTP side of it.
//
// The response is `text/event-stream` with `Cache-Control: no-cache, no-transform` and
// `X-Accel-Buffering: no`, so nothing between the server and the browser (the Vite dev proxy and
// Tailscale Serve included) holds the frames back.
//
// The ping is a named event with empty data, not a `:` comment: a browser's EventSource never
// shows comments to the page, and the page needs to see it. It tells a live stream from one the
// phone's sleep cut without saying so (Mobile plan §4): 20 s of nothing means a dead stream, which
// the page opens again when it comes back. A named event never reaches `onmessage`, so the
// ServerEvent handling never sees it.

import type { Job, Viewer } from '@studio/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '../events/bus.js';
import {
  type ClientStream,
  openClientStream,
  type StreamScope,
  type StreamTimers,
} from '../events/client-stream.js';
import { type CanSee, viewerOf } from '../team/viewer-scope.js';

/** A client this many frames behind is not reading; its stream is closed and it reconnects. */
export const MAX_BACKLOG = 500;

/** The heartbeat: an `event: ping` with empty data, which a browser dispatches as a `ping` event. */
export const PING_FRAME = 'event: ping\ndata:\n\n';

/** What an editor's stream is scoped with (Team plan, TM2). */
export interface EventsScope {
  /** Which clients a viewer sees. */
  canSee: CanSee;
  /** The client a job belongs to; null for an unknown job. */
  clientOfJob(jobId: string): string | null;
  /** Every job, as the stream opens. */
  jobs(): Iterable<Pick<Job, 'id' | 'clientId'>>;
  /**
   * Whether this viewer is an admin right now (the owner's logins, or the team's admins), asked
   * when `access.changed` arrives so that an admin who was made an editor loses their stream.
   * Default: an admin stays one.
   */
  stillAdmin?: (viewer: Viewer) => boolean;
}

export interface EventsRouteOptions {
  bus: EventBus;
  /**
   * Who sees what. Without it an editor's stream carries nothing about any client (fail closed);
   * an admin's stream always carries everything.
   */
  scope?: EventsScope;
  /** Aborting it ends every open stream (the engine does at `stop()`, so shutdown never waits for a browser). */
  signal?: AbortSignal;
  /** Milliseconds between two upserts of one job on one stream. Default 250. */
  coalesceMs?: number;
  /** Milliseconds between heartbeats. Default 15 000. */
  heartbeatMs?: number;
  /** Frames a client may fall behind before it is cut off. Default {@link MAX_BACKLOG}. */
  maxBacklog?: number;
  /** For tests. */
  timers?: StreamTimers;
  now?: () => number;
}

export function createEventsRoutes(options: EventsRouteOptions): Hono {
  const { bus, signal, coalesceMs, heartbeatMs, maxBacklog = MAX_BACKLOG, timers, now } = options;
  const routes = new Hono();

  routes.get('/', (c) => {
    const response = streamSSE(c, async (stream) => {
      if (signal?.aborted) return;

      // Frames handed to the stream and not yet taken by the connection.
      let backlog = 0;
      let client: ClientStream | undefined;

      const write = (frame: string): void => {
        if (stream.aborted || stream.closed) return;
        backlog += 1;
        // `write` never rejects: a failed write only means the client is gone, and the abort
        // below says so.
        void stream.write(frame).then(() => {
          backlog -= 1;
        });
        if (backlog > maxBacklog) client?.close();
      };

      // An admin's stream carries everything; an editor's only their clients' events. A request
      // with no viewer (the route mounted alone, in tests) is an admin's.
      const viewer = viewerOf(c);
      let streamScope: StreamScope | undefined;
      let closeOnAccessChange: (() => boolean) | undefined;
      if (viewer !== undefined && viewer.role !== 'admin') {
        const scope = options.scope;
        streamScope = {
          canSee: (clientId) => scope?.canSee(viewer, clientId) ?? false,
          clientOfJob: (jobId) => scope?.clientOfJob(jobId) ?? null,
          jobs: () => scope?.jobs() ?? [],
        };
      } else if (viewer !== undefined && viewer.via !== 'local') {
        const still = options.scope?.stillAdmin;
        if (still !== undefined) closeOnAccessChange = () => !still(viewer);
      }

      client = openClientStream({
        bus,
        scope: streamScope,
        ...(closeOnAccessChange === undefined ? {} : { closeOnAccessChange }),
        // JSON.stringify never emits a raw newline, so one `data:` line is the whole event.
        send: (event) => write(`data: ${JSON.stringify(event)}\n\n`),
        ping: () => write(PING_FRAME),
        coalesceMs,
        heartbeatMs,
        timers,
        now,
      });

      const stop = (): void => client?.close();
      stream.onAbort(stop);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        // Returning from this callback ends the response, so hold it open until the client goes
        // away (abort) or the server closes the stream.
        await client.whenClosed;
      } finally {
        signal?.removeEventListener('abort', stop);
        client.close();
      }
    });

    // streamSSE sets `Cache-Control: no-cache` after anything set before it; say the rest here.
    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });

  return routes;
}
