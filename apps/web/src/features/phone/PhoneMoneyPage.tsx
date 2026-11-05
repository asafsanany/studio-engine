import type { MoneyResponse } from '@studio/shared';
import { TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react';
import { EngineReconnecting } from '@/components/shell/EngineReconnecting';
import { Skeleton } from '@/components/ui/skeleton';
import { jobsUnreachable, useEngineReconnecting, useMoney } from '@/data';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { useMoneyUiStore } from '@/stores/money-ui';
import { StatusGlyph } from '../jobs/JobStatusIcon';
import {
  BANNER_TONE_STYLES,
  type BannerDirection,
  type BannerView,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
} from '../money/banner-view';
import { MONEY_SKELETON_DELAY_MS, MoneyUnreachable } from '../money/MoneyStates';
import { MonthSelect } from '../money/MonthSelect';
import { PhoneMoneyExpenses } from './PhoneMoneyExpenses';
import { PhoneMoneyLedger } from './PhoneMoneyLedger';
import { moneyFileLine, phoneBanners } from './phone-money';

/** The pill's arrow: a rising or a falling line; a flat banner (0%) has none, as the board draws it. */
const DIRECTION_ICON: Record<BannerDirection, typeof TrendingUp | null> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: null,
};

/** The last eight months as a line with a tint under it, 120 × 38 on the board, in the card's accent. */
function Sparkline({ line, area, className }: BannerView['sparkline'] & { className: string }) {
  return (
    <svg
      aria-hidden="true"
      width={120}
      height={38}
      // The Mac's points (150 × 48), drawn smaller; the line keeps its 1.5 px.
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      className={cn('h-[38px] w-[120px] flex-none', className)}
    >
      <polygon points={area} fill="currentColor" fillOpacity={0.15} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * One banner, full width: its title and description, the change as a pill, the amount at 36 px
 * with the sparkline, and the change in words; Income adds "₪160 not paid yet · 4 videos". Green
 * when the change since last month is good, red when it is bad, grey when there is none.
 */
function BannerCard({ banner }: { banner: BannerView }) {
  const tone = BANNER_TONE_STYLES[banner.tone];
  const Icon = DIRECTION_ICON[banner.direction];
  return (
    <section
      aria-label={banner.title}
      data-banner={banner.kind}
      data-tone={banner.tone}
      className={cn('box-border flex flex-col gap-2 rounded-xl border px-4 py-3.5', tone.card)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">{banner.title}</span>
          <span className="text-[13px] text-muted-foreground">{banner.description}</span>
        </div>
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap tabular-nums',
            tone.pill,
            tone.accent,
          )}
        >
          {Icon && <Icon aria-hidden="true" className="size-3.5" />}
          {banner.percent}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {banner.value}
        </span>
        <Sparkline {...banner.sparkline} className={tone.accent} />
      </div>
      <span className={cn('text-[13px] tabular-nums', tone.accent)}>{banner.delta}</span>
      {banner.unpaid && (
        <span
          data-unpaid=""
          className="flex items-center gap-1.5 border-t border-white/8 pt-2 text-[13px] text-muted-foreground tabular-nums"
        >
          {/* The Jobs list's Delivered icon: "not paid yet" is the state a delivered video is in. */}
          <StatusGlyph kind="delivered" size={14} aria-hidden="true" />
          <span className="min-w-0 truncate">
            {banner.unpaid.amount} {banner.unpaid.text}
          </span>
        </span>
      )}
    </section>
  );
}

/** Three grey cards the size of the real ones, for a first load that is taking its time. */
function PhoneMoneySkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {['income', 'expenses', 'profit'].map((kind, i) => (
        <div
          key={kind}
          data-skeleton-banner=""
          className="box-border flex h-[138px] flex-col gap-2 rounded-xl border px-4 py-3.5"
        >
          {i === 0 && (
            <span role="status" className="sr-only">
              Loading the month…
            </span>
          )}
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-20 motion-reduce:animate-none" />
              <Skeleton className="h-3.5 w-36 motion-reduce:animate-none" />
            </div>
            <Skeleton className="h-6 w-14 rounded-full motion-reduce:animate-none" />
          </div>
          <div className="flex items-end justify-between gap-3">
            <Skeleton className="h-9 w-32 motion-reduce:animate-none" />
            <Skeleton className="h-[38px] w-[120px] motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The warning line under the title while money.json has a mistake (board MMoneyWarn): an amber
 * triangle and one muted sentence, no box and no button; the doctor on the Mac shows the rest.
 * Nothing at all while the file is fine.
 */
function MoneyFileLine({ moneyFile }: { moneyFile: MoneyResponse['moneyFile'] }) {
  const text = moneyFileLine(moneyFile);
  if (text === null) return null;
  return (
    <p
      role="status"
      data-money-file={moneyFile.status}
      className="flex items-start gap-2 pb-2 text-[13px] text-pretty text-muted-foreground"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-4 flex-none text-status-held"
        strokeWidth={2}
      />
      <span>{text}</span>
    </p>
  );
}

/**
 * The Money tab on the phone: the page `/money` shows in place of the Mac's on the phone layout.
 * This is the data around `PhoneMoneyView`: the month picked (the Money page's store), the month's
 * numbers from the same query as the Mac, whether the engine is out of reach, and the
 * "Reconnecting…" line.
 */
export function PhoneMoneyPage({
  skeletonDelayMs = MONEY_SKELETON_DELAY_MS,
}: {
  /** How long the first load may take before grey placeholders appear (default 300 ms). */
  skeletonDelayMs?: number;
}) {
  const month = useMoneyUiStore((state) => state.month);
  const setMonth = useMoneyUiStore((state) => state.setMonth);
  const { data, isError, failureCount, refetch } = useMoney(month);
  const reconnecting = useEngineReconnecting();
  return (
    <PhoneMoneyView
      month={month}
      onMonthChange={setMonth}
      data={data}
      failed={jobsUnreachable({ data, isError, failureCount })}
      onRetry={() => void refetch()}
      reconnecting={reconnecting}
      skeletonDelayMs={skeletonDelayMs}
    />
  );
}

export interface PhoneMoneyViewProps {
  /** The month picked, YYYY-MM. */
  month: string;
  onMonthChange: (month: string) => void;
  /** The month's numbers from `useMoney`: `undefined` until the first load. */
  data: MoneyResponse | undefined;
  /** The first load failed (the engine cannot be reached). Read only while `data` is `undefined`. */
  failed?: boolean;
  onRetry?: () => void;
  /** The engine has been out of reach for a while: a line under the title says so. */
  reconnecting?: boolean;
  /** How long the first load may take before grey placeholders appear (default 300 ms). */
  skeletonDelayMs?: number;
}

/**
 * The page itself (boards MMoney, MMoneyWarn). Top to bottom: the title with the month picker as
 * an outlined button, the money.json warning line when there is a mistake, the three banners
 * stacked full width, the Ledger and the Expenses. Everything it says is what the Mac's Money page
 * says for the same month: the banners, rows and totals come from the Mac's view models
 * (`phone-money.ts` only picks and words them). Read only. The page reaches the screen's edges:
 * the shell pads its page area, so the page takes that top padding back.
 */
export function PhoneMoneyView({
  month,
  onMonthChange,
  data,
  failed = false,
  onRetry,
  reconnecting = false,
  skeletonDelayMs = MONEY_SKELETON_DELAY_MS,
}: PhoneMoneyViewProps) {
  const showSkeleton = useDelayedFlag(data === undefined && !failed, skeletonDelayMs);
  const unreachable = data === undefined && failed;

  return (
    <div
      data-slot="phone-money-page"
      className="-mt-4 flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <header className="flex h-[52px] items-center justify-between gap-3">
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Money</h1>
        <MonthSelect phone month={month} months={data?.months} onChange={onMonthChange} />
      </header>

      <EngineReconnecting reconnecting={reconnecting} className="has-[p]:pb-2" />
      {data && <MoneyFileLine moneyFile={data.moneyFile} />}

      <div className="flex flex-col gap-7 pt-2 pb-2">
        {unreachable ? (
          <MoneyUnreachable onRetry={() => onRetry?.()} />
        ) : data ? (
          <>
            <div data-slot="phone-money-banners" className="flex flex-col gap-3">
              {phoneBanners(data).map((banner) => (
                <BannerCard key={banner.kind} banner={banner} />
              ))}
            </div>
            <PhoneMoneyLedger data={data} />
            <PhoneMoneyExpenses data={data} />
          </>
        ) : showSkeleton ? (
          <PhoneMoneySkeleton />
        ) : null}
      </div>
    </div>
  );
}
