import { createStore, type StoreApi } from 'zustand';
import {
  browserWindow,
  notificationPermission,
  type Permission,
  type PushWindow,
} from './push-browser';

/**
 * What the phone remembers about its notifications, in this browser:
 * - `deviceId`: the engine's id for this phone once notifications are on (`POST
 *   /api/push/devices`), so Settings can read and change its switches. Kept in localStorage.
 * - `cardMemory`: the "Turn on notifications" card on the Jobs page was put away ("Not now") or
 *   has told how to allow notifications in iOS Settings after a refusal. Either way it does not
 *   come back; Settings keeps "Turn on". Kept in localStorage.
 * - `permission`: `Notification.permission`, which the browser does not announce when it changes.
 *   It is read again after a Turn on and whenever the app comes back to the front (the person may
 *   have allowed notifications in iOS Settings meanwhile).
 */

/** localStorage key of the device id. Bump the `v1` suffix with the shape. */
export const PUSH_DEVICE_KEY = 'studio.push.deviceId.v1';
/** localStorage key of the card's memory (`dismissed` or `told`). */
export const NOTIFY_CARD_KEY = 'studio.notifyCard.v1';

export type NotifyCardMemory = 'dismissed' | 'told' | null;

export interface PushState {
  deviceId: string | null;
  cardMemory: NotifyCardMemory;
  permission: Permission;
}

export interface PushActions {
  setDeviceId: (id: string | null) => void;
  rememberCard: (memory: Exclude<NotifyCardMemory, null>) => void;
  refreshPermission: () => void;
}

export type PushStore = PushState & PushActions;

/** The two `Storage` methods used here. */
export interface PushStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function read(storage: PushStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    // Blocked site data: nothing is remembered.
    return null;
  }
}

function write(storage: PushStorage | null, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Blocked site data or a full quota: it is kept for this visit only.
  }
}

function toCardMemory(value: string | null): NotifyCardMemory {
  return value === 'dismissed' || value === 'told' ? value : null;
}

/** A push store over `storage` and `win`. Tests pass their own; the app uses the browser's. */
export function createPushStore(
  storage: PushStorage | null,
  win: PushWindow | null,
): StoreApi<PushStore> {
  const deviceId = read(storage, PUSH_DEVICE_KEY);
  return createStore<PushStore>()((set) => ({
    deviceId: deviceId === '' ? null : deviceId,
    cardMemory: toCardMemory(read(storage, NOTIFY_CARD_KEY)),
    permission: win === null ? 'default' : notificationPermission(win),
    setDeviceId: (id) => {
      write(storage, PUSH_DEVICE_KEY, id);
      set({ deviceId: id });
    },
    rememberCard: (memory) => {
      write(storage, NOTIFY_CARD_KEY, memory);
      set({ cardMemory: memory });
    },
    refreshPermission: () => {
      if (win !== null) set({ permission: notificationPermission(win) });
    },
  }));
}

function browserStorage(): PushStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Reading `window.localStorage` can throw (blocked site data).
    return null;
  }
}

/** The app's push store. */
export const pushStore = createPushStore(browserStorage(), browserWindow());
