import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/router';
import {
  ANALYTICS_PERIOD_STORAGE_KEY,
  periodOfSearch,
  periodToRestore,
  rememberedPeriod,
  rememberPeriod,
  selectPeriod,
  validateAnalyticsSearch,
} from './analytics-search';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The app's router on a memory history, started at `path` and behaving as it does in the browser:
 * a router built outside a browser takes itself for a server and ignores `navigate`. That takes a
 * `window` with an origin, which the router reads once.
 */
async function routerAt(path: string) {
  vi.stubGlobal('window', { origin: 'http://studio.test' });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  router.update({ isServer: false, scrollRestoration: false });
  await router.load();
  return router;
}

const hrefOf = (router: Awaited<ReturnType<typeof routerAt>>) => router.history.location.href;

describe('validateAnalyticsSearch', () => {
  it('keeps week and month', () => {
    expect(validateAnalyticsSearch({ period: 'week' })).toEqual({ period: 'week' });
    expect(validateAnalyticsSearch({ period: 'month' })).toEqual({ period: 'month' });
  });

  it('drops anything else: it is the month', () => {
    for (const period of [undefined, null, '', 'year', 'Week', 'weeks', 7, true, ['week']]) {
      expect(validateAnalyticsSearch({ period })).toEqual({});
    }
    expect(validateAnalyticsSearch({})).toEqual({});
  });

  it('keeps nothing else', () => {
    expect(validateAnalyticsSearch({ period: 'week', job: 'a', page: 2 })).toEqual({
      period: 'week',
    });
  });
});

describe('periodOfSearch', () => {
  it('reads the period from a search, valid or not, and is the month when it says none', () => {
    expect(periodOfSearch({ period: 'week' })).toBe('week');
    expect(periodOfSearch({ period: 'month' })).toBe('month');
    expect(periodOfSearch({})).toBe('month');
    expect(periodOfSearch({ period: 'year' })).toBe('month');
    expect(periodOfSearch({ period: 7 })).toBe('month');
    expect(periodOfSearch(undefined)).toBe('month');
    expect(periodOfSearch(null)).toBe('month');
    expect(periodOfSearch('period=week')).toBe('month');
  });
});

describe('the router and ?period=', () => {
  it('knows the param on the Analytics page', async () => {
    const router = await routerAt('/analytics?period=week');

    expect(periodOfSearch(router.state.location.search)).toBe('week');
    expect(router.state.matches.at(-1)?.search).toEqual({ period: 'week' });
  });

  it('is the month for /analytics, and for a word it does not know', async () => {
    expect(periodOfSearch((await routerAt('/analytics')).state.location.search)).toBe('month');
    const odd = await routerAt('/analytics?period=year');
    expect(periodOfSearch(odd.state.location.search)).toBe('month');
  });

  it('is the week after a reload: the address is the truth', async () => {
    const first = await routerAt('/analytics');
    await selectPeriod(first, 'week');
    const reloaded = await routerAt(hrefOf(first));

    expect(periodOfSearch(reloaded.state.location.search)).toBe('week');
  });
});

describe('selectPeriod', () => {
  it('puts ?period=week in the address, and takes it out again for the month', async () => {
    const router = await routerAt('/analytics');

    await selectPeriod(router, 'week');
    expect(hrefOf(router)).toBe('/analytics?period=week');
    await selectPeriod(router, 'month');
    expect(hrefOf(router)).toBe('/analytics');
  });

  it('replaces the history entry: Back leaves the page and does not step through the switches', async () => {
    const router = await routerAt('/clients');
    await router.navigate({ to: '/analytics' });
    const before = router.history.length;

    await selectPeriod(router, 'week');
    await selectPeriod(router, 'month');
    await selectPeriod(router, 'week');

    expect(router.history.length).toBe(before);
    router.history.back();
    await router.load();
    expect(hrefOf(router)).toBe('/clients');
  });

  it('keeps every other parameter', async () => {
    const router = await routerAt('/analytics?period=week&from=elsewhere');

    await selectPeriod(router, 'month');
    expect(hrefOf(router)).toBe('/analytics?from=elsewhere');
    await selectPeriod(router, 'week');
    expect(router.history.location.search).toContain('period=week');
    expect(router.history.location.search).toContain('from=elsewhere');
  });

  it('does not scroll: the page stays where it is', async () => {
    const router = await routerAt('/analytics');
    const navigate = vi.spyOn(router, 'navigate');

    await selectPeriod(router, 'week');

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true, resetScroll: false }),
    );
  });
});

/** A localStorage stand-in: the browser's, as far as the remembered period is concerned. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

/** The app's router at `path`, in a browser whose localStorage is `storage`. */
async function routerWithStorage(path: string, storage: ReturnType<typeof memoryStorage>) {
  vi.stubGlobal('window', { origin: 'http://studio.test', localStorage: storage });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  router.update({ isServer: false, scrollRestoration: false });
  await router.load();
  return router;
}

describe('the remembered period', () => {
  it('is the month until the week is chosen, and the week after', () => {
    const storage = memoryStorage();
    expect(rememberedPeriod(storage)).toBe('month');
    rememberPeriod('week', storage);
    expect(rememberedPeriod(storage)).toBe('week');
    expect(storage.items.get(ANALYTICS_PERIOD_STORAGE_KEY)).toBe('week');
    rememberPeriod('month', storage);
    expect(rememberedPeriod(storage)).toBe('month');
  });

  it('is the month for anything else stored, and when the storage is blocked', () => {
    expect(rememberedPeriod(memoryStorage({ [ANALYTICS_PERIOD_STORAGE_KEY]: 'year' }))).toBe(
      'month',
    );
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(rememberedPeriod(blocked)).toBe('month');
    expect(() => rememberPeriod('week', blocked)).not.toThrow();
  });
});

describe('periodToRestore', () => {
  it('shows an address that names a period as it is, and remembers it', () => {
    const storage = memoryStorage({ [ANALYTICS_PERIOD_STORAGE_KEY]: 'week' });
    expect(periodToRestore({ period: 'month' }, storage)).toBeNull();
    expect(rememberedPeriod(storage)).toBe('month');
    expect(periodToRestore({ period: 'week' }, storage)).toBeNull();
    expect(rememberedPeriod(storage)).toBe('week');
  });

  it('asks for the remembered week when the address names no period, and for nothing on the month', () => {
    expect(periodToRestore({}, memoryStorage({ [ANALYTICS_PERIOD_STORAGE_KEY]: 'week' }))).toBe(
      'week',
    );
    expect(periodToRestore({}, memoryStorage())).toBeNull();
  });
});

describe('the page opens on the period last chosen', () => {
  it('turns the plain /analytics into ?period=week when the week was chosen (the sidebar, a reload)', async () => {
    const storage = memoryStorage({ [ANALYTICS_PERIOD_STORAGE_KEY]: 'week' });
    const router = await routerWithStorage('/analytics', storage);
    expect(hrefOf(router)).toBe('/analytics?period=week');
  });

  it('leaves the plain /analytics alone when the month was chosen', async () => {
    const router = await routerWithStorage(
      '/analytics',
      memoryStorage({ [ANALYTICS_PERIOD_STORAGE_KEY]: 'month' }),
    );
    expect(hrefOf(router)).toBe('/analytics');
  });

  it('remembers what the switch chooses, and a link that names the month', async () => {
    const storage = memoryStorage();
    const router = await routerWithStorage('/analytics', storage);
    await selectPeriod(router, 'week');
    expect(storage.items.get(ANALYTICS_PERIOD_STORAGE_KEY)).toBe('week');

    await router.navigate({ to: '/jobs' });
    await router.navigate({ to: '/analytics' });
    expect(hrefOf(router)).toBe('/analytics?period=week');

    await router.navigate({ to: '/analytics', search: { period: 'month' } });
    expect(storage.items.get(ANALYTICS_PERIOD_STORAGE_KEY)).toBe('month');
  });
});
