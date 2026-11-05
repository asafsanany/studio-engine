import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';
import { calendarDaySchema } from './money.ts';

// Clients × Instagram (Plane page "Clients × Instagram — architecture & dev plan"): a client has an
// Instagram account, the engine reads its public page every Monday with Apify, and the client page
// shows how our videos do next to the client's own reels. Reels are linked to our jobs by hand.
//
// This file is the contract the engine and the page share (IG0): the handle rule, the wire shapes
// (zod), the words and the empty answer. IG1 (tables), IG2 (the scan), IG4 (link), IG5 (numbers)
// and the web items fill in what stands behind it; they extend the file and say so in their
// hand-off. Everything is behind the `instagram` switch: off, every route below answers 404
// {@link INSTAGRAM_MESSAGES}.off and nothing of it shows.
//
//   GET    /api/clients/:clientId/instagram?range=since|90|30   {@link ClientInstagram}
//   PUT    /api/clients/:clientId/instagram                     {@link SetClientInstagramRequest}
//   DELETE /api/clients/:clientId/instagram                     {@link DeleteClientInstagramResponse}
//   POST   /api/clients/:clientId/instagram/scan                202 {@link ClientInstagram}
//   POST   /api/instagram/reels/:shortcode/link                 {@link InstagramLinkRequest}
//   DELETE /api/instagram/reels/:shortcode/link                 {@link InstagramReel}
//   GET    /api/clients/:clientId/photo                         the saved profile picture (JPEG)
//   GET    /api/jobs/:jobId/reel                                {@link JobReelResponse}

// --- the handle ----------------------------------------------------------------------------------

/** The most characters an Instagram handle has. */
export const INSTAGRAM_HANDLE_MAX_LENGTH = 30;

/** A handle as the engine keeps it: lowercase, no `@`, letters, digits, dots and underscores. */
const STORED_HANDLE = /^[a-z0-9._]{1,30}$/;

/** What a handle is made of, before it is lowercased. */
const HANDLE_CHARACTERS = /^[A-Za-z0-9._]+$/;

/**
 * An instagram.com (or instagr.am) address, with or without the scheme and `www.`. Group 1 is what
 * follows the host: the path, the query and the hash.
 */
const INSTAGRAM_LINK =
  /^(?:https?:\/\/)?(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)(?=[/?#]|$)(.*)$/i;

/** The first path words of an instagram.com address that name something other than a profile. */
const NOT_A_PROFILE = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
]);

export type InstagramHandleResult = { ok: true; handle: string } | { ok: false; error: string };

const handleError = (error: string): InstagramHandleResult => ({ ok: false, error });

/**
 * The handle in what was typed or pasted: `@Falcon.FPV`, `falcon.fpv`, `instagram.com/falcon.fpv` or a
 * profile link with a query (`https://www.instagram.com/falcon.fpv/?igsh=…`) all give `falcon.fpv`.
 * Letters, digits, dots and underscores, 1 to {@link INSTAGRAM_HANDLE_MAX_LENGTH}. Otherwise the
 * error is a plain sentence to show the person who typed it (a post or a reel link, a link that is
 * not Instagram's, an empty box, a handle with a space in it).
 */
export function normalizeInstagramHandle(input: string): InstagramHandleResult {
  const text = input.trim();
  let candidate: string;

  const link = INSTAGRAM_LINK.exec(text);
  if (link !== null) {
    const path = (link[1] ?? '').split(/[?#]/)[0] ?? '';
    const parts = path.split('/').filter((part) => part !== '');
    // The app's own address for a profile: instagram.com/_u/falcon.fpv.
    if (parts[0]?.toLowerCase() === '_u') parts.shift();
    const first = parts[0];
    if (first === undefined) return handleError('That link has no profile in it.');
    if (NOT_A_PROFILE.has(first.toLowerCase())) {
      return handleError('That link is a post, not a profile. Paste the profile’s link or handle.');
    }
    candidate = first;
  } else if (/[/:\s]/.test(text)) {
    return handleError(
      /\s/.test(text) && !/[/:]/.test(text)
        ? 'An Instagram handle has no spaces.'
        : 'That is not an Instagram profile link.',
    );
  } else {
    candidate = text;
  }

  candidate = candidate.replace(/^@/, '');
  if (candidate === '') return handleError('Give the client’s Instagram handle or profile link.');
  if (!HANDLE_CHARACTERS.test(candidate)) {
    return handleError('An Instagram handle has only letters, numbers, dots and underscores.');
  }
  if (candidate.length > INSTAGRAM_HANDLE_MAX_LENGTH) {
    return handleError(
      `An Instagram handle has at most ${INSTAGRAM_HANDLE_MAX_LENGTH} characters.`,
    );
  }
  return { ok: true, handle: candidate.toLowerCase() };
}

/**
 * What a person types for the account, parsed to the handle ({@link normalizeInstagramHandle}).
 * A text that is no handle fails with the sentence to show.
 */
export const instagramHandleSchema = z.string().transform((value, ctx) => {
  const result = normalizeInstagramHandle(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  return result.handle;
});

// --- the account and its scans -------------------------------------------------------------------

const countSchema = z.number().int().nonnegative();

/**
 * A client's Instagram account (table `instagram_accounts`). `since` is the day Studio Engine
 * started working with the client ("Working together since"); `null` means the client's first
 * delivery. The name, bio, `private` and the photo are what the last scan read: empty (and `false`)
 * until the first scan.
 */
export const instagramAccountSchema = z.object({
  handle: z.string().regex(STORED_HANDLE),
  since: calendarDaySchema.nullable(),
  addedAt: isoTimestampSchema,
  fullName: z.string().nullable(),
  bio: z.string().nullable(),
  private: z.boolean(),
  /** When the profile picture was saved (`GET /api/clients/:clientId/photo`); `null`: no photo yet. */
  photoSavedAt: isoTimestampSchema.nullable(),
});
export type InstagramAccount = z.infer<typeof instagramAccountSchema>;

/**
 * How a scan ended: `ok`; `private` (the account is private, so there are no reels to read);
 * `not-found` (no such account); `no-token` (no Apify key in .env); `no-credit` (Apify has no
 * credit left this month); `failed` (anything else, with the reason in `error`).
 */
export const INSTAGRAM_SCAN_OUTCOMES = [
  'ok',
  'private',
  'not-found',
  'no-token',
  'no-credit',
  'failed',
] as const;
export const instagramScanOutcomeSchema = z.enum(INSTAGRAM_SCAN_OUTCOMES);
export type InstagramScanOutcome = z.infer<typeof instagramScanOutcomeSchema>;

/**
 * One scan of the account (table `instagram_scans`). The profile numbers are `null` when the scan
 * did not get that far (`private`, `not-found`, `no-token`, `no-credit`, `failed`). `reelsRead` is
 * how many reels it read. `costUsd` is what Apify charged; it is `null` for an editor, because
 * money is the admin's alone.
 */
export const instagramScanSchema = z.object({
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  outcome: instagramScanOutcomeSchema,
  error: z.string().min(1).nullable(),
  followers: countSchema.nullable(),
  following: countSchema.nullable(),
  posts: countSchema.nullable(),
  reelsRead: countSchema,
  costUsd: z.number().nonnegative().nullable(),
});
export type InstagramScan = z.infer<typeof instagramScanSchema>;

// --- the reels -----------------------------------------------------------------------------------

/** The video a reel is linked to. */
export const instagramReelJobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type InstagramReelJob = z.infer<typeof instagramReelJobSchema>;

/**
 * One reel of the account, with the numbers its last scan read (tables `instagram_reels`). `job`
 * is the video it is linked to: a reel with one is ours, any other is theirs. `shares` is `null`
 * when the scan could not read it. `sound` is the song's name, or "Original audio". `timesUsual`
 * is the reel's plays divided by the account's usual plays (the median of its reels of the last
 * 90 days), or `null` while there is no usual to divide by.
 */
export const instagramReelSchema = z.object({
  shortcode: z.string().min(1),
  url: z.url(),
  postedAt: isoTimestampSchema,
  caption: z.string(),
  durationSec: z.number().nonnegative().nullable(),
  plays: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema.nullable(),
  sound: z.string().nullable(),
  coauthors: z.array(z.string()),
  hashtags: z.array(z.string()),
  pinned: z.boolean(),
  paidPartnership: z.boolean(),
  job: instagramReelJobSchema.nullable(),
  timesUsual: z.number().nonnegative().nullable(),
});
export type InstagramReel = z.infer<typeof instagramReelSchema>;

/**
 * A job that can be linked to a reel (the right-click menu's Link to job): the client's delivered
 * or paid jobs that no reel links yet.
 */
export const instagramLinkableJobSchema = z.object({
  jobId: z.string().min(1),
  name: z.string().min(1),
  deliveredAt: isoTimestampSchema,
  stage: z.enum(['delivered', 'paid']),
});
export type InstagramLinkableJob = z.infer<typeof instagramLinkableJobSchema>;

// --- the numbers ---------------------------------------------------------------------------------

/**
 * The part of the account's history a page shows (`?range=`): `since` is since us (the later of
 * "Working together since", else the first delivery, and the first scan, because followers before
 * the first scan are not known), `90` and `30` the last 90 or 30 days.
 */
export const INSTAGRAM_RANGES = ['since', '90', '30'] as const;
export const instagramRangeSchema = z.enum(INSTAGRAM_RANGES);
export type InstagramRange = z.infer<typeof instagramRangeSchema>;

/** The range a page opens on, and the one `GET …/instagram` answers without `?range=`. */
export const DEFAULT_INSTAGRAM_RANGE: InstagramRange = 'since';

/** One number for our reels (the ones linked to a job) and the same for every other reel. */
const oursTheirsSchema = z.object({
  ours: z.number().nonnegative().nullable(),
  theirs: z.number().nonnegative().nullable(),
});

/** What is usual for the account: the median of its reels of the last 90 days. */
export const instagramUsualSchema = z.object({
  plays: z.number().nonnegative().nullable(),
  likes: z.number().nonnegative().nullable(),
  comments: z.number().nonnegative().nullable(),
  shares: z.number().nonnegative().nullable(),
});
export type InstagramUsual = z.infer<typeof instagramUsualSchema>;

/** The four tiles of the Instagram section (Followers, Plays per reel, Likes per reel, Shares a week). */
export const instagramTilesSchema = z.object({
  followers: z.object({
    /** Followers on the last scan that read the profile. */
    now: countSchema.nullable(),
    /** The change against the scan about 7 days earlier; `null` without such a scan. */
    thisWeek: z.number().int().nullable(),
    /** The change since us; `null` without a scan on that day. */
    sinceUs: z.number().int().nullable(),
    /**
     * The followers of every scan that read the profile, oldest first, for the tile's line.
     * `ours` is true when one of our reels was posted since the scan before (the line's dots);
     * false for the first scan, which has none before it.
     */
    line: z.array(z.object({ at: isoTimestampSchema, followers: countSchema, ours: z.boolean() })),
  }),
  /** The median plays of a reel in the range: ours, theirs, and ours ÷ theirs (`null` when either is). */
  playsPerReel: oursTheirsSchema.extend({ ratio: z.number().nonnegative().nullable() }),
  /** The median likes of a reel in the range, the same way. */
  likesPerReel: oursTheirsSchema.extend({ ratio: z.number().nonnegative().nullable() }),
  /**
   * Shares gained between the last two scans that read the profile (`thisWeek`) and between the
   * scan before those and the last but one (`weekBefore`), ours and theirs; the page shows the
   * change. A side is `null` when the scans cannot tell (fewer scans than that, or no reel with
   * shares in both reads). `line` is the tile's line: for each pair of consecutive scans that
   * ended `ok` (the newer one on or after the range's first day), the shares gained between them,
   * ours and theirs added up, oldest first, at the newer scan's time; `shares` is `null` when the
   * pair cannot tell, the way a side is. The last point is `thisWeek`'s total.
   */
  sharesAWeek: z.object({
    thisWeek: oursTheirsSchema,
    weekBefore: oursTheirsSchema,
    line: z.array(z.object({ at: isoTimestampSchema, shares: countSchema.nullable() })),
  }),
});
export type InstagramTiles = z.infer<typeof instagramTilesSchema>;

/**
 * A reel's plays, for "Plays of every reel" (ours blue, theirs grey). `job` is the name of the video
 * an ours reel is linked to (`null` for theirs); the engine always sends it, and a stand-in without
 * it still parses.
 */
export const instagramPlaysPointSchema = z.object({
  shortcode: z.string().min(1),
  postedAt: isoTimestampSchema,
  plays: countSchema,
  ours: z.boolean(),
  job: z.string().min(1).nullable().optional(),
});
export type InstagramPlaysPoint = z.infer<typeof instagramPlaysPointSchema>;

/**
 * A reel's views (its plays), likes, comments and shares, each as a multiple of what is usual for
 * the account (E1: one axis, blue bands on our reels). A number is `null` when there is no usual
 * to divide by, and `shares` also when the scan could not read them. The engine always sends
 * `plays`; a stand-in without it still parses.
 */
export const instagramEngagementPointSchema = z.object({
  shortcode: z.string().min(1),
  postedAt: isoTimestampSchema,
  ours: z.boolean(),
  plays: z.number().nonnegative().nullable().optional(),
  likes: z.number().nonnegative().nullable(),
  comments: z.number().nonnegative().nullable(),
  shares: z.number().nonnegative().nullable(),
});
export type InstagramEngagementPoint = z.infer<typeof instagramEngagementPointSchema>;

/**
 * The numbers of the Instagram section for one range (IG6, instagram-numbers.ts). `from` is the first day the range
 * counts and `sinceUs` the day "since us" starts on, which the page names. The series have the
 * reels posted in the range, oldest first.
 */
export const instagramNumbersSchema = z.object({
  range: instagramRangeSchema,
  from: calendarDaySchema,
  sinceUs: calendarDaySchema,
  usual: instagramUsualSchema,
  tiles: instagramTilesSchema,
  plays: z.array(instagramPlaysPointSchema),
  engagement: z.array(instagramEngagementPointSchema),
});
export type InstagramNumbers = z.infer<typeof instagramNumbersSchema>;

/**
 * What the Clients list shows of a client's Instagram (L1), while the `instagram` switch is on:
 * the handle, the followers on the last scan, this week's change, ours ÷ theirs plays per reel
 * (the tile's ratio, since us) and when the photo was saved (`GET /api/clients/:clientId/photo`).
 * A number is `null` until a scan has read it. A client with no account has no summary (`null` on
 * its row).
 */
export const clientInstagramSummarySchema = z.object({
  handle: z.string().regex(STORED_HANDLE),
  followers: countSchema.nullable(),
  weekChange: z.number().int().nullable(),
  oursVsTheirs: z.number().nonnegative().nullable(),
  photoAt: isoTimestampSchema.nullable(),
  /**
   * `true` for a private account, which a scan cannot read past its profile: the list says
   * "Account is private" in place of the numbers. Left out for a public one.
   */
  private: z.boolean().optional(),
});
export type ClientInstagramSummary = z.infer<typeof clientInstagramSummarySchema>;

// --- the API -------------------------------------------------------------------------------------

/**
 * `GET /api/clients/:clientId/instagram`: everything the client page's Instagram section shows.
 * `account` is `null` for a client with no Instagram account (the page offers Add Instagram),
 * `lastScan` until the first scan has ended, `scanning` while one is queued or running, and
 * `nextScanAt` when the next weekly scan is due (`null` without an account). `numbers` is `null`
 * until a scan has read the profile. `reels` are every reel the engine has for the account, newest
 * first; `linkableJobs` is for the Link to job menu (an editor gets none: linking is the admin's).
 */
export const clientInstagramSchema = z.object({
  account: instagramAccountSchema.nullable(),
  lastScan: instagramScanSchema.nullable(),
  scanning: z.boolean(),
  nextScanAt: isoTimestampSchema.nullable(),
  numbers: instagramNumbersSchema.nullable(),
  reels: z.array(instagramReelSchema),
  linkableJobs: z.array(instagramLinkableJobSchema),
});
export type ClientInstagram = z.infer<typeof clientInstagramSchema>;

/** The answer for a client with no Instagram account: what the engine says before one is added. */
export function noClientInstagram(): ClientInstagram {
  return {
    account: null,
    lastScan: null,
    scanning: false,
    nextScanAt: null,
    numbers: null,
    reels: [],
    linkableJobs: [],
  };
}

/**
 * `PUT /api/clients/:clientId/instagram` body: the account to read, as typed (the handle is
 * checked and lowercased by {@link instagramHandleSchema}: 400 with its sentence), and the day
 * Studio Engine started working with the client (`null`, or left out: the client's first
 * delivery). Answers the {@link ClientInstagram}, with the first scan queued.
 */
export const setClientInstagramRequestSchema = z.object({
  handle: instagramHandleSchema,
  since: calendarDaySchema.nullable().default(null),
});
export type SetClientInstagramRequest = z.input<typeof setClientInstagramRequestSchema>;

/** `DELETE /api/clients/:clientId/instagram`: the client has no Instagram account any more. */
export const deleteClientInstagramResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteClientInstagramResponse = z.infer<typeof deleteClientInstagramResponseSchema>;

/** `POST /api/instagram/reels/:shortcode/link` body: the job to link the reel to. */
export const instagramLinkRequestSchema = z.object({ jobId: z.string().min(1) });
export type InstagramLinkRequest = z.infer<typeof instagramLinkRequestSchema>;

/**
 * Why a reel cannot be linked to a job, or unlinked (409 each): the job is not this client's
 * (`not-this-client`), has no delivery yet (`not-delivered`), is linked to a reel already
 * (`job-linked`); the reel is linked to a job already (`reel-linked`); there is no such reel
 * (`no-reel`).
 */
export const INSTAGRAM_LINK_REFUSALS = [
  'not-this-client',
  'not-delivered',
  'job-linked',
  'reel-linked',
  'no-reel',
] as const;
export const instagramLinkRefusalReasonSchema = z.enum(INSTAGRAM_LINK_REFUSALS);
export type InstagramLinkRefusalReason = z.infer<typeof instagramLinkRefusalReasonSchema>;

/** The words of each refusal; the 409 carries them as `error`. */
export const INSTAGRAM_LINK_MESSAGES: Readonly<Record<InstagramLinkRefusalReason, string>> = {
  'not-this-client': 'That video belongs to another client.',
  'not-delivered': 'Mark the video delivered before linking it to a reel.',
  'job-linked': 'That video is linked to a reel already. Unlink it first.',
  'reel-linked': 'That reel is linked to a video already. Unlink it first.',
  'no-reel': 'There is no such reel.',
};

/** The 409 of a link that is refused: the usual `{ error }` and the reason, to tell them apart. */
export const instagramLinkRefusalSchema = z.object({
  error: z.string().min(1),
  reason: instagramLinkRefusalReasonSchema,
});
export type InstagramLinkRefusal = z.infer<typeof instagramLinkRefusalSchema>;

/** `POST` and `DELETE /api/instagram/reels/:shortcode/link`: the reel as it is now. */
export const instagramLinkResponseSchema = instagramReelSchema;
export type InstagramLinkResponse = InstagramReel;

/**
 * The reel linked to a job, as the job sheet's "On Instagram" line shows it (board S6): where it
 * is, when it was posted and the numbers its last scan read. `shares` is `null` when the scan could
 * not read them.
 */
export const jobReelSchema = z.object({
  shortcode: z.string().min(1),
  url: z.url(),
  postedAt: isoTimestampSchema,
  plays: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema.nullable(),
});
export type JobReel = z.infer<typeof jobReelSchema>;

/**
 * `GET /api/jobs/:jobId/reel`: the reel that links the job, or `reel: null` for a job that none
 * links (a delivered video with no reel yet). 404 for an unknown job, and while the `instagram`
 * switch is off.
 */
export const jobReelResponseSchema = z.object({
  jobId: z.string().min(1),
  reel: jobReelSchema.nullable(),
});
export type JobReelResponse = z.infer<typeof jobReelResponseSchema>;

/** The engine's words for the Instagram API's own refusals. */
export const INSTAGRAM_MESSAGES = {
  /** 404, every Instagram route while the `instagram` switch is off. */
  off: 'Clients × Instagram is off.',
  /** 501, a route whose part of Clients × Instagram is not built yet. */
  notBuilt: 'That part of Clients × Instagram is not built yet.',
  /** 404, the photo of a client with no Instagram picture saved: the page shows initials. */
  noPhoto: 'This client has no Instagram photo yet.',
  /** 404, Scan now for a client that has no Instagram account to read. */
  noAccount: 'This client has no Instagram account yet.',
  /** 409, Scan now while a scan of the client is running. */
  scanRunning: 'A scan of this client is running.',
  /** 400, a `?range=` that is not one of {@link INSTAGRAM_RANGES}. */
  badRange: 'The range is since, 90 or 30.',
  /** 400, a `PUT …/instagram` body that is not JSON of the right shape (a bad handle says why itself). */
  accountBody:
    'Send the Instagram handle, and the day you started working together if you know it.',
  /** 400, a link body that is not `{ jobId }`. */
  linkBody: 'Say which video to link.',
  /** 404, an unlink of a reel that links no video. */
  notLinked: 'That reel is not linked to a video.',
} as const;
