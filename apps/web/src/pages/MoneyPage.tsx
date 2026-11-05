import { jobsUnreachable, useMoney } from '@/data';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';
import { Banners, BannersSkeleton } from '@/features/money/Banners';
import { Expenses } from '@/features/money/Expenses';
import { Ledger } from '@/features/money/Ledger';
import { MoneyFileWarning } from '@/features/money/MoneyFileWarning';
import {
  BANNERS_MIN_HEIGHT,
  MONEY_SKELETON_DELAY_MS,
  MoneyUnreachable,
} from '@/features/money/MoneyStates';
import { MonthSelect } from '@/features/money/MonthSelect';
import { useMoneyUiStore } from '@/stores/money-ui';

/**
 * The Money page: what the owner earned, spent and kept in a month. The title with the month picker at
 * its right, a warning line when money.json has a mistake (nothing otherwise), the three banners
 * (Income, Expenses, Profit), then the Ledger of the month's jobs and the list of Expenses.
 * Read-only. The month lives in the Money UI store, so the Ledger and the
 * Expenses read the same one; they load their numbers through the same query as this page.
 */
export function MoneyPage({
  skeletonDelayMs = MONEY_SKELETON_DELAY_MS,
}: {
  /** How long the first load may take before grey placeholders appear (default 300 ms). */
  skeletonDelayMs?: number;
}) {
  const month = useMoneyUiStore((state) => state.month);
  const setMonth = useMoneyUiStore((state) => state.setMonth);
  const { data, isError, failureCount, refetch } = useMoney(month);
  const unreachable = jobsUnreachable({ data, isError, failureCount });
  const showSkeleton = useDelayedFlag(data === undefined && !unreachable, skeletonDelayMs);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Money</h1>
        <MonthSelect month={month} months={data?.months} onChange={setMonth} />
      </div>
      {unreachable ? (
        <MoneyUnreachable onRetry={() => void refetch()} />
      ) : (
        <>
          {data && <MoneyFileWarning moneyFile={data.moneyFile} />}
          <div className={BANNERS_MIN_HEIGHT}>
            {data ? <Banners data={data} /> : showSkeleton ? <BannersSkeleton /> : null}
          </div>
          <Ledger />
          <Expenses />
        </>
      )}
    </div>
  );
}
