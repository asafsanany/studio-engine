import type { SeriesSummary } from '@studio/shared';

// The words of the client page's Series list and the series page (Series plan §6, boards
// SeriesClient, SeriesPage and SeriesFormat). Plain functions so the sentences can be tested.

/**
 * "21 Oct": the day a series started or its format was learned, written as the archive writes its
 * day (delivery-text.ts), on the browser's calendar.
 */
export { archivedDay as seriesDay } from '@/features/jobs/delivery-text';

/** "1 episode", "4 episodes". */
export function episodesText(count: number): string {
  return `${count} ${count === 1 ? 'episode' : 'episodes'}`;
}

/** "1 series", "2 series": the client header's count. */
export function seriesCountText(count: number): string {
  return `${count} series`;
}

/**
 * The series of the client page, newest episode first (the order of the Clients page's last job),
 * a series with no episode last; the name breaks a tie, then the id so the order never depends on
 * what order the server happened to send them in.
 */
export function orderSeries(series: readonly SeriesSummary[]): SeriesSummary[] {
  return [...series].sort((a, b) => {
    const newest = timeOf(a.lastEpisodeAt);
    const other = timeOf(b.lastEpisodeAt);
    if (newest !== other) return newest > other ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function timeOf(iso: string | null): number {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}
