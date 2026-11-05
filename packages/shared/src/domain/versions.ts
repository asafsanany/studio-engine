import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

// Preview versions (Plane items VE0–): every run that ends in Review (the first edit, each revise
// round, a re-edit) leaves one version of the live composition, so the owner can go back to an earlier
// cut. A version is a snapshot of edit/preview/ plus the state around it, stored in the job folder
// under edit/versions/ (server: versions/version-service.ts). This file is the contract the store
// and the pages share.
//
// On disk, per job (relative to the job's edit/ folder, `VERSION_FILES`):
//
//   versions/index.json   {current, versions}: which version is the live one, newest first
//   versions/v<n>/        preview/ (without .hyperframes/), music.json, edl.json, project.md,
//                         meta.json; and preview-<id>/ of every extra format of a job with two or
//                         more formats (domain/formats.ts), so one version holds every composition
//                         and Restore puts them back together. A version from before has only
//                         preview/, and a restore of it leaves the other formats as they are.
//
// Restore (VE1) puts a version back as the live one. The API, mounted at /api/jobs:
//
//   GET  /:id/versions                      the job's versions, newest first (JobVersionsResponse)
//   POST /:id/versions/:n/restore           200 with the Job; 404 for a version the job does not
//                                           have; 409 unless the job is in Review, not archived,
//                                           with no unsent notes and no music pick under way
//   GET  /:id/versions/:n/preview/<path>    a file of that version's preview, read-only, served
//                                           like the live preview

// --- files ---------------------------------------------------------------------------------------

/** The version files, relative to a job's edit/ folder. */
export const VERSION_FILES = {
  /** The folder the version store owns. */
  dir: 'versions',
  /** The list: which version is current, and the versions. */
  index: 'versions/index.json',
} as const;

/** A version's folder inside `versions/`: "v3". */
export function versionDirName(n: number): string {
  return `v${n}`;
}

// --- limits --------------------------------------------------------------------------------------

export const VERSION_LIMITS = {
  /** Versions kept per job: the newest ones. The current version is never removed. */
  keep: 10,
} as const;

// --- wire shapes ---------------------------------------------------------------------------------

/**
 * One version. `n` only goes up and normally equals `round` + 1 (the UI calls it "Cut n"); `round`
 * is the job's review round when it was made. `durationSec`, `width` and `height` are the
 * composition's, as the run reported them. `current` is the version the live preview is.
 */
export const jobVersionSchema = z.object({
  n: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  current: z.boolean(),
});
export type JobVersion = z.infer<typeof jobVersionSchema>;

/** The job's versions, newest first. A job from before versions has none. */
export const jobVersionsResponseSchema = z.object({
  versions: z.array(jobVersionSchema),
});
export type JobVersionsResponse = z.infer<typeof jobVersionsResponseSchema>;

/** What a version's folder says about itself (v<n>/meta.json). */
export const versionMetaSchema = z.object({
  n: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  preview: z.object({
    durationSec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});
export type VersionMeta = z.infer<typeof versionMetaSchema>;

/** edit/versions/index.json: the live version and every kept one, newest first. */
export const versionIndexSchema = z.object({
  /** The `n` of the live version; `null` before the first. */
  current: z.number().int().positive().nullable(),
  versions: z.array(versionMetaSchema),
});
export type VersionIndex = z.infer<typeof versionIndexSchema>;

export const VERSION_MESSAGES = {
  /** 404, a version the job does not have (never made, or pruned). */
  notFound: 'This job has no such version.',
  /** 409, Restore on a job that is not in Review. */
  notInReview: 'Only a job in Review can go back to an earlier cut.',
  /** 409, Restore on an archived job. */
  archived: 'An archived job cannot go back to an earlier cut.',
} as const;
