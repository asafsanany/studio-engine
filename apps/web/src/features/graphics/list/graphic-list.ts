import {
  GRAPHIC_KIND_LABELS,
  GRAPHIC_MESSAGES,
  type GraphicKind,
  type GraphicSummary,
  graphicBusyMessage,
  graphicNameKey,
} from '@studio/shared';

// The Graphics list's words and the small rules behind its rows (board GRLibrary): what a row says
// about a graphic, which items its menu has and what each is allowed to do, how the search
// filters, and the counts above the list. Pure, so the tests can read them without a page.

/** The list's words, as the GRLibrary and GRStates boards say them. */
export const GRAPHICS_TEXT = {
  title: 'Graphics',
  intro: 'Ask for a graphic in a chat. Every edit can use what’s here.',
  newGraphic: 'New graphic',
  searchLabel: 'Search graphics',
  searchPlaceholder: 'Search',
  listLabel: 'Graphics',
  loading: 'Loading graphics…',
  emptyTitle: 'No graphics yet',
  emptyBody:
    'Ask for one in a chat: a title, a lower third, a number that counts up, an end card. Every edit can use what you make.',
  unreachable: 'Can’t reach the engine.',
  tryAgain: 'Try again',
  deleteBody:
    'Edits stop using it. Videos already made keep it. It goes to the Trash, so you can get it back from there.',
  cancel: 'Cancel',
  delete: 'Delete',
  deleting: 'Deleting…',
  being: 'Being made',
  failedMark: 'A version failed',
} as const;

/** "7 graphics", "1 graphic". */
export function countText(count: number): string {
  return `${count} ${count === 1 ? 'graphic' : 'graphics'}`;
}

/** How many graphics are being made. */
export function makingCount(graphics: readonly GraphicSummary[]): number {
  return graphics.filter((graphic) => graphic.status === 'making').length;
}

/** "2 being made". */
export function makingText(count: number): string {
  return `${count} being made`;
}

/**
 * The graphics whose name has `query` in it, without regard to case. A blank query leaves them all.
 * Names compare the way the engine compares them (NFC, lower case), so a Hebrew or accented name
 * is found however it was typed.
 */
export function filterGraphics(
  graphics: readonly GraphicSummary[],
  query: string,
): readonly GraphicSummary[] {
  const needle = graphicNameKey(query.trim());
  if (needle === '') return graphics;
  return graphics.filter((graphic) => graphicNameKey(graphic.name).includes(needle));
}

/** What the list's body is: waiting, unreachable, no graphics at all, none that match the search, or the rows. */
export type GraphicsBodyState = 'loading' | 'unreachable' | 'empty' | 'no-match' | 'rows';

/**
 * Which of the list's bodies to draw. `graphics` is `undefined` until the first answer; `failed`
 * is that the first answer never came (read only while there is no list: a list that is on screen
 * stays, whatever a later fetch does); `matching` is how many the search leaves.
 */
export function bodyStateOf(input: {
  graphics: readonly GraphicSummary[] | undefined;
  failed: boolean;
  matching: number;
}): GraphicsBodyState {
  if (input.graphics === undefined) return input.failed ? 'unreachable' : 'loading';
  if (input.graphics.length === 0) return 'empty';
  return input.matching === 0 ? 'no-match' : 'rows';
}

/** A length as the row says it: "3 s", "2.5 s" (one decimal at most). */
export function lengthText(lengthSec: number): string {
  return `${Number(lengthSec.toFixed(1))} s`;
}

/** How a row's detail text is coloured. */
export type DetailTone = 'quiet' | 'making' | 'failed' | 'off';

export interface GraphicDetailText {
  text: string;
  tone: DetailTone;
}

/**
 * The line after a graphic's name: "Making v1…" while it is being made, "Couldn’t finish v3" when
 * its newest run failed, otherwise "Lower third · 3 s", with " · off for edits" when edits don't
 * use it (and the whole line a shade quieter).
 */
export function graphicDetailText(graphic: GraphicSummary): GraphicDetailText {
  if (graphic.status === 'making') {
    const version = graphic.makingVersion;
    return { text: version === null ? 'Making…' : `Making v${version}…`, tone: 'making' };
  }
  if (graphic.status === 'failed') {
    const version = graphic.failedVersion;
    return {
      text: version === null ? 'Couldn’t finish' : `Couldn’t finish v${version}`,
      tone: 'failed',
    };
  }
  const kind = GRAPHIC_KIND_LABELS[graphic.kind ?? 'other'];
  const length = graphic.lengthSec === null ? '' : ` · ${lengthText(graphic.lengthSec)}`;
  const off = graphic.uses ? '' : ' · off for edits';
  return { text: `${kind}${length}${off}`, tone: graphic.uses ? 'quiet' : 'off' };
}

/** The kind a row's icon draws (`other` for a graphic that has none yet). */
export function kindOf(graphic: Pick<GraphicSummary, 'kind'>): GraphicKind {
  return graphic.kind ?? 'other';
}

/** The name of a row's icon, which is its accessible name: "Lower third". */
export function kindLabel(graphic: Pick<GraphicSummary, 'kind'>): string {
  return GRAPHIC_KIND_LABELS[kindOf(graphic)];
}

/** The version a failed row's button tries again: "Retry v3". `null` when the row has no button. */
export function retryLabel(graphic: GraphicSummary): string | null {
  if (graphic.status !== 'failed') return null;
  return graphic.failedVersion === null ? 'Retry' : `Retry v${graphic.failedVersion}`;
}

/** The entries of a row's right-click menu. */
export type GraphicMenuId = 'open' | 'rename' | 'duplicate' | 'reveal' | 'uses' | 'delete';

export interface GraphicMenuEntry {
  type: 'item';
  id: GraphicMenuId;
  label: string;
  disabled: boolean;
  /** Why it is disabled, in the engine's own words; shown as the item's tooltip. */
  disabledReason?: string;
  destructive?: boolean;
}

export interface GraphicMenuLine {
  type: 'separator';
  id: string;
}

/**
 * The right-click menu of a graphic (board GRLibrary): Open, Rename, Duplicate, Show in Finder,
 * then Turn off / on for edits, then Delete… in red, with a line between the groups. A graphic
 * that is being made can't be renamed (the engine moves its folder), and one with no version yet
 * has nothing to copy; those two items are disabled and say why in the engine's words.
 */
export function graphicMenuEntries(
  graphic: GraphicSummary,
): readonly (GraphicMenuEntry | GraphicMenuLine)[] {
  const making = graphic.status === 'making';
  const noVersion = graphic.version === null;
  return [
    { type: 'item', id: 'open', label: 'Open', disabled: false },
    {
      type: 'item',
      id: 'rename',
      label: 'Rename',
      disabled: making,
      disabledReason: making ? graphicBusyMessage(graphic.makingVersion ?? 1, 'rename') : undefined,
    },
    {
      type: 'item',
      id: 'duplicate',
      label: 'Duplicate',
      disabled: noVersion,
      disabledReason: noVersion ? GRAPHIC_MESSAGES.nothingToDuplicate : undefined,
    },
    { type: 'item', id: 'reveal', label: 'Show in Finder', disabled: false },
    { type: 'separator', id: 'line-uses' },
    {
      type: 'item',
      id: 'uses',
      label: graphic.uses ? 'Turn off for edits' : 'Turn on for edits',
      disabled: false,
    },
    { type: 'separator', id: 'line-delete' },
    { type: 'item', id: 'delete', label: 'Delete…', disabled: false, destructive: true },
  ];
}

/** Whether a deleted graphic's folder went to the Trash (and not to the engine's fallback place). */
export function wentToTrash(where: string): boolean {
  return /(^|\/)\.Trash(\/|$)/.test(where);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The time the engine last answered, on a 24-hour clock in this Mac's time zone: "10:42". */
export function heardAtLabel(heardAt: number): string {
  const heard = new Date(heardAt);
  return `${pad(heard.getHours())}:${pad(heard.getMinutes())}`;
}

/**
 * The banner above a list that has stopped being live (board GRStates 9). It says when the list
 * was last right when that is known, and that New graphic waits.
 */
export function offlineBannerText(heardAt: number | null): string {
  const asItWas =
    heardAt === null ? '' : ` This is the list as it was at ${heardAtLabel(heardAt)}.`;
  return `Can’t reach the engine on your Mac.${asItWas} New graphic waits until it’s back.`;
}
