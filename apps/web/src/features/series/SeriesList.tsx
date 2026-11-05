import { episodeFrom, relativeTime, type SeriesSummary } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Layers2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { ROW_LAYOUT_CLASSES } from '@/features/jobs/JobRow';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { episodesText, orderSeries } from './series-text';

/** The small muted title over a list on the client's page ("Series", "Jobs"): 13 px, level with the rows' text. */
export const SECTION_HEADING_CLASS = 'px-3 text-[13px] font-medium text-muted-foreground';

/**
 * What a series' row says after its name: "4 episodes · format from episode 5". A format job whose
 * name has no number is named instead (in its own direction). While the format is being learned
 * the row says so, and a failed one says that; the series page has the reason.
 */
export function SeriesMeta({ series }: { series: SeriesSummary }): ReactNode {
  const count = episodesText(series.episodeCount);
  if (series.state === 'learning') return `${count} · learning the format`;
  if (series.state === 'failed') return `${count} · format failed`;
  const episode = episodeFrom(series.formatJob);
  return (
    <>
      {count} · format from{' '}
      {episode === null ? <bdi>{series.formatJob}</bdi> : `episode ${episode}`}
    </>
  );
}

/**
 * "12 min ago" in muted text, without the exact-time tooltip of `RelativeTime`: the whole row is a
 * link, and a control inside a link could not be focused or clicked on its own.
 */
function LastEpisodeTime({ iso }: { iso: string }) {
  const text = relativeTime(iso, useNow());
  return text === '' ? null : <time dateTime={iso}>{text}</time>;
}

/**
 * One series: a row of the Jobs list's own grid (the icon, the name, what it holds, when its last
 * episode arrived, a chevron) that opens the series page. A hover takes the quiet row background,
 * like a job's row; a keyboard focus does too, with the soft grey ring.
 */
function SeriesListItem({ clientId, series }: { clientId: string; series: SeriesSummary }) {
  return (
    <li>
      <Link
        to="/clients/$clientId/series/$seriesId"
        params={{ clientId, seriesId: series.id }}
        className={cn(
          ROW_LAYOUT_CLASSES,
          'cursor-pointer text-foreground outline-none transition-colors duration-150 ease-in-out hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/35',
        )}
      >
        <Layers2 aria-hidden="true" className="size-4 text-muted-foreground" />
        <Bidi className="font-medium">{series.name}</Bidi>
        <span className="text-[13px] whitespace-nowrap text-muted-foreground">
          <SeriesMeta series={series} />
        </span>
        <span className="text-right text-[13px] whitespace-nowrap text-muted-foreground">
          {series.lastEpisodeAt !== null && <LastEpisodeTime iso={series.lastEpisodeAt} />}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 place-self-center text-muted-foreground"
        />
      </Link>
    </li>
  );
}

/**
 * The client page's quiet "Series" list above the jobs: one row per series, the one with the
 * newest episode first, each opening its page. The caller shows it only when the client has a
 * series and series are on.
 */
export function SeriesList({
  clientId,
  series,
}: {
  clientId: string;
  series: readonly SeriesSummary[];
}) {
  return (
    <section aria-labelledby="client-series" className="flex flex-col gap-2">
      <h2 id="client-series" className={SECTION_HEADING_CLASS}>
        Series
      </h2>
      <ul aria-label="Series" className="flex flex-col gap-0.5">
        {orderSeries(series).map((one) => (
          <SeriesListItem key={one.id} clientId={clientId} series={one} />
        ))}
      </ul>
    </section>
  );
}
