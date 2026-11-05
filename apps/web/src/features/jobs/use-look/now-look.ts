import type { ClientStyleResponse } from '@studio/shared';

/**
 * What the dialog's "Now" still shows (the current look of the client):
 *   loading  the client's style is on its way, so which job it comes from is not known yet
 *   unknown  the style could not be read: no picture, no source
 *   files    the style was made from the client's files, not from a job: a placeholder
 *   job      the still of the job it was learned from (`name` is `null` when that job has left the list)
 */
export type NowLook =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'files' }
  | { kind: 'job'; jobId: string; name: string | null };

/** The "Now" side of the dialog, from the client's style (as far as it is read) and the job list. */
export function nowLookOf(
  style: { data?: Pick<ClientStyleResponse, 'sourceJobId'>; isError: boolean },
  jobs: readonly { id: string; name: string }[] | undefined,
): NowLook {
  if (style.data === undefined) return style.isError ? { kind: 'unknown' } : { kind: 'loading' };
  const { sourceJobId } = style.data;
  if (sourceJobId === null) return { kind: 'files' };
  return {
    kind: 'job',
    jobId: sourceJobId,
    name: jobs?.find((job) => job.id === sourceJobId)?.name ?? null,
  };
}
