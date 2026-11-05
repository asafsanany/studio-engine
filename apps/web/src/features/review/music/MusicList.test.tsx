import { type HealthResponse, MUSIC_NOT_ASKED_REASON, type MusicView } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { notesKey } from '@/data/notes-cache';
import {
  createTestQueryClient,
  makeMusicVersion,
  makeMusicView,
  makeReviewNote,
  makeSeriesSummary,
  makeSong,
  makeSongFailure,
  makeSongView,
  SERIES_CLIENT,
} from '@/data/test-utils';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { renderReview, tagWith } from '../test-helpers';
import { MusicList } from './MusicList';

// The Music list, server-rendered in each of the eight states of board SDMusic (making, failed, off,
// the folder's file, a style that says no music, a series episode …), for the Mac and the phone.

const JOB = 'r1';

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function render(
  music: MusicView,
  props: Partial<React.ComponentProps<typeof MusicList>> = {},
  queryClient: QueryClient = createTestQueryClient(),
): string {
  return renderReview(<MusicList jobId={JOB} music={music} {...props} />, queryClient);
}

/** The radio row for `id`: its opening tag and everything inside it. */
function row(markup: string, id: string): string {
  const open = markup.indexOf(`data-row="${id}"`);
  if (open === -1) throw new Error(`no row ${id}`);
  const start = markup.lastIndexOf('<button', open);
  return markup.slice(start, markup.indexOf('</button>', open) + '</button>'.length);
}

const twoVersions = makeMusicView({
  picked: 'v2',
  versions: [
    makeMusicVersion(1, { madeAt: '2020-10-23T09:01:00.000Z' }),
    makeMusicVersion(2, {
      ask: 'darker, heavier drums',
      describe: 'You asked: darker, heavier drums. Same shape: the drop at 0:18.',
      by: 'you',
      madeAt: '2020-10-23T09:12:00.000Z',
    }),
  ],
});

describe('<MusicList> made for this video', () => {
  it('has the header and the source line', () => {
    const html = render(twoVersions);
    expect(text(html)).toContain('Music Made for this video by ElevenLabs · 0:39');
    expect(tagWith(html, 'data-slot="music-source"')).toContain('dir="auto"');
  });

  it('is a radio group of the versions, newest first, then No music', () => {
    const html = render(twoVersions);
    expect(tagWith(html, 'role="radiogroup"')).toContain('aria-label="Pick the music"');
    const order = [...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['v2', 'v1', 'off']);
  });

  it('checks the pick and tags it "in the preview"', () => {
    const html = render(twoVersions);
    expect(row(html, 'v2')).toContain('aria-checked="true"');
    expect(row(html, 'v2')).toContain('in the preview');
    expect(row(html, 'v1')).toContain('aria-checked="false"');
    expect(row(html, 'v1')).not.toContain('in the preview');
    expect(row(html, 'off')).toContain('aria-checked="false"');
  });

  it('shows each version’s line and time', () => {
    const html = render(twoVersions);
    expect(text(row(html, 'v2'))).toContain(
      'v2 in the preview You asked: darker, heavier drums. Same shape: the drop at 0:18.',
    );
    expect(text(row(html, 'v1'))).toContain('v1 Intense cinematic electronic, 120 BPM.');
    // Old times are a clock time with the day (these versions are from 2020).
    expect(text(row(html, 'v2'))).toContain('23 Oct, ');
  });

  it('draws the cut’s shape under the playing version only, with the drop lit', () => {
    const html = render(twoVersions);
    const v2 = row(html, 'v2');
    expect(v2).toContain('role="img"');
    expect(v2).toContain('aria-label="Written to the cut: build 0:00 to 0:10');
    expect(v2.match(/style="flex:\d+ 1 0"/g)).toHaveLength(5);
    expect(v2.match(/data-hot="true"/g)).toHaveLength(1);
    expect(v2).toContain('flex:10000 1 0');
    // The caption is in pieces (the drop is lit): without the markup it reads as one line.
    expect(v2.replace(/<[^>]*>/g, '')).toContain('Build, rise, drop at 0:18, golden, logo at 0:34');
    expect(row(html, 'v1')).not.toContain('role="img"');
    expect(row(html, 'off')).not.toContain('role="img"');
  });

  it('has the Make another form: the words box, Make v3 and the hint', () => {
    const html = render(twoVersions);
    expect(text(html)).toContain('Make another');
    expect(html).toContain('placeholder="What should change? (optional)"');
    expect(html).toContain('maxLength="200"');
    expect(text(html)).toContain('Make v3');
    expect(text(html)).toContain(
      'Calmer, darker, piano… or leave it empty for another take. About 30 s, same shape, so the cuts stay on the beat.',
    );
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
  });

  it('ties the label to the words box', () => {
    const html = render(twoVersions);
    const label = tagWith(html, '<label');
    const id = /for="([^"]+)"/.exec(label)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`id="${id}"`);
  });

  it('has the Mac’s close button only when given a way to close', () => {
    expect(render(twoVersions)).not.toContain('aria-label="Close"');
    expect(render(twoVersions, { onClose: () => {} })).toContain('aria-label="Close"');
    expect(render(twoVersions, { variant: 'phone', onClose: () => {} })).not.toContain(
      'aria-label="Close"',
    );
  });

  it('keeps the keys typed in it to itself (the player’s Space and arrows stay out)', () => {
    expect(render(twoVersions)).toContain('data-own-keys=""');
  });
});

describe('<MusicList> making', () => {
  const making = makeMusicView({
    making: { id: 'v2', ask: 'darker, heavier drums', startedAt: '2026-10-23T09:29:00.000Z' },
  });

  it('puts the making row at the top: v2, the words, v1 keeps playing, about 30 s', () => {
    const html = render(making);
    const status = tagWith(html, 'data-slot="music-making"');
    expect(status).toContain('role="status"');
    const box = html.slice(html.indexOf('data-slot="music-making"'));
    expect(text(box.slice(0, box.indexOf('data-row='))).replace(/^[^>]*>/, '')).toContain(
      'v2 Making it: darker, heavier drums. v1 keeps playing. ~30 s',
    );
    expect(html.indexOf('data-slot="music-making"')).toBeLessThan(html.indexOf('data-row="v1"'));
  });

  it('spins, and turns the button into Making… that cannot be pressed', () => {
    const html = render(making);
    expect(html).toContain('animate-spin');
    expect(text(html)).toContain('Making…');
    expect(tagWith(html, 'type="submit"')).toContain('disabled=""');
    expect(html).toMatch(/<input[^>]*\sdisabled=""/);
  });

  it('says there is another take, and the current one keeps playing, with no words', () => {
    const html = render(
      makeMusicView({ making: { id: 'v2', ask: null, startedAt: '2026-10-23T09:29:00.000Z' } }),
    );
    expect(text(html)).toContain('Making another take. The current one keeps playing.');
  });
});

describe('<MusicList> failed', () => {
  const failed = makeMusicView({
    failure: {
      id: 'v2',
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      at: '2026-10-23T09:20:00.000Z',
    },
  });

  it('shows a red alert that says why, that v1 stays, with Retry', () => {
    const html = render(failed);
    expect(tagWith(html, 'data-slot="music-failure"')).toContain('role="alert"');
    expect(tagWith(html, 'data-slot="music-failure"')).toContain('border-red-400/30');
    expect(text(html)).toContain(
      'Couldn’t make v2 ElevenLabs says this month’s credits are used up. v1 stays in the video.',
    );
    expect(text(html)).toContain('Retry');
  });

  it('has no failure box while the make goes on', () => {
    const again = makeMusicView({
      ...failed,
      making: { id: 'v2', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
    });
    expect(render(again)).not.toContain('data-slot="music-failure"');
  });
});

describe('<MusicList> No music picked', () => {
  const off = makeMusicView({ ...twoVersions, picked: 'off' });

  it('checks No music, tags no version and says what the video does', () => {
    const html = render(off);
    expect(row(html, 'off')).toContain('aria-checked="true"');
    expect(html).not.toContain('in the preview');
    expect(html).not.toContain('role="img"');
    expect(text(html)).toContain(
      'The video plays and renders without music. Pick a version to bring it back.',
    );
  });
});

describe('<MusicList> a file in the folder', () => {
  const folder = makeMusicView({
    source: 'supplied',
    file: 'Summer Vibes.mp3',
    plan: null,
    picked: 'file',
    versions: [],
    picks: [],
  });

  it('shows the file with its line and No music, the file in the preview', () => {
    const html = render(folder);
    expect(text(html)).toContain('Music From the folder');
    expect(text(row(html, 'file'))).toContain(
      'Summer Vibes.mp3 in the preview From the job folder. The editor cut to its beat.',
    );
    expect(row(html, 'file')).toContain('aria-checked="true"');
    expect(row(html, 'off')).toContain('aria-checked="false"');
    // No shape: nothing was written to this cut.
    expect(html).not.toContain('role="img"');
  });

  it('offers to make music for this video instead', () => {
    const html = render(folder);
    expect(text(html)).toContain('Make music for this video instead');
    expect(text(html)).toContain('Make one');
    expect(text(html)).toContain('About 30 s. ElevenLabs writes it to this cut, from the brief.');
  });
});

describe('<MusicList> the style says no music', () => {
  const none = makeMusicView({
    source: 'none',
    reason: 'The client’s style says no music under the lawyer’s answers.',
    plan: null,
    picked: null,
    versions: [],
    picks: [],
  });

  it('says whose rule it is and lists only No music, checked', () => {
    const html = render(none);
    expect(text(html)).toContain(
      'None. The client’s style says no music under the lawyer’s answers.',
    );
    expect([...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1])).toEqual(['off']);
    expect(row(html, 'off')).toContain('aria-checked="true"');
    expect(text(html)).toContain('Make music for this video instead');
    expect(text(html)).toContain('Make one');
  });
});

describe('<MusicList> nobody asked for music (U21)', () => {
  const notAsked = makeMusicView({
    source: 'none',
    reason: MUSIC_NOT_ASKED_REASON,
    picked: null,
    versions: [],
    picks: [],
  });

  it('says so in plain words, lists only No music (checked) and offers to make some', () => {
    const html = render(notAsked);
    expect(text(html)).toContain('No music asked for. Nothing was made.');
    expect(text(html)).not.toContain('Music was not asked for');
    expect([...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1])).toEqual(['off']);
    expect(row(html, 'off')).toContain('aria-checked="true"');
    expect(text(html)).toContain('Make music for this video');
    expect(text(html)).not.toContain('instead');
    expect(text(html)).toContain('Make one');
  });

  it('can make some now: the button is on when the engine allows it', () => {
    const html = render({ ...notAsked, canMake: true, whyNot: null });
    expect(html).toMatch(/<button[^>]*type="submit"(?![^>]*disabled)[^>]*>/);
    const blocked = render({
      ...notAsked,
      canMake: false,
      whyNot: 'Music can be changed while the video waits for your review.',
    });
    expect(text(blocked)).toContain('Music can be changed while the video waits for your review.');
  });
});

describe('<MusicList> an episode of a series', () => {
  const series = makeMusicView({
    source: 'series',
    file: 'kit/theme.mp3',
    plan: null,
    picked: 'series',
    versions: [],
    picks: [],
  });

  function seriesClient(): QueryClient {
    const queryClient = createTestQueryClient();
    const summary = makeSeriesSummary();
    const health: HealthResponse = {
      ok: true,
      version: '0.0.0',
      settleMs: 60_000,
      series: true,
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
    queryClient.setQueryData(HEALTH_KEY, health);
    queryClient.setQueryData(clientSeriesKey(SERIES_CLIENT.clientId), [summary]);
    const base = REVIEW_ROW_JOBS.find((job) => job.id === JOB);
    if (!base) throw new Error('no r1');
    queryClient.setQueryData(JOBS_KEY, [
      { ...base, clientId: SERIES_CLIENT.clientId, seriesId: summary.id, episode: 6 },
    ]);
    return queryClient;
  }

  it('names the episode and the series, shows the series’ music locked, and no form', () => {
    const html = render(series, {}, seriesClient());
    expect(text(html)).toContain('Music Episode 6 of מיתוס או אמת');
    expect(text(row(html, 'series'))).toContain(
      'The series’ music in the preview Theme from מיתוס או אמת, the same in every episode.',
    );
    expect(row(html, 'series')).toContain('aria-checked="true"');
    expect(row(html, 'series')).toContain('aria-disabled="true"');
    expect(html).not.toContain('data-row="off"');
    expect(html).not.toContain('data-slot="music-make"');
    expect(text(html)).toContain(
      'Every episode plays the series’ music. To change it for the whole series, leave a note and turn on Series.',
    );
  });

  it('still reads before the series is known', () => {
    const html = render(series);
    expect(text(html)).toContain('Music From the series');
    expect(text(row(html, 'series'))).toContain('The same in every episode.');
  });
});

describe('<MusicList> while the engine says no (canMake false)', () => {
  const locked = makeMusicView({
    ...twoVersions,
    canMake: false,
    whyNot: 'Wait for the edit to finish.',
  });

  it('says why in place of the hint, and takes no pick and no make', () => {
    const html = render(locked);
    expect(text(html)).toContain('Wait for the edit to finish.');
    expect(text(html)).not.toContain('Calmer, darker, piano');
    expect(tagWith(html, 'type="submit"')).toContain('disabled=""');
    expect(html).toMatch(/<input[^>]*\sdisabled=""/);
    // The unpicked rows can't be picked (aria-disabled: they stay in the tab order); the pick stays.
    expect(row(html, 'v1')).toContain('aria-disabled="true"');
    expect(row(html, 'off')).toContain('aria-disabled="true"');
    expect(row(html, 'v2')).toContain('aria-checked="true"');
  });

  it('says nothing of it when the engine allows it', () => {
    const html = render(twoVersions);
    expect(row(html, 'v1')).not.toContain('aria-disabled');
  });
});

describe('<MusicList> on the phone', () => {
  it('is the same list with 44 px rows, a 16 px words box and a full-width button', () => {
    const html = render(twoVersions, { variant: 'phone' });
    expect(tagWith(html, 'data-slot="music-list"')).toContain('data-variant="phone"');
    expect(tagWith(html, 'data-row="v2"')).toContain('min-h-11');
    expect(tagWith(html, '<input')).toContain('h-11');
    expect(tagWith(html, '<input')).toContain('text-base');
    expect(tagWith(html, 'type="submit"')).toContain('h-11');
    expect(text(html)).toContain('Make v3');
  });

  it('has the phone board’s words box and hint, shorter than the Mac’s', () => {
    const html = render(twoVersions, { variant: 'phone' });
    expect(html).toContain('placeholder="What should change? Calmer, piano…"');
    expect(text(html)).toContain('About 30 s. Same shape, so the cuts stay on the beat.');
    expect(text(html)).not.toContain('Calmer, darker, piano…');
    // The Mac keeps its own.
    const mac = render(twoVersions);
    expect(mac).toContain('placeholder="What should change? (optional)"');
  });
});

// --- Songs (canvas page "Songs", boards SGMusic and SGStates) ----------------------------------------

const songsHealth = (songs: boolean): HealthResponse => ({
  ok: true,
  version: '0.0.0',
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
  songs,
});

/** A client for a job in Review with Songs on (or off), and these notes unsent. */
function songsClient(songs = true, notes: string[] = []): QueryClient {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, songsHealth(songs));
  const base = REVIEW_ROW_JOBS.find((job) => job.id === JOB);
  if (!base) throw new Error('no r1');
  queryClient.setQueryData(JOBS_KEY, [{ ...base, client: 'Falcon FPV' }]);
  queryClient.setQueryData(
    notesKey(JOB),
    notes.map((note, index) => makeReviewNote({ id: `n${index}`, jobId: JOB, text: note })),
  );
  return queryClient;
}

const renderSongs = (
  music: MusicView,
  props: Partial<React.ComponentProps<typeof MusicList>> = {},
  queryClient = songsClient(),
) => render(music, props, queryClient);

const fallback = (songFailure = makeSongFailure()) =>
  makeMusicView({ songFailure, picked: 'v1', versions: [makeMusicVersion(1)] });

describe('<MusicList> with a song: state 1, the song is in', () => {
  const html = renderSongs(makeSongView());

  it('says whose song it is in the header', () => {
    expect(text(html)).toContain('Music The song Yael asked for · from her screenshot');
    expect(tagWith(html, 'data-slot="music-source"')).toContain('dir="auto"');
  });

  it('is a radio of the song, then No music, the song checked and tagged "in the preview"', () => {
    expect([...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'song',
      'off',
    ]);
    expect(row(html, 'song')).toContain('aria-checked="true"');
    expect(row(html, 'song')).toContain('in the preview');
    expect(row(html, 'off')).toContain('aria-checked="false"');
  });

  it('has the title and the artist, each with its own direction, and the song’s line', () => {
    const song = row(html, 'song');
    expect(text(song)).toContain(
      'נתתי לך בית Ofek Adanek in the preview YouTube Music, the studio track. The cuts sit on its beat.',
    );
    expect(song).toMatch(/<span dir="auto"[^>]*>נתתי לך בית<\/span>/);
    expect(tagWith(song, 'data-slot="music-artist"')).toContain('dir="auto"');
  });

  it('draws the part on a bar as long as the song, with its start and end in words', () => {
    const song = row(html, 'song');
    expect(tagWith(song, 'role="img"')).toContain(
      'aria-label="The part used: 0:42 to 1:21 of the 3:12 song"',
    );
    const used = tagWith(song, 'data-slot="music-part-used"');
    expect(used).toContain('left:21.9%');
    expect(used).toContain('width:20.3%');
    expect(text(song)).toContain('0:00 the part used · 0:42 to 1:21 3:12');
    // The ElevenLabs shape is for the versions.
    expect(song).not.toContain('data-slot="music-shape"');
  });

  it('says Approve renders two files under the list', () => {
    expect(text(html)).toContain(
      'Approve renders two files: with the song, to show the client, and without it, to post. The client adds the song in Instagram.',
    );
  });

  it('has no alert and no status line', () => {
    expect(html).not.toContain('data-slot="music-alert"');
    expect(html).not.toContain('data-slot="music-noted"');
  });
});

describe('<MusicList> with a song: the box under the list', () => {
  const html = renderSongs(makeSongView());

  it('has two tabs, Another song (open) and Make music instead', () => {
    const tabs = tagWith(html, 'role="tablist"');
    expect(tabs).toContain('aria-label="What to try"');
    const another = tagWith(html, 'aria-controls');
    expect(another).toContain('role="tab"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Another song</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Make music instead</);
  });

  it('has the one field with its hint, Add to notes, and the outline Pick a trending one', () => {
    const field = tagWith(html, 'aria-label="A link or a song name"');
    expect(field).toContain('placeholder="Paste a link or type a song name"');
    expect(field).toContain('dir="auto"');
    expect(text(html)).toContain('Add to notes');
    const trend = tagWith(html, 'data-slot="music-trend"');
    expect(trend).toContain('data-variant="outline"');
    expect(trend).toContain('type="button"');
    expect(trend).not.toContain('disabled=""');
    expect(text(html)).toContain('Pick a trending one');
    expect(text(html)).toContain(
      'YouTube, Instagram, TikTok or Spotify links, or just the name. Or let the editor pick one that’s rising on Reels. It goes in your notes, and the editor re-cuts when you press Send.',
    );
  });

  it('keeps the Make box for the other tab: its field, Make one, the board’s hint', () => {
    const make = renderSongs(makeSongView(), { initialTab: 'make' });
    expect(make).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Make music instead</);
    const field = tagWith(make, 'aria-label="What should change"');
    expect(field).toContain('placeholder="What should change? (optional)"');
    expect(field).toContain('maxLength="200"');
    expect(text(make)).toContain('Make one');
    expect(text(make)).toContain(
      'About 30 s. ElevenLabs writes it to this cut. No Claude run, your notes stay as they are.',
    );
    expect(make).not.toContain('data-slot="music-song"');
    expect(make).not.toContain('Pick a trending one');
  });

  it('puts the box after the rows', () => {
    expect(html.indexOf('data-slot="music-box"')).toBeGreaterThan(html.indexOf('data-row="off"'));
  });
});

describe('<MusicList> with a song: state 2, no music picked', () => {
  it('keeps the song in the list unchecked, and says how to bring it back', () => {
    const html = renderSongs(makeSongView({ picked: 'off' }));
    expect(text(html)).toContain('Music The song Yael asked for · from her screenshot');
    expect(row(html, 'song')).toContain('aria-checked="false"');
    expect(row(html, 'song')).not.toContain('in the preview');
    expect(row(html, 'song')).not.toContain('role="img"');
    expect(row(html, 'off')).toContain('aria-checked="true"');
    expect(text(html)).toContain(
      'The video plays and renders without music. Pick one to bring it back.',
    );
  });
});

describe('<MusicList> with a song: state 3, couldn’t get the song', () => {
  const html = renderSongs(fallback());

  it('shows the amber box with the record’s words above the list', () => {
    const alert = tagWith(html, 'data-slot="music-alert"');
    expect(alert).toContain('role="status"');
    expect(alert).toContain('data-tone="amber"');
    expect(alert).toContain('border-amber-400/30');
    expect(text(html)).toContain(
      'Couldn’t get the song The downloader didn’t answer, so ElevenLabs made the music instead. Paste a YouTube link or type the song’s name and the editor tries again when you press Send.',
    );
    expect(html.indexOf('data-slot="music-alert"')).toBeLessThan(html.indexOf('role="radiogroup"'));
  });

  it('reads each sentence left to right, also when the record’s words start with a Hebrew name', () => {
    const html = renderSongs(
      fallback(
        makeSongFailure({
          message: 'נתתי לך בית on YouTube Music did not answer in time. Try again.',
        }),
      ),
    );
    const alert = html.slice(
      html.indexOf('data-slot="music-alert"'),
      html.indexOf('role="radiogroup"'),
    );
    const lines = [...alert.matchAll(/<span dir="([a-z]+)"[^>]*>([^<]*)<\/span>/g)];
    expect(lines.map((line) => line[1])).toEqual(['ltr', 'ltr']);
    expect(lines[0]?.[2]).toContain('נתתי לך בית on YouTube Music');
  });

  it('has v1 in the video, no song row, and Use a song in place of Another song', () => {
    expect(row(html, 'v1')).toContain('aria-checked="true"');
    expect(html).not.toContain('data-row="song"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Use a song</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Make another</);
    expect(text(html)).toContain('Made for this video by ElevenLabs');
  });

  it('offers Make v2 on the Make tab', () => {
    expect(text(renderSongs(fallback(), { initialTab: 'make' }))).toContain('Make v2');
  });
});

describe('<MusicList> with a song: state 4, “Original audio”', () => {
  const html = renderSongs(
    fallback(makeSongFailure({ code: 'original_audio', asked: '@reels.creator' })),
  );

  it('shows the plain box that asks for the reel’s link', () => {
    const alert = tagWith(html, 'data-slot="music-alert"');
    expect(alert).toContain('data-tone="plain"');
    expect(alert).not.toContain('amber');
    expect(text(html)).toContain(
      'No song name on the screenshot It says “Original audio · @reels.creator”, so there’s nothing to look up. Paste that reel’s link and the editor takes the song from it.',
    );
  });
});

describe('<MusicList> with a song: no Apify key', () => {
  it('says plainly that reel links need one', () => {
    const html = renderSongs(fallback(makeSongFailure({ code: 'needs_key' })));
    expect(tagWith(html, 'data-slot="music-alert"')).toContain('data-tone="plain"');
    expect(text(html)).toContain('Reel links need an Apify key');
    expect(text(html)).toContain('APIFY_TOKEN');
  });
});

describe('<MusicList> with a song: state 5, a trending pick', () => {
  const trending = makeSong({
    asked: { from: 'trending', file: null, url: null, by: 'editor' },
    trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
  });
  const html = renderSongs(makeSongView({ song: trending }));

  it('says the editor picked it, and what Instagram says about it', () => {
    expect(text(html)).toContain('Music Picked by the editor · rising on Reels in #fpv');
    expect(text(row(html, 'song'))).toContain(
      'In 18.4K reels. 3 of the top 20 #fpv reels this month use it. The cuts sit on its beat.',
    );
  });
});

describe('<MusicList> with a song whose part has no beats (C73)', () => {
  const ballad = makeSong({
    title: 'A slow one',
    artist: 'Some Band',
    part: { startMs: 42_000, endMs: 81_000, how: 'measured', beatCount: 0 },
  });
  const html = renderSongs(makeSongView({ song: ballad }));

  it('does not say the cuts sit on its beat, and says what they sit on', () => {
    const song = text(row(html, 'song'));
    expect(song).toContain(
      'YouTube Music, the studio track. No steady beat; the cuts sit on its accents.',
    );
    expect(song).not.toContain('sit on its beat');
  });

  it('still says it for a song with beats in its part, and for a record that never counted them', () => {
    const counted = makeSong({
      part: { startMs: 42_000, endMs: 81_000, how: 'measured', beatCount: 46 },
    });
    expect(text(row(renderSongs(makeSongView({ song: counted })), 'song'))).toContain(
      'The cuts sit on its beat.',
    );
    expect(text(row(renderSongs(makeSongView({ song: makeSong() })), 'song'))).toContain(
      'The cuts sit on its beat.',
    );
  });
});

describe('<MusicList> with a song: state 6, Pick a trending one was pressed', () => {
  const trendNote = 'Use a trending song that fits the cut.';
  const html = renderSongs(fallback(), {}, songsClient(true, [trendNote]));

  it('says what the editor will do on Send, with the client’s name, and keeps the preview', () => {
    const status = tagWith(html, 'data-slot="music-noted"');
    expect(status).toContain('role="status"');
    expect(text(html)).toContain(
      'Added to your notes: “Use a trending song that fits the cut.” On Send, the editor picks one that’s rising on Reels in Falcon FPV’s niche and re-cuts the video to it.',
    );
    // v1 is still the pick: the preview stays as it is until Send.
    expect(row(html, 'v1')).toContain('aria-checked="true"');
  });

  it('turns the trending button into "Added to your notes", disabled', () => {
    const trend = tagWith(html, 'data-slot="music-trend"');
    expect(trend).toContain('disabled=""');
    expect(text(html)).toContain('Added to your notes');
    expect(html).not.toContain('Pick a trending one');
  });

  it('does not say it for other notes', () => {
    const other = renderSongs(fallback(), {}, songsClient(true, ['Use cooler colours.']));
    expect(other).not.toContain('data-slot="music-noted"');
    expect(text(other)).toContain('Pick a trending one');
  });
});

describe('<MusicList> with a song: on the phone', () => {
  const html = renderSongs(makeSongView(), { variant: 'phone' });

  it('has 44 px rows, tabs, field and buttons, and a 16 px field', () => {
    expect(tagWith(html, 'data-row="song"')).toContain('min-h-11');
    const field = tagWith(html, 'aria-label="A link or a song name"');
    expect(field).toContain('h-11');
    expect(field).toContain('text-base');
    expect(tagWith(html, 'type="submit"')).toContain('h-11');
    expect(tagWith(html, 'data-slot="music-trend"')).toContain('h-11');
    // The tabs reach 44 px with a pseudo-element, like the Music button.
    expect(html).toMatch(/role="tab"[^>]*before:-inset-y-\[7px\]/);
    expect(text(html)).toContain('Add to notes');
    expect(text(html)).toContain('Pick a trending one');
    expect(text(html)).toContain('0:00 the part used · 0:42 to 1:21 3:12');
  });

  it('has the Make tab’s field at 16 px too', () => {
    const make = renderSongs(makeSongView(), { variant: 'phone', initialTab: 'make' });
    const field = tagWith(make, 'aria-label="What should change"');
    expect(field).toContain('h-11');
    expect(field).toContain('text-base');
    expect(field).toContain('placeholder="What should change? (optional)"');
  });
});

describe('<MusicList> with Songs off', () => {
  const html = renderSongs(fallback(makeSongFailure()), {}, songsClient(false));

  it('is the list it was: no alert, no tabs, the Make box with its label and hint', () => {
    expect(html).not.toContain('data-slot="music-alert"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('data-slot="music-song"');
    expect(html).not.toContain('Pick a trending one');
    expect(text(html)).toContain('Make another');
    expect(text(html)).toContain('Make v2');
    expect(text(html)).toContain(
      'Calmer, darker, piano… or leave it empty for another take. About 30 s, same shape, so the cuts stay on the beat.',
    );
  });

  it('is the same markup as before Songs for a made record', () => {
    const off = renderSongs(twoVersions, {}, songsClient(false));
    const before = render(twoVersions);
    expect(off).toBe(before);
  });
});
