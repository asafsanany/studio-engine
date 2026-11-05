import type { Job } from '@studio/shared';
import { useClientSeries, useSeriesEnabled } from '@/data';

/**
 * The name of the series a job in Review is an episode of, or `null` when the notes' "Series"
 * toggle must not show: series are off (or the server has not said yet), the job is in no series,
 * or the client's series list does not hold its series (yet). A note can only go into a series
 * the server knows: PATCH `addToSeries` answers 422 for any other job.
 */
export function useEpisodeSeriesName(job: Pick<Job, 'clientId' | 'seriesId'>): string | null {
  const enabled = useSeriesEnabled();
  const { data } = useClientSeries(job.clientId);
  if (!enabled || job.seriesId === null) return null;
  return data?.find((series) => series.id === job.seriesId)?.name ?? null;
}
