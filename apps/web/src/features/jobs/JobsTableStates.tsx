import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';

// The Jobs page is a list now (`JobsListStates.tsx` has its states). This is the one table-row state
// the Clients table, which is still a table, borrows.

/**
 * "Can't reach the engine." with a "Try again" link, in a 97 px table row. The link is a button (it
 * runs the retry, it goes nowhere) dressed as the canvas's links.
 */
export function UnreachableRow({
  columnCount,
  onRetry,
}: {
  columnCount: number;
  onRetry: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={columnCount}
        className="h-[97px] text-center whitespace-normal text-muted-foreground"
      >
        <span role="alert">Can't reach the engine.</span>{' '}
        <Button
          type="button"
          variant="link"
          onClick={onRetry}
          className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
        >
          Try again
        </Button>
      </TableCell>
    </TableRow>
  );
}
