import { type RefObject, useMemo } from 'react';

// The review player's keyboard shortcuts (spec: Phase 3 architecture §8):
//   Space or K: play/pause · ← → or J L: 5 s · Shift+← → or , and .: 1 s · Home: the start ·
//   M: mute · F: full screen.
// Esc is not here: W8's dialog owns it (and the browser leaves full screen by itself).

/** What the shortcuts drive. The player's imperative handle has all of it. */
export interface PlayerShortcutTarget {
  togglePlay(): void;
  seek(seconds: number): void;
  seekBy(deltaSeconds: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
}

export type PlayerShortcut =
  | { kind: 'toggle' }
  | { kind: 'seekBy'; seconds: number }
  | { kind: 'seekTo'; seconds: number }
  | { kind: 'mute' }
  | { kind: 'fullscreen' };

/** The part of a keyboard event the shortcuts read (a DOM or a React one, or a plain object). */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  | 'code'
  | 'key'
  | 'shiftKey'
  | 'altKey'
  | 'ctrlKey'
  | 'metaKey'
  | 'repeat'
  | 'defaultPrevented'
  | 'target'
> & { preventDefault(): void };

const LONG_STEP_SEC = 5;
const SHORT_STEP_SEC = 1;

/**
 * True when the key press is meant for a text field: an input, a textarea, a select or an
 * editable element. Duck-typed, so a test can pass plain objects.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const { tagName, isContentEditable } = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    isContentEditable === true
  );
}

/**
 * True when the key press is inside something that keeps its own keys while it is over the player
 * (an element marked `data-own-keys`: the Music list, in a popover that is a React child of the
 * dialog, so its key events reach the dialog's handlers first). Space presses a row there, not
 * play/pause. Duck-typed like `isTypingTarget`.
 */
export function isInOwnKeys(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const { closest } = target as { closest?: unknown };
  return typeof closest === 'function' && (target as Element).closest('[data-own-keys]') !== null;
}

/** `event.key` to the `event.code` of the same key, for events that carry no code. */
const CODE_FOR_KEY: ReadonlyMap<string, string> = new Map([
  [' ', 'Space'],
  ['k', 'KeyK'],
  ['j', 'KeyJ'],
  ['l', 'KeyL'],
  ['m', 'KeyM'],
  ['f', 'KeyF'],
  [',', 'Comma'],
  ['<', 'Comma'],
  ['.', 'Period'],
  ['>', 'Period'],
]);

/**
 * The physical key: `event.code`, so a shortcut works with any keyboard layout (K types "ל" on a
 * Hebrew one). Only an event without a code (`''` or `'Unidentified'`) falls back to `event.key`.
 */
function physicalKey(event: Pick<ShortcutKeyEvent, 'code' | 'key'>): string {
  if (event.code !== '' && event.code !== 'Unidentified') return event.code;
  return CODE_FOR_KEY.get(event.key.toLowerCase()) ?? event.key;
}

/**
 * The shortcut a key press stands for, or `null`. Meta, Ctrl and Alt always give `null` (browser
 * and OS shortcuts), and so does a press meant for a text field or for the Music list (`isInOwnKeys`). Shift only changes the arrows
 * (1 s instead of 5 s); every other key works with or without it. Keys that belong to others
 * (Escape, Enter, C, R, ArrowUp, ArrowDown, End, Tab, ...) give `null` too.
 */
export function playerShortcutFor(event: ShortcutKeyEvent): PlayerShortcut | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isInOwnKeys(event.target)) return null;

  switch (physicalKey(event)) {
    case 'Space':
    case 'KeyK':
      return { kind: 'toggle' };
    case 'ArrowLeft':
      return { kind: 'seekBy', seconds: event.shiftKey ? -SHORT_STEP_SEC : -LONG_STEP_SEC };
    case 'ArrowRight':
      return { kind: 'seekBy', seconds: event.shiftKey ? SHORT_STEP_SEC : LONG_STEP_SEC };
    case 'KeyJ':
      return { kind: 'seekBy', seconds: -LONG_STEP_SEC };
    case 'KeyL':
      return { kind: 'seekBy', seconds: LONG_STEP_SEC };
    case 'Comma':
      return { kind: 'seekBy', seconds: -SHORT_STEP_SEC };
    case 'Period':
      return { kind: 'seekBy', seconds: SHORT_STEP_SEC };
    case 'Home':
      return { kind: 'seekTo', seconds: 0 };
    case 'KeyM':
      return { kind: 'mute' };
    case 'KeyF':
      return { kind: 'fullscreen' };
    default:
      return null;
  }
}

export function runPlayerShortcut(shortcut: PlayerShortcut, target: PlayerShortcutTarget): void {
  switch (shortcut.kind) {
    case 'toggle':
      target.togglePlay();
      break;
    case 'seekBy':
      target.seekBy(shortcut.seconds);
      break;
    case 'seekTo':
      target.seek(shortcut.seconds);
      break;
    case 'mute':
      target.toggleMute();
      break;
    case 'fullscreen':
      target.toggleFullscreen();
      break;
  }
}

export interface PlayerKeyHandlers {
  onKeyDownCapture(event: ShortcutKeyEvent): void;
  onKeyUpCapture(event: ShortcutKeyEvent): void;
}

/**
 * The two key handlers to spread on the element that holds focus (the player column, and W8's
 * dialog). They are for the capture phase, and they call `preventDefault()` on every key they take,
 * because that is how they keep others out: the page does not scroll, Space does not also click a
 * focused button, and the Radix slider (which composes its own handlers after ours and skips them
 * when the event is default-prevented) does not step by 0.01 on ←, → and Home.
 *
 * A handled key is marked as prevented, so a second element carrying the same handlers (the player
 * column inside the dialog) does not act twice. `getTarget` returns `null` before the player is up.
 */
export function createPlayerKeyHandlers(
  getTarget: () => PlayerShortcutTarget | null,
): PlayerKeyHandlers {
  return {
    onKeyDownCapture(event) {
      if (event.defaultPrevented) return;
      const target = getTarget();
      if (target === null) return;
      const shortcut = playerShortcutFor(event);
      if (shortcut === null) return;
      event.preventDefault();
      // Holding a key repeats it: that is wanted for seeking, never for toggles.
      if (event.repeat && shortcut.kind !== 'seekBy') return;
      runPlayerShortcut(shortcut, target);
    },
    onKeyUpCapture(event) {
      // Releasing Space over a button clicks it: a second guard against a double toggle. Only
      // while there is a player to drive; before that Space is left to press the button.
      if (getTarget() === null || isInOwnKeys(event.target)) return;
      const { tagName } = (event.target ?? {}) as { tagName?: unknown };
      if (tagName === 'BUTTON' && physicalKey(event) === 'Space') event.preventDefault();
    },
  };
}

/** {@link createPlayerKeyHandlers} on a ref, made once. Spread the result on a focusable element. */
export function usePlayerShortcuts(
  playerRef: RefObject<PlayerShortcutTarget | null>,
): PlayerKeyHandlers {
  return useMemo(() => createPlayerKeyHandlers(() => playerRef.current), [playerRef]);
}
