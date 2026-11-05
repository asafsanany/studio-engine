import { describe, expect, it, vi } from 'vitest';
import {
  createPlayerKeyHandlers,
  isInOwnKeys,
  isTypingTarget,
  type PlayerShortcut,
  type PlayerShortcutTarget,
  playerShortcutFor,
  runPlayerShortcut,
  type ShortcutKeyEvent,
} from './player-shortcuts';

/** A key event as a plain object: `preventDefault` really marks it, like the browser does. */
function press(init: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  let prevented = init.defaultPrevented ?? false;
  return {
    code: '',
    key: '',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    target: null,
    ...init,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

const toggle: PlayerShortcut = { kind: 'toggle' };
const by = (seconds: number): PlayerShortcut => ({ kind: 'seekBy', seconds });

describe('playerShortcutFor', () => {
  it.each([
    ['Space', ' ', false, toggle],
    ['KeyK', 'k', false, toggle],
    ['KeyK', 'K', true, toggle],
    ['ArrowLeft', 'ArrowLeft', false, by(-5)],
    ['ArrowRight', 'ArrowRight', false, by(5)],
    ['ArrowLeft', 'ArrowLeft', true, by(-1)],
    ['ArrowRight', 'ArrowRight', true, by(1)],
    ['KeyJ', 'j', false, by(-5)],
    ['KeyL', 'l', false, by(5)],
    ['KeyJ', 'J', true, by(-5)],
    ['KeyL', 'L', true, by(5)],
    ['Comma', ',', false, by(-1)],
    ['Period', '.', false, by(1)],
    ['Comma', '<', true, by(-1)],
    ['Period', '>', true, by(1)],
    ['Home', 'Home', false, { kind: 'seekTo', seconds: 0 }],
    ['KeyM', 'm', false, { kind: 'mute' }],
    ['KeyM', 'M', true, { kind: 'mute' }],
    ['KeyF', 'f', false, { kind: 'fullscreen' }],
    ['KeyF', 'F', true, { kind: 'fullscreen' }],
  ] as const)('%s (%s, shift %s)', (code, key, shiftKey, expected) => {
    expect(playerShortcutFor(press({ code, key, shiftKey }))).toEqual(expected);
  });

  it('matches the physical key, so a Hebrew layout works too', () => {
    expect(playerShortcutFor(press({ code: 'KeyK', key: 'ל' }))).toEqual(toggle);
    expect(playerShortcutFor(press({ code: 'KeyJ', key: 'ח' }))).toEqual(by(-5));
    expect(playerShortcutFor(press({ code: 'KeyL', key: 'ך' }))).toEqual(by(5));
    expect(playerShortcutFor(press({ code: 'KeyM', key: 'צ' }))).toEqual({ kind: 'mute' });
    expect(playerShortcutFor(press({ code: 'KeyF', key: 'כ' }))).toEqual({ kind: 'fullscreen' });
    expect(playerShortcutFor(press({ code: 'Comma', key: 'ת' }))).toEqual(by(-1));
    expect(playerShortcutFor(press({ code: 'Period', key: 'ץ' }))).toEqual(by(1));
  });

  it('does not read the key when there is a code: a letter typed on another key is not ours', () => {
    expect(playerShortcutFor(press({ code: 'KeyX', key: 'k' }))).toBeNull();
  });

  it('falls back to the key only when the code is empty or Unidentified', () => {
    expect(playerShortcutFor(press({ code: '', key: 'k' }))).toEqual(toggle);
    expect(playerShortcutFor(press({ code: '', key: ' ' }))).toEqual(toggle);
    expect(playerShortcutFor(press({ code: 'Unidentified', key: 'L' }))).toEqual(by(5));
    expect(playerShortcutFor(press({ code: '', key: ',' }))).toEqual(by(-1));
    expect(playerShortcutFor(press({ code: '', key: '.' }))).toEqual(by(1));
    expect(playerShortcutFor(press({ code: '', key: 'ArrowRight', shiftKey: true }))).toEqual(
      by(1),
    );
    expect(playerShortcutFor(press({ code: '', key: 'Home' }))).toEqual({
      kind: 'seekTo',
      seconds: 0,
    });
    expect(playerShortcutFor(press({ code: '', key: 'ל' }))).toBeNull();
  });

  it('gives null when Meta, Ctrl or Alt is held', () => {
    for (const held of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(playerShortcutFor(press({ code: 'KeyK', key: 'k', [held]: true })), held).toBeNull();
      expect(playerShortcutFor(press({ code: 'ArrowLeft', [held]: true })), held).toBeNull();
    }
  });

  it('gives null for the keys that belong to others', () => {
    for (const code of [
      'Escape',
      'Enter',
      'KeyC',
      'KeyR',
      'ArrowUp',
      'ArrowDown',
      'End',
      'Tab',
      'KeyA',
      'Digit1',
    ]) {
      expect(playerShortcutFor(press({ code })), code).toBeNull();
    }
  });

  it('gives null for a press meant for a text field', () => {
    for (const target of [
      { tagName: 'TEXTAREA' },
      { tagName: 'INPUT' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      const event = press({ code: 'Space', key: ' ', target: target as unknown as EventTarget });
      expect(playerShortcutFor(event), JSON.stringify(target)).toBeNull();
    }
  });

  it('takes a press on a button or the slider', () => {
    for (const tagName of ['BUTTON', 'SPAN', 'DIV']) {
      const event = press({ code: 'ArrowLeft', target: { tagName } as unknown as EventTarget });
      expect(playerShortcutFor(event), tagName).toEqual(by(-5));
    }
  });
});

describe('isTypingTarget', () => {
  it('is true for inputs, textareas, selects and editable elements', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget('INPUT')).toBe(false);
  });
});

/** An element inside the Music list, or not: `closest` answers for the marker the list wears. */
const inside = (tagName: string, own: boolean) =>
  ({
    tagName,
    closest: (selector: string) => (own && selector === '[data-own-keys]' ? {} : null),
  }) as unknown as EventTarget;

describe('isInOwnKeys', () => {
  it('is true for something inside an element that keeps its own keys (the Music list)', () => {
    expect(isInOwnKeys(inside('BUTTON', true))).toBe(true);
  });

  it('is false for the rest, and for anything that is not an element', () => {
    expect(isInOwnKeys(inside('BUTTON', false))).toBe(false);
    expect(isInOwnKeys({ tagName: 'BUTTON' })).toBe(false);
    expect(isInOwnKeys(null)).toBe(false);
    expect(isInOwnKeys(undefined)).toBe(false);
    expect(isInOwnKeys('x')).toBe(false);
  });

  it('keeps the player’s shortcuts out of the Music list: Space and the arrows press and move there', () => {
    for (const code of ['Space', 'KeyK', 'ArrowLeft', 'ArrowRight', 'KeyM', 'KeyF', 'Home']) {
      expect(playerShortcutFor(press({ code, target: inside('BUTTON', true) })), code).toBeNull();
      expect(
        playerShortcutFor(press({ code, target: inside('BUTTON', false) })),
        code,
      ).not.toBeNull();
    }
  });

  it('lets Space on a button in the Music list click it (the key-up guard stands aside)', () => {
    const handlers = createPlayerKeyHandlers(() => fakeTarget());
    const up = press({ code: 'Space', target: inside('BUTTON', true) });
    handlers.onKeyUpCapture(up);
    expect(up.defaultPrevented).toBe(false);
    const elsewhere = press({ code: 'Space', target: inside('BUTTON', false) });
    handlers.onKeyUpCapture(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(true);
  });
});

function fakeTarget() {
  return {
    togglePlay: vi.fn(),
    seek: vi.fn(),
    seekBy: vi.fn(),
    toggleMute: vi.fn(),
    toggleFullscreen: vi.fn(),
  } satisfies PlayerShortcutTarget;
}

describe('runPlayerShortcut', () => {
  it('calls the matching method', () => {
    const target = fakeTarget();
    runPlayerShortcut(toggle, target);
    runPlayerShortcut(by(-5), target);
    runPlayerShortcut({ kind: 'seekTo', seconds: 0 }, target);
    runPlayerShortcut({ kind: 'mute' }, target);
    runPlayerShortcut({ kind: 'fullscreen' }, target);
    expect(target.togglePlay).toHaveBeenCalledOnce();
    expect(target.seekBy).toHaveBeenCalledExactlyOnceWith(-5);
    expect(target.seek).toHaveBeenCalledExactlyOnceWith(0);
    expect(target.toggleMute).toHaveBeenCalledOnce();
    expect(target.toggleFullscreen).toHaveBeenCalledOnce();
  });
});

describe('createPlayerKeyHandlers', () => {
  it('prevents the default and runs the shortcut on keydown', () => {
    const target = fakeTarget();
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => target);

    const space = press({ code: 'Space', key: ' ' });
    onKeyDownCapture(space);
    expect(space.defaultPrevented).toBe(true);
    expect(target.togglePlay).toHaveBeenCalledOnce();

    const right = press({ code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
    onKeyDownCapture(right);
    expect(right.defaultPrevented).toBe(true);
    expect(target.seekBy).toHaveBeenCalledExactlyOnceWith(1);

    onKeyDownCapture(press({ code: 'Home', key: 'Home' }));
    expect(target.seek).toHaveBeenCalledExactlyOnceWith(0);
    onKeyDownCapture(press({ code: 'KeyM', key: 'צ' }));
    expect(target.toggleMute).toHaveBeenCalledOnce();
    onKeyDownCapture(press({ code: 'KeyF', key: 'f' }));
    expect(target.toggleFullscreen).toHaveBeenCalledOnce();
  });

  it('leaves a key that is not a shortcut alone (not even prevented)', () => {
    const target = fakeTarget();
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => target);
    const esc = press({ code: 'Escape', key: 'Escape' });
    onKeyDownCapture(esc);
    expect(esc.defaultPrevented).toBe(false);
    expect(target.togglePlay).not.toHaveBeenCalled();
  });

  it('skips an event that something else already took, so two holders never act twice', () => {
    const target = fakeTarget();
    const handlers = createPlayerKeyHandlers(() => target);
    const space = press({ code: 'Space', key: ' ' });
    handlers.onKeyDownCapture(space); // the dialog
    handlers.onKeyDownCapture(space); // the player column
    expect(target.togglePlay).toHaveBeenCalledOnce();

    const taken = press({ code: 'Space', key: ' ', defaultPrevented: true });
    handlers.onKeyDownCapture(taken);
    expect(target.togglePlay).toHaveBeenCalledOnce();
  });

  it('ignores a held Space, but seeks on a held arrow', () => {
    const target = fakeTarget();
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => target);

    const space = press({ code: 'Space', key: ' ', repeat: true });
    onKeyDownCapture(space);
    expect(target.togglePlay).not.toHaveBeenCalled();
    // Still prevented, so the page does not scroll and the button is not clicked.
    expect(space.defaultPrevented).toBe(true);

    for (const code of ['KeyM', 'KeyF', 'Home', 'KeyK']) {
      onKeyDownCapture(press({ code, repeat: true }));
    }
    expect(target.toggleMute).not.toHaveBeenCalled();
    expect(target.toggleFullscreen).not.toHaveBeenCalled();
    expect(target.seek).not.toHaveBeenCalled();
    expect(target.togglePlay).not.toHaveBeenCalled();

    onKeyDownCapture(press({ code: 'ArrowRight', key: 'ArrowRight', repeat: true }));
    onKeyDownCapture(press({ code: 'ArrowRight', key: 'ArrowRight', repeat: true }));
    expect(target.seekBy).toHaveBeenCalledTimes(2);
    expect(target.seekBy).toHaveBeenLastCalledWith(5);
  });

  it('does nothing without a target (the player is not up yet), and does not prevent the key', () => {
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => null);
    const space = press({ code: 'Space', key: ' ' });
    onKeyDownCapture(space);
    expect(space.defaultPrevented).toBe(false);
  });

  it('does nothing in a text field', () => {
    const target = fakeTarget();
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => target);
    const typed = press({
      code: 'Space',
      key: ' ',
      target: { tagName: 'TEXTAREA' } as unknown as EventTarget,
    });
    onKeyDownCapture(typed);
    expect(typed.defaultPrevented).toBe(false);
    expect(target.togglePlay).not.toHaveBeenCalled();
  });

  it('reads the target when the key is pressed, not when the handlers are made', () => {
    let target: ReturnType<typeof fakeTarget> | null = null;
    const { onKeyDownCapture } = createPlayerKeyHandlers(() => target);
    onKeyDownCapture(press({ code: 'KeyK' }));
    target = fakeTarget();
    onKeyDownCapture(press({ code: 'KeyK' }));
    expect(target.togglePlay).toHaveBeenCalledOnce();
  });

  it('prevents the keyup of Space on a button (it would click it), but not on a div', () => {
    const { onKeyUpCapture } = createPlayerKeyHandlers(() => fakeTarget());

    const onButton = press({ code: 'Space', key: ' ', target: { tagName: 'BUTTON' } as never });
    onKeyUpCapture(onButton);
    expect(onButton.defaultPrevented).toBe(true);

    const onDiv = press({ code: 'Space', key: ' ', target: { tagName: 'DIV' } as never });
    onKeyUpCapture(onDiv);
    expect(onDiv.defaultPrevented).toBe(false);

    const otherKey = press({ code: 'KeyK', key: 'k', target: { tagName: 'BUTTON' } as never });
    onKeyUpCapture(otherKey);
    expect(otherKey.defaultPrevented).toBe(false);

    const noTarget = press({ code: 'Space', key: ' ', target: null });
    onKeyUpCapture(noTarget);
    expect(noTarget.defaultPrevented).toBe(false);
  });

  it('leaves the keyup of Space on a button alone while there is no player to drive', () => {
    const { onKeyUpCapture } = createPlayerKeyHandlers(() => null);
    const onButton = press({ code: 'Space', key: ' ', target: { tagName: 'BUTTON' } as never });
    onKeyUpCapture(onButton);
    expect(onButton.defaultPrevented).toBe(false);
  });
});
