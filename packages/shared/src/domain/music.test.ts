import { describe, expect, it } from 'vitest';
import {
  emptyMusicRecord,
  findMusicVersion,
  formatMusicLength,
  instagramLine,
  isMakingMusic,
  isMusicVersionId,
  MUSIC_EXIT_CODES,
  MUSIC_FAILURE_CODES,
  MUSIC_FILES,
  MUSIC_LIMITS,
  MUSIC_MESSAGES,
  MUSIC_NOT_ASKED_REASON,
  MUSIC_SOURCES,
  makeMusicRequestSchema,
  musicExitCode,
  musicLengthSecOfUsageLine,
  musicPickIdSchema,
  musicPlanSchema,
  musicRecordSchema,
  musicResponseSchema,
  musicScriptLineSchema,
  musicVersionFile,
  musicVersionNumber,
  musicViewSchema,
  musicWasNotAsked,
  nextVersionId,
  parseMusicScriptLine,
  pickedSong,
  pickedVersion,
  pickMusicRequestSchema,
  SONG_ASKED_BY,
  SONG_ASKED_FROM,
  SONG_FAILURE_CODES,
  SONG_LIMITS,
  SONG_PART_HOWS,
  SONG_SITES,
  SONG_VERSIONS,
  SONG_VIAS,
  songFailureSchema,
  songSchema,
} from './music.ts';
import {
  makeMusicPlan,
  makeMusicRecord,
  makeMusicVersion,
  makeMusicView,
  makeSong,
  makeSongFailure,
  makeSongRecord,
} from './test-fixtures.ts';

describe('the files', () => {
  it('sit in edit/music/, and the composition plays edit/preview/music.mp3', () => {
    expect(MUSIC_FILES).toEqual({
      dir: 'music',
      plan: 'music/plan.json',
      record: 'music/music.json',
      lock: 'music/.lock',
      preview: 'preview/music.mp3',
      songFull: 'music/song-full.m4a',
      songReel: 'music/song-reel.m4a',
      song: 'music/song.mp3',
    });
    expect(musicVersionFile('v12')).toBe('v12.mp3');
  });
});

describe('version ids', () => {
  it('are v1, v2 … and nothing else', () => {
    for (const id of ['v1', 'v2', 'v10', 'v123']) expect(isMusicVersionId(id), id).toBe(true);
    for (const id of ['v0', 'v01', 'V1', 'v', '1', 'off', 'file', 'series', 'v1.mp3', ' v1']) {
      expect(isMusicVersionId(id), id).toBe(false);
    }
    expect(musicVersionNumber('v12')).toBe(12);
    expect(musicVersionNumber('off')).toBeNull();
  });
});

describe('MusicPlan', () => {
  it('reads the plan page’s example', () => {
    const plan = makeMusicPlan();
    expect(musicPlanSchema.parse(plan)).toEqual(plan);
  });

  it('needs the sections to add up to lengthMs exactly', () => {
    const plan = makeMusicPlan({ lengthMs: 39_001 });
    const result = musicPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'must add up to lengthMs (39001 ms), not 39000 ms',
    );
  });

  it('keeps each section between 3 and 120 s', () => {
    const at = (ms: number) =>
      musicPlanSchema.safeParse(
        makeMusicPlan({
          lengthMs: ms + 5_000,
          sections: [
            { name: 'A', ms, styles: [], avoid: [] },
            { name: 'B', ms: 5_000, styles: [], avoid: [] },
          ],
        }),
      ).success;
    expect(at(MUSIC_LIMITS.sectionMinMs)).toBe(true);
    expect(at(MUSIC_LIMITS.sectionMaxMs)).toBe(true);
    expect(at(MUSIC_LIMITS.sectionMinMs - 1)).toBe(false);
    expect(at(MUSIC_LIMITS.sectionMaxMs + 1)).toBe(false);
    expect(at(4_500.5)).toBe(false);
  });

  it('keeps describe to one short line, and needs styles and a section', () => {
    const describe = 'x'.repeat(MUSIC_LIMITS.describeMax);
    expect(musicPlanSchema.safeParse(makeMusicPlan({ describe })).success).toBe(true);
    expect(musicPlanSchema.safeParse(makeMusicPlan({ describe: `${describe}x` })).success).toBe(
      false,
    );
    expect(musicPlanSchema.safeParse(makeMusicPlan({ describe: '' })).success).toBe(false);
    expect(musicPlanSchema.safeParse(makeMusicPlan({ styles: [] })).success).toBe(false);
    expect(musicPlanSchema.safeParse(makeMusicPlan({ styles: [''] })).success).toBe(false);
    expect(
      musicPlanSchema.safeParse(makeMusicPlan({ sections: [], lengthMs: 3_000 })).success,
    ).toBe(false);
  });

  it('keeps the track between 3 s and 10 min', () => {
    /** A plan of `ms` in 100 s sections and one for the rest. */
    const of = (ms: number) => {
      const sections = [];
      for (let left = ms; left > 0; left -= 100_000) {
        sections.push({
          name: `S${sections.length}`,
          ms: Math.min(left, 100_000),
          styles: [],
          avoid: [],
        });
      }
      return musicPlanSchema.safeParse(makeMusicPlan({ lengthMs: ms, sections })).success;
    };
    expect(of(MUSIC_LIMITS.lengthMaxMs)).toBe(true);
    expect(of(MUSIC_LIMITS.lengthMaxMs + 3_000)).toBe(false);
  });
});

describe('MusicRecord', () => {
  it('reads a made record, and the empty one', () => {
    const record = makeMusicRecord();
    expect(musicRecordSchema.parse(record)).toEqual(record);
    expect(musicRecordSchema.parse(emptyMusicRecord())).toEqual(emptyMusicRecord());
  });

  it('reads every kind of source, a making and a failure', () => {
    for (const record of [
      makeMusicRecord({
        source: 'supplied',
        file: 'Summer Vibes.mp3',
        plan: null,
        picked: 'file',
        versions: [],
        picks: [{ id: 'file', at: '2026-10-23T09:00:00.000Z' }],
      }),
      makeMusicRecord({ source: 'series', file: 'theme.mp3', picked: 'series', versions: [] }),
      makeMusicRecord({
        source: 'none',
        reason: 'The client’s style says no music under the lawyer’s answers.',
        plan: null,
        picked: null,
        versions: [],
        picks: [],
      }),
      makeMusicRecord({
        making: { id: 'v2', ask: 'darker, more drums', startedAt: '2026-10-23T09:05:00.000Z' },
      }),
      makeMusicRecord({
        picked: 'off',
        failure: {
          id: 'v2',
          code: 'no_credits',
          message: 'ElevenLabs says this month’s credits are used up.',
          at: '2026-10-23T09:06:00.000Z',
        },
      }),
    ]) {
      expect(musicRecordSchema.safeParse(record).success, record.source).toBe(true);
    }
    expect(MUSIC_FAILURE_CODES).toEqual([
      'no_credits',
      'no_access',
      'no_key',
      'down',
      'bad_plan',
      'failed',
    ]);
  });

  it('refuses another version of the file, unknown picks, bad versions and codes', () => {
    const record = makeMusicRecord();
    for (const bad of [
      { ...record, v: 2 },
      { ...record, source: 'bought' },
      { ...record, picked: 'v0' },
      { ...record, picked: 'none' },
      { ...record, versions: [{ ...makeMusicVersion(1), file: 'v1.wav' }] },
      { ...record, versions: [{ ...makeMusicVersion(1), by: 'claude' }] },
      { ...record, versions: [{ ...makeMusicVersion(1), ask: 'x'.repeat(201) }] },
      { ...record, failure: { id: 'v2', code: 'boom', message: 'x', at: record.picks[0]?.at } },
      { ...record, plan: makeMusicPlan({ lengthMs: 1 }) },
    ]) {
      expect(musicRecordSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('MusicView and the routes’ bodies', () => {
  it('is the record plus canMake, whyNot and rev, and null without a record', () => {
    const view = makeMusicView({ canMake: false, whyNot: MUSIC_MESSAGES.notInReview, rev: 0 });
    expect(musicViewSchema.parse(view)).toEqual(view);
    expect(musicResponseSchema.parse(null)).toBeNull();
    expect(musicViewSchema.safeParse(makeMusicRecord()).success).toBe(false);
    expect(musicViewSchema.safeParse({ ...view, rev: -1 }).success).toBe(false);
  });

  it('takes Make another’s words, trimmed, up to 200 characters', () => {
    expect(makeMusicRequestSchema.parse({})).toEqual({});
    expect(makeMusicRequestSchema.parse({ ask: '  darker, more drums ' })).toEqual({
      ask: 'darker, more drums',
    });
    expect(makeMusicRequestSchema.parse({ ask: '   ' })).toEqual({ ask: '' });
    expect(makeMusicRequestSchema.safeParse({ ask: 'x'.repeat(201) }).success).toBe(false);
  });

  it('picks a version, off, the folder’s file or the series’ music, and nothing else', () => {
    for (const id of ['v2', 'off', 'file', 'series']) {
      expect(pickMusicRequestSchema.parse({ id })).toEqual({ id });
    }
    for (const id of ['none', 'v0', 'File', '']) {
      expect(pickMusicRequestSchema.safeParse({ id }).success, id).toBe(false);
    }
  });
});

describe('the music script’s answer', () => {
  it('is one JSON line, ok or not', () => {
    for (const line of [
      { ok: true, id: 'v2', lengthMs: 39_000 },
      { ok: true, id: 'off', lengthMs: 39_000 },
      { ok: true, id: 'file', lengthMs: null },
      { ok: true, id: 'none', lengthMs: null },
      {
        ok: false,
        code: 'no_credits',
        message: 'ElevenLabs says this month’s credits are used up.',
      },
    ]) {
      expect(musicScriptLineSchema.parse(line)).toEqual(line);
    }
    expect(musicScriptLineSchema.safeParse({ ok: false, code: 'nope', message: 'x' }).success).toBe(
      false,
    );
    expect(musicScriptLineSchema.safeParse({ ok: true, id: 'v2' }).success).toBe(false);
  });

  it('is found as the last valid line of stdout', () => {
    const stdout = [
      'ffmpeg says hello',
      '{"ok":true,"id":"v1","lengthMs":1000}',
      '{"not":"an answer"}',
      '{"ok":true,"id":"v2","lengthMs":39000}',
      '',
    ].join('\n');
    expect(parseMusicScriptLine(stdout)).toEqual({ ok: true, id: 'v2', lengthMs: 39_000 });
    expect(parseMusicScriptLine('Traceback…\n{broken')).toBeNull();
    expect(parseMusicScriptLine('')).toBeNull();
  });

  it('exits 0, 2 when ElevenLabs said no, 3 when it is down, 1 for the rest', () => {
    expect(MUSIC_EXIT_CODES).toEqual({ ok: 0, failed: 1, refused: 2, down: 3 });
    expect(MUSIC_FAILURE_CODES.map((code) => [code, musicExitCode(code)])).toEqual([
      ['no_credits', 2],
      ['no_access', 2],
      ['no_key', 2],
      ['down', 3],
      ['bad_plan', 1],
      ['failed', 1],
    ]);
  });
});

describe('small rules', () => {
  it('numbers the next version one past the highest', () => {
    expect(nextVersionId(null)).toBe('v1');
    expect(nextVersionId(emptyMusicRecord())).toBe('v1');
    expect(nextVersionId(makeMusicRecord())).toBe('v2');
    const gaps = makeMusicRecord({ versions: [makeMusicVersion(3), makeMusicVersion(1)] });
    expect(nextVersionId(gaps)).toBe('v4');
  });

  it('finds the picked version, and none for off, a file or nothing', () => {
    const record = makeMusicRecord({
      versions: [makeMusicVersion(1), makeMusicVersion(2)],
      picked: 'v2',
    });
    expect(pickedVersion(record)?.id).toBe('v2');
    expect(findMusicVersion(record, 'v1')?.id).toBe('v1');
    expect(findMusicVersion(record, 'v9')).toBeNull();
    for (const picked of ['off', 'file', 'series', null] as const) {
      expect(pickedVersion({ ...record, picked }), String(picked)).toBeNull();
    }
    expect(pickedVersion({ ...record, picked: 'v7' })).toBeNull();
    expect(pickedVersion(null)).toBeNull();
  });

  it('says a length as m:ss', () => {
    expect(formatMusicLength(39_000)).toBe('0:39');
    expect(formatMusicLength(38_600)).toBe('0:39');
    expect(formatMusicLength(125_000)).toBe('2:05');
    expect(formatMusicLength(0)).toBe('0:00');
  });

  it('knows when a version is being made', () => {
    expect(isMakingMusic(null)).toBe(false);
    expect(isMakingMusic(makeMusicRecord())).toBe(false);
    expect(
      isMakingMusic(
        makeMusicRecord({ making: { id: 'v2', ask: null, startedAt: '2026-10-23T09:05:00.000Z' } }),
      ),
    ).toBe(true);
  });
});

describe('music only when asked (U21)', () => {
  it('names the reason of a record whose music was not asked for, in the editor’s words', () => {
    expect(MUSIC_NOT_ASKED_REASON).toBe('Music was not asked for.');
  });

  it('tells it from a rule that says no music, and from the other sources', () => {
    const none = (reason: string | null) =>
      makeMusicRecord({ source: 'none', reason, versions: [], picked: null });
    expect(musicWasNotAsked(none(MUSIC_NOT_ASKED_REASON))).toBe(true);
    expect(musicWasNotAsked(none('The client’s style says no music.'))).toBe(false);
    expect(musicWasNotAsked(none(null))).toBe(false);
    expect(musicWasNotAsked(makeMusicRecord())).toBe(false);
    expect(musicWasNotAsked(null)).toBe(false);
  });

  it('is a record that parses, with the plan Make music in Review needs', () => {
    const record = makeMusicRecord({
      source: 'none',
      reason: MUSIC_NOT_ASKED_REASON,
      versions: [],
      picked: null,
    });
    expect(musicRecordSchema.parse(record)).toEqual(record);
    expect(record.plan).not.toBeNull();
  });
});

describe('Songs: the song in the record', () => {
  it('adds song to the sources and to what can be picked', () => {
    expect(MUSIC_SOURCES).toEqual(['made', 'supplied', 'series', 'none', 'song']);
    for (const id of ['v1', 'off', 'file', 'series', 'song']) {
      expect(musicPickIdSchema.safeParse(id).success, id).toBe(true);
    }
    expect(musicPickIdSchema.safeParse('songs').success).toBe(false);
    expect(pickMusicRequestSchema.parse({ id: 'song' })).toEqual({ id: 'song' });
    expect(isMusicVersionId('song')).toBe(false);
  });

  it('has song and songFailure null in the empty record and in a made one', () => {
    expect(emptyMusicRecord()).toMatchObject({ song: null, songFailure: null });
    expect(makeMusicRecord()).toMatchObject({ song: null, songFailure: null });
  });

  it('reads a record from before Songs, with neither key, as null and null', () => {
    const { song: _song, songFailure: _failure, ...before } = makeMusicRecord();
    expect(before).not.toHaveProperty('song');
    expect(musicRecordSchema.parse(before)).toEqual(makeMusicRecord());
    // The same for the answer of the route and the job.music event.
    const { song: _s, songFailure: _f, ...viewBefore } = makeMusicView();
    expect(musicViewSchema.parse(viewBefore)).toEqual(makeMusicView());
  });

  it('reads an old music.json file as it was written, byte for byte', () => {
    const onDisk = JSON.stringify({
      v: 1,
      source: 'made',
      reason: null,
      file: null,
      plan: null,
      picked: 'v1',
      versions: [makeMusicVersion(1)],
      picks: [{ id: 'v1', at: '2026-10-23T09:01:00.000Z' }],
      making: null,
      failure: null,
    });
    const record = musicRecordSchema.parse(JSON.parse(onDisk));
    expect(record.song).toBeNull();
    expect(record.songFailure).toBeNull();
    expect(record.versions).toHaveLength(1);
  });

  it('reads a record whose music is the song, and one that failed to get it', () => {
    const got = makeSongRecord();
    expect(musicRecordSchema.parse(got)).toEqual(got);
    expect(pickedSong(got)?.title).toBe('נתתי לך בית');

    const fellBack = makeMusicRecord({ songFailure: makeSongFailure() });
    expect(musicRecordSchema.parse(fellBack)).toEqual(fellBack);

    const view = makeMusicView({ ...got, canMake: true, whyNot: null });
    expect(musicViewSchema.parse(view)).toEqual(view);
  });

  it('knows the song only while it is the pick', () => {
    expect(pickedSong(null)).toBeNull();
    expect(pickedSong(makeMusicRecord())).toBeNull();
    expect(pickedSong(makeSongRecord({ picked: 'off' }))).toBeNull();
    expect(pickedSong(makeSongRecord({ picked: 'v1' }))).toBeNull();
    expect(pickedSong(makeSongRecord())).toEqual(makeSong());
  });
});

describe('Songs: Song', () => {
  it('reads the board’s song with every value kept', () => {
    expect(songSchema.parse(makeSong())).toEqual(makeSong());
  });

  it('has the words of the plan page', () => {
    expect(SONG_VERSIONS).toEqual(['original', 'sped up', 'slowed', 'remix']);
    expect(SONG_ASKED_FROM).toEqual(['screenshot', 'link', 'name', 'note', 'trending']);
    expect(SONG_ASKED_BY).toEqual(['brief', 'you', 'editor']);
    expect(SONG_SITES).toEqual(['youtube-music', 'youtube', 'instagram', 'tiktok']);
    expect(SONG_VIAS).toEqual(['yt-dlp', 'apify']);
    expect(SONG_PART_HOWS).toEqual(['measured', 'whole', 'reel']);
  });

  it('reads every kind of version, ask, maker, site, getter and part', () => {
    for (const version of [...SONG_VERSIONS, null]) {
      expect(songSchema.safeParse(makeSong({ version })).success, String(version)).toBe(true);
    }
    for (const from of SONG_ASKED_FROM) {
      for (const by of SONG_ASKED_BY) {
        const asked = { from, by, file: null, url: null };
        expect(songSchema.safeParse(makeSong({ asked })).success, `${from}/${by}`).toBe(true);
      }
    }
    for (const site of SONG_SITES) {
      for (const via of SONG_VIAS) {
        const source = { site, via, url: 'https://example.com/x', id: 'x' };
        expect(songSchema.safeParse(makeSong({ source })).success, `${site}/${via}`).toBe(true);
      }
    }
    // `reel` is reserved for SG16: the schema reads it, nothing sets it now.
    for (const how of SONG_PART_HOWS) {
      const part = { startMs: 1_000, endMs: 31_000, how };
      expect(songSchema.safeParse(makeSong({ part })).success, how).toBe(true);
    }
  });

  it('may carry what Instagram said, with any of it unknown', () => {
    const trending = { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' };
    expect(songSchema.parse(makeSong({ trending }))).toEqual(makeSong({ trending }));
    const unknown = { reels: null, isTrending: null, nicheTop20: null, niche: '#fpv #drone' };
    expect(songSchema.safeParse(makeSong({ trending: unknown })).success).toBe(true);
    for (const bad of [
      { ...trending, nicheTop20: 21 },
      { ...trending, nicheTop20: -1 },
      { ...trending, reels: 1.5 },
      { ...trending, niche: '' },
      { reels: 1, isTrending: true, nicheTop20: 1 },
    ]) {
      expect(songSchema.safeParse(makeSong({ trending: bad as never })).success).toBe(false);
    }
  });

  it('keeps title and artist to 120 characters, and the line to 240', () => {
    const at = (overrides: Parameters<typeof makeSong>[0]) =>
      songSchema.safeParse(makeSong(overrides)).success;
    expect(SONG_LIMITS).toEqual({
      titleMax: 120,
      artistMax: 120,
      instagramLineMax: 240,
      partMinMs: 3_000,
      partMaxMs: 120_000,
    });
    expect(at({ title: 'x'.repeat(120) })).toBe(true);
    expect(at({ title: 'x'.repeat(121) })).toBe(false);
    expect(at({ title: '' })).toBe(false);
    expect(at({ artist: 'x'.repeat(120) })).toBe(true);
    expect(at({ artist: 'x'.repeat(121) })).toBe(false);
    expect(at({ artist: '' })).toBe(false);
    expect(at({ instagramLine: 'x'.repeat(240) })).toBe(true);
    expect(at({ instagramLine: 'x'.repeat(241) })).toBe(false);
    expect(at({ instagramLine: '' })).toBe(false);
  });

  it('keeps the part between 3 and 120 s', () => {
    const at = (lengthMs: number, startMs = 42_000) =>
      songSchema.safeParse(
        makeSong({
          fullMs: 400_000,
          part: { startMs, endMs: startMs + lengthMs, how: 'measured' },
        }),
      );
    expect(at(SONG_LIMITS.partMinMs).success).toBe(true);
    expect(at(SONG_LIMITS.partMaxMs).success).toBe(true);
    expect(at(SONG_LIMITS.partMinMs - 1).success).toBe(false);
    expect(at(SONG_LIMITS.partMaxMs + 1).success).toBe(false);
    expect(at(0).success).toBe(false);
    expect(at(10_000, 0).success).toBe(true);
    expect(at(10_000, -1).success).toBe(false);
    expect(at(10_000, 1.5).success).toBe(false);
    expect(at(SONG_LIMITS.partMinMs - 1).error?.issues[0]?.message).toBe(
      'must be 3 to 120 s after startMs, not 2999 ms',
    );
  });

  it('may count the beats inside the part (C73): a whole number from 0, and optional', () => {
    const withCount = (beatCount: unknown) =>
      songSchema.safeParse(
        makeSong({ part: { startMs: 42_000, endMs: 81_000, how: 'measured', beatCount } as never }),
      );
    expect(withCount(0).success).toBe(true);
    expect(withCount(46).success).toBe(true);
    expect(withCount(undefined).success).toBe(true);
    expect(withCount(-1).success).toBe(false);
    expect(withCount(1.5).success).toBe(false);
    expect(withCount(null).success).toBe(false);
    expect(withCount('46').success).toBe(false);
    // A record written before the count existed still parses, and keeps its part as it was.
    const old = makeSong({ part: { startMs: 42_000, endMs: 81_000, how: 'measured' } });
    const parsed = songSchema.parse(old);
    expect(parsed.part).toEqual({ startMs: 42_000, endMs: 81_000, how: 'measured' });
    expect('beatCount' in parsed.part).toBe(false);
    // The count survives a parse.
    expect(withCount(0).data?.part.beatCount).toBe(0);
  });

  it('is exact about the rest', () => {
    const song = makeSong();
    for (const bad of [
      { ...song, version: 'live' },
      { ...song, asked: { ...song.asked, from: 'voice' } },
      { ...song, asked: { ...song.asked, by: 'yael' } },
      { ...song, asked: { ...song.asked, file: '' } },
      { ...song, source: { ...song.source, site: 'spotify' } },
      { ...song, source: { ...song.source, via: 'browser' } },
      { ...song, source: { ...song.source, id: '' } },
      { ...song, source: { ...song.source, url: '' } },
      { ...song, fullMs: 0 },
      { ...song, fullMs: 1.5 },
      { ...song, file: 'song.wav' },
      { ...song, file: 'music/song.mp3' },
      { ...song, gotAt: 'yesterday' },
      { ...song, trending: undefined },
    ]) {
      expect(songSchema.safeParse(bad).success).toBe(false);
    }
    const { instagramLine: _line, ...without } = song;
    expect(songSchema.safeParse(without).success).toBe(false);
  });
});

describe('Songs: SongFailure', () => {
  it('has the nine codes of the plan page', () => {
    expect(SONG_FAILURE_CODES).toEqual([
      'not_found',
      'unavailable',
      'blocked',
      'update_needed',
      'tool_missing',
      'needs_key',
      'original_audio',
      'no_trending',
      'failed',
    ]);
  });

  it('reads a failure with each code, and refuses the rest', () => {
    for (const code of SONG_FAILURE_CODES) {
      expect(songFailureSchema.safeParse(makeSongFailure({ code })).success, code).toBe(true);
    }
    expect(songFailureSchema.parse(makeSongFailure())).toEqual(makeSongFailure());
    for (const bad of [
      makeSongFailure({ code: 'no_credits' as never }),
      makeSongFailure({ asked: '' }),
      makeSongFailure({ message: '' }),
      makeSongFailure({ at: 'now' }),
    ]) {
      expect(songFailureSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('Songs: instagramLine', () => {
  it('says what to tap, with the part’s start as m:ss', () => {
    expect(instagramLine(makeSong())).toBe(
      'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42.',
    );
    expect(makeSong().instagramLine).toBe(instagramLine(makeSong()));
  });

  it('reads the start with the clock helper: seconds rounded, minutes, hours', () => {
    const at = (startMs: number) =>
      instagramLine(makeSong({ part: { startMs, endMs: startMs + 30_000, how: 'measured' } }));
    expect(at(0)).toMatch(/start at 0:00\.$/);
    expect(at(41_600)).toMatch(/start at 0:42\.$/);
    expect(at(65_000)).toMatch(/start at 1:05\.$/);
    expect(at(3_725_000)).toMatch(/start at 1:02:05\.$/);
  });

  it('is never longer than the record allows: a long title and artist are cut', () => {
    const long = (title: string, artist: string) =>
      instagramLine(
        makeSong({ title, artist, part: { startMs: 3_725_000, endMs: 3_755_000, how: 'whole' } }),
      );
    const both = long('t'.repeat(120), 'a'.repeat(120));
    expect(both.length).toBeLessThanOrEqual(SONG_LIMITS.instagramLineMax);
    expect(both).toContain('…');
    expect(both).toMatch(
      /^In Instagram tap Add audio, pick t+… by a+… and slide it to start at 1:02:05\.$/,
    );

    const longTitle = long('t'.repeat(120), 'Ofek');
    expect(longTitle.length).toBeLessThanOrEqual(SONG_LIMITS.instagramLineMax);
    expect(longTitle).toContain(' by Ofek and ');
    expect(longTitle).toBe(long('t'.repeat(120), 'Ofek'));

    const longArtist = long('Home', 'a'.repeat(120));
    expect(longArtist.length).toBeLessThanOrEqual(SONG_LIMITS.instagramLineMax);
    expect(longArtist).toContain('pick Home by ');

    // Whatever fits is left whole.
    const fits = long('t'.repeat(90), 'a'.repeat(60));
    expect(fits).not.toContain('…');
    expect(songSchema.safeParse(makeSong({ instagramLine: both })).success).toBe(true);
  });

  it('never cuts a character in two', () => {
    const emoji = '🎵'.repeat(60);
    const line = instagramLine(makeSong({ title: emoji, artist: emoji }));
    expect(line.length).toBeLessThanOrEqual(SONG_LIMITS.instagramLineMax);
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('Songs: the music script’s lines', () => {
  it('may answer ok with the song', () => {
    for (const line of [
      { ok: true, id: 'song', lengthMs: 39_000 },
      { ok: true, id: 'song', lengthMs: null },
    ]) {
      expect(musicScriptLineSchema.parse(line)).toEqual(line);
    }
    expect(parseMusicScriptLine('{"ok":true,"id":"song","lengthMs":39000}')).toEqual({
      ok: true,
      id: 'song',
      lengthMs: 39_000,
    });
  });

  it('may answer with each song failure code, and still with the Soundtrack ones', () => {
    for (const code of [...SONG_FAILURE_CODES, ...MUSIC_FAILURE_CODES]) {
      const line = { ok: false, code, message: 'One plain sentence.' };
      expect(musicScriptLineSchema.safeParse(line).success, code).toBe(true);
    }
    expect(parseMusicScriptLine('{"ok":false,"code":"original_audio","message":"x"}')).toEqual({
      ok: false,
      code: 'original_audio',
      message: 'x',
    });
    expect(musicScriptLineSchema.safeParse({ ok: false, code: 'nope', message: 'x' }).success).toBe(
      false,
    );
  });

  it('exits 2 when the owner has to act or there is no song, 3 when the site is down, 1 for the rest', () => {
    expect(SONG_FAILURE_CODES.map((code) => [code, musicExitCode(code)])).toEqual([
      ['not_found', 1],
      ['unavailable', 3],
      ['blocked', 3],
      ['update_needed', 1],
      ['tool_missing', 2],
      ['needs_key', 2],
      ['original_audio', 2],
      ['no_trending', 1],
      ['failed', 1],
    ]);
    // `failed` is both Soundtrack's and Songs'.
    expect(musicExitCode('failed')).toBe(MUSIC_EXIT_CODES.failed);
  });
});

describe('musicLengthSecOfUsageLine', () => {
  it('reads the length the usage line ends with, the way formatMusicLength wrote it', () => {
    expect(musicLengthSecOfUsageLine('Made music v2 for Horizon FPV / Demo (0:39)')).toBe(39);
    expect(musicLengthSecOfUsageLine('Made music v1 for A / B (12:05)')).toBe(725);
    expect(
      musicLengthSecOfUsageLine(`Made music v1 for A / B (${formatMusicLength(4_000_000)})`),
    ).toBe(4000);
  });

  it('is null for a line without a length', () => {
    expect(musicLengthSecOfUsageLine('Made music v1 for A / B')).toBeNull();
    expect(musicLengthSecOfUsageLine('Edited A / B (round 2)')).toBeNull();
  });
});
