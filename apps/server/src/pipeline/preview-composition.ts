// Whether a run left a live composition in edit/preview/ (Phase 3 §3), and its length and size.
//
// A run that ends in Review succeeds when it exits 0 and edit/preview/index.html names a root
// composition whose data-width, data-height and data-duration parse. The engine reads the preview
// (durationSec, width, height) from those attributes. The parse is light on purpose (no HTML
// dependency): only the first element with data-composition-id matters here, and HyperFrames' own
// lint checks the rest of the file. The check does not require the timeline registry line either:
// the preview route adds the registry when it serves the page.
//
// Formats (GN7): a job with two or more formats has one more composition per extra format, in
// edit/preview-<id>/index.html, read the same way. A run that ends in Review succeeds only when
// ALL of them are valid: each needs its own data-composition-id, data-width, data-height and
// data-duration, its shape must be the format's, and its length the main composition's (one cut).
// A job with one format is read exactly as before.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extraFormatsOf, type JobFormat, type JobPreview } from '@studio/shared';
import { extraPreviewIndexPath, PREVIEW_INDEX_PATH } from './preview-files.js';

/** What a look at edit/preview/index.html found: the composition's size, or what is wrong. */
export type PreviewCheck = { ok: true; preview: JobPreview } | { ok: false; problem: string };

/** Comments, and the contents of script, style and template elements: text that only looks like tags. */
const NOT_MARKUP = /<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** A start tag. A quoted attribute value may hold a `>`. */
const START_TAG =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
/** One attribute: name, then a double-quoted, single-quoted or bare value. */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The longest raw value a problem quotes whole; a longer one is cut to 19 characters plus "…". */
const QUOTED_MAX = 20;

/**
 * The attributes of a start tag's attribute text, by lower-case name (HTML names are
 * case-insensitive). The first one of a name wins. A value is the quoted or bare text, or '' for
 * a bare name.
 */
function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === '' || attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** A raw attribute value as a problem quotes it. */
function quoted(raw: string): string {
  return raw.length > QUOTED_MAX ? `${raw.slice(0, QUOTED_MAX - 1)}…` : raw;
}

/** `value`, read as a number: an empty or blank value is not one. */
function numberOf(raw: string): number {
  const text = raw.trim();
  return text === '' ? Number.NaN : Number(text);
}

/**
 * The composition size and length in the text of an edit/preview/index.html: its first element
 * with `data-composition-id`, which must also have `data-width` and `data-height` (whole numbers
 * above 0) and `data-duration` (a number above 0, in seconds). Pure.
 */
export function previewFromHtml(
  html: string,
  indexPath: string = PREVIEW_INDEX_PATH,
): PreviewCheck {
  const markup = html.replace(NOT_MARKUP, '');
  let root: Map<string, string> | null = null;
  for (const tag of markup.matchAll(START_TAG)) {
    const attributes = attributesOf(tag[2] ?? '');
    if (attributes.has('data-composition-id')) {
      root = attributes;
      break;
    }
  }
  if (root === null) {
    return { ok: false, problem: `${indexPath} has no element with data-composition-id.` };
  }
  const onRoot = `on the root element of ${indexPath}`;
  if ((root.get('data-composition-id') ?? '').trim() === '') {
    return {
      ok: false,
      problem: `the root element of ${indexPath} has an empty data-composition-id.`,
    };
  }
  for (const name of ['data-width', 'data-height', 'data-duration']) {
    if (!root.has(name)) {
      return { ok: false, problem: `the root element of ${indexPath} has no ${name}.` };
    }
  }
  const rawWidth = root.get('data-width') ?? '';
  const rawHeight = root.get('data-height') ?? '';
  const rawDuration = root.get('data-duration') ?? '';
  const width = numberOf(rawWidth);
  if (!Number.isInteger(width) || width <= 0) {
    return {
      ok: false,
      problem: `data-width="${quoted(rawWidth)}" ${onRoot} is not a whole number above 0.`,
    };
  }
  const height = numberOf(rawHeight);
  if (!Number.isInteger(height) || height <= 0) {
    return {
      ok: false,
      problem: `data-height="${quoted(rawHeight)}" ${onRoot} is not a whole number above 0.`,
    };
  }
  const durationSec = numberOf(rawDuration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      ok: false,
      problem: `data-duration="${quoted(rawDuration)}" ${onRoot} is not a number above 0.`,
    };
  }
  return { ok: true, preview: { durationSec, width, height } };
}

/** The `code` of a Node file-system error, when it has one. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** What a file-system error means for a composition's index.html at `indexPath`. */
function readProblem(err: unknown, indexPath: string): string {
  const code = errorCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') return `${indexPath} is missing.`;
  return `${indexPath} could not be read (${code ?? 'unknown error'}).`;
}

/** Looks at `<jobDir>/<indexPath>` and returns the composition it describes, or what is wrong. Never throws. */
async function readComposition(jobDir: string, indexPath: string): Promise<PreviewCheck> {
  const path = join(jobDir, indexPath);
  let html: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, problem: `${indexPath} is not a file.` };
    html = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, problem: readProblem(err, indexPath) };
  }
  return previewFromHtml(html, indexPath);
}

/** How far an extra format's length may be from the main one's, in seconds: one cut, one length. */
export const FORMAT_DURATION_TOLERANCE_SEC = 0.5;
/** How far an extra format's width / height may be from the format's own ratio (1080x1080 is 1). */
const FORMAT_RATIO_TOLERANCE = 0.01;

/**
 * What is wrong with an extra format's composition next to the main one, or `null`: it must be the
 * format's shape and as long as the main composition (the same cut and audio in every format).
 */
function formatProblem(format: JobFormat, main: JobPreview, extra: JobPreview): string | null {
  const path = extraPreviewIndexPath(format.id);
  const wanted = format.width / format.height;
  if (Math.abs(extra.width / extra.height - wanted) > FORMAT_RATIO_TOLERANCE) {
    return `${path} is ${extra.width}x${extra.height}, but the ${format.label} format is ${format.width}x${format.height}.`;
  }
  if (Math.abs(extra.durationSec - main.durationSec) > FORMAT_DURATION_TOLERANCE_SEC) {
    return `${path} is ${extra.durationSec} s long, but ${PREVIEW_INDEX_PATH} is ${main.durationSec} s: every format is the same cut.`;
  }
  return null;
}

/**
 * Looks at `<jobDir>/edit/preview/index.html` and returns the preview it describes, or what is
 * wrong with it. With `formats` (a job with two or more, `Job.formats`) it also looks at
 * `edit/preview-<id>/index.html` of every extra format, and any one of them that is missing or
 * wrong is the answer. The preview it returns is the main composition's. Never throws.
 */
export async function readPreview(
  jobDir: string,
  formats?: readonly JobFormat[],
): Promise<PreviewCheck> {
  const main = await readComposition(jobDir, PREVIEW_INDEX_PATH);
  if (!main.ok) return main;
  for (const format of extraFormatsOf(formats)) {
    const check = await readComposition(jobDir, extraPreviewIndexPath(format.id));
    if (!check.ok) return check;
    const problem = formatProblem(format, main.preview, check.preview);
    if (problem !== null) return { ok: false, problem };
  }
  return main;
}
