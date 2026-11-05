import { describe, expect, it } from 'vitest';
import { hasPhoneLayout } from './phone-pages';

describe('hasPhoneLayout', () => {
  it('is true for the jobs list, Settings, the Clients list and Money (PH19)', () => {
    for (const path of ['/', '/jobs', '/settings', '/clients', '/money'])
      expect(hasPhoneLayout(path), path).toBe(true);
  });

  it('is true for a client’s page and its Style page (PH18)', () => {
    for (const path of ['/clients/abc', '/clients/abc/style', '/clients/e0e0e0e0e0e0/style/'])
      expect(hasPhoneLayout(path), path).toBe(true);
  });

  it('ignores a trailing slash', () => {
    expect(hasPhoneLayout('/jobs/')).toBe(true);
    expect(hasPhoneLayout('/settings/')).toBe(true);
    expect(hasPhoneLayout('/clients/')).toBe(true);
    expect(hasPhoneLayout('/money/')).toBe(true);
    expect(hasPhoneLayout('/clients/abc/')).toBe(true);
  });

  it('is false for the Mac pages and for an address that is no page', () => {
    for (const path of [
      '/analytics',
      '/money/extra',
      '/clients/abc/series/s1',
      '/clients/abc/style/extra',
      '/clients/abc/other',
      '/clients//style',
      '/jobs/extra',
      '/nope',
    ])
      expect(hasPhoneLayout(path), path).toBe(false);
  });
});
