import { describe, expect, it } from 'vitest';
import { isContextMenuKey, keyboardMenuPoint } from './row-menu-key';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  bottom: top + height,
});

describe('isContextMenuKey', () => {
  it('is Shift+F10 and the menu key', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: true })).toBe(true);
  });

  it('is nothing else: F10 alone, Shift with another key, Enter', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: 'F9', shiftKey: true })).toBe(false);
    expect(isContextMenuKey({ key: 'Enter', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: 'Tab', shiftKey: true })).toBe(false);
  });
});

describe('keyboardMenuPoint', () => {
  const row = box(100, 200, 1000, 65);

  it('opens under the left edge of the focused control', () => {
    expect(keyboardMenuPoint(row, box(740, 220, 24, 24))).toEqual({ x: 740, y: 244 });
  });

  it('opens near the left edge of the row, halfway down it, when the row itself is focused', () => {
    expect(keyboardMenuPoint(row, null)).toEqual({ x: 148, y: 232.5 });
  });
});
