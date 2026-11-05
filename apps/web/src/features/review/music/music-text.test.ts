import { MUSIC_NOT_ASKED_REASON, type MusicView } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  makeMusicPlan,
  makeMusicVersion,
  makeMusicView,
  makeSong,
  makeSongFailure,
  makeSongView,
} from '@/data/test-utils';
import type { FooterView } from '../notes-logic';
import {
  approveMusicLine,
  isSongLink,
  MUSIC_TEXT,
  musicButtonLabel,
  musicFooter,
  musicListModel,
  musicMakingReason,
  musicNowPlaying,
  musicShape,
  musicWhen,
  peakSection,
  retryAsk,
  SONG_TEXT,
  songAlert,
  songLine,
  songNote,
  songNotedText,
  songPartBar,
  songSourceLine,
  TRENDING_NOTE,
} from './music-text';

// What Review says about a job's music: the button, the footer line, the times, the cut's shape and
// the eight states of the list (board SDMusic), on plain values.

const NOW = Date.parse('2026-10-23T09:30:00.000Z');
const UTC = 'UTC';

/** v1 and v2 (made with words), v2 picked: the first state of the board. */
function twoVersions(overrides: Partial<MusicView> = {}): MusicView {
  return makeMusicView({
    picked: 'v2',
    versions: [
      makeMusicVersion(1),
      makeMusicVersion(2, {
        ask: 'darker, heavier drums',
        describe: 'You asked: darker, heavier drums. Same shape: the drop at 0:18.',
        by: 'you',
        madeAt: '2026-10-23T09:12:00.000Z',
      }),
    ],
    ...overrides,
  });
}

const model = (music: MusicView) => musicListModel(music, { now: NOW, timeZone: UTC });

describe('musicButtonLabel', () => {
  it('says the version in the preview, from the folder, series or off', () => {
    expect(musicButtonLabel(twoVersions())).toBe('v2');
    expect(musicButtonLabel(twoVersions({ picked: 'v1' }))).toBe('v1');
    expect(musicButtonLabel(makeMusicView({ source: 'supplied', picked: 'file' }))).toBe(
      'from the folder',
    );
    expect(musicButtonLabel(makeMusicView({ source: 'series', picked: 'series' }))).toBe('series');
    expect(musicButtonLabel(twoVersions({ picked: 'off' }))).toBe('off');
  });

  it('says off when nothing is picked (the preview plays no music then), and series for an episode', () => {
    expect(musicButtonLabel(makeMusicView({ source: 'none', picked: null }))).toBe('off');
    expect(musicButtonLabel(makeMusicView({ picked: null, versions: [] }))).toBe('off');
    expect(musicButtonLabel(makeMusicView({ source: 'series', picked: null }))).toBe('series');
  });
});

describe('musicNowPlaying', () => {
  it('says what the preview plays in the controls’ bar', () => {
    expect(musicNowPlaying(twoVersions())).toBe('Music v2');
    expect(musicNowPlaying(twoVersions({ picked: 'off' }))).toBe('No music');
    expect(musicNowPlaying(makeMusicView({ source: 'none', picked: null }))).toBe('No music');
    expect(musicNowPlaying(makeMusicView({ source: 'supplied', picked: 'file' }))).toBe(
      'Music from the folder',
    );
    expect(musicNowPlaying(makeMusicView({ source: 'series', picked: 'series' }))).toBe(
      'The series’ music',
    );
  });
});

describe('approveMusicLine', () => {
  it('says what Approve renders: with music v2, without music', () => {
    expect(approveMusicLine(twoVersions())).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v2.',
    );
    expect(approveMusicLine(twoVersions({ picked: 'off' }))).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, without music.',
    );
  });

  it('names the folder’s and the series’ music', () => {
    expect(approveMusicLine(makeMusicView({ source: 'supplied', picked: 'file' }))).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with the music from the folder.',
    );
    expect(approveMusicLine(makeMusicView({ source: 'series', picked: 'series' }))).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with the series’ music.',
    );
  });

  it('is null for a job with no music, so the footer stays as it was', () => {
    expect(approveMusicLine(null)).toBeNull();
    expect(approveMusicLine(undefined)).toBeNull();
  });
});

describe('musicFooter', () => {
  const approve: FooterView = {
    action: 'approve',
    text: 'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    label: 'Approve',
    disabled: false,
    busy: false,
    disabledReason: null,
  };
  const send: FooterView = {
    action: 'send_notes',
    text: 'Your notes go to the editor together.',
    label: 'Send 2 notes',
    disabled: false,
    busy: false,
    disabledReason: null,
  };

  it('keeps today’s footer for a job without music', () => {
    expect(musicFooter(approve, null)).toBe(approve);
    expect(musicFooter(approve, undefined)).toBe(approve);
  });

  it('adds the music to the line with no notes', () => {
    expect(musicFooter(approve, twoVersions())).toEqual({
      ...approve,
      text: 'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v2.',
    });
  });

  it('leaves Send alone', () => {
    expect(musicFooter(send, twoVersions())).toBe(send);
  });

  it('keeps a fix’s line: busy first, "Fixed here" as it is (Quick fixes)', () => {
    const busy: FooterView = {
      ...approve,
      text: 'Fixing it here. Approve waits for it.',
      disabled: true,
      disabledReason: 'Wait for the fix to finish',
      effortDisabled: true,
      quickFix: 'busy',
    };
    const making = twoVersions({
      making: { id: 'v3', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
    });
    expect(musicFooter(busy, twoVersions())).toBe(busy);
    // The fix is what Approve waits for first.
    expect(musicFooter(busy, making)).toBe(busy);
    const fixed: FooterView = {
      ...approve,
      text: 'Fixed here. Approve it from the job’s right-click menu to render the final video, or keep writing notes.',
      quickFix: 'fixed',
    };
    expect(musicFooter(fixed, twoVersions())).toBe(fixed);
    // The music still holds Approve back.
    expect(musicFooter(fixed, making)).toEqual({
      ...fixed,
      text: 'Music v3 is still being made. Approve when it is ready.',
      disabled: true,
      disabledReason: 'Music v3 is still being made.',
    });
  });

  it('makes Approve wait while a version is being made, and says so', () => {
    const making = twoVersions({
      making: { id: 'v3', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
    });
    expect(musicMakingReason(making)).toBe('Music v3 is still being made.');
    expect(musicFooter(approve, making)).toEqual({
      ...approve,
      text: 'Music v3 is still being made. Approve when it is ready.',
      disabled: true,
      disabledReason: 'Music v3 is still being made.',
    });
    expect(musicMakingReason(twoVersions())).toBeNull();
  });
});

describe('musicWhen', () => {
  it('says "just now" for the first minute', () => {
    expect(musicWhen('2026-10-23T09:29:30.000Z', NOW, UTC)).toBe('just now');
    expect(musicWhen('2026-10-23T09:30:00.000Z', NOW, UTC)).toBe('just now');
    // A time ahead of the clock (skew) is just now too.
    expect(musicWhen('2026-10-23T09:30:40.000Z', NOW, UTC)).toBe('just now');
  });

  it('is the clock time, 24 hours, after that', () => {
    expect(musicWhen('2026-10-23T09:12:00.000Z', NOW, UTC)).toBe('09:12');
    expect(musicWhen('2026-10-23T00:05:00.000Z', NOW, UTC)).toBe('00:05');
  });

  it('reads the clock in the zone it is given', () => {
    expect(musicWhen('2026-10-23T09:12:00.000Z', NOW, 'Asia/Jerusalem')).toBe('12:12');
  });

  it('adds the day when it is not today', () => {
    expect(musicWhen('2026-10-22T23:58:00.000Z', NOW, UTC)).toBe('22 Oct, 23:58');
    // Midnight in Jerusalem is a new day there: 09:30 UTC is 12:30 on the 23rd, 21:00 UTC the 22nd is 00:00 on the 23rd.
    expect(musicWhen('2026-10-22T21:00:00.000Z', NOW, 'Asia/Jerusalem')).toBe('00:00');
  });

  it('is empty for a time it cannot read', () => {
    expect(musicWhen('soon', NOW, UTC)).toBe('');
  });
});

describe('the cut’s shape', () => {
  it('draws a block per section, as long as the section, with the drop lit', () => {
    const shape = musicShape(makeMusicPlan());
    expect(shape?.blocks.map((block) => [block.name, block.ms, block.startMs, block.hot])).toEqual([
      ['Build', 10_000, 0, false],
      ['Rise', 8_000, 10_000, false],
      ['Drop', 6_000, 18_000, true],
      ['Golden', 10_000, 24_000, false],
      ['Logo', 5_000, 34_000, false],
    ]);
  });

  it('says it in one line: the section names, the drop and the last one with when they start', () => {
    const shape = musicShape(makeMusicPlan());
    expect(shape?.caption).toBe('Build, rise, drop at 0:18, golden, logo at 0:34');
    expect(shape?.parts.map((part) => part.hot)).toEqual([false, false, true, false, false]);
  });

  it('describes every section to a screen reader', () => {
    expect(musicShape(makeMusicPlan())?.label).toBe(
      'Written to the cut: build 0:00 to 0:10, rise 0:10 to 0:18, drop 0:18 to 0:24, golden 0:24 to 0:34, logo 0:34 to 0:39',
    );
  });

  it('lights the section whose name says it is the biggest moment', () => {
    const named = (names: string[]) =>
      peakSection({
        sections: names.map((name) => ({ name, ms: 5_000, styles: [], avoid: [] })),
      });
    expect(named(['Intro', 'Climax', 'Outro'])).toBe(1);
    expect(named(['Calm', 'Peak', 'Drop'])).toBe(1);
    expect(named(['A', 'B'])).toBeNull();
  });

  it('falls back to the styles, and lights nothing rather than guess', () => {
    const plan = makeMusicPlan({
      sections: [
        { name: 'One', ms: 5_000, styles: ['pad'], avoid: [] },
        { name: 'Two', ms: 5_000, styles: ['big drop'], avoid: [] },
      ],
      lengthMs: 10_000,
    });
    expect(peakSection(plan)).toBe(1);
    const flat = musicShape({
      sections: [
        { name: 'One', ms: 5_000, styles: [], avoid: [] },
        { name: 'Two', ms: 5_000, styles: [], avoid: [] },
      ],
    });
    expect(flat?.blocks.some((block) => block.hot)).toBe(false);
    expect(flat?.caption).toBe('One, two at 0:05');
  });

  it('is nothing for a plan with no sections', () => {
    expect(musicShape({ sections: [] })).toBeNull();
  });
});

describe('the list: made for this video (states 1 and 2)', () => {
  it('lists the versions newest first, with their lines and times, the pick tagged', () => {
    const list = model(twoVersions());
    expect(list.source).toBe('Made for this video by ElevenLabs · 0:39');
    expect(list.rows.map((row) => [row.id, row.checked, row.playing, row.when])).toEqual([
      ['v2', true, true, '09:12'],
      ['v1', false, false, '09:01'],
      ['off', false, false, ''],
    ]);
    expect(list.rows[0]?.describe).toBe(
      'You asked: darker, heavier drums. Same shape: the drop at 0:18.',
    );
  });

  it('puts the cut’s shape under the version that is playing only', () => {
    const [v2, v1, off] = model(twoVersions()).rows;
    expect(v2?.shape?.caption).toBe('Build, rise, drop at 0:18, golden, logo at 0:34');
    expect(v1?.shape).toBeNull();
    expect(off?.shape).toBeNull();
    // Pick v1: the shape moves with the pick.
    const picked = model(twoVersions({ picked: 'v1' })).rows;
    expect(picked.map((row) => row.shape !== null)).toEqual([false, true, false]);
  });

  it('says "just now" for a version made a moment ago', () => {
    const fresh = twoVersions({
      versions: [makeMusicVersion(1, { madeAt: '2026-10-23T09:29:40.000Z' })],
      picked: 'v1',
    });
    expect(model(fresh).rows[0]?.when).toBe('just now');
  });

  it('offers Make v3 after two versions, with the hint of the board', () => {
    const { make } = model(twoVersions());
    expect(make).toEqual({
      label: 'Make another',
      button: 'Make v3',
      hint: MUSIC_TEXT.hintAnother,
      busy: false,
    });
    expect(model(makeMusicView()).make?.button).toBe('Make v2');
  });
});

describe('the list: making (state 3)', () => {
  const making = (ask: string | null) =>
    makeMusicView({
      making: { id: 'v2', ask, startedAt: '2026-10-23T09:29:00.000Z' },
    });

  it('shows the making row at the top, with the words and what keeps playing', () => {
    const list = model(making('darker, heavier drums'));
    expect(list.making).toEqual({
      title: 'v2',
      text: 'Making it: darker, heavier drums. v1 keeps playing.',
      time: '~30 s',
    });
    expect(list.rows[0]?.id).toBe('v1');
  });

  it('says another take, and that the current one keeps playing, with no words', () => {
    expect(model(making(null)).making?.text).toBe(
      'Making another take. The current one keeps playing.',
    );
  });

  it('turns the button into Making… and holds the form', () => {
    expect(model(making(null)).make).toMatchObject({ button: 'Making…', busy: true });
  });

  it('says it makes the music when there is no version yet', () => {
    const first = model(
      makeMusicView({
        versions: [],
        picked: null,
        making: { id: 'v1', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
      }),
    );
    expect(first.making?.text).toBe('Making the music for this video.');
    expect(first.rows.map((row) => row.id)).toEqual(['off']);
  });
});

describe('the list: failed (state 4)', () => {
  const failed = makeMusicView({
    failure: {
      id: 'v2',
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      at: '2026-10-23T09:20:00.000Z',
    },
  });

  it('says why, that the version in the video stays, and when credits come back', () => {
    expect(model(failed).failure).toEqual({
      title: 'Couldn’t make v2',
      text: 'ElevenLabs says this month’s credits are used up. v1 stays in the video. Credits come back when your plan renews, or top up on elevenlabs.io.',
    });
  });

  it('leaves the credits line out for another failure', () => {
    const down = makeMusicView({
      failure: {
        id: 'v2',
        code: 'down',
        message: 'ElevenLabs did not answer in time.',
        at: '2026-10-23T09:20:00.000Z',
      },
    });
    expect(model(down).failure?.text).toBe(
      'ElevenLabs did not answer in time. v1 stays in the video.',
    );
  });

  it('says the video stays without music when nothing is in it', () => {
    const none = makeMusicView({ ...failed, versions: [], picked: null });
    expect(model(none).failure?.text).toContain('The video stays without music.');
  });

  it('hides the box while another make is running', () => {
    const again = makeMusicView({
      ...failed,
      making: { id: 'v2', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
    });
    expect(model(again).failure).toBeNull();
  });
});

describe('the list: No music (state 5)', () => {
  const off = twoVersions({ picked: 'off' });

  it('checks No music, tags nothing, and says what the video does', () => {
    const list = model(off);
    expect(list.rows.find((row) => row.checked)?.id).toBe('off');
    expect(list.rows.some((row) => row.playing)).toBe(false);
    expect(list.note).toBe(
      'The video plays and renders without music. Pick a version to bring it back.',
    );
  });
});

describe('the list: a file in the folder (state 6)', () => {
  const folder = makeMusicView({
    source: 'supplied',
    file: 'audio/Summer Vibes.mp3',
    plan: null,
    picked: 'file',
    versions: [],
    picks: [],
  });

  it('shows the file by its name, with its line, and No music', () => {
    const list = model(folder);
    expect(list.source).toBe('From the folder');
    expect(list.rows.map((row) => [row.id, row.title, row.checked])).toEqual([
      ['file', 'Summer Vibes.mp3', true],
      ['off', 'No music', false],
    ]);
    expect(list.rows[0]?.describe).toBe('From the job folder. The editor cut to its beat.');
    expect(list.rows[0]?.playing).toBe(true);
  });

  it('offers to make music instead', () => {
    expect(model(folder).make).toEqual({
      label: 'Make music for this video instead',
      button: 'Make one',
      hint: 'About 30 s. ElevenLabs writes it to this cut, from the brief.',
      busy: false,
    });
  });

  it('keeps the file as an option after a version was made instead', () => {
    const instead = makeMusicView({
      source: 'made',
      file: 'Summer Vibes.mp3',
      picked: 'v1',
    });
    expect(model(instead).rows.map((row) => row.id)).toEqual(['v1', 'file', 'off']);
    expect(model(instead).make?.label).toBe('Make another');
  });

  it('tells a pick of No music to bring the file back', () => {
    expect(model({ ...folder, picked: 'off' }).note).toBe(
      'The video plays and renders without music. Pick the file to bring it back.',
    );
  });
});

describe('the list: the style says no music (state 7)', () => {
  const none = makeMusicView({
    source: 'none',
    reason: 'The client’s style says no music under the lawyer’s answers.',
    plan: null,
    picked: null,
    versions: [],
    picks: [],
  });

  it('says whose rule it is, lists only No music (checked) and offers to make one', () => {
    const list = model(none);
    expect(list.source).toBe('None. The client’s style says no music under the lawyer’s answers.');
    expect(list.rows.map((row) => [row.id, row.checked])).toEqual([['off', true]]);
    expect(list.note).toBeNull();
    expect(list.make?.button).toBe('Make one');
  });

  it('is just "None." with no reason', () => {
    expect(model({ ...none, reason: null }).source).toBe('None.');
  });
});

describe('the list: nobody asked for music (U21)', () => {
  const notAsked = makeMusicView({
    source: 'none',
    reason: MUSIC_NOT_ASKED_REASON,
    plan: makeMusicPlan(),
    picked: null,
    versions: [],
    picks: [],
  });

  it('says it in plain words, not as a rule, lists only No music (checked)', () => {
    const list = model(notAsked);
    expect(list.source).toBe('No music asked for. Nothing was made.');
    expect(list.rows.map((row) => [row.id, row.checked])).toEqual([['off', true]]);
    expect(list.note).toBeNull();
    expect(list.failure).toBeNull();
  });

  it('offers to make some, as a first one and not “instead”', () => {
    expect(model(notAsked).make).toEqual({
      label: 'Make music for this video',
      button: 'Make one',
      hint: 'About 30 s. ElevenLabs writes it to this cut, from the brief.',
      busy: false,
    });
    // A rule that says no music keeps its words.
    const rule = { ...notAsked, reason: 'The client’s style says no music.' };
    expect(model(rule).source).toBe('None. The client’s style says no music.');
    expect(model(rule).make?.label).toBe('Make music for this video instead');
  });

  it('with Songs on, offers a song and Make music, and a pick of a trending one', () => {
    const list = songsModel(notAsked);
    expect(list.songBox?.tabs).toEqual({ song: 'Use a song', make: 'Make music' });
    expect(list.make?.label).toBe('Make music for this video');
    expect(list.make?.button).toBe('Make one');
    expect(list.songBox?.song.trendButton).toBe('Pick a trending one');
  });

  it('plays and renders without music: the button says off and the footer says without music', () => {
    expect(musicButtonLabel(notAsked)).toBe('off');
    expect(musicNowPlaying(notAsked)).toBe('No music');
    expect(approveMusicLine(notAsked)).toMatch(/, without music\.$/);
  });

  it('is a made record once Make music is pressed: the words go back to the usual ones', () => {
    const made = makeMusicView({ source: 'made', reason: null, picked: 'v1' });
    expect(model(made).source).toMatch(/^Made for this video by ElevenLabs/);
    expect(model(made).make?.label).toBe('Make another');
  });
});

describe('the list: a record whose source is a song but has no song in it', () => {
  it('has a plain source line', () => {
    const song = makeMusicView({ source: 'song', plan: null, picked: 'song', versions: [] });
    expect(model(song).source).toBe('The song asked for');
  });
});

describe('the list: an episode of a series (state 8)', () => {
  const series = makeMusicView({
    source: 'series',
    file: 'kit/theme.mp3',
    plan: null,
    picked: 'series',
    versions: [],
    picks: [],
  });

  it('shows the series’ music, locked and checked, and no form, and no No music', () => {
    const list = musicListModel(series, {
      now: NOW,
      timeZone: UTC,
      series: { line: 'Episode 6 of מיתוס או אמת', name: 'מיתוס או אמת' },
    });
    expect(list.source).toBe('Episode 6 of מיתוס או אמת');
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({
      id: 'series',
      title: 'The series’ music',
      describe: 'Theme from מיתוס או אמת, the same in every episode.',
      checked: true,
      locked: true,
    });
    expect(list.make).toBeNull();
    expect(list.seriesBox).toBe(
      'Every episode plays the series’ music. To change it for the whole series, leave a note and turn on Series.',
    );
  });

  it('says what it can before the series is known', () => {
    const list = model(series);
    expect(list.source).toBe('From the series');
    expect(list.rows[0]?.describe).toBe('The same in every episode.');
  });
});

describe('retryAsk', () => {
  it('retries with the words of the make that failed', () => {
    const sent = [
      { ask: 'calmer', madeId: 'v2' },
      { ask: 'darker, heavier drums', madeId: 'v3' },
    ];
    expect(retryAsk('v3', sent)).toBe('darker, heavier drums');
    expect(retryAsk('v2', sent)).toBe('calmer');
  });

  it('retries with no words for a failure the page did not start', () => {
    expect(retryAsk('v3', [{ ask: 'calmer', madeId: 'v2' }])).toBeUndefined();
    expect(retryAsk('v3', [])).toBeUndefined();
    expect(retryAsk(null, [{ ask: 'calmer', madeId: 'v3' }])).toBeUndefined();
  });
});

// --- Songs (canvas page "Songs", boards SGMusic and SGStates) ----------------------------------------

/** The list with Songs on, as the Mac's popover and the phone's sheet show it. */
const songsModel = (music: MusicView) =>
  musicListModel(music, { now: NOW, timeZone: UTC, songs: true });

/** State 3 of SGMusic: the song could not be got, ElevenLabs made v1 instead. */
const fallbackView = (songFailure = makeSongFailure()) =>
  makeMusicView({ songFailure, picked: 'v1', versions: [makeMusicVersion(1)] });

describe('the button, the bar and the footer while the song is picked', () => {
  it('says "song" on the Music button, and "The song" in the controls’ bar', () => {
    expect(musicButtonLabel(makeSongView())).toBe('song');
    expect(musicNowPlaying(makeSongView())).toBe('The song');
  });

  it('says Approve renders two files', () => {
    expect(approveMusicLine(makeSongView())).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render two files: with the song, and without it to post.',
    );
    expect(approveMusicLine(makeSongView())).toContain(
      'to render two files: with the song, and without it to post.',
    );
  });

  it('puts that line in the footer with no notes, and leaves Send alone', () => {
    const approve: FooterView = {
      action: 'approve',
      text: 'Happy with it? Approve it from the job’s right-click menu to render the final video.',
      label: 'Approve',
      disabled: false,
      busy: false,
      disabledReason: null,
    };
    expect(musicFooter(approve, makeSongView()).text).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render two files: with the song, and without it to post.',
    );
    const send: FooterView = { ...approve, action: 'send_notes', label: 'Send 1 note' };
    expect(musicFooter(send, makeSongView())).toBe(send);
  });

  it('is as it was once a version is picked instead, or No music', () => {
    expect(approveMusicLine(fallbackView())).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v1.',
    );
    expect(approveMusicLine(makeSongView({ picked: 'off' }))).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, without music.',
    );
    expect(musicButtonLabel(makeSongView({ picked: 'off' }))).toBe('off');
  });
});

describe('songSourceLine', () => {
  const asked = (from: 'screenshot' | 'link' | 'name' | 'note', by: 'brief' | 'you' = 'brief') =>
    makeSong({ asked: { from, file: null, url: null, by } });

  it('says who asked and how it came', () => {
    expect(songSourceLine(asked('screenshot'))).toBe(
      'The song Yael asked for · from her screenshot',
    );
    expect(songSourceLine(asked('link'))).toBe('The song Yael asked for · from a link');
    expect(songSourceLine(asked('name'))).toBe('The song Yael asked for · from your note');
    expect(songSourceLine(asked('note', 'you'))).toBe('The song you asked for · from your note');
    expect(songSourceLine(asked('link', 'you'))).toBe('The song you asked for · from a link');
  });

  it('says the editor picked a trending one, and the niche it rises in', () => {
    const trending = makeSong({
      asked: { from: 'trending', file: null, url: null, by: 'editor' },
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    });
    expect(songSourceLine(trending)).toBe('Picked by the editor · rising on Reels in #fpv');
    expect(songSourceLine({ ...trending, trending: null })).toBe(
      'Picked by the editor · rising on Reels',
    );
  });
});

describe('songPartBar', () => {
  it('lights the part on a bar as long as the whole song', () => {
    expect(songPartBar(makeSong())).toEqual({
      startPct: 21.9,
      widthPct: 20.3,
      from: '0:00',
      to: '3:12',
      caption: 'the part used · 0:42 to 1:21',
      label: 'The part used: 0:42 to 1:21 of the 3:12 song',
    });
  });

  it('lights all of it for a song no longer than the cut: "the whole song"', () => {
    const whole = makeSong({ fullMs: 31_000, part: { startMs: 0, endMs: 31_000, how: 'whole' } });
    expect(songPartBar(whole)).toEqual({
      startPct: 0,
      widthPct: 100,
      from: '0:00',
      to: '0:31',
      caption: 'the whole song',
      label: 'The whole 0:31 song is used',
    });
  });

  it('keeps the part on the bar when the record is off by a little', () => {
    const over = songPartBar(
      makeSong({ fullMs: 60_000, part: { startMs: 50_000, endMs: 70_000, how: 'measured' } }),
    );
    expect(over.startPct + over.widthPct).toBeLessThanOrEqual(100);
    expect(over.caption).toBe('the part used · 0:50 to 1:00');
  });

  it('says so when the part is the one the reel uses (reserved for later)', () => {
    const reel = songPartBar(makeSong({ part: { startMs: 42_000, endMs: 81_000, how: 'reel' } }));
    expect(reel.caption).toBe('the part the reel uses · 0:42 to 1:21');
    expect(reel.label).toBe('The part the reel uses: 0:42 to 1:21 of the 3:12 song');
  });
});

describe('songLine', () => {
  it('says where it came from, then that the cuts follow its beat', () => {
    expect(songLine(makeSong())).toBe('YouTube Music, the studio track. The cuts sit on its beat.');
    expect(songLine(makeSong({ source: { ...makeSong().source, site: 'youtube' } }))).toBe(
      'YouTube. The cuts sit on its beat.',
    );
    expect(songLine(makeSong({ source: { ...makeSong().source, site: 'instagram' } }))).toBe(
      'Instagram, the reel’s own audio. The cuts sit on its beat.',
    );
    expect(songLine(makeSong({ source: { ...makeSong().source, site: 'tiktok' } }))).toBe(
      'TikTok, the video’s own audio. The cuts sit on its beat.',
    );
  });

  it('names a sped up, slowed or remix version, and not the original', () => {
    expect(songLine(makeSong({ version: 'sped up' }))).toBe(
      'YouTube Music, sped up. The cuts sit on its beat.',
    );
    expect(songLine(makeSong({ version: 'original' }))).toBe(
      'YouTube Music, the studio track. The cuts sit on its beat.',
    );
  });

  it('says what Instagram says about a trending pick: the reels and the niche’s top 20', () => {
    const trending = makeSong({
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    });
    expect(songLine(trending)).toBe(
      'In 18.4K reels. 3 of the top 20 #fpv reels this month use it. The cuts sit on its beat.',
    );
  });

  it('leaves out what Instagram did not say, and falls back to where it came from', () => {
    const niche = (reels: number | null, nicheTop20: number | null) =>
      makeSong({ trending: { reels, isTrending: null, nicheTop20, niche: '#fpv' } });
    expect(songLine(niche(1, null))).toBe('In 1 reel. The cuts sit on its beat.');
    expect(songLine(niche(1_250_000, 0))).toBe('In 1.3M reels. The cuts sit on its beat.');
    expect(songLine(niche(null, 4))).toBe(
      '4 of the top 20 #fpv reels this month use it. The cuts sit on its beat.',
    );
    expect(songLine(niche(null, null))).toBe(
      'YouTube Music, the studio track. The cuts sit on its beat.',
    );
  });
});

describe('songLine, when the part has no beats (C73)', () => {
  const part = (beatCount?: number) => ({
    startMs: 42_000,
    endMs: 81_000,
    how: 'measured' as const,
    ...(beatCount === undefined ? {} : { beatCount }),
  });

  it('says the cuts sit on its beat only when the part has beats', () => {
    expect(songLine(makeSong({ part: part(46) }))).toBe(
      'YouTube Music, the studio track. The cuts sit on its beat.',
    );
    expect(songLine(makeSong({ part: part(1) }))).toBe(
      'YouTube Music, the studio track. The cuts sit on its beat.',
    );
  });

  it('says it has no steady beat when the finder found none in the part', () => {
    expect(songLine(makeSong({ part: part(0) }))).toBe(
      'YouTube Music, the studio track. No steady beat; the cuts sit on its accents.',
    );
    expect(SONG_TEXT.noBeat).toBe('No steady beat; the cuts sit on its accents.');
  });

  it('keeps the old line for a record that never counted its beats', () => {
    expect(songLine(makeSong({ part: part() }))).toBe(
      'YouTube Music, the studio track. The cuts sit on its beat.',
    );
  });

  it('puts it after what Instagram says about a trending pick, and after a named version', () => {
    const trending = { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' };
    expect(songLine(makeSong({ part: part(0), trending }))).toBe(
      'In 18.4K reels. 3 of the top 20 #fpv reels this month use it. No steady beat; the cuts sit on its accents.',
    );
    expect(songLine(makeSong({ part: part(0), version: 'slowed' }))).toBe(
      'YouTube Music, slowed. No steady beat; the cuts sit on its accents.',
    );
  });

  it('is the described line of the song’s row in the list', () => {
    const view = makeSongView({ song: makeSong({ part: part(0) }) });
    const row = songsModel(view).rows.find((candidate) => candidate.kind === 'song');
    expect(row?.describe).toBe(
      'YouTube Music, the studio track. No steady beat; the cuts sit on its accents.',
    );
  });
});

describe('songAlert', () => {
  it('is nothing without a failure', () => {
    expect(songAlert(null)).toBeNull();
  });

  it('is the amber box with the record’s own words, and what to do next', () => {
    for (const code of ['not_found', 'unavailable', 'blocked', 'failed'] as const) {
      expect(songAlert(makeSongFailure({ code }))).toEqual({
        tone: 'amber',
        title: 'Couldn’t get the song',
        text: 'The downloader didn’t answer, so ElevenLabs made the music instead.',
        ask: 'Paste a YouTube link or type the song’s name and the editor tries again when you press Send.',
      });
    }
    expect(
      songAlert(makeSongFailure({ code: 'no_trending', message: 'Nothing fit.' })),
    ).toMatchObject({
      text: 'Nothing fit.',
      ask: 'Paste a link or type a song’s name and the editor tries again when you press Send.',
    });
  });

  it('a blocked song (YouTube said too many requests) shows the getter’s "try again in a while", not the internet being down (C81)', () => {
    const message =
      'YouTube Music is refusing requests from this Mac right now (it says this Mac asked too many times lately), so "Blinding Lights" by The Weeknd could not be got. Try again in a while.';
    const alert = songAlert(makeSongFailure({ code: 'blocked', message }));
    expect(alert).toMatchObject({ tone: 'amber', title: 'Couldn’t get the song', text: message });
    expect(alert?.text.toLowerCase()).not.toContain('internet');
    expect(alert?.ask).toBe(
      'Paste a YouTube link or type the song’s name and the editor tries again when you press Send.',
    );
  });

  it('has nothing to paste when a tool is missing or yt-dlp is old: the record’s words alone', () => {
    for (const code of ['tool_missing', 'update_needed'] as const) {
      expect(songAlert(makeSongFailure({ code, message: 'yt-dlp is missing.' }))).toEqual({
        tone: 'amber',
        title: 'Couldn’t get the song',
        text: 'yt-dlp is missing.',
        ask: '',
      });
    }
  });

  it('is the plain box for "Original audio": nothing to look up, the reel’s link is asked for', () => {
    expect(songAlert(makeSongFailure({ code: 'original_audio', asked: '@reels.creator' }))).toEqual(
      {
        tone: 'plain',
        title: 'No song name on the screenshot',
        text: 'It says “Original audio · @reels.creator”, so there’s nothing to look up.',
        ask: 'Paste that reel’s link and the editor takes the song from it.',
      },
    );
    expect(
      songAlert(makeSongFailure({ code: 'original_audio', asked: 'IMG_4412.PNG' }))?.text,
    ).toBe('It says “Original audio”, so there’s nothing to look up.');
  });

  it('says plainly that reel links need an Apify key', () => {
    const alert = songAlert(makeSongFailure({ code: 'needs_key' }));
    expect(alert).toMatchObject({ tone: 'plain', title: 'Reel links need an Apify key' });
    expect(alert?.text).toContain('APIFY_TOKEN');
    expect(alert?.ask).toContain('paste a YouTube link');
  });
});

describe('Another song’s notes', () => {
  it('uses a name as it was typed, trimmed: "Use [name] instead."', () => {
    expect(songNote('  נתתי לך בית  ')).toEqual({ kind: 'name', text: 'Use נתתי לך בית instead.' });
    expect(songNote('Mr. Brightside by The Killers')).toEqual({
      kind: 'name',
      text: 'Use Mr. Brightside by The Killers instead.',
    });
  });

  it('uses a link as it was pasted: "Use the song from [link] instead."', () => {
    for (const link of [
      'https://www.instagram.com/reel/DQx7mK2kF9a/',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
      'http://youtu.be/abc',
      'www.example.com/song',
      'instagram.com/reel/DQx7mK2kF9a/',
      'youtu.be/Zq3Rk1pXo9A',
      'music.apple.com/il/album/x/123?i=456',
    ]) {
      expect(songNote(link), link).toEqual({
        kind: 'link',
        text: `Use the song from ${link} instead.`,
      });
    }
  });

  it('knows a link from a name', () => {
    expect(isSongLink('https://youtu.be/abc')).toBe(true);
    expect(isSongLink('Mr. Brightside')).toBe(false);
    expect(isSongLink('instagram.com is where I saw it')).toBe(false);
    expect(isSongLink('')).toBe(false);
  });

  it('adds nothing for a blank', () => {
    expect(songNote('')).toBeNull();
    expect(songNote('   ')).toBeNull();
  });

  it('has Pick a trending one add exactly "Use a trending song that fits the cut."', () => {
    expect(TRENDING_NOTE).toEqual({
      kind: 'trending',
      text: 'Use a trending song that fits the cut.',
    });
    expect(SONG_TEXT.trendingNote).toBe('Use a trending song that fits the cut.');
  });

  it('says what was added, and what the editor does on Send', () => {
    expect(songNotedText(songNote('נתתי לך בית') ?? TRENDING_NOTE, 'Falcon FPV')).toBe(
      'Added to your notes: “Use נתתי לך בית instead.” The editor re-cuts the video to it when you press Send.',
    );
    expect(songNotedText(songNote('https://youtu.be/abc') ?? TRENDING_NOTE, null)).toBe(
      'Added to your notes: “Use the song from https://youtu.be/abc instead.” The editor re-cuts the video to it when you press Send.',
    );
    expect(songNotedText(TRENDING_NOTE, 'Falcon FPV')).toBe(
      'Added to your notes: “Use a trending song that fits the cut.” On Send, the editor picks one that’s rising on Reels in Falcon FPV’s niche and re-cuts the video to it.',
    );
    expect(songNotedText(TRENDING_NOTE, null)).toContain('in the client’s niche');
  });
});

describe('the list with a song: state 1, the song is in', () => {
  const list = songsModel(makeSongView());

  it('says whose song it is and how it came', () => {
    expect(list.source).toBe('The song Yael asked for · from her screenshot');
    expect(list.alert).toBeNull();
  });

  it('has the song row first, then No music: title, artist, in the preview, its line', () => {
    expect(list.rows.map((row) => [row.id, row.kind, row.checked, row.playing])).toEqual([
      ['song', 'song', true, true],
      ['off', 'off', false, false],
    ]);
    expect(list.rows[0]).toMatchObject({
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      describe: 'YouTube Music, the studio track. The cuts sit on its beat.',
      when: '',
      shape: null,
    });
  });

  it('draws the part under the picked song', () => {
    expect(list.rows[0]?.part).toEqual(songPartBar(makeSong()));
    expect(list.rows[0]?.part?.caption).toBe('the part used · 0:42 to 1:21');
  });

  it('says Approve renders two files, under the rows', () => {
    expect(list.note).toBe(
      'Approve renders two files: with the song, to show the client, and without it, to post. The client adds the song in Instagram.',
    );
  });

  it('has the two tabs, Another song and Make music instead, and the Make box with the board’s words', () => {
    expect(list.songBox).toEqual({
      tabs: { song: 'Another song', make: 'Make music instead' },
      song: {
        label: 'A link or a song name',
        placeholder: 'Paste a link or type a song name',
        button: 'Add to notes',
        trendButton: 'Pick a trending one',
        trendAdded: 'Added to your notes',
        hint: 'YouTube, Instagram, TikTok or Spotify links, or just the name. Or let the editor pick one that’s rising on Reels. It goes in your notes, and the editor re-cuts when you press Send.',
      },
      makeField: { label: 'What should change', placeholder: 'What should change? (optional)' },
    });
    expect(list.make).toEqual({
      label: 'Make another',
      button: 'Make one',
      hint: 'About 30 s. ElevenLabs writes it to this cut. No Claude run, your notes stay as they are.',
      busy: false,
    });
  });
});

describe('the list with a song: state 2, no music picked', () => {
  const list = songsModel(makeSongView({ picked: 'off' }));

  it('keeps the song’s line in the header, checks No music and tags nothing', () => {
    expect(list.source).toBe('The song Yael asked for · from her screenshot');
    expect(list.rows.map((row) => [row.id, row.checked, row.playing])).toEqual([
      ['song', false, false],
      ['off', true, false],
    ]);
  });

  it('draws no part (only the picked song has it) and says how to bring it back', () => {
    expect(list.rows[0]?.part).toBeNull();
    expect(list.note).toBe('The video plays and renders without music. Pick one to bring it back.');
  });
});

describe('the list with a song: state 3, couldn’t get the song', () => {
  const list = songsModel(fallbackView());

  it('is the made music’s header, the amber box, and v1 in the video', () => {
    expect(list.source).toBe('Made for this video by ElevenLabs · 0:39');
    expect(list.alert).toMatchObject({ tone: 'amber', title: 'Couldn’t get the song' });
    expect(list.alert?.text).toContain('The downloader didn’t answer');
    expect(list.rows.map((row) => [row.id, row.checked])).toEqual([
      ['v1', true],
      ['off', false],
    ]);
  });

  it('offers Use a song and Make another, and Make v2 (there is no song to make instead of)', () => {
    expect(list.songBox?.tabs).toEqual({ song: 'Use a song', make: 'Make another' });
    expect(list.make?.button).toBe('Make v2');
  });
});

describe('the list with a song: state 4, "Original audio"', () => {
  const list = songsModel(
    fallbackView(makeSongFailure({ code: 'original_audio', asked: '@reels.creator' })),
  );

  it('asks for the reel’s link in the plain box, and never guesses a song', () => {
    expect(list.alert).toMatchObject({ tone: 'plain', title: 'No song name on the screenshot' });
    expect(list.alert?.ask).toContain('Paste that reel’s link');
    expect(list.rows.some((row) => row.kind === 'song')).toBe(false);
    expect(list.songBox?.tabs.song).toBe('Use a song');
  });
});

describe('the list with a song: state 5, a trending pick', () => {
  const trending = makeSong({
    asked: { from: 'trending', file: null, url: null, by: 'editor' },
    trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
  });
  const list = songsModel(makeSongView({ song: trending }));

  it('says the editor picked it, rising on Reels in the niche', () => {
    expect(list.source).toBe('Picked by the editor · rising on Reels in #fpv');
  });

  it('adds how many reels use it and how many of the niche’s top 20', () => {
    expect(list.rows[0]?.describe).toBe(
      'In 18.4K reels. 3 of the top 20 #fpv reels this month use it. The cuts sit on its beat.',
    );
  });
});

describe('the list with songs on, other ways', () => {
  it('lists the versions under the song, newest first', () => {
    const both = makeSongView({
      source: 'made',
      picked: 'v2',
      plan: makeMusicPlan(),
      versions: [makeMusicVersion(1), makeMusicVersion(2)],
    });
    const list = songsModel(both);
    expect(list.rows.map((row) => [row.id, row.checked])).toEqual([
      ['song', false],
      ['v2', true],
      ['v1', false],
      ['off', false],
    ]);
    // The header is the made music's while a version plays; the song comes back when it is picked.
    expect(list.source).toBe('Made for this video by ElevenLabs · 0:39');
    expect(songsModel({ ...both, picked: 'song' }).source).toBe(
      'The song Yael asked for · from her screenshot',
    );
    expect(list.songBox?.tabs).toEqual({ song: 'Another song', make: 'Make music instead' });
    expect(list.make?.button).toBe('Make one');
  });

  it('shows the song’s title and artist as they are written, Hebrew and all', () => {
    const [row] = songsModel(makeSongView()).rows;
    expect(row?.title).toBe('נתתי לך בית');
    expect(row?.artist).toBe('Ofek Adanek');
  });

  it('is Make music instead for music from the folder, and Make one', () => {
    const folder = makeMusicView({
      source: 'supplied',
      file: 'audio/Summer Vibes.mp3',
      picked: 'file',
      plan: null,
      versions: [],
    });
    const list = songsModel(folder);
    expect(list.songBox?.tabs).toEqual({ song: 'Use a song', make: 'Make music instead' });
    expect(list.make?.button).toBe('Make one');
  });

  it('has neither the tabs nor an alert for an episode of a series', () => {
    const episode = makeMusicView({
      source: 'series',
      picked: 'series',
      file: 'series/theme.mp3',
      songFailure: makeSongFailure(),
    });
    const list = musicListModel(episode, { now: NOW, timeZone: UTC, songs: true });
    expect(list.songBox).toBeNull();
    expect(list.make).toBeNull();
    expect(list.seriesBox).toBe(MUSIC_TEXT.seriesBox);
  });
});

describe('the list with songs off is exactly what it was', () => {
  it('has no tabs and no alert, and the Make box with its own words', () => {
    const list = model(fallbackView());
    expect(list.songBox).toBeNull();
    expect(list.alert).toBeNull();
    expect(list.make).toEqual({
      label: 'Make another',
      button: 'Make v2',
      hint: MUSIC_TEXT.hintAnother,
      busy: false,
    });
  });

  it('is the same list for a made record with or without the switch', () => {
    const made = twoVersions();
    const off = model(made);
    const on = songsModel(made);
    expect(on.rows).toEqual(off.rows);
    expect(on.source).toBe(off.source);
    expect(on.note).toBe(off.note);
    expect(off.songBox).toBeNull();
  });
});
