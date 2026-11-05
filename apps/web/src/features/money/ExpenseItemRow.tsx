import type { MoneyExpenseCharge, MoneyExpenseItem } from '@studio/shared';
import { ChevronRight } from 'lucide-react';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { edgeClass } from '../jobs/edge-class';
import { chargeDate, chargeJobName } from './expenses-view';
import { formatIlsAgorot } from './format';

/** How many columns the Items table has, which the open row's details span. */
export const ITEM_COLUMN_COUNT = 5;

/**
 * What a charge was for: "Clip licence #4831 · for Retreat teaser" when it was bought for one job
 * (the job's folder name), otherwise just what it was. Each piece that comes from the money file or
 * a folder name is its own `<bdi>` (an isolate that takes its direction from its text, as
 * `dir="auto"` does), so a Hebrew job name reads right to left without turning the dots and the
 * English around it.
 */
export function ChargeWhat({ charge }: { charge: Pick<MoneyExpenseCharge, 'what' | 'job'> }) {
  return (
    <span>
      <bdi>{charge.what}</bdi>
      {charge.job !== null && (
        <>
          {' · for '}
          <bdi>{chargeJobName(charge.job)}</bdi>
        </>
      )}
    </span>
  );
}

/** A line of the open item: the date, what for, the amount in the currency paid, and in shekels. */
const CHARGE_GRID = 'grid grid-cols-[110px_minmax(0,1fr)_110px_110px] gap-3';

/**
 * One item of the Items table: its row (the chevron, name, kind, billing, amount and this month's
 * total, to the agora so the column adds up to the footer) and, when it is the open one, a row below with its charges and notes.
 *
 * The name is a button whose box stretches over the row, so a click anywhere on the row opens or
 * closes it, and Tab reaches it and Enter or Space works it. Keyboard focus shows a quiet grey
 * line inside the row, never a coloured ring.
 */
export function ExpenseItemRow({
  item,
  open,
  onToggle,
}: {
  item: MoneyExpenseItem;
  open: boolean;
  onToggle: () => void;
}) {
  const cell = (index: number) => edgeClass(index === 0, index === ITEM_COLUMN_COUNT - 1);
  return (
    <>
      <TableRow
        data-item-id={item.id}
        className={cn(
          'relative h-[45px] has-[button:focus-visible]:bg-muted/50 has-[button:focus-visible]:outline-solid has-[button:focus-visible]:outline-2 has-[button:focus-visible]:-outline-offset-2 has-[button:focus-visible]:outline-foreground/30',
          // The faint line the board draws between an open row and its details.
          open && 'border-b-foreground/[0.06]',
        )}
      >
        <TableCell className={cn('py-0', cell(0))}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the charges of ${item.name}`}
            onClick={onToggle}
            className="flex w-full min-w-0 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:content-['']"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-in-out',
                open && 'rotate-90',
              )}
            />
            <span dir="auto" className="min-w-0 truncate font-medium [unicode-bidi:plaintext]">
              {item.name}
            </span>
          </button>
        </TableCell>
        <TableCell className={cn('py-0 text-muted-foreground', cell(1))}>{item.kind}</TableCell>
        <TableCell className={cn('py-0 text-muted-foreground', cell(2))}>{item.billing}</TableCell>
        <TableCell className={cn('py-0 text-right text-muted-foreground tabular-nums', cell(3))}>
          {item.amountLabel}
        </TableCell>
        <TableCell className={cn('py-0 text-right font-medium tabular-nums', cell(4))}>
          {formatIlsAgorot(item.ils)}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow
          data-item-details={item.id}
          className="bg-foreground/[0.025] hover:bg-foreground/[0.025]"
        >
          <TableCell colSpan={ITEM_COLUMN_COUNT} className="pt-3 pr-3 pb-4 pl-9 text-[13px]">
            <div className="flex flex-col gap-2">
              {item.charges.map((charge, index) => (
                <div
                  // A renewal and a clip can share a day, so the date alone is not a key.
                  // biome-ignore lint/suspicious/noArrayIndexKey: charges have no id; the list is fixed
                  key={`${charge.date}-${index}`}
                  className={CHARGE_GRID}
                >
                  <span className="text-muted-foreground tabular-nums">
                    {chargeDate(charge.date)}
                  </span>
                  <span className="min-w-0 whitespace-normal">
                    <ChargeWhat charge={charge} />
                  </span>
                  <span className="text-right text-muted-foreground tabular-nums">
                    {charge.amountLabel}
                  </span>
                  <span className="text-right tabular-nums">{formatIlsAgorot(charge.ils)}</span>
                </div>
              ))}
              {item.notes.map((note, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: notes are plain text lines, in a fixed order
                  key={index}
                  dir="auto"
                  className="text-left whitespace-normal text-muted-foreground"
                >
                  {note}
                </span>
              ))}
              {item.charges.length === 0 && item.notes.length === 0 && (
                <span className="text-muted-foreground">No charges this month.</span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
