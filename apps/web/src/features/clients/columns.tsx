import { Link } from '@tanstack/react-router';
import { createColumnHelper, type SortFn } from '@tanstack/react-table';
import { ClientAvatar } from '@/components/ClientAvatar';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import { CHANGE_TONE_CLASS } from '@/features/analytics/jobs-tiles-view';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import type { ClientColumnId } from '@/stores/clients-ui';
import { FullTextTip } from '../jobs/cells/FullTextTip';
import { compareSortValues, type SortValue } from '../jobs/sorting';
import { AddInstagramLink } from './AddInstagramLink';
import {
  CLIENT_INSTAGRAM_SORT_VALUE,
  followersText,
  handleText,
  instagramRowKind,
  instagramStatusText,
  oursVsTheirsText,
  rowShowsPhoto,
  weekText,
  weekTone,
} from './client-instagram';
import { CLIENT_SORT_VALUE, type ClientSummary } from './clients';
import type { ClientsTableFeatures } from './table-features';

export interface ClientColumnSpec {
  /** Header text. */
  label: string;
  /**
   * The column's width in px (the content, as in the Jobs table: the gaps and the row padding come
   * on top). The Client column has none: it takes the room the others leave, down to `minWidth`.
   */
  width?: number;
  /** Narrowest the column gets, in px; the table scrolls sideways below the sum of these. */
  minWidth: number;
  /** The first click sorts descending (most, newest) instead of ascending. */
  descFirst: boolean;
  /** Numbers sit at the column's right edge, and so does the header (the Money ledger's way). */
  alignEnd?: boolean;
}

/**
 * Header text and widths, from the Clients board (`minmax(240px, 1fr) 160px 200px`) and, for the
 * Instagram view, board CLList L1 (Followers, This week and Ours vs theirs replace Jobs and Last job).
 */
export const CLIENT_COLUMN_SPECS: Readonly<Record<ClientColumnId, ClientColumnSpec>> = {
  client: { label: 'Client', minWidth: 240, descFirst: false },
  jobs: { label: 'Jobs', width: 160, minWidth: 160, descFirst: true },
  last: { label: 'Last job', width: 200, minWidth: 200, descFirst: true },
  followers: { label: 'Followers', width: 120, minWidth: 120, descFirst: true, alignEnd: true },
  week: { label: 'This week', width: 120, minWidth: 120, descFirst: true, alignEnd: true },
  ours: { label: 'Ours vs theirs', width: 150, minWidth: 150, descFirst: true, alignEnd: true },
};

const helper = createColumnHelper<ClientsTableFeatures, ClientSummary>();

/** TanStack compares rows; ours compare the values each column's accessor returned. */
const sortRows: SortFn<ClientsTableFeatures, ClientSummary> = (rowA, rowB, columnId) =>
  compareSortValues(rowA.getValue<SortValue>(columnId), rowB.getValue<SortValue>(columnId));

/**
 * Client: the initials avatar and the name, in the board's 500 weight. The name is the row's link
 * (so Tab reaches the row and Enter opens it); its `after` covers the whole row (`ClientRow` is
 * its positioned box), so a click anywhere on the row follows it too. The full name is in a
 * tooltip while it is cut off.
 *
 * `instagram` is the Instagram view (board CLList, L1): a 28 px avatar, and a client with an
 * account has its @handle under the name, in muted 12 px. The avatar is the Instagram photo, except
 * for a private account, which keeps its initials (`rowShowsPhoto`).
 */
export function ClientNameCell({
  client,
  instagram = false,
}: {
  client: ClientSummary;
  instagram?: boolean;
}) {
  const handle = instagram ? handleText(client) : null;
  return (
    <div className={cn('flex min-w-0 items-center', instagram ? 'gap-2.5' : 'gap-3')}>
      <ClientAvatar
        client={client.name}
        className={instagram ? 'size-7' : undefined}
        photo={rowShowsPhoto(client)}
      />
      <div className="flex min-w-0 flex-col">
        <Link
          to="/clients/$clientId"
          params={{ clientId: client.clientId }}
          className="block min-w-0 font-medium outline-none after:absolute after:inset-0 after:content-['']"
        >
          {/* Above the link's row-wide `after`, so the tooltip still opens over the name. */}
          <FullTextTip text={client.name} className="relative z-10">
            <Bidi>{client.name}</Bidi>
          </FullTextTip>
        </Link>
        {handle !== null && (
          <span
            data-slot="client-handle"
            dir="ltr"
            className="truncate text-left text-xs text-muted-foreground"
          >
            {handle}
          </span>
        )}
      </div>
    </div>
  );
}

/** Jobs: how many, in digits that do not jitter. */
export function ClientJobsCell({ client }: { client: ClientSummary }) {
  return <div className="tabular-nums">{client.jobCount}</div>;
}

/** Last job: "12 min ago", with the exact time in a tooltip; a dash for a client with no jobs yet. */
export function ClientLastJobCell({ client }: { client: ClientSummary }) {
  return (
    <div>
      {client.lastJobAt === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <RelativeTime iso={client.lastJobAt} />
      )}
    </div>
  );
}

/**
 * Followers (the Instagram view): "12,480" at the right edge, a dash until a scan has read the
 * profile. A client with no readable account has "No Instagram yet" or "Account is private" here
 * instead, over this column and This week (the row gives this cell both columns: `cellSpan`).
 */
export function ClientFollowersCell({ client }: { client: ClientSummary }) {
  const status = instagramStatusText(instagramRowKind(client));
  if (status !== null) return <div className="text-muted-foreground">{status}</div>;
  return <div className="text-right tabular-nums">{followersText(client)}</div>;
}

/**
 * This week (the Instagram view): "+312" in green, "−42" in red, "0" muted. A row without numbers
 * has no cell here (Followers' cell covers it).
 */
export function ClientWeekCell({ client }: { client: ClientSummary }) {
  if (instagramRowKind(client) !== 'account') return null;
  return (
    <div className={cn('text-right tabular-nums', CHANGE_TONE_CLASS[weekTone(client)])}>
      {weekText(client)}
    </div>
  );
}

/**
 * Ours vs theirs (the Instagram view): our typical plays ÷ theirs, "3.6×". A client with no
 * readable account has the Add Instagram link here, at the right edge (Edit account for a private
 * one).
 */
export function ClientOursCell({ client }: { client: ClientSummary }) {
  const kind = instagramRowKind(client);
  if (kind !== 'account') {
    return (
      <div className="text-right">
        <AddInstagramLink client={client} hasAccount={kind === 'private'} />
      </div>
    );
  }
  return <div className="text-right tabular-nums">{oursVsTheirsText(client)}</div>;
}

/**
 * How many columns a cell takes in the Instagram view: a client with no readable account says "No
 * Instagram yet" over Followers and This week, so Followers takes two and This week none
 * (`'skip'`: the row has no cell there). Everywhere else, and in today's table, one.
 */
export function cellSpan(
  columnId: string,
  client: ClientSummary,
  instagram: boolean,
): number | 'skip' {
  if (!instagram || instagramRowKind(client) === 'account') return 1;
  if (columnId === 'followers') return 2;
  return columnId === 'week' ? 'skip' : 1;
}

/** The admin's "Assigned to" column: plain text, not sortable. */
export const ASSIGNED_COLUMN = {
  id: 'assigned',
  label: 'Assigned to',
  width: 220,
  minWidth: 200,
} as const;

/**
 * Assigned to (admin only): the names of the editors the client is assigned to, as plain text; a
 * muted "Unassigned" for a client only the admin sees. Nothing until the team is known.
 */
export function ClientAssignedCell({ client }: { client: ClientSummary }) {
  if (client.assignedTo === undefined) return null;
  if (client.assignedTo.length === 0) {
    return <div className="text-muted-foreground">Unassigned</div>;
  }
  const names = client.assignedTo.join(', ');
  return (
    <FullTextTip text={names}>
      <Bidi>{names}</Bidi>
    </FullTextTip>
  );
}

/** The table's column definitions: Client, Jobs, Last job. */
export const CLIENT_COLUMNS = helper.columns([
  helper.accessor(CLIENT_SORT_VALUE.client, {
    id: 'client',
    header: CLIENT_COLUMN_SPECS.client.label,
    cell: ({ row }) => <ClientNameCell client={row.original} />,
    sortFn: sortRows,
    sortDescFirst: CLIENT_COLUMN_SPECS.client.descFirst,
  }),
  helper.accessor(CLIENT_SORT_VALUE.jobs, {
    id: 'jobs',
    header: CLIENT_COLUMN_SPECS.jobs.label,
    cell: ({ row }) => <ClientJobsCell client={row.original} />,
    sortFn: sortRows,
    sortDescFirst: CLIENT_COLUMN_SPECS.jobs.descFirst,
  }),
  helper.accessor(CLIENT_SORT_VALUE.last, {
    id: 'last',
    header: CLIENT_COLUMN_SPECS.last.label,
    cell: ({ row }) => <ClientLastJobCell client={row.original} />,
    sortFn: sortRows,
    sortDescFirst: CLIENT_COLUMN_SPECS.last.descFirst,
  }),
]);

/**
 * The column definitions of the Instagram view (board CLList, L1): Client with its handle under
 * the name, Followers, This week and Ours vs theirs. A row without numbers sorts after the rest
 * whichever way the column goes (`sortUndefined`).
 */
export const CLIENT_INSTAGRAM_COLUMNS = helper.columns([
  helper.accessor(CLIENT_SORT_VALUE.client, {
    id: 'client',
    header: CLIENT_COLUMN_SPECS.client.label,
    cell: ({ row }) => <ClientNameCell client={row.original} instagram />,
    sortFn: sortRows,
    sortDescFirst: CLIENT_COLUMN_SPECS.client.descFirst,
  }),
  helper.accessor(CLIENT_INSTAGRAM_SORT_VALUE.followers, {
    id: 'followers',
    header: CLIENT_COLUMN_SPECS.followers.label,
    cell: ({ row }) => <ClientFollowersCell client={row.original} />,
    sortFn: sortRows,
    sortUndefined: 'last',
    sortDescFirst: CLIENT_COLUMN_SPECS.followers.descFirst,
  }),
  helper.accessor(CLIENT_INSTAGRAM_SORT_VALUE.week, {
    id: 'week',
    header: CLIENT_COLUMN_SPECS.week.label,
    cell: ({ row }) => <ClientWeekCell client={row.original} />,
    sortFn: sortRows,
    sortUndefined: 'last',
    sortDescFirst: CLIENT_COLUMN_SPECS.week.descFirst,
  }),
  helper.accessor(CLIENT_INSTAGRAM_SORT_VALUE.ours, {
    id: 'ours',
    header: CLIENT_COLUMN_SPECS.ours.label,
    cell: ({ row }) => <ClientOursCell client={row.original} />,
    sortFn: sortRows,
    sortUndefined: 'last',
    sortDescFirst: CLIENT_COLUMN_SPECS.ours.descFirst,
  }),
]);

const ASSIGNED_DEFINITION = helper.display({
  id: ASSIGNED_COLUMN.id,
  header: ASSIGNED_COLUMN.label,
  cell: ({ row }) => <ClientAssignedCell client={row.original} />,
  enableSorting: false,
});

/**
 * The columns for the admin (with Assigned to at the end) or for an editor (without it), and with
 * the Instagram numbers in place of Jobs and Last job while Clients × Instagram is on.
 */
export function clientColumns(withAssigned: boolean, withInstagram = false) {
  const columns = withInstagram ? CLIENT_INSTAGRAM_COLUMNS : CLIENT_COLUMNS;
  return withAssigned ? [...columns, ASSIGNED_DEFINITION] : columns;
}
