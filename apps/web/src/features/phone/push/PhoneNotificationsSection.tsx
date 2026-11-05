import type { PushEventKey } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/data/api';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import {
  type NotificationsSection,
  notificationsSection,
  PUSH_EVENT_ROWS,
  TEST_SENT_MS,
  type TestState,
  TURN_ON_TEXT,
} from './notifications-view';
import { pushApi } from './push-api';
import { pushStore } from './push-store';
import {
  pushDeviceKey,
  serviceWorkerReady,
  usePushDevice,
  usePushKey,
  usePushSupport,
  useTurnOn,
} from './use-push';

/** The message of a failed request, for the line under the switches. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/** The engine no longer has this device (404) or its subscription is gone (410). */
function deviceGone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 410);
}

/**
 * "Notifications on this phone" in Settings (board MSettings), in the slot PH5 left above "This
 * phone". Only in the Home Screen app: a browser tab has no web push on iOS, so there it draws
 * nothing (board MSettingsBasic). With notifications on: a switch per event, each saved on the
 * engine as it is flipped (`PUT /api/push/devices/:id`), and "Send a test", which reads "Test sent
 * to this phone" for 2.5 s. Before that, or once the engine no longer has this phone, "Turn on";
 * after a refusal, how to allow notifications in iOS Settings.
 */
export function PhoneNotificationsSection() {
  const support = usePushSupport();
  const permission = useStore(pushStore, (state) => state.permission);
  const { deviceId, device, failed } = usePushDevice(support);
  const queryClient = useQueryClient();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const testTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(testTimer.current), []);

  const offersTurnOn =
    support === 'supported' &&
    permission !== 'denied' &&
    (permission !== 'granted' || deviceId === null || device === null);
  const publicKey = usePushKey(offersTurnOn);
  const { turnOn, working, error: turnOnError, setError: setTurnOnError } = useTurnOn(publicKey);

  /** The engine dropped this phone: forget it here, and drop a dead subscription with it. */
  function forget(message: string, unsubscribe: boolean) {
    if (deviceId !== null) queryClient.removeQueries({ queryKey: pushDeviceKey(deviceId) });
    pushStore.getState().setDeviceId(null);
    setTurnOnError(message);
    if (unsubscribe) {
      void serviceWorkerReady()
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => subscription?.unsubscribe())
        .catch(() => undefined);
    }
  }

  async function flip(key: PushEventKey, checked: boolean) {
    if (deviceId === null) return;
    const queryKey = pushDeviceKey(deviceId);
    setSaveError(null);
    // Shown flipped at once; only this switch goes back if the engine does not take it.
    queryClient.setQueryData(queryKey, (old: typeof device) =>
      old ? { ...old, events: { ...old.events, [key]: checked } } : old,
    );
    try {
      queryClient.setQueryData(queryKey, await pushApi.updateDevice(deviceId, { [key]: checked }));
    } catch (error) {
      if (deviceGone(error)) {
        forget('Your Mac no longer has this phone. Turn notifications on again.', false);
        return;
      }
      queryClient.setQueryData(queryKey, (old: typeof device) =>
        old ? { ...old, events: { ...old.events, [key]: !checked } } : old,
      );
      setSaveError(`Couldn’t save that. ${messageOf(error)}`);
    }
  }

  async function sendTest() {
    if (deviceId === null) return;
    clearTimeout(testTimer.current);
    setTest({ kind: 'sending' });
    try {
      await pushApi.sendTest(deviceId);
      setTest({ kind: 'sent' });
      testTimer.current = setTimeout(() => setTest({ kind: 'idle' }), TEST_SENT_MS);
    } catch (error) {
      setTest({ kind: 'idle' });
      if (deviceGone(error)) forget(messageOf(error), true);
      else setTest({ kind: 'failed', message: messageOf(error) });
    }
  }

  const section = notificationsSection({
    support,
    permission,
    deviceId,
    device,
    deviceFailed: failed,
    turnOn: { working, error: turnOnError },
    test,
    error: saveError,
  });

  return (
    <NotificationsSectionView
      section={section}
      onTurnOn={() => void turnOn()}
      onFlip={(key, checked) => void flip(key, checked)}
      onTest={() => void sendTest()}
    />
  );
}

/** The section drawn from its view model; see {@link PhoneNotificationsSection}. */
export function NotificationsSectionView({
  section,
  onTurnOn,
  onFlip,
  onTest,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: {
  section: NotificationsSection;
  onTurnOn: () => void;
  onFlip: (key: PushEventKey, checked: boolean) => void;
  onTest: () => void;
  skeletonDelayMs?: number;
}) {
  const showSkeleton = useDelayedFlag(section.kind === 'loading', skeletonDelayMs);
  if (section.kind === 'hidden') return null;

  return (
    <section aria-labelledby="phone-settings-notifications" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2
          id="phone-settings-notifications"
          className="text-[13px] font-medium text-muted-foreground"
        >
          Notifications on this phone
        </h2>
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', section.on ? 'bg-emerald-400' : 'bg-zinc-500')}
          />
          {section.on ? 'On' : 'Off'}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border">
        {section.kind === 'on' && (
          <>
            {section.rows.map((row) => (
              <EventSwitch
                key={row.key}
                label={row.label}
                description={row.description}
                checked={row.checked}
                onCheckedChange={(checked) => onFlip(row.key, checked)}
              />
            ))}
            <div className="flex flex-col gap-2 px-3.5 py-3">
              {section.error !== null && (
                <p role="alert" className="text-[13px] text-pretty text-destructive">
                  {section.error}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full text-[15px]"
                disabled={section.test.busy}
                onClick={onTest}
              >
                <Bell aria-hidden="true" />
                <span aria-live="polite">{section.test.label}</span>
              </Button>
              {section.test.error !== null && (
                <p role="alert" className="text-[13px] text-pretty text-destructive">
                  {section.test.error}
                </p>
              )}
            </div>
          </>
        )}
        {section.kind === 'loading' &&
          (showSkeleton ? (
            <div data-slot="notifications-loading" className="flex flex-col">
              {PUSH_EVENT_ROWS.map((row) => (
                <div
                  key={row.key}
                  className="flex min-h-14 items-center gap-3 border-b px-3.5 py-2"
                >
                  <span className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-3 w-52" />
                  </span>
                  <Skeleton className="h-[26px] w-11 rounded-full" />
                </div>
              ))}
            </div>
          ) : (
            <div className="min-h-14" />
          ))}
        {section.kind === 'turn-on' && (
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <p className="text-[15px] text-pretty text-zinc-300">{TURN_ON_TEXT}</p>
            {section.error !== null && (
              <p role="alert" className="text-[13px] text-pretty text-destructive">
                {section.error}
              </p>
            )}
            <Button
              type="button"
              className="h-11 w-full text-[15px]"
              disabled={section.working}
              onClick={onTurnOn}
            >
              <Bell aria-hidden="true" />
              {section.working ? 'Turning on…' : 'Turn on'}
            </Button>
          </div>
        )}
        {(section.kind === 'denied' ||
          section.kind === 'unsupported' ||
          section.kind === 'error') && (
          <p className="px-3.5 py-3 text-[15px] text-pretty text-zinc-300">{section.text}</p>
        )}
      </div>
    </section>
  );
}

/** One event: its name, what it covers and the switch. The whole row is the target. */
function EventSwitch({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    // A label around the row, so a tap anywhere on it flips the switch (the switch is the one control).
    // The gap is 8 px, not the board's 12: the phone's switch is 44 px wide (the board draws 40), and
    // this keeps the text as wide as the board's, so "The final video is rendered after you approve"
    // stays on one line there too.
    <label
      htmlFor={id}
      className="flex min-h-14 cursor-pointer items-center gap-2 border-b px-3.5 py-2 transition-colors duration-150 ease-in-out active:bg-white/5"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-[13px] text-pretty text-muted-foreground">{description}</span>
      </span>
      <Switch id={id} size="lg" checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
