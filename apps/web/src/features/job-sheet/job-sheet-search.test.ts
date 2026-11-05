import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/router';
import {
  closeJobSheet,
  dropJobParam,
  isSheetEntry,
  jobIdOf,
  moveJobSheet,
  openJobSheet,
  validateJobSearch,
} from './job-sheet-search';

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

/** Where the router stands: the path with its search. */
const hrefOf = (router: Awaited<ReturnType<typeof routerAt>>) => router.history.location.href;

/** Lets the router finish a navigation that a history move (Back) started. */
const settle = (router: Awaited<ReturnType<typeof routerAt>>) => router.load();

describe('validateJobSearch', () => {
  it('keeps a job id', () => {
    expect(validateJobSearch({ job: 'abc123' })).toEqual({ job: 'abc123' });
  });

  it('drops anything that is not a non-empty string', () => {
    for (const job of [undefined, null, '', 42, true, ['a'], { id: 'a' }]) {
      expect(validateJobSearch({ job })).toEqual({});
    }
    expect(validateJobSearch({})).toEqual({});
  });

  it('keeps nothing else', () => {
    expect(validateJobSearch({ job: 'a', page: 2 })).toEqual({ job: 'a' });
  });
});

describe('jobIdOf', () => {
  it('reads the id from a search, valid or not', () => {
    expect(jobIdOf({ job: 'abc' })).toBe('abc');
    expect(jobIdOf({})).toBeNull();
    expect(jobIdOf({ job: '' })).toBeNull();
    expect(jobIdOf({ job: 5 })).toBeNull();
    expect(jobIdOf(undefined)).toBeNull();
    expect(jobIdOf(null)).toBeNull();
    expect(jobIdOf('job=abc')).toBeNull();
  });
});

describe('the router and ?job=', () => {
  it('knows the param on the Jobs page, the home page, a client page and a series page', async () => {
    for (const path of [
      '/jobs?job=a1',
      '/?job=a1',
      '/clients/c1?job=a1',
      '/clients/c1/series/s1?job=a1',
    ]) {
      const router = await routerAt(path);
      expect(jobIdOf(router.state.location.search), path).toBe('a1');
      const leaf = router.state.matches.at(-1);
      expect(leaf?.search, path).toEqual({ job: 'a1' });
    }
  });

  it('has no job without the param, or with one that is not an id', async () => {
    for (const path of ['/jobs', '/jobs?job=', '/jobs?job=42', '/jobs?job[]=a']) {
      const router = await routerAt(path);
      expect(jobIdOf(router.state.location.search), path).toBeNull();
    }
  });
});

describe('openJobSheet', () => {
  it('adds an entry with the job in the address, on the page it is on', async () => {
    for (const path of ['/jobs', '/', '/clients/c1', '/clients/c1/series/s1']) {
      const router = await routerAt(path);
      await openJobSheet(router, 'abc');
      expect(hrefOf(router), path).toBe(`${router.state.location.pathname}?job=abc`);
      expect(isSheetEntry(router), path).toBe(true);
    }
  });

  it('is undone by Back: the page is as it was, with no job', async () => {
    const router = await routerAt('/jobs');
    await openJobSheet(router, 'abc');
    router.history.back();
    await settle(router);
    expect(hrefOf(router)).toBe('/jobs');
    expect(jobIdOf(router.state.location.search)).toBeNull();
  });

  it('does not reopen after it was closed and the person goes Back again', async () => {
    const router = await routerAt('/clients');
    await router.navigate({ to: '/jobs' });
    await openJobSheet(router, 'abc');
    closeJobSheet(router);
    await settle(router);
    expect(hrefOf(router)).toBe('/jobs');
    router.history.back();
    await settle(router);
    expect(hrefOf(router)).toBe('/clients');
  });
});

describe('moveJobSheet', () => {
  it('replaces the entry: Back from the next job leaves the sheet, not steps to the one before', async () => {
    const router = await routerAt('/jobs');
    await openJobSheet(router, 'a');
    await moveJobSheet(router, 'b');
    await moveJobSheet(router, 'c');
    expect(hrefOf(router)).toBe('/jobs?job=c');
    expect(isSheetEntry(router)).toBe(true);
    router.history.back();
    await settle(router);
    expect(hrefOf(router)).toBe('/jobs');
  });

  it('keeps an entry that was not the sheet’s as it is', async () => {
    const router = await routerAt('/jobs?job=a');
    await moveJobSheet(router, 'b');
    expect(hrefOf(router)).toBe('/jobs?job=b');
    expect(isSheetEntry(router)).toBe(false);
  });
});

describe('closeJobSheet', () => {
  it('goes back when the sheet pushed the entry', async () => {
    const router = await routerAt('/jobs');
    await openJobSheet(router, 'a');
    await moveJobSheet(router, 'b');
    closeJobSheet(router);
    await settle(router);
    expect(hrefOf(router)).toBe('/jobs');
    expect(router.history.canGoBack()).toBe(false);
  });

  it('replaces the entry when it was a link or a reload, leaving nothing of the sheet behind', async () => {
    const router = await routerAt('/jobs?job=a');
    closeJobSheet(router);
    await settle(router);
    expect(hrefOf(router)).toBe('/jobs');
    expect(router.history.canGoBack()).toBe(false);
  });

  it('works on a client page too', async () => {
    const router = await routerAt('/clients/c1');
    await openJobSheet(router, 'a');
    closeJobSheet(router);
    await settle(router);
    expect(hrefOf(router)).toBe('/clients/c1');
  });
});

describe('dropJobParam', () => {
  it('removes the job from the address without adding an entry', async () => {
    const router = await routerAt('/jobs?job=nope');
    await dropJobParam(router);
    expect(hrefOf(router)).toBe('/jobs');
    expect(router.history.canGoBack()).toBe(false);
  });
});
