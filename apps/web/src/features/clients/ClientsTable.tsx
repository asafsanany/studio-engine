import type { ClientRow as ClientListRow } from '@studio/shared';
import type { Header } from '@tanstack/react-table';
import type { StoreApi } from 'zustand';
import { SortButton } from '@/components/table/SortButton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  CLIENT_COLUMN_IDS,
  CLIENT_INSTAGRAM_COLUMN_IDS,
  type ClientColumnId,
  type ClientsUiStore,
  clientsUiStore,
} from '@/stores/clients-ui';
import { cellWidth, tableWidth } from '../jobs/column-widths';
import { SKELETON_DELAY_MS, useDelayedFlag } from '../jobs/delayed-flag';
import { edgeClass } from '../jobs/edge-class';
import { JobsPagination } from '../jobs/JobsPagination';
import { UnreachableRow } from '../jobs/JobsTableStates';
import { showsPagination } from '../jobs/table-body';
import { ClientRow } from './ClientRow';
import { EmptyClientsRow, LoadingClientRows, NoMatchingClientsRow } from './ClientsTableStates';
import {
  type AssignedLookup,
  type ClientSummary,
  clientsBodyState,
  clientsFooterText,
} from './clients';
import { ASSIGNED_COLUMN, CLIENT_COLUMN_SPECS, cellSpan } from './columns';
import type { ClientsTableFeatures } from './table-features';
import { CLIENTS_PAGE_SIZE, useClientsTable } from './use-clients-table';

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

/** The columns, left to right: Client, Jobs, Last job, or the Instagram view's (board CLList, L1). */
function columnIdsFor(instagram: boolean): readonly ClientColumnId[] {
  return instagram ? CLIENT_INSTAGRAM_COLUMN_IDS : CLIENT_COLUMN_IDS;
}

/** The columns' content widths, as the layout counts them: the Client column's is its minimum. */
function contentWidths(ids: readonly ClientColumnId[], withAssigned: boolean): number[] {
  const widths = ids.map((id) => CLIENT_COLUMN_SPECS[id].width ?? CLIENT_COLUMN_SPECS[id].minWidth);
  return withAssigned ? [...widths, ASSIGNED_COLUMN.width] : widths;
}

type ClientsHeader = Header<ClientsTableFeatures, ClientSummary, unknown>;

/**
 * One header cell, in the Jobs table's way: muted text and a ghost button that sorts the column
 * (see `SortButton`: an arrow only on the sorted column).
 */
function ClientsTableHeaderCell({
  header,
  first,
  last,
}: {
  header: ClientsHeader;
  first: boolean;
  last: boolean;
}) {
  const { column } = header;
  if (column.id === ASSIGNED_COLUMN.id) {
    // Plain text: this column does not sort.
    return (
      <TableHead scope="col" className={cn('px-1.5 text-muted-foreground', last && 'pr-3')}>
        {ASSIGNED_COLUMN.label}
      </TableHead>
    );
  }
  const sorted = column.getIsSorted();
  const spec = CLIENT_COLUMN_SPECS[column.id as ClientColumnId];

  return (
    <TableHead
      scope="col"
      aria-sort={sorted ? ARIA_SORT[sorted] : 'none'}
      className={cn(
        'px-1.5 text-muted-foreground',
        sorted && 'text-foreground',
        first && 'pl-3',
        last && 'pr-3',
      )}
    >
      <div className={cn('flex h-full items-center', spec.alignEnd && 'justify-end')}>
        <SortButton label={spec.label} sorted={sorted} onClick={column.getToggleSortingHandler()} />
      </div>
    </TableHead>
  );
}

export interface ClientsTableProps {
  /** The client list from `useClients()`: `undefined` until the first load. */
  clients: readonly ClientListRow[] | undefined;
  /**
   * The first load failed (the server cannot be reached). Read only while `clients` is
   * `undefined`: once a list has arrived it stays on screen, even if a later refetch fails.
   */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable row (the clients query's `refetch`). */
  onRetry?: () => void;
  /** The store the table is controlled by. Tests pass their own; the app uses the shared one. */
  store?: StoreApi<ClientsUiStore>;
  /** How long the first load may take before skeleton rows appear (see `JobsTable`). */
  skeletonDelayMs?: number;
  /**
   * The admin's "Assigned to" column: who each client is assigned to (`undefined` while the team
   * is not known). Left out for an editor, who has no such column.
   */
  assignedTo?: AssignedLookup;
  /**
   * Clients × Instagram is on (`useInstagramEnabled()`): the Instagram view of the table (board
   * CLList, L1). Off, it is today's table, unchanged.
   */
  instagram?: boolean;
}

/**
 * The table on the Clients board: Client · Jobs · Last job, in the Jobs table's look (TanStack
 * Table v9 controlled by the Clients UI store, the shadcn Table markup), over the client list the
 * server sent (a client with no jobs shows 0 jobs and "—"). The title, the search box and the New
 * client button belong to the page around it.
 *
 * The header always shows. The body is one of: skeleton rows (waiting for the first answer, and
 * only once that has taken a quarter of a second), "Can't reach the engine." with a retry link,
 * "No clients yet.", "No matching clients." or the client rows. Under it: "7 clients" ("2 of 7
 * clients" while the search leaves some out), or, once there are more clients than a page holds,
 * the Jobs table's range and page controls.
 */
export function ClientsTable({
  clients,
  failed = false,
  onRetry,
  store = clientsUiStore,
  skeletonDelayMs = SKELETON_DELAY_MS,
  assignedTo,
  instagram = false,
}: ClientsTableProps) {
  const { table, clientCount, total, pageCount, pageIndex, setPageIndex } = useClientsTable({
    clients,
    store,
    assignedTo,
    instagram,
  });
  const withAssigned = assignedTo !== undefined;
  const columnIds = columnIdsFor(instagram);
  const columnCount = columnIds.length + (withAssigned ? 1 : 0);
  const bodyState = clientsBodyState({ clients, failed, matching: total });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);
  const rows = table.getRowModel().rows;

  return (
    <TooltipProvider>
      <div className="overflow-hidden rounded-md border">
        <Table
          aria-label="Clients"
          // Fixed layout at the full width of the frame: the Jobs and Last job columns have their
          // widths, the Client column takes what is left. Narrower than the minimums, the frame
          // scrolls sideways.
          className="w-full table-fixed"
          style={{
            minWidth: tableWidth(contentWidths(columnIds, withAssigned)),
          }}
        >
          <colgroup>
            {columnIds.map((id, i) => (
              <col
                key={id}
                style={{
                  width: CLIENT_COLUMN_SPECS[id].width
                    ? cellWidth(CLIENT_COLUMN_SPECS[id].width, i, columnCount)
                    : undefined,
                }}
              />
            ))}
            {withAssigned && (
              <col
                style={{ width: cellWidth(ASSIGNED_COLUMN.width, columnCount - 1, columnCount) }}
              />
            )}
          </colgroup>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header, i) => (
                  <ClientsTableHeaderCell
                    key={header.id}
                    header={header}
                    first={i === 0}
                    last={i === group.headers.length - 1}
                  />
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody aria-busy={bodyState === 'loading' || undefined}>
            {bodyState === 'loading' && showSkeleton && (
              <LoadingClientRows columns={columnIds} withAssigned={withAssigned} />
            )}
            {bodyState === 'unreachable' && (
              <UnreachableRow columnCount={columnCount} onRetry={() => onRetry?.()} />
            )}
            {bodyState === 'empty' && <EmptyClientsRow columnCount={columnCount} />}
            {bodyState === 'no-match' && <NoMatchingClientsRow columnCount={columnCount} />}
            {bodyState === 'rows' &&
              rows.map((row) => {
                const cells = row.getAllCells();
                return (
                  <ClientRow key={row.id} client={row.original}>
                    {cells.map((cell, i) => {
                      // A client with no readable account has one cell over Followers and This week.
                      const span = cellSpan(cell.column.id, row.original, instagram);
                      if (span === 'skip') return null;
                      return (
                        <TableCell
                          key={cell.id}
                          colSpan={span}
                          className={cn('py-0', edgeClass(i === 0, i === cells.length - 1))}
                        >
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      );
                    })}
                  </ClientRow>
                );
              })}
          </TableBody>
        </Table>
      </div>
      {showsPagination(bodyState) &&
        (pageCount > 1 ? (
          <JobsPagination
            pageIndex={pageIndex}
            pageCount={pageCount}
            pageSize={CLIENTS_PAGE_SIZE}
            total={total}
            onPageChange={setPageIndex}
            unit="clients"
          />
        ) : (
          <span className="text-muted-foreground tabular-nums">
            {clientsFooterText(total, clientCount)}
          </span>
        ))}
    </TooltipProvider>
  );
}
