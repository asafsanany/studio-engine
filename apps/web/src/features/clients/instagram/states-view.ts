// What the Instagram section says when something other than numbers is the news (boards CLStates
// S2, S3, S8 and S9), as pure functions of the client's Instagram: the first scan is being read,
// the last scan could not run (one line per outcome, with its button), none of our videos is linked
// to a reel yet. The components (InstagramStates.tsx) only lay these out.

import { addMonths, type ClientInstagram, type InstagramScanOutcome } from '@studio/shared';
import { instantDayText, localDay, shortDayText, type TextOptions } from './instagram-text';

/** The page where Apify's credit is topped up. */
export const APIFY_BILLING_URL = 'https://console.apify.com/billing';

/** The page where the personal API token (what `APIFY_TOKEN` holds) is copied from. */
export const APIFY_TOKEN_URL = 'https://console.apify.com/settings/integrations';

/** The words of the empty section (S8). */
export const NO_ACCOUNT_TEXT = {
  title: 'Add their Instagram to see how our videos do there.',
  detail: 'It’s read once a week, about $0.05.',
  add: 'Add Instagram',
} as const;

/** The first scan (S2): `handle` is read, and it takes about a minute. */
export function readingLine(handle: string): string {
  return `Reading @${handle}… about a minute`;
}

/**
 * Whether the section is waiting for the account's first scan (S2): one is queued or running, or
 * none has ended yet (the first one is queued the moment the account is saved). While the numbers
 * are there, a scan that runs is just the head's "Scanning now".
 */
export function isFirstScan(
  data: Pick<ClientInstagram, 'numbers' | 'scanning' | 'lastScan'>,
): boolean {
  return data.numbers === null && (data.scanning || data.lastScan === null);
}

/** What the button of a scan problem does. */
export type ScanProblemAction = 'edit' | 'how-to' | 'open-apify' | 'retry';

/** How a problem looks: a quiet grey line, an amber one (something to set up), a red one. */
export type ScanProblemTone = 'muted' | 'warning' | 'error';

/** One scan problem as the section draws it (S3). */
export interface ScanProblem {
  outcome: Exclude<InstagramScanOutcome, 'ok'>;
  title: string;
  detail: string;
  action: ScanProblemAction;
  /** The button's words. */
  actionLabel: string;
  tone: ScanProblemTone;
  /** What the scan said went wrong, for people who want it (only a failed scan has one). */
  error: string | null;
}

const ACTION_LABELS: Record<ScanProblemAction, string> = {
  edit: 'Edit account',
  'how-to': 'How to',
  'open-apify': 'Open Apify',
  retry: 'Retry',
};

/**
 * The day the scans' numbers are from: the last scan that read the profile, which is what the tiles
 * show; `''` when none did (then the sentence is left out).
 */
export function numbersDay(data: ClientInstagram, options: TextOptions = {}): string {
  const line = data.numbers?.tiles.followers.line ?? [];
  const last = line.at(-1);
  return last === undefined ? '' : instantDayText(last.at, options);
}

/** The first day of the month after the one the scan ended in: "1 Nov", when Apify's credit renews. */
function creditBackDay(finishedAt: string, options: TextOptions): string {
  const day = localDay(finishedAt, options);
  if (day === '') return '';
  return shortDayText(`${addMonths(day.slice(0, 7), 1)}-01`, options);
}

/**
 * The line to show for the last scan, or `null` when there is none to show: no scan yet, the last
 * one read the page, or a scan is running now (the head says so, and a Retry that has started should
 * not still be offered). The last numbers stay under the line, so when there are some it says whose
 * day they are from.
 */
export function scanProblem(data: ClientInstagram, options: TextOptions = {}): ScanProblem | null {
  const { lastScan, account, scanning } = data;
  if (lastScan === null || scanning || lastScan.outcome === 'ok') return null;
  const from = numbersDay(data, options);
  const older = from === '' ? '' : ` The numbers are from ${from}.`;
  const base = { outcome: lastScan.outcome, error: lastScan.error } as const;
  switch (lastScan.outcome) {
    case 'private':
      return {
        ...base,
        title: 'The account is private',
        detail: `Ask them to make it public, or switch to a business account.${older}`,
        action: 'edit',
        actionLabel: ACTION_LABELS.edit,
        tone: 'muted',
      };
    case 'not-found':
      return {
        ...base,
        title: `No account called @${account?.handle ?? ''}`,
        detail: `Check the name, or paste the link from their profile.${older}`,
        action: 'edit',
        actionLabel: ACTION_LABELS.edit,
        tone: 'muted',
      };
    case 'no-token':
      return {
        ...base,
        title: 'Apify isn’t set up',
        detail: `APIFY_TOKEN is missing from .env.${older}`,
        action: 'how-to',
        actionLabel: ACTION_LABELS['how-to'],
        tone: 'warning',
      };
    case 'no-credit': {
      const back = creditBackDay(lastScan.finishedAt, options);
      return {
        ...base,
        title: 'Apify’s credit is used up',
        detail: `Scans pause until ${back === '' ? 'next month' : back}, or add credit on apify.com.${older}`,
        action: 'open-apify',
        actionLabel: ACTION_LABELS['open-apify'],
        tone: 'warning',
      };
    }
    case 'failed':
      return {
        ...base,
        title: `The scan of ${instantDayText(lastScan.finishedAt, options)} failed`,
        detail: `Instagram didn’t answer.${older}`,
        action: 'retry',
        actionLabel: ACTION_LABELS.retry,
        tone: 'error',
      };
  }
}

/** How many names of the delivered videos the line writes before it says "and 2 more". */
export const UNLINKED_NAMES_SHOWN = 3;

/** The "none linked" notice (S9): how many videos we delivered, which ones, and what to do. */
export interface UnlinkedNotice {
  title: string;
  /** How many of our videos are delivered and have no reel. */
  count: number;
  /** Their names, newest delivery first, at most {@link UNLINKED_NAMES_SHOWN}. */
  names: string[];
  /** How many more there are than `names`. */
  more: number;
  /** What follows the list: where to link them. */
  after: string;
}

/**
 * The notice for "Delivered, none linked": the numbers are there, no reel of the account is linked
 * to a video, and the client has delivered videos that could be (`linkableJobs`, which the engine
 * leaves empty for an editor, who cannot link: no notice then). `null` otherwise.
 */
export function unlinkedNotice(data: ClientInstagram): UnlinkedNotice | null {
  if (data.numbers === null || data.linkableJobs.length === 0) return null;
  if (data.reels.some((reel) => reel.job !== null)) return null;
  const jobs = [...data.linkableJobs].sort(
    (a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt),
  );
  return {
    title: 'None of our videos is linked to a reel yet.',
    count: jobs.length,
    names: jobs.slice(0, UNLINKED_NAMES_SHOWN).map((job) => job.name),
    more: Math.max(0, jobs.length - UNLINKED_NAMES_SHOWN),
    after:
      'When they are up, right-click the reel below › Link to job. Their own reels show meanwhile.',
  };
}
