import type { PushDevice, PushEventKey } from '@studio/shared';
import type { Permission, PushSupport } from './push-browser';

/** One switch of the section: its name and what it covers (board MSettings). */
export interface PushEventRow {
  key: PushEventKey;
  label: string;
  description: string;
}

/** The section's switches, in the engine's order (`PUSH_EVENT_KEYS`), with the board's words. */
export const PUSH_EVENT_ROWS: readonly PushEventRow[] = [
  { key: 'review', label: 'Ready to review', description: 'An edit is waiting for your notes' },
  {
    key: 'failed',
    label: 'Failed',
    description: 'A job stopped with an error, a Claude usage limit too',
  },
  {
    key: 'approved',
    label: 'Approved · ready to send',
    description: 'The final video is rendered after you approve',
  },
  { key: 'queueEmpty', label: 'Queue is empty', description: 'Everything you dropped in is done' },
  {
    key: 'badge',
    label: 'Count on the app icon',
    description: 'Jobs in Review or needing attention',
  },
];

/** "Send a test", then "Test sent to this phone" for a moment (TEST_SENT_MS). */
export type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'failed'; message: string };

/** How long "Test sent to this phone" stays before the button reads "Send a test" again. */
export const TEST_SENT_MS = 2_500;

/** The section, as Settings draws it. `on` is the On/Off beside its title. */
export type NotificationsSection =
  /** Not the Home Screen app: there are no notifications to offer (board MSettingsBasic). */
  | { kind: 'hidden' }
  /** The Home Screen app on an iOS without web push. */
  | { kind: 'unsupported'; on: false; text: string }
  /** Refused: only iOS Settings can change it. */
  | { kind: 'denied'; on: false; text: string }
  /** Not on yet, or the engine no longer has this phone: the Turn on button. */
  | { kind: 'turn-on'; on: false; working: boolean; error: string | null }
  /** On, the switches still on their way from the engine. */
  | { kind: 'loading'; on: true }
  /** On, but the switches could not be read. */
  | { kind: 'error'; on: true; text: string }
  /** On: a switch per event and the test button. */
  | {
      kind: 'on';
      on: true;
      rows: readonly (PushEventRow & { checked: boolean })[];
      test: { label: string; busy: boolean; error: string | null };
      error: string | null;
    };

export const UNSUPPORTED_TEXT = 'Notifications need iOS 16.4 or later on this iPhone.';
export const DENIED_TEXT =
  'Notifications are off for Studio Engine. To allow them, open the iPhone’s Settings, tap Notifications, then Studio Engine, and turn on Allow Notifications.';
export const DEVICE_ERROR_TEXT = 'Couldn’t read this phone’s notifications from your Mac.';
export const TURN_ON_TEXT = 'Get a notification when a job needs you.';

/**
 * The section from what is known. `device` is the engine's answer for the stored id: `undefined`
 * while it is on its way, `null` when the engine no longer has this phone. `turnOn` is a Turn on
 * in progress or its last failure; `error` a switch change that did not save.
 */
export function notificationsSection(input: {
  support: PushSupport;
  permission: Permission;
  deviceId: string | null;
  device: PushDevice | null | undefined;
  deviceFailed?: boolean;
  turnOn?: { working: boolean; error: string | null };
  test?: TestState;
  error?: string | null;
}): NotificationsSection {
  if (input.support === 'browser') return { kind: 'hidden' };
  if (input.support === 'unsupported')
    return { kind: 'unsupported', on: false, text: UNSUPPORTED_TEXT };
  if (input.permission === 'denied') return { kind: 'denied', on: false, text: DENIED_TEXT };

  const turnOn = input.turnOn ?? { working: false, error: null };
  if (input.permission !== 'granted' || input.deviceId === null || input.device === null) {
    return { kind: 'turn-on', on: false, ...turnOn };
  }
  if (input.device === undefined) {
    return input.deviceFailed === true
      ? { kind: 'error', on: true, text: DEVICE_ERROR_TEXT }
      : { kind: 'loading', on: true };
  }

  const { events } = input.device;
  const test = input.test ?? { kind: 'idle' };
  return {
    kind: 'on',
    on: true,
    rows: PUSH_EVENT_ROWS.map((row) => ({ ...row, checked: events[row.key] })),
    test: {
      label:
        test.kind === 'sent'
          ? 'Test sent to this phone'
          : test.kind === 'sending'
            ? 'Sending…'
            : 'Send a test',
      busy: test.kind === 'sending',
      error: test.kind === 'failed' ? test.message : null,
    },
    error: input.error ?? null,
  };
}
