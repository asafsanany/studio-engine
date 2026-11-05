import { ArrowUpRight } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useFontFaces } from '@/features/fonts/pane/use-font-face';
import { cn } from '@/lib/utils';
import { FontIcon, FontPreviewCard, fontRowStyle } from './FontPreviewCard';
import {
  type FontPickerCatalog,
  heeboFaceFor,
  type NotePickerView,
  type PickerEntry,
  visibleFontFaces,
} from './font-picker';
import { ItemIcon, LibraryPreviewCard } from './LibraryPreviewCard';
import type { LibraryFrame } from './library-frame';
import { PICKER_TEXT, type PickerNone, type PlacedAt } from './picker-items';

/** Both popovers sit above the box, 6 px off it, on its right edge; the wide one grows to the left over the video. */
const POPOVER =
  'absolute right-0 bottom-[calc(100%+6px)] z-20 box-border flex flex-col rounded-xl border bg-background text-popover-foreground shadow-[0_16px_40px_rgba(0,0,0,0.55)]';

/** The id of the row at `index`: what the textarea's `aria-activedescendant` names. */
export function pickerOptionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

interface LibraryPickerListProps {
  /** The groups to show: LU8's `PickerView` fits, and so does the one with the fonts group (`notePickerView`). */
  view: NotePickerView;
  highlight: number;
  listId: string;
  /** "0:12": the note's time, shown in "Placed at …". */
  timeLabel: PlacedAt;
  frame: LibraryFrame;
  /** The pointer moved over row `index`: it takes the highlight. */
  onHover: (index: number) => void;
  onPick: (item: PickerEntry) => void;
  /**
   * The font library, when notes can name a font (`fontsInNotes`): the font rows are set in their
   * own files, which the list puts in the page as it shows them. Left out, the list is LU8's.
   */
  fonts?: FontPickerCatalog;
}

/**
 * The picker (boards LUReview and FOReview): a list of fonts, LUTs and graphics on the left
 * (321 px), the highlighted one on the right (the rest of 574 px), and the keys under them. Its
 * parent must be `relative` and sit around the textarea. The list's rows are options of a listbox
 * that never takes the focus: the textarea keeps it and names the highlighted row in
 * `aria-activedescendant`, and pressing the mouse on the popover does not move the focus either.
 * A font row is set in its own font at 16 px and is 32 px high (the rows of a list without fonts
 * are 30); the card of a font is the Hebrew and English caption on a test frame.
 */
export function LibraryPickerList({
  view,
  highlight,
  listId,
  timeLabel,
  frame,
  onHover,
  onPick,
  fonts,
}: LibraryPickerListProps) {
  const current = view.flat[highlight];
  const hasFonts = view.groups.some((group) => group.library === 'fonts');
  // Only the rows on show put a file in the page, and only once (the registry keeps them).
  const faces = useMemo(
    () => (fonts === undefined ? [] : visibleFontFaces(view.flat, current, fonts)),
    [fonts, view.flat, current],
  );
  useFontFaces(faces, fonts?.allFaces);
  const heebo =
    fonts !== undefined && current?.type === 'font' && !current.family.he
      ? heeboFaceFor(fonts, current.face.weight)
      : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the mouse press only keeps the focus in the textarea; the rows are the controls.
    <div
      data-slot="library-picker"
      className={cn(POPOVER, 'w-[574px]')}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex h-[372px]">
        <div
          role="listbox"
          id={listId}
          aria-label={PICKER_TEXT.listLabel}
          className="box-border w-[321px] shrink-0 overflow-y-auto overscroll-contain p-1.5 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-secondary"
        >
          {view.groups.map((group) => (
            <div key={group.library} role="presentation">
              <div
                role="presentation"
                className="box-border h-[26px] px-2 pt-2 text-xs font-medium text-zinc-500"
              >
                {group.head}
              </div>
              {group.items.map((item) => {
                const at = view.flat.indexOf(item);
                const selected = at === highlight;
                return (
                  <button
                    key={item.token}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={pickerOptionId(listId, at)}
                    aria-selected={selected}
                    title={item.token}
                    onMouseMove={() => {
                      if (!selected) onHover(at);
                    }}
                    onClick={() => onPick(item)}
                    className={cn(
                      'box-border flex',
                      hasFonts ? 'h-8' : 'h-[30px]',
                      'w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-foreground outline-none',
                      selected ? 'bg-accent/60' : 'bg-transparent',
                    )}
                  >
                    {item.type === 'font' ? (
                      <>
                        <FontIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span
                          className="min-w-0 truncate text-base whitespace-nowrap"
                          style={fontRowStyle(item.face)}
                        >
                          {item.name}
                        </span>
                        <span className="ml-2 min-w-0 flex-1 truncate text-right text-xs text-zinc-500">
                          {item.right}
                        </span>
                      </>
                    ) : (
                      <>
                        <ItemIcon item={item} className="size-4 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 whitespace-nowrap">{item.name}</span>
                        <span className="ml-auto min-w-0 truncate text-xs text-zinc-500">
                          {item.token}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="box-border flex min-w-0 flex-1 flex-col items-center border-l bg-[#121214] p-3 text-center">
          {current === undefined ? null : current.type === 'font' ? (
            <FontPreviewCard item={current} heebo={heebo} />
          ) : (
            <LibraryPreviewCard item={current} frame={frame} timeLabel={timeLabel} variant="pane" />
          )}
        </div>
      </div>
      <div className="box-border border-t px-3 py-2 text-xs text-zinc-500">{PICKER_TEXT.hint}</div>
    </div>
  );
}

/**
 * The small panel for a query that matches nothing: the sentence, and for a named library a ghost
 * button to its page. It takes no keys; typing on changes the query, Esc closes it. 300 px wide
 * (board LUReview); with fonts in the notes (`withFonts`) 320 px, as board FOReview draws it.
 */
export function LibraryPickerNone({
  none,
  onOpenPage,
  withFonts = false,
}: {
  none: PickerNone;
  onOpenPage: (to: '/luts' | '/graphics' | '/fonts') => void;
  withFonts?: boolean;
}) {
  const { action } = none;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the mouse press only keeps the focus in the textarea; the rows are the controls.
    <div
      data-slot="library-picker-none"
      className={cn(POPOVER, withFonts ? 'w-[320px]' : 'w-[300px]', 'items-start gap-2 p-3')}
      onMouseDown={(event) => event.preventDefault()}
    >
      <p>{none.message}</p>
      {action === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-[13px] text-muted-foreground has-[>svg]:pr-2 has-[>svg]:pl-2.5"
          onClick={() => onOpenPage(action.to)}
        >
          {action.label}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
