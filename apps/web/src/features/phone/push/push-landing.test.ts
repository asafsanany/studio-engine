import { PUSH_URLS } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { isAppPath, reviewLanding } from './push-landing';

/** The search of an address, as the router parses it (`1` becomes a number). */
function searchOf(url: string): Record<string, unknown> {
  const params = new URL(url, 'https://mac.ts.net').searchParams;
  return Object.fromEntries(
    [...params].map(([key, value]) => [key, /^\d+$/.test(value) ? Number(value) : value]),
  );
}

describe('reviewLanding', () => {
  it('finds the job of the engine’s “Ready to review” address', () => {
    expect(reviewLanding(searchOf(PUSH_URLS.review('j 1')))).toBe('j 1');
    expect(reviewLanding({ job: 'j1', review: '1' })).toBe('j1');
    expect(reviewLanding({ job: 'j1', review: true })).toBe('j1');
  });

  it('is null for the sheet’s and the list’s addresses, and for anything odd', () => {
    expect(reviewLanding(searchOf(PUSH_URLS.sheet('j1')))).toBeNull();
    expect(reviewLanding(searchOf(PUSH_URLS.jobs))).toBeNull();
    expect(reviewLanding({ review: 1 })).toBeNull();
    expect(reviewLanding({ job: '', review: 1 })).toBeNull();
    expect(reviewLanding({ job: 'j1', review: 0 })).toBeNull();
    expect(reviewLanding(null)).toBeNull();
  });
});

describe('isAppPath', () => {
  it('takes this app’s paths only', () => {
    expect(isAppPath('/jobs?job=j1')).toBe(true);
    expect(isAppPath('//example.com/jobs')).toBe(false);
    expect(isAppPath('https://example.com/')).toBe(false);
    expect(isAppPath(undefined)).toBe(false);
  });
});
