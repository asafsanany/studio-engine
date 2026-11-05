import type { Job, JobVersion, TimeInput } from '@studio/shared';
import { ChevronDown, Ellipsis, Play, Undo2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useJobVersions } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import {
  CONTEXT_MENU_PARTS,
  DROPDOWN_MENU_PARTS,
  RowMenuItemView,
} from '@/features/jobs/row-menu-views';
import { cn } from '@/lib/utils';
import { GoBackDialog } from './GoBackDialog';
import { takeSectionRequest, useSectionRequest } from './job-sheet-section';
import type { SheetVariant } from './sheet-variant';
import { SHEET_VERSIONS_TEXT, type VersionRow, versionRows } from './sheet-versions';
import { useGoBack } from './use-go-back';

/** The menu of a row, in its width: one item. */
const MENU_WIDTH = 'w-60';

/** A version row's "Go back to this version…" as a menu item, disabled with its reason as the tooltip. */
export function goBackItem(row: VersionRow, onGoBack: (n: number) => void) {
  return {
    type: 'item',
    id: `go-back-${row.n}`,
    label: SHEET_VERSIONS_TEXT.goBack,
    icon: Undo2,
    disabled: row.blocked !== null,
    ...(row.blocked === null ? {} : { disabledReason: row.blocked }),
    onSelect: () => onGoBack(row.n),
  } as const;
}

/** The ghost View button at the end of a row: the next step, a 32 px icon with its tooltip (44 px and none on the phone). */
function ViewButton({
  row,
  onView,
  variant,
}: {
  row: VersionRow;
  onView: () => void;
  variant: SheetVariant;
}) {
  const label = `${SHEET_VERSIONS_TEXT.view} ${row.name}`;
  if (variant === 'phone') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={onView}
        className="size-11 flex-none text-muted-foreground"
      >
        <Play aria-hidden />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onView}
          className="text-muted-foreground hover:text-foreground dark:hover:bg-accent"
        >
          <Play aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One row, on a single line: "Cut 3 · today 14:58 · 0:42", then the Current badge (and Approved on
 * the current cut of an approved job), then View (the next step; given by the caller) and ⋯, which
 * shows when the row is hovered or has the focus. The row's right-click menu and the ⋯ menu hold
 * the same item, "Go back to this version…". On the phone the row is 48 px tall, View and ⋯ are
 * 44 px touch targets and ⋯ is always there (a finger does not hover); a menu whose item is
 * disabled says why under it, since a title never shows on a phone.
 */
function VersionItem({
  row,
  version,
  onGoBack,
  onView,
  variant,
}: {
  row: VersionRow;
  version: JobVersion;
  onGoBack: (n: number) => void;
  onView: ((version: JobVersion) => void) | undefined;
  variant: SheetVariant;
}) {
  const item = goBackItem(row, onGoBack);
  const phone = variant === 'phone';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-version={row.n}
          className={cn(
            'group -mx-2 flex items-center gap-2 rounded-md px-2 transition-colors duration-150 ease-in-out hover:bg-accent/50 has-[[data-state=open]]:bg-accent/50',
            phone ? 'min-h-12 text-sm' : 'min-h-8 text-[13px]',
          )}
        >
          <span className="min-w-0 flex-1 truncate" dir="auto">
            <span className="text-zinc-300">{row.name}</span>
            {row.detail !== '' && <span className="text-zinc-500">{` · ${row.detail}`}</span>}
          </span>
          {row.current && (
            <Badge variant="outline" className="h-5 rounded-md text-[11px]">
              {SHEET_VERSIONS_TEXT.current}
            </Badge>
          )}
          {row.approved && (
            <Badge variant="outline" className="h-5 rounded-md text-[11px]">
              <BadgeDot className="bg-status-ready" />
              {SHEET_VERSIONS_TEXT.approved}
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* A native title, not a tooltip: see the sheet header's ⋯. */}
              <Button
                type="button"
                variant="ghost"
                size={phone ? 'icon' : 'icon-sm'}
                aria-label={`${SHEET_VERSIONS_TEXT.more} · ${row.name}`}
                title={SHEET_VERSIONS_TEXT.more}
                className={cn(
                  'text-muted-foreground transition-opacity duration-150 ease-in-out hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground dark:hover:bg-accent',
                  phone
                    ? 'size-11 flex-none'
                    : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                )}
              >
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={MENU_WIDTH}
              aria-label={`Actions for ${row.name}`}
            >
              <RowMenuItemView item={item} parts={DROPDOWN_MENU_PARTS} />
              {phone && row.blocked !== null && (
                <p className="px-2 pt-0.5 pb-1.5 text-[13px] text-pretty text-muted-foreground">
                  {row.blocked}
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {onView !== undefined && (
            <ViewButton row={row} onView={() => onView(version)} variant={variant} />
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH} aria-label={`Actions for ${row.name}`}>
        <RowMenuItemView item={item} parts={CONTEXT_MENU_PARTS} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Placeholder rows, drawn only when the wait is long enough to see (the sheet's other parts do the same). */
function VersionsSkeleton() {
  return (
    <div aria-hidden="true" data-slot="versions-skeleton" className="mt-1 flex flex-col gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * The sheet's "Versions" part: a full-width ghost button, closed at first, that opens the job's
 * preview versions, newest first, a row for each: "Cut 3 · today 14:58 · 0:42" (see
 * `versionRows`). Nothing is asked of the engine until it is open. "Go back to this version…"
 * (a row's right-click and ⋯ menus) is for a job in Review: it asks first ("Go back to Cut 2? Cut 4
 * stays in Versions, so you can return to it."), then the job stays in Review at its round, and the
 * next Send notes makes a new cut. For any other job (running, approved, delivered, paid, archived,
 * failed, held, cancelled) the item is disabled and says why; the list is for looking at. A video
 * whose folder is gone has no versions to show: the sheet leaves this part out for it.
 *
 * `onView(version)` is the View button's (the sheet opens the preview viewer on that cut); without
 * it there is none.
 * Opened for one job it stays closed for the next one the sheet moves to, except when the row menu's
 * "Versions…" asked for this job's part (`askForVersions`): it opens and scrolls into view.
 * `defaultOpen` starts it open (tests, the boards). `now` and `timeZone` pin the clock and the zone
 * (tests); without them the viewer's own are used. On the phone (`variant="phone"`) the button is
 * 44 px tall, a touch target; so are a row's View and ⋯, and "Go back" asks in a bottom sheet
 * (`PhoneGoBackSheet`) where the Mac has a dialog.
 */
export function JobSheetVersions({
  job,
  defaultOpen = false,
  now,
  timeZone,
  variant = 'mac',
  skeletonDelayMs = SKELETON_DELAY_MS,
  onView,
}: {
  job: Job;
  defaultOpen?: boolean;
  now?: TimeInput;
  timeZone?: string;
  variant?: SheetVariant;
  skeletonDelayMs?: number;
  onView?: (version: JobVersion) => void;
}) {
  const [openFor, setOpenFor] = useState<string | null>(defaultOpen ? job.id : null);
  const open = openFor === job.id;
  const listId = useId();
  const clock = useNow();
  const section = useRef<HTMLElement>(null);

  // The row menu's "Versions…": open, and bring this part into view once its rows are in (before
  // that the part is shorter than it will be, and there would be nothing to scroll to).
  const request = useSectionRequest();
  const [scrollTo, setScrollTo] = useState(false);
  useEffect(() => {
    if (request === null || !takeSectionRequest(job.id, 'versions')) return;
    setOpenFor(job.id);
    setScrollTo(true);
  }, [request, job.id]);

  const versions = useJobVersions(job.id, { enabled: open });
  // The app's queries retry for ever, so a read that fails (the engine is down) stays pending with
  // `failureCount` above 0; a 4xx is an error at once. Either way, with nothing to show, say so.
  const failed = versions.data === undefined && (versions.isError || versions.failureCount > 0);
  const settled = versions.data !== undefined || failed;
  useEffect(() => {
    if (!scrollTo || !open || !settled) return;
    setScrollTo(false);
    section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [scrollTo, open, settled]);
  const showSkeleton = useDelayedFlag(
    open && versions.data === undefined && !failed,
    skeletonDelayMs,
  );
  const list = versions.data?.versions;
  const rows = list === undefined ? [] : versionRows(job, list, now ?? clock, timeZone);
  const current = list?.find((version) => version.current)?.n ?? null;

  // Go back to this version…: ask first, then send.
  const goBack = useGoBack(job.id);

  return (
    <section
      ref={section}
      aria-label={SHEET_VERSIONS_TEXT.heading}
      data-section="versions"
      className="flex scroll-mt-4 flex-col gap-0.5"
    >
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpenFor(open ? null : job.id)}
        className={cn(
          '-mx-2 w-[calc(100%+1rem)] justify-between rounded-md px-2 text-[13px] font-medium text-muted-foreground has-[>svg]:px-2',
          variant === 'phone' ? 'h-11' : 'h-[30px]',
        )}
      >
        {SHEET_VERSIONS_TEXT.heading}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 text-zinc-500 transition-transform duration-150 ease-in-out',
            open && 'rotate-180',
          )}
        />
      </Button>
      {open && (
        <div id={listId}>
          {list !== undefined && rows.length > 0 && (
            <ol className="mt-1 flex flex-col">
              {rows.map((row, index) => (
                <VersionItem
                  key={row.n}
                  row={row}
                  version={list[index] as JobVersion}
                  onGoBack={goBack.ask}
                  onView={onView}
                  variant={variant}
                />
              ))}
            </ol>
          )}
          {list !== undefined && rows.length === 0 && (
            <p className="mt-1 py-1 text-[13px] text-zinc-500">{SHEET_VERSIONS_TEXT.empty}</p>
          )}
          {failed && (
            <p className="mt-1 py-1 text-[13px] text-zinc-500">{SHEET_VERSIONS_TEXT.failed}</p>
          )}
          {showSkeleton && <VersionsSkeleton />}
        </div>
      )}
      <GoBackDialog
        target={goBack.asking}
        current={current}
        pending={goBack.pending}
        variant={variant}
        onOpenChange={(next) => {
          if (!next) goBack.ask(null);
        }}
        onConfirm={goBack.confirm}
      />
    </section>
  );
}
