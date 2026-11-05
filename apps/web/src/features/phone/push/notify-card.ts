import type { Permission, PushSupport } from './push-browser';
import type { NotifyCardMemory } from './push-store';

/**
 * Whether the Jobs page shows the "Turn on notifications" card (board MTurnOn): in the Home
 * Screen app with web push, while notifications are not on yet (never asked, or allowed but this
 * phone is not registered), and never again once it was put away ("Not now") or has told how to
 * allow notifications after a refusal. A refusal made before is not brought up again either:
 * Settings says how to change it.
 */
export function notifyCardWanted(input: {
  support: PushSupport;
  permission: Permission;
  hasDevice: boolean;
  memory: NotifyCardMemory;
}): boolean {
  if (input.support !== 'supported' || input.memory !== null) return false;
  if (input.permission === 'default') return true;
  return input.permission === 'granted' && !input.hasDevice;
}

/** The card's words (board MFirstOpen, step notify). */
export const NOTIFY_CARD_TITLE = 'Turn on notifications';
export const NOTIFY_CARD_BODY =
  'Get a notification when an edit is ready to review, when a job fails and when a final video is ready to send. You can pick which ones in Settings.';

/** Said once, after the person refused: how to allow notifications later. */
export const NOTIFY_DENIED_TITLE = 'Notifications are off';
export const NOTIFY_DENIED_BODY =
  'To turn them on later, open the iPhone’s Settings, tap Notifications, then Studio Engine, and turn on Allow Notifications.';
