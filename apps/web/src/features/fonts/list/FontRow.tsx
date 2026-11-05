import { absoluteTime, type FontFamilySummary, relativeTime } from '@studio/shared';
import { CaseSensitive } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { isContextMenuKey, openMenuFromKeyboard } from '@/features/jobs/row-menu-key';
import { bidiProps } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import type { FontActions } from './font-actions';
import {
  FONT_LIST_TEXT,
  type FontMenuId,
  fontMenuEntries,
  scriptText,
  showsNewTag,
} from './font-list';

/**
 * What a row drops as the list gets narrow (CVP-366). The width that counts is the LIST's own
 * (`@container` on its root, `FontListView`), not the window's: the open pane takes 440 px, so the
 * list is 296 px wide in a 1024 px window, 552 px in a 1280 px one and 712 px in a 1440 px one.
 * The name is the point of the row, so a column leaves before the name would get under about
 * 100 px. They go in this order: the used label under 590 px (it needs 488 px beside the name, and
 * only shows while notes can name a font), when it was added under 480 px, the weights under 400 px
 * and the script under 288 px; the pane has the facts of the open family. A row drawn without a
 * container (a test) matches no query and stays whole.
 */
export const FONT_CELL_NARROW = {
  script: '@max-[288px]:hidden',
  weights: '@max-[400px]:hidden',
  used: '@max-[590px]:hidden',
  added: '@max-[480px]:hidden',
} as const;

/**
 * A row of the list: 44 px high, on a grid of the icon (16 px), the name (the rest of the width,
 * with the "New" tag after it), the script (124 px), the weights (84 px), the used label (96 px)
 * and when it was added (84 px, right-aligned), 12 px apart with 12 px of room on each side (board
 * FOPage). The skeleton rows share it, so a placeholder sits where the content will. Narrower than
 * the board's list (see {@link FONT_CELL_NARROW}) a column leaves and the grid loses its track.
 */
export const FONT_ROW_LAYOUT = cn(
  'grid h-11 grid-cols-[16px_minmax(0,1fr)_124px_84px_96px_84px] items-center gap-3 rounded-lg px-3',
  '@max-[590px]:grid-cols-[16px_minmax(0,1fr)_124px_84px_84px]',
  '@max-[480px]:grid-cols-[16px_minmax(0,1fr)_124px_84px]',
  '@max-[400px]:grid-cols-[16px_minmax(0,1fr)_124px]',
  '@max-[288px]:grid-cols-[16px_minmax(0,1fr)]',
);

/**
 * The same row without the used column: while notes cannot name a font (`fontsInNotes` off) no use
 * is counted, so the column would say "Not used yet" on every row. Its room goes to the name. It
 * drops the added column, the weights and the script at the same widths as the full row.
 */
export const FONT_ROW_LAYOUT_NO_USE = cn(
  'grid h-11 grid-cols-[16px_minmax(0,1fr)_124px_84px_84px] items-center gap-3 rounded-lg px-3',
  '@max-[480px]:grid-cols-[16px_minmax(0,1fr)_124px_84px]',
  '@max-[400px]:grid-cols-[16px_minmax(0,1fr)_124px]',
  '@max-[288px]:grid-cols-[16px_minmax(0,1fr)]',
);

/** The grid of a row, with or without the used column. */
export function fontRowLayout(inNotes: boolean): string {
  return inNotes ? FONT_ROW_LAYOUT : FONT_ROW_LAYOUT_NO_USE;
}

export interface FontRowProps {
  family: FontFamilySummary;
  /** The family whose pane is open: the row takes the quiet background. */
  selected: boolean;
  /** The time, as epoch milliseconds: it decides the "New" tag and the "added" text. */
  now: number;
  actions: FontActions;
  /**
   * Notes can name a font (the `fontsInNotes` switch is on). Off, the row has no used column and
   * its menu no "Copy @name": nothing counts use or reads the name yet.
   */
  inNotes: boolean;
  /** The row was picked (a click on it, or its menu opening). */
  onSelect: (slug: string) => void;
  /** Delete… was chosen: the list asks "Delete “Name”?". */
  onAskDelete: (family: FontFamilySummary) => void;
}

/**
 * One family of the list. A quiet row with no lines and no preview (text only, as the owner asked): the
 * icon, the name (a button, and a click anywhere on the row is a click on it) with a "New" tag for
 * 30 minutes after an import, its script, "9 weights", how much it was used and when it was added.
 * Everything else is in the right-click menu, which Shift+F10 and the menu key open too. The row
 * takes the quiet background while the pointer is over it, while its menu is open, while its name
 * has keyboard focus and while it is the open one.
 */
export function FontRow({
  family,
  selected,
  now,
  actions,
  inNotes,
  onSelect,
  onAskDelete,
}: FontRowProps) {
  function choose(id: FontMenuId) {
    if (id === 'reveal') void actions.reveal(family.slug);
    else if (id === 'copy') void actions.copyToken(family.name);
    else onAskDelete(family);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-font-slug={family.slug}
          data-selected={selected ? 'true' : 'false'}
          className={cn(
            fontRowLayout(inNotes),
            'relative transition-colors duration-150 ease-in-out hover:bg-muted/60 has-[[data-slot=font-name]:focus-visible]:bg-muted/60 data-[selected=true]:bg-muted/60 data-[state=open]:bg-muted/60',
          )}
          onContextMenu={() => onSelect(family.slug)}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          <span className="flex">
            <CaseSensitive aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              dir="auto"
              data-slot="font-name"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(family.slug)}
              // The button's own box is the name; its ::after covers the whole row, so the row is the target.
              className={cn(
                bidiProps.className,
                "min-w-0 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']",
              )}
            >
              {family.name}
            </button>
            {showsNewTag(family, now) && (
              <span
                data-slot="font-new"
                className="relative inline-flex h-[18px] flex-none items-center rounded-full bg-blue-500/15 px-1.5 text-[11px] font-medium text-blue-300"
              >
                {FONT_LIST_TEXT.newTag}
              </span>
            )}
          </span>
          <span
            data-slot="font-script"
            className={cn(
              'text-[13px] whitespace-nowrap text-muted-foreground',
              FONT_CELL_NARROW.script,
            )}
          >
            {scriptText(family)}
          </span>
          <span
            data-slot="font-weights-label"
            className={cn(
              'text-[13px] whitespace-nowrap text-muted-foreground',
              FONT_CELL_NARROW.weights,
            )}
          >
            {family.weightsLabel}
          </span>
          {inNotes && (
            <span
              data-slot="font-used"
              className={cn(
                'truncate text-[13px] whitespace-nowrap text-muted-foreground',
                FONT_CELL_NARROW.used,
              )}
            >
              {family.usedLabel}
            </span>
          )}
          <span
            data-slot="font-added"
            className={cn(
              'text-right text-[13px] whitespace-nowrap text-muted-foreground',
              FONT_CELL_NARROW.added,
            )}
            title={absoluteTime(family.addedAt) || undefined}
          >
            {relativeTime(family.addedAt, now)}
          </span>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-55" aria-label={`Actions for ${family.name}`}>
        {fontMenuEntries(family, { inNotes }).map((entry) =>
          entry.type === 'separator' ? (
            <ContextMenuSeparator key={entry.id} />
          ) : (
            <ContextMenuItem
              key={entry.id}
              variant={entry.destructive ? 'destructive' : 'default'}
              onSelect={() => choose(entry.id)}
            >
              {entry.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
