// What the job sheet says of Instagram while Clients × Instagram is on (design canvas page
// "Clients × Instagram", board CLStates S6): the "On Instagram" row of Details. A delivered video
// that a reel is linked to (Uploaded) says how the reel is doing and when it was posted; a
// delivered video with no reel yet says where to link one. Pure: the sheets read the data
// (`useSheetInstagram`) and `detailRows` / `phoneDetailRows` lay the row out.

import type { Job, JobReel } from '@studio/shared';
import { jobStage } from '@studio/shared';
import { countText, playsText, SEPARATOR } from '@/features/clients/instagram/instagram-text';
import { postedDay } from '@/features/jobs/delivery-text';

/** What a job's sheet knows of Instagram: the linked reel, or that none is linked and could be. */
export type SheetInstagram =
  /** A reel is linked: `reel` is its numbers, `null` while they are on their way (or cannot be read). */
  | { kind: 'reel'; reel: JobReel | null }
  /** Delivered, no reel linked, and the client has an account to link one from. */
  | { kind: 'none' };

/**
 * What the row renders beyond its text: `reel` has "Open reel" at the end of its second line, `none`
 * has the client's page as a link inside its sentence.
 */
export type InstagramRowLinks =
  | { kind: 'reel'; url: string | null }
  | { kind: 'none'; clientId: string; client: string };

/** The row's label in Details. */
export const ON_INSTAGRAM_LABEL = 'On Instagram';

/** What the second line of a linked job says besides the day, and the link that ends it. */
export const LINKED_BY_YOU_TEXT = 'linked by you';
export const OPEN_REEL_TEXT = 'Open reel';

/** The start of "No reel linked yet. Link it from Falcon FPV’s page." that comes before the link. */
export const NO_REEL_LEAD = 'No reel linked yet. Link it from ';

/** "Falcon FPV’s page": the link's words (the curly apostrophe is the board's). */
export function clientPageText(client: string): string {
  return `${client}’s page`;
}

/** The whole sentence, as plain text. */
export function noReelText(client: string): string {
  return `${NO_REEL_LEAD}${clientPageText(client)}.`;
}

/** "1 like", "1,640 likes". */
function counted(count: number, one: string, many: string): string {
  return `${countText(count)} ${count === 1 ? one : many}`;
}

/**
 * "27.5K plays · 1,640 likes · 71 comments · 820 shares": the reel's plays the short way and the
 * rest in full, as the board has them. Shares the scan could not read are left out.
 */
export function reelNumbersText(reel: JobReel): string {
  const parts = [
    playsText(reel.plays),
    counted(reel.likes, 'like', 'likes'),
    counted(reel.comments, 'comment', 'comments'),
  ];
  if (reel.shares !== null) parts.push(counted(reel.shares, 'share', 'shares'));
  return parts.join(SEPARATOR);
}

/** The row's value while a linked reel's numbers are not known: a dash, as the app writes one. */
export const NO_REEL_NUMBERS = '—';

export interface InstagramRow {
  label: typeof ON_INSTAGRAM_LABEL;
  value: string;
  /** The reel's day and who linked it, under the numbers; `none` has no second line. */
  sub?: string;
  /** A sentence that says there is nothing yet is muted; numbers are not. */
  muted: boolean;
  /** What to render in the row besides its text (the links). */
  instagram: InstagramRowLinks;
}

/**
 * The "On Instagram" row, or `null` when the job has none to show:
 * - a job a reel links (it has `delivery.uploadedAt`): the reel's numbers (a dash until they are
 *   in) with "Posted Tue 20 Oct · linked by you" under them, and "Open reel" after that when the
 *   job knows where the reel is;
 * - a delivered job no reel links: "No reel linked yet. Link it from <client>’s page."
 * Nothing for a job that is not finished, and for no `instagram` (the switch is off).
 */
export function instagramRow(
  job: Job,
  instagram: SheetInstagram | null | undefined,
  timeZone?: string,
): InstagramRow | null {
  if (instagram == null || job.delivery === null || jobStage(job) === null) return null;
  const { delivery } = job;
  if (instagram.kind === 'none') {
    if (delivery.uploadedAt !== undefined) return null;
    return {
      label: ON_INSTAGRAM_LABEL,
      value: noReelText(job.client),
      muted: true,
      instagram: { kind: 'none', clientId: job.clientId, client: job.client },
    };
  }
  if (delivery.uploadedAt === undefined) return null;
  const posted = postedDay(delivery, timeZone);
  return {
    label: ON_INSTAGRAM_LABEL,
    value: instagram.reel === null ? NO_REEL_NUMBERS : reelNumbersText(instagram.reel),
    sub: [posted === '' ? null : `Posted ${posted}`, LINKED_BY_YOU_TEXT]
      .filter((part) => part !== null)
      .join(SEPARATOR),
    muted: false,
    instagram: { kind: 'reel', url: instagram.reel?.url ?? delivery.reelUrl ?? null },
  };
}
