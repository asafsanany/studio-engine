/**
 * When the "Add to Home Screen" card shows (board MFirstOpen): on an iPhone, in the browser (not in
 * the Home Screen app it explains how to make), and not within 30 days of the last time it was put
 * away. Plain functions over a window-shaped object, so the rules are tested without a browser.
 *
 * The Mac never sees the card: it sits on the phone's jobs page, which only the phone layout shows,
 * and the iPhone test keeps it off a narrow desktop window that has the phone layout too.
 */

/** localStorage key: when "Not now" or "Got it" was last pressed, in milliseconds since 1970. */
export const INSTALL_CARD_DISMISSED_KEY = 'studio.installCard.dismissedAt';

/** How long "Not now" keeps the card away. */
export const INSTALL_CARD_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** The two `Storage` methods used here. */
export interface InstallCardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of `window` the card reads, so tests pass a plain object. */
export interface InstallCardWindow {
  navigator: {
    userAgent: string;
    /** Safari only: true when the page was opened from the Home Screen. */
    standalone?: boolean;
  };
  matchMedia?: (query: string) => { matches: boolean };
  localStorage: InstallCardStorage;
}

/** Whether the browser says it is an iPhone or iPad (Safari, and Chrome, Firefox and Edge on iOS). */
export function isIosBrowser(userAgent: string): boolean {
  return /\b(?:iPhone|iPad|iPod)\b/.test(userAgent);
}

/**
 * Whether the page was opened from the Home Screen: Safari's `navigator.standalone`, or the
 * `display-mode: standalone` media query (what the manifest asks for, and what other browsers say).
 */
export function isStandalone(win: InstallCardWindow): boolean {
  if (win.navigator.standalone === true) return true;
  return win.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** The time the card was put away, or null when it never was or the value is not a time. */
export function readDismissedAt(storage: InstallCardStorage): number | null {
  try {
    const stored = storage.getItem(INSTALL_CARD_DISMISSED_KEY);
    if (stored === null) return null;
    const at = Number(stored);
    return Number.isFinite(at) ? at : null;
  } catch {
    // Reading `localStorage` can throw (blocked site data): the card just comes back.
    return null;
  }
}

/**
 * Whether the card shows: in an iPhone browser, not standalone, and not put away in the last 30
 * days. A "put away" time in the future (the clock was set back) counts as never.
 */
export function shouldShowInstallCard(input: {
  userAgent: string;
  standalone: boolean;
  dismissedAt: number | null;
  now: number;
}): boolean {
  if (!isIosBrowser(input.userAgent) || input.standalone) return false;
  if (input.dismissedAt === null) return true;
  const sinceDismissed = input.now - input.dismissedAt;
  return sinceDismissed < 0 || sinceDismissed >= INSTALL_CARD_SNOOZE_MS;
}

/** The card's answer for this window and moment. */
export function installCardWanted(win: InstallCardWindow, now: number): boolean {
  let dismissedAt: number | null = null;
  try {
    dismissedAt = readDismissedAt(win.localStorage);
  } catch {
    // `window.localStorage` itself can throw, see `readDismissedAt`.
  }
  return shouldShowInstallCard({
    userAgent: win.navigator.userAgent,
    standalone: isStandalone(win),
    dismissedAt,
    now,
  });
}

/** Put the card away for 30 days. Never throws: private mode or a full disk just bring it back. */
export function rememberInstallCardDismissed(win: InstallCardWindow, now: number): void {
  try {
    win.localStorage.setItem(INSTALL_CARD_DISMISSED_KEY, String(now));
  } catch {
    // Best effort, see above.
  }
}
