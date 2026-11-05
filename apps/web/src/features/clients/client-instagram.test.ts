import type { ClientInstagramSummary } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_INSTAGRAM_SORT_VALUE,
  followersText,
  handleText,
  instagramRowKind,
  instagramStatusText,
  NO_INSTAGRAM_TEXT,
  oursVsTheirsText,
  PRIVATE_ACCOUNT_TEXT,
  rowShowsPhoto,
  weekText,
  weekTone,
} from './client-instagram';
import type { ClientSummary } from './clients';

const summary = (overrides: Partial<ClientInstagramSummary> = {}): ClientInstagramSummary => ({
  handle: 'falcon.fpv',
  followers: 12_480,
  weekChange: 312,
  oursVsTheirs: 3.6,
  photoAt: '2026-10-20T06:00:00.000Z',
  ...overrides,
});

const client = (instagram?: ClientInstagramSummary | null): ClientSummary => ({
  clientId: 'c1',
  name: 'Falcon FPV',
  initials: 'MF',
  jobCount: 2,
  lastJobAt: '2026-10-20T10:00:00.000Z',
  ...(instagram === undefined ? {} : { instagram }),
});

describe('rowShowsPhoto', () => {
  it('shows the photo of a client with an account, or with none read yet', () => {
    expect(rowShowsPhoto(client(summary()))).toBe(true);
    expect(rowShowsPhoto(client(summary({ followers: null })))).toBe(true);
    expect(rowShowsPhoto(client(summary({ private: false })))).toBe(true);
  });

  it('keeps the initials of a private account', () => {
    expect(rowShowsPhoto(client(summary({ private: true })))).toBe(false);
  });

  it('has nothing to hide for a client with no account, or a list sent without Instagram', () => {
    expect(rowShowsPhoto(client(null))).toBe(true);
    expect(rowShowsPhoto(client())).toBe(true);
  });
});

describe('instagramRowKind', () => {
  it('is an account for a client with an account, and none for one without', () => {
    expect(instagramRowKind(client(summary()))).toBe('account');
    expect(instagramRowKind(client(null))).toBe('none');
  });

  it('counts a list sent without Instagram as no account', () => {
    expect(instagramRowKind(client())).toBe('none');
  });

  it('is private only when the summary says so', () => {
    expect(instagramRowKind(client(summary({ private: true })))).toBe('private');
    expect(instagramRowKind(client(summary({ private: false })))).toBe('account');
  });
});

describe('instagramStatusText', () => {
  it('says "No Instagram yet" and "Account is private" in place of the numbers', () => {
    expect(instagramStatusText('none')).toBe('No Instagram yet');
    expect(instagramStatusText('private')).toBe('Account is private');
    expect(NO_INSTAGRAM_TEXT).toBe('No Instagram yet');
    expect(PRIVATE_ACCOUNT_TEXT).toBe('Account is private');
  });

  it('says nothing for a row that has numbers', () => {
    expect(instagramStatusText('account')).toBeNull();
  });
});

describe('handleText', () => {
  it('is the @handle of a client with an account', () => {
    expect(handleText(client(summary()))).toBe('@falcon.fpv');
  });

  it('is nothing for a client with no account or a private one', () => {
    expect(handleText(client(null))).toBeNull();
    expect(handleText(client())).toBeNull();
    expect(handleText(client(summary({ private: true })))).toBeNull();
  });
});

describe('the number columns', () => {
  it('writes followers with a thousands separator, a dash before the first scan', () => {
    expect(followersText(client(summary()))).toBe('12,480');
    expect(followersText(client(summary({ followers: null })))).toBe('—');
  });

  it('writes this week with its sign, a dash before there are two scans', () => {
    expect(weekText(client(summary({ weekChange: 312 })))).toBe('+312');
    expect(weekText(client(summary({ weekChange: -42 })))).toBe('−42');
    expect(weekText(client(summary({ weekChange: 0 })))).toBe('0');
    expect(weekText(client(summary({ weekChange: null })))).toBe('—');
  });

  it('colours this week green up, red down, muted for none or not known', () => {
    expect(weekTone(client(summary({ weekChange: 312 })))).toBe('better');
    expect(weekTone(client(summary({ weekChange: -42 })))).toBe('worse');
    expect(weekTone(client(summary({ weekChange: 0 })))).toBe('same');
    expect(weekTone(client(summary({ weekChange: null })))).toBe('same');
  });

  it('writes ours vs theirs as a multiple, a dash when there is no ratio', () => {
    expect(oursVsTheirsText(client(summary({ oursVsTheirs: 3.6 })))).toBe('3.6×');
    expect(oursVsTheirsText(client(summary({ oursVsTheirs: null })))).toBe('—');
  });
});

describe('CLIENT_INSTAGRAM_SORT_VALUE', () => {
  it('sorts by the numbers of a client with an account', () => {
    const falcon = client(summary());
    expect(CLIENT_INSTAGRAM_SORT_VALUE.followers(falcon)).toBe(12_480);
    expect(CLIENT_INSTAGRAM_SORT_VALUE.week(falcon)).toBe(312);
    expect(CLIENT_INSTAGRAM_SORT_VALUE.ours(falcon)).toBe(3.6);
  });

  it('has nothing to sort by for a number a scan has not read yet', () => {
    const fresh = client(summary({ followers: null, weekChange: null, oursVsTheirs: null }));
    expect(CLIENT_INSTAGRAM_SORT_VALUE.followers(fresh)).toBeUndefined();
    expect(CLIENT_INSTAGRAM_SORT_VALUE.week(fresh)).toBeUndefined();
    expect(CLIENT_INSTAGRAM_SORT_VALUE.ours(fresh)).toBeUndefined();
  });

  it('has nothing to sort by for a client with no account or a private one', () => {
    for (const row of [client(null), client(), client(summary({ private: true }))]) {
      expect(CLIENT_INSTAGRAM_SORT_VALUE.followers(row)).toBeUndefined();
      expect(CLIENT_INSTAGRAM_SORT_VALUE.week(row)).toBeUndefined();
      expect(CLIENT_INSTAGRAM_SORT_VALUE.ours(row)).toBeUndefined();
    }
  });

  it('keeps a change of zero as a number, so it sorts above a client that has none', () => {
    expect(CLIENT_INSTAGRAM_SORT_VALUE.week(client(summary({ weekChange: 0 })))).toBe(0);
  });
});
