import type { LutListResponse, LutSummary } from '@studio/shared';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { jobsUnreachable, useLuts, useLutsInEditsEnabled } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { useEngineOffline } from '@/features/phone/use-engine-offline';
import { DeleteLutDialog } from './DeleteLutDialog';
import {
  EmptyYoursHint,
  Hint,
  LoadingLutRows,
  NoMatchingLuts,
  SectionHead,
  UnreachableLuts,
} from './LutListStates';
import { LutRow } from './LutRow';
import { type LutActions, runDelete } from './lut-actions';
import {
  bodyStateOf,
  effectiveSelection,
  isLutTab,
  LUT_LIST_TEXT,
  LUT_TAB_LABELS,
  LUT_TABS,
  type LutTab,
  noMatchText,
  showBuiltInMissing,
  shownSlugs,
  showYoursHead,
  showYoursHint,
  successorOf,
  tabCounts,
  visibleLuts,
} from './lut-list';
import { useLutActions } from './use-lut-actions';
import { useLutsAddress } from './use-luts-address';

/** What the LUTs page hands the list (LUTs plan, "The page (web)"). */
export interface LutListProps {
  /** The LUT whose pane is open (a slug), or `null` for the first one in the list. */
  selected: string | null;
  /** A row was picked, or the open one is gone (`null`). The list also says which row it opened when `selected` was `null` or hidden. */
  onSelect: (slug: string | null) => void;
  /** The empty state's "Import LUTs" link opens the import dialog. */
  onImport: () => void;
}

/**
 * The list of LUTs (boards LUPage and LUStates), over the engine's data: the page's `selected` is
 * handed in, the tab is the address' (`?tab=`, see lut-address.ts), and the list, the actions and
 * the "Notes can name a LUT" switch come from the app. {@link LutListView} is the same list over
 * plain props, which the tests draw.
 */
export function LutList({ selected, onSelect, onImport }: LutListProps) {
  const { data, isError, failureCount, refetch } = useLuts();
  const failed = jobsUnreachable({ data, isError, failureCount });
  const offline = useEngineOffline();
  const lutsInEdits = useLutsInEditsEnabled();
  const actions = useLutActions();
  const { tab, setTab } = useLutsAddress();

  return (
    <LutListView
      list={data}
      failed={failed}
      onRetry={() => void refetch()}
      selected={selected}
      onSelect={onSelect}
      onImport={onImport}
      canImport={!offline}
      tab={tab}
      onTab={setTab}
      lutsInEdits={lutsInEdits}
      actions={actions}
    />
  );
}

export interface LutListViewProps {
  /** The library from `useLuts()`: `undefined` until the first answer. */
  list: LutListResponse | undefined;
  /**
   * The first answer never came (the engine can't be reached). Read only while `list` is
   * `undefined`: once a list has arrived it stays on screen, even if a later fetch fails.
   */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state (the query's `refetch`). */
  onRetry?: () => void;
  selected: string | null;
  onSelect: (slug: string | null) => void;
  onImport: () => void;
  /** Whether the empty state's Import LUTs link can be pressed: not while the engine can't be reached. */
  canImport?: boolean;
  tab: LutTab;
  onTab: (tab: LutTab) => void;
  /** Whether notes can name a LUT yet (the `lutsInEdits` switch). */
  lutsInEdits: boolean;
  /** What the rows do. */
  actions: LutActions;
  /**
   * How long the first load may take before skeleton rows appear (default {@link SKELETON_DELAY_MS}).
   * Until then nothing is drawn, so a fast load does not flash placeholders. 0 draws them at once,
   * which is what tests of the skeleton use.
   */
  skeletonDelayMs?: number;
  /** What the search box starts with (default empty). It is the box's own state from then on. */
  defaultQuery?: string;
  /** Pins the time (tests). Without it the rows follow the clock. */
  now?: number;
}

/** The delete dialog's LUT. */
interface Deleting {
  slug: string;
  name: string;
}

/** The list itself: no header, no border, no lines, 2 px between the rows. */
const LIST_CLASSES = 'flex flex-col gap-0.5';

/**
 * Under the page's heading: the tabs All · Looks · Camera · Fixes with how many LUTs each holds,
 * a search of names and file names, then one quiet row per LUT in two sections, "Yours" (newest
 * first) and "Built in" (by name). The open LUT's row is picked: when none is (or the open one is
 * hidden by the tab or the search, or gone) the first row is, and the list tells the page.
 *
 * The body is one of: skeleton rows (waiting for the first answer, and only once that has taken a
 * quarter of a second), "Can't reach the engine." with a retry link (the first answer never came),
 * or the sections with their hints and the no-match line. The Delete… dialog belongs to the list,
 * not to a row: rows leave the list when their LUT is deleted, and the dialog has to outlive them.
 */
export function LutListView({
  list,
  failed = false,
  onRetry,
  selected,
  onSelect,
  onImport,
  canImport = true,
  tab,
  onTab,
  lutsInEdits,
  actions,
  skeletonDelayMs = SKELETON_DELAY_MS,
  defaultQuery = '',
  now,
}: LutListViewProps) {
  const clock = useNow();
  // The shared clock ticks every 30 s, so right after an import it can still be a moment before the
  // LUT's added time, and a LUT "added in the future" has no New tag. Never go behind the real time.
  const time = now ?? Math.max(clock, Date.now());
  const [query, setQuery] = useState(defaultQuery);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // What the dialog asked about last: after it closes, its exit animation must still see the name.
  const lastDeleting = useRef<Deleting | null>(null);
  if (deleting !== null) lastDeleting.current = deleting;
  // Slugs a rename has just left, for the moment the address still holds the old one.
  const renamed = useRef(new Map<string, string>());
  // A slug being deleted and the row the pane moves to once it is gone.
  const successors = useRef(new Map<string, string>());

  const rows = useMemo(
    () => (list === undefined ? { yours: [], builtIn: [] } : visibleLuts(list, tab, query)),
    [list, tab, query],
  );
  const shown = useMemo(() => shownSlugs(rows), [rows]);
  const open =
    list === undefined
      ? null
      : effectiveSelection(selected, shown, renamed.current, successors.current);
  const bodyState = bodyStateOf({ list, failed });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);
  const counts = list === undefined ? null : tabCounts(list);

  // The page asks for "the first row" with `null`, and a row can disappear (deleted, filtered): tell
  // it which LUT is open so the pane and the address agree with the list.
  useEffect(() => {
    if (list !== undefined && open !== selected) onSelect(open);
  }, [list, open, selected, onSelect]);

  function renamedTo(from: string, to: string) {
    renamed.current.set(from, to);
    if (open === from) onSelect(to);
  }

  function row(lut: LutSummary) {
    return (
      <LutRow
        key={lut.slug}
        lut={lut}
        selected={lut.slug === open}
        now={time}
        lutsInEdits={lutsInEdits}
        actions={actions}
        onSelect={onSelect}
        onAskDelete={(target) => setDeleting({ slug: target.slug, name: target.name })}
        onRenamed={renamedTo}
      />
    );
  }

  const noRows = list !== undefined && shown.length === 0;
  const hasHint =
    list !== undefined && (showYoursHint(rows, tab, query) || showBuiltInMissing(list, tab, query));

  return (
    <TooltipProvider>
      <div data-slot="lut-list" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (isLutTab(value)) onTab(value);
            }}
          >
            <TabsList aria-label={LUT_LIST_TEXT.tabsLabel}>
              {LUT_TABS.map((id) => (
                <TabsTrigger key={id} value={id} className="h-7 px-3 text-[13px]">
                  {LUT_TAB_LABELS[id]}
                  {counts !== null && (
                    <span
                      data-slot="lut-tab-count"
                      className="font-normal text-zinc-500 tabular-nums"
                    >
                      {counts[id]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <LutSearch value={query} onChange={setQuery} />
        </div>
        {bodyState === 'loading' && (
          <ul aria-label={LUT_LIST_TEXT.listLabel} aria-busy="true" className={LIST_CLASSES}>
            {showSkeleton && <LoadingLutRows />}
          </ul>
        )}
        {bodyState === 'unreachable' && <UnreachableLuts onRetry={() => onRetry?.()} />}
        {list !== undefined && (
          <>
            {(shown.length > 0 || hasHint) && (
              <ul aria-label={LUT_LIST_TEXT.listLabel} className={LIST_CLASSES}>
                {showYoursHead(rows, tab, query) && (
                  <SectionHead title={LUT_LIST_TEXT.yours} count={rows.yours.length} />
                )}
                {showYoursHint(rows, tab, query) && (
                  <EmptyYoursHint onImport={onImport} disabled={!canImport} />
                )}
                {rows.yours.map(row)}
                {showBuiltInMissing(list, tab, query) ? (
                  <>
                    <SectionHead title={LUT_LIST_TEXT.builtIn} />
                    <Hint>{LUT_LIST_TEXT.builtInMissing}</Hint>
                  </>
                ) : (
                  rows.builtIn.length > 0 && (
                    <SectionHead title={LUT_LIST_TEXT.builtIn} count={rows.builtIn.length} />
                  )
                )}
                {rows.builtIn.map(row)}
              </ul>
            )}
            {noRows && !hasHint && <NoMatchingLuts text={noMatchText(query)} />}
          </>
        )}
      </div>
      <DeleteLutDialog
        open={deleting !== null}
        name={(deleting ?? lastDeleting.current)?.name ?? ''}
        lutsInEdits={lutsInEdits}
        pending={deletePending}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting === null) return;
          const next = successorOf(shown, deleting.slug);
          if (next !== null) successors.current.set(deleting.slug, next);
          void runDelete(deleting, actions.remove, {
            setPending: setDeletePending,
            close: () => setDeleting(null),
          });
        }}
        onCloseAutoFocus={(event) => {
          // There is no trigger to give focus back to (the dialog is asked for from a row's menu):
          // the row's name gets it when the row is still there.
          event.preventDefault();
          const slug = lastDeleting.current?.slug;
          if (slug === undefined) return;
          document
            .querySelector<HTMLElement>(
              `[data-lut-slug="${CSS.escape(slug)}"] [data-slot="lut-name"]`,
            )
            ?.focus();
        }}
      />
    </TooltipProvider>
  );
}

/**
 * The search box: 220 px wide (as the LUPage board draws it) and 32 px high, a transparent field
 * with a 1 px border and a magnifier inside, `type="search"` (so the browser adds its clear button).
 * Every keystroke filters at once: it is a few dozen names, and a controlled input fed
 * synchronously keeps Hebrew and other IME composition intact.
 */
function LutSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="relative w-55 flex-none">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
      />
      <label htmlFor={id} className="sr-only">
        {LUT_LIST_TEXT.searchLabel}
      </label>
      <Input
        id={id}
        type="search"
        placeholder={LUT_LIST_TEXT.searchPlaceholder}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 border-border bg-transparent pl-8.5 shadow-none dark:bg-transparent"
      />
    </div>
  );
}
