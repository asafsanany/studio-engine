import { describe, expect, it } from 'vitest';
import { choosePill } from './pill-choice';

// One pill at a time on the video: the font preview's, then the quick fix's, then the look on the
// paused frame's.

describe('choosePill', () => {
  it('is the font pill whenever the note box names a font', () => {
    expect(choosePill({ font: true, fix: false, look: false })).toBe('font');
    expect(choosePill({ font: true, fix: true, look: false })).toBe('font');
    expect(choosePill({ font: true, fix: false, look: true })).toBe('font');
    expect(choosePill({ font: true, fix: true, look: true })).toBe('font');
  });

  it('is the fix pill next, over the look on the paused frame', () => {
    expect(choosePill({ font: false, fix: true, look: false })).toBe('fix');
    expect(choosePill({ font: false, fix: true, look: true })).toBe('fix');
  });

  it('is the look on the paused frame when it is the only one', () => {
    expect(choosePill({ font: false, fix: false, look: true })).toBe('look');
  });

  it('is none when none wants to be there', () => {
    expect(choosePill({ font: false, fix: false, look: false })).toBeNull();
  });
});
