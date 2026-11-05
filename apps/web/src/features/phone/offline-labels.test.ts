import { describe, expect, it } from 'vitest';
import { lastConnectedLabel, offlineTitle } from './offline-labels';

// Local times throughout: the label is read on the phone's own clock.
const at = (day: number, hour: number, minute: number, month = 9) =>
  new Date(2026, month, day, hour, minute).getTime();

describe('lastConnectedLabel', () => {
  it('says "today" for the same calendar day, on a 24-hour clock', () => {
    expect(lastConnectedLabel(at(22, 14, 2), at(22, 14, 40))).toBe('Last connected today at 14:02');
    expect(lastConnectedLabel(at(22, 9, 5), at(22, 23, 59))).toBe('Last connected today at 09:05');
    expect(lastConnectedLabel(at(22, 0, 0), at(22, 0, 1))).toBe('Last connected today at 00:00');
  });

  it('says "yesterday" for the day before, even a few minutes apart across midnight', () => {
    expect(lastConnectedLabel(at(21, 23, 50), at(22, 0, 10))).toBe(
      'Last connected yesterday at 23:50',
    );
  });

  it('names the day for anything older', () => {
    expect(lastConnectedLabel(at(20, 9, 15), at(22, 8, 0))).toBe(
      'Last connected on 20 Oct at 09:15',
    );
    expect(lastConnectedLabel(at(30, 18, 30, 8), at(22, 8, 0))).toBe(
      'Last connected on 30 Sep at 18:30',
    );
  });

  it('counts calendar days across a month end', () => {
    expect(lastConnectedLabel(at(31, 22, 0, 9), new Date(2026, 10, 1, 7, 0).getTime())).toBe(
      'Last connected yesterday at 22:00',
    );
  });
});

describe('offlineTitle', () => {
  it('names the phone pages', () => {
    expect(offlineTitle('/')).toBe('Jobs');
    expect(offlineTitle('/jobs')).toBe('Jobs');
    expect(offlineTitle('/jobs/')).toBe('Jobs');
    expect(offlineTitle('/settings')).toBe('Settings');
    expect(offlineTitle('/clients')).toBe('Clients');
    expect(offlineTitle('/money')).toBe('Money');
  });

  it('falls back to the app’s name for a page it has no name for', () => {
    expect(offlineTitle('/clients/abc')).toBe('Studio Engine');
    expect(offlineTitle('/analytics')).toBe('Studio Engine');
  });
});
