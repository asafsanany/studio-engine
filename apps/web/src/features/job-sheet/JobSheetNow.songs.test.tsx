import type { HealthResponse, Job, MusicView, NoSongStatus } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { musicKey } from '@/data/music-query';
import { noSongKey } from '@/data/no-song';
import { createTestQueryClient, makeMusicView, makeSongView } from '@/data/test-utils';
import { JobSheetNow } from './JobSheetNow';
import { jobSheetJobs, jobSheetList } from './test-fixtures';

// The Now part of a video with a song (Songs, SG9; board SGSheet): the two files where Download MP4
// was, the line to post, and the sentence that says there are two. With Songs off, no song picked,
// or a job that is not ready, the part is what it was. The part reads the job's music and the
// second file's status from the query cache, which the events keep current.

vi.mock('@/components/jobs/use-now', () => ({ useNow: () => Date.now() }));

const health: HealthResponse = {
  ok: true,
  version: '0.44.6',
  settleMs: 60_000,
  series: false,
  jobSheet: true,
  analytics: false,
  phone: false,
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

const READY: NoSongStatus = {
  state: 'ready',
  file: 'Demo · no song.mp4',
  at: '2026-10-22T14:00:00.000Z',
};

interface Cache {
  songs?: boolean;
  music?: MusicView | null;
  noSong?: NoSongStatus;
}

/** The job's Now part with what the page would hold: the health answer, its music and the second file's status. */
function nowOf(job: Job, { songs = true, music = makeSongView(), noSong }: Cache = {}) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, jobSheetList);
  queryClient.setQueryData(HEALTH_KEY, { ...health, songs });
  if (music !== undefined) queryClient.setQueryData(musicKey(job.id), music);
  if (noSong !== undefined) queryClient.setQueryData(noSongKey(job.id), noSong);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <JobSheetNow job={job} timeZone="UTC" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The downloads the part offers, by the id they carry. */
const downloads = (markup: string) =>
  [...markup.matchAll(/data-sheet-download="([^"]*)"/g)].map((match) => match[1]);

const approved = jobSheetJobs.approved;
const POST_LEAD = `Post “${approved.name} · no song.mp4”. In Instagram tap Add audio`;
const TWO_FILES =
  'Approved and rendered. Two files: one with the song, to show the client, and one without it, to post.';

describe('a video with a song, both files made', () => {
  const html = () =>
    nowOf(approved, { noSong: { ...READY, file: `${approved.name} · no song.mp4` } });

  it('says there are two files', () => {
    expect(text(html())).toContain(TWO_FILES);
    expect(text(html())).not.toContain('The MP4 is ready');
  });

  it('has the two Download rows in place of Download MP4, with the lengths', () => {
    const markup = html();
    expect(downloads(markup)).toEqual(['with-song', 'no-song']);
    expect(markup).not.toContain('data-sheet-download=""');
    expect(markup).toContain(`${approved.name}.mp4`);
    expect(markup).toContain(`${approved.name} · no song.mp4`);
    expect(text(markup)).toContain('With the song · to show the client · 0:30');
    expect(text(markup)).toContain('Without it · to post · 0:30');
    expect(markup).toContain(`/api/jobs/${approved.id}/download"`);
    expect(markup).toContain(`/api/jobs/${approved.id}/download?file=no-song"`);
  });

  it('has the line to post with Copy, and the hint', () => {
    const body = text(html());
    expect(body).toContain('To post on Instagram');
    expect(body).toContain(POST_LEAD);
    expect(body).toContain(
      'slide it to start at 0:42. That way the reel counts toward the song’s trend.',
    );
    expect(body).toContain('Copy it and send it to Yael with the file.');
    expect(html()).toContain('data-sheet-copy-line');
  });

  it('keeps the next step and View preview', () => {
    const markup = html();
    expect(markup).toContain('data-sheet-action="deliver"');
    expect(markup).toContain('data-sheet-action="view-preview"');
  });
});

describe('a video with a song, the second file not made', () => {
  it('says it is being made, with no Download for it yet and the old sentence', () => {
    const markup = nowOf(approved, { noSong: { state: 'making' } });
    expect(text(markup)).toContain('Making the file without the song…');
    expect(downloads(markup)).toEqual(['with-song']);
    expect(text(markup)).toContain('The MP4 is ready');
    expect(text(markup)).not.toContain(TWO_FILES);
    expect(text(markup)).toContain('To post on Instagram');
  });

  it('says why it failed, in red, with Try again', () => {
    const markup = nowOf(approved, {
      noSong: { state: 'failed', message: 'The render stopped: Chrome did not start.' },
    });
    expect(text(markup)).toContain('The render stopped: Chrome did not start.');
    expect(markup).toMatch(/text-status-failed-foreground[^>]*>The render stopped/);
    expect(markup).toContain('data-sheet-action="try-again"');
    expect(downloads(markup)).toEqual(['with-song']);
  });

  it('offers Try again for a file that is not there (a restart mid-render, a lost copy)', () => {
    const markup = nowOf(approved, { noSong: { state: 'idle' } });
    expect(text(markup)).toContain('The file without the song isn’t there.');
    expect(markup).toContain('data-sheet-action="try-again"');
  });

  it('waits for the status instead of showing Download MP4 and then two rows', () => {
    const markup = nowOf(approved, {});
    expect(downloads(markup)).toEqual([]);
    expect(markup).not.toContain('data-slot="job-sheet-song-files"');
    expect(markup).toContain('data-sheet-action="deliver"');
  });
});

describe('a video with a song, delivered', () => {
  it('keeps both files to download, and the sentence of its stage', () => {
    const delivered = jobSheetJobs.delivered;
    const markup = nowOf(delivered, {
      noSong: { ...READY, file: `${delivered.name} · no song.mp4` },
    });
    expect(downloads(markup)).toEqual(['with-song', 'no-song']);
    expect(text(markup)).toContain('Sent to LAKESHORE on 21 Oct.');
    expect(text(markup)).not.toContain(TWO_FILES);
  });
});

describe('the sheet as it was', () => {
  const plainDownload = (markup: string) => downloads(markup).filter((id) => id === '');

  it('has Download MP4 alone with Songs off', () => {
    const markup = nowOf(approved, { songs: false, noSong: READY });
    expect(plainDownload(markup)).toHaveLength(1);
    expect(text(markup)).toContain('The MP4 is ready');
    expect(markup).not.toContain('To post on Instagram');
  });

  it('has Download MP4 alone when no song is picked', () => {
    for (const music of [
      makeMusicView(),
      makeMusicView({ picked: 'off' }),
      makeSongView({ picked: 'v1' }),
      null,
    ]) {
      const markup = nowOf(approved, { music, noSong: READY });
      expect(plainDownload(markup), String(music?.picked)).toHaveLength(1);
      expect(markup).not.toContain('To post on Instagram');
    }
  });

  it('has Download MP4 alone when the engine has no second file for the job', () => {
    const markup = nowOf(approved, { noSong: { state: 'none' } });
    expect(plainDownload(markup)).toHaveLength(1);
    expect(markup).not.toContain('To post on Instagram');
  });

  it('has no files for a job that is not ready', () => {
    const markup = nowOf(jobSheetJobs.review, { noSong: READY });
    expect(markup).not.toContain('To post on Instagram');
    expect(downloads(markup)).toEqual([]);
  });
});
