import { DM_KIND_LABELS, type DmItem, fileSize } from '@studio/shared';

/** The words of the Instagram DMs page. */
export const DMS_TEXT = {
  title: 'Instagram DMs',
  intro: (from: string, account: string) =>
    `The reels ${from} and ${account} send each other in a DM, downloaded.`,
  checkNow: 'Check now',
  checking: 'Checking…',
  empty: (from: string, account: string) =>
    `No reels yet. Send a reel to ${account} from ${from}, or to ${from} from ${account}; it shows here within a minute.`,
  unreachable: "Can't reach the engine.",
  tryAgain: 'Try again',
  connectTitle: 'Connect the studio’s Instagram',
  connectIntro:
    'The engine reads the DMs of your studio’s Instagram account with Instagram’s own API. It takes a key that only you can make, once:',
  connectSteps: [
    'In the Instagram app, as the studio account: Settings › Account type and tools › Switch to a professional account (creator or business). Keep it public.',
    'Still as the studio account: Settings › Messages and story replies › Message controls › Connected tools: turn on Allow access to messages.',
    'Open developers.facebook.com/apps, logged in to Facebook. If it shows Get started instead of Create app, register first: accept the terms, confirm your phone and email, and pick an occupation.',
    'Click Create app (top right): a name, the use case Manage messaging & content on Instagram, and your business portfolio. Then Create app.',
    'In the app: App roles › Roles › Add People › Instagram Tester, and add the studio account. Then, as the studio account, accept it at instagram.com/accounts/manage_access › Tester invites.',
    'Back in the app: Use cases › Customize › API setup with Unified login. In step 1 click Create new configuration (Create from template); in step 2 click Generate token next to the studio account, and copy it.',
    'Put it in the repo’s .env as INSTAGRAM_DM_TOKEN=… The page connects within a minute; no restart.',
  ],
  connectAfter:
    'Then list your own username under instagramDmFrom in config.json and send a reel to the studio account from it. A key made this way never runs out.',
  missing: 'Not downloaded',
  download: 'Download',
  reveal: 'Show in Finder',
  openOnInstagram: 'Open on Instagram',
  openLink: 'Open link',
  copyLink: 'Copy link',
  copyText: 'Copy text',
  open: 'Open',
  sent: 'Sent',
  from: 'From',
  message: 'Message',
  caption: 'Caption',
  file: 'File',
  link: 'Link',
  noFileYet: 'No file for this one.',
} as const;

/** "@name" for a username. */
export const at = (username: string): string => `@${username}`;

/** The links in a message's words. */
const LINKS = /https?:\/\/\S+/g;

/**
 * What a row and the sheet call an item: its caption or name, its words (without the links in
 * them), its link, or its kind ("Voice note" for a sound that came as a file).
 */
export function dmTitle(item: Pick<DmItem, 'title' | 'text' | 'link' | 'kind' | 'file'>): string {
  const first = (value: string | null): string | null =>
    value === null
      ? null
      : (value
          .replace(LINKS, '')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .find((line) => line !== '') ?? null);
  if (item.kind === 'unsupported') return 'Instagram did not pass this message on';
  return (
    first(item.title) ??
    first(item.text) ??
    (item.link === null ? null : shortLink(item.link)) ??
    (item.kind === 'audio' && item.file !== null ? 'Voice note' : DM_KIND_LABELS[item.kind])
  );
}

/** A link without its scheme, `www.` and query: `instagram.com/reels/audio/104…/`. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`;
  } catch {
    return link;
  }
}

/** The row's detail: who sent it, and the file's size or why there is none. */
export function dmDetail(item: Pick<DmItem, 'from' | 'file' | 'missing'>): string {
  const from = `From ${at(item.from)}`;
  if (item.file !== null) return `${from} · ${fileSize(item.file.bytes)}`;
  if (item.missing !== null) return `${from} · ${DMS_TEXT.missing}`;
  return from;
}

/** Whether `link` is a page on Instagram (Open on Instagram) or any other link (Open link). */
export function isInstagramLink(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

/** What the item's file is, for the player: a video, a picture, a sound, or none it can show. */
export function playerKind(contentType: string): 'video' | 'image' | 'audio' | null {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}
