// What one DM holds, read from Instagram's message (graph.ts). Instagram's documents show two
// shapes and say little about which a shared reel comes in, so both are read, and every field may
// be missing:
//
//   shares.data[]       { type: ig_reel|reel|ig_post|post, name, description, url, link, id }
//   attachments.data[]  { video_data: { url }, image_data: { url }, audio_data: { url }, file_url,
//                         mime_type } or the webhook's { type, payload: { url, title } }
//   story               { link, id } or { mention|reply_to: { link, id } }
//   message             the words, where a link to a reel, a post or a sound may be
//
// A link on instagram.com is where the thing is on Instagram; any other link in a share or an
// attachment is the file itself on Instagram's CDN (signed, for a few days), which the inbox
// downloads.

import type { DmItemKind } from '@studio/shared';
import type { GraphMessage } from './graph.js';

export interface ParsedItem {
  kind: DmItemKind;
  title: string | null;
  text: string | null;
  link: string | null;
  /** The file to download; `null` when the item has none. */
  mediaUrl: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function dataOf(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) && Array.isArray(value.data) ? value.data.filter(isRecord) : [];
}

/** Whether `url` is a page on instagram.com (not a file on its CDN). */
export function isInstagramPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am';
  } catch {
    return false;
  }
}

/** What an instagram.com link points at: a reel, a post, a sound (an audio page), or a story. */
export function kindOfInstagramLink(url: string): DmItemKind {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'link';
  }
  if (/^\/reels?\/audio\//.test(path) || /^\/(explore\/)?audio\//.test(path)) return 'audio';
  if (/^\/(reels?|tv)\/[^/]+/.test(path)) return 'reel';
  if (/^\/p\/[^/]+/.test(path)) return 'post';
  if (/^\/stories\//.test(path)) return 'story';
  return 'link';
}

/** The kind a share's or a webhook attachment's `type` names. */
function kindOfType(type: string | null): DmItemKind | null {
  switch (type?.toLowerCase()) {
    case 'ig_reel':
    case 'reel':
    case 'clip':
      return 'reel';
    case 'ig_post':
    case 'post':
    case 'share':
    case 'media':
      return 'post';
    case 'story':
    case 'ig_story':
    case 'story_mention':
      return 'story';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'image':
      return 'photo';
    case 'file':
      return 'file';
    default:
      return null;
  }
}

/** The kind of a file by its MIME type. */
function kindOfMime(mime: string | null): DmItemKind {
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('image/')) return 'photo';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

/** The links in a message's words, without the punctuation that may follow them. */
export function linksIn(words: string): string[] {
  return [...words.matchAll(URL_IN_TEXT)].map((match) => match[0].replace(/[).,!?]+$/, ''));
}

/** The items of a share (`shares.data[]`). */
function shareItem(share: Record<string, unknown>): ParsedItem | null {
  const title = text(share.name) ?? text(share.description) ?? text(share.title);
  const urls = [text(share.url), text(share.link)].filter((url) => url !== null);
  const page = urls.find(isInstagramPage) ?? null;
  const media = urls.find((url) => !isInstagramPage(url)) ?? null;
  const kind = kindOfType(text(share.type)) ?? (page === null ? 'post' : kindOfInstagramLink(page));
  if (page === null && media === null && title === null) return null;
  return { kind, title, text: null, link: page, mediaUrl: media };
}

/** The item of an attachment (`attachments.data[]`), in either shape. */
function attachmentItem(attachment: Record<string, unknown>): ParsedItem | null {
  // The webhook's shape: { type, payload: { url, title } }.
  if (isRecord(attachment.payload)) {
    const url = text(attachment.payload.url);
    const title = text(attachment.payload.title);
    const kind = kindOfType(text(attachment.type)) ?? 'file';
    if (url === null && title === null) return null;
    const page = url !== null && isInstagramPage(url) ? url : null;
    return { kind, title, text: null, link: page, mediaUrl: page === null ? url : null };
  }
  const mime = text(attachment.mime_type);
  const title = text(attachment.name);
  const video = isRecord(attachment.video_data) ? text(attachment.video_data.url) : null;
  if (video !== null) return { kind: 'video', title, text: null, link: null, mediaUrl: video };
  const audio = isRecord(attachment.audio_data) ? text(attachment.audio_data.url) : null;
  if (audio !== null) return { kind: 'audio', title, text: null, link: null, mediaUrl: audio };
  const image = isRecord(attachment.image_data) ? text(attachment.image_data.url) : null;
  if (image !== null) return { kind: 'photo', title, text: null, link: null, mediaUrl: image };
  const file = text(attachment.file_url) ?? text(attachment.url);
  if (file !== null)
    return { kind: kindOfMime(mime), title, text: null, link: null, mediaUrl: file };
  return null;
}

/** The item of a story mention or reply (`story`). */
function storyItem(story: unknown): ParsedItem | null {
  const parts = Array.isArray(story) ? story : [story];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const inner = isRecord(part.mention)
      ? part.mention
      : isRecord(part.reply_to)
        ? part.reply_to
        : part;
    const link = text(inner.link) ?? text(inner.url);
    if (link === null) continue;
    return isInstagramPage(link)
      ? { kind: 'story', title: null, text: null, link, mediaUrl: null }
      : { kind: 'story', title: null, text: null, link: null, mediaUrl: link };
  }
  return null;
}

/**
 * The items of one message, in the order they appear: its shares, the attachments that are not
 * a share's own file, a story, then the links in its words. A message with only words is one
 * `text` item; one Instagram could not pass on is one `unsupported` item; an empty one (a
 * reaction, an unsent message) has none. The words go with every item of the message.
 */
export function itemsOfMessage(message: GraphMessage): ParsedItem[] {
  const words = text(message.message);
  const items: ParsedItem[] = [];

  for (const share of dataOf(message.shares)) {
    const item = shareItem(share);
    if (item !== null) items.push(item);
  }
  for (const attachment of dataOf(message.attachments)) {
    const item = attachmentItem(attachment);
    if (item === null) continue;
    if (item.mediaUrl !== null && items.some((known) => known.mediaUrl === item.mediaUrl)) continue;
    // A share without its file and an attachment that is the file: one item.
    const bare = items.find(
      (known) =>
        known.mediaUrl === null &&
        item.mediaUrl !== null &&
        (known.kind === 'reel' || known.kind === 'post' || known.kind === 'story'),
    );
    if (bare !== undefined) {
      bare.mediaUrl = item.mediaUrl;
      bare.title ??= item.title;
      continue;
    }
    items.push(item);
  }
  const story = storyItem(message.story);
  if (story !== null) items.push(story);

  for (const link of words === null ? [] : linksIn(words)) {
    if (items.some((known) => known.link === link || known.mediaUrl === link)) continue;
    const kind = isInstagramPage(link) ? kindOfInstagramLink(link) : 'link';
    items.push({ kind, title: null, text: null, link, mediaUrl: null });
  }

  if (items.length === 0) {
    if (words !== null)
      return [{ kind: 'text', title: null, text: words, link: null, mediaUrl: null }];
    if (message.is_unsupported === true) {
      return [{ kind: 'unsupported', title: null, text: null, link: null, mediaUrl: null }];
    }
    return [];
  }
  return items.map((item) => ({ ...item, text: words }));
}
