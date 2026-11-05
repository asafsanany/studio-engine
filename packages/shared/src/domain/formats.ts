// Formats (Generated videos, GN7): a second video of the same cut, only when the brief or the owner's
// note explicitly asks for more than one size (`brief.formats`, e.g. 9:16 and 1:1).
//
// The rule that keeps every other job as it was: a job reports `formats` only when it has TWO OR
// MORE of them. With none, or with one, the key is absent from the job, `output` has no `outputs`
// and nothing in the engine looks any different.
//
// The first format is the main one (the brief's `formats[0]`, the canvas the edit is built in).
// What each format owns on disk, relative to the job folder:
//
//   main    edit/preview/index.html        edit/final.mp4            <Client>/<Job>.mp4
//   extra   edit/preview-1x1/index.html    edit/final-1x1.mp4        <Client>/<Job> (1x1).mp4
//
// and, when Review's Export MP4 is pressed on that format (C65), a full-quality video of it kept in
// edit/ and saved under the name the exports use:
//
//   main    edit/review-export.mp4         <Job>.mp4
//   extra   edit/review-export-1x1.mp4     <Job> (1x1).mp4
//
// and over the API (relative to `/api/jobs/:id/`):
//
//   main    preview/index.html   (and every file beside it, as always)
//   extra   preview/1x1/index.html   (and every file beside it)
//
// The format's `id` is its ratio as `<w>x<h>` in lowest terms ("9x16", "1x1", "4x5", "16x9"). It is
// safe in a path and a URL, and it names the extra folder, file and export.

import { z } from 'zod';
import { formatRatioText } from './generate.ts';

/** "1080x1920" as numbers, or `null` when the text is not a canvas size. */
export function parseCanvas(canvas: string): { width: number; height: number } | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(canvas);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The id of a canvas: its ratio in lowest terms, "1080x1920" is "9x16". */
export function formatIdOf(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}x${height / divisor}`;
}

/** A format's id: its ratio as "9x16". */
export const formatIdSchema = z.string().regex(/^\d+x\d+$/);

/** One format of a job with more than one (`Job.formats`, the main one first). */
export const jobFormatSchema = z.object({
  /** The ratio as "9x16": names the extra folder, file and export, and is the preview route's segment. */
  id: formatIdSchema,
  /** What the app shows: "9:16". */
  label: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The format's live composition, relative to `/api/jobs/:id/`. */
  previewPath: z.string().min(1),
});
export type JobFormat = z.infer<typeof jobFormatSchema>;

/** One exported file of a job with more than one format (`JobOutput.outputs`, the main one first). */
export const jobOutputFileSchema = z.object({
  /** The `id` of the format it is. */
  format: formatIdSchema,
  /** Relative to the exports folder, like `JobOutput.fileName`. */
  fileName: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export type JobOutputFile = z.infer<typeof jobOutputFileSchema>;

/** The live composition of a format, relative to `/api/jobs/:id/`. */
export function formatPreviewPath(id: string, main: boolean): string {
  return main ? 'preview/index.html' : `preview/${id}/index.html`;
}

/**
 * The formats a job reports for the sizes its brief asked for: `[]` unless there are two or more
 * different ones. The first size is the main format. A size that repeats an earlier ratio, and
 * text that is not a size, are left out.
 */
export function jobFormatsOf(canvases: readonly string[] | null | undefined): JobFormat[] {
  const formats: JobFormat[] = [];
  for (const canvas of canvases ?? []) {
    const size = parseCanvas(canvas);
    if (size === null) continue;
    const id = formatIdOf(size.width, size.height);
    if (formats.some((format) => format.id === id)) continue;
    formats.push({
      id,
      label: formatRatioText(canvas),
      width: size.width,
      height: size.height,
      previewPath: formatPreviewPath(id, formats.length === 0),
    });
  }
  return formats.length < 2 ? [] : formats;
}

/** The sizes to store for a job's formats: what `jobFormatsOf` reads back, `null` for none. */
export function canvasesOfFormats(formats: readonly JobFormat[] | undefined): string[] | null {
  return formats === undefined || formats.length === 0
    ? null
    : formats.map((format) => `${format.width}x${format.height}`);
}

/** The formats after the main one: the ones that get a composition and a file of their own. */
export function extraFormatsOf(formats: readonly JobFormat[] | undefined): JobFormat[] {
  return formats === undefined ? [] : formats.slice(1);
}

/** An extra format's folder inside edit/: "preview-1x1". */
export function extraPreviewDirName(id: string): string {
  return `preview-${id}`;
}

/** An extra format's rendered video inside edit/: "final-1x1.mp4". */
export function extraFinalName(id: string): string {
  return `final-${id}.mp4`;
}

/** The suffix of an extra format's export name: " (1x1)" in "Job (1x1).mp4". */
export function extraExportSuffix(id: string): string {
  return ` (${id})`;
}

/** An extra format's Review export inside edit/: "review-export-1x1.mp4" (the main format's is "review-export.mp4"). */
export function extraReviewExportName(id: string): string {
  return `review-export-${id}.mp4`;
}

/**
 * The name Review's Export MP4 saves as: "Job.mp4" for the main format (no id), "Job (1x1).mp4" for
 * an extra one, so the two files cannot be mixed up.
 */
export function reviewExportFileName(jobName: string, extraFormatId?: string | null): string {
  const suffix =
    extraFormatId === undefined || extraFormatId === null ? '' : extraExportSuffix(extraFormatId);
  return `${jobName}${suffix}.mp4`;
}
