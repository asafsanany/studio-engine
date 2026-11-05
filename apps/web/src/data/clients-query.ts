// The client list (`['clients']`): every client folder of the inbox, with jobs or without, from
// `GET /api/clients`. The server pushes what can change it over SSE (a client folder added or
// removed, a job arriving or going, a style changing; see job-events.ts), which only says "this
// changed": the query then asks again. Not polled.

import type { ClientRow, Job } from '@studio/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The TanStack Query key of the client list. */
export const CLIENTS_KEY = ['clients'] as const;

/** Options of the `['clients']` query: the full list, fresh forever (SSE says when it changes). */
export function clientsQueryOptions(api: Api) {
  return queryOptions<ClientRow[], ApiError>({
    queryKey: CLIENTS_KEY,
    queryFn: ({ signal }) => api.listClients(signal),
    staleTime: Infinity,
  });
}

/** `row` replaces the row with the same `clientId`, or is added when the list has none. */
export function upsertClientRow(list: readonly ClientRow[], row: ClientRow): ClientRow[] {
  return list.some((existing) => existing.clientId === row.clientId)
    ? list.map((existing) => (existing.clientId === row.clientId ? row : existing))
    : [...list, row];
}

/**
 * Whether a job that arrived over SSE can change a row of the client list: it is a job the list of
 * jobs did not hold (so the client's job count and last job may change), or it moved to another
 * client. A progress tick of a known job cannot, and asking the server for the list again on every
 * tick of every running job would be a request a second for nothing.
 */
export function changesClientRow(known: Job | undefined, job: Job): boolean {
  return known === undefined || known.clientId !== job.clientId || known.addedAt !== job.addedAt;
}

/** The client list changed on the server: loads it again (does nothing while nobody shows it). */
export function reloadClients(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
}

/**
 * The mutation behind "New client": `create.mutateAsync(name)` resolves with the new client's row,
 * which is already in the cached list (when there is one), so its page can open at once. A
 * refusal is an `ApiError`: 400 with the reason, 409 when the name is taken.
 */
export function createClientMutationOptions({
  queryClient,
  api,
}: {
  queryClient: QueryClient;
  api: Api;
}) {
  return {
    mutationFn: (name: string) => api.createClient(name),
    onSuccess: (row: ClientRow) => {
      queryClient.setQueryData<ClientRow[]>(
        CLIENTS_KEY,
        (list) => list && upsertClientRow(list, row),
      );
      // The `client.added` event does the same; this covers a stream that is not connected.
      void reloadClients(queryClient);
    },
  };
}
