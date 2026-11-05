import type { MoneyExpenseCharge, MoneyExpenseItem, MoneyExpenses } from '@studio/shared';
import { homeCurrencySymbol } from '@studio/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMoney } from '@/data';
import { cn } from '@/lib/utils';
import {
  EXPENSES_VIEWS,
  type ExpensesView,
  MONEY_PAGE_SIZE,
  useMoneyUiStore,
} from '@/stores/money-ui';
import { edgeClass } from '../jobs/edge-class';
import { ChargeWhat, ExpenseItemRow, ITEM_COLUMN_COUNT } from './ExpenseItemRow';
import {
  chargeDate,
  chargesByDate,
  EXPENSES_UNITS,
  EXPENSES_VIEW_LABELS,
  emptyExpensesText,
  expensesDescription,
  expensesFooter,
  openItemId,
  pageSlice,
} from './expenses-view';
import { formatIlsAgorot } from './format';
import { MoneyPager } from './MoneyPager';

/**
 * Column widths, the board's plus the 12 px between columns (6 px of padding on each side). The
 * first and the last column are the board's 110 px, 6 px of the gap beside it and the row's 12 px at
 * the edge of the frame.
 */
const ITEM_COLUMN_WIDTHS = [undefined, '142px', '232px', '122px', '128px'] as const;
const CHARGE_COLUMN_WIDTHS = ['128px', undefined, undefined, '122px', '128px'] as const;

/**
 * The look of the "Items" | "All charges" switch: the Ledger's switch (a muted track, the chosen
 * one raised on the page's own colour), so the two read alike. These override the Tabs' stock
 * classes of the same kind; the Tabs keep their behaviour and their grey keyboard-only focus.
 */
const SWITCH_TRACK = 'group-data-[orientation=horizontal]/tabs:h-[35px]';
const SWITCH_BUTTON =
  'h-[29px] rounded-md border-0 px-3 py-0 transition-colors duration-150 ease-in-out data-[state=active]:bg-background group-data-[variant=default]/tabs-list:data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.3)] dark:data-[state=active]:bg-background';

/** The board's frame: 8 px corners, a hairline, and the 900 px the table needs before it scrolls. */
const FRAME = 'overflow-hidden rounded-[8px] border';
const TABLE = 'min-w-[900px] table-fixed';

/** The footer's two parts, from `expensesFooter`. */
interface FooterParts {
  label: string;
  amount: string;
}

/** A header cell: grey, with no sort arrow (the lists are not sortable); amounts are right-aligned. */
function Head({
  index,
  count,
  right,
  className,
  children,
}: {
  index: number;
  count: number;
  right?: boolean;
  className?: string;
  children: string;
}) {
  return (
    <TableHead
      className={cn(
        'text-muted-foreground',
        edgeClass(index === 0, index === count - 1),
        right && 'text-right',
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function Columns({ widths }: { widths: ReadonlyArray<string | undefined> }) {
  return (
    <colgroup>
      {widths.map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of columns, in order
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  );
}

/** The line under the rows: how many there are, and what the month cost in bold at the right. */
function Footer({ label, amount, columns }: FooterParts & { columns: number }) {
  return (
    <TableFooter className="border-t-foreground/[0.18] bg-transparent font-semibold">
      <TableRow className="h-[45px] border-0 hover:bg-transparent">
        <TableCell colSpan={columns - 1} className="py-0 pr-1.5 pl-9">
          {label}
        </TableCell>
        <TableCell className="py-0 pr-3 pl-1.5 text-right tabular-nums">{amount}</TableCell>
      </TableRow>
    </TableFooter>
  );
}

/** Item · Kind · Billing · Amount · This month, a row opening to the item's charges and notes. */
function ItemsTable({
  items,
  openId,
  onToggle,
  footer,
}: {
  items: readonly MoneyExpenseItem[];
  openId: string | null;
  onToggle: (id: string) => void;
  footer: FooterParts;
}) {
  return (
    <div className={FRAME}>
      <Table aria-label="Expenses by item" className={TABLE}>
        <Columns widths={ITEM_COLUMN_WIDTHS} />
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <Head index={0} count={ITEM_COLUMN_COUNT} className="pl-9">
              Item
            </Head>
            <Head index={1} count={ITEM_COLUMN_COUNT}>
              Kind
            </Head>
            <Head index={2} count={ITEM_COLUMN_COUNT}>
              Billing
            </Head>
            <Head index={3} count={ITEM_COLUMN_COUNT} right>
              Amount
            </Head>
            <Head index={4} count={ITEM_COLUMN_COUNT} right>
              This month
            </Head>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <ExpenseItemRow
              key={item.id}
              item={item}
              open={item.id === openId}
              onToggle={() => onToggle(item.id)}
            />
          ))}
        </TableBody>
        <Footer label={footer.label} amount={footer.amount} columns={ITEM_COLUMN_COUNT} />
      </Table>
    </div>
  );
}

/** Date · Item · What for · Amount · In ₪: every payment of the month, earliest first. */
function ChargesTable({
  charges,
  footer,
}: {
  charges: readonly MoneyExpenseCharge[];
  footer: FooterParts;
}) {
  const count = CHARGE_COLUMN_WIDTHS.length;
  return (
    <div className={FRAME}>
      <Table aria-label="All charges" className={TABLE}>
        <Columns widths={CHARGE_COLUMN_WIDTHS} />
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <Head index={0} count={count}>
              Date
            </Head>
            <Head index={1} count={count}>
              Item
            </Head>
            <Head index={2} count={count}>
              What for
            </Head>
            <Head index={3} count={count} right>
              Amount
            </Head>
            <Head index={4} count={count} right>
              {`In ${homeCurrencySymbol()}`}
            </Head>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.map((charge, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: charges have no id and one day can hold several alike; the page is only ever shown
            <TableRow key={`${charge.date}-${charge.item}-${index}`} className="h-[45px]">
              <TableCell
                className={cn('py-0 text-muted-foreground tabular-nums', edgeClass(true, false))}
              >
                {chargeDate(charge.date)}
              </TableCell>
              <TableCell className={cn('py-0', edgeClass(false, false))}>
                {/* text-left: a Hebrew name reads right to left but stays at the cell's left edge, like the rest. */}
                <span
                  dir="auto"
                  className="block truncate text-left font-medium [unicode-bidi:plaintext]"
                >
                  {charge.item}
                </span>
              </TableCell>
              <TableCell className={cn('py-0 text-muted-foreground', edgeClass(false, false))}>
                <span className="block truncate">
                  <ChargeWhat charge={charge} />
                </span>
              </TableCell>
              <TableCell
                className={cn(
                  'py-0 text-right text-muted-foreground tabular-nums',
                  edgeClass(false, false),
                )}
              >
                {charge.amountLabel}
              </TableCell>
              <TableCell className={cn('py-0 text-right tabular-nums', edgeClass(false, true))}>
                {formatIlsAgorot(charge.ils)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <Footer label={footer.label} amount={footer.amount} columns={count} />
      </Table>
    </div>
  );
}

/** "Items" | "All charges": the segmented control that picks how the month's expenses are listed. */
function ViewSwitch({
  view,
  onChange,
}: {
  view: ExpensesView;
  onChange: (view: ExpensesView) => void;
}) {
  return (
    <Tabs
      value={view}
      onValueChange={(value) => {
        const next = EXPENSES_VIEWS.find((candidate) => candidate === value);
        if (next) onChange(next);
      }}
    >
      <TabsList aria-label="Show expenses as" className={SWITCH_TRACK}>
        {EXPENSES_VIEW_LABELS.map(({ view: option, label }) => (
          <TabsTrigger
            key={option}
            value={option}
            // There is no panel to point at: the table below is shared by both views.
            aria-controls={undefined}
            className={SWITCH_BUTTON}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The Items view: one page of items, the footer and the pager. */
function ItemsView({ expenses }: { expenses: MoneyExpenses }) {
  const page = useMoneyUiStore((state) => state.expensesPage);
  const open = useMoneyUiStore((state) => state.open);
  const setPage = useMoneyUiStore((state) => state.setExpensesPage);
  const toggleOpen = useMoneyUiStore((state) => state.toggleOpen);
  const slice = pageSlice(expenses.items, page, MONEY_PAGE_SIZE);
  const footer = expensesFooter('items', slice.total, expenses.total);

  return (
    <>
      <ItemsTable
        items={slice.rows}
        openId={openItemId(open)}
        // The store keeps one open row for the whole page: this closes an open Ledger job.
        onToggle={(id) => toggleOpen({ kind: 'item', id })}
        footer={footer}
      />
      <MoneyPager
        label="Expense pages"
        unit={EXPENSES_UNITS.items}
        pageIndex={slice.pageIndex}
        pageCount={slice.pageCount}
        pageSize={MONEY_PAGE_SIZE}
        total={slice.total}
        onPageChange={setPage}
      />
    </>
  );
}

/** The All charges view: one page of charges, the footer and the pager. */
function ChargesView({ expenses }: { expenses: MoneyExpenses }) {
  const page = useMoneyUiStore((state) => state.expensesPage);
  const setPage = useMoneyUiStore((state) => state.setExpensesPage);
  const slice = pageSlice(chargesByDate(expenses.charges), page, MONEY_PAGE_SIZE);
  const footer = expensesFooter('charges', slice.total, expenses.total);

  return (
    <>
      <ChargesTable charges={slice.rows} footer={footer} />
      <MoneyPager
        label="Expense pages"
        unit={EXPENSES_UNITS.charges}
        pageIndex={slice.pageIndex}
        pageCount={slice.pageCount}
        pageSize={MONEY_PAGE_SIZE}
        total={slice.total}
        onPageChange={setPage}
      />
    </>
  );
}

/** What fills the section under its header: the view's table and pager, or the empty-month line. */
function ExpensesBody({
  expenses,
  month,
  view,
}: {
  expenses: MoneyExpenses;
  /** The month the numbers are for, YYYY-MM. */
  month: string;
  view: ExpensesView;
}) {
  const count = view === 'items' ? expenses.items.length : expenses.charges.length;
  if (count === 0) {
    return (
      <p className="flex min-h-24 items-center justify-center rounded-[8px] border px-3 text-center text-muted-foreground">
        {emptyExpensesText(month)}
      </p>
    );
  }
  return view === 'items' ? <ItemsView expenses={expenses} /> : <ChargesView expenses={expenses} />;
}

/**
 * The Expenses: everything the owner actually paid in the month, as items (every subscription and every
 * thing paid per use, each opening to its charges and notes) or as one list of every charge. The
 * switch between the two is remembered; a page is 10 rows in either. Read-only: nothing here can
 * be edited, only opened.
 *
 * It takes no props: the month and the numbers come from the Money UI store and the shared money
 * query, the same as the page's. Until the first answer is in, only the heading shows.
 */
export function Expenses() {
  const month = useMoneyUiStore((state) => state.month);
  const view = useMoneyUiStore((state) => state.expensesView);
  const setView = useMoneyUiStore((state) => state.setExpensesView);
  const { data } = useMoney(month);

  return (
    <section aria-labelledby="exp-h" className="flex flex-col gap-3.5 rounded-[12px] border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="exp-h" className="text-base leading-[1.43] font-semibold">
            Expenses
          </h2>
          {data && (
            <span className="text-[13px] leading-[1.43] text-muted-foreground">
              {expensesDescription(data.expenses.usdToIls)}
            </span>
          )}
        </div>
        {data && <ViewSwitch view={view} onChange={setView} />}
      </div>
      {/* `data.month` is the month of the numbers, which is the one before the pick while a new month loads. */}
      {data && <ExpensesBody expenses={data.expenses} month={data.month} view={view} />}
    </section>
  );
}
