import type { HealthResponse, Job, MusicView, NoSongStatus } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { ApiError, api } from '@/data/api';
import { HEALTH_KEY } from '@/data/health-query';
import { jobStepsKey } from '@/data/job-steps';
import { musicKey } from '@/data/music-query';
import { noSongKey } from '@/data/no-song';
import { notesKey } from '@/data/notes-cache';
import { sentNotesKey, sentNotesQueryOptions } from '@/data/sent-notes';
import {
  createTestQueryClient,
  makeMusicVersion,
  makeMusicView,
  makeSong,
  makeSongView,
} from '@/data/test-utils';
import { JobSheetHistory } from './JobSheetHistory';
import {
  type JobSheetState,
  jobSheetJobs,
  jobSheetNotes,
  jobSheetNow,
  jobSheetStepsResponse,
} from './test-fixtures';

// The part reads the notes they sent through `useSentNotes`; a call-through spy shows what it asked.
const sentNotesHook = vi.hoisted(() => ({ useSentNotes: vi.fn() }));
vi.mock('@/data/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/hooks')>();
  sentNotesHook.useSentNotes.mockImplementation(actual.useSentNotes);
  return { ...actual, useSentNotes: sentNotesHook.useSentNotes };
});

let queryClient: ReturnType<typeof createTestQueryClient>;
let getSentNotes: MockInstance<typeof api.getSentNotes>;
beforeEach(() => {
  queryClient = createTestQueryClient();
  sentNotesHook.useSentNotes.mockClear();
  getSentNotes = vi.spyOn(api, 'getSentNotes');
});
afterEach(() => getSentNotes.mockRestore());

/** The sheet's History part for a job of the boards, with what the other parts already read in the cache. */
function render(state: JobSheetState, { defaultOpen = false, job = jobSheetJobs[state] } = {}) {
  queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse(state));
  queryClient.setQueryData(sentNotesKey(job.id), { jobId: job.id, notes: jobSheetNotes[state] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <JobSheetHistory
        job={job as Job}
        defaultOpen={defaultOpen}
        now={jobSheetNow[state]}
        timeZone="UTC"
      />
    </QueryClientProvider>,
  );
}

/** The `[time, text]` rows of the open list, in order. */
function rows(html: string): [string, string][] {
  return [...html.matchAll(/<li[^>]*><span[^>]*>(.*?)<\/span><span[^>]*>(.*?)<\/span><\/li>/g)].map(
    ([, time = '', text = '']) => [time, text],
  );
}

describe('JobSheetHistory', () => {
  it('is a closed full-width ghost button with a chevron at first', () => {
    const html = render('failed');
    expect(html).toContain('aria-label="History"');
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*aria-expanded="false"/);
    expect(html).toContain('w-[calc(100%+1rem)]');
    expect(html).toContain('>History<');
    expect(html).toContain('lucide-chevron-down');
    expect(html).not.toContain('<ol');
    expect(rows(html)).toEqual([]);
  });

  it('keeps the chevron still while closed, and turns it over (ease-in-out) when open', () => {
    const closed = render('failed');
    expect(closed).toContain('transition-transform');
    expect(closed).toContain('ease-in-out');
    expect(closed).not.toContain('rotate-180');

    const open = render('failed', { defaultOpen: true });
    expect(open).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(open).toContain('rotate-180');
  });

  it('ties the button to the list it opens', () => {
    const html = render('failed', { defaultOpen: true });
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeDefined();
    expect(html).toContain(`<ol id="${controls}"`);
  });

  it('opens on Failed as the board draws it', () => {
    expect(rows(render('failed', { defaultOpen: true }))).toEqual([
      ['12:09', 'Folder appeared'],
      ['12:10', 'Settled: 4 video clips, 1 audio file'],
      ['12:10', 'Started · High'],
      ['12:45', 'First cut ready for review'],
      ['12:50', 'Approved by you'],
      ['12:52', 'Render failed'],
    ]);
  });

  it('opens on Delivered as the board draws it', () => {
    expect(rows(render('delivered', { defaultOpen: true }))).toEqual([
      ['21 Oct', 'Folder appeared'],
      ['21 Oct', 'Settled: 9 video clips, 1 audio file'],
      ['21 Oct', 'Started · Extra high'],
      ['21 Oct', 'First cut ready for review'],
      ['21 Oct', 'Approved by you'],
      ['21 Oct', 'MP4 ready in _Exports/LAKESHORE'],
      ['21 Oct', 'Marked delivered · ₪40'],
    ]);
  });

  it('shows the notes that were sent in a round', () => {
    const texts = rows(render('reviewRound2', { defaultOpen: true })).map(([, text]) => text);
    expect(texts).toContain('You sent 3 notes · round 1');
    expect(texts.at(-1)).toBe('Round 2 ready for review');
  });

  it('counts each round’s notes and orders the rounds by when they were sent', () => {
    const texts = rows(render('archived', { defaultOpen: true })).map(
      ([time, text]) => `${time} ${text}`,
    );
    expect(texts.filter((text) => text.includes('You sent'))).toEqual([
      '10 Sep You sent 2 notes · round 1',
      '11 Sep You sent 1 note · round 2',
    ]);
    // Whatever order the engine listed them in.
    queryClient.setQueryData(sentNotesKey(jobSheetJobs.archived.id), {
      jobId: jobSheetJobs.archived.id,
      notes: [...jobSheetNotes.archived].reverse(),
    });
    const again = rows(
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <JobSheetHistory
            job={jobSheetJobs.archived}
            defaultOpen
            now={jobSheetNow.archived}
            timeZone="UTC"
          />
        </QueryClientProvider>,
      ),
    ).map(([time, text]) => `${time} ${text}`);
    expect(again).toEqual(texts);
  });

  it('gives each row its time in a column of its own and its text its own direction', () => {
    const html = render('cancelled', { defaultOpen: true });
    expect(html).toContain('grid-cols-[72px_minmax(0,1fr)]');
    expect(html).toMatch(/<span dir="auto" class="[^"]*\[unicode-bidi:plaintext\]/);
    expect(rows(html).at(-1)).toEqual(['10:41', 'Cancelled by you during Cut']);
  });

  it('does not read the Review dialog’s notes list', () => {
    const job = jobSheetJobs.reviewRound2;
    queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse('reviewRound2'));
    queryClient.setQueryData(notesKey(job.id), jobSheetNotes.reviewRound2);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetHistory job={job} defaultOpen now={jobSheetNow.reviewRound2} timeZone="UTC" />
      </QueryClientProvider>,
    );
    expect(rows(html).some(([, text]) => text.includes('You sent'))).toBe(false);
  });

  it('has no row for the notes while they are still on their way', () => {
    const job = jobSheetJobs.reviewRound2;
    queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse('reviewRound2'));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetHistory job={job} defaultOpen now={jobSheetNow.reviewRound2} timeZone="UTC" />
      </QueryClientProvider>,
    );
    const texts = rows(html).map(([, text]) => text);
    expect(texts).toContain('First cut ready for review');
    expect(texts.at(-1)).toBe('Round 2 ready for review');
    expect(texts.some((text) => text.includes('You sent'))).toBe(false);
  });

  it('falls back to "You sent notes · round 1", without a count, when the notes could not be loaded', async () => {
    const job = jobSheetJobs.reviewRound2;
    queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse('reviewRound2'));
    getSentNotes.mockRejectedValue(new ApiError(404, 'There is no such job.'));
    await queryClient.prefetchQuery(sentNotesQueryOptions(api, job.id));
    // A server render would show the failed query as fetching again (it would retry on mount); the
    // browser shows it as failed once that retry has failed too.
    queryClient.setQueryDefaults(sentNotesKey(job.id), { retryOnMount: false });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetHistory job={job} defaultOpen now={jobSheetNow.reviewRound2} timeZone="UTC" />
      </QueryClientProvider>,
    );
    expect(rows(html).map(([time, text]) => `${time} ${text}`)).toContain(
      '12:11 You sent notes · round 1',
    );
    expect(html).not.toContain('There is no such job');
    expect(html).not.toContain('role="alert"');
  });

  it('asks for the sent notes only once it is open and a round was sent', () => {
    const asked = (job: Job, defaultOpen: boolean) => {
      sentNotesHook.useSentNotes.mockClear();
      renderToStaticMarkup(
        <QueryClientProvider client={createTestQueryClient()}>
          <JobSheetHistory job={job} defaultOpen={defaultOpen} />
        </QueryClientProvider>,
      );
      return sentNotesHook.useSentNotes.mock.calls;
    };
    const round2 = jobSheetJobs.reviewRound2;
    expect(asked(round2, true)).toEqual([[round2.id, { enabled: true }]]);
    expect(asked(round2, false)).toEqual([[round2.id, { enabled: false }]]);
    // A job that has sent no round has no sent notes to ask for, open or not.
    expect(asked(jobSheetJobs.review, true)).toEqual([
      [jobSheetJobs.review.id, { enabled: false }],
    ]);
    expect(getSentNotes).not.toHaveBeenCalled();
  });

  it('shows what the job says while the step runs have not arrived', () => {
    const job = jobSheetJobs.review;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <JobSheetHistory job={job} defaultOpen now={jobSheetNow.review} timeZone="UTC" />
      </QueryClientProvider>,
    );
    expect(rows(html).map(([, text]) => text)).toEqual([
      'Folder appeared',
      'Settled: 8 video clips, 1 audio file, 3 images',
    ]);
  });
});

// The job's music lines (Soundtrack): read from the `['music', id]` query, which the job.music event
// keeps current, and shown only while the switch is on.
describe('JobSheetHistory: the music lines', () => {
  const health: HealthResponse = {
    ok: true,
    version: '0.27.1',
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
  };
  const at = (time: string) => `2026-10-22T${time}:00.000Z`;

  /** The open History of the Ready-to-review job, with the music the engine answered (`undefined`: not answered). */
  function renderWithMusic(
    music: MusicView | null | undefined,
    { on = true, variant }: { on?: boolean; variant?: 'phone' } = {},
  ) {
    const job = jobSheetJobs.review;
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: on });
    queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse('review'));
    queryClient.setQueryData(sentNotesKey(job.id), { jobId: job.id, notes: jobSheetNotes.review });
    if (music !== undefined) queryClient.setQueryData(musicKey(job.id), music);
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetHistory
          job={job}
          defaultOpen
          now={jobSheetNow.review}
          timeZone="UTC"
          variant={variant}
        />
      </QueryClientProvider>,
    );
  }

  /** The class of the text span of the row that says `text`. */
  const textClass = (html: string, text: string) =>
    html.match(new RegExp(`<span dir="auto" class="([^"]*)">${text}</span>`))?.[1] ?? '';

  const made = makeMusicView({
    picked: 'v2',
    versions: [
      makeMusicVersion(1, { madeAt: at('13:10') }),
      makeMusicVersion(2, { by: 'you', ask: 'darker, heavier drums', madeAt: at('13:20') }),
    ],
    picks: [
      { id: 'v1', at: at('13:10') },
      { id: 'v2', at: at('13:20') },
    ],
  });

  it('puts the music lines among the others in time order', () => {
    expect(rows(renderWithMusic(made))).toEqual([
      ['13:01', 'Folder appeared'],
      ['13:02', 'Settled: 8 video clips, 1 audio file, 3 images'],
      ['13:02', 'Started · Extra high'],
      ['13:10', 'Music v1 made · 0:39 · ElevenLabs'],
      ['13:20', 'Music v2 made · you asked: darker, heavier drums'],
      ['13:20', 'You picked music v2'],
      ['13:35', 'First cut ready for review'],
    ]);
  });

  it('reads the music lines in the normal colour', () => {
    const html = renderWithMusic(made);
    expect(textClass(html, 'Music v1 made · 0:39 · ElevenLabs')).toContain('text-zinc-300');
    expect(textClass(html, 'You picked music v2')).toContain('text-zinc-300');
  });

  it('shows a failure in the failure colour and leaves the other rows alone', () => {
    const html = renderWithMusic(
      makeMusicView({
        versions: [],
        picked: null,
        picks: [],
        failure: {
          id: 'v1',
          code: 'no_credits',
          message: 'ElevenLabs says this month’s credits are used up.',
          at: at('13:06'),
        },
      }),
    );
    const failure = 'Couldn’t make music: ElevenLabs says this month’s credits are used up.';
    expect(rows(html).map(([, text]) => text)).toContain(failure);
    expect(textClass(html, failure)).toContain('text-status-failed-foreground');
    expect(textClass(html, failure)).not.toContain('text-zinc-300');
    expect(textClass(html, 'Folder appeared')).toContain('text-zinc-300');
    expect(html.match(/text-status-failed-foreground/g)).toHaveLength(1);
  });

  it('shows the make going on in the colour of a step that is running', () => {
    const html = renderWithMusic(
      makeMusicView({
        versions: [],
        picked: null,
        picks: [],
        making: { id: 'v1', ask: null, startedAt: at('13:05') },
      }),
    );
    expect(rows(html)).toContainEqual(['13:05', 'Making music for the cut · 0:39']);
    expect(textClass(html, 'Making music for the cut · 0:39')).toContain('text-blue-300');
  });

  it('keeps each line’s own reading direction, on the phone too', () => {
    const html = renderWithMusic(made, { variant: 'phone' });
    expect(html).toMatch(
      /<span dir="auto" class="[^"]*\[unicode-bidi:plaintext\][^"]*">Music v1 made/,
    );
  });

  it('shows no music lines for a job without music.json, or while the answer is not here (the switch is off)', () => {
    const plain = rows(render('review', { defaultOpen: true }));
    expect(rows(renderWithMusic(null))).toEqual(plain);
    expect(rows(renderWithMusic(undefined))).toEqual(plain);
    expect(rows(renderWithMusic(undefined, { on: false }))).toEqual(plain);
  });

  it('reads the answer in the cache, which the job.music event rewrites', () => {
    expect(rows(renderWithMusic(made)).map(([, text]) => text)).not.toContain(
      'You turned the music off',
    );
    const off: MusicView = {
      ...made,
      picked: 'off',
      picks: [...made.picks, { id: 'off', at: at('13:30') }],
    };
    expect(rows(renderWithMusic(off)).map(([, text]) => text)).toContain(
      'You turned the music off',
    );
  });
});

// The song's lines and the second file's (Songs, SG9): read from the music query and the second
// file's status, which the events keep current, and asked for only while Songs is on.
describe('JobSheetHistory: the song’s lines', () => {
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
  const at = (time: string) => `2026-10-22T${time}:00.000Z`;
  const song = makeSongView({
    song: makeSong({ gotAt: at('11:55') }),
    picks: [{ id: 'song', at: at('11:55') }],
  });
  const ready: NoSongStatus = { state: 'ready', file: 'Demo · no song.mp4', at: at('14:01') };
  let getNoSong: MockInstance<typeof api.getNoSong>;
  beforeEach(() => {
    getNoSong = vi.spyOn(api, 'getNoSong').mockResolvedValue({ state: 'none' });
  });
  afterEach(() => getNoSong.mockRestore());

  /** The open History of the Approved job, with what the page holds of its song. */
  function approvedHistory({
    songs = true,
    music = song,
    noSong,
  }: {
    songs?: boolean;
    music?: MusicView;
    noSong?: NoSongStatus;
  } = {}) {
    const job = jobSheetJobs.approved;
    queryClient.setQueryData(HEALTH_KEY, { ...health, songs });
    queryClient.setQueryData(jobStepsKey(job.id), jobSheetStepsResponse('approved'));
    queryClient.setQueryData(sentNotesKey(job.id), { jobId: job.id, notes: [] });
    queryClient.setQueryData(musicKey(job.id), music);
    if (noSong !== undefined) queryClient.setQueryData(noSongKey(job.id), noSong);
    return rows(
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <JobSheetHistory job={job} defaultOpen now={jobSheetNow.approved} timeZone="UTC" />
        </QueryClientProvider>,
      ),
    );
  }

  it('says the song was found when the Brief run ended, and got, and then both files', () => {
    const lines = approvedHistory({ noSong: ready });
    expect(lines.map(([, text]) => text)).toEqual([
      'Folder appeared',
      'Settled: 6 video clips, 1 audio file, 2 images',
      'Started · Extra high',
      'The brief found the song on Yael’s screenshot: נתתי לך בית, Ofek Adanek',
      'Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21',
      'First cut ready for review',
      'Approved by you',
      'MP4 ready in _Exports/RGM',
      'Rendered with the song, and without it',
    ]);
    expect(lines.at(-1)?.[0]).toBe('14:01');
  });

  it('says nothing of a second file until it is made', () => {
    for (const noSong of [{ state: 'making' }, { state: 'idle' }] as const) {
      const lines = approvedHistory({ noSong });
      expect(lines.map(([, text]) => text)).not.toContain('Rendered with the song, and without it');
    }
  });

  it('has no song lines for a job whose music is not a song, with Songs off or on', () => {
    for (const songs of [false, true]) {
      const lines = approvedHistory({ songs, music: makeMusicView() }).map(([, text]) => text);
      expect(lines.some((text) => /song/i.test(text))).toBe(false);
    }
    // Songs off: the second file's status is not asked (`useNoSong` is gated by the switch).
    expect(getNoSong).not.toHaveBeenCalled();
  });
});
