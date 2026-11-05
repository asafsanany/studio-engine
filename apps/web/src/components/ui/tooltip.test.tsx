import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipTrigger } from './tooltip';

type Props = { 'data-slot': string; onFocus: (event: unknown) => void };

/** The element a TooltipTrigger renders, to call its onFocus (no hooks inside). */
function trigger(props: Record<string, unknown> = {}): ReactElement<Props> {
  return TooltipTrigger(props as never) as ReactElement<Props>;
}

/**
 * A focus event on a trigger. `focusVisible` is what the browser says about it: true for the focus
 * a key press gives (Tab), false for the focus a script hands back after a pointer close (a dialog
 * closed with the mouse gives the row's button its focus back).
 */
function focusEvent(focusVisible: boolean) {
  return {
    currentTarget: {
      matches: vi.fn((selector: string) => selector === ':focus-visible' && focusVisible),
    },
    preventDefault: vi.fn(),
  };
}

// Radix opens the tooltip in its own onFocus, which it skips when the caller's onFocus has
// prevented the event. The real thing (a dialog closed with the pointer, then Tab) is checked in a
// browser by e2e/smoke.spec.ts.
describe('<TooltipTrigger> focus', () => {
  it('lets the tooltip open on keyboard focus (:focus-visible)', () => {
    const event = focusEvent(true);
    trigger().props.onFocus(event);
    expect(event.currentTarget.matches).toHaveBeenCalledWith(':focus-visible');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps it closed on focus that is not :focus-visible, such as a dialog giving focus back after a pointer close', () => {
    const event = focusEvent(false);
    trigger().props.onFocus(event);
    expect(event.currentTarget.matches).toHaveBeenCalledWith(':focus-visible');
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('still calls the onFocus it was given, whichever kind of focus it is', () => {
    for (const focusVisible of [true, false]) {
      const given = vi.fn();
      const event = focusEvent(focusVisible);
      trigger({ onFocus: given }).props.onFocus(event);
      expect(given).toHaveBeenCalledOnce();
      expect(given).toHaveBeenCalledWith(event);
    }
  });

  it('marks itself as a tooltip trigger and leaves hover to Radix', () => {
    const { props } = trigger();
    expect(props['data-slot']).toBe('tooltip-trigger');
    // Hover (pointer move, with its 300 ms delay) is Radix's own; only focus is taken over here.
    expect(props).not.toHaveProperty('onPointerMove');
    expect(props).not.toHaveProperty('onPointerEnter');
  });
});
