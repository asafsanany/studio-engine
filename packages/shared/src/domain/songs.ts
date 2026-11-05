import { z } from 'zod';
import { clock } from '../format.ts';
import { isoTimestampSchema } from './job.ts';
import {
  SONG_LIMITS,
  songAskedBySchema,
  songAskedFromSchema,
  songFailureCodeSchema,
  songPartSchema,
  songSiteSchema,
  songViaSchema,
} from './music.ts';

// Songs (Plane page "Songs — architecture & dev plan", SG0): the pieces of the contract that are
// not the music record. The record itself (`song`, `songFailure`, `MUSIC_FILES.song…`,
// `instagramLine`, the script's lines) is in music.ts. Later Songs items extend this file and say
// "CONTRACT CHANGE:" in their hand-off.
//
//   note attachments    the screenshots the owner attaches in "Note for the editor" (SG5, SG6)
//   trending cache      a client's last trending lookup, reused for 7 days (SG10)
//   the second export   "[Job] · no song.mp4" next to the normal export (SG8)
//   song events         the six things a job's History says about its song (SG3, SG9, SG10)

// --- note attachments ----------------------------------------------------------------------------

/**
 * The pictures the owner attaches in Note for the editor (a reel's screenshot, pasted or dropped on the
 * Mac, picked with Add photo on the phone). They are kept per job in `dir`, relative to the job's
 * edit/ folder (edit/brief/from-you/), listed to the Brief run and part of its fingerprint. At most
 * `maxFiles` of them, each at most `maxBytes`, of the `types` (by extension, any case).
 */
export const NOTE_ATTACHMENTS = {
  dir: 'brief/from-you',
  maxFiles: 6,
  maxBytes: 15 * 1024 * 1024,
  types: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'],
} as const;

/** The lower-case extension of a note attachment's name when it is one of the types, else `null`. */
export function noteAttachmentType(name: string): (typeof NOTE_ATTACHMENTS.types)[number] | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return NOTE_ATTACHMENTS.types.find((type) => type === extension) ?? null;
}

/**
 * Whether `name` can be the name of a note attachment: one file name (no folders, no dot-file, no
 * control characters, at most 255 characters) with one of the allowed extensions. `DELETE
 * /api/jobs/:id/note/attachments/:name` takes the name as it was answered.
 */
export function isNoteAttachmentName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('.') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    !/[/\\\u0000-\u001f]/.test(name) &&
    noteAttachmentType(name) !== null
  );
}

/** One picture attached to a job's note: its name in edit/brief/from-you/, its size and when it was added. */
export const noteAttachmentSchema = z.object({
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  addedAt: isoTimestampSchema,
});
export type NoteAttachment = z.infer<typeof noteAttachmentSchema>;

/**
 * `GET /api/jobs/:id/note`: the job's note view, the note as `Job.note` has it plus the pictures
 * attached to it (oldest first). `PUT /api/jobs/:id/note` stays as it is: the note text, answering
 * the job.
 */
export const noteViewSchema = z.object({
  note: z.string().min(1).nullable(),
  attachments: z.array(noteAttachmentSchema),
});
export type NoteView = z.infer<typeof noteViewSchema>;

/**
 * `POST /api/jobs/:id/note/attachments` (multipart/form-data, field `file`): answers 201 with the
 * attachment as it was kept (its `name` is the one to use afterwards; a name already taken gets a
 * number). Allowed while the job's note can be edited (`canEditNote`).
 */
export const addNoteAttachmentResponseSchema = noteAttachmentSchema;
export type AddNoteAttachmentResponse = z.infer<typeof addNoteAttachmentResponseSchema>;

/** `DELETE /api/jobs/:id/note/attachments/:name`: the picture is gone. */
export const deleteNoteAttachmentResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteNoteAttachmentResponse = z.infer<typeof deleteNoteAttachmentResponseSchema>;

// --- the trending cache --------------------------------------------------------------------------

/**
 * A client's last trending lookup is <dataDir>/trends/<clientId>.json (`TRENDING_CACHE`), reused
 * for `maxAgeDays` days. Songs are ranked only by Instagram's own signals; charts never rank.
 */
export const TRENDING_CACHE = { dir: 'trends', maxAgeDays: 7 } as const;

/** The cache file of a client, relative to the data folder: "trends/1c9823704bf5.json". */
export function trendingCacheFile(clientId: string): string {
  return `${TRENDING_CACHE.dir}/${clientId}.json`;
}

/** One sound the niche's top recent reels use. */
export const trendingSoundSchema = z.object({
  /** Instagram's id of the sound; `null` when the lookup did not give one. */
  igAudioId: z.string().min(1).nullable(),
  title: z.string().min(1),
  /** The artist, or the account for an "Original audio"; may be empty. */
  artist: z.string(),
  /** Whether it is a song, as opposed to someone's "Original audio". */
  isSong: z.boolean(),
  /** Reels that use the sound; `null` when Instagram did not say. */
  reels: z.number().int().nonnegative().nullable(),
  /** Instagram's own trending flag on the sound; `null` when Instagram did not say. */
  isTrending: z.boolean().nullable(),
  /** How many of the niche's top 20 recent reels use it. */
  nicheTop20: z.number().int().min(0).max(20),
  /** Where the sound's page is; `null` when the lookup did not give one. */
  url: z.string().min(1).nullable(),
});
export type TrendingSound = z.infer<typeof trendingSoundSchema>;

/** <dataDir>/trends/<clientId>.json. */
export const trendingCacheSchema = z.object({
  v: z.literal(1),
  /** A client's id: 12 hex characters, but only a file-name-safe string is required. */
  clientId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be a file-name-safe id'),
  /** The niche it was looked up for: "#fpv #drone". */
  niche: z.string().min(1),
  fetchedAt: isoTimestampSchema,
  sounds: z.array(trendingSoundSchema),
});
export type TrendingCache = z.infer<typeof trendingCacheSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a cache is still good at `now`: fetched less than `TRENDING_CACHE.maxAgeDays` days ago
 * (and not in the future). A cache for another niche than the one asked for is the caller's to refuse.
 */
export function isTrendingCacheFresh(
  cache: Pick<TrendingCache, 'fetchedAt'>,
  now: Date | number,
): boolean {
  const age = (typeof now === 'number' ? now : now.getTime()) - Date.parse(cache.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < TRENDING_CACHE.maxAgeDays * DAY_MS;
}

// --- the second export ---------------------------------------------------------------------------

/** What follows the job's name in the second export's file name. */
export const NO_SONG_EXPORT_SUFFIX = ' · no song';

/**
 * The second export of a job that has a song, the one to post (the song is added in Instagram):
 * "Demo 2 · no song.mp4", next to the normal "Demo 2.mp4" in `_Exports/<Client>/`. The name gets
 * the same treatment as the normal export's (`exportFileNamePart` in the server's finalize.ts: NFC,
 * and "/", ":" and NUL replaced by "-"), so the two files always sit side by side.
 */
export function noSongExportName(jobName: string): string {
  return `${jobName.normalize('NFC').replace(/[/:\0]/g, '-')}${NO_SONG_EXPORT_SUFFIX}.mp4`;
}

/**
 * Where the second export stands (SG8), as `GET /api/jobs/:id/no-song` answers it and `POST` (Try
 * again) starts it. The engine makes it after the normal export landed; the job is Approved
 * either way, and a failure never fails the job.
 *
 *   none     there is no second file for this job: Songs is off, the job is not ready, its music
 *            is not the song, or it has no preview to render
 *   idle     it should exist and does not (not started yet, or the engine restarted while it was
 *            being made): the sheet offers Try again
 *   making   the engine is rendering it now
 *   failed   it could not be made: `message` says why, the sheet offers Try again
 *   ready    it is in _Exports next to the normal one. `file` is its name (`noSongExportName`) and
 *            `at` when it was rendered, which is what History's `export.no-song` line says
 *            (`{ type: 'export.no-song', at, file }`)
 *
 * Each change republishes the job (`job.upsert`, the job itself unchanged), so a page that shows
 * the second file asks again then.
 */
export const noSongStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('making') }),
  z.object({ state: z.literal('failed'), message: z.string().min(1) }),
  z.object({ state: z.literal('ready'), file: z.string().min(1), at: isoTimestampSchema }),
]);
export type NoSongStatus = z.infer<typeof noSongStatusSchema>;

/** What the second export's routes answer in words. */
export const NO_SONG_MESSAGES = {
  /** `POST /api/jobs/:id/no-song` for a job that has no second file to make. */
  nothingToMake: 'This job has no file without the song to make.',
  /** `GET /api/jobs/:id/download?file=no-song` while the file is not there. */
  noFile: 'This job has no file without the song yet.',
} as const;

// --- song events ---------------------------------------------------------------------------------

/**
 * The six things a job's History says about its song. Each is a fact with the moment it happened,
 * and `songEventText` is the History line for it (the wording of the Songs board "job sheet after
 * Approve"). They are not stream events: the page hears of a song through `job.music`, whose
 * answer carries the record. Where the record already has the facts (`found`, `got`, `failed` are
 * its `song.asked`, `song` and `songFailure`) History can say them from the record; `trending`,
 * `asked` and `export.no-song` are not in it, so whoever knows them (the trending pick, the Review
 * note, the second render) writes them where History reads them.
 */
export const SONG_EVENT_TYPES = [
  'music.song.found',
  'music.song.got',
  'music.song.trending',
  'music.song.failed',
  'music.song.asked',
  'export.no-song',
] as const;

/** The brief (or a Review note) named a song: from where, who asked, and what was named. */
export const songFoundEventSchema = z.object({
  type: z.literal('music.song.found'),
  at: isoTimestampSchema,
  from: songAskedFromSchema,
  by: songAskedBySchema,
  /** The screenshot it was read from, or `null`. */
  file: z.string().min(1).nullable(),
  /** The link it was named with, or `null`. */
  url: z.string().min(1).nullable(),
  /** `null` while only a link is known. */
  title: z.string().min(1).max(SONG_LIMITS.titleMax).nullable(),
  artist: z.string().min(1).max(SONG_LIMITS.artistMax).nullable(),
});
export type SongFoundEvent = z.infer<typeof songFoundEventSchema>;

/** The song was got: from which site and with what, how long the whole song is, and the part used. */
export const songGotEventSchema = z.object({
  type: z.literal('music.song.got'),
  at: isoTimestampSchema,
  site: songSiteSchema,
  via: songViaSchema,
  fullMs: z.number().int().positive(),
  part: songPartSchema,
});
export type SongGotEvent = z.infer<typeof songGotEventSchema>;

/**
 * The editor picked a trending song: the niche, how many songs it looked at (the pick's own ok
 * line says it; the music record does not keep it, so `songEventText` does not either), and the
 * pick (`null`: none fit).
 */
export const songTrendingEventSchema = z.object({
  type: z.literal('music.song.trending'),
  at: isoTimestampSchema,
  niche: z.string().min(1),
  looked: z.number().int().nonnegative(),
  pick: z
    .object({
      title: z.string().min(1).max(SONG_LIMITS.titleMax),
      artist: z.string().min(1).max(SONG_LIMITS.artistMax),
    })
    .nullable(),
});
export type SongTrendingEvent = z.infer<typeof songTrendingEventSchema>;

/** The song could not be got. */
export const songFailedEventSchema = z.object({
  type: z.literal('music.song.failed'),
  at: isoTimestampSchema,
  code: songFailureCodeSchema,
  message: z.string().min(1),
});
export type SongFailedEvent = z.infer<typeof songFailedEventSchema>;

/**
 * A Review note asked for another song (`text`: what the note named, e.g. a title or a link) or for
 * a trending one (`text` is `null`).
 */
export const songAskedEventSchema = z.object({
  type: z.literal('music.song.asked'),
  at: isoTimestampSchema,
  wanted: z.enum(['another', 'trending']),
  text: z.string().min(1).nullable(),
});
export type SongAskedEvent = z.infer<typeof songAskedEventSchema>;

/** Approve made the second file, the one without the song: its file name (`noSongExportName`). */
export const noSongExportEventSchema = z.object({
  type: z.literal('export.no-song'),
  at: isoTimestampSchema,
  file: z.string().min(1),
});
export type NoSongExportEvent = z.infer<typeof noSongExportEventSchema>;

export const songEventSchema = z.discriminatedUnion('type', [
  songFoundEventSchema,
  songGotEventSchema,
  songTrendingEventSchema,
  songFailedEventSchema,
  songAskedEventSchema,
  noSongExportEventSchema,
]);
export type SongEvent = z.infer<typeof songEventSchema>;

const SITE_LABELS = {
  'youtube-music': 'YouTube Music',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
} as const;

const FOUND_WHERE = {
  screenshot: 'on Yael’s screenshot',
  link: 'in the link',
  name: 'in the note',
  note: 'in the note',
  trending: 'on Reels',
} as const;

const PART_LABELS = {
  measured: 'The part with its drop',
  whole: 'The whole song',
  reel: 'The part the reel uses',
} as const;

/** The History line for an event, as on the board: "Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21". */
export function songEventText(event: SongEvent): string {
  switch (event.type) {
    case 'music.song.found': {
      const who = event.by === 'brief' ? 'The brief' : 'The editor';
      const name =
        event.title !== null && event.artist !== null
          ? `${event.title}, ${event.artist}`
          : (event.title ?? event.artist ?? event.url);
      return `${who} found the song ${FOUND_WHERE[event.from]}${name === null ? '' : `: ${name}`}`;
    }
    case 'music.song.got': {
      const { part } = event;
      return `Got the song from ${SITE_LABELS[event.site]} (${clock(event.fullMs / 1000)}). ${PART_LABELS[part.how]}: ${clock(part.startMs / 1000)} to ${clock(part.endMs / 1000)}`;
    }
    case 'music.song.trending': {
      // How many songs were looked at (`looked`) is not saved in the music record, which is where
      // History reads the pick from, so the line does not say it.
      const rising = `rising on Reels in ${event.niche}`;
      return event.pick === null
        ? `No song ${rising} fit the cut`
        : `Picked a song ${rising}: ${event.pick.title} by ${event.pick.artist}`;
    }
    case 'music.song.failed':
      return `Couldn’t get the song: ${event.message}`;
    case 'music.song.asked':
      return event.wanted === 'trending'
        ? 'You asked for a trending song'
        : `You asked for another song${event.text === null ? '' : `: ${event.text}`}`;
    case 'export.no-song':
      return 'Rendered with the song, and without it';
  }
}
