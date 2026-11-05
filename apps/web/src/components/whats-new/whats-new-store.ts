import {
  compareVersions,
  findRelease,
  parseVersion,
  RELEASES,
  type Release,
  releasesToShow,
} from '@studio/shared';
import { createStore, useStore } from 'zustand';
import { APP_VERSION } from '@/lib/version';

/**
 * State of the "What's new" dialog. On app load one dialog lists every release newer than the one
 * last seen, newest first. Closing it ("Got it", Esc or a click outside) remembers the current
 * version, so the next load shows nothing until a newer release exists.
 *
 * The logic is plain functions and one vanilla store (no React), so tests drive it directly and
 * simulate a reload by creating a second store over the same storage.
 */

/** localStorage key holding the newest version whose notes have been shown. */
export const LAST_SEEN_STORAGE_KEY = 'studio.lastSeenVersion';

/** The two `Storage` methods used here, so tests can pass a plain in-memory object. */
export interface VersionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createMemoryVersionStorage(): VersionStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

/** The browser's localStorage, or an in-memory stand-in when it is missing or blocked. */
function browserStorage(): VersionStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Reading `localStorage` itself can throw (blocked site data).
  }
  return createMemoryVersionStorage();
}

/** The stored last seen version; null if there is none, it is not X.Y.Z, or storage throws. */
export function readLastSeenVersion(storage: VersionStorage): string | null {
  try {
    const stored = storage.getItem(LAST_SEEN_STORAGE_KEY);
    return stored !== null && parseVersion(stored) !== null ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Remember that `version` has been seen. Never lowers the stored version (after a downgrade, the
 * newer notes were already seen), and never throws: private mode or a full disk just means the
 * dialog shows again next time.
 */
export function rememberVersion(storage: VersionStorage, version: string): void {
  if (parseVersion(version) === null) return;
  const stored = readLastSeenVersion(storage);
  if (stored !== null && compareVersions(stored, version) >= 0) return;
  try {
    storage.setItem(LAST_SEEN_STORAGE_KEY, version);
  } catch {
    // Best effort, see above.
  }
}

export interface WhatsNewState {
  /**
   * The releases the dialog lists, newest first. They stay after the dialog closes, so its content
   * does not vanish while it fades out; `open` says whether it is showing.
   */
  releases: readonly Release[];
  open: boolean;
}

export interface WhatsNewActions {
  /** "Got it", Esc or a click outside: close the dialog and remember the current version. */
  close: () => void;
  /** The sidebar version button: show the notes of the running version once more. */
  openCurrent: () => void;
}

export type WhatsNewStore = WhatsNewState & WhatsNewActions;

export interface WhatsNewOptions {
  storage?: VersionStorage;
  releases?: readonly Release[];
  currentVersion?: string;
}

/** Newest first. A copy, so the caller's list keeps its order. */
function newestFirst(releases: readonly Release[]): Release[] {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Build the store. Reads the last seen version from `storage` once, now, to decide what to show.
 * If there is nothing to show the current version is remembered right away.
 */
export function createWhatsNewStore(options: WhatsNewOptions = {}) {
  const { storage = browserStorage(), releases = RELEASES, currentVersion = APP_VERSION } = options;

  // `pnpm demo` builds with VITE_DEMO: a first look has no earlier version to catch up from.
  const unseen = import.meta.env.VITE_DEMO
    ? []
    : newestFirst(releasesToShow(releases, readLastSeenVersion(storage), currentVersion));
  if (unseen.length === 0) rememberVersion(storage, currentVersion);

  return createStore<WhatsNewStore>()((set, get) => ({
    releases: unseen,
    open: unseen.length > 0,

    close: () => {
      if (!get().open) return;
      set({ open: false });
      rememberVersion(storage, currentVersion);
    },

    openCurrent: () => {
      // Already showing (the unseen releases, say): the button sits behind the dialog anyway.
      if (get().open) return;
      const release = findRelease(releases, currentVersion);
      if (release) set({ releases: [release], open: true });
    },
  }));
}

/** The app-wide store, backed by this browser's localStorage. */
export const whatsNewStore = createWhatsNewStore();

export function useWhatsNewStore<T>(selector: (state: WhatsNewStore) => T): T {
  return useStore(whatsNewStore, selector);
}
