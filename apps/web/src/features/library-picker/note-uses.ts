// What a note names once fonts are in it (Fonts plan, "Using fonts"; board FOReview: `parse()`, the
// chips' `remove` and the posted note's lines): the fonts, LUTs and graphics a text points at, once
// each in the order they are first written, the text cut into plain parts and tokens, how a chip's ×
// edits the text, and the lines a sent note carries. Plain functions, so the tests need no browser.
//
// This is the note-level reader that knows fonts. LU7's `namedItems`, `sentNoteParts` and
// `removeToken` (picker-items.ts, shared) read LUTs and graphics only, after whitespace only; while
// the `fontsInNotes` switch is on the "Uses" row, the sent notes and the chip's × call this file
// instead, and it reads with the same `parseNoteTokens` the engine uses (shared, FN12). With the
// switch off nothing here is called and those are exactly LU8's.

import {
  type FontScope,
  fontNameKey,
  fontScopeOfToken,
  type NoteCatalogFace,
  parseNoteTokens,
  removeSpans,
  type UnresolvedNoteName,
} from '@studio/shared';
import {
  type FontPickerCatalog,
  type FontPickerFace,
  type FontPickerItem,
  faceItem,
  type PickerEntry,
} from './font-picker';
import {
  type GraphicPickerItem,
  type LutPickerItem,
  type PickerItem,
  type PlacedAt,
  sentLead,
  sentLine,
} from './picker-items';

/** What a note is read against: the font library and the LUTs and graphics the picker offers. */
export interface NoteSources {
  fonts: FontPickerCatalog;
  /** Empty while LUTs and graphics cannot be named (`lutsInEdits` off): their tokens stay text. */
  items: readonly PickerItem[];
}

/** One thing a note names, however often it writes it. */
export interface NoteUse {
  /** Tells two uses apart: the same face (any spelling of its name), the same LUT or graphic. */
  key: string;
  entry: PickerEntry;
  /** The text a font is for, as far as the note's words say (its first mention); `null` for a LUT or a graphic. */
  scope: FontScope | null;
}

/** A piece of a note: plain text, or a token that points at something (shown as a pill). */
export type NotePart = { text: string } | { text: string; entry: PickerEntry };

/** A token's place in the text and the use it belongs to. */
export interface NoteSpan {
  start: number;
  end: number;
  key: string;
}

export interface ReadNote {
  /** Once each, in the order first written. A name that points at nothing is not one. */
  uses: NoteUse[];
  /** Joining the parts' text gives the note back; a note with no token is one part (none if empty). */
  parts: NotePart[];
  /** Every token, as often as it is written. */
  spans: NoteSpan[];
  /**
   * The font names the library does not have (`@Outfit Bold`: shared's `parseNoteTokens`
   * `unresolved`, fonts only), as written with single spaces, once each without regard to case, in
   * the order first written. LUT and graphic names are never here. Empty while the font list is
   * not in (an empty catalog cannot say what is missing).
   */
  missing: string[];
}

/** A face of the catalog the way `parseNoteTokens` reads it, with the row the picker shows for it. */
interface FaceRow extends NoteCatalogFace {
  item: FontPickerItem;
}

const FACE_ROWS = new WeakMap<FontPickerCatalog, readonly FaceRow[]>();

function faceRows(catalog: FontPickerCatalog): readonly FaceRow[] {
  const known = FACE_ROWS.get(catalog);
  if (known !== undefined) return known;
  const rows = catalog.faces.map((entry: FontPickerFace) => ({
    name: entry.face.name,
    family: entry.face.family,
    weight: entry.face.weight,
    italic: entry.face.italic,
    item: faceItem(entry),
  }));
  FACE_ROWS.set(catalog, rows);
  return rows;
}

/** What tells two entries apart: a face by its name without regard to case or doubled spaces, a LUT or graphic by its token. */
export function noteUseKey(entry: PickerEntry): string {
  return entry.type === 'font' ? `font:${fontNameKey(entry.face.name)}` : entry.token;
}

/**
 * What a chip or a pill says: a font's `@Heebo Bold`; a LUT's or graphic's `@luts/cinematic`. (Without
 * fonts in the notes a LUT is shown as its bare `luts/cinematic`, LU8's way; with them, the three
 * kinds are written alike, as the board does.)
 */
export function entryLabel(entry: PickerEntry): string {
  return entry.type === 'font' ? entry.token : `@${entry.token}`;
}

/** The accessible name of a chip's × button: "Remove @Heebo Bold from the note". */
export function removeUseLabel(entry: PickerEntry): string {
  return `Remove ${entryLabel(entry)} from the note`;
}

const isLut = (item: PickerItem): item is LutPickerItem => item.type === 'lut';
const isGraphic = (item: PickerItem): item is GraphicPickerItem => item.type === 'graphic';

/**
 * Everything `text` names (shared's `parseNoteTokens`: `@Heebo Bold`, `@luts/cinematic`,
 * `@graphics/follow-card`, after whitespace, a hyphen, a maqaf or `(`, so `ל-@Heebo Bold` counts). A
 * name the library does not have, or a LUT or graphic while those cannot be named, is left in the
 * text as it is. The scope of a font is shared's `fontScopeOfToken` for its first mention.
 */
export function readNote(text: string, sources: NoteSources): ReadNote {
  if (!text.includes('@')) {
    return { uses: [], parts: text === '' ? [] : [{ text }], spans: [], missing: [] };
  }
  const { tokens, unresolved } = parseNoteTokens(text, {
    faces: faceRows(sources.fonts),
    luts: sources.items.filter(isLut),
    graphics: sources.items.filter(isGraphic),
  });
  const uses: NoteUse[] = [];
  const parts: NotePart[] = [];
  const spans: NoteSpan[] = [];
  const seen = new Set<string>();
  let last = 0;
  for (const [index, token] of tokens.entries()) {
    const entry: PickerEntry =
      token.kind === 'font' ? token.face.item : token.kind === 'lut' ? token.lut : token.graphic;
    const key = noteUseKey(entry);
    if (token.start > last) parts.push({ text: text.slice(last, token.start) });
    parts.push({ text: token.raw, entry });
    last = token.end;
    spans.push({ start: token.start, end: token.end, key });
    if (!seen.has(key)) {
      seen.add(key);
      uses.push({
        key,
        entry,
        scope: token.kind === 'font' ? fontScopeOfToken(text, tokens, index) : null,
      });
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return {
    uses,
    parts,
    spans,
    missing: sources.fonts.faces.length === 0 ? [] : missingFonts(unresolved),
  };
}

/** The font names among `unresolved`, once each (without regard to case or doubled spaces). */
function missingFonts(unresolved: readonly UnresolvedNoteName[]): string[] {
  const names = new Map<string, string>();
  for (const entry of unresolved) {
    if (entry.kind !== 'font') continue;
    const key = fontNameKey(entry.name);
    if (!names.has(key)) names.set(key, entry.name);
  }
  return [...names.values()];
}

/**
 * `text` without every mention of the use `key`, and one adjacent space for each (the one after it,
 * else the one before it); a text that is only whitespace afterwards comes back empty. The chip's ×.
 */
export function removeNoteUse(text: string, sources: NoteSources, key: string): string {
  return removeSpans(
    text,
    readNote(text, sources).spans.filter((span) => span.key === key),
  );
}

/** What a font is used for, in the sent note's words. */
export const SCOPE_PHRASES: Readonly<Record<FontScope, string>> = {
  captions: 'the captions',
  titles: 'the titles',
  all: 'all the text it adds',
};

/**
 * The dim line for a font name the library does not have: the edit does not wait, it uses the
 * closest font it has (the Fonts page's bar says the same once the run has started, C51).
 */
export function missingFontLine(name: string): string {
  return `${name} isn’t in your library, so the edit will use the closest font it has.`;
}

/**
 * The dim lines under a sent note, one per use: "Saved. The next edit uses Heebo Bold for the
 * captions." then "It also uses Rubik Black for the titles."; a LUT "…uses Cinematic on the whole
 * video."; a graphic "…places Name at 0:12." After them one line per font name the library does
 * not have: "Outfit Bold isn’t in your library, so the edit will use the closest font it has." A
 * note that names nothing gets none.
 */
export function noteSavedLines(read: ReadNote, timeLabel: PlacedAt): string[] {
  const lines = read.uses.map(({ entry, scope }, index) => {
    const first = index === 0;
    if (entry.type !== 'font') return sentLine(entry, first, timeLabel);
    return `${sentLead(first)}uses ${entry.name} for ${SCOPE_PHRASES[scope ?? 'all']}.`;
  });
  return [...lines, ...read.missing.map(missingFontLine)];
}
