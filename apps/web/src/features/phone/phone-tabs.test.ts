import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { activeTab, badgeText, jobsTabBadge, PHONE_TABS, showsTabBar } from './phone-tabs';

const job = (state: Job['state'], overrides: Partial<Job> = {}) => makeJob({ state, ...overrides });

describe('PHONE_TABS', () => {
  it('are Jobs, Clients and Money, in that order (board MMoney)', () => {
    expect(PHONE_TABS.map((tab) => [tab.id, tab.label, tab.to])).toEqual([
      ['jobs', 'Jobs', '/jobs'],
      ['clients', 'Clients', '/clients'],
      ['money', 'Money', '/money'],
    ]);
  });
});

describe('activeTab', () => {
  it('is Jobs on the jobs list, at / and /jobs', () => {
    for (const path of ['/', '/jobs', '/jobs/']) expect(activeTab(path), path).toBe('jobs');
  });

  it('is Clients on the Clients list, a client’s page and its Style page', () => {
    for (const path of ['/clients', '/clients/abc', '/clients/abc/style', '/clients/abc/style/'])
      expect(activeTab(path), path).toBe('clients');
  });

  it('is Money on the Money page', () => {
    for (const path of ['/money', '/money/']) expect(activeTab(path), path).toBe('money');
  });

  it('is none on Settings and on a page with no phone layout yet', () => {
    for (const path of ['/settings', '/analytics', '/clients/abc/series/s1', '/nope'])
      expect(activeTab(path), path).toBeNull();
  });
});

describe('showsTabBar', () => {
  it('shows on the top-level pages: Jobs, Clients, a client and its Style, Money', () => {
    for (const path of ['/', '/jobs', '/clients', '/clients/abc', '/clients/abc/style', '/money'])
      expect(showsTabBar(path), path).toBe(true);
  });

  it('stays away from Settings, and from a Mac page under the Back header', () => {
    for (const path of ['/settings', '/analytics', '/clients/abc/series/s1'])
      expect(showsTabBar(path), path).toBe(false);
  });
});

describe('jobsTabBadge', () => {
  it('counts the jobs in Review plus the ones that need attention (held, failed, cancelled)', () => {
    const jobs = [
      job('review'),
      job('review'),
      job('held'),
      job('failed'),
      job('cancelled'),
      job('editing'),
      job('queued'),
      job('ready'),
      job('arriving'),
    ];
    expect(jobsTabBadge(jobs)).toBe(5);
  });

  it('leaves archived jobs out, as the Mac header does', () => {
    const archivedAt = '2026-10-01T00:00:00.000Z';
    expect(
      jobsTabBadge([job('review'), job('failed', { archivedAt }), job('review', { archivedAt })]),
    ).toBe(1);
  });

  it('counts a delivered or paid video as none: it needs nobody', () => {
    expect(
      jobsTabBadge([
        job('ready', { approvedAt: '2026-10-20T10:00:00.000Z', delivery: makeJobDelivery() }),
        job('ready', { delivery: makeJobDelivery({ paidOn: '2026-10-21' }) }),
      ]),
    ).toBe(0);
  });

  it('is 0 for an empty list and for one that has not arrived', () => {
    expect(jobsTabBadge([])).toBe(0);
    expect(jobsTabBadge(undefined)).toBe(0);
  });
});

describe('badgeText', () => {
  it('is the count, up to 99, and 99+ beyond', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});
