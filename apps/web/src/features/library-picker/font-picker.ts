// What the @ picker decides about fonts, apart from how it looks (Fonts plan, "The @ picker"; board
// FOReview: `picker()`, `hits()` and `insert()`): when the box is asking for a name, which fonts a
// typed query shows, how the font rows join the LUTs and graphics in one list, what to say when none
// does, and what picking one writes into the note. Plain functions, so the tests need no browser.
//
// This is the second reader of the `@`. LU7's `openPickerQuery` (picker-items.ts) reads LUTs and
// graphics only: `@` after whitespace, then `[a-z0-9-]*`. A font is typed with spaces and capitals
// (`@Heebo Bold`) and sits in the middle of Hebrew text (`ל-@Heebo`), so while the `fontsInNotes`
// switch is on this file reads the box instead, and the LUT and graphic matching (`pickerView`) is
// still LU8's. With the switch off nothing here is called and the picker is exactly LU8's.

import {
  type FontFaceInfo,
  type FontFamilySummary,
  type FontsListResponse,
  fontNameKey,
  fontScriptLabel,
  HEBREW_FALLBACK_FONT,
  type LibraryName,
  type PickerQuery,
} from '@studio/shared';
import { defaultFace, nearestFace } from '@/features/fonts/pane/font-pane-model';
import {
  PICKER_GROUP_LIMIT,
  type PickerItem,
  type PickerNone,
  type PickerView,
  pickerView,
} from './picker-items';

/** The words of the fonts group. */
export const FONT_PICKER_TEXT = {
  fonts: 'Fonts',
  recent: 'Fonts · recent',
  openFonts: 'Open Fonts to import one',
  /** The dim line under the "Uses" chips when a note names a font. */
  useLine:
    'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.',
  /** What a note box's placeholder says `@` points at (`pointAtText`). */
  pointFonts: 'a font',
  pointFontsAndLibrary: 'a font, a LUT or a graphic',
  pointLibrary: 'a LUT or a graphic',
} as const;

/** A query longer than this is not a font name any more: the list closes. */
export const NOTE_QUERY_MAX = 40;

/** At most this many rows when the matches belong to several families. */
export const FONT_FAMILY_ROWS_MAX = 10;

/** How many families the empty query leads with. */
export const FONT_RECENT_COUNT = 5;

/** How many LUTs and graphics the empty query leads with when fonts are in the list too. */
export const FONT_EMPTY_LIBRARY_LIMIT = 3;

// --- the catalog ---------------------------------------------------------------------------------

/** A face of the catalog with what matching it needs. */
export interface FontPickerFace {
  face: FontFaceInfo;
  family: FontFamilySummary;
  /** `fontNameKey(face.name)`. */
  key: string;
  /** The key's words. */
  words: readonly string[];
}

/** What the picker offers from `GET /api/fonts`: every face with its family. */
export interface FontPickerCatalog {
  faces: readonly FontPickerFace[];
  /** The faces by family (`fontNameKey` of the family), in catalog order. */
  byFamily: ReadonlyMap<string, readonly FontPickerFace[]>;
  /** The families A to Z, as the list answered. */
  families: readonly FontFamilySummary[];
  /** The catalog's faces as they came: the siblings of a file (a variable font's weights) and Heebo's. */
  allFaces: readonly FontFaceInfo[];
  /** Every face name as `fontNameKey`: whether a name is complete. */
  names: ReadonlySet<string>;
}

/** The catalog of a list answer; an answer that is not in yet is an empty catalog. */
export function fontPickerCatalog(list: FontsListResponse | undefined): FontPickerCatalog {
  const families = list?.families ?? [];
  const allFaces = list?.catalog ?? [];
  const familyByKey = new Map<string, FontFamilySummary>();
  for (const family of families) familyByKey.set(fontNameKey(family.name), family);
  const faces: FontPickerFace[] = [];
  const byFamily = new Map<string, FontPickerFace[]>();
  const names = new Set<string>();
  for (const face of allFaces) {
    const familyKey = fontNameKey(face.family);
    const family = familyByKey.get(familyKey);
    if (family === undefined) continue;
    const key = fontNameKey(face.name);
    const entry: FontPickerFace = { face, family, key, words: key.split(' ') };
    faces.push(entry);
    names.add(key);
    const siblings = byFamily.get(familyKey);
    if (siblings === undefined) byFamily.set(familyKey, [entry]);
    else siblings.push(entry);
  }
  return { faces, byFamily, families, allFaces, names };
}

// --- the rows ------------------------------------------------------------------------------------

/**
 * A font the picker offers. A face row is one weight ("Heebo Bold"); a family row (`collapsed`,
 * shown when the matches belong to several families) is the family in its Regular, named by the
 * family and labelled with how many weights it has. Picking either writes `@` + {@link insertName}.
 */
export interface FontPickerItem {
  type: 'font';
  library: 'fonts';
  /** The face the row stands for (a family row: the family's Regular). */
  face: FontFaceInfo;
  family: FontFamilySummary;
  collapsed: boolean;
  /** What the row says: the face's name, or the family's on a family row. */
  name: string;
  /** What is written after the `@`: the face's name (`Heebo Bold`; `Heebo` for Regular). */
  insertName: string;
  /** `@Heebo Bold`. */
  token: string;
  /** What the row says on its right: "Hebrew + English", or "9 weights" on a family row. */
  right: string;
}

/** A row of the list: a LUT, a graphic or a font. */
export type PickerEntry = PickerItem | FontPickerItem;

/** The row for one face of the catalog (a font token in a note, or a face row of the list). */
export function faceItem(entry: FontPickerFace): FontPickerItem {
  const { face, family } = entry;
  return {
    type: 'font',
    library: 'fonts',
    face,
    family,
    collapsed: false,
    name: face.name,
    insertName: face.name,
    token: `@${face.name}`,
    right: fontScriptLabel(family.he),
  };
}

function familyItem(family: FontFamilySummary, faces: readonly FontPickerFace[]): FontPickerItem {
  const regular = defaultFace(faces.map((entry) => entry.face)) ?? faces[0]?.face;
  if (regular === undefined) throw new Error('A family with no faces');
  return {
    type: 'font',
    library: 'fonts',
    face: regular,
    family,
    collapsed: true,
    name: family.name,
    insertName: regular.name,
    token: `@${regular.name}`,
    right: family.weightsLabel,
  };
}

/** Regular first, Bold second, the rest by weight (an italic right after the upright of its weight). */
function faceRank(face: Pick<FontFaceInfo, 'weight' | 'italic'>): number {
  const italic = face.italic ? 0.0005 : 0;
  if (face.weight === 400 && !face.italic) return 0;
  if (face.weight === 700 && !face.italic) return 1;
  return 2 + face.weight / 1000 + italic;
}

/** The face a family shows when it leads the empty query: Bold when it has one, else its Regular. */
function bestFace(faces: readonly FontPickerFace[]): FontPickerFace | undefined {
  const bold = faces.find((entry) => entry.face.weight === 700 && !entry.face.italic);
  if (bold !== undefined) return bold;
  const regular = defaultFace(faces.map((entry) => entry.face));
  return faces.find((entry) => entry.face === regular) ?? faces[0];
}

/**
 * The empty query's fonts: the five most used families, each in its best face. `recent` is false
 * when nothing has been used yet: then the first five families A to Z lead, under "Fonts".
 */
export function recentFontItems(catalog: FontPickerCatalog): {
  items: FontPickerItem[];
  recent: boolean;
} {
  const families = catalog.families.filter((family) =>
    catalog.byFamily.has(fontNameKey(family.name)),
  );
  const used = families
    .filter((family) => family.used > 0)
    .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
  const recent = used.length > 0;
  const lead = (recent ? used : families).slice(0, FONT_RECENT_COUNT);
  const items: FontPickerItem[] = [];
  for (const family of lead) {
    const best = bestFace(catalog.byFamily.get(fontNameKey(family.name)) ?? []);
    if (best !== undefined) items.push(faceItem(best));
  }
  return { items, recent };
}

/**
 * The fonts a typed query shows (board `hits()`): a face matches when every word of the query
 * starts a word of its name ("heebo b" → Heebo Bold, Heebo Black). Matches from more than one
 * family make one row per family (its Regular, the family's name, "9 weights"), at most 10, the
 * ones that start with the query first, then the most used; matches from one family are that
 * family's faces, Regular, Bold, then by weight. An empty query matches nothing here: see
 * {@link recentFontItems}.
 */
export function matchFontItems(catalog: FontPickerCatalog, typed: string): FontPickerItem[] {
  const query = fontNameKey(typed);
  if (query === '') return [];
  const words = query.split(' ');
  const hits = catalog.faces.filter((entry) =>
    words.every((word) => entry.words.some((own) => own.startsWith(word))),
  );
  const byFamily = new Map<string, FontPickerFace[]>();
  for (const hit of hits) {
    const key = fontNameKey(hit.face.family);
    const some = byFamily.get(key);
    if (some === undefined) byFamily.set(key, [hit]);
    else some.push(hit);
  }
  if (byFamily.size <= 1) {
    return hits
      .slice()
      .sort((a, b) => faceRank(a.face) - faceRank(b.face))
      .map(faceItem);
  }
  const rows = [...byFamily.entries()].map(([key, some]) => {
    const first = some[0] as FontPickerFace;
    return {
      family: first.family,
      startsWith: some.some((hit) => hit.key.startsWith(query)),
      all: catalog.byFamily.get(key) ?? some,
    };
  });
  rows.sort(
    (a, b) =>
      Number(!a.startsWith) - Number(!b.startsWith) ||
      b.family.used - a.family.used ||
      a.family.name.localeCompare(b.family.name),
  );
  return rows.slice(0, FONT_FAMILY_ROWS_MAX).map((row) => familyItem(row.family, row.all));
}

/**
 * The faces whose files the open list needs in the page (`useFontFaces`): the faces of the rows,
 * and, for the highlighted font without Hebrew, Heebo's face nearest to its weight (the Hebrew line
 * of its card). Each once, in row order.
 */
export function visibleFontFaces(
  entries: readonly PickerEntry[],
  highlighted: PickerEntry | undefined,
  catalog: FontPickerCatalog,
): FontFaceInfo[] {
  const faces: FontFaceInfo[] = [];
  const seen = new Set<string>();
  const add = (face: FontFaceInfo | null) => {
    if (face === null || seen.has(face.fileId + face.name)) return;
    seen.add(face.fileId + face.name);
    faces.push(face);
  };
  for (const entry of entries) if (entry.type === 'font') add(entry.face);
  if (highlighted?.type === 'font' && !highlighted.family.he) {
    add(heeboFaceFor(catalog, highlighted.face.weight));
  }
  return faces;
}

/** Heebo's face nearest to `weight`, or `null` when the library has no Heebo. */
export function heeboFaceFor(catalog: FontPickerCatalog, weight: number): FontFaceInfo | null {
  const heebo = catalog.byFamily.get(fontNameKey(HEBREW_FALLBACK_FONT));
  if (heebo === undefined) return null;
  return nearestFace(
    heebo.map((entry) => entry.face),
    weight,
  );
}

// --- when the box is asking ----------------------------------------------------------------------

/** The picker query a note ends in, with what was typed as it was typed. */
export interface NoteQuery extends PickerQuery {
  /** What follows the `@` (after `luts/` or `graphics/` when the query names one), as typed. */
  typed: string;
}

/**
 * The `@` at the start or after whitespace, `-`, U+05BE (maqaf) or `(`, and everything after it
 * on the line (up to the end of the text, with no other `@`).
 */
const NOTE_QUERY = /(?<![^\s\-־(])@([^@\n]*)$/;

/** `luts/` or `graphics/` right after the `@`. */
const LIBRARY_PREFIX = /^(luts|graphics)\//i;

/**
 * The query a note ends in, or `null` when the picker is closed because of the text: it does not end
 * in `@` + a query, or the query is longer than {@link NOTE_QUERY_MAX} characters. The query may
 * hold spaces (a font's name does). One that starts `luts/` or `graphics/` (when `library` is on:
 * LUTs and graphics can be named) is LU7's: letters, digits and "-" only, so a space after the
 * slug closes it, as it always did.
 */
export function openNoteQuery(text: string, library: boolean): NoteQuery | null {
  const match = NOTE_QUERY.exec(text);
  if (match === null) return null;
  const typed = match[1] ?? '';
  if (typed.length > NOTE_QUERY_MAX) return null;
  const prefix = library ? LIBRARY_PREFIX.exec(typed) : null;
  if (prefix !== null) {
    const slug = typed.slice(prefix[0].length);
    if (!/^[a-z0-9-]*$/i.test(slug)) return null;
    return {
      start: match.index,
      library: (prefix[1] as string).toLowerCase() as LibraryName,
      query: slug.toLowerCase(),
      typed: slug,
    };
  }
  return { start: match.index, library: null, query: typed.toLowerCase(), typed };
}

// --- the list ------------------------------------------------------------------------------------

/** One group of the list: its heading and its rows (fonts, LUTs or graphics). */
export interface NotePickerGroup {
  library: LibraryName | 'fonts';
  head: string;
  items: PickerEntry[];
}

/** What the popover shows: `PickerView`, with the fonts group in front. */
export interface NotePickerView {
  groups: NotePickerGroup[];
  /** The rows in the order the keys walk them. */
  flat: PickerEntry[];
  /** Set when `flat` is empty. */
  none: PickerNone | null;
}

/** "Nothing in Fonts, LUTs or Graphics is called “Gotham”." and the button to Fonts. */
function bareNone(typed: string, library: boolean): PickerNone {
  const where = library ? 'Fonts, LUTs or Graphics' : 'Fonts';
  return {
    message: `Nothing in ${where} is called “${typed}”.`,
    action: { label: FONT_PICKER_TEXT.openFonts, to: '/fonts' },
  };
}

/** The groups of LU8's view as note groups. */
function noteGroups(view: PickerView, limit: number | null): NotePickerGroup[] {
  return view.groups.map((group) => ({
    library: group.library,
    head: group.head,
    items: limit === null ? group.items : group.items.slice(0, limit),
  }));
}

/** What the two lists a note box can name give the picker. */
export interface NotePickerSources {
  fonts: FontPickerCatalog;
  /** The LUTs and graphics (`useLibraryItems`); empty while `lutsInEdits` is off. */
  items: readonly PickerItem[];
  /** LUTs and graphics can be named (`lutsInEdits`): `luts/` and `graphics/` queries, and the words of the "none" panel. */
  library: boolean;
}

/**
 * What the picker shows for `query` while notes can name fonts, or `null` when it is closed:
 *
 * - `luts/…` and `graphics/…` are LU8's, unchanged (that group alone, every match).
 * - The empty query leads with "Fonts · recent" (see {@link recentFontItems}), the first 3 LUTs and
 *   the first 3 graphics.
 * - Any other query shows the fonts it matches ({@link matchFontItems}), then up to 4 LUTs and 4
 *   graphics whose slug or name contains it.
 * - A space after a complete face name means the name is done: closed (so after picking one, and
 *   after typing `Heebo Bold `). A query with a space that matches nothing is closed too; one
 *   without a space that matches nothing opens the "none" panel.
 */
export function notePickerView(
  sources: NotePickerSources,
  query: NoteQuery,
): NotePickerView | null {
  if (query.library !== null) {
    const view = pickerView(sources.items, query);
    return { groups: noteGroups(view, null), flat: view.flat, none: view.none };
  }
  const key = fontNameKey(query.typed);
  const trailingSpace = /\s$/.test(query.typed);
  if (key !== '' && trailingSpace && sources.fonts.names.has(key)) return null;

  const groups: NotePickerGroup[] = [];
  let libraryQuery: PickerQuery = { start: query.start, library: null, query: key };
  let fonts: FontPickerItem[];
  let head: string = FONT_PICKER_TEXT.fonts;
  if (key === '') {
    const recent = recentFontItems(sources.fonts);
    fonts = recent.items;
    if (recent.recent) head = FONT_PICKER_TEXT.recent;
    libraryQuery = { ...libraryQuery, query: '' };
  } else {
    fonts = matchFontItems(sources.fonts, key);
  }
  if (fonts.length > 0) groups.push({ library: 'fonts', head, items: fonts });
  const others = pickerView(sources.items, libraryQuery);
  groups.push(...noteGroups(others, key === '' ? FONT_EMPTY_LIBRARY_LIMIT : PICKER_GROUP_LIMIT));

  const flat = groups.flatMap((group) => group.items);
  if (flat.length > 0) return { groups, flat, none: null };
  if (trailingSpace || /\s/.test(key)) return null;
  return { groups: [], flat: [], none: bareNone(query.typed, sources.library) };
}

/**
 * `text` with the open query replaced by the chosen row and one space after it
 * (`Make it @he` → `Make it @Heebo Bold `): the face's name for a font (`@Heebo ` for Regular and
 * for a family row), `@luts/slug ` for a LUT, `@graphics/slug ` for a graphic. The cursor goes to
 * the end of what this returns.
 */
export function insertEntry(
  text: string,
  query: Pick<NoteQuery, 'start'>,
  entry: PickerEntry,
): string {
  const label = entry.type === 'font' ? entry.insertName : `${entry.library}/${entry.slug}`;
  return `${text.slice(0, query.start)}@${label} `;
}

/** What `@` points at, for the placeholder of a note box: "a LUT or a graphic", "a font", … */
export function pointAtText(fonts: boolean, library: boolean): string {
  if (fonts && library) return FONT_PICKER_TEXT.pointFontsAndLibrary;
  return fonts ? FONT_PICKER_TEXT.pointFonts : FONT_PICKER_TEXT.pointLibrary;
}

/** "not used yet", "used in 1 job", "used in 14 jobs": the card's last words. */
export function usedInText(used: number): string {
  if (used <= 0) return 'not used yet';
  return used === 1 ? 'used in 1 job' : `used in ${used} jobs`;
}
