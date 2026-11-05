import type { GraphicSummary } from '@studio/shared';
import { Search } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { DeleteGraphicDialog } from './DeleteGraphicDialog';
import { runDelete } from './delete-flow';
import { GraphicRow } from './GraphicRow';
import {
  EmptyGraphics,
  LoadingGraphicRows,
  MakingSummary,
  NoMatchingGraphics,
  UnreachableGraphics,
} from './GraphicsListStates';
import type { GraphicActions } from './graphic-actions';
import { bodyStateOf, countText, filterGraphics, GRAPHICS_TEXT, makingCount } from './graphic-list';
import { useGraphicActions } from './use-graphic-actions';

export interface GraphicsListProps {
  /** The library from `useGraphics()`, newest change first: `undefined` until the first answer. */
  graphics: readonly GraphicSummary[] | undefined;
  /**
   * The first answer never came (the engine can't be reached). Read only while `graphics` is
   * `undefined`: once a list has arrived it stays on screen, even if a later fetch fails.
   */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state (the query's `refetch`). */
  onRetry?: () => void;
  /** New graphic, from the empty state's button. */
  onNew: () => void;
  /** Whether New graphic can be pressed: not while the engine can't be reached. */
  canCreate?: boolean;
  /**
   * How long the first load may take before skeleton rows appear (default {@link SKELETON_DELAY_MS}).
   * Until then nothing is drawn, so a fast load does not flash placeholders. 0 draws them at once,
   * which is what tests of the skeleton use.
   */
  skeletonDelayMs?: number;
  /** What the rows do. Tests pass their own; the page uses the engine's (`useGraphicActions`). */
  actions?: GraphicActions;
  /** What the search box starts with (default empty). It is the box's own state from then on. */
  defaultQuery?: string;
}

/** The delete dialog's graphic. */
interface Deleting {
  id: string;
  name: string;
}

/** The list itself: no header, no border, no lines, 2 px between the rows. */
const LIST_CLASSES = 'flex flex-col gap-0.5';

/**
 * The library (board GRLibrary): under the page's heading, a toolbar with how many graphics there
 * are (and how many are being made) and a search of their names, then one quiet row per graphic,
 * newest change first. A row is a mark, the name, a line of detail, the time and, only when its
 * newest run failed, a ghost Retry button; everything else is in the row's right-click menu.
 *
 * The body is one of: skeleton rows (waiting for the first answer, and only once that has taken a
 * quarter of a second), "Can't reach the engine." with a retry link (the first answer never came),
 * "No graphics yet" (the library is empty), "No graphic matches “…”." (the search leaves nothing) or
 * the rows. The Delete… dialog belongs to the list, not to a row: rows leave the list when their
 * graphic is deleted, and the dialog has to outlive them.
 */
export function GraphicsList({
  graphics,
  failed = false,
  onRetry,
  onNew,
  canCreate = true,
  skeletonDelayMs = SKELETON_DELAY_MS,
  actions,
  defaultQuery = '',
}: GraphicsListProps) {
  const own = useGraphicActions();
  const rowActions = actions ?? own;
  const [query, setQuery] = useState(defaultQuery);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // What the dialog asked about last: after it closes, its exit animation must still see the name.
  const lastDeleting = useRef<Deleting | null>(null);
  if (deleting !== null) lastDeleting.current = deleting;
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());

  const shown = useMemo(
    () => (graphics === undefined ? [] : filterGraphics(graphics, query)),
    [graphics, query],
  );
  const bodyState = bodyStateOf({ graphics, failed, matching: shown.length });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);
  const making = graphics === undefined ? 0 : makingCount(graphics);

  function retry(graphic: GraphicSummary) {
    setRetrying((now) => new Set(now).add(graphic.id));
    void rowActions.retry(graphic.id).finally(() =>
      setRetrying((now) => {
        const next = new Set(now);
        next.delete(graphic.id);
        return next;
      }),
    );
  }

  return (
    <TooltipProvider>
      <div data-slot="graphics-list" className="flex flex-1 flex-col gap-4">
        {graphics !== undefined && graphics.length > 0 && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {countText(graphics.length)}
              </span>
              {making > 0 && <MakingSummary count={making} />}
            </div>
            <GraphicsSearch value={query} onChange={setQuery} />
          </div>
        )}
        {bodyState === 'loading' && (
          <ul aria-label={GRAPHICS_TEXT.listLabel} aria-busy="true" className={LIST_CLASSES}>
            {showSkeleton && <LoadingGraphicRows />}
          </ul>
        )}
        {bodyState === 'unreachable' && <UnreachableGraphics onRetry={() => onRetry?.()} />}
        {bodyState === 'empty' && <EmptyGraphics onNew={onNew} disabled={!canCreate} />}
        {bodyState === 'no-match' && <NoMatchingGraphics query={query} />}
        {bodyState === 'rows' && (
          <ul aria-label={GRAPHICS_TEXT.listLabel} className={LIST_CLASSES}>
            {shown.map((graphic) => (
              <GraphicRow
                key={graphic.id}
                graphic={graphic}
                actions={rowActions}
                onAskDelete={(target) => setDeleting({ id: target.id, name: target.name })}
                retrying={retrying.has(graphic.id)}
                onRetry={retry}
              />
            ))}
          </ul>
        )}
      </div>
      <DeleteGraphicDialog
        open={deleting !== null}
        name={(deleting ?? lastDeleting.current)?.name ?? ''}
        pending={deletePending}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting === null) return;
          void runDelete(deleting, rowActions.remove, {
            setPending: setDeletePending,
            close: () => setDeleting(null),
          });
        }}
        onCloseAutoFocus={(event) => {
          // There is no trigger to give focus back to (the dialog is asked for from a row's menu):
          // the row's name gets it when the row is still there.
          event.preventDefault();
          const id = lastDeleting.current?.id;
          if (id === undefined) return;
          document
            .querySelector<HTMLElement>(
              `[data-graphic-id="${CSS.escape(id)}"] [data-slot="graphic-name"]`,
            )
            ?.focus();
        }}
      />
    </TooltipProvider>
  );
}

/**
 * The search box: 220 px wide (as the GRLibrary board draws it) and 32 px high, a transparent field
 * with a 1 px border and a magnifier inside, `type="search"` (so the browser adds its clear button).
 * Every keystroke filters at once: it is a few dozen names, and a controlled input fed
 * synchronously keeps Hebrew and other IME composition intact.
 */
function GraphicsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="relative w-55">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
      />
      <label htmlFor={id} className="sr-only">
        {GRAPHICS_TEXT.searchLabel}
      </label>
      <Input
        id={id}
        type="search"
        placeholder={GRAPHICS_TEXT.searchPlaceholder}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 border-border bg-transparent pl-8.5 shadow-none dark:bg-transparent"
      />
    </div>
  );
}
