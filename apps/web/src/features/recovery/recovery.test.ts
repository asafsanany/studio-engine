import { describe, expect, it, vi } from 'vitest';
import {
  fetchServerVersion,
  type GuardStorage,
  isChunkLoadError,
  RELOAD_GUARD_MS,
  RESUME_RELOAD_KEY,
  reloadGuarded,
  resumeAction,
  startResumeRecovery,
} from './recovery';

function memoryStorage(initial: Record<string, string> = {}): GuardStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

describe('isChunkLoadError', () => {
  it('knows what Safari, Chrome and Firefox say for a file that is gone', () => {
    for (const message of [
      'Importing a module script failed.',
      'Failed to fetch dynamically imported module: https://x/assets/a.js',
      'error loading dynamically imported module: https://x/assets/a.js',
      'Loading chunk 12 failed.',
      'Unable to preload CSS for /assets/a.css',
    ]) {
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
    }
  });

  it('is false for every other error', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('reloadGuarded', () => {
  it('reloads and remembers when', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadGuarded({ storage, key: 'k', now: 5_000, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem('k')).toBe('5000');
  });

  it('does not reload again within the minute, and does after it', () => {
    const storage = memoryStorage({ k: '5000' });
    const reload = vi.fn();
    expect(reloadGuarded({ storage, key: 'k', now: 5_000 + RELOAD_GUARD_MS - 1, reload })).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(reloadGuarded({ storage, key: 'k', now: 5_000 + RELOAD_GUARD_MS, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when the browser gives no storage, or one that throws', () => {
    const reload = vi.fn();
    reloadGuarded({ storage: null, key: 'k', now: 1, reload });
    const broken: GuardStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    reloadGuarded({ storage: broken, key: 'k', now: 1, reload });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('resumeAction', () => {
  it('reloads an empty page, whatever the engine says', () => {
    expect(resumeAction({ rootEmpty: true, appVersion: '1.0.0', serverVersion: null })).toBe(
      'reload',
    );
  });

  it('reloads a page built for another version than the engine runs', () => {
    expect(resumeAction({ rootEmpty: false, appVersion: '1.0.0', serverVersion: '1.0.1' })).toBe(
      'reload',
    );
  });

  it('leaves a drawn page alone when the version matches or the engine does not answer', () => {
    expect(resumeAction({ rootEmpty: false, appVersion: '1.0.0', serverVersion: '1.0.0' })).toBe(
      'none',
    );
    expect(resumeAction({ rootEmpty: false, appVersion: '1.0.0', serverVersion: null })).toBe(
      'none',
    );
  });
});

describe('startResumeRecovery', () => {
  function setup(
    options: {
      rootChildren?: number;
      serverVersion?: string | null;
      checkVersion?: boolean;
      stored?: Record<string, string>;
    } = {},
  ) {
    const listeners: Record<string, Array<() => void>> = {};
    const add = (key: string, handler: () => void) => {
      listeners[key] = [...(listeners[key] ?? []), handler];
    };
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (type: string, handler: () => void) => add(`doc:${type}`, handler),
      removeEventListener: vi.fn(),
    };
    const win = {
      addEventListener: (type: string, handler: () => void) => add(`win:${type}`, handler),
      removeEventListener: vi.fn(),
    };
    const reload = vi.fn();
    const fetchVersion = vi.fn(async () =>
      options.serverVersion === undefined ? '1.0.0' : options.serverVersion,
    );
    const stop = startResumeRecovery({
      document: doc as never,
      window: win as never,
      root: { childElementCount: options.rootChildren ?? 1 },
      appVersion: '1.0.0',
      fetchServerVersion: fetchVersion,
      checkVersion: options.checkVersion ?? true,
      storage: memoryStorage(options.stored),
      now: () => 100_000,
      reload,
    });
    const fire = async (key: string) => {
      for (const handler of listeners[key] ?? []) handler();
      await vi.waitFor(() => undefined);
      await Promise.resolve();
    };
    return { doc, win, reload, fetchVersion, stop, fire, listeners };
  }

  it('reloads an empty page when it comes back to the foreground', async () => {
    const page = setup({ rootChildren: 0 });
    await page.fire('doc:visibilitychange');
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.fetchVersion).not.toHaveBeenCalled();
  });

  it('reloads a page built before the last release', async () => {
    const page = setup({ serverVersion: '1.0.1' });
    await page.fire('win:pageshow');
    await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
  });

  it('leaves a page that is drawn and current alone', async () => {
    const page = setup();
    await page.fire('doc:visibilitychange');
    await page.fire('win:pageshow');
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('does nothing when the engine cannot be reached, or in dev where versions are not compared', async () => {
    const down = setup({ serverVersion: null });
    await down.fire('doc:visibilitychange');
    const dev = setup({ serverVersion: '9.9.9', checkVersion: false });
    await dev.fire('doc:visibilitychange');
    expect(down.reload).not.toHaveBeenCalled();
    expect(dev.reload).not.toHaveBeenCalled();
    expect(dev.fetchVersion).not.toHaveBeenCalled();
  });

  it('does nothing while the page is in the background', async () => {
    const page = setup({ rootChildren: 0 });
    page.doc.visibilityState = 'hidden';
    await page.fire('doc:visibilitychange');
    await page.fire('win:pageshow');
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('does not reload in a loop: a second resume within the minute is left alone', async () => {
    const page = setup({ rootChildren: 0, stored: { [RESUME_RELOAD_KEY]: '99000' } });
    await page.fire('doc:visibilitychange');
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('removes its listeners', () => {
    const page = setup();
    page.stop();
    expect(page.doc.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    expect(page.win.removeEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
  });
});

describe('fetchServerVersion', () => {
  it('reads the version from /api/health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, version: '0.36.0' }) })),
    );
    expect(await fetchServerVersion()).toBe('0.36.0');
    vi.unstubAllGlobals();
  });

  it('is null when the engine is down, refuses or answers oddly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await fetchServerVersion()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    expect(await fetchServerVersion()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
    );
    expect(await fetchServerVersion()).toBeNull();
    vi.unstubAllGlobals();
  });
});
