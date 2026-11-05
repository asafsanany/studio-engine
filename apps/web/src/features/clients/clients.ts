import { type ClientInstagramSummary, type ClientRow, initials } from '@studio/shared';
import { matchesText } from '../jobs/filtering';
import { compareSortValues, type SortValue, toMs } from '../jobs/sorting';
import type { TableBodyState } from '../jobs/table-body';
import { instagramRowKind } from './client-instagram';

/** One client, as the Clients page lists it: a row of `GET /api/clients`, ready to show. */
export interface ClientSummary {
  /** The server's id for the client folder (see `Job.clientId`); it is what the URL carries. */
  clientId: string;
  /** The folder's name, as the file system lists it. */
  name: string;
  /** Up to two letters, the same as the Jobs table's avatar. */
  initials: string;
  /** How many jobs the engine knows for the client; 0 for a client that has none yet. */
  jobCount: number;
  /** When the newest job arrived (its `addedAt`, as ISO text); `null` for a client with no jobs. */
  lastJobAt: string | null;
  /**
   * The names of the editors the client is assigned to (admin only, from the team); an empty list is
   * a client for the admin alone. Left out while the team is not known and for an editor.
   */
  assignedTo?: readonly string[];
  /**
   * The client's Instagram in short (Clients × Instagram, L1): `null` for a client with no account,
   * left out while the switch is off (the list was sent without it).
   */
  instagram?: ClientInstagramSummary | null;
}

/** The editors of a client by its id, or `undefined` while the team is not known. */
export type AssignedLookup = (clientId: string) => readonly string[] | undefined;

/** What each column sorts by: the name as text, the others as numbers. */
export const CLIENT_SORT_VALUE: Readonly<
  Record<'client' | 'jobs' | 'last', (client: ClientSummary) => SortValue>
> = {
  client: (client) => client.name,
  jobs: (client) => client.jobCount,
  // A client with no jobs has had none at all: older than any job, so last when newest first.
  last: (client) => (client.lastJobAt === null ? Number.NEGATIVE_INFINITY : toMs(client.lastJobAt)),
};

/**
 * The clients of the list the server sent, newest last job first, then by name; a client with no
 * jobs comes after those that have. The id breaks a tie so the answer never depends on the order
 * the server (or an event) happened to leave the list in.
 *
 * `accountsFirst` (the Clients table while Clients × Instagram is on, L1) puts the clients with no
 * Instagram account (or none that can be read) after every client that has one, each group in that
 * order.
 */
export function summarizeClients(
  rows: readonly ClientRow[],
  assignedTo?: AssignedLookup,
  { accountsFirst = false }: { accountsFirst?: boolean } = {},
): ClientSummary[] {
  const clients = rows.map((row): ClientSummary => {
    const summary: ClientSummary = {
      clientId: row.clientId,
      name: row.client,
      initials: initials(row.client),
      jobCount: row.jobs,
      lastJobAt: row.lastJobAt,
    };
    const assigned = assignedTo?.(row.clientId);
    const withAssigned = assigned === undefined ? summary : { ...summary, assignedTo: assigned };
    return row.instagram === undefined
      ? withAssigned
      : { ...withAssigned, instagram: row.instagram };
  });
  const unreadable = (client: ClientSummary): number =>
    instagramRowKind(client) === 'account' ? 0 : 1;
  return clients.sort(
    (a, b) =>
      (accountsFirst ? unreadable(a) - unreadable(b) : 0) ||
      compareSortValues(CLIENT_SORT_VALUE.last(b), CLIENT_SORT_VALUE.last(a)) ||
      compareSortValues(a.name, b.name) ||
      (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0),
  );
}

/** The client with this id, or `undefined` for one the client list does not hold. */
export function findClient(
  clients: readonly ClientSummary[],
  clientId: string,
): ClientSummary | undefined {
  return clients.find((client) => client.clientId === clientId);
}

/** The clients whose name matches the search (case, accents and Hebrew points are ignored). */
export function filterClients(clients: readonly ClientSummary[], search: string): ClientSummary[] {
  return clients.filter((client) => matchesText(client.name, search));
}

/** "1 client", "7 clients". */
export function clientCountText(count: number): string {
  return `${count} ${count === 1 ? 'client' : 'clients'}`;
}

/** The line under the table: "7 clients", or "2 of 7 clients" while the search leaves some out. */
export function clientsFooterText(shown: number, total: number): string {
  return shown === total ? clientCountText(total) : `${shown} of ${clientCountText(total)}`;
}

/** "3 jobs", "1 job". */
export function jobCountText(count: number): string {
  return `${count} ${count === 1 ? 'job' : 'jobs'}`;
}

/**
 * Which of the table body's states applies, as the Jobs table's `tableBodyState` works it out for
 * jobs: a list that has arrived always wins over `failed`, so a refetch that fails later leaves
 * the table as it is. `clients` is the server's list (`undefined` until the first answer) and
 * `matching` the clients the search leaves, across all pages.
 */
export function clientsBodyState({
  clients,
  failed,
  matching,
}: {
  clients: readonly ClientRow[] | undefined;
  failed: boolean;
  matching: number;
}): TableBodyState {
  if (clients === undefined) return failed ? 'unreachable' : 'loading';
  if (clients.length === 0) return 'empty';
  return matching === 0 ? 'no-match' : 'rows';
}
