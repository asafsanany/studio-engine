// The `@` tokens (LUTs build 2, LU7). OWNER: LU7.
//
// A note can name a library item by writing `@luts/<slug>` or `@graphics/<slug>`. This file is the
// one definition of what a token is and how text with tokens is read and edited: the engine (to
// find what a note uses), the `@` picker (LU8, LU12) and the notes that show chips all call it.
// The text of a note is stored as typed; nothing here changes how it is stored.
//
//   "Make it @luts/cinematic, then @graphics/lower-third at 0:12"
//        ─▶ parseLibraryTokens ─▶ [{luts, cinematic}, {graphics, lower-third}]
//
// Pure functions, no state.
//
// Fonts (the Fonts build 2, FN12) add a third kind, `@Heebo Bold`, to the same note text. A font's
// name has spaces, so it cannot be found with the regex above: {@link parseNoteTokens} (the last
// section of this file) reads fonts, LUTs and graphics together against a catalog and answers what
// each token points at and which names point at nothing. {@link parseLibraryTokens} and the rest
// above it are LU7's and stay as they are.

import { fontNameKey } from './fonts.ts';

/** The libraries a note can name. */
export const LIBRARY_NAMES = ['luts', 'graphics'] as const;
export type LibraryName = (typeof LIBRARY_NAMES)[number];

/** The longest slug (the same as `LUT_SLUG_PATTERN` and `lutSlug`). */
export const LIBRARY_SLUG_MAX = 60;

/** One token found in a text: `text.slice(start, end)` is `@<library>/<slug>`. */
export interface LibraryToken {
  library: LibraryName;
  slug: string;
  start: number;
  end: number;
}

/** What names a library item without saying where it is in a text. */
export type LibraryRef = Pick<LibraryToken, 'library' | 'slug'>;

/**
 * A token: `@luts/<slug>` or `@graphics/<slug>`, only at the start of the text or after
 * whitespace (so `mail@luts/x` is not one), and only if the character after the slug is not a
 * slug character (so `@luts/a-b!` ends at `b`, and a 61-character slug is not a token at all).
 * Group 1 is the library, group 2 the slug.
 *
 * This object is global (it keeps `lastIndex`): to scan with it, use {@link parseLibraryTokens},
 * or build your own with `new RegExp(LIBRARY_TOKEN)`.
 */
export const LIBRARY_TOKEN = /(?<!\S)@(luts|graphics)\/([a-z0-9][a-z0-9-]{0,59})(?![a-z0-9-])/g;

/** `@luts/cinematic` for `{library: 'luts', slug: 'cinematic'}`. */
export function libraryTokenText({ library, slug }: LibraryRef): string {
  return `@${library}/${slug}`;
}

/**
 * Every token in `text`, in the order they appear. With `{unique: true}` a (library, slug) that is
 * named again later is left out (the first one stays).
 */
export function parseLibraryTokens(
  text: string,
  { unique = false }: { unique?: boolean } = {},
): LibraryToken[] {
  const found: LibraryToken[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(LIBRARY_TOKEN))) {
    const library = match[1] as LibraryName;
    const slug = match[2] as string;
    if (unique) {
      const key = `${library}/${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const start = match.index ?? 0;
    found.push({ library, slug, start, end: start + match[0].length });
  }
  return found;
}

// --- the picker ----------------------------------------------------------------------------------

/**
 * The `@` the picker is open on: where it starts in the text, the library the query already
 * names (`@luts/cin` → `'luts'`; `@` and `@lu` → `null`) and what is typed after that.
 */
export interface PickerQuery {
  /** The index of the `@`; the query runs from here to the end of the text. */
  start: number;
  library: LibraryName | null;
  /** Lower case; `''` right after `@` or `@luts/`. */
  query: string;
}

/** The end of a text that is a picker query: `@`, `@lu`, `@luts/`, `@luts/cin`, `@graphics/na`. */
const OPEN_QUERY = /(?<!\S)@(?:(luts|graphics)\/([a-z0-9-]*)|([a-z0-9-]*))$/i;

/**
 * The picker query the text ends in, or `null` when it does not end in `@` plus an optional query
 * (the `@` must be at the start or after whitespace). The picker opens on a result and closes on
 * `null`. Letters are read without regard to case and returned in lower case.
 */
export function openPickerQuery(text: string): PickerQuery | null {
  const match = OPEN_QUERY.exec(text);
  if (match === null) return null;
  const library = match[1] === undefined ? null : (match[1].toLowerCase() as LibraryName);
  const query = (match[1] === undefined ? match[3] : match[2]) ?? '';
  return { start: match.index, library, query: query.toLowerCase() };
}

/** Whether the end of `text` is a picker query that starts exactly at `start`. */
function isOpenAt(text: string, start: number): boolean {
  return openPickerQuery(text)?.start === start;
}

/**
 * `text` with the open picker query replaced by the chosen token and one space after it
 * (`Make it @lu` → `Make it @luts/cinematic `). `query` is what {@link openPickerQuery} answered
 * for `text`; when the text has moved on and no longer ends in that query, the picker's current
 * query is used instead, and a text with no open query comes back unchanged.
 */
export function replacePickerQuery(text: string, query: PickerQuery, token: LibraryRef): string {
  const current = isOpenAt(text, query.start) ? query : openPickerQuery(text);
  if (current === null) return text;
  return `${text.slice(0, current.start)}${libraryTokenText(token)} `;
}

// --- editing and showing -------------------------------------------------------------------------

/**
 * `text` without every `token` it names, and one adjacent space for each: the space after the
 * token, or, when it has none, the one before it. Other whitespace (a newline) stays. A text that
 * is only whitespace afterwards comes back empty.
 */
export function removeToken(text: string, token: LibraryRef): string {
  return removeSpans(
    text,
    parseLibraryTokens(text).filter((t) => t.library === token.library && t.slug === token.slug),
  );
}

/**
 * `text` without the given spans (each `text.slice(start, end)`, the places of tokens that do not
 * overlap), and one adjacent space for each: the space after it, or, when it has none, the one
 * before it. Other whitespace (a newline) stays. A text that is only whitespace afterwards comes
 * back empty; with no span it comes back as it was. This is {@link removeToken}'s edit for any
 * reader of tokens, fonts included ({@link parseNoteTokens}).
 */
export function removeSpans(
  text: string,
  spans: readonly { start: number; end: number }[],
): string {
  let result = text;
  for (const { start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    let from = start;
    let to = end;
    if (result[to] === ' ') to += 1;
    else if (from > 0 && result[from - 1] === ' ') from -= 1;
    result = result.slice(0, from) + result.slice(to);
  }
  return spans.length > 0 && result.trim() === '' ? '' : result;
}

/** A piece of a note: plain text, or a token (to show as a chip). */
export type TokenPart = { text: string } | { token: LibraryToken };

/**
 * The text cut into plain-text and token parts, in order, so a note can show its tokens as chips.
 * Joining the parts' text (a token's is `text.slice(start, end)`) gives the text back; no part is
 * empty, and an empty text has no parts.
 */
export function splitByTokens(text: string): TokenPart[] {
  const parts: TokenPart[] = [];
  let last = 0;
  for (const token of parseLibraryTokens(text)) {
    if (token.start > last) parts.push({ text: text.slice(last, token.start) });
    parts.push({ token });
    last = token.end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// --- graphic slugs -------------------------------------------------------------------------------

/** Characters, not UTF-16 units: a Hebrew letter or an emoji counts once. */
function cutTo(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * The slug a graphic is named by in a note. Graphics have no slug column: it is the name with the
 * same rule as `lutSlug` (accents dropped, lower case, runs of anything but a-z and 0-9 become a
 * single "-", no "-" at the ends, at most 60 characters). A name with no letters or digits
 * (Hebrew, say) gets `graphic-<first 6 of the id>`.
 */
export function graphicSlug(name: string, fallbackId: string): string {
  const slug = cutTo(
    name
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, ''),
    LIBRARY_SLUG_MAX,
  ).replace(/-+$/, '');
  return slug === '' ? `graphic-${fallbackId.slice(0, 6).toLowerCase()}` : slug;
}

// --- notes: fonts, LUTs and graphics together (FN12) ---------------------------------------------

/**
 * What a font token is matched against: a face's name (what the owner types after `@`, see `faceName`)
 * and what the face is. `GET /api/fonts`'s `catalog` entries (`FontFaceInfo`) and the engine's font
 * index fit as they are.
 */
export interface NoteCatalogFace {
  name: string;
  family: string;
  weight: number;
  italic: boolean;
}

/** What a LUT or graphic token is matched against: the slug a note names it by. */
export interface NoteCatalogSlug {
  slug: string;
}

/**
 * Everything a note can name. Any part may be empty or left out (then every name of that kind is
 * unresolved). The types are generic so a caller with richer rows (a font index with files, say)
 * gets them back on the tokens.
 */
export interface NoteCatalog<
  F extends NoteCatalogFace = NoteCatalogFace,
  L extends NoteCatalogSlug = NoteCatalogSlug,
  G extends NoteCatalogSlug = NoteCatalogSlug,
> {
  faces?: readonly F[];
  luts?: readonly L[];
  graphics?: readonly G[];
}

interface NoteTokenBase {
  /** The index of the `@`. */
  start: number;
  /** The index after the last character of the name: `text.slice(start, end)` is {@link raw}. */
  end: number;
  /** The token as typed (`@HEEBO bold`). */
  raw: string;
}

/**
 * A token that points at a row of the catalog: `face` for a font, `lut` for a LUT, `graphic` for a
 * graphic (the row of the catalog, as given). The other two are never there.
 */
export type NoteToken<
  F extends NoteCatalogFace = NoteCatalogFace,
  L extends NoteCatalogSlug = NoteCatalogSlug,
  G extends NoteCatalogSlug = NoteCatalogSlug,
> =
  | (NoteTokenBase & { kind: 'font'; face: F; lut?: undefined; graphic?: undefined })
  | (NoteTokenBase & { kind: 'lut'; lut: L; face?: undefined; graphic?: undefined })
  | (NoteTokenBase & { kind: 'graphic'; graphic: G; face?: undefined; lut?: undefined });

/**
 * A name that points at nothing. `name` is a LUT's or graphic's slug with its prefix
 * (`luts/nope`) or a font's name the way it is said, words joined by single spaces (`Gotham Bold`).
 * `start` and `end` are as in {@link NoteToken}.
 */
export interface UnresolvedNoteName {
  kind: 'font' | 'lut' | 'graphic';
  start: number;
  end: number;
  name: string;
}

export interface ParsedNoteTokens<
  F extends NoteCatalogFace = NoteCatalogFace,
  L extends NoteCatalogSlug = NoteCatalogSlug,
  G extends NoteCatalogSlug = NoteCatalogSlug,
> {
  /** In the order they are written, each one as often as it is written. */
  tokens: NoteToken<F, L, G>[];
  /** The names that matched nothing, in the order they are written. */
  unresolved: UnresolvedNoteName[];
}

/** What may stand right before an `@` that starts a token: whitespace, a hyphen, a maqaf or `(`. */
const NOTE_TOKEN_OPENER = /[\s\-\u05BE(]/;

/** What ends a name when it follows it: anything that is not an ASCII letter or digit. */
const NAME_CHARACTER = /[A-Za-z0-9]/;

/** Spaces and tabs, not a line break: "@Heebo\nBold" is Heebo, then a new line. */
const NAME_GAP = /[^\S\r\n]/;

/** A LUT's or graphic's token after the `@`; group 1 is the library, group 2 the slug. */
const NOTE_LIBRARY_TOKEN_SOURCE = `(luts|graphics)\\/([a-z0-9][a-z0-9-]{0,${LIBRARY_SLUG_MAX - 1}})(?![a-z0-9-])`;

/** One word of an unresolved font name: starts with a capital letter or a digit. */
const CAPITAL_WORD = /[A-Z0-9][A-Za-z0-9]*/y;

/** An unresolved font name has at most this many words. */
const UNRESOLVED_NAME_WORDS = 3;

interface FaceMatcher<F> {
  face: F;
  /** The face's name as lower-case words (`fontNameKey` split at its single spaces). */
  words: string[];
  length: number;
}

function skipGap(text: string, from: number): number {
  let i = from;
  while (i < text.length && NAME_GAP.test(text.charAt(i))) i += 1;
  return i;
}

/**
 * Where the face named by `words` ends when `text` has it at `from` (without regard to case, with
 * any run of spaces between the words), or `-1`. The name must end at the end of the text or at a
 * character that is not an ASCII letter or digit.
 */
function matchFaceAt(text: string, from: number, words: readonly string[]): number {
  let i = from;
  for (const [n, word] of words.entries()) {
    if (n > 0) {
      const next = skipGap(text, i);
      if (next === i) return -1;
      i = next;
    }
    if (text.slice(i, i + word.length).toLowerCase() !== word) return -1;
    i += word.length;
  }
  return i < text.length && NAME_CHARACTER.test(text.charAt(i)) ? -1 : i;
}

/**
 * The unresolved font name at `from` (just after an `@`): up to three words that start with a
 * capital letter or a digit, with spaces between them, stopping at the first word that starts with
 * a lower-case letter, at punctuation or at the end. `null` when the first word is not one.
 */
function unresolvedFontName(text: string, from: number): { name: string; end: number } | null {
  const words: string[] = [];
  let end = from;
  let i = from;
  while (words.length < UNRESOLVED_NAME_WORDS) {
    CAPITAL_WORD.lastIndex = i;
    const match = CAPITAL_WORD.exec(text);
    if (match === null) break;
    words.push(match[0]);
    end = i + match[0].length;
    const next = skipGap(text, end);
    if (next === end) break;
    i = next;
  }
  return words.length === 0 ? null : { name: words.join(' '), end };
}

/**
 * Every `@` token in a note, and the names that point at nothing.
 *
 *   "Titles in @Rubik Black and captions in @Heebo Medium, with @luts/cinematic"
 *      ─▶ tokens: font Rubik Black, font Heebo Medium, lut cinematic
 *
 * A token starts at an `@` at the start of the text or after whitespace, a hyphen, a maqaf
 * (U+05BE) or `(`: `ל-@Heebo Bold` is one, `owner@heebo.com` is not.
 *
 * - A font is its face's full name (`@Heebo Bold`; `@Heebo` is the Regular face). The text after
 *   the `@` is compared with the catalog's face names without regard to case and with any run of
 *   spaces counting as one; the longest name wins; and the name must end at the end of the text or
 *   before a character that is not an ASCII letter or digit (a Hebrew letter, a space or
 *   punctuation all end it): `@Heebo Bold and bigger` is Heebo Bold, `@Heebo and bigger` is Heebo.
 * - A LUT or graphic is `@luts/<slug>` or `@graphics/<slug>` (the slug is 1 to 60 of a-z, 0-9
 *   and "-", starting with a letter or digit), in lower case and found in the catalog.
 * - An `@` that matched nothing takes the name it was written with into `unresolved`: for
 *   `luts/` and `graphics/` the slug with its prefix, for anything else up to three words that
 *   start with a capital letter or a digit (`@Gotham Bold and bigger` → `Gotham Bold`; `@gotham`
 *   is no name). A `luts/` or `graphics/` prefix followed by no valid slug names nothing.
 *
 * LU7's {@link parseLibraryTokens} is the older, regex-only reader of LUTs and graphics, which
 * allows only whitespace before the `@` and has no catalog; this reader allows the wider openers
 * above because a font is typed in the middle of Hebrew text.
 */
export function parseNoteTokens<
  F extends NoteCatalogFace = NoteCatalogFace,
  L extends NoteCatalogSlug = NoteCatalogSlug,
  G extends NoteCatalogSlug = NoteCatalogSlug,
>(text: string, catalog: NoteCatalog<F, L, G> = {}): ParsedNoteTokens<F, L, G> {
  const result: ParsedNoteTokens<F, L, G> = { tokens: [], unresolved: [] };
  if (!text.includes('@')) return result;

  const matchers: FaceMatcher<F>[] = [];
  for (const face of catalog.faces ?? []) {
    const key = fontNameKey(face.name);
    if (key !== '') matchers.push({ face, words: key.split(' '), length: key.length });
  }
  matchers.sort((a, b) => b.length - a.length);
  const lutBySlug = new Map<string, L>();
  for (const lut of catalog.luts ?? []) if (!lutBySlug.has(lut.slug)) lutBySlug.set(lut.slug, lut);
  const graphicBySlug = new Map<string, G>();
  for (const graphic of catalog.graphics ?? []) {
    if (!graphicBySlug.has(graphic.slug)) graphicBySlug.set(graphic.slug, graphic);
  }
  const libraryToken = new RegExp(NOTE_LIBRARY_TOKEN_SOURCE, 'y');

  let at = text.indexOf('@');
  while (at >= 0) {
    let next = at + 1;
    if (at === 0 || NOTE_TOKEN_OPENER.test(text.charAt(at - 1))) {
      const from = at + 1;
      libraryToken.lastIndex = from;
      const lib = libraryToken.exec(text);
      if (lib !== null) {
        const end = from + lib[0].length;
        const slug = lib[2] as string;
        const base = { start: at, end, raw: text.slice(at, end) };
        const lut = lib[1] === 'luts' ? lutBySlug.get(slug) : undefined;
        const graphic = lib[1] === 'graphics' ? graphicBySlug.get(slug) : undefined;
        if (lut !== undefined) result.tokens.push({ ...base, kind: 'lut', lut });
        else if (graphic !== undefined) result.tokens.push({ ...base, kind: 'graphic', graphic });
        else {
          const kind = lib[1] === 'luts' ? 'lut' : 'graphic';
          result.unresolved.push({ kind, start: at, end, name: `${lib[1]}/${slug}` });
        }
        next = end;
      } else {
        let found = false;
        for (const { face, words } of matchers) {
          const end = matchFaceAt(text, from, words);
          if (end < 0) continue;
          result.tokens.push({ kind: 'font', face, start: at, end, raw: text.slice(at, end) });
          next = end;
          found = true;
          break;
        }
        if (!found && !/^(?:luts|graphics)\//i.test(text.slice(from, from + 10))) {
          const name = unresolvedFontName(text, from);
          if (name !== null) {
            result.unresolved.push({ kind: 'font', start: at, end: name.end, name: name.name });
            next = name.end;
          }
        }
      }
    }
    at = text.indexOf('@', next);
  }
  return result;
}

// --- what a font is for (FN12) -------------------------------------------------------------------

/** The text a font is for, as far as the note's own words say: captions, titles or all text. */
export type FontScope = 'captions' | 'titles' | 'all';

/** Words that name the captions: caption(s), subtitle(s) and the Hebrew כתוביות. */
const CAPTION_WORDS = 'caption|subtitle|כתוב';

/** Words that name the titles: title(s), heading(s) and the Hebrew כותרת. "subtitle" is not one. */
const TITLE_WORDS = '(?<!sub)title|heading|כותר';

/** Where the last match of `source` starts in `text`, or -1. */
function lastMatchIndex(source: string, text: string): number {
  let last = -1;
  for (const match of text.matchAll(new RegExp(source, 'gi'))) last = match.index ?? last;
  return last;
}

/** Where the first match of `source` starts in `text`, or -1. */
function firstMatchIndex(source: string, text: string): number {
  return text.search(new RegExp(source, 'i'));
}

/**
 * Which text a font token is for, guessed from the note's words: `before` is the text between the
 * previous token and this one, `after` the text between this one and the next. The nearest
 * "caption", "subtitle" or "כתוב" word before the token and the nearest "title", "heading" or
 * "כותר" word before it compete (the one closer to the token wins); when there is neither before
 * it, the first such word after it decides (the closer to the token again); else all text.
 *
 * Only for what the UI says ("the next edit uses Heebo Bold for the captions") and for the live
 * preview. The edit decides from the note's words itself; this never reaches the engine.
 */
export function fontScope(before: string, after: string): FontScope {
  const beforeCaption = lastMatchIndex(CAPTION_WORDS, before);
  const beforeTitle = lastMatchIndex(TITLE_WORDS, before);
  if (beforeCaption >= 0 || beforeTitle >= 0)
    return beforeCaption > beforeTitle ? 'captions' : 'titles';
  const afterCaption = firstMatchIndex(CAPTION_WORDS, after);
  const afterTitle = firstMatchIndex(TITLE_WORDS, after);
  if (afterCaption >= 0 || afterTitle >= 0) {
    return afterTitle < 0 || (afterCaption >= 0 && afterCaption < afterTitle)
      ? 'captions'
      : 'titles';
  }
  return 'all';
}

/**
 * {@link fontScope} for the `index`th of `tokens` (as {@link parseNoteTokens} answered for
 * `text`): the words before it start after the token before it (of any kind), the words after it
 * end at the token after it. The first token reads from the start of the text and the last one to
 * its end.
 */
export function fontScopeOfToken(
  text: string,
  tokens: readonly Pick<NoteTokenBase, 'start' | 'end'>[],
  index: number,
): FontScope {
  const token = tokens[index];
  if (token === undefined) return 'all';
  const previous = tokens[index - 1];
  const following = tokens[index + 1];
  return fontScope(
    text.slice(previous?.end ?? 0, token.start),
    text.slice(token.end, following?.start ?? text.length),
  );
}
