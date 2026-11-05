// The dev server's (and `vite preview`'s) /api proxy to the Studio Engine. Split out of
// vite.config.ts so the hook can be tested against a real Vite proxy (dev-proxy.test.ts).

import type { ProxyOptions } from 'vite';

type ProxyServer = Parameters<NonNullable<ProxyOptions['configure']>>[0];

/**
 * The proxy hook for `/api`:
 *
 * 1. Server-Sent Events (/api/events) must stream straight through: SSE responses are marked
 *    non-cacheable / non-transformable and the head is flushed so the browser sees the stream open
 *    at once. The flush is deferred: http-proxy copies proxyRes.headers onto `res` only after this
 *    event handler returns, and flushing earlier drops them.
 *
 * 2. When the engine goes away mid-response, the browser's response must end too. http-proxy
 *    forwards the body with `proxyRes.pipe(res)`, and a pipe only ends its target when the source
 *    ends *normally*. When the upstream connection is cut instead (the engine was stopped,
 *    restarted or killed) the proxy's response emits `aborted`, `error` (ECONNRESET) and `close`
 *    with `complete === false`, nothing ends `res`, and the browser's EventSource sits on a
 *    connection that never says anything again: `readyState` stays OPEN, so no error reaches the
 *    page, the "Reconnecting to the engine..." notice never shows, and a restarted engine is never
 *    found until the page is reloaded. So an upstream response that closes before it was complete
 *    destroys `res`: the browser sees the connection drop (EventSource fires `error`, and the
 *    events client reconnects). `close` is the one event that always follows, so it is the trigger.
 *
 * 3. The same for an `error` of the proxy after the head has gone out (it fires for a connection
 *    reset). Vite's own handler only answers 502 while the head is unsent and leaves a streaming
 *    response open. With the head unsent (the engine is down when the browser asks) Vite's 502 is
 *    left alone: it makes the EventSource fail and the client try again later.
 */
export function configureApiProxy(proxy: ProxyServer): void {
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      proxyRes.headers['cache-control'] = 'no-cache, no-transform';
      proxyRes.headers['x-accel-buffering'] = 'no';
      setImmediate(() => res.flushHeaders());
    }
    proxyRes.on('close', () => {
      if (!proxyRes.complete) res.destroy();
    });
  });

  proxy.on('error', (_error, _req, res) => {
    // `res` is a socket for a WebSocket proxy, which has no head to speak of.
    if ('headersSent' in res && res.headersSent && !res.writableEnded) res.destroy();
  });
}

/** The proxy table for `server.proxy` and `preview.proxy`: everything under /api goes to `target`. */
export function createApiProxy(target: string): Record<string, ProxyOptions> {
  return { '/api': { target, configure: configureApiProxy } };
}
