import { describe, expect, it, vi } from 'vitest';
import { ignoreMessageTaps, PHONE_SHEET_CLASSES } from './phone-sheet-shell';

/** A stand-in for the element a tap landed on: it answers `closest` for the selectors it is inside. */
const insideOf = (...selectors: string[]) => ({
  closest: (selector: string) => (selectors.includes(selector) ? {} : null),
});

describe('ignoreMessageTaps', () => {
  it('keeps the sheet open for a tap inside sonner’s toaster (a message’s Undo)', () => {
    const preventDefault = vi.fn();
    ignoreMessageTaps({ target: insideOf('[data-sonner-toaster]') as never, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('lets any other tap through, so the dimmed page still closes the sheet', () => {
    const preventDefault = vi.fn();
    ignoreMessageTaps({ target: insideOf() as never, preventDefault });
    ignoreMessageTaps({ target: null, preventDefault });
    ignoreMessageTaps({ target: {} as never, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('PHONE_SHEET_CLASSES', () => {
  it('is the boards’ sheet: 790 px at most, a 16 px top radius, room for the home indicator', () => {
    expect(PHONE_SHEET_CLASSES).toContain('max-h-[min(790px,calc(100dvh-54px))]');
    expect(PHONE_SHEET_CLASSES).toContain('rounded-t-2xl');
    expect(PHONE_SHEET_CLASSES).toContain('pb-[max(34px,var(--safe-bottom))]');
  });
});
