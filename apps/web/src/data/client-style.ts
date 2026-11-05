// A client's style (`['client-style', clientId]`): its state and its style.md. The server pushes
// every change over SSE (`client.upsert`, see job-events.ts), which only says "this one changed";
// the query then asks again, so the markdown always comes with the state it belongs to. Not polled.

import type { ClientStyle, ClientStyleResponse } from '@studio/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** Every client-style query starts with this. */
export const CLIENT_STYLES_KEY = ['client-style'] as const;

/** One client's style: ['client-style', clientId]. */
export function clientStyleKey(clientId: string): readonly ['client-style', string] {
  return ['client-style', clientId] as const;
}

/**
 * Options of the `['client-style', clientId]` query: fresh forever (SSE says when it changes). A
 * 4xx (404 for a client the engine does not know) will not change by asking again, so it is not
 * retried; every other failure is, as for all queries (query-client.ts).
 */
export function clientStyleQueryOptions(api: Api, clientId: string) {
  return queryOptions<ClientStyleResponse, ApiError>({
    queryKey: clientStyleKey(clientId),
    queryFn: ({ signal }) => api.getClientStyle(clientId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/**
 * The style as an upload or a retry answered it (it has no markdown): written over the cached
 * one, whose markdown stays, so the page shows "analysing" at once. The query is then loaded again
 * so that the next answer is the server's own.
 */
export function applyClientStyle(queryClient: QueryClient, style: ClientStyle): void {
  const key = clientStyleKey(style.clientId);
  queryClient.setQueryData<ClientStyleResponse>(
    key,
    (old) => old && { ...old, ...style, pass: style.pass ?? null, markdown: old.markdown },
  );
  void queryClient.invalidateQueries({ queryKey: key });
}

/** The style changed on the server: loads it again (does nothing for a style nobody has loaded). */
export function reloadClientStyle(queryClient: QueryClient, clientId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: clientStyleKey(clientId) });
}
