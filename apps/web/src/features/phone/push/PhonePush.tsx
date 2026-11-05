import type { Job } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { openReview } from '@/features/review/review-dialog';
import { appBadgeCount, showAppBadge } from './app-badge';
import { syncPushDevice } from './device-sync';
import { pushApi } from './push-api';
import { SERVICE_WORKER_URL, SW_DEVICE_MESSAGE, SW_OPEN_MESSAGE } from './push-browser';
import { isAppPath, reviewLanding } from './push-landing';
import { pushStore } from './push-store';
import { pushDeviceKey, serviceWorkerReady, usePushDevice, usePushSupport } from './use-push';

/**
 * Notifications' part of the phone shell (`PhoneShell` mounts it; it draws nothing):
 *
 * - In the Home Screen app with web push it registers the service worker (public/sw.js). Nowhere
 *   else: iOS has no web push in a browser tab, and the Mac never registers it.
 * - It follows the worker's messages: a tapped notification's address is opened with the router
 *   (no reload), and a new subscription's device becomes this phone's.
 * - Once per open, with notifications allowed, it brings the engine and this phone back in step
 *   (`syncPushDevice`).
 * - While the app is open it keeps the count on the app icon equal to Review + Needs attention, and
 *   clears it at 0 or when "Count on the app icon" is off.
 * - It reads the permission again when the app comes back to the front.
 * - An address that asks for a job's Review (`?job=<id>&review=1`, the "Ready to review" ping)
 *   opens the job's sheet with the phone Review over it (PH8), see push-landing.ts.
 */
export function PhonePush({ jobs }: { jobs: readonly Job[] | undefined }) {
  const support = usePushSupport();
  const router = useRouter();
  const queryClient = useQueryClient();
  const permission = useStore(pushStore, (state) => state.permission);
  const { device } = usePushDevice(support);
  const supported = support === 'supported';

  // The service worker, and its messages.
  useEffect(() => {
    if (!supported) return;
    const container = navigator.serviceWorker;
    void container
      .register(SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' })
      .catch((error: unknown) =>
        console.warn('Studio Engine: the service worker did not register', error),
      );
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; url?: unknown; id?: unknown };
      if (message.type === SW_OPEN_MESSAGE && isAppPath(message.url)) {
        void router.navigate({ href: message.url });
      }
      if (message.type === SW_DEVICE_MESSAGE && typeof message.id === 'string') {
        void queryClient.invalidateQueries({ queryKey: pushDeviceKey(message.id) });
        pushStore.getState().setDeviceId(message.id);
      }
    };
    container.addEventListener('message', onMessage);
    container.startMessages();
    return () => container.removeEventListener('message', onMessage);
  }, [supported, router, queryClient]);

  // The permission may change in iOS Settings while the app is in the background.
  useEffect(() => {
    if (!supported) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') pushStore.getState().refreshPermission();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [supported]);

  // Once per open: the engine and this phone back in step.
  const synced = useRef(false);
  useEffect(() => {
    if (!supported || permission !== 'granted' || synced.current) return;
    synced.current = true;
    void serviceWorkerReady()
      .then((registration) =>
        syncPushDevice({ registration, storedId: pushStore.getState().deviceId, api: pushApi }),
      )
      .then((synced) => {
        if (synced !== null) queryClient.setQueryData(pushDeviceKey(synced.id), synced);
        pushStore.getState().setDeviceId(synced?.id ?? null);
      })
      .catch(() => {
        // The engine is out of reach: the next open tries again.
      });
  }, [supported, permission, queryClient]);

  // The count on the app icon, while the app is open.
  const badgeOn = device?.events.badge !== false;
  const count = jobs === undefined ? null : appBadgeCount(jobs);
  useEffect(() => {
    if (!supported || permission !== 'granted' || count === null) return;
    void showAppBadge(navigator, badgeOn ? count : 0);
  }, [supported, permission, count, badgeOn]);

  // A notification asked for a job's Review: the job's sheet, with the phone Review over it (PH8).
  // Closing the review gives the sheet back. A job no longer in Review gets only its sheet.
  const reviewJob = useRouterState({ select: (state) => reviewLanding(state.location.search) });
  useEffect(() => {
    if (reviewJob === null) return;
    void router.navigate({ to: '/jobs', search: { job: reviewJob }, replace: true });
    openReview(reviewJob);
  }, [reviewJob, router]);

  return null;
}
