// What one style run does (Phase 2 plan §5), as the style worker queues it and as
// `client_styles.last_pass` stores it, so that Retry and the next start can run it again:
//
//   { kind: 'read', mode: 'create' | 'add' | 'replace', files: [{ name, size }] }
//   { kind: 'learn', mode: 'create' | 'merge' | 'replace', jobId, job }
//
// A Read pass turns new files in `_Style` into style.md. `name` is the file's path inside `_Style`
// ('/' between folders), `size` its bytes.
//
// A Learn pass writes style.md from a finished job, `<inbox>/<Client>/<job>`. Every job that
// reaches ready queues one (C10), and so does the backfill: `create` while the client has no
// style.md, `merge` (the job's look added to the current style) once it has one. The mode is
// settled again when its turn comes, so a style made meanwhile is merged into, never overwritten.
// `replace` is Use this look: it always replaces.
//
// The series passes (Series plan §3) run on the same queue, one at a time with the style passes of
// their client, and `series.last_pass` stores them the same way:
//
//   { kind: 'series', mode: 'start' | 'replace', seriesId, series, jobId, job, notes? }
//
// A `series` pass writes `_Series/<series>/series.md` from a finished episode, `<inbox>/<Client>/<job>`:
// `start` is Start a series (it also takes what only the series does out of the client's style),
// `replace` is Use as the series format, and also what approving an episode that had review notes
// marked Series queues (C26). That one carries `notes`: the files Send wrote into the series folder
// for those notes ({ name, size }, as a Read pass's files), which the run turns into rules with the
// values the approved episode has. Only the schemas are here; the worker runs them (K2).
//
// Until C26, Send queued a `series-read` pass that merged the notes into series.md at once, before
// the revise run had decided what they mean. It is gone: a stored one parses as no pass.

import { SERIES_PASS_MODES, type SeriesPassSummary, type StylePassSummary } from '@studio/shared';
import { z } from 'zod';

/**
 * How a Read pass treats the current style.md: `create` writes the first one, `add` merges the new
 * files into it, `replace` writes a new one from the new files only.
 */
export const READ_MODES = ['create', 'add', 'replace'] as const;
export type ReadMode = (typeof READ_MODES)[number];

/** What an upload asks for. Without a style.md either one becomes `create`. */
export const REQUESTED_READ_MODES = ['add', 'replace'] as const;
export type RequestedReadMode = (typeof REQUESTED_READ_MODES)[number];

/** A path inside a folder (`_Style`, or a series folder): relative, never leaving it. */
function pathInside(folder: string) {
  return z
    .string()
    .min(1)
    .refine(
      (name) =>
        !name.startsWith('/') && name.split('/').every((part) => part !== '' && part !== '..'),
      `must be a path inside the ${folder} folder`,
    );
}

/** A path inside `_Style`: relative, never leaving the folder. */
const styleFileName = pathInside('style');

export const styleFileSchema = z.object({
  name: styleFileName,
  size: z.number().int().nonnegative(),
});
export type StyleFile = z.infer<typeof styleFileSchema>;

export const readPassSchema = z.object({
  kind: z.literal('read'),
  mode: z.enum(READ_MODES),
  files: z.array(styleFileSchema).min(1),
});
export type ReadPass = z.infer<typeof readPassSchema>;

/**
 * How a Learn pass treats the current style.md: `create` writes the first one, `merge` adds the
 * job's look to it, `replace` writes a new one from the job alone.
 */
export const LEARN_MODES = ['create', 'merge', 'replace'] as const;
export type LearnMode = (typeof LEARN_MODES)[number];

/** A job folder's name: one path segment inside the client folder. */
const jobName = z
  .string()
  .min(1)
  .refine((name) => !name.includes('/') && name !== '.' && name !== '..', 'must be a job folder');

export const learnPassSchema = z.object({
  kind: z.literal('learn'),
  mode: z.enum(LEARN_MODES),
  /** The job's id (`jobIdFor`), which becomes the style's `source_job_id`. */
  jobId: z.string().min(1),
  /** The job folder's name, as the jobs list spells it. */
  job: jobName,
});
export type LearnPass = z.infer<typeof learnPassSchema>;

export const stylePassSchema = z.discriminatedUnion('kind', [readPassSchema, learnPassSchema]);
export type StylePass = z.infer<typeof stylePassSchema>;

/** A series folder's name: one path segment inside `_Series`. */
const seriesName = z
  .string()
  .min(1)
  .refine(
    (name) => !name.includes('/') && name !== '.' && name !== '..',
    'must be a series folder',
  );

/** A file of a series folder, as a pass's `notes` name it: its path inside the folder and its bytes. */
export const seriesFileSchema = z.object({
  name: pathInside('series'),
  size: z.number().int().nonnegative(),
});
export type SeriesFile = z.infer<typeof seriesFileSchema>;

/**
 * Start a series (`start`) or Use as the series format (`replace`), from the finished job `job`;
 * a `replace` with `notes` is the approval of an episode that had review notes marked Series (C26).
 */
export const seriesPassSchema = z.object({
  kind: z.literal('series'),
  mode: z.enum(SERIES_PASS_MODES),
  /** The series' id (`seriesIdFor`). */
  seriesId: z.string().min(1),
  /** The series folder's name inside `_Series`. */
  series: seriesName,
  /** The episode the format is learned from (`jobIdFor`), which becomes the series' `format_job_id`. */
  jobId: z.string().min(1),
  /** Its folder's name, as the jobs list spells it. */
  job: jobName,
  /** The episode's review-note files in the series folder, for the notes marked Series (C26). */
  notes: z.array(seriesFileSchema).min(1).optional(),
});
export type SeriesPass = z.infer<typeof seriesPassSchema>;

/** A stored `series.last_pass` as a series pass the worker can run, or null when it is not one. */
export function parseSeriesPass(value: unknown): SeriesPass | null {
  const parsed = seriesPassSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What a series pass does, as the web shows it while the series is learning (`Series.pass`). */
export function summarizeSeriesPass(pass: SeriesPass): SeriesPassSummary {
  return { kind: 'series', mode: pass.mode, fileCount: 0, jobId: pass.jobId, job: pass.job };
}

/** A stored `last_pass` as a pass the worker can run, or null when it is not one. */
export function parseStylePass(value: unknown): StylePass | null {
  const parsed = stylePassSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The mode a Read pass runs in, given whether style.md exists: `create` while there is none,
 * otherwise `replace` or `add`. A pass queued as `create` adds to the style an earlier pass made.
 */
export function readModeFor(mode: ReadMode, hasStyle: boolean): ReadMode {
  if (!hasStyle) return 'create';
  return mode === 'replace' ? 'replace' : 'add';
}

/**
 * The mode a Learn pass runs in, given whether style.md exists: `replace` as it is, otherwise
 * `create` while there is none and `merge` once there is one.
 */
export function learnModeFor(mode: LearnMode, hasStyle: boolean): LearnMode {
  if (mode === 'replace') return mode;
  return hasStyle ? 'merge' : 'create';
}

/**
 * The pass with its mode for a folder that has a style.md or not (see {@link readModeFor} and
 * {@link learnModeFor}).
 */
export function withStyleState(pass: StylePass, hasStyle: boolean): StylePass {
  if (pass.kind === 'learn') return { ...pass, mode: learnModeFor(pass.mode, hasStyle) };
  return { ...pass, mode: readModeFor(pass.mode, hasStyle) };
}

/**
 * Two passes of one client as one. Two Read passes: the first one's mode with the files of both
 * (a file in both keeps its place and takes the later size). Two Learn passes of one job: the
 * later one, `replace` if either was. Null when they cannot be merged: a Read and a Learn pass, or
 * Learn passes of two jobs, since each job's look goes into the style in turn.
 */
export function mergePasses(first: StylePass, second: StylePass): StylePass | null {
  if (first.kind === 'learn' && second.kind === 'learn') {
    if (first.jobId !== second.jobId) return null;
    return { ...second, mode: first.mode === 'replace' ? 'replace' : second.mode };
  }
  if (first.kind !== 'read' || second.kind !== 'read') return null;
  const files = new Map<string, StyleFile>();
  for (const file of [...first.files, ...second.files]) files.set(file.name.normalize('NFC'), file);
  return { kind: 'read', mode: first.mode, files: [...files.values()] };
}

/** What a pass does, as the web shows it while the client is analysing (`ClientStyle.pass`). */
export function summarizePass(pass: StylePass): StylePassSummary {
  return pass.kind === 'read'
    ? { kind: 'read', mode: pass.mode, fileCount: pass.files.length, jobId: null, job: null }
    : { kind: 'learn', mode: pass.mode, fileCount: 0, jobId: pass.jobId, job: pass.job };
}

/** The fields a log line about a pass carries. */
export function passLogFields(pass: StylePass): Record<string, unknown> {
  return pass.kind === 'read'
    ? { kind: pass.kind, mode: pass.mode, files: pass.files.length }
    : { kind: pass.kind, mode: pass.mode, jobId: pass.jobId, job: pass.job };
}
