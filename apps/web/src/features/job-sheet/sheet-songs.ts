// What the job sheet says about a video whose music is a song (Songs, SG9; canvas page "Songs",
// board SGSheet): after Approve there are two files, one with the song to show the client and one
// without it to post, and one line to send with the second file so the song is added in Instagram.
//
//   sheetSongFiles(...)      the sheet's Files section and its "To post on Instagram" line, or why
//                            the sheet is as it was: no song picked, Songs off, the job not ready,
//                            the engine has no second file for it, or its status is not known yet
//   songPostText(song, name) the line Copy puts on the clipboard: "Post “Demo 2 · no song.mp4”. In
//                            Instagram tap Add audio, pick … That way the reel counts toward the
//                            song’s trend."
//   hasTwoFiles(files)       both files are made (the sentence under the title says so)
//
// Pure, like sheet-now.ts and sheet-music.ts: the component reads the job, its music
// (`useJobMusic`) and the second file's status (`useNoSong`) and hands them in. With Songs off, no
// song picked, or a job that is not ready, every function answers "plain": the sheet is exactly
// what it was before Songs.

import {
  clock,
  isFolderDeleted,
  type Job,
  type MusicView,
  type NoSongStatus,
  noSongExportName,
  pickedSong,
  type Song,
} from '@studio/shared';
import { downloadUrl, noSongDownloadUrl } from '@/data';

/** The sheet's own words for the two files and the line. */
export const SONG_SHEET_TEXT = {
  /** The sentence under the title once both files exist (replaces "The MP4 is ready: …"). */
  twoFiles:
    'Approved and rendered. Two files: one with the song, to show the client, and one without it, to post.',
  /** After the file's name, then the length: "With the song · to show the client · 0:39". */
  withSong: 'With the song · to show the client',
  withoutSong: 'Without it · to post',
  download: 'Download',
  making: 'Making the file without the song…',
  tryAgain: 'Try again',
  /** Why the file is not there when the engine does not say (it was never finished, or its copy is gone). */
  missing: 'The file without the song isn’t there.',
  postTitle: 'To post on Instagram',
  postTail: 'That way the reel counts toward the song’s trend.',
  postHint: 'Copy it and send it to Yael with the file.',
  copy: 'Copy',
  copied: 'Copied',
} as const;

/** One of the two files: its name, the muted line under it and where it downloads from. */
export interface SongFile {
  id: 'with-song' | 'no-song';
  name: string;
  sub: string;
  href: string;
}

/**
 * The second file, by where it stands: made (a Download), being made (a spinner), or not made
 * (`failed`, or `idle` after a restart or a lost copy, which read the same): the reason in red and
 * Try again.
 */
export type NoSongRow =
  | { state: 'ready'; file: SongFile }
  | { state: 'making'; name: string }
  | { state: 'failed'; name: string; message: string };

/**
 * `plain`: no second file to show, the sheet is as it was (its Download MP4 stays). `pending`: a
 * song job whose second file's status has not arrived; the Download waits for it, so the button
 * does not change into two rows a moment later. `files`: the two rows and the line.
 */
export type SheetSongFiles =
  | { kind: 'plain' }
  | { kind: 'pending' }
  | { kind: 'files'; withSong: SongFile; noSong: NoSongRow; post: string };

/** What `sheetSongFiles` reads. */
export interface SongFilesSource {
  job: Job;
  /** `/api/health`'s `songs` (with Soundtrack). */
  songsOn: boolean;
  /** The job's music: `null` for a job without music.json, `undefined` until it has arrived. */
  music: MusicView | null | undefined;
  /** The second file's status: `undefined` until it has arrived, or when it could not be read. */
  noSong: NoSongStatus | undefined;
  /** The status could not be read (a failed request): the sheet stays as it was. */
  noSongFailed?: boolean;
}

/** "Name.mp4" out of the export's path, "Client/Name.mp4". */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The line to send with the second file: "Post “Demo 2 · no song.mp4”. In Instagram tap …". */
export function songPostText(song: Pick<Song, 'instagramLine'>, noSongName: string): string {
  return `Post “${noSongName}”. ${song.instagramLine} ${SONG_SHEET_TEXT.postTail}`;
}

/**
 * The sheet's files for a job: two rows where Download MP4 is, and the line to post with the
 * second one. Only a ready job (with its export, its folder still there) whose music is the song
 * and for which the engine makes the second file. Everything else is `plain`.
 */
export function sheetSongFiles({
  job,
  songsOn,
  music,
  noSong,
  noSongFailed = false,
}: SongFilesSource): SheetSongFiles {
  const song = songsOn ? pickedSong(music ?? null) : null;
  if (song === null || job.state !== 'ready' || job.output === null || isFolderDeleted(job)) {
    return { kind: 'plain' };
  }
  if (noSongFailed) return { kind: 'plain' };
  if (noSong === undefined) return { kind: 'pending' };
  if (noSong.state === 'none') return { kind: 'plain' };

  const length = clock(job.output.durationSec);
  const withSong: SongFile = {
    id: 'with-song',
    name: baseName(job.output.fileName),
    sub: `${SONG_SHEET_TEXT.withSong} · ${length}`,
    href: downloadUrl(job.id),
  };
  const name = noSong.state === 'ready' ? noSong.file : noSongExportName(job.name);
  let row: NoSongRow;
  switch (noSong.state) {
    case 'ready':
      row = {
        state: 'ready',
        file: {
          id: 'no-song',
          name,
          sub: `${SONG_SHEET_TEXT.withoutSong} · ${length}`,
          href: noSongDownloadUrl(job.id),
        },
      };
      break;
    case 'making':
      row = { state: 'making', name };
      break;
    case 'failed':
      row = { state: 'failed', name, message: noSong.message };
      break;
    case 'idle':
      row = { state: 'failed', name, message: SONG_SHEET_TEXT.missing };
      break;
  }
  return { kind: 'files', withSong, noSong: row, post: songPostText(song, name) };
}

/** Whether both files are made: the sentence under the title says so. */
export function hasTwoFiles(files: SheetSongFiles): boolean {
  return files.kind === 'files' && files.noSong.state === 'ready';
}
