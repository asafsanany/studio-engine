import type { MoneyResponse } from '@studio/shared';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { StatusGlyph } from '../jobs/JobStatusIcon';
import {
  BANNER_TONE_STYLES,
  type BannerDirection,
  type BannerView,
  bannerViews,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
} from './banner-view';
import { deliveredOnly } from './ledger-view';

/** The three cards sit side by side while each can have 300 px, and stack when they cannot. */
const ROW = 'grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-6';

/** Every card is the same height, with data or without it. */
const CARD = 'flex h-[196px] flex-col rounded-[12px] border p-5';

/** The space between a card's parts: 14 px, or 8 px while the Income card has its "not paid yet" line. */
const CARD_GAP = 'gap-3.5';
const CARD_GAP_COMPACT = 'gap-2';

const DIRECTION_ICON: Record<BannerDirection, typeof TrendingUp> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
};

/** The last eight months as a line with a tint under it, in the card's accent colour. */
function Sparkline({ line, area, className }: BannerView['sparkline'] & { className: string }) {
  return (
    <svg
      aria-hidden="true"
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      // Fixed at 150 × 48; it only gives way (and scales down) when the card is too narrow.
      className={cn('h-12 w-[150px] min-w-0 shrink', className)}
    >
      <polygon points={area} fill="currentColor" fillOpacity={0.15} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One banner: its title and description, the change as a pill, the amount, the line and the change in words. */
function BannerCard({ banner, compact }: { banner: BannerView; compact: boolean }) {
  const tone = BANNER_TONE_STYLES[banner.tone];
  const Icon = DIRECTION_ICON[banner.direction];
  return (
    <section
      aria-label={banner.title}
      data-banner={banner.kind}
      data-tone={banner.tone}
      className={cn(CARD, compact ? CARD_GAP_COMPACT : CARD_GAP, tone.card)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
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
          <Icon aria-hidden="true" className="size-3.5" />
          {banner.percent}
        </span>
      </div>
      <div className="flex items-end justify-between gap-4">
        <span className="shrink-0 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {banner.value}
        </span>
        <Sparkline {...banner.sparkline} className={tone.accent} />
      </div>
      <span className={cn('text-[13px] tabular-nums', tone.accent)}>{banner.delta}</span>
      {banner.unpaid && (
        <div
          data-unpaid=""
          className="flex h-[22px] items-center gap-2 border-t border-white/[0.08] pt-[5px] text-[13px] leading-4"
        >
          {/* The Jobs list's Delivered icon at 14 px: "not paid yet" is the state a delivered video is in. */}
          <StatusGlyph kind="delivered" size={14} aria-hidden="true" />
          {/* One line, whatever the width: a card too narrow for it cuts the end rather than growing. */}
          <span className="min-w-0 truncate">
            <span className="font-medium tabular-nums">{banner.unpaid.amount}</span>{' '}
            <span className="text-muted-foreground">{banner.unpaid.text}</span>
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The Money page's three banners (Income, Expenses, Profit) for the month `data` is about. Green
 * when the change since last month is good, red when it is bad, grey when there is none.
 */
export function Banners({ data }: { data: Pick<MoneyResponse, 'month' | 'banners' | 'ledger'> }) {
  const banners = bannerViews(data.month, data.banners, deliveredOnly(data.ledger));
  // The "not paid yet" line needs the room the 14 px gaps take, so while it shows all three cards
  // tighten up together (and their parts stay level with each other) to keep their 196 px.
  const compact = banners.some((banner) => banner.unpaid !== null);
  return (
    <div data-slot="money-banners" className={ROW}>
      {banners.map((banner) => (
        <BannerCard key={banner.kind} banner={banner} compact={compact} />
      ))}
    </div>
  );
}

/** Three grey cards of the same size, for a first load that is taking its time. */
export function BannersSkeleton() {
  return (
    <div className={ROW}>
      {['income', 'expenses', 'profit'].map((kind, i) => (
        <div key={kind} data-skeleton-banner="" className={cn(CARD, CARD_GAP, 'border-border')}>
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
          <div className="flex items-end justify-between gap-4">
            <Skeleton className="h-11 w-36 motion-reduce:animate-none" />
            <Skeleton className="h-12 w-[150px] min-w-0 shrink motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-3.5 w-44 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}
