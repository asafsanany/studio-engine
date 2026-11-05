import { describe, expect, it } from 'vitest';
import {
  INSTALL_CARD_DISMISSED_KEY,
  INSTALL_CARD_SNOOZE_MS,
  type InstallCardStorage,
  type InstallCardWindow,
  installCardWanted,
  isIosBrowser,
  isStandalone,
  readDismissedAt,
  rememberInstallCardDismissed,
  shouldShowInstallCard,
} from './install-card';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(initial: Record<string, string> = {}): InstallCardStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function windowOf(options: {
  userAgent?: string;
  navigatorStandalone?: boolean;
  displayModeStandalone?: boolean;
  storage?: InstallCardStorage;
}): InstallCardWindow {
  return {
    navigator: { userAgent: options.userAgent ?? IPHONE, standalone: options.navigatorStandalone },
    matchMedia: (query) => ({
      matches: query === '(display-mode: standalone)' && options.displayModeStandalone === true,
    }),
    localStorage: options.storage ?? memoryStorage(),
  };
}

describe('isIosBrowser', () => {
  it('is true for an iPhone, an iPad and an iPod, in any browser on them', () => {
    expect(isIosBrowser(IPHONE)).toBe(true);
    expect(isIosBrowser(IPHONE.replace('Version/17.5', 'CriOS/126.0.6478.153'))).toBe(true);
    expect(isIosBrowser('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15')).toBe(
      true,
    );
    expect(isIosBrowser('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)')).toBe(true);
  });

  it('is false for a Mac and for Android', () => {
    expect(isIosBrowser(MAC)).toBe(false);
    expect(isIosBrowser(ANDROID)).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true when Safari says navigator.standalone', () => {
    expect(isStandalone(windowOf({ navigatorStandalone: true }))).toBe(true);
  });

  it('is true when the display-mode: standalone media query matches', () => {
    expect(isStandalone(windowOf({ displayModeStandalone: true }))).toBe(true);
  });

  it('is false in a browser tab: navigator.standalone false or missing, the query not matching', () => {
    expect(isStandalone(windowOf({ navigatorStandalone: false }))).toBe(false);
    expect(isStandalone(windowOf({}))).toBe(false);
  });

  it('is false in a browser with no matchMedia', () => {
    const win = windowOf({});
    delete win.matchMedia;
    expect(isStandalone(win)).toBe(false);
  });
});

describe('readDismissedAt', () => {
  it('is null when never dismissed', () => {
    expect(readDismissedAt(memoryStorage())).toBeNull();
  });

  it('reads the stored time', () => {
    const storage = memoryStorage({ [INSTALL_CARD_DISMISSED_KEY]: String(NOW) });
    expect(readDismissedAt(storage)).toBe(NOW);
  });

  it('is null for a value that is not a time, and when storage throws', () => {
    expect(
      readDismissedAt(memoryStorage({ [INSTALL_CARD_DISMISSED_KEY]: 'yesterday' })),
    ).toBeNull();
    const blocked: InstallCardStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    };
    expect(readDismissedAt(blocked)).toBeNull();
  });
});

describe('shouldShowInstallCard', () => {
  const base = { userAgent: IPHONE, standalone: false, dismissedAt: null, now: NOW };

  it('shows on an iPhone, in the browser, when never dismissed', () => {
    expect(shouldShowInstallCard(base)).toBe(true);
  });

  it('does not show in the Home Screen app', () => {
    expect(shouldShowInstallCard({ ...base, standalone: true })).toBe(false);
  });

  it('does not show away from an iPhone (the Mac, a narrow desktop window, Android)', () => {
    expect(shouldShowInstallCard({ ...base, userAgent: MAC })).toBe(false);
    expect(shouldShowInstallCard({ ...base, userAgent: ANDROID })).toBe(false);
  });

  it('stays away for 30 days after “Not now”, then comes back', () => {
    const dismissedAt = NOW - 29 * DAY;
    expect(shouldShowInstallCard({ ...base, dismissedAt })).toBe(false);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW })).toBe(false);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - INSTALL_CARD_SNOOZE_MS + 1 })).toBe(
      false,
    );
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - INSTALL_CARD_SNOOZE_MS })).toBe(
      true,
    );
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - 31 * DAY })).toBe(true);
  });

  it('shows when the dismissed time is in the future (the clock was set back)', () => {
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW + DAY })).toBe(true);
  });

  it('keeps the Home Screen app card-free however long ago it was dismissed', () => {
    expect(shouldShowInstallCard({ ...base, standalone: true, dismissedAt: NOW - 90 * DAY })).toBe(
      false,
    );
  });
});

describe('installCardWanted and rememberInstallCardDismissed', () => {
  it('shows, then stays away for 30 days after it is put away, then shows again', () => {
    const storage = memoryStorage();
    const win = windowOf({ storage });

    expect(installCardWanted(win, NOW)).toBe(true);
    rememberInstallCardDismissed(win, NOW);
    expect(storage.items.get(INSTALL_CARD_DISMISSED_KEY)).toBe(String(NOW));

    expect(installCardWanted(win, NOW + 1)).toBe(false);
    expect(installCardWanted(win, NOW + 29 * DAY)).toBe(false);
    expect(installCardWanted(win, NOW + 30 * DAY)).toBe(true);
  });

  it('reads the Home Screen app and the media query', () => {
    expect(installCardWanted(windowOf({ navigatorStandalone: true }), NOW)).toBe(false);
    expect(installCardWanted(windowOf({ displayModeStandalone: true }), NOW)).toBe(false);
  });

  it('works when localStorage is blocked: shows, and putting it away does not throw', () => {
    const blocked: InstallCardStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const win = windowOf({ storage: blocked });
    expect(installCardWanted(win, NOW)).toBe(true);
    expect(() => rememberInstallCardDismissed(win, NOW)).not.toThrow();
  });
});
