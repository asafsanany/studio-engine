// What the @ picker decides, apart from how it looks (LUTs plan, "The @ picker"; board LUReview):
// the items it offers, which of them a typed query shows, what to say when none does, which items a
// text already names, and the lines a sent note carries. Plain functions, so the tests need no
// browser. The token rules themselves (what ends a query, how an item is written into the text)
// are LU7's `library-tokens.ts` in shared.

import {
  BUILTIN_LUTS,
  GRAPHIC_KIND_LABELS,
  type GraphicKind,
  type GraphicSummary,
  graphicSlug,
  type LibraryName,
  type LibraryRef,
  type LutListResponse,
  type LutOwner,
  type LutSummary,
  type PickerQuery,
  parseLibraryTokens,
  splitByTokens,
} from '@studio/shared';

/** A LUT the picker offers (a camera LUT never is: the grade does not take one by name). */
export interface LutPickerItem {
  type: 'lut';
  library: 'luts';
  /** The bare slug: `cinematic`. */
  slug: string;
  /** What is written in a note: `luts/cinematic`. */
  token: string;
  name: string;
  kind: 'look' | 'fix';
  owner: LutOwner;
  /** The built-in LUT's line; empty for one of Yours (an import has no description). */
  description: string;
  /** The `?v=` of its stills, so the browser may keep them. */
  previewKey: string | null;
}

/** A graphic the picker offers: one that has a version edits can place. */
export interface GraphicPickerItem {
  type: 'graphic';
  library: 'graphics';
  slug: string;
  token: string;
  name: string;
  kind: GraphicKind;
  /** "Lower third". */
  kindLabel: string;
  /** Seconds; `null` while the newest version says none. */
  lengthSec: number | null;
}

export type PickerItem = LutPickerItem | GraphicPickerItem;

/** The words of the picker. */
export const PICKER_TEXT = {
  luts: 'LUTs',
  graphics: 'Graphics',
  listLabel: 'Library',
  hint: '↑ ↓ to move · Enter to add · Esc to close',
  before: 'Before',
  after: 'After',
  uses: 'Uses',
  lutUse: 'A LUT applies to the whole video.',
  openLuts: 'Open LUTs to import one',
  openGraphics: 'Open Graphics to add one',
  nothingYet: 'Nothing in LUTs or Graphics yet.',
  noLutsYet: 'There are no LUTs yet.',
  noGraphicsYet: 'There are no graphics yet.',
  placeholder: 'Write a note… type @ to point at a LUT or a graphic',
} as const;

/**
 * The placeholder of a note box that has the picker: "Write a note… type @ to point at a LUT or a
 * graphic". `pointAt` is what `@` points at (`LibraryPicker.pointAt`); with fonts in the notes it
 * says "a font, a LUT or a graphic".
 */
export function pickerPlaceholder(pointAt: string): string {
  return `Write a note… type @ to point at ${pointAt}`;
}

/**
 * Where a note pins a graphic: "0:12" in Review; `null` where no time is known yet (the Brief's
 * note, the job's note for the editor), and the edit places it where it fits.
 */
export type PlacedAt = string | null;

/** "A graphic is placed at 0:12." / "A graphic is placed where it fits." */
export function graphicUseLine(timeLabel: PlacedAt): string {
  return timeLabel === null
    ? 'A graphic is placed where it fits.'
    : `A graphic is placed at ${timeLabel}.`;
}

/** The preview card's line for a graphic: "Placed at 0:12" / "Placed where it fits." */
export function placedLine(timeLabel: PlacedAt): string {
  return timeLabel === null ? 'Placed where it fits.' : `Placed at ${timeLabel}`;
}

/** The accessible name of a chip's × button: "Remove luts/cinematic from the note". */
export function removeChipLabel(item: Pick<PickerItem, 'token'>): string {
  return `Remove ${item.token} from the note`;
}

/** The built-in LUTs the empty query leads with, in this order. */
const FEATURED_LUTS = ['cinematic', 'film-contrast', 'golden-warm'] as const;

/** A bare query offers at most this many of each group; `luts/` or `graphics/` offers them all. */
export const PICKER_GROUP_LIMIT = 4;

/**
 * The LUTs the picker offers, in the board's order: Cinematic, Film contrast and Golden warm, then
 * Yours (newest first, as the server lists them), then the rest of Built in. Camera LUTs are left
 * out. `undefined` (not loaded, or LUTs off) offers none.
 */
export function lutPickerItems(list: LutListResponse | undefined): LutPickerItem[] {
  if (list === undefined) return [];
  const notCamera = (lut: LutSummary): boolean => lut.kind !== 'camera';
  const builtIn = list.builtIn.filter(notCamera);
  const featured = FEATURED_LUTS.flatMap((slug) => builtIn.filter((lut) => lut.slug === slug));
  const rest = builtIn.filter((lut) => !FEATURED_LUTS.some((slug) => slug === lut.slug));
  return [...featured, ...list.yours.filter(notCamera), ...rest].map((lut) => ({
    type: 'lut' as const,
    library: 'luts' as const,
    slug: lut.slug,
    token: `luts/${lut.slug}`,
    name: lut.name,
    kind: lut.kind === 'fix' ? ('fix' as const) : ('look' as const),
    owner: lut.owner,
    description: BUILTIN_LUTS.find((row) => row.slug === lut.slug)?.description ?? '',
    previewKey: lut.previewKey ?? null,
  }));
}

/**
 * The graphics the picker offers: the ones with a version (the engine can place nothing before
 * v1), in the list's order. A name that makes the same slug as an earlier one is left out, since
 * the token could only point at one of them.
 */
export function graphicPickerItems(
  graphics: readonly GraphicSummary[] | undefined,
): GraphicPickerItem[] {
  if (graphics === undefined) return [];
  const seen = new Set<string>();
  const items: GraphicPickerItem[] = [];
  for (const graphic of graphics) {
    if (graphic.version === null) continue;
    const slug = graphicSlug(graphic.name, graphic.id);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const kind = graphic.kind ?? 'other';
    items.push({
      type: 'graphic',
      library: 'graphics',
      slug,
      token: `graphics/${slug}`,
      name: graphic.name,
      kind,
      kindLabel: GRAPHIC_KIND_LABELS[kind],
      lengthSec: graphic.lengthSec,
    });
  }
  return items;
}

/** One group of the list: its heading and its items. */
export interface PickerGroup {
  library: LibraryName;
  head: string;
  items: PickerItem[];
}

/** What the popover says when nothing matches: the sentence and, for a named library, a button to its page. */
export interface PickerNone {
  message: string;
  action: { label: string; to: '/luts' | '/graphics' | '/fonts' } | null;
}

export interface PickerView {
  groups: PickerGroup[];
  /** The items in the order the keys walk them (LUTs, then graphics). */
  flat: PickerItem[];
  /** Set when `flat` is empty. */
  none: PickerNone | null;
}

function matches(item: PickerItem, query: PickerQuery): boolean {
  if (query.query === '') return true;
  const name = item.name.toLowerCase();
  // Naming a library, the rest is looked for in the slug and the name. With a bare query ("lu",
  // "cin") it is looked for in the whole token too, so "@lu" reaches every LUT and "@gr" every graphic.
  const haystack = query.library === null ? item.token : item.slug;
  return haystack.includes(query.query) || name.includes(query.query);
}

function noneFor(query: PickerQuery): PickerNone {
  const typed = query.query;
  if (query.library === 'luts') {
    return {
      message: typed === '' ? PICKER_TEXT.noLutsYet : `No LUT called “${typed}”.`,
      action: { label: PICKER_TEXT.openLuts, to: '/luts' },
    };
  }
  if (query.library === 'graphics') {
    return {
      message: typed === '' ? PICKER_TEXT.noGraphicsYet : `No graphic called “${typed}”.`,
      action: { label: PICKER_TEXT.openGraphics, to: '/graphics' },
    };
  }
  return {
    message:
      typed === '' ? PICKER_TEXT.nothingYet : `Nothing in LUTs or Graphics is called “${typed}”.`,
    action: null,
  };
}

/**
 * What the popover shows for `query` (LU7's `openPickerQuery`): two groups, LUTs and Graphics
 * (a group with nothing to show is absent). A bare query shows 4 of each; `luts/` or `graphics/`
 * shows only that group, every match. Nothing at all gives the sentence for the empty popover.
 */
export function pickerView(items: readonly PickerItem[], query: PickerQuery): PickerView {
  const hits = (library: LibraryName): PickerItem[] => {
    if (query.library !== null && query.library !== library) return [];
    const found = items.filter((item) => item.library === library && matches(item, query));
    return query.library === null ? found.slice(0, PICKER_GROUP_LIMIT) : found;
  };
  const groups: PickerGroup[] = [];
  const luts = hits('luts');
  const graphics = hits('graphics');
  if (luts.length > 0) groups.push({ library: 'luts', head: PICKER_TEXT.luts, items: luts });
  if (graphics.length > 0) {
    groups.push({ library: 'graphics', head: PICKER_TEXT.graphics, items: graphics });
  }
  const flat = [...luts, ...graphics];
  return { groups, flat, none: flat.length === 0 ? noneFor(query) : null };
}

/** The highlight after a key: ↓ and ↑ wrap around. `count` 0 keeps 0. */
export function moveHighlight(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (clampHighlight(index, count) + step + count) % count;
}

/** The highlight kept inside the list (the list may have got shorter under it). */
export function clampHighlight(index: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
}

/** The items a text names, once each, in the order they are first written. A token that points at nothing is left out. */
export function namedItems(text: string, items: readonly PickerItem[]): PickerItem[] {
  const found: PickerItem[] = [];
  for (const token of parseLibraryTokens(text, { unique: true })) {
    const item = items.find((it) => it.library === token.library && it.slug === token.slug);
    if (item !== undefined) found.push(item);
  }
  return found;
}

/** The item a reference points at, or `undefined`. */
export function findItem(items: readonly PickerItem[], ref: LibraryRef): PickerItem | undefined {
  return items.find((item) => item.library === ref.library && item.slug === ref.slug);
}

/** The meta line of a preview: "Look · built in", "Fix · yours", "Lower third · 3 s". */
export function itemMeta(item: PickerItem): string {
  if (item.type === 'lut') {
    const kind = item.kind === 'fix' ? 'Fix' : 'Look';
    return `${kind} · ${item.owner === 'yours' ? 'yours' : 'built in'}`;
  }
  const length = item.lengthSec === null ? '' : ` · ${Number(item.lengthSec.toFixed(1))} s`;
  return `${item.kindLabel}${length}`;
}

/** The accessible name of a LUT's before/after picture. */
export function lutPreviewAlt(item: LutPickerItem, timeLabel: PlacedAt): string {
  return timeLabel === null
    ? `Before and after: ${item.name} on the test frame`
    : `Before and after: ${item.name} on the frame at ${timeLabel}`;
}

/**
 * The dim lines under a sent note that names library items, one per item: "Saved. The next edit
 * uses Cinematic on the whole video." then "It also uses X on the whole video."; a graphic
 * "…places Name at 0:12." A note that names nothing gets none (it is shown exactly as before).
 */
export function sentNoteLines(
  text: string,
  items: readonly PickerItem[],
  timeLabel: PlacedAt,
): string[] {
  return namedItems(text, items).map((item, index) => sentLine(item, index === 0, timeLabel));
}

/** The words that open a sent note's first line, and the ones that open every other: "Saved. The next edit " / "It also ". */
export function sentLead(first: boolean): string {
  return first ? 'Saved. The next edit ' : 'It also ';
}

/** One line of a sent note for a LUT or a graphic: "…uses Cinematic on the whole video." / "…places X at 0:12." */
export function sentLine(item: PickerItem, first: boolean, timeLabel: PlacedAt): string {
  if (item.type === 'lut') {
    return `${sentLead(first)}uses ${item.name} on the whole video.`;
  }
  const where = timeLabel === null ? 'where it fits' : `at ${timeLabel}`;
  return `${sentLead(first)}places ${item.name} ${where}.`;
}

/** A piece of a sent note: plain text, or a token that points at an item (shown as a chip). */
export type SentPart = { text: string } | { text: string; item: PickerItem };

/**
 * A sent note cut into text and chips (LU7's `splitByTokens`). A token that points at nothing (the
 * LUT was deleted, the library is off) stays text, and neighbouring text is joined, so a note with
 * no chip is one part: its own text. Joining the parts' text gives the note back.
 */
export function sentNoteParts(text: string, items: readonly PickerItem[]): SentPart[] {
  const parts: SentPart[] = [];
  for (const part of splitByTokens(text)) {
    if ('token' in part) {
      const slice = text.slice(part.token.start, part.token.end);
      const item = findItem(items, part.token);
      if (item !== undefined) {
        parts.push({ text: slice, item });
        continue;
      }
      pushText(parts, slice);
    } else {
      pushText(parts, part.text);
    }
  }
  return parts;
}

function pushText(parts: SentPart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last !== undefined && !('item' in last)) last.text += text;
  else parts.push({ text });
}
