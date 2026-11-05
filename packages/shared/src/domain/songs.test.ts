import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  addNoteAttachmentResponseSchema,
  deleteNoteAttachmentResponseSchema,
  isNoteAttachmentName,
  isTrendingCacheFresh,
  NO_SONG_EXPORT_SUFFIX,
  NO_SONG_MESSAGES,
  NOTE_ATTACHMENTS,
  type NoteAttachment,
  type NoteView,
  noSongExportEventSchema,
  noSongExportName,
  noSongStatusSchema,
  noteAttachmentSchema,
  noteAttachmentType,
  noteViewSchema,
  SONG_EVENT_TYPES,
  type SongFoundEvent,
  type SongGotEvent,
  songAskedEventSchema,
  songEventSchema,
  songEventText,
  songFailedEventSchema,
  songFoundEventSchema,
  songGotEventSchema,
  songTrendingEventSchema,
  TRENDING_CACHE,
  type TrendingCache,
  trendingCacheFile,
  trendingCacheSchema,
  trendingSoundSchema,
} from './songs.ts';

describe('note attachments', () => {
  it('are at most 6 pictures of 15 MB in edit/brief/from-you/', () => {
    expect(NOTE_ATTACHMENTS).toEqual({
      dir: 'brief/from-you',
      maxFiles: 6,
      maxBytes: 15 * 1024 * 1024,
      types: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'],
    });
  });

  it('are named with an allowed extension, in any case, and nothing that is a path', () => {
    for (const name of ['IMG_4412.PNG', 'shot.jpg', 'a b.jpeg', 'שוט.HEIC', 'x.webp', 'x.gif']) {
      expect(isNoteAttachmentName(name), name).toBe(true);
    }
    for (const name of [
      '',
      'shot',
      'shot.pdf',
      'shot.png.exe',
      '.png',
      '.hidden.png',
      '../shot.png',
      'a/b.png',
      'a\\b.png',
      'a\u0000.png',
      'a\n.png',
      `${'x'.repeat(252)}.png`,
    ]) {
      expect(isNoteAttachmentName(name), JSON.stringify(name)).toBe(false);
    }
    expect(isNoteAttachmentName(`${'x'.repeat(251)}.png`)).toBe(true);
    expect(noteAttachmentType('A.JPEG')).toBe('jpeg');
    expect(noteAttachmentType('A.mov')).toBeNull();
    expect(noteAttachmentType('png')).toBeNull();
  });

  it('are answered as { name, bytes, addedAt }', () => {
    const attachment = {
      name: 'IMG_4412.PNG',
      bytes: 412_903,
      addedAt: '2026-10-25T21:00:00.000Z',
    };
    expect(noteAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(addNoteAttachmentResponseSchema.parse(attachment)).toEqual(attachment);
    for (const bad of [
      { ...attachment, name: '' },
      { ...attachment, bytes: -1 },
      { ...attachment, bytes: 1.5 },
      { ...attachment, addedAt: 'today' },
    ]) {
      expect(noteAttachmentSchema.safeParse(bad).success).toBe(false);
    }
    expectTypeOf<NoteAttachment>().toEqualTypeOf<{
      name: string;
      bytes: number;
      addedAt: string;
    }>();
  });

  it('are listed with the note in the job’s note view', () => {
    const view = {
      note: 'Yael wants this song. Start it where the reel does.',
      attachments: [{ name: 'IMG_4412.PNG', bytes: 1, addedAt: '2026-10-25T21:00:00.000Z' }],
    };
    expect(noteViewSchema.parse(view)).toEqual(view);
    expect(noteViewSchema.parse({ note: null, attachments: [] })).toEqual({
      note: null,
      attachments: [],
    });
    expect(noteViewSchema.safeParse({ note: '', attachments: [] }).success).toBe(false);
    expect(noteViewSchema.safeParse({ note: null }).success).toBe(false);
    expectTypeOf<NoteView['attachments']>().toEqualTypeOf<NoteAttachment[]>();
  });

  it('answer DELETE with { ok: true }', () => {
    expect(deleteNoteAttachmentResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(deleteNoteAttachmentResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('the trending cache', () => {
  const sound = {
    igAudioId: '1234567890',
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
    isSong: true,
    reels: 18_400,
    isTrending: true,
    nicheTop20: 3,
    url: 'https://www.instagram.com/reels/audio/1234567890/',
  };
  const cache: TrendingCache = {
    v: 1,
    clientId: '1c9823704bf5',
    niche: '#fpv #drone',
    fetchedAt: '2026-10-25T21:00:00.000Z',
    sounds: [
      sound,
      {
        igAudioId: null,
        title: 'Original audio',
        artist: 'fpv.pilot.il',
        isSong: false,
        reels: null,
        isTrending: null,
        nicheTop20: 0,
        url: null,
      },
    ],
  };

  it('is trends/<clientId>.json in the data folder, reused for 7 days', () => {
    expect(TRENDING_CACHE).toEqual({ dir: 'trends', maxAgeDays: 7 });
    expect(trendingCacheFile('1c9823704bf5')).toBe('trends/1c9823704bf5.json');
  });

  it('reads a lookup with a sound Instagram knows and one it does not', () => {
    expect(trendingCacheSchema.parse(cache)).toEqual(cache);
    expect(trendingCacheSchema.safeParse({ ...cache, sounds: [] }).success).toBe(true);
    expect(trendingSoundSchema.parse(sound)).toEqual(sound);
  });

  it('is exact about the rest', () => {
    for (const bad of [
      { ...cache, v: 2 },
      { ...cache, clientId: '' },
      { ...cache, clientId: '../x' },
      { ...cache, clientId: 'a/b' },
      { ...cache, niche: '' },
      { ...cache, fetchedAt: 'last week' },
      { ...cache, sounds: [{ ...sound, nicheTop20: 21 }] },
      { ...cache, sounds: [{ ...sound, nicheTop20: null }] },
      { ...cache, sounds: [{ ...sound, isSong: undefined }] },
      { ...cache, sounds: [{ ...sound, title: '' }] },
      { ...cache, sounds: [{ ...sound, reels: -5 }] },
    ]) {
      expect(trendingCacheSchema.safeParse(bad).success).toBe(false);
    }
    // An "Original audio" may have an account for an artist, or none at all.
    expect(trendingSoundSchema.safeParse({ ...sound, artist: '' }).success).toBe(true);
  });

  it('is fresh for 7 days and not a moment longer', () => {
    const fetched = Date.parse(cache.fetchedAt);
    const day = 24 * 60 * 60 * 1000;
    expect(isTrendingCacheFresh(cache, fetched)).toBe(true);
    expect(isTrendingCacheFresh(cache, fetched + 6 * day)).toBe(true);
    expect(isTrendingCacheFresh(cache, new Date(fetched + 7 * day - 1))).toBe(true);
    expect(isTrendingCacheFresh(cache, fetched + 7 * day)).toBe(false);
    expect(isTrendingCacheFresh(cache, fetched + 30 * day)).toBe(false);
    // A clock that went back is not a fresh lookup.
    expect(isTrendingCacheFresh(cache, fetched - 1)).toBe(false);
    expect(isTrendingCacheFresh({ fetchedAt: 'garbage' }, fetched)).toBe(false);
  });
});

describe('noSongExportName', () => {
  it('is "<Job> · no song.mp4", next to the normal export', () => {
    expect(NO_SONG_EXPORT_SUFFIX).toBe(' · no song');
    expect(noSongExportName('Demo 2')).toBe('Demo 2 · no song.mp4');
  });

  it('keeps a Hebrew job name', () => {
    expect(noSongExportName('הדגמה 2')).toBe('הדגמה 2 · no song.mp4');
    expect(noSongExportName('נתתי לך בית – גרסה ב׳')).toBe('נתתי לך בית – גרסה ב׳ · no song.mp4');
  });

  it('treats the name the way the normal export does: NFC, and no / : or NUL', () => {
    expect(noSongExportName('Re: spring/summer')).toBe('Re- spring-summer · no song.mp4');
    expect(noSongExportName('a\u0000b')).toBe('a-b · no song.mp4');
    // "é" as e + a combining accent becomes the single character.
    expect(noSongExportName('Café')).toBe('Café · no song.mp4');
    expect(noSongExportName('x'.repeat(5))).toBe('xxxxx · no song.mp4');
  });

  it('is the same for a name that is already a file name part', () => {
    const once = noSongExportName('Re: x');
    expect(noSongExportName(once.slice(0, -'.mp4'.length - NO_SONG_EXPORT_SUFFIX.length))).toBe(
      'Re- x · no song.mp4',
    );
  });
});

describe('song events', () => {
  const at = '2026-10-25T21:03:00.000Z';
  const found: SongFoundEvent = {
    type: 'music.song.found',
    at,
    from: 'screenshot',
    by: 'brief',
    file: 'IMG_4412.PNG',
    url: null,
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
  };
  const got: SongGotEvent = {
    type: 'music.song.got',
    at,
    site: 'youtube-music',
    via: 'yt-dlp',
    fullMs: 192_000,
    part: { startMs: 42_000, endMs: 81_000, how: 'measured' },
  };
  const trending = {
    type: 'music.song.trending',
    at,
    niche: '#fpv',
    looked: 3,
    pick: { title: 'נתתי לך בית', artist: 'Ofek Adanek' },
  } as const;
  const failed = {
    type: 'music.song.failed',
    at,
    code: 'unavailable',
    message: 'The downloader didn’t answer, so ElevenLabs made the music instead.',
  } as const;
  const asked = { type: 'music.song.asked', at, wanted: 'another', text: 'נתתי לך בית' } as const;
  const noSong = { type: 'export.no-song', at, file: 'Demo 2 · no song.mp4' } as const;

  it('are the six of the plan, each with its own shape', () => {
    expect(SONG_EVENT_TYPES).toEqual([
      'music.song.found',
      'music.song.got',
      'music.song.trending',
      'music.song.failed',
      'music.song.asked',
      'export.no-song',
    ]);
    expect(songFoundEventSchema.parse(found)).toEqual(found);
    expect(songGotEventSchema.parse(got)).toEqual(got);
    expect(songTrendingEventSchema.parse(trending)).toEqual(trending);
    expect(songFailedEventSchema.parse(failed)).toEqual(failed);
    expect(songAskedEventSchema.parse(asked)).toEqual(asked);
    expect(noSongExportEventSchema.parse(noSong)).toEqual(noSong);
    for (const event of [found, got, trending, failed, asked, noSong]) {
      expect(songEventSchema.parse(event)).toEqual(event);
    }
    expect(SONG_EVENT_TYPES).toEqual(
      [found, got, trending, failed, asked, noSong].map((event) => event.type),
    );
  });

  it('may leave out what was not known', () => {
    expect(
      songFoundEventSchema.safeParse({
        ...found,
        title: null,
        artist: null,
        file: null,
        url: 'https://x.test/r',
      }).success,
    ).toBe(true);
    expect(songTrendingEventSchema.safeParse({ ...trending, looked: 0, pick: null }).success).toBe(
      true,
    );
    expect(
      songAskedEventSchema.safeParse({ ...asked, wanted: 'trending', text: null }).success,
    ).toBe(true);
  });

  it('refuse what does not fit', () => {
    for (const bad of [
      { ...found, from: 'voice' },
      { ...got, part: { startMs: 0, endMs: 1_000, how: 'measured' } },
      { ...got, fullMs: 0 },
      { ...trending, niche: '' },
      { ...trending, looked: -1 },
      { ...failed, code: 'no_credits' },
      { ...failed, message: '' },
      { ...asked, wanted: 'louder' },
      { ...noSong, file: '' },
      { ...noSong, at: 'later' },
      { ...found, type: 'music.song.lost' },
    ]) {
      expect(songEventSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('say what happened in the words of the job sheet board', () => {
    expect(songEventText(found)).toBe(
      'The brief found the song on Yael’s screenshot: נתתי לך בית, Ofek Adanek',
    );
    expect(songEventText(got)).toBe(
      'Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21',
    );
    expect(songEventText(failed)).toBe(
      'Couldn’t get the song: The downloader didn’t answer, so ElevenLabs made the music instead.',
    );
    expect(songEventText(noSong)).toBe('Rendered with the song, and without it');
  });

  it('say where a song was found and who found it', () => {
    const text = (overrides: Partial<SongFoundEvent>) => songEventText({ ...found, ...overrides });
    expect(text({ from: 'link' })).toBe(
      'The brief found the song in the link: נתתי לך בית, Ofek Adanek',
    );
    expect(text({ from: 'name' })).toBe(
      'The brief found the song in the note: נתתי לך בית, Ofek Adanek',
    );
    expect(text({ from: 'note', by: 'you' })).toBe(
      'The editor found the song in the note: נתתי לך בית, Ofek Adanek',
    );
    expect(text({ from: 'trending', by: 'editor' })).toBe(
      'The editor found the song on Reels: נתתי לך בית, Ofek Adanek',
    );
    expect(text({ title: 'Home', artist: null })).toBe(
      'The brief found the song on Yael’s screenshot: Home',
    );
    expect(text({ title: null, artist: null, url: 'https://x.test/r' })).toBe(
      'The brief found the song on Yael’s screenshot: https://x.test/r',
    );
    expect(text({ title: null, artist: null })).toBe(
      'The brief found the song on Yael’s screenshot',
    );
  });

  it('say how the song was got and which part', () => {
    const text = (overrides: Partial<SongGotEvent>) => songEventText({ ...got, ...overrides });
    expect(text({ site: 'youtube', fullMs: 65_000 })).toMatch(
      /^Got the song from YouTube \(1:05\)\./,
    );
    expect(text({ site: 'instagram', via: 'apify' })).toMatch(
      /^Got the song from Instagram \(3:12\)\./,
    );
    expect(text({ site: 'tiktok', via: 'apify' })).toMatch(/^Got the song from TikTok /);
    expect(text({ part: { startMs: 0, endMs: 45_000, how: 'whole' } })).toMatch(
      /The whole song: 0:00 to 0:45$/,
    );
    expect(text({ part: { startMs: 12_000, endMs: 40_000, how: 'reel' } })).toMatch(
      /The part the reel uses: 0:12 to 0:40$/,
    );
  });

  it('say what the trending pick was (not how many songs it looked at), and what was asked in Review', () => {
    expect(songEventText(trending)).toBe(
      'Picked a song rising on Reels in #fpv: נתתי לך בית by Ofek Adanek',
    );
    // The count is not in the music record, so the line never says it, whatever the event holds.
    expect(songEventText({ ...trending, looked: 1 })).toBe(songEventText(trending));
    expect(songEventText({ ...trending, looked: 0 })).toBe(songEventText(trending));
    expect(songEventText({ ...trending, looked: 5, pick: null })).toBe(
      'No song rising on Reels in #fpv fit the cut',
    );
    expect(songEventText(asked)).toBe('You asked for another song: נתתי לך בית');
    expect(songEventText({ ...asked, text: null })).toBe('You asked for another song');
    expect(songEventText({ ...asked, wanted: 'trending', text: null })).toBe(
      'You asked for a trending song',
    );
  });
});

describe('noSongStatusSchema', () => {
  it('reads the five states of the second export', () => {
    for (const status of [
      { state: 'none' },
      { state: 'idle' },
      { state: 'making' },
      { state: 'failed', message: 'The file without the song could not be made: boom' },
      { state: 'ready', file: 'Demo 2 · no song.mp4', at: '2026-10-25T21:30:00.000Z' },
    ]) {
      expect(noSongStatusSchema.parse(status)).toEqual(status);
    }
  });

  it('refuses a failure with no words, a ready one with no file or time, and another state', () => {
    expect(noSongStatusSchema.safeParse({ state: 'failed' }).success).toBe(false);
    expect(noSongStatusSchema.safeParse({ state: 'failed', message: '' }).success).toBe(false);
    expect(noSongStatusSchema.safeParse({ state: 'ready', file: 'x.mp4' }).success).toBe(false);
    expect(
      noSongStatusSchema.safeParse({ state: 'ready', at: '2026-10-25T21:30:00.000Z' }).success,
    ).toBe(false);
    expect(noSongStatusSchema.safeParse({ state: 'done' }).success).toBe(false);
  });

  it('turns a ready one into History’s export.no-song fact', () => {
    const status = noSongStatusSchema.parse({
      state: 'ready',
      file: noSongExportName('Demo 2'),
      at: '2026-10-25T21:30:00.000Z',
    });
    expect(
      status.state === 'ready' &&
        noSongExportEventSchema.parse({ type: 'export.no-song', at: status.at, file: status.file }),
    ).toEqual({
      type: 'export.no-song',
      at: '2026-10-25T21:30:00.000Z',
      file: 'Demo 2 · no song.mp4',
    });
  });

  it('has words for the two answers that are not a status', () => {
    expect(NO_SONG_MESSAGES.nothingToMake).not.toBe('');
    expect(NO_SONG_MESSAGES.noFile).not.toBe('');
  });
});
