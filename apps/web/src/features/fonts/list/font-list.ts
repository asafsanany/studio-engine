import {
  FONT_LIMITS,
  FONT_SCRIPT_LABELS,
  type FontFamilySummary,
  fontNameKey,
  fontScriptLabel,
} from '@studio/shared';
import { heardAtLabel } from '@/features/graphics/list/graphic-list';

// The Fonts list's words and the small rules behind it (boards FOPage and FOStates): the tabs and
// their counts, how the search filters, the order of the rows, what a row says, which items its
// right-click menu has, what the delete dialog says and which family is open. Pure, so the tests
// read them without a page.

/** The list's words, as the FOPage and FOStates boards say them. */
export const FONT_LIST_TEXT = {
  listLabel: 'Fonts',
  tabsLabel: 'Script',
  searchLabel: 'Search fonts',
  searchPlaceholder: 'Search',
  newTag: 'New',
  loading: 'Loading fonts…',
  emptyLibrary: 'No fonts yet. Drop .ttf or .otf files anywhere on this page, or use',
  emptyLibraryLink: 'Import fonts',
  emptyTab: 'Nothing in this tab yet.',
  unreachable: 'Can’t reach the engine.',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  delete: 'Delete',
  deleting: 'Deleting…',
  deleteAfter:
    'Videos already made keep it. A retry or a new round on those jobs would use another font, and notes that name it stop working. It goes to the Trash, so you can get it back from there.',
  /** The same paragraph while notes cannot name a font yet (`fontsInNotes` off): nothing to stop working. */
  deleteAfterPlain:
    'Videos already made keep it. A retry or a new round on those jobs would use another font. It goes to the Trash, so you can get it back from there.',
} as const;

/** The list's tabs: every family, or one script. */
export const FONT_TABS = ['all', 'he', 'en'] as const;
export type FontTab = (typeof FONT_TABS)[number];

/** The tabs' words (the two scripts are the labels the pane and the folders use). */
export const FONT_TAB_LABELS: Readonly<Record<FontTab, string>> = {
  all: 'All',
  he: FONT_SCRIPT_LABELS.hebrew,
  en: FONT_SCRIPT_LABELS.english,
};

/** Whether `value` is one of the tab words. */
export function isFontTab(value: unknown): value is FontTab {
  return typeof value === 'string' && (FONT_TABS as readonly string[]).includes(value);
}

/** Whether a family belongs under `tab`. */
export function inTab(family: Pick<FontFamilySummary, 'he'>, tab: FontTab): boolean {
  return tab === 'all' || (tab === 'he' ? family.he : !family.he);
}

/** How many families each tab holds. The search does not change them (the board counts the whole library). */
export function tabCounts(
  families: readonly Pick<FontFamilySummary, 'he'>[],
): Readonly<Record<FontTab, number>> {
  const counts: Record<FontTab, number> = { all: 0, he: 0, en: 0 };
  for (const family of families) {
    counts.all += 1;
    if (family.he) counts.he += 1;
    else counts.en += 1;
  }
  return counts;
}

/** Whether a family's name has `query` in it, without regard to case. A blank query matches. */
export function matchesQuery(family: Pick<FontFamilySummary, 'name'>, query: string): boolean {
  const needle = fontNameKey(query);
  return needle === '' || fontNameKey(family.name).includes(needle);
}

/**
 * Whether a family still carries its "New" tag at `now`. The server's `isNew` is its word at the
 * time it answered, and nothing tells the page when the 30 minutes end, so the tag also needs the
 * family to be younger than that on the clock the page is reading.
 */
export function showsNewTag(
  family: Pick<FontFamilySummary, 'isNew' | 'addedAt'>,
  now: number,
): boolean {
  if (!family.isNew) return false;
  const added = Date.parse(family.addedAt);
  return Number.isNaN(added) || now - added < FONT_LIMITS.newTagMs;
}

const byName = (a: Pick<FontFamilySummary, 'name'>, b: Pick<FontFamilySummary, 'name'>): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);

/**
 * The rows in the order they are drawn: the families that are still new first (the newest of them
 * on top), then every other family A to Z without regard to case.
 */
export function sortedFamilies(
  families: readonly FontFamilySummary[],
  now: number,
): FontFamilySummary[] {
  const fresh: FontFamilySummary[] = [];
  const rest: FontFamilySummary[] = [];
  for (const family of families) (showsNewTag(family, now) ? fresh : rest).push(family);
  fresh.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt) || byName(a, b));
  rest.sort(byName);
  return [...fresh, ...rest];
}

/** The families of `tab` that match `query`, in the order they are drawn. */
export function visibleFamilies(
  families: readonly FontFamilySummary[],
  tab: FontTab,
  query: string,
  now: number,
): FontFamilySummary[] {
  return sortedFamilies(
    families.filter((family) => inTab(family, tab) && matchesQuery(family, query)),
    now,
  );
}

/**
 * The family whose pane is open: `selected` while it is in the list, otherwise the first row (the
 * first visible row is open when none is chosen, or when the chosen one is hidden by the tab or the
 * search, or gone). `null` when no row is shown.
 */
export function effectiveSelection(
  selected: string | null,
  shown: readonly Pick<FontFamilySummary, 'slug'>[],
): string | null {
  if (selected !== null && shown.some((family) => family.slug === selected)) return selected;
  return shown[0]?.slug ?? null;
}

/** What the list's body is. */
export type FontBodyState = 'loading' | 'unreachable' | 'rows';

/** `families` is `undefined` until the first answer; `failed` is that the first answer never came. */
export function bodyStateOf(input: {
  families: readonly FontFamilySummary[] | undefined;
  failed: boolean;
}): FontBodyState {
  if (input.families === undefined) return input.failed ? 'unreachable' : 'loading';
  return 'rows';
}

/** The body's text when the tab and the search leave no row but the library has families. */
export function noMatchText(query: string): string {
  const q = query.trim();
  return q === '' ? FONT_LIST_TEXT.emptyTab : `No font matches “${q}”.`;
}

/** The script of a row: "Hebrew + English" or "English only". */
export function scriptText(family: Pick<FontFamilySummary, 'he'>): string {
  return fontScriptLabel(family.he);
}

/** What a note writes to use a family in its Regular weight: `@Heebo`, `@Amatic SC`. */
export function fontToken(name: string): string {
  return `@${name}`;
}

/** The entries of a row's right-click menu. */
export type FontMenuId = 'reveal' | 'copy' | 'delete';

export type FontMenuEntry =
  | { type: 'item'; id: FontMenuId; label: string; destructive?: boolean }
  | { type: 'separator'; id: string };

/**
 * The menu of a row: Show in Finder, Copy @name, a line, Delete…. A font's name comes from its
 * file, so there is no Rename. "Copy @name" is left out while notes cannot name a font yet
 * (`inNotes`, the `fontsInNotes` switch, is off): there is nothing to paste it into.
 */
export function fontMenuEntries(
  family: Pick<FontFamilySummary, 'name'>,
  options: { inNotes: boolean },
): readonly FontMenuEntry[] {
  const entries: FontMenuEntry[] = [{ type: 'item', id: 'reveal', label: 'Show in Finder' }];
  if (options.inNotes) {
    entries.push({ type: 'item', id: 'copy', label: `Copy ${fontToken(family.name)}` });
  }
  entries.push(
    { type: 'separator', id: 'before-delete' },
    { type: 'item', id: 'delete', label: 'Delete…', destructive: true },
  );
  return entries;
}

/** The delete dialog's second paragraph: what happens to videos, retries, notes and the file. */
export function deleteAfterText(inNotes: boolean): string {
  return inNotes ? FONT_LIST_TEXT.deleteAfter : FONT_LIST_TEXT.deleteAfterPlain;
}

/**
 * The first sentence of the delete dialog (board FOStates 8): "14 jobs use it. All 9 weights go."
 * A family with no recorded use says "Not used by any job yet."; one weight goes by itself. While
 * notes cannot name a font (`inNotes` off) no use is counted, so only what goes is said.
 */
export function deleteBodyText(
  family: Pick<FontFamilySummary, 'used' | 'weights'>,
  options: { inNotes: boolean },
): string {
  const count = family.weights.length;
  const goes = count === 1 ? 'Its only weight goes.' : `All ${count} weights go.`;
  if (!options.inNotes) return goes;
  const used =
    family.used <= 0
      ? 'Not used by any job yet.'
      : family.used === 1
        ? '1 job uses it.'
        : `${family.used} jobs use it.`;
  return `${used} ${goes}`;
}

/**
 * The bar above the list while the engine can't be reached (board FOStates 10): the list is as it
 * was, and importing waits. It says when the list was last right when that is known.
 */
export function offlineBannerText(heardAt: number | null): string {
  const asItWas =
    heardAt === null ? '' : ` This is the list as it was at ${heardAtLabel(heardAt)}.`;
  return `Can’t reach the engine on your Mac.${asItWas} Importing waits until it’s back.`;
}
