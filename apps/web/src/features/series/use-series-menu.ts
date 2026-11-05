import type { Job, SeriesSummary } from '@studio/shared';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useClientSeries, useSeriesEnabled, useSetJobSeries } from '@/data';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';
import type { SeriesMenuContext } from './series-menu';
import { useOnSeriesPage } from './series-page-context';

/** Where a series' own page is (route `/clients/$clientId/series/$seriesId`). */
export function seriesPagePath(clientId: string, seriesId: string): string {
  return `/clients/${encodeURIComponent(clientId)}/series/${encodeURIComponent(seriesId)}`;
}

/** The server refused to put the job in a series or take it out (409: its edit has started). */
export function announceJobSeriesRefused(job: Pick<Job, 'id'>, message: string): void {
  toast.error("Couldn't change the series", {
    id: `set-job-series:${job.id}`,
    description: message,
    duration: ACTION_ERROR_MS,
  });
}

/**
 * What a job's menu needs of series when it opens: whether they are on, the client's series (the
 * query asks nothing while they are off), and what the items do: choosing in the Series submenu
 * (`PUT /api/jobs/:id/series`, a refusal said in a message) and "Open the series" (the series'
 * page). Read where the menu's content is, which Radix mounts only while the menu is open, not for
 * every row when the page loads.
 */
export function useSeriesMenu(job: Job): SeriesMenuContext {
  const enabled = useSeriesEnabled();
  const clientSeries = useClientSeries(job.clientId).data;
  const setJobSeries = useSetJobSeries();
  const onSeriesPage = useOnSeriesPage();
  // Outside a router (a bare render in a test) there is nowhere to go.
  const router = useRouter({ warn: false });
  return {
    enabled,
    clientSeries: clientSeries ?? [],
    onSeriesPage,
    setJobSeries: (seriesId) => {
      setJobSeries.mutateAsync({ jobId: job.id, seriesId }).catch((error: unknown) => {
        announceJobSeriesRefused(job, error instanceof Error ? error.message : String(error));
      });
    },
    openSeries: (series: SeriesSummary) => {
      router?.history.push(seriesPagePath(job.clientId, series.id));
    },
  };
}
