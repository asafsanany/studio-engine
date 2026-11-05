import { describe, expect, it } from 'vitest';
import { opensSheetOnClick, ROW_CONTROLS, ROW_PANEL, type RowClick } from './row-open';

/**
 * A row that holds `inside` and, unless `outside`, the element clicked; the click lands on a control
 * `hit` (or on none).
 */
function click(
  hit: object | null,
  overrides: Partial<Omit<RowClick, 'target' | 'row'>> & {
    inside?: object[];
    outside?: boolean;
  } = {},
): RowClick {
  const { inside = [], outside = false, ...rest } = overrides;
  const target = { closest: () => hit };
  return {
    target,
    row: {
      contains: (other: unknown) =>
        (other === target && !outside) || inside.includes(other as object),
    },
    button: 0,
    ctrlKey: false,
    selectedText: '',
    ...rest,
  };
}

describe('opensSheetOnClick', () => {
  it('opens on a click on the row’s plain parts: its name, its status icon, its empty space', () => {
    expect(opensSheetOnClick(click(null))).toBe(true);
  });

  it('does not open on a control of the row: the client’s link, a button, the Action cell', () => {
    const control = {};
    expect(opensSheetOnClick(click(control, { inside: [control] }))).toBe(false);
  });

  it('opens when the control found is not in the row (one around it is not the row’s)', () => {
    expect(opensSheetOnClick(click({}, { inside: [] }))).toBe(true);
  });

  it('does not open on a click that only passes through the row: one in a menu its panel drew outside it', () => {
    expect(opensSheetOnClick(click(null, { outside: true }))).toBe(false);
  });

  it('does not open on any button but the main one, or on Ctrl and click (a right-click on a Mac)', () => {
    expect(opensSheetOnClick(click(null, { button: 2 }))).toBe(false);
    expect(opensSheetOnClick(click(null, { button: 1 }))).toBe(false);
    expect(opensSheetOnClick(click(null, { ctrlKey: true }))).toBe(false);
  });

  it('does not open when the person has just selected some text', () => {
    expect(opensSheetOnClick(click(null, { selectedText: 'Coach intro' }))).toBe(false);
  });

  it('opens when the click has no target element', () => {
    expect(opensSheetOnClick({ ...click(null), target: null })).toBe(true);
  });
});

describe('ROW_CONTROLS', () => {
  it('covers links, buttons, the Action cell, the marks that show a tooltip and the open job’s panel', () => {
    const parts = ROW_CONTROLS.split(',').map((part) => part.trim());
    for (const selector of [
      'a',
      'button',
      '[data-row-actions]',
      '[role="img"][tabindex]',
      ROW_PANEL,
    ]) {
      expect(parts, selector).toContain(selector);
    }
  });

  it('does not cover the status icon, an image with no focus of its own', () => {
    expect(ROW_CONTROLS).not.toMatch(/(^|,\s*)\[role="img"\](,|$)/);
  });
});
