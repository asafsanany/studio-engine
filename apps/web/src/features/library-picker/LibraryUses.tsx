import { X } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFontFaces } from '@/features/fonts/pane/use-font-face';
import { cn } from '@/lib/utils';
import { FontIcon, FontPreviewCard } from './FontPreviewCard';
import {
  FONT_PICKER_TEXT,
  type FontPickerCatalog,
  type FontPickerItem,
  heeboFaceFor,
  type PickerEntry,
} from './font-picker';
import { ItemIcon, LibraryPreviewCard } from './LibraryPreviewCard';
import type { LibraryFrame } from './library-frame';
import { entryLabel, removeUseLabel } from './note-uses';
import {
  graphicUseLine,
  PICKER_TEXT,
  type PickerItem,
  type PlacedAt,
  removeChipLabel,
} from './picker-items';

interface LibraryUsesProps {
  /** What the text names (`namedItems`, or `readNote` with fonts), once each. */
  items: readonly PickerEntry[];
  frame: LibraryFrame;
  /** "0:12": the note's time. */
  timeLabel: PlacedAt;
  /** The × of a chip: the note loses every copy of that token. */
  onRemove: (item: PickerEntry) => void;
  /**
   * The font library, when notes can name a font (`fontsInNotes`). Then a font gets a chip like any
   * other item, the chips of all three kinds are written with their `@` and read left to right (a
   * Hebrew note's too), and the row has a line about fonts. Left out, the row is LU8's.
   */
  fonts?: FontPickerCatalog;
}

interface ChipFrameProps {
  /** `data-token`: what the chip points at. */
  token: string;
  icon: ReactNode;
  /** What the chip says. */
  label: string;
  removeLabel: string;
  onRemove: () => void;
  /** What opens above the chip while the pointer or the focus is on it. */
  card: ReactNode;
  /**
   * Fonts are in the notes: the chip reads left to right even in a Hebrew note, and its card keeps
   * inside the dialog (it opens to the left of the chip's right edge when it would run out).
   */
  withFonts: boolean;
}

/** One chip with its card above it while the pointer or the focus is on it. */
function ChipFrame({ token, icon, label, removeLabel, onRemove, card, withFonts }: ChipFrameProps) {
  const tipId = useId();
  const [tip, setTip] = useState(false);
  const cardBox = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  // A chip near the right edge of the notes column opens its card to the left of its own right edge,
  // so the card is not cut off by the dialog.
  useLayoutEffect(() => {
    const box = cardBox.current;
    if (!tip || !withFonts || box === null) {
      setAlignRight(false);
      return;
    }
    const edge = box.closest('[role="dialog"]')?.getBoundingClientRect().right ?? window.innerWidth;
    setAlignRight(box.getBoundingClientRect().left + box.offsetWidth > edge - 8);
  }, [tip, withFonts]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only show the card; the × is the control.
    <span
      data-slot="library-chip"
      data-token={token}
      dir={withFonts ? 'ltr' : undefined}
      className="relative inline-flex"
      onPointerEnter={() => setTip(true)}
      onPointerLeave={() => setTip(false)}
      onFocus={() => setTip(true)}
      onBlur={() => setTip(false)}
    >
      <span className="box-border inline-flex h-6 items-center gap-1.5 rounded-md bg-[#3B82F6]/15 pr-[3px] pl-2 text-[13px] text-[#93C5FD]">
        {icon}
        {label}
        <button
          type="button"
          aria-label={removeLabel}
          aria-describedby={tip ? tipId : undefined}
          className="inline-flex size-[18px] cursor-pointer items-center justify-center rounded-sm text-[#93C5FD] transition-colors duration-150 ease-in-out outline-none hover:bg-[#93C5FD]/20 focus-visible:ring-[3px] focus-visible:ring-ring/35"
          onClick={() => {
            setTip(false);
            onRemove();
          }}
        >
          <X aria-hidden="true" className="size-3" strokeWidth={2.4} />
        </button>
      </span>
      {tip ? (
        <div
          ref={cardBox}
          role="tooltip"
          id={tipId}
          className={cn(
            'pointer-events-none absolute bottom-[calc(100%+8px)] z-30 box-border w-[252px] rounded-lg border bg-background p-2.5 text-left text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.55)]',
            alignRight ? 'right-0' : 'left-0',
          )}
        >
          {card}
        </div>
      ) : null}
    </span>
  );
}

/** A LUT's or a graphic's chip. */
function UsesChip({
  item,
  frame,
  timeLabel,
  onRemove,
  withAt,
}: {
  item: PickerItem;
  frame: LibraryFrame;
  timeLabel: PlacedAt;
  onRemove: (item: PickerEntry) => void;
  /** Fonts are in the notes: written `@luts/cinematic`, left to right. */
  withAt: boolean;
}) {
  return (
    <ChipFrame
      token={item.token}
      icon={<ItemIcon item={item} className="size-3.5 shrink-0" />}
      label={withAt ? entryLabel(item) : item.token}
      removeLabel={withAt ? removeUseLabel(item) : removeChipLabel(item)}
      onRemove={() => onRemove(item)}
      card={<LibraryPreviewCard item={item} frame={frame} timeLabel={timeLabel} variant="tip" />}
      withFonts={withAt}
    />
  );
}

/**
 * A font's chip: `@Heebo Bold`, and above it, on hover or focus, the name in its own font, the
 * Hebrew sample and the facts. The chip puts its font file in the page when it shows, so the card
 * opens already set in it.
 */
function FontUsesChip({
  item,
  fonts,
  onRemove,
}: {
  item: FontPickerItem;
  fonts: FontPickerCatalog;
  onRemove: (item: PickerEntry) => void;
}) {
  const heebo = useMemo(
    () => (item.family.he ? null : heeboFaceFor(fonts, item.face.weight)),
    [fonts, item.family.he, item.face.weight],
  );
  const faces = useMemo(
    () => (heebo === null ? [item.face] : [item.face, heebo]),
    [item.face, heebo],
  );
  useFontFaces(faces, fonts.allFaces);
  return (
    <ChipFrame
      token={item.token}
      icon={<FontIcon className="size-3.5 shrink-0" />}
      label={entryLabel(item)}
      removeLabel={removeUseLabel(item)}
      onRemove={() => onRemove(item)}
      card={<FontPreviewCard item={item} heebo={heebo} variant="tip" />}
      withFonts
    />
  );
}

/**
 * The "Uses" row under the note box (boards LUReview and FOReview): one removable chip for every
 * font, LUT and graphic the text names, and below them one dim line per kind (what a font is used
 * for, that a LUT applies to the whole video, where a graphic is placed). A token that points at
 * nothing shows no chip. Renders nothing when nothing is named.
 */
export function LibraryUses({ items, frame, timeLabel, onRemove, fonts }: LibraryUsesProps) {
  if (items.length === 0) return null;
  return (
    <div data-slot="library-uses" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{PICKER_TEXT.uses}</span>
        {items.map((item) =>
          item.type === 'font' ? (
            fonts === undefined ? null : (
              <FontUsesChip key={item.token} item={item} fonts={fonts} onRemove={onRemove} />
            )
          ) : (
            <UsesChip
              key={item.token}
              item={item}
              frame={frame}
              timeLabel={timeLabel}
              onRemove={onRemove}
              withAt={fonts !== undefined}
            />
          ),
        )}
      </div>
      {items.some((item) => item.type === 'font') ? (
        <p className="text-xs text-pretty text-zinc-500">{FONT_PICKER_TEXT.useLine}</p>
      ) : null}
      {items.some((item) => item.type === 'lut') ? (
        <p className="text-xs text-zinc-500">{PICKER_TEXT.lutUse}</p>
      ) : null}
      {items.some((item) => item.type === 'graphic') ? (
        <p className="text-xs text-zinc-500">{graphicUseLine(timeLabel)}</p>
      ) : null}
    </div>
  );
}
