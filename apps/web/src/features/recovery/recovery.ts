// Recovery from a blank screen (CVP-317, U17). Pure logic with everything it touches passed in, so
// the rules are tested without a browser; `startResumeRecovery` below wires them to the real one.
// index.html carries the same chunk-error and "never mounted" rules as plain script, for the
// moments before this file has loaded (see index.html and boot-watchdog.test.ts).

/** What the browsers say when a lazy chunk or a module cannot be fetched (Chrome, Safari, Firefox). */
const CHUNK_ERROR =
  /Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Whether `error` is a script or stylesheet that could not be fetched, as an old page asks for after a release. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return CHUNK_ERROR.test(message);
}

/** The two `Storage` methods the reload guard uses. */
export interface GuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** sessionStorage, or null when this browser will not let the page touch it. */
export function browserSessionStorage(): GuardStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** A reload for the same reason is not repeated inside this window: a loop would be worse than a blank page. */
export const RELOAD_GUARD_MS = 60_000;

/** The sessionStorage keys of the guards. */
export const CHUNK_RELOAD_KEY = 'studio.recovery.chunk.v1';
export const RESUME_RELOAD_KEY = 'studio.recovery.resume.v1';

/**
 * Reloads the page unless `key` says it already did within {@link RELOAD_GUARD_MS}. Returns whether
 * it reloaded. With no usable storage it still reloads (a reload that fixes nothing leaves the
 * person on the "Something went wrong" screen, which has a button).
 */
export function reloadGuarded(input: {
  storage: GuardStorage | null;
  key: string;
  now: number;
  reload: () => void;
}): boolean {
  try {
    const last = Number(input.storage?.getItem(input.key));
    if (Number.isFinite(last) && last > 0 && input.now - last < RELOAD_GUARD_MS) return false;
    input.storage?.setItem(input.key, String(input.now));
  } catch {
    // Blocked storage: reload anyway.
  }
  input.reload();
  return true;
}

/** What a page that was in the background should do when it comes back. */
export function resumeAction(input: {
  /** `#root` has nothing in it. */
  rootEmpty: boolean;
  /** The version this page was built as. */
  appVersion: string;
  /** The version the engine answered with; `null` when it did not answer. */
  serverVersion: string | null;
}): 'reload' | 'none' {
  if (input.rootEmpty) return 'reload';
  if (input.serverVersion !== null && input.serverVersion !== input.appVersion) return 'reload';
  return 'none';
}

/** The parts of the browser the resume check uses. */
export interface ResumeDeps {
  /** The page's `document`: the visibility event and the state. */
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  /** The page's `window`: `pageshow`. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** `#root`. */
  root: { childElementCount: number };
  appVersion: string;
  /** Asks the engine its version; `null` when it cannot be reached (then nothing is decided). */
  fetchServerVersion: () => Promise<string | null>;
  /** Compare versions at all. Off in `vite dev`, where the engine and the page are restarted apart. */
  checkVersion: boolean;
  storage: GuardStorage | null;
  now: () => number;
  reload: () => void;
}

/**
 * Checks the page when it comes back to the foreground (`visibilitychange` to visible, `pageshow`
 * after the back/forward cache): an empty `#root` (iOS ended the web process, or the first render
 * died) or a version that is not the engine's (the app stayed open across a release) reloads it.
 * Returns the function that removes the listeners.
 */
export function startResumeRecovery(deps: ResumeDeps): () => void {
  let checking = false;

  const check = async () => {
    if (checking || deps.document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const rootEmpty = deps.root.childElementCount === 0;
      const serverVersion =
        rootEmpty || !deps.checkVersion ? null : await deps.fetchServerVersion();
      if (resumeAction({ rootEmpty, appVersion: deps.appVersion, serverVersion }) === 'reload') {
        reloadGuarded({
          storage: deps.storage,
          key: RESUME_RELOAD_KEY,
          now: deps.now(),
          reload: deps.reload,
        });
      }
    } catch {
      // A failed check changes nothing: the page stays as it is.
    } finally {
      checking = false;
    }
  };

  const onVisibility = () => {
    if (deps.document.visibilityState === 'visible') void check();
  };
  const onPageShow = () => void check();
  deps.document.addEventListener('visibilitychange', onVisibility);
  deps.window.addEventListener('pageshow', onPageShow);
  return () => {
    deps.document.removeEventListener('visibilitychange', onVisibility);
    deps.window.removeEventListener('pageshow', onPageShow);
  };
}

/** The engine's version from `/api/health`; `null` when it does not answer in 5 s or answers oddly. */
export async function fetchServerVersion(): Promise<string | null> {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
