import { describe, expect, it } from 'vitest';
import { fullscreenActive } from './use-viewport-size';

describe('fullscreenActive', () => {
  it('is true for an element', () => {
    expect(fullscreenActive({ tagName: 'DIV' })).toBe(true);
  });

  it('is false for null: nothing is full screen', () => {
    expect(fullscreenActive(null)).toBe(false);
  });

  it('is false for undefined: Safari on iPhone has no element full screen, so the size must follow the window', () => {
    expect(fullscreenActive(undefined)).toBe(false);
  });
});
