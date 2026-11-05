import { isArchived, isFolderDeleted, type Job } from '@studio/shared';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useDraftChatEnabled, useSeriesEnabled } from '@/data';
import { rowOpensChat } from '@/features/job-chat/job-chat-logic';
import { JobRowPanel } from '@/features/job-sheet/JobRowPanel';
import { inTypingField } from '@/features/job-sheet/job-sheet-keys';
import { useOpenJobSheetId, useRowSheetOpener } from '@/features/job-sheet/job-sheet-open';
import { openReview } from '@/features/review/review-dialog';
import { cn } from '@/lib/utils';
import { type TreeFlags, treeContinues, treePosition } from './by-client';
import { type RowActions, RowActionsContext, useRowActions } from './cells/use-row-actions';
import { focusJobRow } from './row-focus';
import { isContextMenuKey, openMenuFromKeyboard } from './row-menu-key';
import { RowMenuEntries } from './row-menu-views';
import { opensSheetOnClick } from './row-open';

// The views of a job's menu live in row-menu-views.tsx (the job sheet's ⋯ menu draws the same
// entries); the Clients page and the tests still import them from here.
export { RowMenuItemLabel, RowMenuItemView, RowMenuSubmenuView } from './row-menu-views';

/** The width of the board's menu (208 px). */
export const MENU_WIDTH = 'w-52';

/** A ready row's menu is wider (264 px on the boards): an approved row's last item is a sentence. */
export const READY_MENU_WIDTH = 'w-66';

/**
 * The width of a job's menu: the board's, or the wider one of a ready row (Use this look) and of an
 * episode of a series while series are on ("Open the series <name>" and "Use as the series
 * format…" are sentences too, and wrap in 208 px; board SeriesPage's menu is 264). A video whose
 * folder was deleted has no Use this look: its menu is the board's.
 */
export function menuWidth(job: Pick<Job, 'state' | 'seriesId'>, seriesOn = false): string {
  const ready = job.state === 'ready' && !isFolderDeleted(job);
  return ready || (seriesOn && job.seriesId !== null) ? READY_MENU_WIDTH : MENU_WIDTH;
}

/**
 * A row of the list: 44 px high, on a grid of the status icon (16 px), the name (the rest of the
 * width), the detail (as wide as its text), the time (80 px) and the next-step button (32 px), 12 px
 * apart, with 12 px of room on the left and 6 px on the right. The skeleton rows share it, so a
 * placeholder sits where the content will.
 */
export const ROW_LAYOUT_CLASSES =
  'grid h-11 grid-cols-[16px_minmax(0,1fr)_auto_80px_32px] items-center gap-3 rounded-lg pr-1.5 pl-3';

interface JobRowProps {
  job: Job;
  /** The row's five cells, in the order of the grid. */
  children: ReactNode;
  /**
   * The row is the list's one Tab stop (`tabIndex` 0). The list says so while the job sheet is on:
   * with it off every row is -1, as before.
   */
  tabStop?: boolean;
  /**
   * Where the row sits in its client's tree, in the By client view: the row is one step in, with
   * an elbow into its middle from the client's line. `undefined` is the flat list.
   */
  tree?: TreeFlags;
}

/**
 * A row of the Jobs list with its right-click menu. A right-click anywhere on the row opens it,
 * and so does Shift+F10 or the keyboard's menu key while focus is inside the row (a control of the
 * row, or the row itself), so every action is reachable without the mouse. The menu comes from
 * `rowMenuEntries` (Review… and Approve for a job in Review, which only this menu offers on the Mac;
 * the note and Effort ▸, then the actions of the job's state, then, for a ready
 * job, Use this look or the way back from its stage, then the series items, and last Archive or
 * Unarchive).
 *
 * An archived job's row (Show archived is on) is faded: everything in it but the last cell, the
 * next-step button, and its tree line is at 55%, until it is opened. The row says so with `data-archived`.
 *
 * Under a client's name (By client, the `tree` flags) the row is 28 px further in, and draws the
 * tree the phone's list has: an elbow from the line down the left of the client's rows into the
 * middle of its 44 px, and the line on to the next row (the last row ends the line at its elbow).
 * The 2 px between the rows, and an open job's margin, are bridged, so the line is unbroken.
 *
 * The row owns what it can do (`useRowActions`) and shares it with the menu and, through context,
 * with the Action cell, so the button and the menu act on one set of requests: a request sent from
 * the menu disables the button, and a refusal is explained under the button whichever sent it.
 *
 * The row has no lines and no outline. It takes a quiet background on hover, while its menu is
 * open (Radix puts `data-state="open"` on it: the menu is modal, so the pointer is not "over" the
 * row any more) and while it has keyboard focus. The row can be focused (by a click, or by the
 * page, which gives it focus back when a dialog or the open job closes); it is reached with Tab
 * only when it is the list's one Tab stop (`tabStop`).
 *
 * With the job sheet on, a click anywhere on the row opens the job under it, and a second click
 * closes it, except on a link, a button, a mark with a tooltip or the Action cell, which do their
 * own thing, or after selecting some of its text; so does Enter on the row itself, and Esc
 * anywhere in the open job closes it. One job is open at a time: a click on another row moves it
 * there. With Draft & chat on, a job in Review, waiting in line or running opens its chat (Review)
 * on a click instead; it still opens under its row from its menu's "Versions…" or a link. A
 * right-click on the row is the menu, as ever.
 *
 * The open job (`data-sheet-open`) is a card: the row grows a second line of its grid with the
 * job's panel (`JobRowPanel`) across all five columns, takes a faint fill and a 1 px line round it
 * (a shadow, so nothing moves), and 6 px of room above and below. It has no hover background of
 * its own then. It is scrolled into view when it opens below the fold. A click or a right-click in
 * the panel is the panel's: it neither closes the job nor opens the row's menu.
 */
export function JobRow({ job, children, tabStop = false, tree }: JobRowProps) {
  const actions = useRowActions(job);
  const sheet = useRowSheetOpener();
  const sheetOpen = useOpenJobSheetId() === job.id;
  const chat = rowOpensChat(job, useDraftChatEnabled());
  // What a click or Enter on the row does: open the job's chat, open the job under the row or
  // close it again, or nothing.
  const open = chat
    ? () => openReview(job.id)
    : sheet === null
      ? null
      : () => (sheetOpen ? sheet.close() : sheet.open(job.id));
  const item = useRef<HTMLLIElement>(null);
  // A job that opens below the fold is brought into view: all of it when it fits, else its top.
  useEffect(() => {
    if (!sheetOpen) return;
    const frame = requestAnimationFrame(() => revealOpenJob(item.current));
    return () => cancelAnimationFrame(frame);
  }, [sheetOpen]);
  return (
    <RowActionsContext.Provider value={actions}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <li
            ref={item}
            data-job-id={job.id}
            data-archived={isArchived(job) ? '' : undefined}
            data-folder-deleted={isFolderDeleted(job) ? '' : undefined}
            data-sheet-open={sheetOpen ? '' : undefined}
            data-tree={tree === undefined ? undefined : treePosition(tree)}
            tabIndex={tabStop ? 0 : -1}
            className={cn(
              ROW_LAYOUT_CLASSES,
              'scroll-my-4 outline-none transition-colors duration-150 ease-in-out hover:bg-muted/60 focus-visible:bg-muted/60 data-[state=open]:bg-muted/60',
              // The open job: its panel on a second line of the grid, in a card.
              sheetOpen &&
                'my-1.5 h-auto grid-rows-[44px_auto] rounded-[10px] bg-[#111113] shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-[#111113] focus-visible:bg-[#111113] data-[state=open]:bg-[#111113]',
              // The last cell is the next-step button, and the tree line is not a cell: they stay as
              // they are. An open archived job is not faded: it is the one being looked at.
              '[&[data-archived]:not([data-sheet-open])>:not(:last-child):not([data-tree-line])]:opacity-55',
              tree !== undefined && 'relative pl-10',
              open !== null && 'cursor-pointer',
            )}
            onClick={(event) => {
              if (open === null) return;
              const selection = window.getSelection()?.toString() ?? '';
              const click = {
                target: event.target as Element,
                row: event.currentTarget,
                button: event.button,
                ctrlKey: event.ctrlKey,
                selectedText: selection,
              };
              if (opensSheetOnClick(click)) open();
            }}
            onKeyDown={(event) => {
              if (sheetOpen && sheet !== null && closesOnEscape(event)) {
                event.preventDefault();
                sheet.close();
                focusJobRow(job.id);
              } else if (isContextMenuKey(event)) {
                event.preventDefault();
                openMenuFromKeyboard(event.currentTarget, event.target as Element);
              } else if (
                open !== null &&
                event.key === 'Enter' &&
                event.target === event.currentTarget
              ) {
                event.preventDefault();
                open();
              }
            }}
          >
            {tree !== undefined && (
              <>
                {/* The elbow: from the client's line down to the middle of the row's 44 px, 7 px
                    round. An open job's reaches up through its 6 px margin too. */}
                <span
                  aria-hidden="true"
                  data-tree-line=""
                  className={cn(
                    'absolute left-[23.5px] w-[11px] rounded-bl-[7px] border-b border-l border-[#3F3F46]',
                    sheetOpen ? '-top-1.5 h-[28.5px]' : 'top-0 h-[calc(50%+0.5px)]',
                  )}
                />
                {/* The line on to the next job, across the 2 px between the rows (and an open
                    job's panel and margin). */}
                {treeContinues(tree) && (
                  <span
                    aria-hidden="true"
                    data-tree-line=""
                    className={cn(
                      'absolute left-[23.5px] border-l border-[#3F3F46]',
                      sheetOpen ? 'top-[22px] -bottom-2' : 'top-1/2 -bottom-0.5',
                    )}
                  />
                )}
              </>
            )}
            {children}
            {/* After the cells, so Tab goes through the row before it; the grid puts it on the
                second line. */}
            {sheetOpen && <JobRowPanel job={job} actions={actions} />}
          </li>
        </ContextMenuTrigger>
        <RowContextMenuContent job={job} actions={actions} />
      </ContextMenu>
    </RowActionsContext.Provider>
  );
}

/**
 * Whether a keydown closes the open job: Esc, from the row or anywhere in its panel, unless a menu,
 * a tooltip or a field already used it or reads the keys itself, or it came from something drawn
 * outside the row (a dialog the panel opened).
 */
function closesOnEscape(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target;
  if (event.key !== 'Escape' || event.defaultPrevented || !(target instanceof Element))
    return false;
  return event.currentTarget.contains(target) && !inTypingField(target);
}

/**
 * Scrolls the open job into view when it is not: the whole of it when it fits in the window, its
 * top otherwise (the row and the start of its panel). Nothing moves when it is already in view.
 */
function revealOpenJob(item: HTMLElement | null): void {
  if (item === null || typeof item.scrollIntoView !== 'function') return;
  const box = item.getBoundingClientRect();
  if (box.top >= 0 && box.bottom <= window.innerHeight) return;
  const fits = box.height <= window.innerHeight && box.top >= 0;
  item.scrollIntoView({ block: fits ? 'end' : 'start', behavior: 'smooth' });
}

function RowContextMenuContent({ job, actions }: { job: Job; actions: RowActions }) {
  const seriesOn = useSeriesEnabled();
  return (
    <ContextMenuContent className={menuWidth(job, seriesOn)} aria-label={`Actions for ${job.name}`}>
      {/* Radix mounts the content only while the menu is open: what the entries read is read then. */}
      <RowMenuEntries job={job} actions={actions} withDelete withApprove />
    </ContextMenuContent>
  );
}
