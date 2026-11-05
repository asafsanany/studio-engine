import type { Job, MusicView, NoSongStatus } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeSongView } from '@/data/test-utils';
import { type SheetSongFiles, sheetSongFiles } from '@/features/job-sheet/sheet-songs';
import { jobSheetJobs } from '@/features/job-sheet/test-fixtures';
import { rowMenuEntries } from '@/features/jobs/row-menu';
import { type PhoneItemRow, phoneMenuRows, songFileRows } from './phone-menu';
import { SHARE_IDLE, type ShareTarget } from './share-video';

// The song's two files as list rows on the phone (Songs, SG9): where Download MP4 was.

const job: Job = { ...jobSheetJobs.approved, id: 'a1b2c3d4e5f6', name: 'Demo 2' };
const READY: NoSongStatus = {
  state: 'ready',
  file: 'Demo 2 · no song.mp4',
  at: '2026-10-25T21:24:00.000Z',
};

const filesOf = (
  noSong: NoSongStatus | undefined,
  music: MusicView = makeSongView(),
): SheetSongFiles => sheetSongFiles({ job, songsOn: true, music, noSong });

const retry = { onTryAgain: vi.fn(), pending: false };

const itemOf = (rows: readonly PhoneItemRow[], id: string): PhoneItemRow => {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

describe('songFileRows', () => {
  it('has a Download row for each file, named like the Mac’s, with its line under the name', () => {
    const rows = songFileRows(filesOf(READY), retry);
    expect(rows.map((row) => row.id)).toEqual(['download', 'download-no-song']);
    expect(itemOf(rows, 'download')).toMatchObject({
      kind: 'item',
      label: 'טורניר בחירות שש בש.mp4',
      detail: 'With the song · to show the client · 0:30',
      href: '/api/jobs/a1b2c3d4e5f6/download',
      disabled: false,
      destructive: false,
    });
    expect(itemOf(rows, 'download-no-song')).toMatchObject({
      label: 'Demo 2 · no song.mp4',
      detail: 'Without it · to post · 0:30',
      href: '/api/jobs/a1b2c3d4e5f6/download?file=no-song',
    });
  });

  it('says the second file is being made, with a spinner row that does nothing', () => {
    const rows = songFileRows(filesOf({ state: 'making' }), retry);
    expect(rows.map((row) => row.id)).toEqual(['download', 'no-song-making']);
    expect(itemOf(rows, 'no-song-making')).toMatchObject({
      label: 'Making the file without the song…',
      busy: true,
      href: null,
    });
  });

  it('says why it is not there in red, and Try again asks the engine again', () => {
    const onTryAgain = vi.fn();
    const rows = songFileRows(
      filesOf({ state: 'failed', message: 'The render stopped: Chrome did not start.' }),
      { onTryAgain, pending: false },
    );
    const row = itemOf(rows, 'no-song-retry');
    expect(row).toMatchObject({
      label: 'Try again',
      detail: 'The render stopped: Chrome did not start.',
      detailTone: 'failure',
      disabled: false,
    });
    row.onSelect();
    expect(onTryAgain).toHaveBeenCalledOnce();
  });

  it('reads a file that is not there (idle) like a failure, and waits for the answer to a press', () => {
    const rows = songFileRows(filesOf({ state: 'idle' }), { onTryAgain: vi.fn(), pending: true });
    expect(itemOf(rows, 'no-song-retry')).toMatchObject({
      detail: 'The file without the song isn’t there.',
      disabled: true,
    });
  });

  it('has no rows for a sheet that is plain or waiting for the status', () => {
    expect(songFileRows({ kind: 'plain' }, retry)).toEqual([]);
    expect(songFileRows(filesOf(undefined), retry)).toEqual([]);
  });
});

describe('phoneMenuRows with the song’s rows', () => {
  const entries = (state: 'approved' | 'delivered') =>
    rowMenuEntries(
      { ...jobSheetJobs[state], id: 'a1b2c3d4e5f6' },
      {
        run: vi.fn(),
        busy: false,
        setEffort: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        archiveAllPaid: vi.fn(),
      },
      null,
      undefined,
      { paidIds: [] },
    );
  const shareMenu = {
    flow: SHARE_IDLE,
    target: { url: '/x', fileName: 'x.mp4', sizeBytes: null } satisfies ShareTarget,
    onShare: () => {},
  };
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  it('puts them where Download MP4 was, for an Approved job whose big button is Share video', () => {
    const songRows = songFileRows(filesOf(READY), retry);
    const plain = phoneMenuRows(entries('approved'), job, undefined, shareMenu);
    const withSong = phoneMenuRows(entries('approved'), job, undefined, shareMenu, songRows);
    expect(ids(plain)).not.toContain('download');
    expect(ids(withSong)).toContain('download');
    expect(ids(withSong)).toContain('download-no-song');
    // Everything else is where it was.
    expect(ids(withSong).filter((id) => !id.startsWith('download'))).toEqual(ids(plain));
    expect(ids(withSong).indexOf('download-no-song')).toBe(ids(withSong).indexOf('download') + 1);
  });

  it('keeps the Share video row of a delivered job, and puts the two files after it', () => {
    const delivered = { ...jobSheetJobs.delivered, id: 'a1b2c3d4e5f6' };
    const files = sheetSongFiles({
      job: delivered,
      songsOn: true,
      music: makeSongView(),
      noSong: READY,
    });
    const rows = phoneMenuRows(
      rowMenuEntries(
        delivered,
        {
          run: vi.fn(),
          busy: false,
          setEffort: vi.fn(),
          archive: vi.fn(),
          unarchive: vi.fn(),
          archiveAllPaid: vi.fn(),
        },
        null,
        undefined,
        { paidIds: [] },
      ),
      delivered,
      undefined,
      shareMenu,
      songFileRows(files, retry),
    );
    expect(ids(rows)).toEqual(['share', 'download', 'download-no-song', 'undeliver', 'archive']);
  });

  it('drops Download MP4 and nothing else while the status is on its way (an empty list of rows)', () => {
    const rows = phoneMenuRows(entries('approved'), job, undefined, null, []);
    expect(ids(rows)).not.toContain('download');
  });

  it('is what it was with no song rows', () => {
    const rows = (songRows?: readonly PhoneItemRow[] | null) =>
      phoneMenuRows(entries('approved'), job, undefined, shareMenu, songRows).map(
        ({ id, label }) => [id, label],
      );
    expect(rows(null)).toEqual(rows());
  });
});
