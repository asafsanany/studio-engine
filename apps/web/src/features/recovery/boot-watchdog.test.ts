/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot watchdog is plain script in index.html (it has to run when the app's own script never
// arrives), so the test takes that script out of the file and runs it against a fake page.
const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const script = /<script>\s*([\s\S]*?)<\/script>/.exec(html)?.[1];

type Handler = (event: Record<string, unknown>) => void;

function boot(options: { stored?: Record<string, string>; healthOk?: boolean } = {}) {
  if (script === undefined) throw new Error('index.html has no inline script');
  const root = { childElementCount: 0 };
  const screen = { style: { display: 'none' } };
  const listeners: Record<string, Handler> = {};
  const store = new Map(Object.entries(options.stored ?? {}));
  let observed: (() => void) | undefined;
  class FakeObserver {
    constructor(callback: () => void) {
      observed = callback;
    }
    observe() {}
  }
  const location = { reload: vi.fn() };
  const fetchHealth = vi.fn(async () => {
    if (options.healthOk === undefined) throw new Error('offline');
    return { ok: options.healthOk };
  });
  new Function(
    'document',
    'window',
    'sessionStorage',
    'location',
    'fetch',
    'MutationObserver',
    'setTimeout',
    'setInterval',
    'clearInterval',
    script,
  )(
    { getElementById: (id: string) => (id === 'root' ? root : screen) },
    {
      addEventListener: (type: string, handler: Handler) => {
        listeners[type] = handler;
      },
    },
    {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    location,
    fetchHealth,
    FakeObserver,
    setTimeout,
    setInterval,
    clearInterval,
  );
  return {
    screen,
    location,
    fetchHealth,
    store,
    listeners,
    /** The app draws something into #root. */
    mount() {
      root.childElementCount = 1;
      observed?.();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('the boot watchdog in index.html', () => {
  it('shows nothing while the app has time to start, then Connecting… after 6 s with #root empty', () => {
    const page = boot();
    vi.advanceTimersByTime(5_999);
    expect(page.screen.style.display).toBe('none');
    vi.advanceTimersByTime(1);
    expect(page.screen.style.display).toBe('flex');
  });

  it('shows nothing at all when the app started in time', () => {
    const page = boot();
    page.mount();
    vi.advanceTimersByTime(30_000);
    expect(page.screen.style.display).toBe('none');
    expect(page.location.reload).not.toHaveBeenCalled();
  });

  it('goes away by itself when the app starts after all', () => {
    const page = boot();
    vi.advanceTimersByTime(6_000);
    page.mount();
    expect(page.screen.style.display).toBe('none');
    vi.advanceTimersByTime(30_000);
    expect(page.location.reload).not.toHaveBeenCalled();
  });

  it('reloads on its own once the engine answers, and not while it does not', async () => {
    const down = boot();
    await vi.advanceTimersByTimeAsync(6_000 + 15_000);
    expect(down.fetchHealth).toHaveBeenCalledTimes(3);
    expect(down.location.reload).not.toHaveBeenCalled();
    expect(down.screen.style.display).toBe('flex');

    const up = boot({ healthOk: true });
    await vi.advanceTimersByTimeAsync(6_000 + 5_000);
    expect(up.fetchHealth).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    expect(up.location.reload).toHaveBeenCalledTimes(1);
    expect(up.store.get('studio.boot.retries.v1')).toBe('1');
  });

  it('gives up reloading after 3 tries, leaving the button', async () => {
    const page = boot({ healthOk: true, stored: { 'studio.boot.retries.v1': '3' } });
    await vi.advanceTimersByTimeAsync(6_000 + 20_000);
    expect(page.location.reload).not.toHaveBeenCalled();
    expect(page.screen.style.display).toBe('flex');
  });

  it('forgets the tries once the app has started', () => {
    const page = boot({ stored: { 'studio.boot.retries.v1': '2' } });
    page.mount();
    expect(page.store.get('studio.boot.retries.v1')).toBe('0');
  });

  it('reloads once when a lazy file cannot be fetched, and not again within a minute', () => {
    const page = boot();
    const preventDefault = vi.fn();
    page.listeners['vite:preloadError']?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(page.location.reload).toHaveBeenCalledTimes(1);

    page.listeners.unhandledrejection?.({
      reason: new TypeError('Failed to fetch dynamically imported module: /assets/x.js'),
    });
    expect(page.location.reload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    page.listeners.error?.({ message: 'Loading chunk 7 failed.' });
    expect(page.location.reload).toHaveBeenCalledTimes(2);
  });

  it('leaves other errors alone', () => {
    const page = boot();
    page.listeners.error?.({ message: 'undefined is not a function' });
    page.listeners.unhandledrejection?.({ reason: new Error('boom') });
    expect(page.location.reload).not.toHaveBeenCalled();
  });
});
