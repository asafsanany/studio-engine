import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsEvent, Timers } from '../inbox/watcher.js';
import {
  createFontWatcher,
  FONT_WATCH_DEBOUNCE_MS,
  type FontEventSource,
  isFontEvent,
} from './font-watcher.js';
import { makeLibrary, type TempLibrary } from './library/test-utils.js';

// The `_Fonts` watcher (FN3): which events count, the 500 ms debounce (with the clock in the test's
// hands), and one pass through the real chokidar on a temp folder.

const DIR = '/inbox/_Fonts';

/** A clock the test moves by hand: timers fire when `advance` passes their time. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    setTimeout(run, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
  };
}

function fakeSource() {
  let emit: (event: FsEvent) => void = () => {};
  const source: FontEventSource & { starts: number; stops: number } = {
    starts: 0,
    stops: 0,
    async start(next) {
      source.starts += 1;
      emit = next;
    },
    async stop() {
      source.stops += 1;
    },
  };
  return {
    source,
    send: (kind: FsEvent['kind'], rel: string) => emit({ kind, path: `${DIR}/${rel}` }),
  };
}

function watcherWith(overrides: { onChange?: () => void } = {}) {
  const clock = manualTimers();
  const { source, send } = fakeSource();
  const onChange = overrides.onChange ?? vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const watcher = createFontWatcher({ dir: DIR, onChange, source, timers: clock.timers, logger });
  return { watcher, clock, source, send, onChange, logger };
}

describe('which events count', () => {
  const ev = (kind: FsEvent['kind'], rel: string): FsEvent => ({ kind, path: `${DIR}/${rel}` });

  it('counts a font file added, changed or removed, at any depth', () => {
    for (const kind of ['add', 'change', 'unlink'] as const) {
      expect(isFontEvent(DIR, ev(kind, 'Outfit-Bold.ttf')), kind).toBe(true);
    }
    expect(isFontEvent(DIR, ev('add', 'Hebrew + English/Heebo/Heebo-Bold.woff2'))).toBe(true);
    expect(isFontEvent(DIR, ev('add', 'a/b/c/d/e/F.OTF'))).toBe(true);
  });

  it('counts a folder added or removed', () => {
    expect(isFontEvent(DIR, ev('addDir', 'Karantina'))).toBe(true);
    expect(isFontEvent(DIR, ev('unlinkDir', 'English only/Outfit'))).toBe(true);
  });

  it('leaves out dot names and partial downloads, wherever they are', () => {
    expect(isFontEvent(DIR, ev('add', '.DS_Store'))).toBe(false);
    expect(isFontEvent(DIR, ev('add', 'x/._Outfit-Bold.ttf'))).toBe(false);
    expect(isFontEvent(DIR, ev('add', '.hidden/Outfit-Bold.ttf'))).toBe(false);
    expect(isFontEvent(DIR, ev('addDir', '.Trash'))).toBe(false);
    expect(isFontEvent(DIR, ev('add', 'Outfit-Bold.ttf.crdownload'))).toBe(false);
    expect(isFontEvent(DIR, ev('add', 'Outfit-Bold.ttf.part'))).toBe(false);
  });

  it('leaves out files that are not fonts', () => {
    expect(isFontEvent(DIR, ev('add', 'licence.txt'))).toBe(false);
    expect(isFontEvent(DIR, ev('change', 'Heebo/OFL.md'))).toBe(false);
    expect(isFontEvent(DIR, ev('unlink', 'Heebo/Heebo-Bold.ttf.bak'))).toBe(false);
  });

  it('leaves out the folder itself and anything outside it', () => {
    expect(isFontEvent(DIR, { kind: 'addDir', path: DIR })).toBe(false);
    expect(isFontEvent(DIR, { kind: 'add', path: '/inbox/Client/Job/Outfit-Bold.ttf' })).toBe(
      false,
    );
    expect(isFontEvent(DIR, { kind: 'add', path: '/inbox/_Fonts-old/Outfit-Bold.ttf' })).toBe(
      false,
    );
  });
});

describe('the debounce', () => {
  it('waits 500 ms after an event, then calls once', async () => {
    const { watcher, clock, send, onChange } = watcherWith();
    await watcher.start();

    send('add', 'Outfit-Bold.ttf');
    clock.advance(FONT_WATCH_DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(FONT_WATCH_DEBOUNCE_MS).toBe(500);
  });

  it('makes one call of a burst, 500 ms after the last event of it', async () => {
    const { watcher, clock, send, onChange } = watcherWith();
    await watcher.start();

    send('add', 'Heebo/Heebo-Thin.ttf');
    clock.advance(300);
    send('add', 'Heebo/Heebo-Bold.ttf');
    clock.advance(300);
    send('change', 'Heebo/Heebo-Bold.ttf');
    clock.advance(499);
    expect(onChange).not.toHaveBeenCalled();
    clock.advance(1);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it('does not wait for events it leaves out', async () => {
    const { watcher, clock, send, onChange } = watcherWith();
    await watcher.start();

    send('add', '.DS_Store');
    send('add', 'Outfit-Bold.ttf.crdownload');
    send('add', 'licence.txt');
    clock.advance(10_000);

    expect(onChange).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('calls again for a later burst', async () => {
    const { watcher, clock, send, onChange } = watcherWith();
    await watcher.start();

    send('add', 'a.ttf');
    clock.advance(500);
    send('unlink', 'a.ttf');
    clock.advance(500);

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('starting and stopping', () => {
  it('starts its source once, and stops it', async () => {
    const { watcher, source } = watcherWith();

    await watcher.start();
    await watcher.start();
    await watcher.stop();
    await watcher.stop();

    expect(source.starts).toBe(1);
    expect(source.stops).toBe(1);
  });

  it('drops a call that was waiting when it stops, and hears nothing after', async () => {
    const { watcher, clock, send, onChange } = watcherWith();
    await watcher.start();
    send('add', 'a.ttf');

    await watcher.stop();
    clock.advance(1_000);
    send('add', 'b.ttf');
    clock.advance(1_000);

    expect(onChange).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('logs a source that cannot start instead of throwing, and can be started again later', async () => {
    const clock = manualTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const source: FontEventSource = {
      start: vi.fn().mockRejectedValueOnce(new Error('no folder')).mockResolvedValue(undefined),
      stop: vi.fn(async () => {}),
    };
    const watcher = createFontWatcher({
      dir: DIR,
      onChange: () => {},
      source,
      timers: clock.timers,
      logger,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);

    await watcher.start();
    expect(source.start).toHaveBeenCalledTimes(2);
  });

  it('lets go of a source it was still starting when stop() came', async () => {
    const clock = manualTimers();
    let finish: () => void = () => {};
    const source: FontEventSource = {
      start: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      stop: vi.fn(async () => {}),
    };
    const watcher = createFontWatcher({
      dir: DIR,
      onChange: () => {},
      source,
      timers: clock.timers,
    });

    const starting = watcher.start();
    await watcher.stop();
    finish();
    await starting;

    // Once by stop() (which found nothing to stop yet) and once when the start came back.
    expect(source.stop).toHaveBeenCalledTimes(2);
  });
});

// --- the real chokidar ----------------------------------------------------------------------------

describe('the real folder watcher', () => {
  const libraries: TempLibrary[] = [];
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const library of libraries.splice(0)) library.cleanup();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function waitFor(read: () => boolean, what: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!read()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  async function watching() {
    const library = makeLibrary();
    libraries.push(library);
    const onChange = vi.fn();
    const watcher = createFontWatcher({ dir: library.dir, onChange, debounceMs: 50 });
    await watcher.start();
    stops.push(() => watcher.stop());
    return { library, onChange };
  }

  it('hears a font dropped in (in a folder, at depth), changed and removed', async () => {
    const { library, onChange } = await watching();

    library.putFixture('English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
    await waitFor(() => onChange.mock.calls.length >= 1, 'the added font');
    const afterAdd = onChange.mock.calls.length;

    library.put('English only/Outfit/Outfit-Bold.ttf', 'changed');
    await waitFor(() => onChange.mock.calls.length > afterAdd, 'the changed font');
    const afterChange = onChange.mock.calls.length;

    library.remove('English only/Outfit/Outfit-Bold.ttf');
    await waitFor(() => onChange.mock.calls.length > afterChange, 'the removed font');
  });

  it('hears nothing of dot names, partial downloads and files that are not fonts', async () => {
    const { library, onChange } = await watching();

    library.put('.DS_Store', 'x');
    library.put('._Outfit-Bold.ttf', 'x');
    library.put('Outfit-Bold.ttf.crdownload', 'x');
    library.put('licence.txt', 'x');
    await sleep(800);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not throw for a folder that is not there; it logs and carries on without watching', async () => {
    const library = makeLibrary();
    libraries.push(library);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const watcher = createFontWatcher({
      dir: join(library.inbox, 'nowhere'),
      onChange: () => {},
      logger,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    await watcher.stop();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
