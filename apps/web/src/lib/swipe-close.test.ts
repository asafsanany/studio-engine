import { describe, expect, it } from 'vitest';
import {
  SWIPE_CLOSE_DISTANCE_PX,
  SWIPE_FLICK_DISTANCE_PX,
  SWIPE_START_PX,
  swipeIntent,
  swipeOffset,
  swipeShouldClose,
} from './swipe-close';

describe('swipeShouldClose', () => {
  it('closes after a long swipe down, however slow', () => {
    expect(swipeShouldClose({ dy: SWIPE_CLOSE_DISTANCE_PX, ms: 5_000 })).toBe(true);
    expect(swipeShouldClose({ dy: 400, ms: 3_000 })).toBe(true);
  });

  it('springs back after a short, slow swipe', () => {
    expect(swipeShouldClose({ dy: SWIPE_CLOSE_DISTANCE_PX - 1, ms: 1_000 })).toBe(false);
    expect(swipeShouldClose({ dy: 40, ms: 400 })).toBe(false);
  });

  it('closes after a quick flick that has gone only a little way', () => {
    expect(swipeShouldClose({ dy: 40, ms: 60 })).toBe(true);
    expect(swipeShouldClose({ dy: SWIPE_FLICK_DISTANCE_PX, ms: 40 })).toBe(true);
  });

  it('does not count a tap, a twitch or a flick that has hardly moved', () => {
    expect(swipeShouldClose({ dy: 0, ms: 0 })).toBe(false);
    expect(swipeShouldClose({ dy: 5, ms: 5 })).toBe(false);
    expect(swipeShouldClose({ dy: SWIPE_FLICK_DISTANCE_PX - 1, ms: 10 })).toBe(false);
  });

  it('never closes on a swipe up', () => {
    expect(swipeShouldClose({ dy: -200, ms: 50 })).toBe(false);
  });

  it('copes with a zero duration (two events in the same tick)', () => {
    expect(swipeShouldClose({ dy: 30, ms: 0 })).toBe(false);
    expect(swipeShouldClose({ dy: 120, ms: 0 })).toBe(true);
  });
});

describe('swipeOffset', () => {
  it('follows the finger down and stays put on the way up', () => {
    expect(swipeOffset(37)).toBe(37);
    expect(swipeOffset(0)).toBe(0);
    expect(swipeOffset(-80)).toBe(0);
  });
});

describe('swipeIntent: a touch on the sheet’s body', () => {
  it('waits until the finger has moved a few pixels, so a tap stays a tap', () => {
    expect(swipeIntent({ dx: 0, dy: SWIPE_START_PX - 1, atTop: true })).toBe('pending');
    expect(swipeIntent({ dx: 3, dy: 3, atTop: true })).toBe('pending');
  });

  it('drags the sheet when it goes down, more down than sideways, with nothing scrolled down', () => {
    expect(swipeIntent({ dx: 0, dy: 12, atTop: true })).toBe('drag');
    expect(swipeIntent({ dx: 5, dy: 12, atTop: true })).toBe('drag');
  });

  it('scrolls instead when the list under the finger is scrolled down', () => {
    expect(swipeIntent({ dx: 0, dy: 40, atTop: false })).toBe('scroll');
  });

  it('scrolls when the finger goes up or sideways', () => {
    expect(swipeIntent({ dx: 0, dy: -20, atTop: true })).toBe('scroll');
    expect(swipeIntent({ dx: 30, dy: 10, atTop: true })).toBe('scroll');
  });
});
