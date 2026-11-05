// The job sheet's place in the address: `?job=<id>` on the Jobs page, a client's page and a series
// page. The address is the truth about which sheet is open, so a reload keeps it, Back closes it,
// and a link can point straight at a job.
//
// - Opening pushes a history entry (and marks it as the sheet's own), so Back closes the sheet.
// - Walking to another job (↑ ↓) replaces the entry: Back does not step through the jobs.
// - Closing goes back when the entry is the sheet's own, so Back after closing does not reopen
//   it. An entry that is not (a reload of a pasted link) has nothing of ours behind it: closing
//   replaces it with the same page without `job`.
//
// None of these scroll the page: the list stays where it is behind the sheet.

import type { AnyRouter } from '@tanstack/react-router';

/** The optional `job` search parameter the pages with a job list share. */
export interface JobSheetSearch {
  job?: string;
}

/**
 * `validateSearch` of those pages: keeps `job` when it is a non-empty string and drops it
 * otherwise (a number, a list, nothing).
 */
export function validateJobSearch(search: Record<string, unknown>): JobSheetSearch {
  const { job } = search;
  return typeof job === 'string' && job !== '' ? { job } : {};
}

/** The id of the job in a page's search, or `null`. Reads any search, valid or not. */
export function jobIdOf(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { job } = search as { job?: unknown };
  return typeof job === 'string' && job !== '' ? job : null;
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** The history entry was pushed by the job sheet when it opened: going back closes it. */
    jobSheet?: boolean;
  }
}

/**
 * A change of the current page's search with `job` set to `id`, or taken out with `null`; every
 * other parameter stays. The router types `search` from the route in `to`, and with no `to` (the
 * page we are on) it can't know the route, so the function is handed over untyped.
 */
function setJob(id: string | null): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { job: _was, ...rest } = search;
    return id === null ? rest : { ...rest, job: id };
  };
  return change as never;
}

/** Whether the entry the router stands on is one the sheet pushed when it opened. */
export function isSheetEntry(router: AnyRouter): boolean {
  return router.history.location.state.jobSheet === true;
}

/** Opens the sheet on a job: a new history entry, marked as the sheet's. */
export function openJobSheet(router: AnyRouter, jobId: string): Promise<void> {
  return router.navigate({
    search: setJob(jobId),
    state: (prev) => ({ ...prev, jobSheet: true }),
    resetScroll: false,
  });
}

/**
 * Shows another job in the open sheet (↑ ↓): the entry is replaced, and stays the sheet's own if it
 * was, so closing still goes back to before the sheet.
 */
export function moveJobSheet(router: AnyRouter, jobId: string): Promise<void> {
  const own = isSheetEntry(router);
  return router.navigate({
    search: setJob(jobId),
    state: (prev) => ({ ...prev, jobSheet: own }),
    replace: true,
    resetScroll: false,
  });
}

/** Takes `job` out of the address by replacing the entry (an unknown id, or an entry not ours). */
export function dropJobParam(router: AnyRouter): Promise<void> {
  return router.navigate({
    search: setJob(null),
    state: (prev) => ({ ...prev, jobSheet: false }),
    replace: true,
    resetScroll: false,
  });
}

/**
 * Closes the sheet: back, when the sheet pushed the entry; otherwise the same page without `job`,
 * replacing the entry.
 */
export function closeJobSheet(router: AnyRouter): void {
  if (isSheetEntry(router)) {
    router.history.back();
    return;
  }
  void dropJobParam(router);
}
