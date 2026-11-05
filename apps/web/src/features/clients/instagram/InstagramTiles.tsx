import type { InstagramNumbers } from '@studio/shared';
import type { ReactNode } from 'react';
import { Sparkline } from '@/features/analytics/charts/Sparkline';
import { CHANGE_TONE_CLASS, type ChangeTone } from '@/features/analytics/jobs-tiles-view';
import { cn } from '@/lib/utils';
import { InstagramCard } from './InstagramCard';
import { OURS } from './instagram-colors';
import { countText, type TextOptions } from './instagram-text';
import {
  type FollowersTileView,
  type PairTileView,
  type SharesTileView,
  tilesView,
} from './tiles-view';

/** The tiles' big number, 28 px (20 px for the second one of a pair). */
function Big({ size = 'lg', children }: { size?: 'lg' | 'md'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'leading-none font-semibold tracking-[-0.03em] whitespace-nowrap tabular-nums',
        size === 'lg' ? 'text-[28px]' : 'text-xl',
      )}
    >
      {children}
    </span>
  );
}

function Small({ tone = 'same', children }: { tone?: ChangeTone; children: ReactNode }) {
  return (
    <span className={cn('text-[13px] tabular-nums', CHANGE_TONE_CLASS[tone])}>{children}</span>
  );
}

/** A tile with a sparkline lets the line's hover card hang out under it instead of cutting it off. */
const HOVER_CARD_ROOM = 'overflow-visible';

function FollowersTile({ tile }: { tile: FollowersTileView }) {
  return (
    <InstagramCard
      title={tile.title}
      subtitle={tile.subtitle}
      gap="gap-2.5"
      className={HOVER_CARD_ROOM}
    >
      <Big>{tile.value}</Big>
      <Sparkline
        rows={tile.rows}
        label={tile.title}
        formatValue={(value) => `${countText(value)} followers`}
        color={OURS}
      />
      {tile.change !== '' && <Small tone={tile.tone}>{tile.change}</Small>}
    </InstagramCard>
  );
}

function PairTile({ tile }: { tile: PairTileView }) {
  return (
    <InstagramCard title={tile.title} subtitle={tile.subtitle} gap="gap-2.5">
      <div className="flex items-baseline gap-2">
        <Big>{tile.ours}</Big>
        <Small>ours</Small>
      </div>
      <div className="flex items-baseline gap-2">
        <Big size="md">{tile.theirs}</Big>
        <Small>their other reels</Small>
      </div>
      {tile.ratio !== '' && <Small tone={tile.tone}>{tile.ratio}</Small>}
    </InstagramCard>
  );
}

function SharesTile({ tile }: { tile: SharesTileView }) {
  return (
    <InstagramCard
      title={tile.title}
      subtitle={tile.subtitle}
      gap="gap-2.5"
      className={HOVER_CARD_ROOM}
    >
      <Big>{tile.value}</Big>
      <Sparkline
        rows={tile.rows}
        label={tile.title}
        formatValue={(value) => `${countText(value)} new shares`}
        color={OURS}
      />
      {tile.split !== '' && <Small>{tile.split}</Small>}
      {tile.change !== '' && <Small tone={tile.tone}>{tile.change}</Small>}
    </InstagramCard>
  );
}

/**
 * The four tiles of the Instagram section, side by side from 1200 px, two by two from 640 px and in
 * one column below: Followers (the number, the line of the scans with a dot on each week one of
 * our reels was posted, this week's and since-us change), Plays per reel and Likes per reel (ours
 * next to their other reels, and the ratio), and Shares a week (all new shares, the line of the
 * weeks, ours · theirs, the change on the week before). A number the scans have not read yet is "—"
 * and its change line is left out. `numbers` is the range's (`numbers.range`).
 */
export function InstagramTiles({
  numbers,
  textOptions,
}: {
  numbers: InstagramNumbers;
  textOptions?: TextOptions;
}) {
  const view = tilesView(numbers, textOptions);
  return (
    <div className="grid grid-cols-1 gap-4 min-[640px]:grid-cols-2 min-[1200px]:grid-cols-4">
      <FollowersTile tile={view.followers} />
      <PairTile tile={view.plays} />
      <PairTile tile={view.likes} />
      <SharesTile tile={view.shares} />
    </div>
  );
}
