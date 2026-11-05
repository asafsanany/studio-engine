import type { Job, MusicView, NoSongStatus } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeSongView } from '@/data/test-utils';
import { type SheetSongFiles, sheetSongFiles } from '@/features/job-sheet/sheet-songs';
import { SONG_SHARE_TEXT, songShare } from './song-share';

// What Share video shares for a video whose music is a song (Songs, SG9): the file without the
// song, with the line for Instagram as the share text.

const job: Job = makeJob({
  id: 'a1b2c3d4e5f6',
  name: 'Demo 2',
  relPath: 'Falcon FPV/Demo 2',
  state: 'ready',
  output: {
    fileName: 'Falcon FPV/Demo 2.mp4',
    durationSec: 39,
    width: 1080,
    height: 1920,
    sizeBytes: 27_000_000,
  },
});

const READY: NoSongStatus = {
  state: 'ready',
  file: 'Demo 2 · no song.mp4',
  at: '2026-10-25T21:24:00.000Z',
};

function filesOf(
  noSong: NoSongStatus | undefined,
  music: MusicView = makeSongView(),
): SheetSongFiles {
  return sheetSongFiles({ job, songsOn: true, music, noSong });
}

describe('songShare', () => {
  it('has nothing to say for a job that is not a song job: the caller keeps the export', () => {
    expect(songShare(job, { kind: 'plain' })).toBeUndefined();
    expect(
      songShare(job, sheetSongFiles({ job, songsOn: false, music: makeSongView(), noSong: READY })),
    ).toBeUndefined();
  });

  it('shares the file without the song, with the line as the text, once it is made', () => {
    const share = songShare(job, filesOf(READY));
    expect(share).toEqual({
      target: {
        url: '/api/jobs/a1b2c3d4e5f6/download?file=no-song',
        fileName: 'Demo 2 · no song.mp4',
        sizeBytes: 27_000_000,
        text: 'Post “Demo 2 · no song.mp4”. In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42. That way the reel counts toward the song’s trend.',
      },
      waiting: null,
      note: SONG_SHARE_TEXT.noSong,
      downloadNote: SONG_SHARE_TEXT.noSongDownload,
    });
  });

  it('waits while the file is being made: nothing to fetch, and the button says so', () => {
    expect(songShare(job, filesOf({ state: 'making' }))).toEqual({
      target: null,
      waiting: 'Making the file without the song…',
      note: null,
      downloadNote: null,
    });
  });

  it('fetches nothing while the status is on its way, and says nothing', () => {
    expect(songShare(job, filesOf(undefined))).toEqual({
      target: null,
      waiting: null,
      note: null,
      downloadNote: null,
    });
  });

  it('shares the file with the song, as before Songs, when the other is not there, and says so', () => {
    for (const noSong of [{ state: 'failed', message: 'No.' }, { state: 'idle' }] as const) {
      const share = songShare(job, filesOf(noSong));
      expect(share?.target).toEqual({
        url: '/api/jobs/a1b2c3d4e5f6/download',
        fileName: 'Demo 2.mp4',
        sizeBytes: 27_000_000,
      });
      expect(share?.target?.text).toBeUndefined();
      expect(share?.note).toBe(SONG_SHARE_TEXT.withSong);
    }
  });
});
