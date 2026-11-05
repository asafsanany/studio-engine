// What Share video shares on the phone for a video whose music is a song (Songs, SG9): the file
// without the song, to post, with the line for adding the song in Instagram as the share text.
// Pure, like share-video.ts: the sheet reads the job's files (`sheetSongFiles`) and asks.
//
//   plain job (no song, Songs off, not ready)   nothing changes: the export, shared alone
//   the second file is made                     that file, with the line as the share text
//   it is being made (or its status is on its   nothing is fetched; the big button waits with
//     way)                                      "Making the file without the song…"
//   it could not be made                        the file with the song, as before Songs, and a
//                                               line saying so (the sheet's Files has Try again)

import type { Job } from '@studio/shared';
import { type SheetSongFiles, SONG_SHEET_TEXT } from '@/features/job-sheet/sheet-songs';
import { type ShareTarget, shareTargetFor } from './share-video';

/** The muted line under Share video: which file it shares. */
export const SONG_SHARE_TEXT = {
  noSong: 'Shares the file without the song, with the line for Instagram.',
  /** Where the browser cannot share a file, Download MP4 is the same file. */
  noSongDownload: 'Downloads the file without the song.',
  withSong: 'The file without the song isn’t there, so this one has the song in it.',
} as const;

/** What the phone sheet shares and says about it. */
export interface SongShare {
  /** The video to fetch and share: `null` while there is none to share yet. */
  target: ShareTarget | null;
  /** In the big button's place while the second file is made: its words; `null` otherwise. */
  waiting: string | null;
  /** Under the button: which file it shares; `null` for none. */
  note: string | null;
  /** Under the button where it downloads instead (the browser cannot share a file); `null` for none. */
  downloadNote: string | null;
}

/**
 * Share video's target and words for a job's files. `undefined` for a job that is not a song job:
 * the caller keeps the export as the target, as it always did.
 */
export function songShare(job: Job, files: SheetSongFiles): SongShare | undefined {
  if (files.kind === 'plain') return undefined;
  if (files.kind === 'pending')
    return { target: null, waiting: null, note: null, downloadNote: null };
  const { noSong } = files;
  if (noSong.state === 'making') {
    return { target: null, waiting: SONG_SHEET_TEXT.making, note: null, downloadNote: null };
  }
  if (noSong.state === 'failed') {
    return {
      target: shareTargetFor(job, 'export'),
      waiting: null,
      note: SONG_SHARE_TEXT.withSong,
      downloadNote: SONG_SHARE_TEXT.withSong,
    };
  }
  const exported = shareTargetFor(job, 'export');
  return {
    target: {
      url: noSong.file.href,
      fileName: noSong.file.name,
      // The same composition, so about the same size: only the bar's "of 27 MB" until the answer says.
      sizeBytes: exported?.sizeBytes ?? null,
      text: files.post,
    },
    waiting: null,
    note: SONG_SHARE_TEXT.noSong,
    downloadNote: SONG_SHARE_TEXT.noSongDownload,
  };
}
