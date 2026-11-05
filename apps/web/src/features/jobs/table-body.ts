import type { Job } from '@studio/shared';

/** What the Jobs list shows (and, since the Clients table borrows this, what its body shows). */
export type TableBodyState =
  /** The first answer has not come yet: skeleton rows. */
  | 'loading'
  /** The first answer never came (the server cannot be reached): an inline message and a retry. */
  | 'unreachable'
  /** The list is empty, whatever the tab and the search say: "No jobs yet." */
  | 'empty'
  /** There are jobs, but the tab and the search leave none: "No matching jobs." */
  | 'no-match'
  /** At least one job to show. */
  | 'rows';

export interface TableBodyInput {
  /** The job list from `useJobs()`: `undefined` until the first answer. */
  jobs: readonly Job[] | undefined;
  /** The first load failed. Only read while there is no list: a list on screen is never replaced. */
  failed: boolean;
  /** Jobs left after the tab and the search, across all pages. */
  matching: number;
}

/**
 * Which of the body's states applies. A list that has arrived always wins over `failed`, so a
 * refetch that fails later (the server went away after the page had loaded) leaves the list as
 * it is; live updates resume when the event stream reconnects and reloads the list.
 */
export function tableBodyState({ jobs, failed, matching }: TableBodyInput): TableBodyState {
  if (jobs === undefined) return failed ? 'unreachable' : 'loading';
  if (jobs.length === 0) return 'empty';
  return matching === 0 ? 'no-match' : 'rows';
}

/**
 * Whether the range and page controls under the list or table make sense in this state. The Jobs
 * list also needs more than one page before it shows them.
 */
export function showsPagination(state: TableBodyState): boolean {
  return state === 'rows' || state === 'no-match';
}
