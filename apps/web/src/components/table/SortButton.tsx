import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The sort button inside a table's column header: a ghost button with the column's name. Only the
 * sorted column shows an arrow (ArrowDown for descending, ArrowUp for ascending); on any other
 * column ArrowUpDown fades in at half strength while the button is hovered or focused, and its room
 * is always kept so nothing shifts.
 */
export function SortButton({
  label,
  sorted,
  onClick,
}: {
  label: string;
  /** How the column is sorted; `false` when the table is sorted by another column. */
  sorted: false | 'asc' | 'desc';
  /** TanStack's `column.getToggleSortingHandler()`. */
  onClick: ((event: unknown) => void) | undefined;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      // Wider than its text by 8 px a side so the hover background has room, pulled back
      // by the same amount so the text lines up with the cells below.
      className="group/sort -mx-2 gap-1.5 px-2 has-[>svg]:px-2"
    >
      {label}
      {sorted === 'desc' ? (
        <ArrowDown className="size-3.5" aria-hidden />
      ) : sorted === 'asc' ? (
        <ArrowUp className="size-3.5" aria-hidden />
      ) : (
        <ArrowUpDown
          className="size-3.5 opacity-0 transition-opacity group-hover/sort:opacity-50 group-focus-visible/sort:opacity-50"
          aria-hidden
        />
      )}
    </Button>
  );
}
