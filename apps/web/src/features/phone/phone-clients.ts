import { isArchived, type Job } from '@studio/shared';
import { matchingJobs } from '@/features/jobs/use-jobs-list';

// The rules of the Clients pages on the phone (boards MClients, MClient, MStyle) that are not
// drawing. The data is the Mac's (`summarizeClients`, `filterClients`, `clientsBodyState`, the
// client-scoped `matchingJobs`); what is the phone's is below.

/**
 * The jobs a client's page lists, last updated first: that client's, archived ones only with Show
 * archived on. The status tabs and the search of the Jobs page do not apply there. `ordered` is
 * the whole job list in `lastUpdatedOrder`.
 */
export function clientJobs(
  ordered: readonly Job[],
  clientId: string,
  showArchived: boolean,
): readonly Job[] {
  return matchingJobs(ordered, { tab: 'all', search: '', showArchived, clientId });
}

/**
 * The line under a client's jobs (board MClient): "2 archived · Show" while they are hidden, and
 * "2 archived shown · Hide archived" while they are shown.
 */
export interface ClientArchivedLine {
  /** How many archived jobs the client has. */
  count: number;
  /** Whether they are shown now (the button then hides them). */
  shown: boolean;
}

/** The archive line of a client's page, or `null` when the client has no archived job. */
export function clientArchivedLine(
  ordered: readonly Job[],
  clientId: string,
  showArchived: boolean,
): ClientArchivedLine | null {
  const count = ordered.filter((job) => job.clientId === clientId && isArchived(job)).length;
  return count === 0 ? null : { count, shown: showArchived };
}

/** The part of the line before its button: "2 archived ·" or "2 archived shown ·". */
export function clientArchivedLead(line: ClientArchivedLine): string {
  return `${line.count} archived${line.shown ? ' shown' : ''} ·`;
}

/** The line's button: "Show", or "Hide archived". */
export function clientArchivedButton(line: ClientArchivedLine): string {
  return line.shown ? 'Hide archived' : 'Show';
}

/**
 * "last job" is followed by the time in running text, so "Just now" and "Yesterday" lose their
 * capital: "last job just now" (board MClients). The other forms ("3 min ago") are lower case
 * already.
 */
export function inSentence(relative: string): string {
  return relative.charAt(0).toLowerCase() + relative.slice(1);
}
