import { z } from 'zod';
import { isoTimestampSchema, type Job } from './job.ts';
import type { JobState } from './status.ts';

// Series (the Series plan §2): episodes of one show share one design and flow. A series is started
// from one Ready job, whose HyperFrames composition becomes the series' kit in
// `<inbox>/<Client>/_Series/<name>/` (series.md and kit/), and a job folder named after the series
// plus a number ("מיתוס או אמת 6") joins it and is rebuilt from that kit.

/**
 * Where a series stands, in lifecycle order: `learning` while a series pass of it is queued or
 * running (its first format, a new one, or review notes going into it), `ready` once a series.md is
 * installed, `failed` when the latest pass failed (Retry runs it again).
 */
export const SERIES_STATES = ['learning', 'ready', 'failed'] as const;

export const seriesStateSchema = z.enum(SERIES_STATES);
export type SeriesState = z.infer<typeof seriesStateSchema>;

/**
 * The two kinds of series pass (plan §3): `series` writes the format from a finished episode,
 * `series-read` merges review-note files into it.
 */
export const SERIES_PASS_KINDS = ['series', 'series-read'] as const;

/** How a `series` pass treats the series: `start` is Start a series, `replace` is Use as the series format. */
export const SERIES_PASS_MODES = ['start', 'replace'] as const;
export type SeriesPassMode = (typeof SERIES_PASS_MODES)[number];

/**
 * What a `learning` series' pass is doing, for "Learning the format from <job>…". A `series` pass
 * has a `mode` and names its job (`fileCount` 0); a `series-read` pass has no mode and no job, and
 * `fileCount` is its new files.
 */
export const seriesPassSummarySchema = z.object({
  kind: z.enum(SERIES_PASS_KINDS),
  mode: z.enum(SERIES_PASS_MODES).nullable(),
  fileCount: z.number().int().nonnegative(),
  jobId: z.string().min(1).nullable(),
  job: z.string().min(1).nullable(),
});
export type SeriesPassSummary = z.infer<typeof seriesPassSummarySchema>;

/**
 * One series, as `GET /api/series/:seriesId` and the `series.changed` event carry it (no
 * markdown). Every field is always present; "none" is `null`.
 */
export const seriesSchema = z.object({
  /** The first 12 hex characters of sha1 over the NFC form of `<clientId>/<name>` (`seriesIdFor`). */
  id: z.string().min(1),
  clientId: z.string().min(1),
  /** The client folder's name, spelled as the file system lists it. */
  client: z.string().min(1),
  /** The series folder's name inside `_Series`, as it was started (trimmed, NFC). */
  name: z.string().min(1),
  state: seriesStateSchema,
  /** Why the latest series pass failed; only for `failed`. */
  error: z.string().min(1).nullable(),
  /** 0 until the first series.md is installed; +1 each time it is replaced. */
  version: z.number().int().nonnegative(),
  /** The job the format comes from: the one it started from, or the one picked as the format later. */
  formatJobId: z.string().min(1),
  /** That job's folder name. */
  formatJob: z.string().min(1),
  /** When the series was started (Undo works for {@link SERIES_UNDO_MS} after it). */
  createdAt: isoTimestampSchema,
  /** When the series last changed. */
  updatedAt: isoTimestampSchema,
  /** The pass queued or running while the series is `learning`; `null` otherwise. */
  pass: seriesPassSummarySchema.nullable(),
});
export type Series = z.infer<typeof seriesSchema>;

/**
 * One series of a client, as `GET /api/clients/:clientId/series` lists it (plan §5): what the
 * client page's "Series" list shows. `episodeCount` counts the jobs in the series (the format job
 * too) and `lastEpisodeAt` is the newest one's `addedAt` (`null` without episodes).
 */
export const seriesSummarySchema = seriesSchema
  .pick({
    id: true,
    name: true,
    state: true,
    error: true,
    formatJobId: true,
    formatJob: true,
    version: true,
    updatedAt: true,
  })
  .extend({
    episodeCount: z.number().int().nonnegative(),
    lastEpisodeAt: isoTimestampSchema.nullable(),
  });
export type SeriesSummary = z.infer<typeof seriesSummarySchema>;

/** How long after Start a series its Undo works (the toast offers it as long): 10 s. */
export const SERIES_UNDO_MS = 10_000;

/**
 * The states in which a job can join a series or leave it: by name or by hand. Once its edit has
 * started (editing, review, ready, failed, cancelled) a job keeps its series.
 */
export const SERIES_CHANGEABLE_STATES = [
  'arriving',
  'queued',
  'held',
] as const satisfies readonly JobState[];

/** Whether the job can be put in a series or taken out right now (`PUT /api/jobs/:id/series` answers 409 if not). */
export function canChangeSeries(job: Pick<Job, 'state'>): boolean {
  return (SERIES_CHANGEABLE_STATES as readonly JobState[]).includes(job.state);
}

// --- the name rule (plan §2) --------------------------------------------------------------------

/** A trailing episode number: spaces and "#" before the digits, spaces after them. */
const EPISODE_SUFFIX = /[\s#]*(\d+)\s*$/u;

/** The name split at its trailing number, or `null` when it has none or would be nothing without it. */
function splitEpisode(jobName: string): { name: string; episode: number } | null {
  const match = EPISODE_SUFFIX.exec(jobName);
  if (match === null || match[1] === undefined) return null;
  const name = jobName.slice(0, match.index).trim();
  const episode = Number(match[1]);
  if (name === '' || !Number.isSafeInteger(episode)) return null;
  return { name, episode };
}

/**
 * The series name a job folder's name points to: the name without its trailing number, "#" or
 * spaces ("מיתוס או אמת 5" and "מיתוס או אמת #5" → "מיתוס או אמת"). A name with no number comes
 * back unchanged, and so does a name that is only a number.
 */
export function seriesNameFrom(jobName: string): string {
  return splitEpisode(jobName)?.name ?? jobName;
}

/** The episode number at the end of a job folder's name ("מיתוס או אמת #6" → 6), or `null` when it has none. */
export function episodeFrom(jobName: string): number | null {
  return splitEpisode(jobName)?.episode ?? null;
}

/** How series names compare: trimmed, in Unicode NFC and lower case (a macOS folder name ignores case). */
export function seriesNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/**
 * The series a job folder joins by its name, from the names of its client's series: the one whose
 * name compares equal ({@link seriesNameKey}) to {@link seriesNameFrom} of the job's name, with the
 * job's episode number. A name with no number never matches. When two names match, the longest
 * wins (then the first). `name` is spelled as it was given.
 */
export function matchSeries(
  jobName: string,
  names: readonly string[],
): { name: string; episode: number } | null {
  const split = splitEpisode(jobName);
  if (split === null) return null;
  const key = seriesNameKey(split.name);
  let best: string | null = null;
  for (const name of names) {
    if (seriesNameKey(name) !== key) continue;
    if (best === null || Array.from(name).length > Array.from(best).length) best = name;
  }
  return best === null ? null : { name: best, episode: split.episode };
}

// --- a new series' name -------------------------------------------------------------------------

/** The longest series name, in characters. */
export const SERIES_NAME_MAX_LENGTH = 80;

/** A series name as the server keeps it: trimmed and in Unicode NFC. */
export function normalizeSeriesName(name: string): string {
  return name.trim().normalize('NFC');
}

/** Control characters (NUL included) can't be in a folder name. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why a series name can't be used, in words for the person who typed it, or null when it can
 * (`POST /api/jobs/:jobId/series` answers 422 with it). The name is checked as
 * {@link normalizeSeriesName} leaves it: not empty, at most {@link SERIES_NAME_MAX_LENGTH}
 * characters, no `/` or `:` (nor control characters), and not starting with `.` or `_`. Whether
 * the client has a series of that name is up to the server.
 */
export function seriesNameProblem(name: string): string | null {
  const normalized = normalizeSeriesName(name);
  if (normalized === '') return 'Give the series a name.';
  if (Array.from(normalized).length > SERIES_NAME_MAX_LENGTH) {
    return `A series name can have at most ${SERIES_NAME_MAX_LENGTH} characters.`;
  }
  if (normalized.includes('/') || normalized.includes(':')) {
    return 'A series name can’t contain / or :.';
  }
  if (hasControlCharacter(normalized)) return 'A series name can’t contain control characters.';
  if (normalized.startsWith('.') || normalized.startsWith('_')) {
    return 'A series name can’t start with . or _.';
  }
  return null;
}
