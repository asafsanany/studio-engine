import { isInOwnKeys, isTypingTarget, type ShortcutKeyEvent } from './player-shortcuts';

// The review dialog's own keys (the player's are in player-shortcuts.ts): Esc, C and R.

/** How long after full screen ended an Esc still counts as the one that ended it (some browsers deliver it). */
export const FULLSCREEN_ESC_GRACE_MS = 500;

export interface ReviewEscapeContext {
  /** Focus is in a text field (the note box). */
  typing: boolean;
  /** A voice note is starting or recording (W11). */
  recording: boolean;
  /** Full screen is on, or ended a moment ago (`escapeIsForFullscreen`). */
  fullscreen: boolean;
}

export type ReviewEscapeStep = 'leave-note-box' | 'cancel-recording' | 'exit-fullscreen' | 'close';

/**
 * Whether the element is the note box with the @ picker open (the box marks itself with
 * `data-picker="open"`). Esc then belongs to the picker, which closes alone: the dialog neither
 * leaves the box nor closes.
 */
export function escapeIsForPicker(element: Pick<Element, 'getAttribute'> | null): boolean {
  return element?.getAttribute('data-picker') === 'open';
}

/** Esc, in the spec's order: leave the note box, then cancel a recording, then full screen, then close. */
export function reviewEscapeStep({
  typing,
  recording,
  fullscreen,
}: ReviewEscapeContext): ReviewEscapeStep {
  if (typing) return 'leave-note-box';
  if (recording) return 'cancel-recording';
  if (fullscreen) return 'exit-fullscreen';
  return 'close';
}

/**
 * Whether an Esc now belongs to full screen: an element is full screen, or it ended under
 * `FULLSCREEN_ESC_GRACE_MS` ago (the browser leaves full screen itself, and some also deliver the
 * keydown afterwards, when `fullscreenElement` is already null).
 */
export function escapeIsForFullscreen(
  fullscreenElement: unknown,
  lastExitAt: number | null,
  now: number,
): boolean {
  if (fullscreenElement !== null && fullscreenElement !== undefined) return true;
  return lastExitAt !== null && now - lastExitAt < FULLSCREEN_ESC_GRACE_MS;
}

/** The dialog's own keys (the player's are W9's): C writes a note (W10), R records or stops (W11). */
export type ReviewShortcut = 'focus-composer' | 'toggle-recording';

const SHORTCUT_BY_CODE: Readonly<Record<string, ReviewShortcut>> = {
  KeyC: 'focus-composer',
  KeyR: 'toggle-recording',
};

const SHORTCUT_BY_KEY: Readonly<Record<string, ReviewShortcut>> = {
  c: 'focus-composer',
  r: 'toggle-recording',
};

/**
 * The dialog shortcut a key press stands for, or `null`. `null` for a press meant for a text field,
 * with Meta, Ctrl or Alt held (browser and OS shortcuts), repeating, or already taken. It reads the
 * physical key (`event.code`), so it works with the Hebrew layout (C types ב, R types ר), and falls
 * back to `event.key` only for an event without a code. Shift does not matter.
 */
export function reviewShortcutFor(event: ShortcutKeyEvent): ReviewShortcut | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isInOwnKeys(event.target)) return null;
  if (event.code !== '' && event.code !== 'Unidentified')
    return SHORTCUT_BY_CODE[event.code] ?? null;
  return SHORTCUT_BY_KEY[event.key.toLowerCase()] ?? null;
}
