import {
  Flag,
  Hash,
  type LucideIcon,
  Palette,
  PanelBottom,
  Shapes,
  Type,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { LibraryFrame } from './library-frame';
import {
  itemMeta,
  type LutPickerItem,
  lutPreviewAlt,
  PICKER_TEXT,
  type PickerItem,
  type PlacedAt,
  placedLine,
} from './picker-items';

const GRAPHIC_ICONS = {
  title: Type,
  'lower-third': PanelBottom,
  callout: Hash,
  'end-card': Flag,
  other: Shapes,
} as const;

/** The icon in front of an item: a palette for a look, a wrench for a fix, the graphic's kind for a graphic. */
export function itemIcon(item: PickerItem): LucideIcon {
  if (item.type === 'graphic') return GRAPHIC_ICONS[item.kind];
  return item.kind === 'fix' ? Wrench : Palette;
}

export function ItemIcon({ item, className }: { item: PickerItem; className?: string }) {
  const Icon = itemIcon(item);
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * The frame cut in two: the left half as it is, the right half with the LUT, a thin white divider
 * between and tiny Before / After labels. If either picture fails to load the frame is not drawn at
 * all, and the text beside it stays (the card never shows a broken image).
 */
function SplitFrame({
  item,
  frame,
  timeLabel,
  small,
}: {
  item: LutPickerItem;
  frame: LibraryFrame;
  timeLabel: PlacedAt;
  small: boolean;
}) {
  const beforeSrc = frame.beforeSrc;
  const afterSrc = frame.afterSrc(item.slug, item.previewKey);
  // A new picture gets a new chance: the failure belongs to the pair of addresses it happened to.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const pair = `${beforeSrc}|${afterSrc}`;
  if (beforeSrc === '' || failedFor === pair) return null;
  const onError = () => setFailedFor(pair);
  const label = cn(
    'absolute bottom-1.5 rounded-sm bg-black/60 px-[5px] font-medium text-white',
    small ? 'bottom-1 px-1 text-[9px] leading-[14px]' : 'text-[10px] leading-4',
  );
  return (
    <div
      role="img"
      aria-label={lutPreviewAlt(item, timeLabel)}
      data-slot="library-split-frame"
      className={cn(
        'relative shrink-0 overflow-hidden rounded-md bg-black',
        small ? 'h-[160px] w-[90px]' : 'h-[248px] w-[140px]',
      )}
    >
      <img
        src={beforeSrc}
        alt=""
        draggable={false}
        onError={onError}
        className="absolute inset-0 block size-full object-cover"
      />
      <img
        src={afterSrc}
        alt=""
        draggable={false}
        onError={onError}
        className="absolute inset-0 block size-full object-cover [clip-path:inset(0_0_0_50%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 -ml-px w-px bg-white"
        data-slot="library-split-divider"
      />
      <span aria-hidden="true" className={cn(label, small ? 'left-1' : 'left-1.5')}>
        {PICKER_TEXT.before}
      </span>
      <span aria-hidden="true" className={cn(label, small ? 'right-1' : 'right-1.5')}>
        {PICKER_TEXT.after}
      </span>
    </div>
  );
}

interface LibraryPreviewCardProps {
  item: PickerItem;
  frame: LibraryFrame;
  /** "0:12": the note's time, for "Placed at 0:12" and the picture's name. */
  timeLabel: PlacedAt;
  /** `pane`: the picker's right side (250 px). `tip`: the chip's tooltip (about 250 px wide, smaller picture). */
  variant: 'pane' | 'tip';
}

/**
 * What the picker's right pane and a chip's tooltip show about an item (board LUReview, `card`).
 * A LUT: the frame split before and after, its name, its line and "Look · built in" / "Look ·
 * yours". A graphic: its icon, name, "Lower third · 3 s" and "Placed at 0:12".
 */
export function LibraryPreviewCard({ item, frame, timeLabel, variant }: LibraryPreviewCardProps) {
  const tip = variant === 'tip';
  if (item.type === 'lut') {
    const text = (
      <div
        className={cn(
          'flex min-w-0 flex-col gap-0.5',
          tip ? 'flex-1' : 'mt-2.5 w-full text-pretty',
        )}
      >
        <div className="font-semibold">{item.name}</div>
        {item.description === '' ? null : (
          <div className={cn('text-muted-foreground', tip ? 'text-xs' : 'text-[13px]')}>
            {item.description}
          </div>
        )}
        <div className="mt-0.5 text-xs text-zinc-500">{itemMeta(item)}</div>
      </div>
    );
    return (
      <div
        data-slot="library-preview"
        data-variant={variant}
        className={cn(tip ? 'flex items-start gap-2.5 text-left' : 'flex flex-col items-center')}
      >
        <SplitFrame item={item} frame={frame} timeLabel={timeLabel} small={tip} />
        {text}
      </div>
    );
  }
  const Icon = itemIcon(item);
  if (tip) {
    return (
      <div
        data-slot="library-preview"
        data-variant={variant}
        className="flex items-start gap-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground"
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="font-semibold">{item.name}</div>
          <div className="text-xs text-zinc-500">{itemMeta(item)}</div>
          <div className="text-xs text-zinc-500">{placedLine(timeLabel)}</div>
        </div>
      </div>
    );
  }
  return (
    <div
      data-slot="library-preview"
      data-variant={variant}
      className="flex w-full flex-col items-center gap-1.5 rounded-lg border bg-card px-3 py-5"
    >
      <span
        aria-hidden="true"
        className="mb-1 inline-flex size-10 items-center justify-center rounded-lg bg-secondary text-foreground"
      >
        <Icon className="size-5" />
      </span>
      <div className="font-semibold">{item.name}</div>
      <div className="text-xs text-zinc-500">{itemMeta(item)}</div>
      <div className="text-xs text-zinc-500">{placedLine(timeLabel)}</div>
    </div>
  );
}
