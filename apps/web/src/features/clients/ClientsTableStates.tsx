import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { CLIENT_COLUMN_IDS, type ClientColumnId } from '@/stores/clients-ui';
import { edgeClass } from '../jobs/edge-class';

// What the Clients table body shows when there are no client rows. Each is a row (or, for loading,
// a few) inside the same bordered table, under the same header, so the page keeps its shape. The
// engine being unreachable is the Jobs table's own row (`UnreachableRow`).

/** Rows of skeleton while the first answer is on its way. */
export const CLIENT_SKELETON_ROW_COUNT = 7;

/** "No clients yet." The inbox holds no client folder, so there is nobody to list. */
export function EmptyClientsRow({ columnCount }: { columnCount: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="p-0 whitespace-normal">
        <div className="flex h-40 flex-col items-center justify-center gap-1 px-3 text-center">
          <p className="font-medium">No clients yet.</p>
          <p className="text-muted-foreground">
            Click New client, or make a folder for one in Studio Inbox:{' '}
            <code className="font-mono text-[13px] text-foreground">
              Studio Inbox/&lt;Client&gt;
            </code>
            .
          </p>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** "No matching clients." There are clients, but the search leaves none. */
export function NoMatchingClientsRow({ columnCount }: { columnCount: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={columnCount}
        className="h-24 text-center whitespace-normal text-muted-foreground"
      >
        No matching clients.
      </TableCell>
    </TableRow>
  );
}

/** A grey placeholder shaped like what each column will hold. */
function Bone({ className }: { className: string }) {
  return <Skeleton className={cn('motion-reduce:animate-none', className)} />;
}

const NAME_BAR = ['w-40', 'w-32', 'w-44', 'w-36'] as const;

/**
 * Skeleton rows, 57 px high like the real ones. Screen readers get one "Loading clients…" in the
 * first cell instead of rows of nothing.
 */
export function LoadingClientRows({
  columns = CLIENT_COLUMN_IDS,
  withAssigned = false,
}: {
  /** The columns of the table (the Instagram view has others than today's). */
  columns?: readonly ClientColumnId[];
  withAssigned?: boolean;
}) {
  const ids = withAssigned ? [...columns, 'assigned' as const] : columns;
  return Array.from({ length: CLIENT_SKELETON_ROW_COUNT }, (_, row) => (
    // The rows are identical and never reorder, so the index is the right key.
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
    <TableRow key={row} data-skeleton-row="" className="h-[57px] hover:bg-transparent">
      {ids.map((id, i) => (
        <TableCell key={id} className={cn('py-0', edgeClass(i === 0, i === ids.length - 1))}>
          {row === 0 && i === 0 && (
            <span role="status" className="sr-only">
              Loading clients…
            </span>
          )}
          {id === 'client' && (
            <div className="flex min-w-0 items-center gap-3">
              <Bone className="size-8 shrink-0 rounded-full" />
              <Bone className={cn('h-4', NAME_BAR[row % NAME_BAR.length])} />
            </div>
          )}
          {id === 'jobs' && <Bone className="h-4 w-6" />}
          {id === 'last' && <Bone className="h-4 w-16" />}
          {(id === 'followers' || id === 'week' || id === 'ours') && (
            <Bone className="ml-auto h-4 w-12" />
          )}
          {id === 'assigned' && <Bone className="h-4 w-24" />}
        </TableCell>
      ))}
    </TableRow>
  ));
}
