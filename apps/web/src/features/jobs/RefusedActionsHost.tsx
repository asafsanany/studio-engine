import type { Job } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { ACTION_ERROR_MS } from './cells/ActionError';
import { type RefusableAction, type RefusedAction, watchRefusedActions } from './row-refusals';

/** What comes after "Couldn't" for each action, before the job: "Couldn't hold <job>". */
const VERBS = {
  start: 'start',
  hold: 'hold',
  release: 'release',
  resume: 'resume',
  retry: 'retry',
  deliver: 'deliver',
  undeliver: 'undo the delivery of',
  unpay: 'undo the payment of',
} as const satisfies Record<RefusableAction, string>;

/**
 * The title of the note: which job, as "<Client> / <Job>". The names are the person's own and may
 * be Hebrew or mixed, so each sits in its own `<bdi>` and keeps its own direction; without it the
 * slash between two Hebrew names would flip them. A job that has left the list is "this job".
 */
export function refusalTitle(action: RefusableAction, job: Job | undefined) {
  return (
    <>
      Couldn&apos;t {VERBS[action]}{' '}
      {job === undefined ? (
        'this job'
      ) : (
        <>
          <bdi>{job.client}</bdi> / <bdi>{job.name}</bdi>
        </>
      )}
    </>
  );
}

/** The toast id of a refusal: asking again for the same thing replaces the note instead of stacking. */
export const refusalToastId = ({ action, jobId }: Pick<RefusedAction, 'action' | 'jobId'>) =>
  `refused:${action}:${jobId}`;

/** Shows a refusal at page level: the job, then the reason in the server's words. */
export function announceRefusal(refused: RefusedAction, job: Job | undefined): void {
  toast.error(refusalTitle(refused.action, job), {
    id: refusalToastId(refused),
    description: refused.message,
    // As long as the tooltip it stands in for.
    duration: ACTION_ERROR_MS,
  });
}

interface RefusedActionsHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /**
   * Draw the app's messages (the toaster) here too. On by default: the Mac's Jobs, client and
   * series pages each mount one. The phone shell mounts the one toaster of the phone layout, so a
   * page under it passes `false` and only watches.
   */
  toaster?: boolean;
}

/**
 * Tells the person why a row action was refused when the row is no longer on the page to say so.
 *
 * A row explains a refusal in a tooltip under its buttons (`ActionError`). The list is sorted by
 * Last updated and the jobs keep changing, so the row can be on another page by the time the
 * server answers; then the reason would be shown nowhere. This host watches the refusals no row is
 * left to show (`watchRefusedActions`) and puts each in a toast: which job, and the server's
 * reason. A refusal whose row is still there keeps its tooltip and gets no toast.
 *
 * Mount it once, on the Jobs page. It watches only while the page is open. It also mounts the
 * toaster that draws every message of the page (Undo included), unless `toaster` is `false`.
 */
export function RefusedActionsHost({ jobs, toaster = true }: RefusedActionsHostProps) {
  const queryClient = useQueryClient();

  // The latest list for the watcher, without restarting it whenever the list changes.
  const latest = useRef(jobs);
  useEffect(() => {
    latest.current = jobs;
  });

  useEffect(
    () =>
      watchRefusedActions(queryClient, (refused) =>
        announceRefusal(
          refused,
          latest.current?.find((job) => job.id === refused.jobId),
        ),
      ),
    [queryClient],
  );

  // No close ×: a message is its text and, where it has one, Undo, as on the design boards. Every
  // message goes away on its own (CVP-208).
  return toaster ? <Toaster /> : null;
}
