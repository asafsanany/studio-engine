import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

// Instagram DMs: The owner sends reels between their own account (@owner_account) and the studio's
// (@studio_account) in a DM, either way, and the DMs page lists the reels, downloaded. The engine
// reads the studio account's DMs through Instagram's own API (the Conversations API, on
// graph.facebook.com or graph.instagram.com by the key), with the key `INSTAGRAM_DM_TOKEN` in the
// repo's .env. Only reels are kept. Nothing else uses them: they are not linked to clients, jobs
// or songs.
//
//   GET  /api/dms              {@link DmsResponse}: the connection and every item, newest first
//   POST /api/dms/check        {@link DmsResponse} after one check of the DMs, right now
//   GET  /api/dms/file/:name   a downloaded file (ranges, for the player)
//   POST /api/dms/:id/reveal   Finder shows the item's file

/** What a DM item is. */
export const DM_ITEM_KINDS = [
  'reel',
  'post',
  'story',
  'video',
  'photo',
  'audio',
  'file',
  'link',
  'text',
  'unsupported',
] as const;
export const dmItemKindSchema = z.enum(DM_ITEM_KINDS);
export type DmItemKind = z.infer<typeof dmItemKindSchema>;

/** The page's name for each kind. */
export const DM_KIND_LABELS: Record<DmItemKind, string> = {
  reel: 'Reel',
  post: 'Post',
  story: 'Story',
  video: 'Video',
  photo: 'Photo',
  audio: 'Sound',
  file: 'File',
  link: 'Link',
  text: 'Message',
  unsupported: 'Not readable',
};

/** A file the engine downloaded for an item, kept in <dataDir>/instagram-dms/files/. */
export const dmFileSchema = z.object({
  /** The file's name in that folder; `GET /api/dms/file/:name` serves it. */
  name: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export type DmFile = z.infer<typeof dmFileSchema>;

/** One thing that came in a DM: a message can hold more than one (a share and its text). */
export const dmItemSchema = z.object({
  /** `<message id>:<index in the message>`. */
  id: z.string().min(1),
  messageId: z.string().min(1),
  /** When it was sent. */
  at: isoTimestampSchema,
  /** The sender's Instagram username. */
  from: z.string(),
  kind: dmItemKindSchema,
  /** What Instagram calls it: a reel's or post's caption, a shared item's name. */
  title: z.string().nullable(),
  /** The message's own words. */
  text: z.string().nullable(),
  /** Where it is on Instagram, or the link that was sent. */
  link: z.string().nullable(),
  /** The downloaded picture, video or sound; `null` when there is none (yet). */
  file: dmFileSchema.nullable(),
  /** Why an item that should have a file has none, in a plain line. */
  missing: z.string().nullable(),
});
export type DmItem = z.infer<typeof dmItemSchema>;

export const DM_CONNECTION_STATES = ['off', 'connected', 'failing'] as const;

/** Whether the engine reads the DMs, and how the last check went. */
export const dmConnectionSchema = z.object({
  /** off: no key in .env; connected: the last check worked; failing: it did not (`error`). */
  state: z.enum(DM_CONNECTION_STATES),
  /** The studio account the key belongs to (`studio_account`), once a check has read it. */
  account: z.string().nullable(),
  /** The senders whose conversations with the studio are read (their reels and the studio's). */
  from: z.array(z.string()),
  /** When the DMs were last read, successfully or not. */
  checkedAt: isoTimestampSchema.nullable(),
  error: z.string().nullable(),
  /** How often the engine reads them. */
  everySecs: z.number().int().positive(),
});
export type DmConnection = z.infer<typeof dmConnectionSchema>;

export const dmsResponseSchema = z.object({
  connection: dmConnectionSchema,
  /** Newest first. */
  items: z.array(dmItemSchema),
});
export type DmsResponse = z.infer<typeof dmsResponseSchema>;

export const revealDmResponseSchema = z.object({ ok: z.literal(true) });

/** What the routes say when they refuse. */
export const DM_MESSAGES = {
  notFound: 'No such DM item.',
  noFile: 'This item has no file.',
  fileGone: 'The file is gone.',
} as const;
