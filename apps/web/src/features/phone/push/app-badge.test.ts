import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { appBadgeCount, showAppBadge } from './app-badge';

type BadgeJob = Pick<Job, 'state' | 'delivery' | 'archivedAt'>;
const job = (state: Job['state'], archivedAt: string | null = null): BadgeJob => ({
  state,
  delivery: null,
  archivedAt,
});

describe('appBadgeCount', () => {
  it('counts Review and Needs attention, like the Mac header, archived left out', () => {
    const jobs = [
      job('review'),
      job('review'),
      job('failed'),
      job('held'),
      job('cancelled'),
      job('editing'),
      job('queued'),
      job('ready'),
      job('failed', '2026-10-01T00:00:00.000Z'),
      job('review', '2026-10-01T00:00:00.000Z'),
    ];
    expect(appBadgeCount(jobs)).toBe(5);
    expect(appBadgeCount([])).toBe(0);
  });
});

describe('showAppBadge', () => {
  it('sets the count, and clears the icon at 0', async () => {
    const nav = {
      setAppBadge: vi.fn(async () => undefined),
      clearAppBadge: vi.fn(async () => undefined),
    };
    await showAppBadge(nav, 3);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    await showAppBadge(nav, 0);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(nav.setAppBadge).toHaveBeenCalledTimes(1);
  });

  it('never fails: no badges at all, or a badge iOS does not allow', async () => {
    await expect(showAppBadge({}, 2)).resolves.toBeUndefined();
    const refused = {
      setAppBadge: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))),
    };
    await expect(showAppBadge(refused, 2)).resolves.toBeUndefined();
  });
});
