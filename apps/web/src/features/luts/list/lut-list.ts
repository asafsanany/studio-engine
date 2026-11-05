import {
  builtInLut,
  isNewLut,
  LUT_BUILTIN_MISSING_LINE,
  LUT_KIND_LABELS,
  type LutKind,
  type LutListResponse,
  type LutSummary,
  lutNameKey,
} from '@studio/shared';

// The LUTs list's words and the small rules behind it (boards LUPage and LUStates): the tabs and
// their counts, how the search filters, which rows go under "Yours" and "Built in", what a row
// says, which items its right-click menu has, and which LUT is open. Pure, so the tests read them
// without a page.

/** The list's words, as the LUPage and LUStates boards say them. */
export const LUT_LIST_TEXT = {
  listLabel: 'LUTs',
  tabsLabel: 'Kind',
  searchLabel: 'Search LUTs',
  searchPlaceholder: 'Search',
  yours: 'Yours',
  builtIn: 'Built in',
  builtInAdded: 'Built in',
  newTag: 'New',
  loading: 'Loading LUTs…',
  emptyYours: 'Nothing imported yet. Drop .cube files anywhere on this page, or use',
  emptyYoursLink: 'Import LUTs',
  emptyTab: 'Nothing in this tab yet.',
  builtInMissing: LUT_BUILTIN_MISSING_LINE,
  unreachable: 'Can’t reach the engine.',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  delete: 'Delete',
  deleting: 'Deleting…',
  noFile: 'This look is made by the grade and has no file.',
} as const;

/** The list's tabs: everything, or one kind. */
export const LUT_TABS = ['all', 'look', 'camera', 'fix'] as const;
export type LutTab = (typeof LUT_TABS)[number];

/** The tabs' words (plural, as the board has them). */
export const LUT_TAB_LABELS: Readonly<Record<LutTab, string>> = {
  all: 'All',
  look: 'Looks',
  camera: 'Camera',
  fix: 'Fixes',
};

/** Whether `value` is one of the tab words. */
export function isLutTab(value: unknown): value is LutTab {
  return typeof value === 'string' && (LUT_TABS as readonly string[]).includes(value);
}

/** Every LUT of the list, Yours first (newest first) and then Built in (by name). */
export function allLuts(list: LutListResponse): readonly LutSummary[] {
  return [...list.yours, ...list.builtIn];
}

/** How many LUTs each tab holds. The search does not change them (the board counts the whole library). */
export function tabCounts(list: LutListResponse): Readonly<Record<LutTab, number>> {
  const counts: Record<LutTab, number> = { all: 0, look: 0, camera: 0, fix: 0 };
  for (const lut of allLuts(list)) {
    counts.all += 1;
    counts[lut.kind] += 1;
  }
  return counts;
}

/**
 * The file names a LUT answers to in the search: an imported one is `<Name>.cube`; a built-in one
 * has the colour-grade skill's file name (the Cinematic look has none).
 */
export function lutFileNames(lut: Pick<LutSummary, 'slug' | 'name' | 'owner'>): readonly string[] {
  if (lut.owner === 'yours') return [`${lut.name}.cube`];
  return builtInLut(lut.slug)?.files ?? [];
}

/** Whether a LUT's name, slug or file name has `query` in it, without regard to case. A blank query matches. */
export function matchesQuery(lut: LutSummary, query: string): boolean {
  const needle = lutNameKey(query.trim());
  if (needle === '') return true;
  return [lut.name, lut.slug, ...lutFileNames(lut)].some((text) =>
    lutNameKey(text).includes(needle),
  );
}

/** What the list shows once the tab and the search are applied. */
export interface LutRows {
  yours: readonly LutSummary[];
  builtIn: readonly LutSummary[];
}

/** The LUTs of `tab` that match `query`, split into the two sections. */
export function visibleLuts(list: LutListResponse, tab: LutTab, query: string): LutRows {
  const keep = (lut: LutSummary) => (tab === 'all' || lut.kind === tab) && matchesQuery(lut, query);
  return { yours: list.yours.filter(keep), builtIn: list.builtIn.filter(keep) };
}

/** The slugs of the rows in the order they are drawn. */
export function shownSlugs(rows: LutRows): readonly string[] {
  return [...rows.yours, ...rows.builtIn].map((lut) => lut.slug);
}

/**
 * The LUT whose pane is open: `selected` while it is in the list, otherwise the first row (the
 * list's first visible row is selected when nothing is, or when the open one is hidden by the tab or
 * the search, or gone). `null` when no row is shown. `renamed` maps a slug a rename has just left
 * to the one it became, for the moment the address still holds the old one. `successors` maps a
 * slug that is being deleted to the row that follows it: once the deleted row is gone the pane
 * moves to that row (the next one down, or the one above for the last row) and not to the first.
 */
export function effectiveSelection(
  selected: string | null,
  shown: readonly string[],
  renamed: ReadonlyMap<string, string> = new Map(),
  successors: ReadonlyMap<string, string> = new Map(),
): string | null {
  const wanted = selected === null ? null : (renamed.get(selected) ?? selected);
  if (wanted !== null && shown.includes(wanted)) return wanted;
  const next = wanted === null ? undefined : successors.get(wanted);
  if (next !== undefined && shown.includes(next)) return next;
  return shown[0] ?? null;
}

/** The row to open when `slug` is deleted: the one below it, else the one above, else none. */
export function successorOf(shown: readonly string[], slug: string): string | null {
  const at = shown.indexOf(slug);
  if (at === -1) return null;
  return shown[at + 1] ?? shown[at - 1] ?? null;
}

/** What the list's body is. */
export type LutBodyState = 'loading' | 'unreachable' | 'rows';

/** `list` is `undefined` until the first answer; `failed` is that the first answer never came. */
export function bodyStateOf(input: {
  list: LutListResponse | undefined;
  failed: boolean;
}): LutBodyState {
  if (input.list === undefined) return input.failed ? 'unreachable' : 'loading';
  return 'rows';
}

/** The line under "Yours" when it is empty: only on the All tab with no search. */
export function showYoursHint(rows: LutRows, tab: LutTab, query: string): boolean {
  return rows.yours.length === 0 && query.trim() === '' && tab === 'all';
}

/** Whether the "Yours" heading shows: it has rows, or it holds the hint. */
export function showYoursHead(rows: LutRows, tab: LutTab, query: string): boolean {
  return rows.yours.length > 0 || showYoursHint(rows, tab, query);
}

/** Whether the one line replaces "Built in": the colour grade is not installed (All tab, no search). */
export function showBuiltInMissing(list: LutListResponse, tab: LutTab, query: string): boolean {
  return !list.builtInAvailable && query.trim() === '' && tab === 'all';
}

/** The body's text when the tab and the search leave no row at all. */
export function noMatchText(query: string): string {
  const q = query.trim();
  return q === '' ? LUT_LIST_TEXT.emptyTab : `No LUT matches “${q}”.`;
}

/** "Look · 33³": the kind and the grid, after a row's name. */
export function lutDetailText(lut: Pick<LutSummary, 'kind' | 'size'>): string {
  return `${LUT_KIND_LABELS[lut.kind]} · ${lut.size}³`;
}

/** The kind's name, which is its icon's accessible name. */
export function kindLabel(kind: LutKind): string {
  return LUT_KIND_LABELS[kind];
}

/**
 * Whether a row carries its "New" tag at `now`. The server's `isNew` is its word at the time it
 * answered and the list never hears the 30 minutes end, so the list works it out again from when
 * the file was added.
 */
export function showsNewTag(lut: Pick<LutSummary, 'addedAt'>, now: number): boolean {
  return isNewLut(lut.addedAt, now);
}

/** The entries of a row's right-click menu. */
export type LutMenuId = 'rename' | 'reveal' | 'duplicate' | 'copy' | 'delete';

export type LutMenuEntry =
  | {
      type: 'item';
      id: LutMenuId;
      label: string;
      destructive?: boolean;
      disabled?: boolean;
      disabledReason?: string;
    }
  | { type: 'separator'; id: string };

/**
 * The menu of a row. Yours: Rename, Show in Finder, Duplicate, Copy @luts/name, a line, Delete….
 * Built in: Show in Finder, Duplicate to Yours, Copy @luts/name. "Copy @luts/name" is left out
 * while notes cannot name a LUT yet (`lutsInEdits` off). The Cinematic look has no file to show.
 */
export function lutMenuEntries(
  lut: Pick<LutSummary, 'slug' | 'owner'>,
  options: { lutsInEdits: boolean },
): readonly LutMenuEntry[] {
  const yours = lut.owner === 'yours';
  const hasFile = yours || (builtInLut(lut.slug)?.files.length ?? 1) > 0;
  const entries: LutMenuEntry[] = [];
  if (yours) entries.push({ type: 'item', id: 'rename', label: 'Rename' });
  entries.push({
    type: 'item',
    id: 'reveal',
    label: 'Show in Finder',
    disabled: !hasFile,
    disabledReason: hasFile ? undefined : LUT_LIST_TEXT.noFile,
  });
  entries.push({
    type: 'item',
    id: 'duplicate',
    label: yours ? 'Duplicate' : 'Duplicate to Yours',
  });
  if (options.lutsInEdits) {
    entries.push({ type: 'item', id: 'copy', label: `Copy @luts/${lut.slug}` });
  }
  if (yours) {
    entries.push({ type: 'separator', id: 'before-delete' });
    entries.push({ type: 'item', id: 'delete', label: 'Delete…', destructive: true });
  }
  return entries;
}

/** What the Delete… dialog says under its title. */
export function deleteBodyText(options: { lutsInEdits: boolean }): string {
  const notes = options.lutsInEdits ? ' Notes that name it stop working.' : '';
  return `Jobs already made keep their look.${notes} It goes to the Trash, so you can get it back from there.`;
}

/** Whether a deleted file's folder is the Trash (and not the engine's fallback place). */
export function wentToTrash(where: string): boolean {
  return /(^|\/)\.Trash(\/|$)/.test(where);
}
