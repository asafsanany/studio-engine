import { episodeFrom, type Job } from '@studio/shared';
import type { ReactNode } from 'react';
import { useSeriesEnabled } from '@/data';
import { useJobSeries } from './SeriesMark';
import { useOnSeriesPage } from './series-page-context';

const SEPARATOR = ' · ';

/**
 * An editing episode's detail with "follows episode N" after the step: "Cut · graphics 2/5 ·
 * follows episode 5 · ~4 min left", "Editing · follows episode 5" (`step` is the step label the
 * text starts with, "" when it has none).
 */
export function followsEpisodeText(text: string, step: string, episode: number): string {
  const follows = `follows episode ${episode}`;
  if (step !== '' && text.startsWith(step)) {
    return `${step}${SEPARATOR}${follows}${text.slice(step.length)}`;
  }
  return `${text}${SEPARATOR}${follows}`;
}

interface FollowsEpisodeProps {
  job: Job;
  /** The detail text the row would show without the series. */
  text: string;
  /** The step label at the start of `text` (see {@link followsEpisodeText}). */
  step: string;
  /** Draws the (possibly longer) text. */
  children: (text: string) => ReactNode;
}

/**
 * Gives the detail of an editing episode (Series plan §6): when the series' format job has an
 * episode number in its name, the line says which episode the edit follows. The caller renders this
 * only for an editing job that is in a series; while series are off, and on a series' own page
 * (board SeriesPage), the line stays as it is.
 */
export function FollowsEpisode({ job, text, step, children }: FollowsEpisodeProps) {
  const enabled = useSeriesEnabled();
  const series = useJobSeries(job);
  const onSeriesPage = useOnSeriesPage();
  const episode = series === null ? null : episodeFrom(series.formatJob);
  if (!enabled || onSeriesPage || episode === null) return children(text);
  return children(followsEpisodeText(text, step, episode));
}
