import type { AnalyticsJobs, AnalyticsPeriod } from '@studio/shared';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnalyticsTileCard } from './AnalyticsCard';
import { tileCopy } from './analytics-copy';
import { Sparkline } from './charts/Sparkline';
import {
  CHANGE_TONE_CLASS,
  type ChangeTone,
  sparklineColor,
  sparkRows,
  sparkValueText,
  tileView,
} from './jobs-tiles-view';

/**
 * The five tiles of the top row (Jobs finished, Clients, Files in → ready, Editing time, Approved
 * first time): each a number for the last 30 days, its eight-week sparkline and how it compares
 * with the 30 days before; in the week period the last 7 days, a 14-day sparkline and the 7 days
 * before. The Clients sparkline is by day in both periods: each day's clients with a job finished
 * in the 30 (7) days up to it, ending on the tile's number. They sit in the page's tile grid, so this
 * renders the tiles side by side and nothing around them. A tile with nothing to count shows "—", an
 * empty sparkline and no change line, and keeps its size. Hovering a sparkline says which week
 * (day) the point is and its value.
 */
export function JobsTiles({
  tiles,
  period = 'month',
}: {
  tiles: AnalyticsJobs['tiles'];
  period?: AnalyticsPeriod;
}) {
  const copy = tileCopy(period);
  return (
    <>
      {tiles.map((tile) => {
        const view = tileView(tile, period);
        return (
          <AnalyticsTileCard key={tile.key} {...copy[tile.key]}>
            <div className="flex flex-col gap-2.5">
              {/* 28 px, but 24 px while five tiles share a row narrower than 1200 px (tiles of 133 to 170 px: "14 of 19" would run into the edge). */}
              <span className="text-[28px] leading-none font-semibold tracking-[-0.03em] whitespace-nowrap tabular-nums min-[1000px]:max-[1199px]:text-2xl">
                {view.value}
              </span>
              <Sparkline
                rows={sparkRows(tile, period)}
                label={copy[tile.key].title}
                formatValue={(value) => sparkValueText(tile, value)}
                color={sparklineColor(view.tone)}
              />
              <span
                className={cn(
                  'flex min-h-[1.25em] items-center gap-1 text-[13px] tabular-nums',
                  CHANGE_TONE_CLASS[view.tone],
                )}
              >
                {view.change !== '' && <ToneIcon tone={view.tone} />}
                {view.change}
              </span>
            </div>
          </AnalyticsTileCard>
        );
      })}
    </>
  );
}

/** Better is an up-trend in green, worse a down-trend in red, same / nothing to compare a grey dash. */
function ToneIcon({ tone }: { tone: ChangeTone }) {
  const Icon = tone === 'better' ? TrendingUp : tone === 'worse' ? TrendingDown : Minus;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}
