import type { Series } from '@studio/shared';
import { useRetrySeries } from '@/data';
import { StyleDocument } from '@/features/style/StyleDocument';
import { StyleStatusLine } from '@/features/style/StyleStatusLine';
import type { StyleStatus } from '@/features/style/style-status';
import { seriesDay } from './series-text';

/** What a failed pass says when the server gave no reason. */
export const FAILED_FORMAT_TEXT = "The format couldn't be made.";

/**
 * The one line above series.md that says what the series is doing, or `null` when nothing is going
 * on. While a `series` pass learns the format it names the job ("Learning the format from <job>…");
 * a pass that only reads review notes has no job to name. A failed series says why, with Retry.
 */
export function formatStatus(
  series: Pick<Series, 'state' | 'error' | 'pass' | 'formatJob'>,
): StyleStatus | null {
  if (series.state === 'failed') {
    return { kind: 'error', text: series.error ?? FAILED_FORMAT_TEXT, retry: true };
  }
  if (series.state !== 'learning') return null;
  if (series.pass?.kind === 'series-read') {
    return { kind: 'busy', text: 'Adding the review notes to the format…' };
  }
  const job = series.pass?.job ?? series.formatJob;
  return { kind: 'busy', text: `Learning the format from ${job}…`, job };
}

/**
 * The series page's Format tab: series.md, rendered as the Style page renders style.md, in a 680 px
 * column under "series.md · learned 21 Oct from <job>"; the status line (learning, or failed with
 * Retry) above the document, or alone while there is no document yet. Retry asks again; a refusal
 * (the server's words) takes the failure's place.
 */
export function SeriesFormat({ series, markdown }: { series: Series; markdown: string | null }) {
  const retry = useRetrySeries();
  const found = formatStatus(series);
  const status =
    found?.kind === 'error' && retry.error !== null
      ? { ...found, text: retry.error.message }
      : found;

  return (
    <article className="flex max-w-[680px] flex-col gap-3 leading-[1.6]">
      {markdown !== null && (
        <span className="text-[13px] text-muted-foreground">
          series.md · learned {seriesDay(series.updatedAt)} from <bdi>{series.formatJob}</bdi>
        </span>
      )}
      {status && (
        <StyleStatusLine
          status={status}
          onRetry={() => retry.mutate(series.id)}
          retrying={retry.isPending}
        />
      )}
      {markdown !== null ? (
        <StyleDocument markdown={markdown} />
      ) : (
        status === null && <p className="text-muted-foreground">No series.md yet.</p>
      )}
    </article>
  );
}
