import { SERIES_UNDO_MS, type Series } from '@studio/shared';
import { toast } from 'sonner';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';
import { UNDO_BUTTON_CLASS } from '@/features/jobs/use-look/use-look-toasts';
import type { StartSeriesTarget } from './start-series-dialog';

/**
 * The toast id of one kind of message about a client's series being started: the newest replaces
 * the one before (so Undo is always the newest series'). Each kind has its own id: Undo closes its
 * message when it is pressed, and a message that reuses the id of one that is closing is swallowed
 * by it.
 */
export const startSeriesToastId = (
  kind: 'started' | 'refused' | 'undone' | 'undo-refused',
  clientId: string,
) => `start-series:${kind}:${clientId}`;

/**
 * "Started the series X. Its format is being learned from J." with Undo, which runs `onUndo`. It
 * stays for as long as Undo works (`SERIES_UNDO_MS`, 10 s), longer than sonner's four seconds.
 * Both names keep their own direction.
 */
export function announceSeriesStarted(
  target: Pick<StartSeriesTarget, 'clientId' | 'jobName'>,
  series: Pick<Series, 'name'>,
  onUndo: () => void,
): void {
  toast(
    <>
      Started the series <bdi>{series.name}</bdi>. Its format is being learned from{' '}
      <bdi>{target.jobName}</bdi>.
    </>,
    {
      id: startSeriesToastId('started', target.clientId),
      duration: SERIES_UNDO_MS,
      action: { label: 'Undo', onClick: onUndo },
      classNames: { actionButton: UNDO_BUTTON_CLASS },
    },
  );
}

/** The server said no (409: not ready, in a series already, a pass is running), or could not be reached. */
export function announceSeriesRefused(
  target: Pick<StartSeriesTarget, 'clientId'>,
  message: string,
): void {
  toast.error("Couldn't start the series", {
    id: startSeriesToastId('refused', target.clientId),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}

/** Undo worked: the series is gone and so is its folder. */
export function announceSeriesUndone(
  target: Pick<StartSeriesTarget, 'clientId'>,
  series: Pick<Series, 'name'>,
): void {
  toast(
    <>
      Took back the series <bdi>{series.name}</bdi>.
    </>,
    { id: startSeriesToastId('undone', target.clientId) },
  );
}

/** Undo was refused (409: too late) or could not be reached. */
export function announceSeriesUndoRefused(
  target: Pick<StartSeriesTarget, 'clientId'>,
  message: string,
): void {
  toast.error("Couldn't take back the series", {
    id: startSeriesToastId('undo-refused', target.clientId),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}
