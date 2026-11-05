import type { PushDevice } from '@studio/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useStore } from 'zustand';
import { pushApi } from './push-api';
import {
  browserWindow,
  type PushRegistrationLike,
  type PushSupport,
  pushSupport,
} from './push-browser';
import { pushStore } from './push-store';
import { type TurnOnResult, turnOnNotifications } from './turn-on';

/** The query of this phone's device on the engine (`GET /api/push/devices/:id`). */
export const pushDeviceKey = (id: string) => ['push-device', id] as const;
/** The query of the engine's VAPID key, fetched ahead of a Turn on. */
export const PUSH_KEY_KEY = ['push-key'] as const;

/**
 * Where this window stands for notifications. Read once: a page does not move in or out of the
 * Home Screen app. A render without a window (the tests' static markup) is a browser tab.
 */
export function usePushSupport(): PushSupport {
  const [support] = useState<PushSupport>(() => {
    const win = browserWindow();
    return win === null ? 'browser' : pushSupport(win);
  });
  return support;
}

/** The service worker's registration once it is active. Never settles where there is none. */
export function serviceWorkerReady(): Promise<PushRegistrationLike> {
  return navigator.serviceWorker.ready as Promise<unknown> as Promise<PushRegistrationLike>;
}

/**
 * This phone's device on the engine: `undefined` while it loads (or while notifications are not
 * on), `null` when the engine no longer has it. Shared by Settings and the app badge.
 */
export function usePushDevice(support: PushSupport) {
  const deviceId = useStore(pushStore, (state) => state.deviceId);
  const permission = useStore(pushStore, (state) => state.permission);
  const enabled = support === 'supported' && permission === 'granted' && deviceId !== null;
  const query = useQuery({
    queryKey: pushDeviceKey(deviceId ?? ''),
    queryFn: ({ signal }) => pushApi.getDevice(deviceId ?? '', signal),
    enabled,
    retry: 1,
  });
  return {
    deviceId,
    device: enabled ? query.data : undefined,
    failed: enabled && query.isError,
    refetch: query.refetch,
  };
}

/** The engine's key, asked for as soon as a Turn on is offered, so the tap has it already. */
export function usePushKey(wanted: boolean): string | undefined {
  const query = useQuery({
    queryKey: PUSH_KEY_KEY,
    queryFn: ({ signal }) => pushApi.getKey(signal),
    enabled: wanted,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return query.data;
}

/** Remembers `device` as this phone's (here and in the query cache). */
export function useRememberDevice(): (device: PushDevice) => void {
  const queryClient = useQueryClient();
  return (device) => {
    queryClient.setQueryData(pushDeviceKey(device.id), device);
    pushStore.getState().setDeviceId(device.id);
  };
}

/**
 * Turn on, for the card and Settings: `turnOn` must be called straight from the tap's handler (see
 * `turnOnNotifications`). It remembers the device when it worked and reads the permission again
 * whatever the answer; `working` is true until it settles and `error` holds the last failure.
 */
export function useTurnOn(publicKey: string | undefined) {
  const remember = useRememberDevice();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function turnOn(): Promise<TurnOnResult> {
    const win = browserWindow();
    const notification = win?.Notification;
    // The question first, inside the tap: nothing may be awaited before it.
    const done = turnOnNotifications({
      requestPermission: () =>
        notification ? notification.requestPermission() : Promise.resolve('denied'),
      registration: serviceWorkerReady,
      publicKey,
      api: pushApi,
    });
    setWorking(true);
    setError(null);
    return done.then((result) => {
      setWorking(false);
      pushStore.getState().refreshPermission();
      if (result.kind === 'on') remember(result.device);
      if (result.kind === 'failed') setError(`Couldn’t turn notifications on. ${result.message}`);
      return result;
    });
  }

  return { turnOn, working, error, setError };
}
