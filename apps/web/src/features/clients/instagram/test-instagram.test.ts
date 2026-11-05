import { clientInstagramSchema, INSTAGRAM_RANGES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { falconInstagram, falconNumbers, falconReels } from './test-instagram';

describe("Falcon FPV's page, the board's sample", () => {
  it.each(INSTAGRAM_RANGES)('is a valid Instagram answer for the %s range', (range) => {
    expect(clientInstagramSchema.safeParse(falconInstagram(range)).success).toBe(true);
  });

  it('has 22 reels in the last 90 days, 7 of them ours, as the board says', () => {
    const numbers = falconNumbers('90');
    expect(numbers.plays).toHaveLength(22);
    expect(numbers.plays.filter((point) => point.ours)).toHaveLength(7);
    expect(falconReels()).toHaveLength(22);
  });

  it('has the board’s typical reels: ours 18.4K, theirs 5.1K', () => {
    const { playsPerReel } = falconNumbers('since').tiles;
    expect(playsPerReel.ours).toBe(18_400);
    expect(playsPerReel.theirs).toBe(5_100);
  });

  it('counts only the last 30 days in that range', () => {
    expect(falconNumbers('30').plays).toHaveLength(10);
  });
});
