// The kit of a Learn pass (Phase 2 plan §5; C14): the graphics the finished job's edit made, kept
// in the client's style folder so the next jobs reuse them.
//
//   <job>/edit/animations/slot_*/   --copy-->   <inbox>/<Client>/_Style/kit/slot_*/
//
// An edit built as one HyperFrames composition has no slots (C14): its graphics are in the
// composition, so those are copied instead, when the job has no slot folders:
//
//   <job>/edit/preview/     (Review on: the live composition the owner approved)
//   <job>/edit/composition/ (Review off: the composition video-use built)
//                           --copy-->   <inbox>/<Client>/_Style/kit/composition/
//
// The first of the two folders that holds anything reusable is the one copied. With neither slots
// nor a composition the job has no graphics to learn, and the client's kit is left exactly as it
// is (nothing is set aside, nothing goes to history).
//
// A graphic of the owner's Graphics library that the edit mounted is not the client's own and is never
// copied (C30): the library is the only source of it, so the next job gets its current version, and
// a graphic that is deleted or turned off stops being used. Its files sit in the project at its root
// (`compositions/lib-<id>.html` and `lib/<id>/`, see `isLibraryGraphicPath`); every kit leaves them
// out: the style's slots and composition, and a series' composition. The mount in index.html stays,
// which is how the kit shows where the graphic played; the next edit copies the graphic's files from
// its own edit/graphics/<id>/.
//
// Render outputs (*.mov, *.mp4, *.webm) are left out: they are big, and they are this job's video,
// not the graphic. In a composition the other video and audio files are left out too (the baked
// cut, the music), as are files over 25 MB and node_modules. Dot files (`.hyperframes` render
// state, `.DS_Store`) are left out everywhere. Files are APFS clones where the volume can, like
// the Brief step's copy of the style (C5).
//
// The kit changes in three moves around the run, so a run that fails or is cut short leaves the
// kit as it was:
//
//   before the run   the job's graphics are copied into .kit-copying/; when there are some,
//                    kit/ ─▶ .kit-previous/ (an empty one when there was no kit) and
//                    .kit-copying/ is renamed to kit/
//   the run worked   .kit-previous/ ─▶ history/<version>-kit/ (see `keepPreviousKit`)
//   it did not       kit/ is removed and .kit-previous/ goes back to kit/ (`restoreKit`)
//
// Both dot folders are invisible to the inbox watcher and to the Brief step's copy. A
// .kit-previous/ found before a run is one a crash left: it still holds the old kit, so the kit/
// next to it is the half-made one and is thrown away.
//
// A series (Series plan §3) keeps a kit the same way, in its own folder: a `series` pass copies the
// episode's composition into `_Series/<name>/kit/` with `prepareKit(jobDir, seriesDir, 'series')`.
// There the composition is the kit itself (`kit/index.html`, `kit/compositions/`), since the next
// episodes are rebuilt from it; slot folders are not a series' kit, so a job without a composition
// has nothing to copy. The three moves are the same, and the kit that was set aside goes to the
// series' history (`keepPreviousKit` with `seriesHistoryKitDirFor`). The composition's music and
// sounds are part of the format, so a series kit also keeps the audio files under `assets/` that
// the composition's HTML or scripts name (C21): an episode is then rebuilt from the kit alone, not
// from the format episode's folder. The style kit still leaves all audio out.
//
// A Read pass that replaces the style (C17) has no new kit to put in place, only an old one to let
// go of. It changes nothing before or during the run; once the new style.md is installed, kit/
// moves to history/<version>-kit/ (see `keepReplacedKit`), so a run that fails or is cut short
// leaves the kit where it was, and Undo brings the old style.md and its kit back together.

import { constants } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { GRAPHIC_ID_PATTERN } from '@studio/shared';
import { isDotName } from '../inbox/classify.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { KIT_DIR_NAME } from './paths.js';

/** Where the edit keeps its graphics, inside the job folder. */
export const ANIMATIONS_PATH = join('edit', 'animations');

/** The graphics folders a Learn pass copies: `edit/animations/slot_<name>/`. */
export const SLOT_PREFIX = 'slot_';

/** What a graphic renders to; never part of the kit. */
export const RENDER_OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set(['.mov', '.mp4', '.webm']);

/** The folder of the kit that holds a copied composition: `_Style/kit/composition/`. */
export const COMPOSITION_KIT_NAME = 'composition';

/**
 * Where a composition-only edit keeps its graphics, in the order they are tried: the live
 * composition of a Review job, then the one video-use builds with the Review switch off.
 */
export const COMPOSITION_PATHS: readonly string[] = [PREVIEW_DIR_PATH, join('edit', 'composition')];

/** The audio a composition holds: music, sounds, speech. A series kit keeps some of it (C21). */
export const COMPOSITION_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.aif',
  '.aiff',
]);

/** The media a composition holds beside its graphics: the baked cut, renders, audio. Not in the style kit. */
export const COMPOSITION_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...RENDER_OUTPUT_EXTENSIONS,
  '.m4v',
  '.mkv',
  '.avi',
  '.mxf',
  ...COMPOSITION_AUDIO_EXTENSIONS,
]);

/** Where a composition keeps its music and sounds; the only audio a series kit takes from it. */
const COMPOSITION_ASSETS_DIR = 'assets';

/** The files that name the composition's audio: its HTML and scripts. */
const REFERENCING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
]);

/** A composition file bigger than this is source media, not a graphic, whatever its type. */
export const COMPOSITION_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** The old kit while a Learn run is going, in the style folder. */
export const PREVIOUS_KIT_NAME = '.kit-previous';

/** The new kit while it is being copied, in the style folder. */
const COPYING_KIT_NAME = '.kit-copying';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The file a library graphic is mounted from, in a project: `compositions/lib-<id>.html`. */
const LIBRARY_COMPOSITION_DIR = 'compositions';
const LIBRARY_COMPOSITION_PREFIX = 'lib-';
const LIBRARY_COMPOSITION_SUFFIX = '.html';
/** The folder of what it loads, in a project: `lib/<id>/`. */
const LIBRARY_ASSETS_DIR = 'lib';

/**
 * Whether a path inside a project (a slot's folder, or a composition's) is a graphic of the
 * Graphics library that the edit mounted (C30): `compositions/lib-<id>.html`, or anything under
 * `lib/<id>/`, `<id>` being a graphic's id (12 hex characters). `path` is relative to the project's
 * root, which is where the Brief step tells the edit to put them. A kit never keeps these.
 */
export function isLibraryGraphicPath(path: string): boolean {
  const [folder, name = '', ...rest] = path
    .split(sep)
    .filter((part) => part !== '' && part !== '.');
  if (folder === LIBRARY_COMPOSITION_DIR) {
    return (
      rest.length === 0 &&
      name.startsWith(LIBRARY_COMPOSITION_PREFIX) &&
      name.endsWith(LIBRARY_COMPOSITION_SUFFIX) &&
      GRAPHIC_ID_PATTERN.test(
        name.slice(LIBRARY_COMPOSITION_PREFIX.length, -LIBRARY_COMPOSITION_SUFFIX.length),
      )
    );
  }
  return folder === LIBRARY_ASSETS_DIR && GRAPHIC_ID_PATTERN.test(name);
}

/** Whether a name in a slot folder is copied into the kit: no render output, no dot file. */
export function isKitFile(name: string): boolean {
  return !isDotName(name) && !RENDER_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase());
}

/** The job's slot folders, `edit/animations/slot_*`, sorted. None when there is no such folder. */
export async function listSlots(jobDir: string): Promise<string[]> {
  const animations = join(jobDir, ANIMATIONS_PATH);
  let entries: string[];
  try {
    entries = await readdir(animations);
  } catch {
    return [];
  }
  const slots: string[] = [];
  for (const name of entries) {
    if (name.startsWith(SLOT_PREFIX) && (await isDirectory(join(animations, name)))) {
      slots.push(name);
    }
  }
  return slots.sort();
}

/**
 * Copies the job's slot folders into `target` (made fresh), without render outputs, dot files or
 * the library graphics a slot mounts. Links are followed, so the kit never points back into the job.
 */
export async function copySlots(jobDir: string, slots: readonly string[], target: string) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const slot of slots) {
    const source = join(jobDir, ANIMATIONS_PATH, slot);
    await cp(source, join(target, slot), {
      recursive: true,
      dereference: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => isKitFile(basename(path)) && !isLibraryGraphicPath(relative(source, path)),
    });
  }
}

/** Whether a name in a composition is copied into the kit: no media, no dot file, no node_modules. */
export function isCompositionKitFile(name: string): boolean {
  return (
    !isDotName(name) &&
    name !== 'node_modules' &&
    !COMPOSITION_MEDIA_EXTENSIONS.has(extname(name).toLowerCase())
  );
}

/** Removes the folders under `dir` that hold no file, `dir` itself last; returns whether `dir` is empty. */
async function pruneEmptyFolders(dir: string): Promise<boolean> {
  let empty = true;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && (await pruneEmptyFolders(path))) {
      await rm(path, { recursive: true, force: true });
    } else {
      empty = false;
    }
  }
  return empty;
}

/** Every file below `dir` (links followed), without dot files and node_modules. */
async function listCompositionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(dir)) {
    if (isDotName(name) || name === 'node_modules') continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) files.push(...(await listCompositionFiles(path)));
    else files.push(path);
  }
  return files;
}

/**
 * The audio files under `source/assets/` that the composition's HTML or scripts name (an
 * `<audio src>`, a path in its JS), by file name, as written or URL-encoded. Whole paths, as the
 * copy sees them.
 */
async function findCompositionAudio(source: string): Promise<Set<string>> {
  const files = await listCompositionFiles(source);
  const assets = join(source, COMPOSITION_ASSETS_DIR);
  const audio = files.filter(
    (path) =>
      path.startsWith(assets + sep) &&
      COMPOSITION_AUDIO_EXTENSIONS.has(extname(path).toLowerCase()),
  );
  const used = new Set<string>();
  if (audio.length === 0) return used;

  const texts: string[] = [];
  for (const path of files) {
    if (!REFERENCING_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const info = await stat(path);
    if (info.size <= COMPOSITION_FILE_MAX_BYTES) texts.push(await readFile(path, 'utf8'));
  }
  const text = texts.join('\n');
  for (const path of audio) {
    const name = basename(path);
    if (text.includes(name) || text.includes(encodeURIComponent(name))) used.add(path);
  }
  return used;
}

/**
 * Copies the reusable parts of one composition folder (HTML, sub-compositions, fonts, images,
 * scripts) into `target`, without media, big files, dot files or the library graphics it mounts,
 * and without the folders that end up empty. Links are followed. `withAudio` also keeps the audio the composition uses (see
 * `findCompositionAudio`). Returns whether anything was copied.
 */
async function copyCompositionFolder(
  source: string,
  target: string,
  withAudio: boolean,
): Promise<boolean> {
  const audio = withAudio ? await findCompositionAudio(source) : new Set<string>();
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    mode: constants.COPYFILE_FICLONE,
    filter: async (path) => {
      if (path === source) return true;
      if (isLibraryGraphicPath(relative(source, path))) return false;
      if (!audio.has(path) && !isCompositionKitFile(basename(path))) return false;
      const info = await stat(path).catch(() => null);
      return info !== null && (info.isDirectory() || info.size <= COMPOSITION_FILE_MAX_BYTES);
    },
  });
  const empty = await pruneEmptyFolders(target);
  if (empty) await rm(target, { recursive: true, force: true });
  return !empty;
}

/**
 * Copies the job's composition into `target/composition/` (`target` made fresh): the first folder
 * of `COMPOSITION_PATHS` that holds anything reusable. Returns whether the job has such a
 * composition.
 */
export async function copyComposition(jobDir: string, target: string): Promise<boolean> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const path of COMPOSITION_PATHS) {
    const source = join(jobDir, path);
    if (!(await isDirectory(source))) continue;
    if (await copyCompositionFolder(source, join(target, COMPOSITION_KIT_NAME), false)) return true;
  }
  return false;
}

/**
 * Copies the job's composition itself into `target` (made fresh), as a series keeps it: the first
 * folder of `COMPOSITION_PATHS` that holds anything reusable, with the audio it uses. Returns that folder's path inside the
 * job (`edit/preview`), or null when the job has no composition.
 */
export async function copySeriesComposition(
  jobDir: string,
  target: string,
): Promise<string | null> {
  await rm(target, { recursive: true, force: true });
  for (const path of COMPOSITION_PATHS) {
    const source = join(jobDir, path);
    if (!(await isDirectory(source))) continue;
    // A new series' folder is made here, with its first kit.
    await mkdir(dirname(target), { recursive: true });
    if (await copyCompositionFolder(source, target, true)) return path;
  }
  return null;
}

/**
 * Where a kit is kept: `style`, the client's `_Style/kit/` (the job's slots, else its composition
 * in `kit/composition/`), or `series`, a series' `kit/` (the composition itself).
 */
export type KitLayout = 'style' | 'series';

/**
 * Copies what the job's edit made into `target` (made fresh). For the style: its slot folders,
 * else its composition, and the names now at the top of `target` (the slots, or `composition`).
 * For a series: its composition, and the folder it came from (`edit/preview`). None when the job
 * has nothing to copy.
 */
async function copyGraphics(jobDir: string, target: string, layout: KitLayout): Promise<string[]> {
  if (layout === 'series') {
    const source = await copySeriesComposition(jobDir, target);
    return source === null ? [] : [source];
  }
  const slots = await listSlots(jobDir);
  if (slots.length > 0) {
    await copySlots(jobDir, slots, target);
    return slots;
  }
  return (await copyComposition(jobDir, target)) ? [COMPOSITION_KIT_NAME] : [];
}

/**
 * Before a Learn run (or a series pass, `layout` `series`): copies the job's graphics and, when
 * there are some, sets the folder's kit aside and puts the copy in a fresh `kit/` (see
 * `copyGraphics` for what is copied and returned). None when the job has nothing to copy: the kit
 * is then left as it is (a kit a crashed run set aside is put back), so a job without graphics
 * never empties a kit.
 */
export async function prepareKit(
  jobDir: string,
  folder: string,
  layout: KitLayout = 'style',
): Promise<string[]> {
  const kit = join(folder, KIT_DIR_NAME);
  const previous = join(folder, PREVIOUS_KIT_NAME);
  const copying = join(folder, COPYING_KIT_NAME);
  try {
    // Copied before anything is moved: a copy that fails or finds nothing leaves the kit alone.
    const names = await copyGraphics(jobDir, copying, layout);
    if (names.length === 0) {
      await restoreKit(folder);
      return names;
    }

    if (await isDirectory(previous)) {
      // An earlier run was cut short: the old kit is still set aside, kit/ is its half-made one.
      await rm(kit, { recursive: true, force: true });
    } else if (await isDirectory(kit)) {
      await rename(kit, previous);
    } else {
      await rm(kit, { recursive: true, force: true });
      await mkdir(previous, { recursive: true });
    }
    await rename(copying, kit);
    return names;
  } finally {
    await rm(copying, { recursive: true, force: true });
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  return (await readdir(path)).length === 0;
}

/** The run failed or was stopped: the kit of `folder` is put back as it was before `prepareKit`. */
export async function restoreKit(folder: string): Promise<void> {
  const previous = join(folder, PREVIOUS_KIT_NAME);
  if (!(await isDirectory(previous))) return;
  const kit = join(folder, KIT_DIR_NAME);
  await rm(kit, { recursive: true, force: true });
  if (await isEmptyDirectory(previous)) await rm(previous, { recursive: true, force: true });
  else await rename(previous, kit);
}

/** Moves a folder, also to another volume (the data folder need not share the inbox's). */
export async function moveFolder(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await cp(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * The new style (or series.md) is in place: the kit that was set aside goes to `historyKitDir`
 * (`history/<version>-kit/`, empty when there was no kit), next to the document it went with.
 * An empty one is only kept when that document was (`styleKept`); otherwise there is nothing to
 * go back to and it is removed.
 */
export async function keepPreviousKit(
  folder: string,
  historyKitDir: string,
  styleKept: boolean,
): Promise<void> {
  const previous = join(folder, PREVIOUS_KIT_NAME);
  if (!(await isDirectory(previous))) return;
  if (!styleKept && (await isEmptyDirectory(previous))) {
    await rm(previous, { recursive: true, force: true });
    return;
  }
  await moveFolder(previous, historyKitDir);
}

/**
 * A Read pass replaced the style (C17), or Start a series took the style's kit for the series
 * (Series plan §3), and the new style.md has no kit: the client's `kit/` goes to `historyKitDir`
 * (`history/<version>-kit/`), next to the style.md it went with, so Undo brings both back. Returns whether there was a kit to keep; without one nothing is created, and
 * Undo leaves the kit as it is, as it does for any style whose kit did not change.
 */
export async function keepReplacedKit(styleDir: string, historyKitDir: string): Promise<boolean> {
  const kit = join(styleDir, KIT_DIR_NAME);
  if (!(await isDirectory(kit))) return false;
  await moveFolder(kit, historyKitDir);
  return true;
}
