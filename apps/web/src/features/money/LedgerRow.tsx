import type { MoneyLedgerEntry } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { edgeClass } from '../jobs/edge-class';
import { BANNER_TONE_STYLES } from './banner-view';
import { formatIls, formatIlsAgorot } from './format';
import {
  type ClientGroup,
  clientDotColor,
  type DetailColumn,
  type DetailTone,
  deliveredText,
  jobCountText,
  jobDetail,
  LEDGER_COLUMN_IDS,
  NOT_DELIVERED_TEXT,
  paidCellText,
} from './ledger-view';

/** The number of cells in a row, for the open row's panel to span. */
const COLUMN_COUNT = LEDGER_COLUMN_IDS.length;

/**
 * The row is the positioned box of its button, whose `after` stretches over the whole row, so a
 * click anywhere on the row toggles it (Tab reaches the button; Enter and Space toggle). Keyboard
 * focus shows a quiet background and a grey line inside the row, never a coloured ring.
 */
const ROW_BASE =
  'relative h-[45px] outline-none has-[button:focus-visible]:bg-muted/50 has-[button:focus-visible]:outline-solid has-[button:focus-visible]:outline-2 has-[button:focus-visible]:-outline-offset-2 has-[button:focus-visible]:outline-foreground/30';

const TOGGLE_BASE =
  "flex w-full min-w-0 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:content-['']";

/** The chevron turns a quarter when its row is open (ease-in-out, as the board). */
function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-in-out',
        open && 'rotate-90',
      )}
    />
  );
}

/** The colour of the total at the bottom of a detail column. */
const TOTAL_TONE: Record<DetailTone, string> = {
  green: BANNER_TONE_STYLES.good.accent,
  red: BANNER_TONE_STYLES.bad.accent,
  grey: BANNER_TONE_STYLES.flat.accent,
  plain: '',
};

/** One column of an open job: a small uppercase title, its details, and its total on the bottom line. */
function DetailColumnView({ column }: { column: DetailColumn }) {
  return (
    <div data-detail={column.id} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs leading-[1.43] font-medium tracking-[0.04em] text-muted-foreground uppercase">
        {column.title}
      </span>
      {column.lines.map((line) => (
        <div key={line.label} className="flex justify-between gap-3">
          <span className={cn('min-w-0', line.muted && 'text-muted-foreground')}>
            <span dir="auto">{line.label}</span>
            {line.note !== null && <span className="text-muted-foreground"> · {line.note}</span>}
          </span>
          {line.value !== null && (
            <span
              className={cn(
                'shrink-0 text-right tabular-nums',
                line.valueMuted && 'text-muted-foreground',
              )}
            >
              {line.value}
            </span>
          )}
        </div>
      ))}
      {/* Every column's total sits on one line: the columns stretch, and this one goes to the bottom. */}
      <div className="mt-auto flex justify-between gap-3 border-t border-white/[0.12] pt-2">
        <span>{column.total.label}</span>
        <span
          className={cn(
            'shrink-0 text-right font-semibold tabular-nums',
            TOTAL_TONE[column.total.tone],
          )}
        >
          {column.total.value}
        </span>
      </div>
    </div>
  );
}

/** The panel under an open job: Income, Expenses, Profit and Your time, side by side. */
export function JobDetail({ entry }: { entry: MoneyLedgerEntry }) {
  return (
    <TableRow className="border-t-white/[0.06] hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="p-0 whitespace-normal">
        <div className="bg-white/[0.025] pt-4 pr-3 pb-5 pl-9 text-[13px]">
          <div className="grid grid-cols-4 items-stretch gap-8">
            {jobDetail(entry).map((column) => (
              <DetailColumnView key={column.id} column={column} />
            ))}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * A job of the month: its row (chevron and name, client, when it was delivered, when it was paid,
 * income, expenses, profit), and under it, while it is the open row of the page, its panel. `indented` is a job under
 * a client's header.
 */
export function LedgerJobRows({
  entry,
  open,
  indented,
  onToggle,
}: {
  entry: MoneyLedgerEntry;
  open: boolean;
  indented: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow data-job-id={entry.jobId} className={cn(ROW_BASE, open && 'border-b-0')}>
        <TableCell className={cn('py-0', edgeClass(true, false))}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the money details of ${entry.name}`}
            onClick={onToggle}
            className={cn(TOGGLE_BASE, indented && 'pl-6')}
          >
            <Chevron open={open} />
            <Bidi className="font-medium">{entry.name}</Bidi>
          </button>
        </TableCell>
        <TableCell className={cn('py-0', edgeClass(false, false))}>
          <Link
            to="/clients/$clientId"
            params={{ clientId: entry.clientId }}
            className="cursor-pointer text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
          >
            <Bidi>{entry.client}</Bidi>
          </Link>
        </TableCell>
        <TableCell
          className={cn('py-0 text-muted-foreground tabular-nums', edgeClass(false, false))}
        >
          {entry.deliveredAt === null ? NOT_DELIVERED_TEXT : deliveredText(entry.deliveredAt)}
        </TableCell>
        <TableCell
          data-cell="paid"
          className={cn(
            'py-0 tabular-nums',
            edgeClass(false, false),
            entry.paidOn === null && 'text-muted-foreground',
          )}
        >
          {paidCellText(entry)}
        </TableCell>
        <TableCell className={cn('py-0 text-right tabular-nums', edgeClass(false, false))}>
          {formatIls(entry.income)}
        </TableCell>
        <TableCell
          className={cn(
            'py-0 text-right tabular-nums',
            edgeClass(false, false),
            entry.expenses > 0 ? '' : 'text-zinc-500',
          )}
        >
          {entry.expenses > 0 ? formatIlsAgorot(entry.expenses) : '—'}
        </TableCell>
        <TableCell
          className={cn('py-0 text-right font-medium tabular-nums', edgeClass(false, true))}
        >
          {formatIls(entry.profit)}
        </TableCell>
      </TableRow>
      {open && <JobDetail entry={entry} />}
    </>
  );
}

/**
 * A client's header in the "By client" grouping: the chevron, a dot in the colour of the client's
 * avatar and the name, how many jobs, and what they add up to under Income, Expenses and Profit.
 * The dot stays on the left of a Hebrew name (the pair is `ltr`, the name inside reads `auto`).
 */
export function LedgerGroupRow({
  group,
  open,
  onToggle,
}: {
  group: ClientGroup;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow
      data-client-id={group.clientId}
      className={cn(
        ROW_BASE,
        // 44 px, not the job rows' 45: the board's header has its line inside its height.
        'h-11 bg-white/[0.03] has-aria-expanded:bg-white/[0.03] hover:bg-muted/50',
      )}
    >
      <TableCell className={cn('py-0', edgeClass(true, false))}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the jobs of ${group.client}`}
          onClick={onToggle}
          className={TOGGLE_BASE}
        >
          <Chevron open={open} />
          <span dir="ltr" className="inline-flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: clientDotColor(group.client) }}
            />
            <Bidi className="font-semibold">{group.client}</Bidi>
          </span>
        </button>
      </TableCell>
      <TableCell className={cn('py-0 text-muted-foreground tabular-nums', edgeClass(false, false))}>
        {jobCountText(group.jobs.length)}
      </TableCell>
      <TableCell className={cn('py-0', edgeClass(false, false))} />
      <TableCell className={cn('py-0', edgeClass(false, false))} />
      <TableCell
        className={cn('py-0 text-right font-semibold tabular-nums', edgeClass(false, false))}
      >
        {formatIls(group.income)}
      </TableCell>
      <TableCell
        className={cn(
          'py-0 text-right font-semibold text-muted-foreground tabular-nums',
          edgeClass(false, false),
        )}
      >
        {formatIls(group.expenses)}
      </TableCell>
      <TableCell
        className={cn('py-0 text-right font-semibold tabular-nums', edgeClass(false, true))}
      >
        {formatIls(group.profit)}
      </TableCell>
    </TableRow>
  );
}
