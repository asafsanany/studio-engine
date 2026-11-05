import { describe, expect, it } from 'vitest';
import {
  compactText,
  countText,
  dayText,
  instantDayText,
  localDay,
  monthText,
  playsText,
  rangeWords,
  reelsText,
  sentenceCase,
  shortDayText,
  signedText,
  timesText,
} from './instagram-text';

const ZONE = { timeZone: 'Asia/Jerusalem', now: Date.parse('2026-10-28T10:00:00.000Z') };

describe('numbers', () => {
  it('writes a count with a thousands separator', () => {
    expect(countText(12480)).toBe('12,480');
    expect(countText(940)).toBe('940');
    expect(countText(1_234_567.4)).toBe('1,234,567');
  });

  it('writes plays with their word, the short way', () => {
    expect(playsText(27_500)).toBe('27.5K plays');
    expect(playsText(980)).toBe('980 plays');
    expect(playsText(1_240_000)).toBe('1.2M plays');
    expect(playsText(1)).toBe('1 play');
    expect(playsText(0)).toBe('0 plays');
  });

  it('writes plays and likes the short way', () => {
    expect(compactText(0)).toBe('0');
    expect(compactText(980)).toBe('980');
    expect(compactText(18_400)).toBe('18.4K');
    expect(compactText(5_000)).toBe('5K');
    expect(compactText(99_950)).toBe('100K');
    expect(compactText(410_000)).toBe('410K');
    expect(compactText(999_600)).toBe('1M');
    expect(compactText(1_240_000)).toBe('1.2M');
  });

  it('writes a change with its sign, a drop with the minus sign', () => {
    expect(signedText(312)).toBe('+312');
    expect(signedText(1930)).toBe('+1,930');
    expect(signedText(-42)).toBe('−42');
    expect(signedText(0)).toBe('0');
  });

  it('writes a multiple to one decimal, and whole from ten up', () => {
    expect(timesText(3.607)).toBe('3.6×');
    expect(timesText(0.8)).toBe('0.8×');
    expect(timesText(1)).toBe('1.0×');
    expect(timesText(12.4)).toBe('12×');
  });

  it('counts reels', () => {
    expect(reelsText(1)).toBe('1 reel');
    expect(reelsText(22)).toBe('22 reels');
    expect(reelsText(0)).toBe('0 reels');
  });
});

describe('days', () => {
  it('writes a calendar day with its weekday', () => {
    expect(dayText('2026-10-26')).toBe('Mon 26 Oct');
    expect(dayText('2026-11-02')).toBe('Mon 2 Nov');
    expect(dayText('nope')).toBe('');
  });

  it('writes the day an instant falls on in the time zone', () => {
    // 22:30 UTC on Sunday is already Monday morning in Israel.
    expect(instantDayText('2026-10-25T22:30:00.000Z', ZONE)).toBe('Mon 26 Oct');
    expect(instantDayText('2026-10-25T22:30:00.000Z', { timeZone: 'UTC' })).toBe('Sun 25 Oct');
    expect(localDay('2026-10-26T04:00:00.000Z', ZONE)).toBe('2026-10-26');
    expect(instantDayText('not a time', ZONE)).toBe('');
  });

  it('names the year only for a day of another year', () => {
    expect(shortDayText('2026-08-03', ZONE)).toBe('3 Aug');
    expect(shortDayText('2025-12-31', ZONE)).toBe('31 Dec 2025');
    expect(shortDayText('', ZONE)).toBe('');
  });

  it('names the month', () => {
    expect(monthText('2026-08-03')).toBe('Aug');
    expect(monthText('')).toBe('');
  });
});

describe('the range in words', () => {
  it('names the day since us starts on', () => {
    expect(rangeWords({ range: 'since', sinceUs: '2026-08-03' }, ZONE)).toBe('since us (3 Aug)');
  });

  it('says the last 90 or 30 days', () => {
    expect(rangeWords({ range: '90', sinceUs: '2026-08-03' }, ZONE)).toBe('last 90 days');
    expect(rangeWords({ range: '30', sinceUs: '2026-08-03' }, ZONE)).toBe('last 30 days');
  });

  it('starts a subtitle with a capital', () => {
    expect(sentenceCase('since us (3 Aug)')).toBe('Since us (3 Aug)');
    expect(sentenceCase('')).toBe('');
  });
});
