import { useEffect, useState, useSyncExternalStore } from 'react';
import { useHealth } from '@/data';
import { MOBILE_BREAKPOINT } from '@/hooks/use-mobile';

/**
 * Which layout the app is in. `pending` is a narrow window that does not know yet whether the
 * phone layout is on: the engine's health answer is not in and nothing was remembered from an
 * earlier visit. It draws nothing (see App), so the Mac layout never flashes on a phone.
 */
export type PhoneLayoutState = 'pending' | 'phone' | 'mac';

/**
 * The layout from what is known: the phone layout shows when the Phone switch is on and the window
 * is narrower than 768 px; everything else is the Mac layout. Pure, so the rule is tested without a
 * browser.
 *
 * The switch is the engine's answer (`/api/health`) when it is in. Until then, and when it never
 * comes (the Mac is out of reach on a cold open), it is what the last answer said, kept in this
 * browser: a phone that opened the app before starts straight in the phone layout, with the
 * offline screen if the Mac cannot be reached. A window that is not narrow is the Mac layout
 * whatever the switch says, so it never waits for the answer.
 */
export function phoneLayoutState(input: {
  /** The switch, from the health answer; `undefined` while there is no answer. */
  phone: boolean | undefined;
  /** The health answer has neither arrived nor failed yet. */
  healthPending: boolean;
  /** The window is narrower than 768 px. */
  isMobile: boolean;
  /** The switch as the last health answer left it in this browser; `null` when never. */
  remembered: boolean | null;
}): PhoneLayoutState {
  if (!input.isMobile) return 'mac';
  const known = input.phone ?? input.remembered;
  if (known === true) return 'phone';
  if (known === false) return 'mac';
  return input.healthPending ? 'pending' : 'mac';
}

/** localStorage key of the last known Phone switch. Bump the `v1` suffix with the shape. */
export const PHONE_SWITCH_KEY = 'studio.phone.switch.v1';

/** The two `Storage` methods used here. */
export interface SwitchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserSwitchStorage(): SwitchStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Reading `window.localStorage` can throw (blocked site data).
    return null;
  }
}

/** The switch the last health answer left in `storage`; `null` when there is none or it is odd. */
export function readRememberedPhoneSwitch(
  storage: SwitchStorage | null = browserSwitchStorage(),
): boolean | null {
  try {
    const stored = storage?.getItem(PHONE_SWITCH_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // Blocked site data: nothing is remembered.
  }
  return null;
}

/** Keeps the switch for the next cold open. Never throws. */
export function rememberPhoneSwitch(
  phone: boolean,
  storage: SwitchStorage | null = browserSwitchStorage(),
): void {
  try {
    storage?.setItem(PHONE_SWITCH_KEY, phone ? '1' : '0');
  } catch {
    // Blocked site data or a full quota: the next open waits for the answer instead.
  }
}

const NARROW_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Whether the window is narrower than 768 px, read at the first render (the sidebar's
 * `useIsMobile` reads it in an effect, after a first paint in the wrong layout) and kept current.
 * A render with no window (the tests' static markup) says no.
 */
function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW_QUERY);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/**
 * The layout state, for the places that must not act on a guess: App draws nothing while it is
 * `pending`, and the redirect that sends the Mac layout away from a phone-only address
 * (`/settings`) waits for it. Everything else reads {@link usePhoneLayout}.
 */
export function usePhoneLayoutState(): PhoneLayoutState {
  const health = useHealth();
  const isMobile = useNarrowWindow();
  // Read once, as the page opens: later answers change the layout through `health.data`.
  const [remembered] = useState(() => readRememberedPhoneSwitch());
  const phone = health.data?.phone;
  useEffect(() => {
    if (phone !== undefined) rememberPhoneSwitch(phone);
  }, [phone]);
  return phoneLayoutState({ phone, healthPending: health.isPending, isMobile, remembered });
}

/**
 * Whether the phone layout is showing: the Phone switch is on and the window is narrower than 768
 * px. False otherwise, and before either is known. Every phone component reads this hook and
 * nothing else to decide what it looks like.
 */
export function usePhoneLayout(): boolean {
  return usePhoneLayoutState() === 'phone';
}
