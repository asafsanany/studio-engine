import type { HealthResponse, Job, MusicView, NoSongStatus } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import { noSongKey } from '@/data/no-song';
import { createTestQueryClient, makeMusicView, makeSongView } from '@/data/test-utils';
import {
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNow,
} from '@/features/job-sheet/test-fixtures';
import { renderAt } from '@/lib/test-router';
import { PhoneJobSheet } from './PhoneJobSheet';

// The phone's job sheet for a video with a song (Songs, SG9; board SGSheet): the two files as list
// rows where Download MP4 was, the line to post with a 44 px Copy, the Music row, and Share video
// sharing the file without the song. With Songs off, or no song picked, the sheet is what it was.

const health: HealthResponse = {
  ok: true,
  version: '0.44.6',
  settleMs: 60_000,
  series: false,
  jobSheet: true,
  analytics: false,
  phone: true,
  graphics: false,
  graphicsInEdits: false,
  music: true,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
  songs: true,
};

const READY = (name: string): NoSongStatus => ({
  state: 'ready',
  file: `${name} · no song.mp4`,
  at: '2026-10-22T14:00:00.000Z',
});

interface Cache {
  songs?: boolean;
  music?: MusicView | null;
  noSong?: NoSongStatus;
}

/** The phone sheet of a job of the boards, with what the page would hold of its song. */
async function sheetOf(
  state: JobSheetState,
  { songs = true, music = makeSongView(), noSong }: Cache = {},
) {
  const job: Job = jobSheetJobs[state];
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, songs });
  if (music !== undefined) queryClient.setQueryData(musicKey(job.id), music);
  if (noSong !== undefined) queryClient.setQueryData(noSongKey(job.id), noSong);
  return renderAt(
    '/jobs',
    <Sheet open>
      <PhoneJobSheet job={job} jobs={jobSheetList} onClose={() => {}} now={jobSheetNow[state]} />
    </Sheet>,
    queryClient,
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tag = (markup: string, needle: string) =>
  markup.match(new RegExp(`<[^>]*${needle}[^>]*>`))?.[0] ?? '';
const menuRows = (markup: string) =>
  [...markup.matchAll(/data-menu-row="([^"]*)"/g)].map((match) => match[1]);

const approved = jobSheetJobs.approved;
const noSongName = `${approved.name} · no song.mp4`;
const POST = `Post “${noSongName}”. In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42. That way the reel counts toward the song’s trend.`;

/** An iPhone: Web Share with files (Node has none). */
function onPhoneThatShares() {
  vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
}
afterEach(() => vi.unstubAllGlobals());

describe('<PhoneJobSheet>: a video with a song, both files made', () => {
  it('has the two files as Download rows where Download MP4 was, with their lines', async () => {
    const markup = await sheetOf('approved', { noSong: READY(approved.name) });
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'download',
      'download-no-song',
      'use-look',
      'unapprove',
      'archive',
    ]);
    const first = tag(markup, 'data-menu-row="download"');
    expect(first).toMatch(/^<a/);
    expect(first).toContain(`href="/api/jobs/${approved.id}/download"`);
    expect(first).toContain(' download=""');
    const second = tag(markup, 'data-menu-row="download-no-song"');
    expect(second).toContain(`href="/api/jobs/${approved.id}/download?file=no-song"`);
    const body = text(markup);
    expect(body).toContain(`${approved.name}.mp4 With the song · to show the client · 0:30`);
    expect(body).toContain(`${noSongName} Without it · to post · 0:30`);
  });

  it('has the line to post under the big button, with a 44 px Copy and the hint', async () => {
    const markup = await sheetOf('approved', { noSong: READY(approved.name) });
    expect(text(markup)).toContain(
      `To post on Instagram Copy ${POST} Copy it and send it to Yael with the file.`,
    );
    expect(tag(markup, 'data-sheet-copy-line')).toMatch(/\bh-11\b/);
    // Under the button, before the notes and the list.
    expect(markup.indexOf('aria-label="To post on Instagram"')).toBeLessThan(
      markup.indexOf('data-slot="phone-sheet-menu"'),
    );
  });

  it('has the Music row of the song in Details, with where it came from', async () => {
    const markup = await sheetOf('approved', { noSong: READY(approved.name) });
    expect(text(markup)).toContain(
      'Music נתתי לך בית · Ofek Adanek From Yael’s screenshot (IMG_4412.PNG). The studio track from YouTube Music; the part used, 0:42 to 1:21.',
    );
  });

  it('shares the file without the song: the big button fetches it and says which file it is', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', { noSong: READY(approved.name) });
    expect(markup).toContain('data-slot="share-getting"');
    expect(text(markup)).toContain(
      'Shares the file without the song, with the line for Instagram.',
    );
    expect(markup).not.toContain('data-slot="share-making"');
  });

  it('where the browser can’t share a file, the big button downloads the second file and says so', async () => {
    const markup = await sheetOf('approved', { noSong: READY(approved.name) });
    const button = tag(markup, 'data-sheet-action="download"');
    expect(button).toContain(`href="/api/jobs/${approved.id}/download?file=no-song"`);
    expect(text(markup)).toContain('Downloads the file without the song.');
  });

  it('keeps Share video and both files for a delivered video', async () => {
    onPhoneThatShares();
    const delivered = jobSheetJobs.delivered;
    const markup = await sheetOf('delivered', { noSong: READY(delivered.name) });
    expect(menuRows(markup)).toEqual([
      'share',
      'download',
      'download-no-song',
      'undeliver',
      'archive',
    ]);
    expect(text(markup)).toContain('To post on Instagram');
  });
});

describe('<PhoneJobSheet>: a video with a song, the second file not made', () => {
  it('says it is being made in the big button’s place, in the list, and fetches nothing', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', { noSong: { state: 'making' } });
    expect(tag(markup, 'data-slot="share-making"')).toMatch(/\bh-12\b/);
    expect(text(markup)).toContain('Making the file without the song…');
    expect(markup).not.toContain('data-slot="share-getting"');
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'download',
      'no-song-making',
      'use-look',
      'unapprove',
      'archive',
    ]);
    expect(tag(markup, 'data-menu-row="no-song-making"')).toContain('role="status"');
  });

  it('says why it failed in red with a Try again row, and shares the file with the song, saying so', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', {
      noSong: { state: 'failed', message: 'The render stopped: Chrome did not start.' },
    });
    expect(menuRows(markup)).toContain('no-song-retry');
    expect(tag(markup, 'data-menu-row="no-song-retry"')).toMatch(/^<button/);
    expect(text(markup)).toContain('Try again The render stopped: Chrome did not start.');
    expect(markup).toMatch(/text-status-failed-foreground[^>]*>The render stopped/);
    expect(markup).toContain('data-slot="share-getting"');
    expect(text(markup)).toContain(
      'The file without the song isn’t there, so this one has the song in it.',
    );
  });

  it('offers Try again for a file that is not there (a restart mid-render, a lost copy)', async () => {
    const markup = await sheetOf('approved', { noSong: { state: 'idle' } });
    expect(text(markup)).toContain('Try again The file without the song isn’t there.');
  });

  it('shows neither Download MP4 nor a button for a moment, until the status is here', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', {});
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'use-look',
      'unapprove',
      'archive',
    ]);
    expect(markup).not.toContain('data-slot="share-getting"');
    expect(markup).not.toContain('data-slot="share-making"');
    expect(markup).not.toContain('To post on Instagram');
  });
});

describe('<PhoneJobSheet>: the sheet as it was', () => {
  it('is what it was with Songs off', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', { songs: false, noSong: READY(approved.name) });
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'use-look',
      'unapprove',
      'archive',
    ]);
    expect(markup).not.toContain('To post on Instagram');
    expect(markup).not.toContain('share-song-note');
    expect(text(markup)).toContain('Getting the video · 0 of 27 MB');
  });

  it('is what it was when no song is picked', async () => {
    onPhoneThatShares();
    for (const music of [makeMusicView(), makeMusicView({ picked: 'off' }), null]) {
      const markup = await sheetOf('approved', { music, noSong: READY(approved.name) });
      expect(menuRows(markup), String(music?.picked)).toEqual([
        'view-preview',
        'deliver',
        'use-look',
        'unapprove',
        'archive',
      ]);
      expect(markup).not.toContain('To post on Instagram');
    }
  });

  it('is what it was when the engine has no second file for the job', async () => {
    onPhoneThatShares();
    const markup = await sheetOf('approved', { noSong: { state: 'none' } });
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'use-look',
      'unapprove',
      'archive',
    ]);
    expect(markup).not.toContain('To post on Instagram');
  });
});
