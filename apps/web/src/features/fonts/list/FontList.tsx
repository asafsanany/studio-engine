import type { FontFamilySummary } from '@studio/shared';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { jobsUnreachable, useFonts, useFontsInNotesEnabled } from '@/data';
import { useSelectedFamily } from '@/features/fonts/use-selected-family';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { useEngineOffline } from '@/features/phone/use-engine-offline';
import { cn } from '@/lib/utils';
import { DeleteFontDialog } from './DeleteFontDialog';
import {
  EmptyLibraryHint,
  LoadingFontRows,
  NoMatchingFonts,
  UnreachableFonts,
} from './FontListStates';
import { FontRow } from './FontRow';
import { type FontActions, runDelete } from './font-actions';
import {
  bodyStateOf,
  deleteBodyText,
  effectiveSelection,
  FONT_LIST_TEXT,
  FONT_TAB_LABELS,
  FONT_TABS,
  type FontTab,
  isFontTab,
  noMatchText,
  tabCounts,
  visibleFamilies,
} from './font-list';
import { useFontActions } from './use-font-actions';

/** What the Fonts page hands the list (Fonts plan, "The page (web)"). */
export interface FontListProps {
  /** The empty state's "Import fonts" link opens the import dialog (FN9's), like the page's button. */
  onImport: () => void;
}

/**
 * The list of font families (boards FOPage and FOStates), over the engine's data: which family is
 * open is the address' `?family=` (`useSelectedFamily()`), the tab is the list's own, and the
 * families and the actions come from the app. {@link FontListView} is the same list over plain
 * props, which the tests draw.
 */
export function FontList({ onImport }: FontListProps) {
  const { data, isError, failureCount, refetch } = useFonts();
  const failed = jobsUnreachable({ data, isError, failureCount });
  const offline = useEngineOffline();
  const inNotes = useFontsInNotesEnabled();
  const actions = useFontActions();
  const { selected, setSelected } = useSelectedFamily();
  const [tab, setTab] = useState<FontTab>('all');

  return (
    <FontListView
      families={data?.families}
      failed={failed}
      onRetry={() => void refetch()}
      selected={selected}
      onSelect={setSelected}
      onImport={onImport}
      canImport={!offline}
      tab={tab}
      onTab={setTab}
      actions={actions}
      inNotes={inNotes}
    />
  );
}

export interface FontListViewProps {
  /** The library from `useFonts()`: `undefined` until the first answer. */
  families: readonly FontFamilySummary[] | undefined;
  /**
   * The first answer never came (the engine can't be reached). Read only while `families` is
   * `undefined`: once a list has arrived it stays on screen, even if a later fetch fails.
   */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state (the query's `refetch`). */
  onRetry?: () => void;
  /** The open family (a slug), or `null` when the address names none. */
  selected: string | null;
  /** A row was picked, or the open one is gone or hidden: the list says which family is open (`null` for none). */
  onSelect: (slug: string | null) => void;
  onImport: () => void;
  /** Whether the empty state's Import fonts link can be pressed: not while the engine can't be reached. */
  canImport?: boolean;
  tab: FontTab;
  onTab: (tab: FontTab) => void;
  /** What the rows do. */
  actions: FontActions;
  /**
   * Notes can name a font (the `fontsInNotes` switch is on). Off, nothing counts use or reads the
   * name: no used column, no "Copy @name", and the delete dialog says only what goes.
   */
  inNotes: boolean;
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

/** The delete dialog's family: its name and the sentence about its use, as they were when Delete… was chosen. */
interface Deleting {
  slug: string;
  name: string;
  body: string;
}

/** The list itself: no header, no border, no lines, 2 px between the rows. */
const LIST_CLASSES = 'flex flex-col gap-0.5';

/**
 * Under the page's heading: the tabs All · Hebrew + English · English only with how many families
 * each holds, a search of names, then one quiet row per family, A to Z, with the ones just imported
 * on top. The open family's row is picked: when none is (or the open one is hidden by the tab or
 * the search, or gone) the first row is, and the list tells the page.
 *
 * The body is one of: skeleton rows (waiting for the first answer, and only once that has taken a
 * quarter of a second), "Can't reach the engine." with a retry link (the first answer never came),
 * the rows, the empty library's hint or the no-match line. The Delete… dialog belongs to the list,
 * not to a row: rows leave the list when their family is deleted, and the dialog has to outlive
 * them.
 *
 * The root is the container (`@container`) the rows and the controls answer to, because the open
 * pane takes 440 px and what counts is the list's own width, not the window's (CVP-366): in a
 * 1024 px window it is 296 px. Narrower than the board's list the rows drop their less important
 * columns (FontRow.tsx), the tabs lose their counts under 400 px, and under 530 px the search
 * moves below the tabs instead of running under the pane.
 */
export function FontListView({
  families,
  failed = false,
  onRetry,
  selected,
  onSelect,
  onImport,
  canImport = true,
  tab,
  onTab,
  actions,
  inNotes,
  skeletonDelayMs = SKELETON_DELAY_MS,
  defaultQuery = '',
  now,
}: FontListViewProps) {
  const clock = useNow();
  const time = now ?? clock;
  const [query, setQuery] = useState(defaultQuery);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // What the dialog asked about last: after it closes, its exit animation must still see the name.
  const lastDeleting = useRef<Deleting | null>(null);
  if (deleting !== null) lastDeleting.current = deleting;

  const shown = useMemo(
    () => (families === undefined ? [] : visibleFamilies(families, tab, query, time)),
    [families, tab, query, time],
  );
  const open = families === undefined ? null : effectiveSelection(selected, shown);
  const bodyState = bodyStateOf({ families, failed });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);
  const counts = families === undefined ? null : tabCounts(families);

  // The address may name no family, or one the tab or the search hides, or one that is gone: tell
  // the page which family is open so the pane and the address agree with the list.
  useEffect(() => {
    if (families !== undefined && open !== selected) onSelect(open);
  }, [families, open, selected, onSelect]);

  const emptyLibrary = families !== undefined && families.length === 0;
  const noMatch = families !== undefined && !emptyLibrary && shown.length === 0;

  return (
    <TooltipProvider>
      <div data-slot="font-list" className="@container flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 @max-[530px]:flex-wrap">
          <Tabs
            // Lets the bar give way (below) instead of running under the pane when the list is squeezed.
            className="min-w-0"
            value={tab}
            onValueChange={(value) => {
              if (isFontTab(value)) onTab(value);
            }}
          >
            <TabsList
              aria-label={FONT_LIST_TEXT.tabsLabel}
              // The board's bar: 34 px high, its tabs 2 px apart (the stock bar is 36 px, no gap). It
              // keeps its natural width (356 px with two-digit counts) and only shrinks when the
              // list is narrower than its tabs without counts (288 px): the two long labels then end
              // in "…" and All stays whole.
              className="max-w-full gap-0.5 group-data-[orientation=horizontal]/tabs:h-[34px]"
            >
              {FONT_TABS.map((id) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className={cn('h-7 min-w-0 px-3 text-[13px]', id === 'all' && 'shrink-0')}
                >
                  <span className="truncate">{FONT_TAB_LABELS[id]}</span>
                  {counts !== null && (
                    <span
                      data-slot="font-tab-count"
                      className="shrink-0 font-normal text-zinc-500 tabular-nums @max-[400px]:hidden"
                    >
                      {counts[id]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FontSearch value={query} onChange={setQuery} />
        </div>
        {bodyState === 'loading' && (
          <ul aria-label={FONT_LIST_TEXT.listLabel} aria-busy="true" className={LIST_CLASSES}>
            {showSkeleton && <LoadingFontRows inNotes={inNotes} />}
          </ul>
        )}
        {bodyState === 'unreachable' && <UnreachableFonts onRetry={() => onRetry?.()} />}
        {emptyLibrary && (
          <ul aria-label={FONT_LIST_TEXT.listLabel} className={LIST_CLASSES}>
            <EmptyLibraryHint onImport={onImport} disabled={!canImport} />
          </ul>
        )}
        {shown.length > 0 && (
          <ul aria-label={FONT_LIST_TEXT.listLabel} className={LIST_CLASSES}>
            {shown.map((family) => (
              <FontRow
                key={family.slug}
                family={family}
                selected={family.slug === open}
                now={time}
                actions={actions}
                inNotes={inNotes}
                onSelect={onSelect}
                onAskDelete={(target) =>
                  setDeleting({
                    slug: target.slug,
                    name: target.name,
                    body: deleteBodyText(target, { inNotes }),
                  })
                }
              />
            ))}
          </ul>
        )}
        {noMatch && <NoMatchingFonts text={noMatchText(query)} />}
      </div>
      <DeleteFontDialog
        open={deleting !== null}
        name={(deleting ?? lastDeleting.current)?.name ?? ''}
        body={(deleting ?? lastDeleting.current)?.body ?? ''}
        inNotes={inNotes}
        pending={deletePending}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting === null) return;
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
              `[data-font-slug="${CSS.escape(slug)}"] [data-slot="font-name"]`,
            )
            ?.focus();
        }}
      />
    </TooltipProvider>
  );
}

/**
 * The search box: up to 220 px wide (as the FOPage board draws it) and 32 px high, a transparent
 * field with a 1 px border and a magnifier inside, `type="search"` (so the browser adds its clear
 * button). It takes what the tabs leave free on their row, never less than 144 px, so with the
 * pane open (552 px of list at 1280, 356 px of tabs with the real library's two-digit counts) it
 * ends at the list's edge instead of running under the pane (CVP-367); its 144 px basis is also
 * what the row wraps on, so it never shrinks below that and never wraps early. Where the row has
 * room it is the board's 220 px. Every keystroke filters at once: it is a few dozen names, and a
 * controlled input fed synchronously keeps Hebrew and other IME composition intact.
 */
function FontSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="relative min-w-36 max-w-55 flex-1 basis-36">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
      />
      <label htmlFor={id} className="sr-only">
        {FONT_LIST_TEXT.searchLabel}
      </label>
      <Input
        id={id}
        type="search"
        placeholder={FONT_LIST_TEXT.searchPlaceholder}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 border-border bg-transparent pl-8.5 shadow-none dark:bg-transparent"
      />
    </div>
  );
}
