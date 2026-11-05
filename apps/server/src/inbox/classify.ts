import { extname } from 'node:path';
import type { InputCounts } from '@studio/shared';

/** What a file in a job folder is. `other` is anything unknown: it counts toward size only. */
export type FileKind = 'video' | 'audio' | 'image' | 'doc' | 'other';

/** The kinds that show up in `InputCounts`. */
export type CountedKind = keyof InputCounts;

// Extensions are lower case with the leading dot, which is what `extname(name).toLowerCase()` gives.
const KIND_EXTENSIONS: Readonly<Record<CountedKind, readonly string[]>> = {
  video: ['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.3gp'],
  audio: ['.opus', '.ogg', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.amr'],
  image: ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.svg', '.tif', '.tiff'],
  doc: ['.txt', '.md', '.pdf', '.docx', '.doc', '.rtf', '.pages'],
};

const KIND_BY_EXTENSION: ReadonlyMap<string, CountedKind> = new Map(
  (Object.entries(KIND_EXTENSIONS) as [CountedKind, readonly string[]][]).flatMap(
    ([kind, extensions]) => extensions.map((extension): [string, CountedKind] => [extension, kind]),
  ),
);

/** Classifies a file by its extension, case-insensitively. Unknown extensions are `other`. */
export function classifyFile(fileName: string): FileKind {
  return KIND_BY_EXTENSION.get(extname(fileName).toLowerCase()) ?? 'other';
}

/** A fresh `InputCounts` with all four keys at zero. */
export function emptyInputCounts(): InputCounts {
  return { video: 0, audio: 0, image: 0, doc: 0 };
}

/** The kinds whose duration adds to a job's footage length. */
export function isTimedKind(kind: FileKind): kind is 'video' | 'audio' {
  return kind === 'video' || kind === 'audio';
}

/** Browser and downloader leftovers: the file is still arriving, so the engine must not see it. */
const PARTIAL_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  '.crdownload',
  '.part',
  '.download',
]);

/** True for `.crdownload`, `.part` and `.download` (Safari's partial download is a folder). */
export function isPartialDownload(name: string): boolean {
  return PARTIAL_DOWNLOAD_EXTENSIONS.has(extname(name).toLowerCase());
}

/** Dotfiles and dot-folders: `.DS_Store`, `.git`, `._AppleDouble`, `.Spotlight-V100`, ... */
export function isDotName(name: string): boolean {
  return name.startsWith('.');
}

/**
 * True for names the engine never looks at, wherever they are: dotfiles and dot-folders (this
 * includes `.DS_Store`) and partial downloads. Works for files and folders alike.
 */
export function isIgnoredName(name: string): boolean {
  return isDotName(name) || isPartialDownload(name);
}

/** Folder name of the video-use workspace inside a job. Ignored at the job root. */
export const EDIT_DIR_NAME = 'edit';

/**
 * Folder name, at the root of a job, of the client's reference material (Generated videos): a video
 * or audio file in it is style to match, never footage, so with the Generate switch on the scanner
 * leaves it out of the job's inputs and footage length. Compared with {@link isReservedName}.
 */
export const REFERENCE_DIR_NAME = 'reference';

/** Folder name of the exports at the top of the inbox. Ignored at client level. */
export const EXPORTS_DIR_NAME = '_Exports';

/**
 * Folder name of the shared fonts at the top of the inbox, `<inbox>/_Fonts` (CVP-201): fonts every
 * client's jobs can use, copied into each job's edit/fonts/. Ignored at client level like
 * `_Exports`, so it is never a client.
 */
export const FONTS_DIR_NAME = '_Fonts';

/**
 * Folder name of the Graphics library at the top of the inbox, `<inbox>/_Graphics` (Graphics
 * plan): one folder per graphic, with its versions and the work of its runs. Ignored at client
 * level like `_Fonts`, whether the Graphics switch is on or not, so it is never a client and the
 * watcher never sees the runs writing there. The engine makes it at boot while the switch is on.
 */
export const GRAPHICS_DIR_NAME = '_Graphics';

/**
 * Folder name of the LUTs library at the top of the inbox, `<inbox>/_LUTs` (LUTs plan): a flat
 * folder with one `.cube` per imported LUT. Ignored at client level like `_Graphics`, whether the
 * LUTs switch is on or not, so it is never a client and the watcher never sees an import writing
 * there. The engine makes it at boot while the switch is on.
 */
export const LUTS_DIR_NAME = '_LUTs';

/**
 * Folder name of a client's style, `<inbox>/<Client>/_Style`: `style.md`, the files it was made
 * from and `kit/`. Ignored at job level, so it is never a job.
 */
export const STYLE_DIR_NAME = '_Style';

/**
 * Folder name of a client's series, `<inbox>/<Client>/_Series/<Series name>`: each series'
 * series.md, kit/ and review-note files (Series plan §2). Ignored at job level like `_Style`,
 * whether series are on or not, so it is never a job. The engine makes it when the first series
 * of the client starts.
 */
export const SERIES_DIR_NAME = '_Series';

/**
 * Folder name of a client's shared files, `<inbox>/<Client>/_Shared`: footage, logos, b-roll and
 * music the client's jobs can all use, so nothing is copied into each job by hand. Before every
 * edit run the Brief step copies it into the job's edit/shared/ (shared-files.ts). Ignored at job
 * level like `_Style` and `_Series`, so it is never a job; the owner makes it in Finder.
 */
export const SHARED_DIR_NAME = '_Shared';

/**
 * Compares a folder name with a reserved name, ignoring case: macOS volumes are case-insensitive
 * by default, so `Edit` on disk is the same folder as `edit`.
 */
export function isReservedName(name: string, reserved: string): boolean {
  return name.toLowerCase() === reserved.toLowerCase();
}

/** True for a file inside the job's `reference/` folder (`reference/ad.mp4`), given its path from the job folder. */
export function isReferencePath(relPath: string): boolean {
  const [first, ...rest] = relPath.split('/');
  return first !== undefined && rest.length > 0 && isReservedName(first, REFERENCE_DIR_NAME);
}

/** True for the client's own folders that are never a job: `_Style`, `_Series` and `_Shared`, in any case. */
export function isReservedJobName(name: string): boolean {
  return (
    isReservedName(name, STYLE_DIR_NAME) ||
    isReservedName(name, SERIES_DIR_NAME) ||
    isReservedName(name, SHARED_DIR_NAME)
  );
}

/**
 * macOS packages: folders that Finder shows as a single file. The scanner treats each one as one
 * file and never looks inside, so a Keynote deck's thumbnails or a Pages document's preview image
 * do not turn into extra images. Their bytes still count toward the job size.
 */
const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pages',
  '.numbers',
  '.key',
  '.rtfd',
  '.app',
  '.photoslibrary',
  '.fcpbundle',
  '.imovielibrary',
  '.logicx',
  '.band',
]);

/** True when a folder with this name is a macOS package (`Brief.pages`, `Deck.key`, ...). */
export function isPackageName(name: string): boolean {
  return PACKAGE_EXTENSIONS.has(extname(name).toLowerCase());
}
