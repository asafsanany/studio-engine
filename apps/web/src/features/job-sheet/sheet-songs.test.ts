import { type Job, type MusicView, type NoSongStatus, noSongExportName } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeMusicView, makeSong, makeSongView } from '@/data/test-utils';
import {
  hasTwoFiles,
  type SheetSongFiles,
  SONG_SHEET_TEXT,
  sheetSongFiles,
  songPostText,
} from './sheet-songs';
import { jobSheetJobs } from './test-fixtures';

// The job sheet's two files and the line to post (Songs, SG9; board SGSheet): which states give
// them, and which leave the sheet exactly as it was.

/** A finished job of the boards' day whose name is plain, so the file names read like the board's. */
const job: Job = makeJob({
  ...jobSheetJobs.approved,
  id: 'a1b2c3d4e5f6',
  client: 'Falcon FPV',
  name: 'Demo 2',
  relPath: 'Falcon FPV/Demo 2',
  output: {
    fileName: 'Falcon FPV/Demo 2.mp4',
    durationSec: 39,
    width: 1080,
    height: 1920,
    sizeBytes: 27_000_000,
  },
});

/** A video whose music is the song of the boards. */
const songMusic: MusicView = makeSongView();

const READY: NoSongStatus = {
  state: 'ready',
  file: 'Demo 2 · no song.mp4',
  at: '2026-10-25T21:24:00.000Z',
};

function filesOf(overrides: Partial<Parameters<typeof sheetSongFiles>[0]> = {}): SheetSongFiles {
  return sheetSongFiles({
    job,
    songsOn: true,
    music: songMusic,
    noSong: READY,
    ...overrides,
  });
}

/** The files of a source that must have them. */
function filesAre(overrides: Partial<Parameters<typeof sheetSongFiles>[0]> = {}) {
  const files = filesOf(overrides);
  if (files.kind !== 'files') throw new Error(`expected files, got ${files.kind}`);
  return files;
}

describe('sheetSongFiles: the song made and the second file ready', () => {
  it('has the two files of the board, with their lengths and where each downloads from', () => {
    const files = filesAre();
    expect(files.withSong).toEqual({
      id: 'with-song',
      name: 'Demo 2.mp4',
      sub: 'With the song · to show the client · 0:39',
      href: '/api/jobs/a1b2c3d4e5f6/download',
    });
    expect(files.noSong).toEqual({
      state: 'ready',
      file: {
        id: 'no-song',
        name: 'Demo 2 · no song.mp4',
        sub: 'Without it · to post · 0:39',
        href: '/api/jobs/a1b2c3d4e5f6/download?file=no-song',
      },
    });
    expect(hasTwoFiles(files)).toBe(true);
  });

  it('has the line to post: the file’s name, the record’s own line, and why', () => {
    expect(filesAre().post).toBe(
      'Post “Demo 2 · no song.mp4”. In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42. That way the reel counts toward the song’s trend.',
    );
  });

  it('names the second file as the engine does, whatever the job is called', () => {
    const hebrew = jobSheetJobs.approved;
    const files = filesAre({
      job: hebrew,
      noSong: { ...READY, file: noSongExportName(hebrew.name) },
    });
    expect(files.noSong).toMatchObject({
      state: 'ready',
      file: { name: `${hebrew.name} · no song.mp4` },
    });
    expect(files.withSong.name).toBe(`${hebrew.name}.mp4`);
  });

  it('keeps the name the engine gave the file for the line (not one made up)', () => {
    const files = filesAre({ noSong: { ...READY, file: 'Demo 2 · no song.mp4' } });
    expect(files.post.startsWith('Post “Demo 2 · no song.mp4”. ')).toBe(true);
  });

  it('says the line of a trending pick, a long title cut by the record, as the record has it', () => {
    const song = makeSong({
      instagramLine:
        'In Instagram tap Add audio, pick Home by Edith and slide it to start at 1:05.',
    });
    const files = filesAre({ music: makeSongView({ song }) });
    expect(files.post).toContain('pick Home by Edith and slide it to start at 1:05.');
  });
});

describe('sheetSongFiles: the second file is not ready', () => {
  it('shows the one being made as a status, with the line already there', () => {
    const files = filesAre({ noSong: { state: 'making' } });
    expect(files.noSong).toEqual({ state: 'making', name: 'Demo 2 · no song.mp4' });
    expect(files.withSong.name).toBe('Demo 2.mp4');
    expect(files.post).toContain('Post “Demo 2 · no song.mp4”.');
    expect(hasTwoFiles(files)).toBe(false);
  });

  it('shows a failure with the engine’s reason', () => {
    const files = filesAre({
      noSong: { state: 'failed', message: 'The render stopped: Chrome did not start.' },
    });
    expect(files.noSong).toEqual({
      state: 'failed',
      name: 'Demo 2 · no song.mp4',
      message: 'The render stopped: Chrome did not start.',
    });
    expect(hasTwoFiles(files)).toBe(false);
  });

  it('reads idle (a restart mid-render, or a lost copy) like a failure, with Try again', () => {
    expect(filesAre({ noSong: { state: 'idle' } }).noSong).toEqual({
      state: 'failed',
      name: 'Demo 2 · no song.mp4',
      message: SONG_SHEET_TEXT.missing,
    });
  });

  it('waits for the status instead of showing Download MP4 for a moment', () => {
    expect(filesOf({ noSong: undefined })).toEqual({ kind: 'pending' });
  });
});

describe('sheetSongFiles: the sheet as it was', () => {
  it('is plain with Songs off', () => {
    expect(filesOf({ songsOn: false })).toEqual({ kind: 'plain' });
  });

  it('is plain when no song is picked: a made version, no music, the folder’s file, off, nothing', () => {
    for (const music of [
      makeMusicView(),
      makeMusicView({ picked: 'off' }),
      makeMusicView({ source: 'supplied', picked: 'file', file: 'music/a.mp3' }),
      makeMusicView({ source: 'none', picked: null, versions: [], reason: 'Rule' }),
      // The song was got but another version is picked now.
      makeSongView({ picked: 'v1' }),
      null,
      undefined,
    ]) {
      expect(filesOf({ music })).toEqual({ kind: 'plain' });
    }
  });

  it('is plain for a job that is not ready, has no export, or whose folder is gone', () => {
    expect(filesOf({ job: jobSheetJobs.review })).toEqual({ kind: 'plain' });
    expect(filesOf({ job: jobSheetJobs.rendering })).toEqual({ kind: 'plain' });
    expect(filesOf({ job: { ...job, output: null } })).toEqual({ kind: 'plain' });
    expect(filesOf({ job: Object.assign({}, job, { folderDeleted: true }) })).toEqual({
      kind: 'plain',
    });
  });

  it('is plain when the engine has no second file for the job (none) or could not be asked', () => {
    expect(filesOf({ noSong: { state: 'none' } })).toEqual({ kind: 'plain' });
    expect(filesOf({ noSong: undefined, noSongFailed: true })).toEqual({ kind: 'plain' });
  });

  it('keeps both files for a delivered job: they are still there to download', () => {
    const delivered = { ...jobSheetJobs.delivered, id: job.id };
    expect(filesOf({ job: delivered }).kind).toBe('files');
  });
});

describe('songPostText', () => {
  it('is the file’s name in quotes, the line, and the reason, in one paragraph', () => {
    expect(songPostText({ instagramLine: 'In Instagram tap Add audio.' }, 'X · no song.mp4')).toBe(
      'Post “X · no song.mp4”. In Instagram tap Add audio. That way the reel counts toward the song’s trend.',
    );
  });
});
