// What the client page says about the account, as pure functions: the line under "Instagram"
// ("Scanned Mon 26 Oct · next scan Mon 2 Nov") and the facts the page header adds when the client
// has an account (the handle as a link, the followers, the bio).
//
// This is one of the few places that reads a `ClientInstagram`: the account, the last scan and when
// the next one is due. The numbers of the range are read in tiles-view.ts, plays-view.ts and
// engagement-view.ts.

import type { ClientInstagram } from '@studio/shared';
import { countText, instantDayText, SEPARATOR, type TextOptions } from './instagram-text';

/** The line under "Instagram" in the section's head. */
export function scanLine(
  data: Pick<ClientInstagram, 'lastScan' | 'nextScanAt' | 'scanning'>,
  options: TextOptions = {},
): string {
  const { lastScan, nextScanAt, scanning } = data;
  const last = lastScan === null ? '' : instantDayText(lastScan.finishedAt, options);
  const parts: string[] = [];
  if (scanning) {
    parts.push('Scanning now');
    if (lastScan?.outcome === 'ok' && last !== '') parts.push(`last scan ${last}`);
  } else if (lastScan === null) {
    parts.push('Not scanned yet');
  } else if (lastScan.outcome === 'ok') {
    parts.push(`Scanned ${last}`);
  } else {
    // The reasons a scan can't run have their own place (Clients × Instagram › states).
    parts.push(`The scan of ${last} could not read the page`);
  }
  const next = nextScanAt === null ? '' : instantDayText(nextScanAt, options);
  if (next !== '' && !scanning) parts.push(`next scan ${next}`);
  return parts.join(SEPARATOR);
}

/** What the page header adds to "6 jobs · last job 2 d ago" for a client with an account. */
export interface HeaderFacts {
  /** Lowercase, without the `@`. */
  handle: string;
  /** The account's page on Instagram. */
  url: string;
  /** "12,480 followers"; `null` until a scan has read the profile. */
  followers: string | null;
  /** The bio line under the name; `null` when the account has none (or has not been read yet). */
  bio: string | null;
}

/** The followers as the last scan that read the profile saw them; `null` before the first. */
export function followersNow(data: ClientInstagram): number | null {
  return data.numbers?.tiles.followers.now ?? data.lastScan?.followers ?? null;
}

/**
 * The header's Instagram facts, or `null` when there is nothing to add: no data yet, the switch
 * off, or a client with no account (the header is then as it was).
 */
export function headerFacts(data: ClientInstagram | undefined): HeaderFacts | null {
  if (data === undefined || data.account === null) return null;
  const { handle, bio } = data.account;
  const followers = followersNow(data);
  const bioText = bio?.trim() ?? '';
  return {
    handle,
    url: `https://www.instagram.com/${handle}/`,
    followers:
      followers === null
        ? null
        : `${countText(followers)} ${followers === 1 ? 'follower' : 'followers'}`,
    bio: bioText === '' ? null : bioText,
  };
}
