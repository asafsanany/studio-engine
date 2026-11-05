import { describe, expect, it } from 'vitest';
import { type PickerKeyEvent, pickerKeyAction } from './picker-keys';

function press(key: string, extra: Partial<PickerKeyEvent> = {}): PickerKeyEvent {
  return { key, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...extra };
}

describe('pickerKeyAction', () => {
  it('moves with the arrows', () => {
    expect(pickerKeyAction(press('ArrowDown'), 5)).toBe('next');
    expect(pickerKeyAction(press('ArrowUp'), 5)).toBe('prev');
  });

  it('inserts with Enter or Tab', () => {
    expect(pickerKeyAction(press('Enter'), 5)).toBe('insert');
    expect(pickerKeyAction(press('Tab'), 5)).toBe('insert');
  });

  it('closes with Esc, with or without rows', () => {
    expect(pickerKeyAction(press('Escape'), 5)).toBe('close');
    expect(pickerKeyAction(press('Escape'), 0)).toBe('close');
  });

  it('leaves Shift+Enter (a new line) and Shift+Tab (the focus going back) alone', () => {
    expect(pickerKeyAction(press('Enter', { shiftKey: true }), 5)).toBeNull();
    expect(pickerKeyAction(press('Tab', { shiftKey: true }), 5)).toBeNull();
  });

  it('leaves Cmd/Ctrl+Enter to post the note', () => {
    expect(pickerKeyAction(press('Enter', { metaKey: true }), 5)).toBeNull();
    expect(pickerKeyAction(press('Enter', { ctrlKey: true }), 5)).toBeNull();
  });

  it('takes nothing but Esc when no row is there (the "no match" panel)', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab']) {
      expect(pickerKeyAction(press(key), 0), key).toBeNull();
    }
  });

  it('leaves every key of an IME composition to the composition, Esc included', () => {
    for (const key of ['ArrowDown', 'Enter', 'Escape', 'Tab']) {
      expect(pickerKeyAction(press(key, { isComposing: true }), 5), key).toBeNull();
    }
  });

  it('leaves the other keys to the box', () => {
    for (const key of ['a', ' ', 'Backspace', 'ArrowLeft', '@']) {
      expect(pickerKeyAction(press(key), 5), key).toBeNull();
    }
  });
});
