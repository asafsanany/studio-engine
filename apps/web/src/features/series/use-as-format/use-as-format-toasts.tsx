import { toast } from 'sonner';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';
import type { UseAsFormatTarget } from './use-as-format-dialog';

/**
 * The toast id of one kind of message about a series' format: the newest replaces the one before.
 * Each kind has its own id, so a message that reuses the id of one that is closing is not swallowed
 * by it.
 */
export const formatToastId = (kind: 'done' | 'refused', seriesId: string) =>
  `use-as-format:${kind}:${seriesId}`;

/**
 * "The format of the series X is being learned from J." Both names keep their own direction. There
 * is no Undo: the server undoes only the start of a series, and the old format is kept in the
 * series' history.
 */
export function announceFormatChanging(
  target: Pick<UseAsFormatTarget, 'seriesId' | 'seriesName' | 'jobName'>,
): void {
  toast(
    <>
      The format of the series <bdi>{target.seriesName}</bdi> is being learned from{' '}
      <bdi>{target.jobName}</bdi>.
    </>,
    { id: formatToastId('done', target.seriesId) },
  );
}

/** The server said no (409: not a ready episode, the series or the client's style is being learned), or could not be reached. */
export function announceFormatRefused(
  target: Pick<UseAsFormatTarget, 'seriesId'>,
  message: string,
): void {
  toast.error("Couldn't use this episode as the format", {
    id: formatToastId('refused', target.seriesId),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}
