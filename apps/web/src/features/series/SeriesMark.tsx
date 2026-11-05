import type { Job, SeriesSummary } from '@studio/shared';
import { Layers2 } from 'lucide-react';
import { useClientSeries, useSeriesEnabled } from '@/data';
import { HoverMarker } from '@/features/jobs/cells/HoverMarker';
import { useOnSeriesPage } from './series-page-context';

/** The series a job is in, from its client's series (`null` until they are loaded, or if it is in none). */
export function useJobSeries(job: Pick<Job, 'clientId' | 'seriesId'>): SeriesSummary | null {
  const { data } = useClientSeries(job.clientId);
  if (job.seriesId === null) return null;
  return data?.find((series) => series.id === job.seriesId) ?? null;
}

/** What the mark's tooltip says: a sentence, with the series' name (`name`) left to the caller's `<bdi>`. */
export interface SeriesMarkText {
  /** The words before the name: "Episode 6 of ". */
  lead: string;
  /** The series' name, or `null` while the client's series are not loaded. */
  name: string | null;
  /** Whether the job is the series' format job. */
  format: boolean;
}

/**
 * The tooltip of the Layers2 mark (Series plan §6): "Episode 6 of מיתוס או אמת", "The format of the
 * series מיתוס או אמת", and, for a job that joined by hand and has no number in its name, "In the
 * series מיתוס או אמת". Until the series is known the name is left out: "Episode 6 of a series".
 */
export function seriesMarkText(
  job: Pick<Job, 'id' | 'episode'>,
  series: Pick<SeriesSummary, 'name' | 'formatJobId'> | null,
): SeriesMarkText {
  if (series === null) {
    return {
      lead: job.episode === null ? 'In a series' : `Episode ${job.episode} of a series`,
      name: null,
      format: false,
    };
  }
  if (series.formatJobId === job.id) {
    return { lead: 'The format of the series ', name: series.name, format: true };
  }
  const lead = job.episode === null ? 'In the series ' : `Episode ${job.episode} of `;
  return { lead, name: series.name, format: false };
}

/**
 * What the phone's lines say about the series a job is in: "Episode 6 of <series>" (the Review
 * header, the job sheet's subtitle), or `null` while series are off, the job is in none, or the
 * client's series have not arrived (a line never names a series it can't).
 */
export function useSeriesText(job: Pick<Job, 'id' | 'clientId' | 'seriesId' | 'episode'>) {
  const enabled = useSeriesEnabled();
  const series = useJobSeries(job);
  if (!enabled || series === null) return null;
  return seriesMarkText(job, series);
}

/**
 * The mark of an episode in the Jobs list: a muted 14 px Layers2 right after the job's name (and
 * its note and effort marks), before the client's name. Hovering or focusing it says which episode
 * of which series it is. Only a job that is in a series has one (the caller checks `job.seriesId`).
 * Nothing shows while series are off (a job can keep its series after the switch is turned off),
 * until the client's series have arrived, or when they don't hold this one (it was undone or its
 * folder deleted), so the row never shows a series it can't name.
 *
 * On a series' own page (`SeriesPageScope`) every row is an episode, so the icon is left out and
 * the format job says "Format" in muted text after its name instead (board SeriesPage).
 */
export function SeriesMark({ job }: { job: Job }) {
  const enabled = useSeriesEnabled();
  const series = useJobSeries(job);
  const onSeriesPage = useOnSeriesPage();
  if (!enabled || series === null) return null;
  const { lead, name, format } = seriesMarkText(job, series);
  if (onSeriesPage) {
    return format ? (
      <span className="ml-1 shrink-0 text-[13px] text-muted-foreground">Format</span>
    ) : null;
  }
  return (
    <HoverMarker icon={Layers2} label={`${lead}${name ?? ''}`}>
      {lead}
      {name !== null && <bdi>{name}</bdi>}
    </HoverMarker>
  );
}
