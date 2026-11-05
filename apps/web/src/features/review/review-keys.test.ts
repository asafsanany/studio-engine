import { describe, expect, it } from 'vitest';
import type { ShortcutKeyEvent } from './player-shortcuts';
import {
  escapeIsForFullscreen,
  escapeIsForPicker,
  FULLSCREEN_ESC_GRACE_MS,
  reviewEscapeStep,
  reviewShortcutFor,
} from './review-keys';

describe('reviewEscapeStep: the order of Esc', () => {
  it.each([
    [false, false, false, 'close'],
    [false, false, true, 'exit-fullscreen'],
    [false, true, false, 'cancel-recording'],
    [false, true, true, 'cancel-recording'],
    [true, false, false, 'leave-note-box'],
    [true, false, true, 'leave-note-box'],
    [true, true, false, 'leave-note-box'],
    [true, true, true, 'leave-note-box'],
  ] as const)(
    'typing %s, recording %s, full screen %s: %s',
    (typing, recording, fullscreen, step) => {
      expect(reviewEscapeStep({ typing, recording, fullscreen })).toBe(step);
    },
  );
});

describe('escapeIsForFullscreen', () => {
  const now = 1_000_000;

  it('is true while an element is full screen', () => {
    expect(escapeIsForFullscreen({}, null, now)).toBe(true);
    expect(escapeIsForFullscreen({}, now - 60_000, now)).toBe(true);
  });

  it('is true for an Esc shortly after full screen ended (some browsers deliver it)', () => {
    expect(escapeIsForFullscreen(null, now - 100, now)).toBe(true);
    expect(escapeIsForFullscreen(null, now - (FULLSCREEN_ESC_GRACE_MS - 1), now)).toBe(true);
  });

  it('is false once the grace period has passed', () => {
    expect(escapeIsForFullscreen(null, now - 600, now)).toBe(false);
    expect(escapeIsForFullscreen(null, now - FULLSCREEN_ESC_GRACE_MS, now)).toBe(false);
  });

  it('is false when full screen never happened', () => {
    expect(escapeIsForFullscreen(null, null, now)).toBe(false);
    expect(escapeIsForFullscreen(undefined, null, now)).toBe(false);
  });

  it('gives half a second of grace', () => {
    expect(FULLSCREEN_ESC_GRACE_MS).toBe(500);
  });
});

describe('reviewShortcutFor', () => {
  function key(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
    return {
      code: '',
      key: '',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      defaultPrevented: false,
      target: { tagName: 'DIV' } as unknown as EventTarget,
      preventDefault: () => {},
      ...overrides,
    };
  }

  it('maps C to the composer and R to the recorder, by physical key', () => {
    expect(reviewShortcutFor(key({ code: 'KeyC', key: 'c' }))).toBe('focus-composer');
    expect(reviewShortcutFor(key({ code: 'KeyR', key: 'r' }))).toBe('toggle-recording');
  });

  it('works with the Hebrew layout, where C types ב and R types ר', () => {
    expect(reviewShortcutFor(key({ code: 'KeyC', key: 'ב' }))).toBe('focus-composer');
    expect(reviewShortcutFor(key({ code: 'KeyR', key: 'ר' }))).toBe('toggle-recording');
  });

  it('falls back to the typed key only when the event carries no code', () => {
    expect(reviewShortcutFor(key({ code: '', key: 'c' }))).toBe('focus-composer');
    expect(reviewShortcutFor(key({ code: 'Unidentified', key: 'R' }))).toBe('toggle-recording');
    // A code that names another key wins over the character it typed.
    expect(reviewShortcutFor(key({ code: 'KeyV', key: 'c' }))).toBeNull();
  });

  it('does not mind Shift', () => {
    expect(reviewShortcutFor(key({ code: 'KeyC', key: 'C', shiftKey: true }))).toBe(
      'focus-composer',
    );
    expect(reviewShortcutFor(key({ code: 'KeyR', key: 'R', shiftKey: true }))).toBe(
      'toggle-recording',
    );
  });

  it.each([
    ['Meta', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['a held key (repeat)', { repeat: true }],
    ['an event somebody already took', { defaultPrevented: true }],
    ['a text box', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget }],
    ['an input', { target: { tagName: 'INPUT' } as unknown as EventTarget }],
  ] as const)('is null with %s', (_label, overrides) => {
    expect(reviewShortcutFor(key({ code: 'KeyC', key: 'c', ...overrides }))).toBeNull();
    expect(reviewShortcutFor(key({ code: 'KeyR', key: 'r', ...overrides }))).toBeNull();
  });

  it('is null for other keys, the player’s included', () => {
    for (const code of ['Space', 'KeyK', 'KeyF', 'KeyM', 'ArrowLeft', 'Escape', 'Enter', 'Tab']) {
      expect(reviewShortcutFor(key({ code, key: code })), code).toBeNull();
    }
  });
});

describe('reviewShortcutFor in the Music list', () => {
  const press = (target: unknown): ShortcutKeyEvent =>
    ({
      code: 'KeyC',
      key: 'c',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      defaultPrevented: false,
      target,
      preventDefault() {},
    }) as unknown as ShortcutKeyEvent;
  const element = (own: boolean) => ({
    tagName: 'BUTTON',
    closest: (selector: string) => (own && selector === '[data-own-keys]' ? {} : null),
  });

  it('leaves C and R to the list: nothing focuses the composer or starts a recording from there', () => {
    expect(reviewShortcutFor(press(element(true)))).toBeNull();
    expect(reviewShortcutFor(press(element(false)))).toBe('focus-composer');
  });
});

describe('escapeIsForPicker: Esc belongs to the @ picker while the note box shows it open', () => {
  const element = (value: string | null) => ({
    getAttribute: (name: string) => (name === 'data-picker' ? value : null),
  });

  it('is true on a box marked open', () => {
    expect(escapeIsForPicker(element('open'))).toBe(true);
  });

  it('is false on a box without the mark, on another element and on nothing', () => {
    expect(escapeIsForPicker(element(null))).toBe(false);
    expect(escapeIsForPicker(element('closed'))).toBe(false);
    expect(escapeIsForPicker(null)).toBe(false);
  });
});
