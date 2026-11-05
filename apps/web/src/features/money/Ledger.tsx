import type { MoneyResponse } from '@studio/shared';
import { Fragment, useMemo, useState } from 'react';
import { SortButton } from '@/components/table/SortButton';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMoney } from '@/data';
import { cn } from '@/lib/utils';
import { type LedgerGrouping, MONEY_PAGE_SIZE, useMoneyUiStore } from '@/stores/money-ui';
import { useDelayedFlag } from '../jobs/delayed-flag';
import { monthName } from './format';
import { LedgerGroupRow, LedgerJobRows } from './LedgerRow';
import {
  DEFAULT_LEDGER_SORT,
  LEDGER_COLUMN_IDS,
  LEDGER_COLUMNS,
  LEDGER_MIN_WIDTH,
  type LedgerColumnId,
  ledgerCellWidth,
  ledgerPage,
  nextSort,
  summaryHasContent,
} from './ledger-view';
import { MoneyPager } from './MoneyPager';
import { MONEY_SKELETON_DELAY_MS } from './MoneyStates';
import { MonthSummary } from './MonthSummary';

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

/** What the pager counts: jobs in "Every job", clients in "By client". */
const JOB_UNIT = { one: 'job', many: 'jobs' } as const;
const CLIENT_UNIT = { one: 'client', many: 'clients' } as const;

/** The two ways to list the month's jobs, as the segmented control at the top right names them. */
const GROUPINGS: readonly { value: LedgerGrouping; label: string }[] = [
  { value: 'job', label: 'Every job' },
  { value: 'client', label: 'By client' },
];

/**
 * "Every job" | "By client": a segmented control in the Tabs' look (a muted track, the chosen one
 * raised). Plain pressed-buttons, since it switches how one list is shown and has no panels. The
 * choice is remembered per browser. A grey keyboard-only focus line; a click leaves no ring.
 */
function GroupSwitch() {
  const grouping = useMoneyUiStore((state) => state.grouping);
  const setGrouping = useMoneyUiStore((state) => state.setGrouping);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of two buttons
    <div
      role="group"
      aria-label="Group the ledger"
      className="inline-flex rounded-lg bg-muted p-[3px]"
    >
      {GROUPINGS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={grouping === value}
          onClick={() => setGrouping(value)}
          className="h-[29px] rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-in-out outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * One header cell, in the Jobs table's way: muted text and a ghost button that sorts the column
 * (see `SortButton`: an arrow only on the sorted column). The Job header leaves room for the
 * chevron so its label sits over the names.
 */
function LedgerHeaderCell({
  id,
  sorted,
  onSort,
}: {
  id: LedgerColumnId;
  sorted: 'asc' | 'desc' | false;
  onSort: (id: LedgerColumnId) => void;
}) {
  const spec = LEDGER_COLUMNS[id];
  return (
    <TableHead
      scope="col"
      aria-sort={sorted ? ARIA_SORT[sorted] : 'none'}
      className={cn(
        'px-1.5 text-muted-foreground',
        sorted && 'text-foreground',
        id === 'name' && 'pl-9',
        id === 'profit' && 'pr-3',
      )}
    >
      <div className={cn('flex h-full items-center', spec.align === 'end' && 'justify-end')}>
        <SortButton label={spec.label} sorted={sorted} onClick={() => onSort(id)} />
      </div>
    </TableHead>
  );
}

/** Grey rows in the shape of the table, for a first load that is taking a while. */
function LedgerSkeleton() {
  return (
    <div aria-busy="true" className="overflow-hidden rounded-md border">
      <span className="sr-only">Loading the ledger…</span>
      {Array.from({ length: 5 }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
        <div key={row} className="flex h-[45px] items-center gap-3 border-b px-3 last:border-b-0">
          <Skeleton className="h-4 w-44 motion-reduce:animate-none" />
          <Skeleton className="ml-auto h-4 w-16 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

/** The table, its pager and the Month summary, for one month's answer. */
function LedgerBody({ data }: { data: MoneyResponse }) {
  const grouping = useMoneyUiStore((state) => state.grouping);
  const open = useMoneyUiStore((state) => state.open);
  const clientOpen = useMoneyUiStore((state) => state.clientOpen);
  const pageIndex = useMoneyUiStore((state) => state.ledgerPage);
  const toggleOpen = useMoneyUiStore((state) => state.toggleOpen);
  const setClientOpen = useMoneyUiStore((state) => state.setClientOpen);
  const setLedgerPage = useMoneyUiStore((state) => state.setLedgerPage);
  // The order is the table's own; a new order starts from the first page.
  const [sort, setSort] = useState(DEFAULT_LEDGER_SORT);

  const view = useMemo(
    () => ledgerPage(data.ledger, { grouping, sort, page: pageIndex, pageSize: MONEY_PAGE_SIZE }),
    [data.ledger, grouping, sort, pageIndex],
  );
  const empty = data.ledger.length === 0;

  function onSort(id: LedgerColumnId) {
    setSort((current) => nextSort(current, id));
    setLedgerPage(0);
  }

  const isOpen = (jobId: string) => open?.kind === 'job' && open.id === jobId;
  // Nothing chosen yet (`undefined`): the first client on the page is open, as on the board.
  const openClient =
    clientOpen === undefined
      ? view.grouping === 'client'
        ? (view.groups[0]?.clientId ?? null)
        : null
      : clientOpen;

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <Table
          aria-label="Ledger"
          // Fixed layout at the full width of the frame: every column but Job has its width, Job
          // takes what is left. Narrower than the minimums, the frame scrolls sideways.
          className="w-full table-fixed"
          style={{ minWidth: LEDGER_MIN_WIDTH }}
        >
          <colgroup>
            {LEDGER_COLUMN_IDS.map((id) => (
              <col key={id} style={id === 'name' ? undefined : { width: ledgerCellWidth(id) }} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {LEDGER_COLUMN_IDS.map((id) => (
                <LedgerHeaderCell
                  key={id}
                  id={id}
                  sorted={sort.key === id ? sort.dir : false}
                  onSort={onSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {empty && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={LEDGER_COLUMN_IDS.length}
                  className="h-24 text-center whitespace-normal text-muted-foreground"
                >
                  {`No jobs in ${monthName(data.month)}.`}
                </TableCell>
              </TableRow>
            )}
            {!empty &&
              view.grouping === 'job' &&
              view.jobs.map((entry) => (
                <LedgerJobRows
                  key={entry.jobId}
                  entry={entry}
                  open={isOpen(entry.jobId)}
                  indented={false}
                  onToggle={() => toggleOpen({ kind: 'job', id: entry.jobId })}
                />
              ))}
            {!empty &&
              view.grouping === 'client' &&
              view.groups.map((group) => {
                const groupOpen = openClient === group.clientId;
                return (
                  <Fragment key={group.clientId}>
                    <LedgerGroupRow
                      group={group}
                      open={groupOpen}
                      onToggle={() => setClientOpen(groupOpen ? null : group.clientId)}
                    />
                    {groupOpen &&
                      group.jobs.map((entry) => (
                        <LedgerJobRows
                          key={entry.jobId}
                          entry={entry}
                          open={isOpen(entry.jobId)}
                          indented
                          onToggle={() => toggleOpen({ kind: 'job', id: entry.jobId })}
                        />
                      ))}
                  </Fragment>
                );
              })}
          </TableBody>
        </Table>
      </div>
      {!empty && (
        <MoneyPager
          label="Ledger pages"
          unit={view.grouping === 'client' ? CLIENT_UNIT : JOB_UNIT}
          pageIndex={view.page}
          pageCount={view.pageCount}
          pageSize={MONEY_PAGE_SIZE}
          total={view.total}
          onPageChange={setLedgerPage}
        />
      )}
      {summaryHasContent(data) && <MonthSummary data={data} />}
    </>
  );
}

/**
 * The Ledger: every job of the month, delivered or not, what it earned, what it cost and what was kept.
 *
 * "Every job" lists the jobs in a table (every column sorts; newest delivery first to begin with);
 * "By client" puts a header per client above its jobs, the client who kept the most first, and
 * pages by client. Click a row to open its money (one row is open on the whole page, across this
 * table and the Expenses; one client is open at a time, the first on the page to begin with). Under the pager, the Month summary shows
 * how the jobs and the payments that belong to no job add up to the Profit banner.
 *
 * It takes no props: the month and what is open are in the Money UI store, and the numbers are
 * the page's own query (`useMoney`). Read-only: nothing here changes any data.
 */
export function Ledger() {
  const month = useMoneyUiStore((state) => state.month);
  const { data } = useMoney(month);
  const showSkeleton = useDelayedFlag(data === undefined, MONEY_SKELETON_DELAY_MS);

  return (
    <section aria-labelledby="ledger-h" className="flex flex-col gap-3.5 rounded-[12px] border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="ledger-h" className="text-base leading-[1.43] font-semibold">
            Ledger
          </h2>
          <p className="text-[13px] leading-[1.43] text-muted-foreground">
            Every job this month, delivered or not: what it earned, what it cost and what you kept.
            Open a row for the details.
          </p>
        </div>
        <GroupSwitch />
      </div>
      {data ? <LedgerBody data={data} /> : showSkeleton ? <LedgerSkeleton /> : null}
    </section>
  );
}
