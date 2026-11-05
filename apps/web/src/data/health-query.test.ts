import { type HealthResponse, SETTLE_MS } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from './api';
import {
  cachedSettleMs,
  draftChatEnabled,
  generateEnabled,
  HEALTH_KEY,
  healthQueryOptions,
  instagramEnabled,
  quickFixesEnabled,
  songsEnabled,
} from './health-query';
import { BASE_URL, createTestQueryClient } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const health: HealthResponse = {
  ok: true,
  version: '0.1.6',
  settleMs: 5000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

describe('cachedSettleMs', () => {
  it('is the default 60 s until the health answer is in', () => {
    expect(SETTLE_MS).toBe(60_000);
    expect(cachedSettleMs(queryClient)).toBe(SETTLE_MS);
  });

  it("is the server's settle delay once it is cached", () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(cachedSettleMs(queryClient)).toBe(5000);
  });

  it('keeps a settle delay of 0 instead of falling back', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, settleMs: 0 });
    expect(cachedSettleMs(queryClient)).toBe(0);
  });
});

describe('quickFixesEnabled', () => {
  it('is off until the health answer is in, and while the server says so', () => {
    expect(quickFixesEnabled(undefined)).toBe(false);
    expect(quickFixesEnabled(health)).toBe(false);
  });

  it('is on when the server says so', () => {
    expect(quickFixesEnabled({ ...health, quickFixes: true })).toBe(true);
  });
});

describe('generateEnabled', () => {
  it('is off until the answer is in, for an engine from before Generated videos, and when it says off', () => {
    expect(generateEnabled(undefined)).toBe(false);
    expect(generateEnabled(health)).toBe(false);
    expect(generateEnabled({ ...health, generate: false })).toBe(false);
  });

  it('is on when the answer says so, whatever the other switches say', () => {
    expect(generateEnabled({ ...health, generate: true })).toBe(true);
    expect(generateEnabled({ ...health, generate: true, music: false, songs: false })).toBe(true);
  });
});

describe('draftChatEnabled', () => {
  it('is off until the answer is in, for an engine from before Draft & chat, and when it says off', () => {
    expect(draftChatEnabled(undefined)).toBe(false);
    expect(draftChatEnabled(health)).toBe(false);
    expect(draftChatEnabled({ ...health, draftChat: false })).toBe(false);
  });

  it('is on when the answer says so', () => {
    expect(draftChatEnabled({ ...health, draftChat: true })).toBe(true);
  });
});

describe('instagramEnabled', () => {
  it('is off until the answer is in, for an engine from before Clients × Instagram, and when it says off', () => {
    expect(instagramEnabled(undefined)).toBe(false);
    expect(instagramEnabled(health)).toBe(false);
    expect(instagramEnabled({ ...health, instagram: false })).toBe(false);
  });

  it('is on when the answer says so, and not because another switch is on', () => {
    expect(instagramEnabled({ ...health, instagram: true })).toBe(true);
    expect(instagramEnabled({ ...health, draftChat: true, series: true })).toBe(false);
  });
});

describe('songsEnabled', () => {
  it('is off until the health answer is in, for an engine from before Songs, and while the server says so', () => {
    expect(songsEnabled(undefined)).toBe(false);
    expect(songsEnabled(health)).toBe(false);
    expect(songsEnabled({ ...health, music: true })).toBe(false);
    expect(songsEnabled({ ...health, songs: false, music: true })).toBe(false);
  });

  it('is on when the server says so and Soundtrack is on', () => {
    expect(songsEnabled({ ...health, songs: true, music: true })).toBe(true);
  });

  it('is off without Soundtrack, whatever songs says', () => {
    expect(songsEnabled({ ...health, songs: true, music: false })).toBe(false);
  });
});

describe('healthQueryOptions', () => {
  it("loads GET /api/health into the cache, where cachedSettleMs finds the server's delay", async () => {
    server.use(http.get(`${BASE_URL}/api/health`, () => HttpResponse.json(health)));

    await expect(queryClient.fetchQuery(healthQueryOptions(api))).resolves.toEqual(health);

    expect(queryClient.getQueryData(HEALTH_KEY)).toEqual(health);
    expect(cachedSettleMs(queryClient)).toBe(5000);
  });

  it('leaves the default in place when the answer cannot be read', async () => {
    server.use(
      http.get(`${BASE_URL}/api/health`, () => HttpResponse.json({ ok: true, version: '0.1.5' })),
    );
    const observer = new QueryObserver(queryClient, {
      ...healthQueryOptions(api),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(cachedSettleMs(queryClient)).toBe(SETTLE_MS);
    } finally {
      unsubscribe();
    }
  });
});
