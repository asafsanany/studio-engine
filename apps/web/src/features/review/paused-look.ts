// The look on the paused frame in Review (LUTs plan, "The look on the paused frame"; board LUReview,
// states chip and sent): which LUT a note box names, what the pill says, and when the still shows.
// Plain functions, so the tests need no browser.
//
//   note box: "Make it @luts/cinematic and @luts/film-contrast"   video paused at 0:12
//     ─▶ the last LUT named that the picker knows (a Look or a Fix): film-contrast, "the last of 2"
//     ─▶ GET /api/jobs/:id/review/frame?t=12&lut=film-contrast   (and the plain frame, for Compare)

import { parseLibraryTokens } from '@studio/shared';
import type { PickerItem } from '@/features/library-picker/picker-items';

/** The LUT to show on the paused frame. */
export interface PausedLookTarget {
  slug: string;
  /** `luts/cinematic`, as written in the note without the `@`. */
  token: string;
  /** How many different LUTs the note names that can be shown (one is previewed, the last). */
  count: number;
}

/**
 * The LUT the paused frame shows: the last one the note names, among the ones the picker offers (a
 * Camera LUT is never offered, and a name that points at nothing is not an item, so neither gets a
 * still or a pill). `null` when the note names none.
 */
export function pausedLookTarget(
  text: string,
  items: readonly PickerItem[],
): PausedLookTarget | null {
  const named: string[] = [];
  for (const token of parseLibraryTokens(text)) {
    if (token.library !== 'luts') continue;
    const item = items.find((it) => it.type === 'lut' && it.slug === token.slug);
    if (item === undefined) continue;
    named.push(item.slug);
  }
  const last = named[named.length - 1];
  if (last === undefined) return null;
  return { slug: last, token: `luts/${last}`, count: new Set(named).size };
}

/** The pill's words: "Previewing luts/cinematic", or "Previewing the last of 2" for several. */
export function pausedLookPill(target: Pick<PausedLookTarget, 'token' | 'count'>): string {
  return target.count > 1 ? `Previewing the last of ${target.count}` : `Previewing ${target.token}`;
}

/** The words of the still's controls. */
export const PAUSED_LOOK_TEXT = {
  compare: 'Compare',
  compareTip: 'Hold to see the original',
  frameAlt: (time: string) => `Frame from the video at ${time}`,
} as const;

/**
 * What a key does to the Compare button: Space and Enter hold the plain frame while they are down
 * (`true`) and give it back when they come up (`false`); any other key is not Compare's (`null`).
 */
export function compareKeyAction(key: string, phase: 'down' | 'up'): boolean | null {
  if (key !== ' ' && key !== 'Enter') return null;
  return phase === 'down';
}

/** The moment in tenths of a second: what the server rounds to, so equal tenths are the same frame. */
export function tenthsOf(seconds: number): number {
  return Math.max(0, Math.round(seconds * 10));
}

/** How long the playhead must stand still before a frame is asked for (a drag asks for none). */
export const PAUSED_LOOK_SETTLE_MS = 150;

/** After this long without the still, a skeleton shows where the pill will be. */
export const PAUSED_LOOK_SKELETON_MS = 250;

export interface PausedLookState {
  /** The switch: notes can name LUTs (`lutsInEdits`). */
  enabled: boolean;
  /** The player is up (it has said its length). */
  ready: boolean;
  playing: boolean;
  /** A voice note is being recorded or added: the box the LUT is named in is not there. */
  busy: boolean;
  target: PausedLookTarget | null;
  /** The playhead, in tenths of a second, and the one the playhead has stood on for a moment. */
  tenths: number;
  settledTenths: number | null;
}

/**
 * Whether the still shows: a LUT is named, the video is paused on a frame the playhead has stopped
 * on (playing, seeking and dragging hide it), and nothing else has the note box's place.
 */
export function pausedLookShows(state: PausedLookState): boolean {
  return (
    state.enabled &&
    state.ready &&
    !state.playing &&
    !state.busy &&
    state.target !== null &&
    state.settledTenths === state.tenths
  );
}
