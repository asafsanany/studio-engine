// The series caches (Series plan §5): a client's series list (`['series', 'client', clientId]`) and
// one series with its series.md (`['series', 'one', seriesId]`). The server pushes every change
// over SSE (job-events.ts), which only says "this one changed" or "this one is gone"; the queries
// then ask again, so series.md always comes with the state it belongs to and the episode counts
// stay the server's to work out. Not polled.
//
//   series.changed   that series and its client's list load again
//   series.removed   that series is reset (a page showing it asks again and finds it gone), and its
//                    client's list loads again
//   job.upsert       a job joining, leaving or moving between series loads its client's list again
//   job.remove       a removed episode does too
//   hello            every series query loads again (whatever happened while we were away)

import type { Job, Series, SeriesResponse } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';

/** Every series query starts with this. */
export const SERIES_KEY = ['series'] as const;

/** A client's series list: ['series', 'client', clientId]. */
export function clientSeriesKey(clientId: string): readonly ['series', 'client', string] {
  return ['series', 'client', clientId] as const;
}

/** One series and its series.md: ['series', 'one', seriesId]. */
export function seriesKey(seriesId: string): readonly ['series', 'one', string] {
  return ['series', 'one', seriesId] as const;
}

/** The client's series list changed on the server: loads it again (nothing when nobody loaded it). */
export function reloadClientSeries(queryClient: QueryClient, clientId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: clientSeriesKey(clientId) });
}

/** `series.changed`: the series and its client's list load again. */
export function reloadSeries(
  queryClient: QueryClient,
  series: Pick<Series, 'id' | 'clientId'>,
): void {
  void queryClient.invalidateQueries({ queryKey: seriesKey(series.id) });
  void reloadClientSeries(queryClient, series.clientId);
}

/**
 * `series.removed`: the cached series is dropped (a page that shows it asks again, and gets the
 * 404 of a series that is gone), and its client's list loads again.
 */
export function dropSeries(queryClient: QueryClient, seriesId: string, clientId: string): void {
  void queryClient.resetQueries({ queryKey: seriesKey(seriesId) });
  void reloadClientSeries(queryClient, clientId);
}

/**
 * The series as an action answered it (Start a series, Use as the series format, Retry; it has no
 * markdown): written over the cached one, whose markdown stays, so the page shows "learning" at
 * once. Then both queries load again, so the next answer is the server's own.
 */
export function applySeries(queryClient: QueryClient, series: Series): void {
  queryClient.setQueryData<SeriesResponse>(
    seriesKey(series.id),
    (old) => old && { series, markdown: old.markdown },
  );
  reloadSeries(queryClient, series);
}

/**
 * Whether a job's change moves its client's series counts: a new job that is in a series, or a
 * known one that joined, left or moved to another series of its client. `known` is the job as
 * cached before. (A job's client never changes: its id comes from its folder's path.)
 */
export function changesSeriesCounts(known: Job | undefined, job: Job): boolean {
  return (known?.seriesId ?? null) !== job.seriesId;
}
