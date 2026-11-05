import {
  type FeatureSwitchKey,
  INSTAGRAM_ACTIVE_DAYS,
  type InstagramClients,
} from '@studio/shared';
import { ApiError } from '@/data';

/** The words of the Settings page. */
export const SETTINGS_TEXT = {
  title: 'Settings',
  intro:
    'Turn off the parts of Studio Engine you don’t use, and choose how Claude runs are billed.',
  featuresTitle: 'Features',
  claudeTitle: 'Claude',
  off: 'Off',
  restartNeeded: 'Changes count after the engine restarts. Edits in progress pick up again.',
  restart: 'Restart engine',
  restarting: 'Restarting…',
  restartFailed: 'The engine didn’t come back. Check it, then reload this page.',
  cannotRestart: 'This engine can’t restart itself. Restart it yourself to apply the changes.',
  saveFailed: 'Couldn’t save that.',
  loading: 'Loading…',
  unreachable: 'Couldn’t reach the engine.',
  retry: 'Try again',
} as const;

/** What each switch is, in plain words. */
export const FEATURE_TEXT: Record<FeatureSwitchKey, { label: string; description: string }> = {
  graphics: {
    label: 'Graphics',
    description: 'A library of graphics made in a chat, which your edits can use.',
  },
  fonts: {
    label: 'Fonts',
    description: 'See every font in English and Hebrew, import more, and name one in a note.',
  },
  luts: {
    label: 'LUTs',
    description: 'See, preview and import colour LUTs, and name one in a note.',
  },
  draftChat: {
    label: 'Draft & chat',
    description:
      'Each edit is one video-use run that reads the instructions itself, and Review is a chat with everything it says, runs and looks at.',
  },
  twoJobsAtOnce: {
    label: 'Two jobs at once',
    description:
      'Two videos edit at the same time, so the line moves faster. Turn it off to edit one at a time.',
  },
  quickFixes: {
    label: 'Quick fixes',
    description:
      'With Auto effort in Review, small notes (a font, a caption’s words, a colour) are fixed right away. Turn it off to have every note wait for Send.',
  },
  // Board CLStates S7. The switch is the whole of Clients × Instagram: off, no scan runs and the
  // client page, its menus and the Instagram photos show nothing of it.
  instagram: {
    label: 'Weekly Instagram scan',
    description: 'Every Monday at 06:00 · about $0.05 a client a week, shares included',
  },
  claudePlanOnly: {
    label: 'Claude plan only',
    description:
      'Every Claude run uses your claude.ai plan login and never the API. Turn it off to bill the API key in the .env file instead.',
  },
};

/** The server's own words for a refusal (an environment variable decides, config.json is broken). */
export function settingsErrorText(
  error: unknown,
  fallback: string = SETTINGS_TEXT.saveFailed,
): string {
  if (error instanceof ApiError && error.message !== '') return error.message;
  return fallback;
}

/** What a switch that waits for the restart will do. */
export function pendingText(label: string, saved: boolean): string {
  return saved ? `${label} turns on after the restart.` : `${label} turns off after the restart.`;
}

/** The words of Which clients, under the weekly Instagram scan (board CLStates S7). */
export const INSTAGRAM_CLIENTS_TEXT = {
  label: 'Which clients',
  active: 'Active',
  all: 'All',
} as const;

/**
 * What the chosen one means: Active skips the clients with no job added or delivered in the last 60
 * days (an account added in that time counts as active, so a new client is read at once); All
 * reads every client that has an account.
 */
export function instagramClientsHint(choice: InstagramClients): string {
  return choice === 'active'
    ? `Clients with no job added or delivered in the last ${INSTAGRAM_ACTIVE_DAYS} days are skipped, unless their account was added in that time.`
    : 'Every client with an Instagram account is scanned.';
}

/** What a saved Which clients that waits for the restart will do. */
export function instagramClientsPendingText(saved: InstagramClients): string {
  return `Which clients changes to ${saved === 'active' ? 'Active' : 'All'} after the restart.`;
}
