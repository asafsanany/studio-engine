// Formats (Generated videos, GN7) meet Soundtrack (C64): a job with two or more formats has one
// composition per format, `edit/preview/` for the main one and `edit/preview-<id>/` for each other,
// and each composition plays the music.mp3 beside its index.html. The music script only ever
// writes edit/preview/music.mp3, so after a Make another or a Pick the music service calls
// `copyMusicToFormats` and the other formats play the same track in Review, not the old one until
// the render run copies the approved music in.
//
// A job with fewer than two formats has no extra format, so nothing here touches the disk for it.
// A format whose folder is not there (its composition was not built yet) is skipped, and a copy
// that fails is logged and skipped too: the music itself was changed, the page must hear of it.

import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extraFormatsOf, extraPreviewDirName, type JobFormat, MUSIC_FILES } from '@studio/shared';
import type { RunnerLogger } from '../pipeline/claude-process.js';

/** The file every composition plays, next to its index.html. */
const MUSIC_NAME = 'music.mp3';

function errorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether `path` is a folder that exists. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Puts the main composition's music (`edit/preview/music.mp3`) into the folder of every extra
 * format that exists, written whole and moved into place so a player never reads half a file, with
 * a fresh modified time. Resolves with the ids of the formats it updated. Never rejects.
 *
 * @param editDir the job's `edit/` folder
 * @param formats the job's formats (`Job.formats`, the main one first); none or one means nothing to do
 */
export async function copyMusicToFormats(
  editDir: string,
  formats: readonly JobFormat[] | undefined,
  logger: Pick<RunnerLogger, 'warn'>,
  jobId?: string,
): Promise<string[]> {
  const extras = extraFormatsOf(formats);
  if (extras.length === 0) return [];

  let bytes: Buffer;
  try {
    bytes = await readFile(join(editDir, MUSIC_FILES.preview));
  } catch (err) {
    // No music.mp3 in the main composition (nothing picked or made yet): nothing to copy.
    if (errorCode(err) !== 'ENOENT' && errorCode(err) !== 'ENOTDIR') {
      logger.warn(
        { err, jobId },
        'could not read the preview’s music to copy it to the other formats',
      );
    }
    return [];
  }

  const updated: string[] = [];
  for (const format of extras) {
    const folder = join(editDir, extraPreviewDirName(format.id));
    if (!(await isFolder(folder))) continue;
    const temporary = join(folder, `.${MUSIC_NAME}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, join(folder, MUSIC_NAME));
      updated.push(format.id);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      logger.warn(
        { err, jobId, format: format.id },
        `could not put the music into the ${format.label} preview`,
      );
    }
  }
  return updated;
}
