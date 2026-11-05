// The right-click menu of a reel in the Reels list, as data (boards CLPage, S4 and S5), the way
// `rowMenuEntries` is for a job: which entries there are, in which order, what each says and
// whether it can be chosen. ReelMenu.tsx only draws them.
//
//   A reel with no video   Open on Instagram · Link to job ▸ · Copy link
//                          ▸ "Delivered to <client>, not linked yet", then the client's delivered
//                            and paid videos that no reel links, newest first (name, "Delivered 21
//                            Oct" or "Paid 12 Oct"); with none, a disabled "Every delivered video
//                            is linked"
//   A linked reel          Open on Instagram · Open job · <name> · Unlink from <name> · — · Copy link
//
// Linking is the admin's (the engine refuses an editor, and sends an editor no videos to link), so
// an editor's menu has neither Link to job nor Unlink.

import type { InstagramLinkableJob, InstagramReel } from '@studio/shared';
import { localDay, shortDayText, type TextOptions } from './instagram-text';

export type ReelMenuIcon = 'instagram' | 'link' | 'job' | 'unlink' | 'copy';

export type ReelMenuItemId = 'open-instagram' | 'open-job' | 'unlink' | 'copy-link';

/** The words of an entry; a name (the person's own, in any script) is kept apart so it keeps its direction. */
export interface ReelMenuLabel {
  before: string;
  name: string | null;
}

export interface ReelMenuItem {
  type: 'item';
  id: ReelMenuItemId;
  icon: ReelMenuIcon;
  label: ReelMenuLabel;
  disabled: boolean;
  /** Why the entry can't be chosen, for its tooltip. */
  disabledReason?: string;
}

export interface ReelMenuSeparator {
  type: 'separator';
  id: string;
}

/** One video of the Link to job list. */
export interface ReelMenuJob {
  jobId: string;
  name: string;
  /** "Delivered 21 Oct" or "Paid 12 Oct". */
  when: string;
}

export interface ReelMenuSubmenu {
  type: 'submenu';
  id: 'link-to-job';
  icon: 'link';
  label: ReelMenuLabel;
  /** Over the list: the client's name is kept apart so it keeps its direction. */
  heading: { before: string; name: string; after: string };
  jobs: readonly ReelMenuJob[];
  /** What the list says, disabled, when it has no video. */
  emptyLabel: string;
}

export type ReelMenuEntry = ReelMenuItem | ReelMenuSeparator | ReelMenuSubmenu;

export const OPEN_ON_INSTAGRAM = 'Open on Instagram';
export const LINK_TO_JOB = 'Link to job';
export const COPY_LINK = 'Copy link';
export const EVERY_VIDEO_LINKED = 'Every delivered video is linked';
export const JOB_SHEET_OFF = 'The job sheet is off.';

/** What a menu entry says in one piece, for a screen reader's label and for tests. */
export function labelText(label: ReelMenuLabel): string {
  return `${label.before}${label.name ?? ''}`;
}

/** "Delivered 21 Oct" or "Paid 12 Oct": the day is the delivery's, whatever the video's stage since. */
export function linkableWhen(job: InstagramLinkableJob, options: TextOptions = {}): string {
  const word = job.stage === 'paid' ? 'Paid' : 'Delivered';
  return `${word} ${shortDayText(localDay(job.deliveredAt, options), options)}`;
}

/**
 * The videos the Link to job list offers: the page's `linkableJobs`, newest delivery first, without
 * any that a reel links already (`linkedJobIds`: the page can be a moment behind a link).
 */
export function linkableJobItems(
  linkableJobs: readonly InstagramLinkableJob[],
  linkedJobIds: ReadonlySet<string>,
  options: TextOptions = {},
): ReelMenuJob[] {
  return linkableJobs
    .filter((job) => !linkedJobIds.has(job.jobId))
    .sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt))
    .map((job) => ({ jobId: job.jobId, name: job.name, when: linkableWhen(job, options) }));
}

/** What a menu needs to know besides the reel. */
export interface ReelMenuContext {
  /** The client's name, for the list's heading; `null` while the client list has not arrived. */
  clientName: string | null;
  linkableJobs: readonly InstagramLinkableJob[];
  /** The ids of the videos a reel of the page links. */
  linkedJobIds: ReadonlySet<string>;
  /** Linking is the admin's. */
  admin: boolean;
  /** Whether the job sheet is there to open (its switch is on). */
  canOpenJob: boolean;
}

/** The entries of one reel's menu, top to bottom. */
export function reelMenuEntries(
  reel: Pick<InstagramReel, 'job'>,
  context: ReelMenuContext,
  options: TextOptions = {},
): ReelMenuEntry[] {
  const openOnInstagram: ReelMenuItem = {
    type: 'item',
    id: 'open-instagram',
    icon: 'instagram',
    label: { before: OPEN_ON_INSTAGRAM, name: null },
    disabled: false,
  };
  const copyLink: ReelMenuItem = {
    type: 'item',
    id: 'copy-link',
    icon: 'copy',
    label: { before: COPY_LINK, name: null },
    disabled: false,
  };

  const { job } = reel;
  if (job === null) {
    const entries: ReelMenuEntry[] = [openOnInstagram];
    if (context.admin) {
      entries.push({
        type: 'submenu',
        id: 'link-to-job',
        icon: 'link',
        label: { before: LINK_TO_JOB, name: null },
        heading: {
          before: 'Delivered to ',
          name: context.clientName ?? 'this client',
          after: ', not linked yet',
        },
        jobs: linkableJobItems(context.linkableJobs, context.linkedJobIds, options),
        emptyLabel: EVERY_VIDEO_LINKED,
      });
    }
    entries.push(copyLink);
    return entries;
  }

  const entries: ReelMenuEntry[] = [
    openOnInstagram,
    {
      type: 'item',
      id: 'open-job',
      icon: 'job',
      label: { before: 'Open job · ', name: job.name },
      disabled: !context.canOpenJob,
      ...(context.canOpenJob ? {} : { disabledReason: JOB_SHEET_OFF }),
    },
  ];
  if (context.admin) {
    entries.push({
      type: 'item',
      id: 'unlink',
      icon: 'unlink',
      label: { before: 'Unlink from ', name: job.name },
      disabled: false,
    });
  }
  entries.push({ type: 'separator', id: 'before-copy' }, copyLink);
  return entries;
}
