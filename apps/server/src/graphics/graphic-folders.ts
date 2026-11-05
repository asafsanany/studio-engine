// The folders of the Graphics library (Graphics plan, "What a graphic is, on disk"). OWNER: GR1.
//
//   <inbox>/_Graphics/<folder>/
//     versions/v1/ v2/ …   one whole HyperFrames project per version, never changed once made
//     work/                where a run works; reset from the newest version before every run
//     refs/                the files the owner attached in the chat
//     fonts/               the engine's fresh copy of _Fonts before each run (not part of a version)
//   <inbox>/_Graphics/.upload-<uuid>/   an upload on its way into refs/ (same volume, so a move)
//
// A version (and work/) holds index.html (the host), compositions/lib-<id>.html (the graphic),
// lib/<id>/ (what it loads), vendor/gsap.min.js and about.json.
//
// Every copy is made next to its place and renamed (`COPYFILE_FICLONE`: an APFS clone where the
// volume can, a plain copy where it can't), so a copy cut short never passes for the real thing.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { GRAPHICS_DIR_NAME } from '../inbox/classify.js';
import { copyFontsTo } from '../pipeline/shared-fonts.js';
import {
  errorCode,
  pathExists as exists,
  freeFileNameIn,
  moveFile,
  type TrashedPath,
  trashPath,
} from '../trash-path.js';
import { GSAP_ASSET_PATH } from './graphic-assets.js';
import { renderGraphicHost } from './graphic-host.js';

/** `<inbox>/_Graphics`. */
export function graphicsRoot(inboxPath: string): string {
  return join(inboxPath, GRAPHICS_DIR_NAME);
}

/** `<inbox>/_Graphics/<folder>`: one graphic's folder. */
export function graphicDir(inboxPath: string, folder: string): string {
  return join(graphicsRoot(inboxPath), folder);
}

/** `<graphic>/versions/v<version>`. */
export function graphicVersionDir(dir: string, version: number): string {
  return join(dir, 'versions', `v${version}`);
}

/** `<graphic>/work`: where a run works. */
export function graphicWorkDir(dir: string): string {
  return join(dir, 'work');
}

/** `<graphic>/refs`: the files the owner attached in the chat. */
export function graphicRefsDir(dir: string): string {
  return join(dir, 'refs');
}

/** `<graphic>/fonts`: the copy of _Fonts a run reads. */
export function graphicFontsDir(dir: string): string {
  return join(dir, 'fonts');
}

/** One file attached to a message, as the upload left it before it is moved into refs/. */
export interface ReceivedGraphicFile {
  /** Its name, cleaned like a style upload's (`cleanFileName`). */
  name: string;
  /** Where the upload put it (a staging folder). */
  path: string;
  size: number;
}

/**
 * Where a deleted graphic's folder went: `where` is `~/.Trash/<Name>`, or `<data>/deleted-graphics/<Name>`
 * with `trashed` false (and the `reason`) when macOS would not take it to the Trash.
 */
export type TrashedGraphic = TrashedPath;

export interface GraphicFoldersOptions {
  inboxPath: string;
  /** For `<data>/deleted-graphics/`, where a folder goes when macOS will not take it to the Trash. */
  dataDir: string;
  /** The home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string;
}

/** What `prepareWork` needs to know about the graphic. */
export interface PrepareWorkOptions {
  /** The graphic's id (12 hex): the host mounts compositions/lib-<id>.html. */
  id: string;
  /** The version work/ starts from (the newest one), or `null` for a fresh work/ (v1). */
  fromVersion: number | null;
  /** The host's length for the graphic: the newest version's, or a stand-in before v1. */
  lengthSec: number;
}

/** What a run's work/ starts with before v1 knows its length: the host mounts the graphic for this long. */
export const FIRST_RUN_LENGTH_SEC = 3;

/** Names inside a version's folder that stay out of a version: tools' scratch, never the graphic. */
const SCRATCH_ROOTS = ['node_modules', 'renders', 'snapshots', '.hyperframes/artifacts'] as const;

/** The text files whose graphic id is rewritten when a version is copied to another graphic. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.svg',
  '.txt',
  '.md',
]);

/** An upload folder older than this at boot is a leftover. */
const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** Whether a path inside a project is tools' scratch (see {@link SCRATCH_ROOTS}) or a `.DS_Store`. */
function isScratch(root: string, path: string): boolean {
  if (basename(path) === '.DS_Store') return true;
  const inside = relative(root, path).split(sep).join('/');
  return SCRATCH_ROOTS.some((scratch) => inside === scratch || inside.startsWith(`${scratch}/`));
}

/**
 * Copies the folder `from` to `to` (which must not be there): into a hidden sibling first, then
 * renamed, so `to` is whole or not there. `transform` may change the copy before it is put in place.
 */
async function cloneDir(
  from: string,
  to: string,
  options: {
    filter?: (source: string) => boolean;
    transform?: (staged: string) => Promise<void>;
  } = {},
): Promise<void> {
  const staging = join(dirname(to), `.${basename(to)}-copying-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, staging, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    });
    await options.transform?.(staging);
    await rm(to, { recursive: true, force: true });
    await rename(staging, to);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Every file under `dir`, as paths. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * A copy of a version made for another graphic has the other graphic's id inside it: the
 * composition and its folder are named by id (so several library graphics never clash in an edit),
 * and so is every reference in the files. Renames `compositions/lib-<from>.html` and `lib/<from>/`
 * and rewrites the id in the text files.
 */
async function reidentify(projectDir: string, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const composition = join(projectDir, 'compositions', `lib-${fromId}.html`);
  if (await exists(composition)) {
    await rename(composition, join(projectDir, 'compositions', `lib-${toId}.html`));
  }
  const assets = join(projectDir, 'lib', fromId);
  if (await exists(assets)) await rename(assets, join(projectDir, 'lib', toId));
  for (const file of await filesUnder(projectDir)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    if (relative(projectDir, file).startsWith(`vendor${sep}`)) continue;
    const text = await readFile(file, 'utf8');
    if (text.includes(fromId)) await writeFile(file, text.replaceAll(fromId, toId));
  }
}

/** Everything the library does on disk. OWNER: GR1. */
export class GraphicFolders {
  readonly inboxPath: string;
  readonly dataDir: string;
  private readonly home: string;

  constructor(options: GraphicFoldersOptions) {
    this.inboxPath = options.inboxPath;
    this.dataDir = options.dataDir;
    this.home = options.home ?? homedir();
  }

  /** A graphic's folder by its folder name. */
  dirOf(folder: string): string {
    return graphicDir(this.inboxPath, folder);
  }

  /** The names of the folders in `_Graphics` (the hidden ones left out): names a new graphic must not take. */
  async names(): Promise<string[]> {
    try {
      const entries = await readdir(graphicsRoot(this.inboxPath), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  /** Whether the folder is there. */
  async has(folder: string): Promise<boolean> {
    return exists(this.dirOf(folder));
  }

  /** Whether `versions/v<version>/` is there. */
  async hasVersion(folder: string, version: number): Promise<boolean> {
    return exists(graphicVersionDir(this.dirOf(folder), version));
  }

  /** Makes `<inbox>/_Graphics/<folder>/` with its empty refs/ (a new graphic). Throws when it is already there. */
  async create(folder: string): Promise<void> {
    await mkdir(graphicsRoot(this.inboxPath), { recursive: true });
    await mkdir(this.dirOf(folder));
    await mkdir(graphicRefsDir(this.dirOf(folder)));
  }

  /** Removes a folder that was made and never used (a create that failed half way). */
  async discard(folder: string): Promise<void> {
    await rm(this.dirOf(folder), { recursive: true, force: true });
  }

  /**
   * Renames a graphic's folder (rename, and v1 naming a "New graphic"). Throws when another folder
   * already has the new name; a change of case alone is fine.
   */
  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const source = this.dirOf(from);
    const target = this.dirOf(to);
    if (await exists(target)) {
      const [a, b] = await Promise.all([lstat(source), lstat(target)]);
      if (a.ino !== b.ino || a.dev !== b.dev) throw new Error(`The folder ${to} is already there.`);
    }
    await rename(source, target);
  }

  // --- uploads ----------------------------------------------------------------------------------

  /**
   * An empty folder for an upload to stage its files in, inside `_Graphics` (a hidden folder, on
   * the same volume as every refs/, so storing a file is a rename). The caller removes it.
   */
  async stagingDir(): Promise<string> {
    const dir = join(graphicsRoot(this.inboxPath), `.upload-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Removes the upload folders a stopped engine left behind (at boot). */
  async cleanStaging(now: number = Date.now()): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(graphicsRoot(this.inboxPath));
    } catch {
      return;
    }
    for (const name of entries.filter((entry) => entry.startsWith('.upload-'))) {
      const dir = join(graphicsRoot(this.inboxPath), name);
      try {
        if (now - (await stat(dir)).mtimeMs > STALE_UPLOAD_MS) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        // gone already
      }
    }
  }

  /**
   * Moves the files of a message from their staging place into `<folder>/refs/`, each under its
   * own (cleaned) name or "name (1).ext" when that is taken. Answers their final names, in order.
   */
  async storeRefs(folder: string, files: readonly ReceivedGraphicFile[]): Promise<string[]> {
    const refs = graphicRefsDir(this.dirOf(folder));
    await mkdir(refs, { recursive: true });
    const names: string[] = [];
    for (const file of files) {
      const name = await freeFileNameIn(refs, file.name);
      await moveFile(file.path, join(refs, name));
      names.push(name);
    }
    return names;
  }

  // --- a run's work/ -----------------------------------------------------------------------------

  /** Resets `<folder>/work/` from versions/v<from>/ (or makes it empty, for v1). */
  async resetWork(folder: string, from: number | null): Promise<void> {
    const dir = this.dirOf(folder);
    const work = graphicWorkDir(dir);
    await rm(work, { recursive: true, force: true });
    if (from === null) {
      await mkdir(work, { recursive: true });
      return;
    }
    const version = graphicVersionDir(dir, from);
    if (!(await exists(version))) throw new Error(`v${from} is not in the graphic's folder.`);
    await cloneDir(version, work);
  }

  /**
   * Everything a run starts with: work/ reset from the newest version (or fresh), the host as
   * work/index.html (9:16, nothing behind it), vendor/gsap.min.js, and a fresh copy of the shared
   * fonts in `<graphic>/fonts/`. Answers the fonts copied.
   */
  async prepareWork(folder: string, options: PrepareWorkOptions): Promise<string[]> {
    const dir = this.dirOf(folder);
    const work = graphicWorkDir(dir);
    await this.resetWork(folder, options.fromVersion);
    await mkdir(join(work, 'vendor'), { recursive: true });
    await copyFile(GSAP_ASSET_PATH, join(work, 'vendor', 'gsap.min.js'));
    await writeFile(
      join(work, 'index.html'),
      renderGraphicHost({
        id: options.id,
        lengthSec: options.lengthSec,
        size: '9x16',
        background: null,
        values: {},
      }),
    );
    return copyFontsTo(this.inboxPath, graphicFontsDir(dir));
  }

  /**
   * Rewrites work/index.html for the length the run settled on (about.json's `lengthSec`), so the
   * version's host plays the graphic for as long as it lasts.
   */
  async writeWorkHost(folder: string, id: string, lengthSec: number): Promise<void> {
    await writeFile(
      join(graphicWorkDir(this.dirOf(folder)), 'index.html'),
      renderGraphicHost({ id, lengthSec, size: '9x16', background: null, values: {} }),
    );
  }

  // --- versions ----------------------------------------------------------------------------------

  /**
   * Clones work/ to versions/v<version>/ (COPYFILE_FICLONE): the run's result becomes a version.
   * The tools' scratch (node_modules, renders, snapshots, .hyperframes/artifacts) stays out. A
   * folder already there for that number is an orphan of a run the engine lost, and is replaced.
   */
  async saveVersion(folder: string, version: number): Promise<void> {
    const dir = this.dirOf(folder);
    const work = graphicWorkDir(dir);
    await cloneDir(work, graphicVersionDir(dir, version), {
      filter: (source) => !isScratch(work, source),
    });
  }

  /** "Use vN again": copies versions/v<from>/ to versions/v<to>/. */
  async copyVersion(folder: string, from: number, to: number): Promise<void> {
    const dir = this.dirOf(folder);
    await cloneDir(graphicVersionDir(dir, from), graphicVersionDir(dir, to));
  }

  /**
   * Duplicate: makes `<to>/` (with its refs/) and versions/v1/ copied from
   * `<from>/versions/v<version>/`. The graphics have different ids, so the copy is renamed to its
   * own: `compositions/lib-<toId>.html`, `lib/<toId>/`, and the id in the files. A copy that fails
   * leaves no `<to>/` behind.
   */
  async duplicate(
    from: string,
    version: number,
    to: string,
    ids: { from: string; to: string },
  ): Promise<void> {
    const source = graphicVersionDir(this.dirOf(from), version);
    if (!(await exists(source))) throw new Error(`v${version} is not in the graphic's folder.`);
    await this.create(to);
    try {
      await cloneDir(source, graphicVersionDir(this.dirOf(to), 1), {
        transform: (staged) => reidentify(staged, ids.from, ids.to),
      });
    } catch (error) {
      await this.discard(to).catch(() => undefined);
      throw error;
    }
  }

  // --- delete ------------------------------------------------------------------------------------

  /**
   * Delete: moves the folder into `~/.Trash/<Name>` ("<Name> 2" when the Trash has one by that
   * name). When macOS will not take it (no permission for the engine, another volume), it is moved
   * to `<data>/deleted-graphics/<Name>` instead and the answer says so. Throws when neither works.
   */
  async trash(folder: string): Promise<TrashedGraphic> {
    return trashPath(this.dirOf(folder), {
      home: this.home,
      asideDir: join(this.dataDir, 'deleted-graphics'),
    });
  }
}
