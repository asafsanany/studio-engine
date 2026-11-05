import type { Series } from '@studio/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Layers2 } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, api, jobsUnreachable, useJobs, useSeries } from '@/data';
import { healthQueryOptions } from '@/data/health-query';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { JobsListSection } from '@/features/jobs/JobsListSection';
import { SeriesFormat } from '@/features/series/SeriesFormat';
import { SeriesPageScope } from '@/features/series/series-page-context';
import { episodesText, seriesDay } from '@/features/series/series-text';
import { Bidi } from '@/lib/bidi';
import { jobsUiStore } from '@/stores/jobs-ui';
import { PAGE_LINK_CLASS } from './NotFoundPage';

export type SeriesTab = 'episodes' | 'format';

/** A series the engine does not hold: a mistyped address, one that was undone, or series being off. */
export function NoSuchSeries({ clientId }: { clientId: string }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-md border text-center">
      <p className="font-medium">No such series.</p>
      <Link to="/clients/$clientId" params={{ clientId }} className={PAGE_LINK_CLASS}>
        Back to the client
      </Link>
    </div>
  );
}

/** The header's place while the series is on its way: shown only once the wait is noticeable. */
function SeriesHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <Skeleton className="size-10 rounded-[10px] motion-reduce:animate-none" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-72 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * The icon box, the series' name and "4 episodes · format from <job> · started 21 Oct". The
 * episode count is left out until the job list has loaded (the page counts the jobs it lists).
 */
function SeriesHeader({ series, episodes }: { series: Series; episodes: number | undefined }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted"
      >
        <Layers2 className="size-5" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Bidi as="h1" className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
          {series.name}
        </Bidi>
        <p className="text-muted-foreground">
          {episodes !== undefined && `${episodesText(episodes)} · `}format from{' '}
          <bdi>{series.formatJob}</bdi> · started {seriesDay(series.createdAt)}
        </p>
      </div>
    </div>
  );
}

/** What the Episodes tab says under the list: what a right-click on an episode offers. */
const EPISODES_HINT =
  'Right-click an episode to make it the format, or to take it out of the series before its edit starts.';

/** A loaded series: the header, the Episodes | Format tabs and the tab that is open. */
function SeriesView({
  clientId,
  series,
  markdown,
  initialTab,
}: {
  clientId: string;
  series: Series;
  markdown: string | null;
  initialTab: SeriesTab;
}) {
  const [tab, setTab] = useState<SeriesTab>(initialTab);
  const { data: jobs } = useJobs();
  const episodes = jobs?.filter((job) => job.seriesId === series.id).length;

  return (
    <div className="flex flex-col gap-5">
      <SeriesHeader series={series} episodes={episodes} />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value === 'format' ? 'format' : 'episodes')}
        className="gap-5"
      >
        <TabsList variant="ghost" aria-label="Series">
          <TabsTrigger value="episodes" count={episodes}>
            Episodes
          </TabsTrigger>
          <TabsTrigger value="format">Format</TabsTrigger>
        </TabsList>
        <TabsContent value="episodes" className="flex flex-col gap-1">
          <div className="flex flex-col gap-4">
            {/* Every row here is an episode of this series: "Format" for the format job, no Layers2 mark. */}
            <SeriesPageScope value>
              <JobsListSection clientId={clientId} seriesId={series.id} />
            </SeriesPageScope>
          </div>
          {episodes !== 0 && (
            <p className="px-3 text-[13px] text-muted-foreground">{EPISODES_HINT}</p>
          )}
        </TabsContent>
        <TabsContent value="format">
          <SeriesFormat series={series} markdown={markdown} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * A series' page: its name and what it holds, then two ghost tabs. Episodes is the Jobs list
 * (the client's own, rows, menu and dialogs included) narrowed to the series; Format is series.md,
 * rendered like the Style page renders style.md, with the line that says it is being learned or
 * failed (and Retry). Until the series has loaded the page is empty, with a skeleton after a
 * moment, or "Can't reach the engine."; a series the engine does not hold, one of another client,
 * or any series while the Series switch is off is "No such series."
 */
export function SeriesPage({
  clientId,
  seriesId,
  initialTab = 'episodes',
}: {
  clientId: string;
  seriesId: string;
  /** The tab the page opens on (the board of the Format tab opens on Format). */
  initialTab?: SeriesTab;
}) {
  const query = useSeries(seriesId);
  const { data, error } = query;
  // While series are off nothing is asked, so the page would wait for ever: the health answer says so.
  const health = useQuery(healthQueryOptions(api));
  const off = health.data?.series === false;
  const unknown =
    off ||
    (error instanceof ApiError && error.status === 404) ||
    (data !== undefined && data.series.clientId !== clientId);
  const unreachable =
    !unknown && data === undefined && (jobsUnreachable(query) || jobsUnreachable(health));
  const showSkeleton = useDelayedFlag(
    data === undefined && !unknown && !unreachable,
    SKELETON_DELAY_MS,
  );

  // The list's page number is shared with the Jobs page: a series' page starts on its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seriesId` is the trigger, not something the effect reads
  useLayoutEffect(() => {
    jobsUiStore.getState().setPageIndex(0);
  }, [seriesId]);

  if (unknown) return <NoSuchSeries clientId={clientId} />;
  return (
    <TooltipProvider>
      {data !== undefined ? (
        <SeriesView
          key={data.series.id}
          clientId={clientId}
          series={data.series}
          markdown={data.markdown}
          initialTab={initialTab}
        />
      ) : unreachable ? (
        <p role="alert" className="text-muted-foreground">
          Can't reach the engine.
        </p>
      ) : (
        showSkeleton && <SeriesHeaderSkeleton />
      )}
    </TooltipProvider>
  );
}
