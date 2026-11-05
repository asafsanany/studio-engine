import { compareVersions, findRelease, RELEASES, type Release } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@/lib/version';
import {
  createMemoryVersionStorage,
  createWhatsNewStore,
  LAST_SEEN_STORAGE_KEY,
  readLastSeenVersion,
  rememberVersion,
  type VersionStorage,
} from './whats-new-store';

const release = (version: string): Release => ({
  version,
  date: '2026-10-22',
  items: [`Change in ${version}.`],
});

// Newest first, as in the real file.
const releases = [release('0.2.0'), release('0.1.2'), release('0.1.1'), release('0.1.0')];

/** A storage that already holds the last seen version (or nothing). */
function storageSeeing(version: string | null): VersionStorage {
  const storage = createMemoryVersionStorage();
  if (version !== null) storage.setItem(LAST_SEEN_STORAGE_KEY, version);
  return storage;
}

/** Open the app: a new store over `storage`, as a page load does. */
function load(storage: VersionStorage, currentVersion = '0.2.0') {
  return createWhatsNewStore({ storage, releases, currentVersion });
}

const shownOf = (store: ReturnType<typeof load>) => store.getState().releases.map((r) => r.version);

describe('storage helpers', () => {
  it('reads the stored version, only if it is X.Y.Z', () => {
    expect(readLastSeenVersion(storageSeeing('0.1.0'))).toBe('0.1.0');
    expect(readLastSeenVersion(storageSeeing(null))).toBeNull();
    expect(readLastSeenVersion(storageSeeing('banana'))).toBeNull();
    expect(readLastSeenVersion(storageSeeing(''))).toBeNull();
  });

  it('uses the key studio.lastSeenVersion', () => {
    const storage = storageSeeing(null);
    rememberVersion(storage, '0.1.0');
    expect(storage.getItem('studio.lastSeenVersion')).toBe('0.1.0');
  });

  it('never lowers the stored version', () => {
    const storage = storageSeeing('0.3.0');
    rememberVersion(storage, '0.2.0');
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.3.0');
    rememberVersion(storage, '0.3.0');
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.3.0');
    rememberVersion(storage, '0.10.0');
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.10.0');
  });

  it('replaces a stored value that is not a version', () => {
    const storage = storageSeeing('banana');
    rememberVersion(storage, '0.1.0');
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.1.0');
  });

  it('ignores a version that is not X.Y.Z', () => {
    const storage = storageSeeing(null);
    rememberVersion(storage, 'dev');
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBeNull();
  });

  it('never throws when storage does (private mode, blocked site data)', () => {
    const broken: VersionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readLastSeenVersion(broken)).toBeNull();
    expect(() => rememberVersion(broken, '0.1.0')).not.toThrow();
  });
});

describe('missed versions in one dialog', () => {
  it('seen 0.1.0 with releases 0.1.1, 0.1.2, 0.2.0 opens one dialog listing all three, newest first', () => {
    const store = load(storageSeeing('0.1.0'));
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.2.0', '0.1.2', '0.1.1']);
    expect(store.getState().releases[0]).toBe(findRelease(releases, '0.2.0'));
  });

  it('lists newest first whatever order the release list comes in', () => {
    const store = createWhatsNewStore({
      storage: storageSeeing('0.1.0'),
      releases: [release('0.1.1'), release('0.2.0'), release('0.1.2')],
      currentVersion: '0.2.0',
    });
    expect(shownOf(store)).toEqual(['0.2.0', '0.1.2', '0.1.1']);
  });

  it('"Got it" closes the one dialog and remembers the current version, even after a reload', () => {
    const storage = storageSeeing('0.1.0');
    const store = load(storage);
    // Nothing is remembered until the dialog is closed.
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.1.0');

    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');

    const reloaded = load(storage);
    expect(reloaded.getState().open).toBe(false);
    expect(shownOf(reloaded)).toEqual([]);
  });

  it('keeps the releases after closing, so the content does not vanish while it fades out', () => {
    const store = load(storageSeeing('0.1.0'));
    store.getState().close();
    expect(shownOf(store)).toEqual(['0.2.0', '0.1.2', '0.1.1']);
  });

  it('closing twice changes nothing', () => {
    const storage = storageSeeing('0.1.0');
    const store = load(storage);
    store.getState().close();
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
  });

  it('reloading without closing shows them all again', () => {
    const storage = storageSeeing('0.1.0');
    load(storage);
    expect(shownOf(load(storage))).toEqual(['0.2.0', '0.1.2', '0.1.1']);
  });

  it('has no one-at-a-time "Got it", no "Close all" and no stack: only close and openCurrent act', () => {
    const state = load(storageSeeing('0.1.0')).getState() as unknown as Record<string, unknown>;
    expect(state.gotIt).toBeUndefined();
    expect(state.closeAll).toBeUndefined();
    expect(state.stack).toBeUndefined();
    expect(typeof state.close).toBe('function');
    expect(typeof state.openCurrent).toBe('function');
  });

  it('a single unseen version is a dialog with one release', () => {
    const store = load(storageSeeing('0.1.1'), '0.1.2');
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.1.2']);
  });

  it('closing a single release remembers the current version', () => {
    const storage = storageSeeing('0.1.1');
    const store = load(storage, '0.1.2');
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.1.2');
  });

  it('a release newer than the running app is not shown and not remembered', () => {
    const storage = storageSeeing('0.1.0');
    const store = load(storage, '0.1.1');
    expect(shownOf(store)).toEqual(['0.1.1']);
    store.getState().close();
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.1.1');
  });

  it('compares versions as numbers (0.10.0 is after 0.9.0)', () => {
    const list = [release('0.10.0'), release('0.9.0'), release('0.2.0')];
    const store = createWhatsNewStore({
      storage: storageSeeing('0.2.0'),
      releases: list,
      currentVersion: '0.10.0',
    });
    expect(store.getState().releases.map((r) => r.version)).toEqual(['0.10.0', '0.9.0']);
  });
});

describe('first ever open', () => {
  it('shows only the current version', () => {
    const store = load(storageSeeing(null));
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.2.0']);
  });

  it('treats a stored value that is not a version the same way', () => {
    expect(shownOf(load(storageSeeing('banana')))).toEqual(['0.2.0']);
  });

  it('remembers the current version once it has been closed, and shows nothing after a reload', () => {
    const storage = storageSeeing(null);
    load(storage).getState().close();
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
    const reloaded = load(storage);
    expect(reloaded.getState().open).toBe(false);
    expect(shownOf(reloaded)).toEqual([]);
  });
});

describe('when there is nothing to show', () => {
  it('shows nothing when the current version was already seen, and leaves storage alone', () => {
    const storage = storageSeeing('0.2.0');
    const store = load(storage);
    expect(store.getState().open).toBe(false);
    expect(shownOf(store)).toEqual([]);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
  });

  it('remembers the current version at once when it has no entry', () => {
    const storage = storageSeeing(null);
    const store = createWhatsNewStore({ storage, releases, currentVersion: '0.1.5' });
    expect(store.getState().open).toBe(false);
    expect(shownOf(store)).toEqual([]);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.1.5');
  });

  it('shows nothing after a downgrade and keeps the newer remembered version', () => {
    const storage = storageSeeing('0.2.0');
    const store = load(storage, '0.1.1');
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
  });

  it('closing does nothing when the dialog is not open', () => {
    const storage = storageSeeing('0.2.0');
    const store = load(storage);
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
  });
});

describe('opening the current version from the sidebar', () => {
  it('opens the same dialog with the current release alone, and closing it closes the dialog', () => {
    const storage = storageSeeing('0.2.0');
    const store = load(storage);
    store.getState().openCurrent();
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.2.0']);
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.2.0');
  });

  it('shows only the current version even after a longer list was closed', () => {
    const store = load(storageSeeing('0.1.0'));
    store.getState().close();
    store.getState().openCurrent();
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.2.0']);
  });

  it('does not lower a remembered newer version after a downgrade', () => {
    const storage = storageSeeing('0.3.0');
    const store = load(storage, '0.2.0');
    store.getState().openCurrent();
    store.getState().close();
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe('0.3.0');
  });

  it('leaves the dialog alone when it is already open', () => {
    const store = load(storageSeeing('0.1.0'));
    store.getState().openCurrent();
    expect(store.getState().open).toBe(true);
    expect(shownOf(store)).toEqual(['0.2.0', '0.1.2', '0.1.1']);
  });

  it('does nothing when the current version has no entry', () => {
    const store = createWhatsNewStore({
      storage: storageSeeing('0.1.5'),
      releases,
      currentVersion: '0.1.5',
    });
    store.getState().openCurrent();
    expect(store.getState().open).toBe(false);
    expect(shownOf(store)).toEqual([]);
  });
});

describe('storage that fails', () => {
  it('still works for the session', () => {
    const broken: VersionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const store = load(broken);
    // Nothing readable: treated as a first open.
    expect(shownOf(store)).toEqual(['0.2.0']);
    expect(() => store.getState().close()).not.toThrow();
    expect(store.getState().open).toBe(false);
  });
});

describe('with the real release notes and app version', () => {
  it('greets a first ever open with the notes of the running version', () => {
    const store = createWhatsNewStore({ storage: storageSeeing(null) });
    const current = findRelease(RELEASES, APP_VERSION);
    expect(current).toBeDefined();
    expect(store.getState().releases).toEqual([current]);
    expect(store.getState().open).toBe(true);
  });

  it('lists every release since 0.1.0 in one dialog, the running version first, versions falling', () => {
    const store = createWhatsNewStore({ storage: storageSeeing('0.1.0') });
    const shown = store.getState().releases.map((r) => r.version);
    expect(shown[0]).toBe(APP_VERSION);
    expect(shown).not.toContain('0.1.0');
    for (let i = 1; i < shown.length; i++) {
      expect(compareVersions(shown[i - 1] as string, shown[i] as string)).toBe(1);
    }
  });
});
