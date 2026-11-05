import { describe, expect, it } from 'vitest';
import { PHONE_TOAST_BOTTOM, PHONE_TOAST_GUTTER, toasterPlacement } from './sonner';

describe('toasterPlacement', () => {
  it('leaves the Mac’s messages where sonner puts them (bottom right, 24 px in)', () => {
    expect(toasterPlacement(false)).toEqual({});
  });

  it('puts the phone layout’s messages in the middle at the bottom, 12 px from the sides', () => {
    const placement = toasterPlacement(true);
    expect(placement.position).toBe('bottom-center');
    expect(PHONE_TOAST_GUTTER).toBe(12);
    expect(placement.offset).toMatchObject({ left: 12, right: 12 });
    // Below 600 px sonner reads the mobile offset, above it the other: both are the same.
    expect(placement.mobileOffset).toEqual(placement.offset);
  });

  it('keeps them above the home bar: its inset and 8 px (the boards’ 42 px on an iPhone)', () => {
    // The fallback is the home bar; the tab bar raises it (index.css) while it shows.
    expect(PHONE_TOAST_BOTTOM).toBe('var(--phone-toast-bottom, calc(var(--safe-bottom) + 8px))');
    expect(toasterPlacement(true).offset).toMatchObject({ bottom: PHONE_TOAST_BOTTOM });
  });
});
