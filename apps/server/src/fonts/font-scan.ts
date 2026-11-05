// "Used in" for fonts (Fonts plan, build 2). OWNER: FN17.
//
// What fonts did a finished edit actually use? A plain scan of its compositions, strings only: no
// browser, no ffmpeg, nothing is rendered or executed.
//
//   <job>/edit/**/*.html and *.css
//     ─▶ the family names written in `font-family` (a CSS property or an SVG attribute), in the
//         `font` shorthand and in CSS variables
//         (`--title-font: "Secular One", Heebo, sans-serif`), and in `@font-face` (its own
//         `font-family`, the file its `src` points at and `local()` names)
//     ─▶ those that are a family of the library (without regard to case) ─▶ the families found
//
// Weights are not told: a scan reads names, and which weight a rule picks is the browser's call, so
// the callers record weight "any" (`FONT_USE_ANY_WEIGHT` in the font repository).
//
// A composition often names a font by an alias of its own: `@font-face { font-family: "HeeboCap";
// src: url(heebo-latin-500-normal.woff2) }`. The family name alone would miss it, so an
// `@font-face` also counts for the library family its file (or `local()` name) starts with:
// `heebo-latin-500-normal.woff2` and `Heebo-Bold.ttf` are Heebo, `RubikSprayPaint-Regular.ttf` is
// Rubik Spray Paint and not Rubik (the longest family that fits wins).
//
// Where it looks. Everything under `edit/` that is a `.html` or `.css` file of 2 MB or less, except
// folders that are not the composition: `node_modules`, `vendor` and anything hidden at any depth,
// and, directly inside `edit/`:
//   fonts/    the job's copy of the whole library: it is every font, not the ones used
//   review/   the notes, not a composition
//   style/    the client's saved style kit, a reference the edit may or may not take from
//   graphics/ the library graphics the Brief step copies in, whether the edit mounts them or not
//             (a mounted one is in the preview, which is scanned)
//   work/     the edit's scratch: earlier versions of the preview index of every round
// (The first two are the plan's; the last three come from looking at real jobs: a graphic nobody
// mounted and a style kit nobody used would each count a font the video does not have.)
//
// Nothing here writes anything, and nothing here throws for a file it cannot read: that file is
// left out (and said, to the logger). A folder that is not there has no fonts.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fontNameKey } from '@studio/shared';
import type { WorkerLogger } from '../pipeline/worker.js';

/** A file bigger than this is not read: a composition that big is mostly data. */
export const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

/** A project is a handful of files; this keeps a runaway folder from making the scan slow. */
const MAX_FILES = 2_000;

/** Folders left out at any depth (hidden ones, whose name starts with a dot, are left out too). */
const SKIPPED_ANYWHERE: ReadonlySet<string> = new Set(['node_modules', 'vendor']);

/** Folders left out when they are directly inside `edit/` (see the header). */
export const SKIPPED_IN_EDIT: ReadonlySet<string> = new Set([
  'fonts',
  'review',
  'style',
  'graphics',
  'work',
]);

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

// --- finding the files ---------------------------------------------------------------------------

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/** The `.html` and `.css` files under `dir`: no symlinks, nothing hidden, nothing skipped above. */
async function compositionFiles(dir: string, top: boolean, found: string[]): Promise<void> {
  const entries = await listDir(dir);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (found.length >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_ANYWHERE.has(entry.name)) continue;
      if (top && SKIPPED_IN_EDIT.has(entry.name)) continue;
      await compositionFiles(path, false, found);
    } else if (entry.isFile() && /\.(?:html|css)$/i.test(entry.name)) {
      found.push(path);
    }
  }
}

// --- reading family names out of text --------------------------------------------------------------

/** Comments say nothing: a rule that is commented out is not used. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

/** A style attribute can quote its names as entities: `style="font-family: &quot;Heebo&quot;"`. */
function withoutEntities(text: string): string {
  return text.replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
}

/** A name longer than this is not a font name, it is something else in quotes. */
const MAX_NAME = 80;

/**
 * The family names of the list that starts at `from` (after the colon of a `font-family`
 * declaration): quoted or plain names, separated by commas, up to the first thing that is not a
 * list (the `;` or `}` that ends the declaration, the quote that ends a style attribute, `!important`).
 * A `var(...)` or any other function ends the list: whatever it points at is declared elsewhere.
 */
function familyList(text: string, from: number): string[] {
  const names: string[] = [];
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1 || end - i - 1 > MAX_NAME) break;
      const name = text.slice(i + 1, end);
      if (name.includes('\n')) break;
      names.push(name);
      i = end + 1;
    } else {
      let j = i;
      while (j < text.length && !/[,;{}"'<>()!\\\n\r]/.test(text.charAt(j))) j += 1;
      const name = text.slice(i, j).trim();
      // `inherit`, `var(` and the like: a word with a bracket after it is a function, not a name.
      if (name === '' || j - i > MAX_NAME || text.charAt(j) === '(') break;
      names.push(name);
      i = j;
    }
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
    if (text.charAt(i) !== ',') break;
    i += 1;
  }
  return names;
}

/**
 * Where the family list of a `font` shorthand begins: after the size (and the `/line-height`), as
 * in `font: 600 64px/1.26 "Akrobat", "HeeboCap", sans-serif`. `null` when the value has no size
 * (a variable, a system font keyword): there is nothing to read.
 */
const FONT_SIZE =
  /^[^;{}"'()<>\n]*?(?:\d*\.?\d+(?:px|pt|em|rem|%|vw|vh|vmin|vmax|ex|ch|cm|mm|in|pc)|(?:xx?-)?(?:small|large)|medium|smaller|larger)(?:\s*\/\s*[^\s,;}"']+)?(?:\s+|(?=["']))/i;

function afterFontSize(text: string, from: number): number | null {
  const match = FONT_SIZE.exec(text.slice(from, from + 400));
  return match === null ? null : from + match[0].length;
}

/** Declarations that hold a list of family names: `font-family`, a CSS variable, `font` and SVG's attribute. */
const FAMILY_DECLARATION = /(?<![\w-])(?:font-family|--[\w-]+)\s*:/gi;
const FONT_SHORTHAND = /(?<![\w-])font\s*:/gi;
/** An SVG presentation attribute: `<text font-family="'Secular One', Heebo">`. */
const FAMILY_ATTRIBUTE = /(?<![\w-])font-family\s*=\s*["']?/gi;

/** Every family name written in a declaration of `text`, in order, with repeats. */
function declaredNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(FAMILY_DECLARATION)) {
    names.push(...familyList(text, match.index + match[0].length));
  }
  for (const match of text.matchAll(FAMILY_ATTRIBUTE)) {
    names.push(...familyList(text, match.index + match[0].length));
  }
  for (const match of text.matchAll(FONT_SHORTHAND)) {
    const start = afterFontSize(text, match.index + match[0].length);
    if (start !== null) names.push(...familyList(text, start));
  }
  return names;
}

// --- @font-face sources ------------------------------------------------------------------------------

const FONT_FACE_BLOCK = /@font-face\s*\{([^}]*)\}/gi;
const URL_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']+))\s*\)/gi;
const LOCAL_REFERENCE = /local\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']+))\s*\)/gi;

/** The file name of a `url(...)`, without its folders, query or extension; `null` for inline data. */
function fileStem(reference: string): string | null {
  if (/^\s*data:/i.test(reference)) return null;
  let path = reference.split(/[?#]/)[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not valid percent-encoding: the text as written is the name.
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const stem = name.replace(/\.(?:ttf|otf|woff2?|eot|svg|ttc)$/i, '');
  return stem === '' ? null : stem;
}

/** The names a face's source points at: the stems of its files and its `local()` names. */
function sourceNames(block: string): string[] {
  const names: string[] = [];
  for (const match of block.matchAll(URL_REFERENCE)) {
    const stem = fileStem(match[1] ?? match[2] ?? match[3] ?? '');
    if (stem !== null) names.push(stem);
  }
  for (const match of block.matchAll(LOCAL_REFERENCE)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (name !== '') names.push(name);
  }
  return names;
}

/** Letters and digits only, lower case: "Rubik Spray Paint", "RubikSprayPaint" and "rubik-spray-paint" agree. */
function compact(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The library family a file or `local()` name starts with: the longest run of its leading words
 * (split at spaces, hyphens, underscores and dots; a variable font's `[wght]` is dropped) that
 * spells a family. `Heebo-Bold` → Heebo; `heebo-latin-500-normal` → Heebo; `RubikSprayPaint-Regular`
 * → Rubik Spray Paint; `Rubik-Mono-One` → Rubik Mono One when the library has it, else Rubik.
 */
function familyOfSource(name: string, byCompact: ReadonlyMap<string, string>): string | undefined {
  const words = name
    .replace(/\[[^\]]*\]/g, '')
    .split(/[\s_\-.+]+/)
    .filter((word) => word !== '');
  for (let count = words.length; count >= 1; count -= 1) {
    const family = byCompact.get(compact(words.slice(0, count).join('')));
    if (family !== undefined) return family;
  }
  return undefined;
}

// --- the scan --------------------------------------------------------------------------------------------

/** The library families named in one file's text, added to `found` (as the library spells them). */
function scanText(
  raw: string,
  byKey: ReadonlyMap<string, string>,
  byCompact: ReadonlyMap<string, string>,
  found: Set<string>,
): void {
  const text = withoutEntities(withoutComments(raw));
  for (const name of declaredNames(text)) {
    const family = byKey.get(fontNameKey(name));
    if (family !== undefined) found.add(family);
  }
  for (const block of text.matchAll(FONT_FACE_BLOCK)) {
    for (const name of sourceNames(block[1] ?? '')) {
      const family = familyOfSource(name, byCompact);
      if (family !== undefined) found.add(family);
    }
  }
}

/**
 * The library families a job's finished edit uses: `jobDir` is the job's folder (the one that holds
 * `edit/`) and `familyNames` the library's families, as the font index spells them. Answers the
 * families found, each once, in the library's spelling, sorted. A job with no `edit/` folder, a
 * library with no families, and an edit that names none all answer an empty list.
 *
 * Reads only; a file it cannot read is left out and said to `logger`. Throws only for a folder it
 * cannot list (permissions), which the caller logs.
 */
export async function scanJobFonts(
  jobDir: string,
  familyNames: Iterable<string>,
  logger: WorkerLogger = SILENT,
): Promise<string[]> {
  const byKey = new Map<string, string>();
  const byCompact = new Map<string, string>();
  for (const name of familyNames) {
    const key = fontNameKey(name);
    if (key === '' || byKey.has(key)) continue;
    byKey.set(key, name);
    const short = compact(name);
    if (short !== '' && !byCompact.has(short)) byCompact.set(short, name);
  }
  if (byKey.size === 0) return [];

  const files: string[] = [];
  await compositionFiles(join(jobDir, 'edit'), true, files);
  const found = new Set<string>();
  for (const file of files) {
    try {
      if ((await stat(file)).size > MAX_SCANNED_FILE_BYTES) continue;
      scanText(await readFile(file, 'utf8'), byKey, byCompact, found);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      logger.warn({ err, file }, 'could not read a composition file for its fonts');
    }
  }
  return [...found].sort();
}
