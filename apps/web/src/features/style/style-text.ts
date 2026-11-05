/** "1 file", "3 files". */
export function fileCountText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** File names for one line: the first few, then "and 3 more". */
export function namesText(names: readonly string[], shown = 4): string {
  if (names.length <= shown) return names.join(', ');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** What kind of file a name is, for its icon in the Add dialog. */
export type FileKind = 'image' | 'font' | 'video' | 'doc';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'svg',
  'webp',
  'gif',
  'heic',
  'heif',
  'tif',
  'tiff',
]);
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv']);

/** The kind of a file by its extension: anything that is not an image, font or video is a document. */
export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (FONT_EXTENSIONS.has(extension)) return 'font';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'doc';
}
