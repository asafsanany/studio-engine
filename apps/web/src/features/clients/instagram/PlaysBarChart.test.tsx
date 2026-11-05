import { describe, expect, it } from 'vitest';
import { BAR_CATEGORY_GAP, MAX_BAR_WIDTH } from './PlaysBarChart';

// The bars are laid out by recharts inside a ResponsiveContainer, which measures its card in a
// browser and draws nothing on a server (no browser DOM here), so the width itself is not measured
// by a test. It was measured on the real page (DOM check of `.recharts-bar-rectangle path`, 22 reels
// at 1440 px): 32 px bars in slots of 49.09 px, 65%, where "30%" had drawn 19 px, 39%. What is
// pinned here is the reading of the setting that went wrong.

describe('the bars of "Plays of every reel" (C94)', () => {
  it('leaves the board’s 65% of the slot to a bar: recharts’ gap is the room on each side of it', () => {
    const eachSide = Number.parseFloat(BAR_CATEGORY_GAP) / 100;
    const share = 1 - 2 * eachSide;
    expect(BAR_CATEGORY_GAP).toMatch(/%$/);
    expect(share).toBeGreaterThan(0.64);
    expect(share).toBeLessThan(0.68);
  });

  it('stops a client with few reels from getting a few huge bars, at about 40 px', () => {
    expect(MAX_BAR_WIDTH).toBeGreaterThan(32);
    expect(MAX_BAR_WIDTH).toBeLessThanOrEqual(40);
  });
});
