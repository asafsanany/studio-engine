import type { MoneyResponse } from '@studio/shared';
import { useState } from 'react';
import { Bidi } from '@/lib/bidi';
import { type ExpensesView, useMoneyUiStore } from '@/stores/money-ui';
import { ChargeWhat } from '../money/ExpenseItemRow';
import { chargeDate, EXPENSES_VIEW_LABELS } from '../money/expenses-view';
import { PhoneSegmented } from './PhoneSegmented';
import { PHONE_EXPENSES_TEXT, type PhoneExpenseRow, phoneExpenses } from './phone-money';

const VIEW_OPTIONS = EXPENSES_VIEW_LABELS.map(({ view, label }) => ({ value: view, label }));

/** The board's row: a name over a muted line, the amount in shekels at the right with what was paid under it. */
function ExpenseRow({ row }: { row: PhoneExpenseRow }) {
  return (
    <div className="flex min-h-[60px] items-center gap-3 border-b border-white/8 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <Bidi className="truncate font-medium">{row.name}</Bidi>
        <span className="truncate text-[13px] text-muted-foreground">
          {row.charge === null ? (
            row.sub
          ) : (
            <>
              <span className="tabular-nums">{chargeDate(row.charge.date)}</span>
              {' · '}
              <ChargeWhat charge={row.charge} />
            </>
          )}
        </span>
      </div>
      <div className="flex flex-none flex-col items-end tabular-nums">
        <span data-expense-ils="" className="font-medium">
          {row.ils}
        </span>
        {row.orig !== '' && <span className="text-xs text-muted-foreground">{row.orig}</span>}
      </div>
    </div>
  );
}

/** The list inside its box: the first rows, "Show all N charges" and the month's total. */
function ExpensesList({ data, view }: { data: MoneyResponse; view: ExpensesView }) {
  const [expanded, setExpanded] = useState(false);
  const list = phoneExpenses(data.expenses, { view, expanded, month: data.month });

  if (list.empty !== null) {
    return (
      <p className="flex min-h-24 items-center justify-center rounded-lg border border-white/10 px-3 text-center text-muted-foreground">
        {list.empty}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      {list.rows.map((row) => (
        <ExpenseRow key={row.key} row={row} />
      ))}
      {list.more !== null && (
        <button
          type="button"
          data-slot="phone-money-more"
          onClick={() => setExpanded(!expanded)}
          className="h-12 w-full cursor-pointer border-b border-white/8 text-sm font-medium outline-none transition-colors duration-150 ease-in-out focus-visible:bg-muted/50 active:bg-muted/50 [-webkit-tap-highlight-color:transparent]"
        >
          {list.more}
        </button>
      )}
      <div
        data-slot="phone-money-expenses-total"
        className="flex justify-between gap-3 p-3 font-semibold tabular-nums"
      >
        <span>{list.footer.label}</span>
        <span>{list.footer.amount}</span>
      </div>
    </div>
  );
}

/**
 * The Expenses on the phone (board MMoney): "Items | All charges" over a box of rows, ten of them
 * and then "Show all N charges", and the month's total at the bottom. Read only; the Mac's rows
 * open to their charges, the phone's do not (the board's rows have no chevron). The switch is the
 * Money page's store, shared with the Mac.
 */
export function PhoneMoneyExpenses({ data }: { data: MoneyResponse }) {
  const view = useMoneyUiStore((state) => state.expensesView);
  const setView = useMoneyUiStore((state) => state.setExpensesView);
  return (
    <section aria-labelledby="phone-exp-h" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="phone-exp-h" className="text-base font-semibold">
          Expenses
        </h2>
        <p className="text-[13px] text-muted-foreground">{PHONE_EXPENSES_TEXT}</p>
      </div>
      <PhoneSegmented
        label="Show expenses as"
        options={VIEW_OPTIONS}
        value={view}
        onChange={setView}
      />
      <ExpensesList key={`${data.month}-${view}`} data={data} view={view} />
    </section>
  );
}
