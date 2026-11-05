import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  instagramLine,
  SONG_FAILURE_CODES,
  SONG_SITES,
  SONG_VIAS,
  type Song,
  songSchema,
} from '@studio/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APIFY,
  type Candidate,
  classifyLink,
  type GotSong,
  getSong,
  isOriginalSound,
  normName,
  pickCanonical,
  pruneSongsCache,
  RANK,
  rankCandidates,
  readApifyToken,
  readInstagramItem,
  readTikTokItem,
  redact,
  type SearchEntry,
  SongError,
  songNameOfSound,
  YT_MUSIC,
} from '../../assets/music/get-song.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import {
  type Bench,
  bytes,
  type FetchCall,
  fakeFetch,
  fixture,
  html,
  json,
  lengthOf,
  makeAudio,
  makeBench,
  type Reply,
  TOKEN,
} from './test-utils.js';

// The song getter (assets/music/get-song.mjs): its pure parts (links, ranking, iTunes' pick, the
// reel scrapers' items, the key), then getSong end to end against a fake yt-dlp (a script answering
// from testdata/) and a fake fetch for Apify, iTunes, Spotify and the reels' audio. No test uses
// the network, a real key or the live inbox; the key must only ever be in an Authorization header.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn(
    'get-song.test.ts: ffmpeg/ffprobe not found on PATH or in /opt/homebrew/bin; skipping the runs that need them (brew install ffmpeg)',
  );
}

/** Every failure code the getter threw in these tests: all of them must be the contract's. */
const seenCodes = new Set<string>();

async function failure(promise: Promise<unknown>, code: string): Promise<SongError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a ${code} failure, but it got the song`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SongError);
  const songError = error as SongError;
  expect(songError.code).toBe(code);
  expect(songError.message).not.toContain(TOKEN);
  seenCodes.add(songError.code);
  return songError;
}

/** The song as SG3 will record it, from what the getter returned: it must parse as the contract's. */
function asSong(got: GotSong, from: 'name' | 'link' = 'name'): Song {
  const part = { startMs: 0, endMs: Math.min(got.meta.fullMs, 20_000), how: 'measured' as const };
  return songSchema.parse({
    title: got.meta.title,
    artist: got.meta.artist,
    version: null,
    asked: { from, file: null, url: null, by: 'brief' },
    source: {
      site: got.meta.site,
      via: got.meta.via,
      url: got.meta.url,
      id: got.meta.id,
    },
    fullMs: got.meta.fullMs,
    part,
    trending: null,
    file: 'song.mp3',
    instagramLine: instagramLine({ title: got.meta.title, artist: got.meta.artist, part }),
    gotAt: new Date().toISOString(),
  });
}

const entry = (
  id: string,
  title: string,
  seconds: number | null,
  channel = 'Someone',
  extra: Partial<SearchEntry> = {},
): SearchEntry => ({
  id,
  title,
  duration: seconds,
  channel,
  uploader: channel,
  view_count: 1000,
  channel_is_verified: false,
  ...extra,
});

const ids = (list: Candidate[]) => list.map((item) => item.id);

// --- pure parts ----------------------------------------------------------------------------------

describe('classifyLink', () => {
  it('reads reels and videos, with the code', () => {
    expect(classifyLink('https://www.instagram.com/reel/DX7lzTOJ1p6/?igsh=abc')).toMatchObject({
      kind: 'instagram',
      code: 'DX7lzTOJ1p6',
    });
    expect(classifyLink('https://instagram.com/p/CODE12345/')).toMatchObject({
      kind: 'instagram',
      code: 'CODE12345',
    });
    expect(classifyLink('instagram.com/someone/reel/ABCDE12345/')).toMatchObject({
      kind: 'instagram',
      code: 'ABCDE12345',
    });
    expect(classifyLink('https://www.tiktok.com/@dancer/video/7333300000000000001')).toMatchObject({
      kind: 'tiktok',
      code: '7333300000000000001',
    });
    expect(classifyLink('https://vm.tiktok.com/ZSabc123/')).toMatchObject({
      kind: 'tiktok',
      code: 'ZSabc123',
    });
  });

  it('reads YouTube in every shape', () => {
    expect(classifyLink('https://www.youtube.com/watch?v=nat0Topic01&list=PLx')).toMatchObject({
      kind: 'youtube',
      id: 'nat0Topic01',
      music: false,
    });
    expect(classifyLink('https://music.youtube.com/watch?v=nat0Topic01')).toMatchObject({
      kind: 'youtube',
      id: 'nat0Topic01',
      music: true,
    });
    expect(classifyLink('https://youtu.be/nat0Topic01?si=zz')).toMatchObject({
      kind: 'youtube',
      id: 'nat0Topic01',
    });
    expect(classifyLink('https://www.youtube.com/shorts/nat0Topic01')).toMatchObject({
      kind: 'youtube',
      id: 'nat0Topic01',
    });
  });

  it('reads Spotify tracks and Apple Music songs', () => {
    expect(
      classifyLink('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x'),
    ).toMatchObject({
      kind: 'spotify',
      trackId: '4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(
      classifyLink('https://open.spotify.com/intl-he/track/4uLU6hMCjMI75M1A2tKUQC'),
    ).toMatchObject({
      kind: 'spotify',
      trackId: '4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(
      classifyLink('https://music.apple.com/us/album/blinding-lights/1499378081?i=1499378108'),
    ).toMatchObject({ kind: 'apple', trackId: '1499378108', country: 'us' });
    expect(
      classifyLink('https://music.apple.com/il/song/blinding-lights/1499378108'),
    ).toMatchObject({
      kind: 'apple',
      trackId: '1499378108',
      country: 'il',
    });
  });

  it('says why a link of a known site is not one song', () => {
    expect(classifyLink('https://www.instagram.com/someaccount/')?.problem).toContain('reel');
    expect(classifyLink('https://www.instagram.com/reels/audio/123456789/')?.problem).toContain(
      'reel',
    );
    expect(classifyLink('https://www.tiktok.com/@dancer')?.problem).toContain('video');
    expect(classifyLink('https://www.youtube.com/playlist?list=PLabc')?.problem).toContain(
      'one video',
    );
    expect(classifyLink('https://open.spotify.com/album/abc')?.problem).toContain('one song');
    expect(
      classifyLink('https://music.apple.com/us/album/after-hours/1499378081')?.problem,
    ).toContain('one song');
  });

  it('other sites are other, and a thing that is not a link is null', () => {
    expect(classifyLink('https://soundcloud.com/a/b')).toMatchObject({
      kind: 'other',
      host: 'soundcloud.com',
    });
    expect(classifyLink('נתתי לך בית')).toBeNull();
    expect(classifyLink('two words')).toBeNull();
    expect(classifyLink('')).toBeNull();
    expect(classifyLink('ftp://example.com/x')).toBeNull();
    expect(classifyLink('https://localhost/x')).toBeNull();
  });
});

describe('rankCandidates', () => {
  const want = { title: 'Blinding Lights', artist: 'The Weeknd', canonicalMs: 200_040 };

  it('drops a lyric video, a live take, a cover, a karaoke, a 10-hour loop and the rest of the list', () => {
    const list = rankCandidates(
      [
        entry('lyric000001', 'The Weeknd - Blinding Lights (Lyrics)', 200),
        entry('live0000001', 'The Weeknd - Blinding Lights (Live at SNL)', 200),
        entry('cover000001', 'Blinding Lights cover by Dana', 200),
        entry('karaoke0001', 'Blinding Lights (Karaoke Version)', 200),
        entry('inst0000001', 'Blinding Lights instrumental', 200),
        entry('loop0000001', 'Blinding Lights loop', 200),
        entry('hours000001', 'Blinding Lights 10 HOURS', 36_000),
        entry('hour0000001', 'Blinding Lights 1hour', 200),
        entry('react000001', 'Blinding Lights REACTION', 200),
        entry('night000001', 'Blinding Lights nightcore', 200),
        entry('slowed00001', 'Blinding Lights slowed', 200),
        entry('reverb00001', 'Blinding Lights reverb', 200),
        entry('eightd00001', 'Blinding Lights 8D audio', 200),
        entry('sped0000001', 'Blinding Lights sped up', 200),
        entry('remix000001', 'Blinding Lights (Remix)', 200),
        entry('good0000001', 'The Weeknd - Blinding Lights (Official Audio)', 200),
      ],
      want,
    );
    expect(ids(list)).toEqual(['good0000001']);
  });

  it('drops entries more than 5 s off the canonical length, keeps 5 s (an official audio upload runs a few seconds long)', () => {
    const list = rankCandidates(
      [
        entry('exact000001', 'Blinding Lights', 200.04),
        entry('plus4000001', 'Blinding Lights a', 204.1),
        entry('plus5000001', 'Blinding Lights b', 205.0),
        entry('plus6000001', 'Blinding Lights c', 206.1),
        entry('minus400001', 'Blinding Lights d', 196.0),
        entry('minus600001', 'Blinding Lights e', 194.0),
      ],
      want,
    );
    expect(new Set(ids(list))).toEqual(
      new Set(['exact000001', 'plus4000001', 'plus5000001', 'minus400001']),
    );
    expect(list[0]?.id).toBe('exact000001');
  });

  it('drops entries with no id, no length, a live stream, or 15 minutes and more', () => {
    const list = rankCandidates(
      [
        entry('', 'Blinding Lights', 200),
        entry('nolength0001', 'Blinding Lights', null),
        entry('stream000001', 'Blinding Lights', 200, 'x', { live_status: 'is_live' }),
        entry('long00000001', 'Blinding Lights', 900),
        entry('fine00000001', 'Blinding Lights', 200),
      ],
      { ...want, canonicalMs: null },
    );
    expect(ids(list)).toEqual(['fine00000001']);
  });

  it('prefers a Topic channel, then a verified one, then the artist in the channel, then the closest length', () => {
    const list = rankCandidates(
      [
        entry('closest00001', 'Blinding Lights', 200.04, 'Random', { view_count: 9_000_000_000 }),
        entry('artist000001', 'Blinding Lights', 201, 'The Weeknd Fans'),
        entry('verified0001', 'Blinding Lights', 202, 'Official', { channel_is_verified: true }),
        entry('topic0000001', 'Blinding Lights', 203, 'The Weeknd - Topic'),
      ],
      want,
    );
    expect(ids(list)).toEqual(['topic0000001', 'verified0001', 'artist000001', 'closest00001']);
  });

  it('breaks a tie by the closest length', () => {
    const list = rankCandidates(
      [entry('far00000001', 'Blinding Lights', 202), entry('near0000001', 'Blinding Lights', 200)],
      want,
    );
    expect(ids(list)).toEqual(['near0000001', 'far00000001']);
  });

  it('without a canonical length: keeps those within 15 s of the most viewed, prefers the most viewed', () => {
    const list = rankCandidates(
      [
        entry('fan00000001', 'Quiet Rooms', 180, 'Fans', { view_count: 900_000 }),
        entry('other0000001', 'Quiet Rooms (full)', 240, 'Fans', { view_count: 100_000 }),
        entry('near0000001', 'Quiet Rooms 2', 190, 'Fans', { view_count: 700_000 }),
        entry('edge0000001', 'Quiet Rooms 3', 195, 'Fans', { view_count: 800_000 }),
        entry('over0000001', 'Quiet Rooms 4', 195.5, 'Fans', { view_count: 600_000 }),
      ],
      { title: 'Quiet Rooms', artist: 'Some Band', canonicalMs: null },
    );
    expect(ids(list)).toEqual(['fan00000001', 'edge0000001', 'near0000001']);
    expect(RANK.looseToleranceMs).toBe(15_000);
  });

  it('a Topic channel still wins when there is no canonical length', () => {
    const list = rankCandidates(
      [
        entry('fan00000001', 'Quiet Rooms', 180, 'Fans', { view_count: 900_000 }),
        entry('topic000001', 'Quiet Rooms', 185, 'Some Band - Topic', { view_count: 400_000 }),
      ],
      { title: 'Quiet Rooms', artist: 'Some Band', canonicalMs: null },
    );
    expect(ids(list)).toEqual(['topic000001', 'fan00000001']);
  });

  it("counts an info call's track (the song's own title) as the title too", () => {
    const list = rankCandidates(
      [
        entry('video000001', 'The Weeknd, a video of nothing', 200),
        entry('track000001', 'Official upload', 200, 'The Weeknd', { track: 'Blinding Lights' }),
      ],
      want,
    );
    expect(list.map((item) => [item.id, item.titleMatch])).toEqual([
      ['track000001', true],
      ['video000001', false],
    ]);
  });

  it('puts the song with its own title first, wherever it ranks otherwise', () => {
    const list = rankCandidates(
      [
        entry('other000001', 'Save Your Tears', 200, 'The Weeknd - Topic'),
        entry('this0000001', 'Blinding Lights', 200, 'Fans'),
      ],
      want,
    );
    expect(ids(list)).toEqual(['this0000001', 'other000001']);
  });

  it('a sped-up ask: only sped-up uploads of 80 to 91% of the original, Topic or the artist first', () => {
    const list = rankCandidates(
      [
        entry('original0001', 'Blinding Lights', 200, 'The Weeknd - Topic'),
        entry('user00000001', 'Blinding Lights sped up', 175, 'fastsongs', {
          view_count: 90_000_000,
        }),
        entry('topic0000001', 'Blinding Lights (Sped Up)', 168, 'The Weeknd - Topic'),
        entry('toolong00001', 'Blinding Lights sped up extended', 250, 'fastsongs'),
        entry('tooshort0001', 'Blinding Lights sped up', 120, 'fastsongs'),
        entry('nightcore001', 'Blinding Lights nightcore', 165, 'nc'),
        entry('slowed000001', 'Blinding Lights slowed', 165, 'nc'),
      ],
      { ...want, version: 'sped up' },
    );
    expect(ids(list)).toEqual(['topic0000001', 'user00000001', 'nightcore001']);
    // 80 to 91% of 200.04 s, 5 s of room each side:
    expect(
      rankCandidates([entry('edgelow00001', 'x sped up', 157.1)], {
        ...want,
        title: 'x',
        version: 'sped up',
      }),
    ).toHaveLength(1);
    expect(
      rankCandidates([entry('edgehigh0001', 'x sped up', 184.9)], {
        ...want,
        title: 'x',
        version: 'sped up',
      }),
    ).toHaveLength(1);
    expect(
      rankCandidates([entry('outhigh00001', 'x sped up', 187.3)], {
        ...want,
        title: 'x',
        version: 'sped up',
      }),
    ).toHaveLength(0);
  });

  it('a slowed ask lifts the slowed and reverb bans and wants a longer track', () => {
    const list = rankCandidates(
      [
        entry('original0001', 'Blinding Lights', 200),
        entry('slowed000001', 'Blinding Lights (Slowed + Reverb)', 245),
        entry('slowed000002', 'Blinding Lights slowed', 190),
      ],
      { ...want, version: 'slowed' },
    );
    expect(ids(list)).toEqual(['slowed000001']);
  });

  it('a remix ask wants "remix" in the title and ignores the original length', () => {
    const list = rankCandidates(
      [
        entry('original0001', 'Blinding Lights', 200),
        entry('remix000001', 'Blinding Lights (Remix)', 213),
        entry('remix000002', 'Blinding Lights (Chromatics Remix)', 301),
      ],
      { ...want, version: 'remix' },
    );
    expect(new Set(ids(list))).toEqual(new Set(['remix000001', 'remix000002']));
  });

  it('a banned word that is in the song asked for is not banned', () => {
    const list = rankCandidates(
      [
        entry('forever0001', 'Live Forever', 216, 'Oasis - Topic'),
        entry('live0000001', 'Live Forever (Live)', 216),
      ],
      { title: 'Live Forever', artist: 'Oasis', canonicalMs: 216_000 },
    );
    expect(list).toHaveLength(2);
  });

  it('reads Hebrew titles: Hebrew lyrics, live, cover and karaoke are banned too', () => {
    const list = rankCandidates(
      [
        entry('he000000001', 'נתתי לך בית (מילים)', 192),
        entry('he000000002', 'נתתי לך בית לייב', 192),
        entry('he000000003', 'נתתי לך בית קאבר', 192),
        entry('he000000004', 'נתתי לך בית קריוקי', 192),
        entry('he000000005', 'נתתי לך בית', 192, 'אופק אדנק - Topic'),
      ],
      { title: 'נתתי לך בית', artist: 'אופק אדנק', canonicalMs: 192_400 },
    );
    expect(ids(list)).toEqual(['he000000005']);
    expect(list[0]).toMatchObject({ topic: true, artistInChannel: true, titleMatch: true });
  });

  it('works on an empty or odd list', () => {
    expect(rankCandidates([], want)).toEqual([]);
    expect(rankCandidates([null as unknown as SearchEntry, {}], want)).toEqual([]);
  });
});

describe('pickCanonical', () => {
  const results = [
    {
      kind: 'song',
      trackName: 'Blinding Lights (Remix)',
      artistName: 'The Weeknd',
      trackTimeMillis: 213_000,
    },
    {
      kind: 'song',
      trackName: 'Blinding Lights',
      artistName: 'The Weeknd',
      trackTimeMillis: 200_040,
    },
    {
      kind: 'music-video',
      trackName: 'Blinding Lights',
      artistName: 'The Weeknd',
      trackTimeMillis: 260_000,
    },
    {
      kind: 'song',
      trackName: 'Blinding Lights',
      artistName: 'Someone Else',
      trackTimeMillis: 99_000,
    },
  ];

  it('is the song with the asked title and artist, a title that is exactly the asked one first', () => {
    expect(pickCanonical(results, 'Blinding Lights', 'The Weeknd')?.trackTimeMillis).toBe(200_040);
    expect(pickCanonical(results, 'Blinding Lights (feat. X)', 'The Weeknd')?.trackTimeMillis).toBe(
      200_040,
    );
  });

  it('takes a title that only has the asked one in it when nothing is exact', () => {
    const edit = {
      kind: 'song',
      trackName: 'Blinding Lights (Radio Edit)',
      artistName: 'The Weeknd',
      trackTimeMillis: 190_000,
    };
    expect(pickCanonical([edit], 'Blinding Lights', 'The Weeknd')?.trackTimeMillis).toBe(190_000);
  });

  it('never takes a remix, a live take or a sped-up version for the song', () => {
    for (const name of [
      'Blinding Lights (Remix)',
      'Blinding Lights - Live',
      'Blinding Lights (Sped Up)',
    ]) {
      const result = {
        kind: 'song',
        trackName: name,
        artistName: 'The Weeknd',
        trackTimeMillis: 213_000,
      };
      expect(pickCanonical([result], 'Blinding Lights', 'The Weeknd')).toBeNull();
    }
    const remix = {
      kind: 'song',
      trackName: 'Blinding Lights (Remix)',
      artistName: 'The Weeknd',
      trackTimeMillis: 213_000,
    };
    expect(pickCanonical([remix], 'Blinding Lights (Remix)', 'The Weeknd')?.trackTimeMillis).toBe(
      213_000,
    );
  });

  it('is null for another artist, a video, no length or nothing', () => {
    expect(pickCanonical(results, 'Blinding Lights', 'Nobody')).toBeNull();
    expect(pickCanonical(results.slice(2, 3), 'Blinding Lights', 'The Weeknd')).toBeNull();
    expect(
      pickCanonical(
        [{ kind: 'song', trackName: 'Blinding Lights', artistName: 'The Weeknd' }],
        'Blinding Lights',
        'The Weeknd',
      ),
    ).toBeNull();
    expect(pickCanonical([], 'Blinding Lights', 'The Weeknd')).toBeNull();
    expect(pickCanonical(undefined as unknown as [], 'x', 'y')).toBeNull();
  });

  it('matches without an artist', () => {
    expect(pickCanonical(results, 'Blinding Lights', '')?.trackTimeMillis).toBe(200_040);
  });

  it('reads Hebrew', () => {
    const hebrew = fixture<{ results: Parameters<typeof pickCanonical>[0] }>('itunes', 'natati-il');
    expect(pickCanonical(hebrew.results, 'נתתי לך בית', 'אופק אדנק')?.trackTimeMillis).toBe(
      192_400,
    );
    expect(normName('Café (feat. Bob)  Déjà vu')).toBe('cafe deja vu');
    expect(normName('Song (Remix)')).toBe('song remix');
    expect(normName('שָׁלוֹם  עולם')).toBe('שלום עולם');
  });
});

describe('what the reel scrapers say', () => {
  it('an Instagram item: the song, its artist, the audio and the shortcode', () => {
    const [item] = fixture<unknown[]>('apify', 'instagram-song');
    expect(readInstagramItem(item)).toEqual({
      id: 'DX7lzTOJ1p6',
      url: 'https://www.instagram.com/reel/DX7lzTOJ1p6/',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      owners: ['someaccount'],
      original: false,
      audioUrl:
        'https://scontent-fra5-1.cdninstagram.com/o1/v/t2/f2/m86/audio.mp4?_nc_ht=scontent&oh=00_signed',
      durationMs: 12_400,
      error: '',
    });
  });

  it('uses the video when there is no audio url, and never a non-https url', () => {
    expect(
      readInstagramItem({ videoUrl: 'https://cdn.test/v.mp4', musicInfo: { song_name: 'A' } })
        .audioUrl,
    ).toBe('https://cdn.test/v.mp4');
    expect(
      readInstagramItem({ audioUrl: 'http://cdn.test/a.mp4', musicInfo: { song_name: 'A' } })
        .audioUrl,
    ).toBeNull();
    expect(readInstagramItem({ audioUrl: 'file:///etc/passwd' }).audioUrl).toBeNull();
    for (const host of [
      'localhost',
      '127.0.0.1',
      '192.168.1.5',
      '10.0.0.2',
      '172.20.1.1',
      'nas.local',
      '169.254.1.1',
    ]) {
      expect(readInstagramItem({ audioUrl: `https://${host}/a.mp4` }).audioUrl).toBeNull();
    }
    expect(readInstagramItem({ audioUrl: 'https://172.32.1.1/a.mp4' }).audioUrl).not.toBeNull();
  });

  it('a TikTok item: the music and the play url', () => {
    const [item] = fixture<unknown[]>('apify', 'tiktok-song');
    expect(readTikTokItem(item)).toMatchObject({
      id: '7333300000000000001',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      original: false,
      audioUrl: 'https://sf16-ies-music.tiktokcdn.com/obj/ies-music/blinding.mp3',
      durationMs: 15_000,
    });
  });

  it('knows "Original audio" in English and Hebrew, and the flag', () => {
    expect(isOriginalSound('Original audio', false)).toBe(true);
    expect(isOriginalSound('original sound - dancer', false)).toBe(true);
    expect(isOriginalSound('אודיו מקורי', false)).toBe(true);
    expect(isOriginalSound('אודיו מקורי - someaccount', false)).toBe(true);
    expect(isOriginalSound('אודיו מקורית', false)).toBe(false);
    expect(isOriginalSound('', false)).toBe(true);
    expect(isOriginalSound('Blinding Lights', true)).toBe(true);
    expect(isOriginalSound('Blinding Lights', false)).toBe(false);
    expect(isOriginalSound('Original Sin', false)).toBe(false);
  });

  it('"Original audio" in the languages the reels come in is the creator\'s own sound, flag or not', () => {
    const names = [
      'Original audio',
      'Original sound',
      'original sound - dancer',
      'Originalton',
      'Originalton - someaccount',
      'som original',
      'Som original - conta',
      'sonido original',
      'Audio original',
      'Áudio original',
      'son original',
      'Son original - compte',
      'suono originale',
      'Audio originale',
      'оригинальный звук',
      'оригінальний аудіозапис',
      'оригінальний звук',
      'אודיו מקורי',
      // The accent written as a letter and a combining mark (some actors send it so).
      'Áudio original'.normalize('NFD'),
      'оригінальний аудіозапис'.normalize('NFD'),
    ];
    for (const name of names) {
      expect(isOriginalSound(name, false), name).toBe(true);
      // The words win over everything else: even a different author does not make it a song.
      expect(isOriginalSound(name, true, 'Somebody Else', 'someone'), name).toBe(true);
    }
    // Songs that only start like those words.
    for (const name of [
      'Original Sin',
      'Originals',
      'Son of a Preacher Man',
      'Audioslave',
      'Suono',
    ]) {
      expect(isOriginalSound(name, false), name).toBe(false);
    }
  });

  it("a named sound with the actor's flag is the creator's own only when its author is the video's own account", () => {
    // Real items (SG13): a song uploaded as a sound is a song, whatever the flag says.
    expect(isOriginalSound('КРУЖИТЬ', true, 'Dmytro Monatik', ['nrkdnk'])).toBe(false);
    expect(
      isOriginalSound('Somewhere only we know - Keane', true, 'sofia.peters', 'zianlutfiana'),
    ).toBe(false);
    expect(
      isOriginalSound('Atmosphere • Anyma, Chris Avantgarde', true, 'anyma.fans', 'irvinepolice'),
    ).toBe(false);
    // The creator's own named sound: its author is the account (punctuation, case and emoji aside).
    expect(isOriginalSound('Mibellyuseche💋', true, 'mibellyuseche', 'mibellyuseche')).toBe(true);
    expect(isOriginalSound('Mix', true, '@Some.Dj', 'some_dj')).toBe(true);
    expect(isOriginalSound('DJI OR', true, 'DJI OR', 'dji.or')).toBe(true);
    // TikTok: the author of an own sound can be the account's nickname.
    expect(
      isOriginalSound('my beat', true, 'Dan the Dancer', ['dancer_dan', 'Dan the Dancer']),
    ).toBe(true);
    expect(isOriginalSound('my beat', true, 'Dan the Dancer', ['dancer_dan'])).toBe(false);
    // Without the flag a named sound is a song, even by the account itself.
    expect(isOriginalSound('Blinding Lights', false, 'someone', 'someone')).toBe(false);
    // When the author or the account is not known, the flag decides, as it always did.
    expect(isOriginalSound('Blinding Lights', true)).toBe(true);
    expect(isOriginalSound('Blinding Lights', true, 'The Weeknd')).toBe(true);
    expect(isOriginalSound('Blinding Lights', true, '', 'someone')).toBe(true);
    expect(isOriginalSound('Blinding Lights', true, 'The Weeknd', null)).toBe(true);
    expect(isOriginalSound('Blinding Lights', true, 'The Weeknd', [undefined, ''])).toBe(true);
    // No name is no song.
    expect(isOriginalSound('', false, 'someone', 'other')).toBe(true);
  });

  it('a TikTok song uploaded as a sound is read as a song (the flag says original, the author is not the account)', () => {
    const [kruzhit] = fixture<unknown[]>('apify', 'tiktok-song-as-sound');
    expect(readTikTokItem(kruzhit)).toMatchObject({
      id: '7700258159444643092',
      title: 'КРУЖИТЬ',
      artist: 'Dmytro Monatik',
      original: false,
      audioUrl: 'https://sf16-ies-music.tiktokcdn.com/obj/ies-music/kruzhit.mp3',
    });
    const [carMusic] = fixture<unknown[]>('apify', 'tiktok-car-music');
    expect(readTikTokItem(carMusic)).toMatchObject({
      title: 'Car Music 37',
      artist: 'Fabrício Cesar',
      original: false,
    });
  });

  it('a TikTok creator\'s own named sound and its "original sound" stay the creator\'s own', () => {
    const [own] = fixture<unknown[]>('apify', 'tiktok-own-named-sound');
    expect(readTikTokItem(own)).toMatchObject({ title: 'my beat', original: true });
    const [named] = fixture<unknown[]>('apify', 'tiktok-original');
    expect(readTikTokItem(named).original).toBe(true);
  });

  it("an Instagram song uploaded as a sound is read as a song; the creator's own named sound is not", () => {
    const [keane] = fixture<unknown[]>('apify', 'instagram-song-as-sound');
    expect(readInstagramItem(keane)).toMatchObject({
      id: 'DKeaneSound1',
      title: 'Somewhere only we know - Keane',
      artist: 'sofia.peters',
      original: false,
    });
    const [own] = fixture<unknown[]>('apify', 'instagram-own-named-sound');
    expect(readInstagramItem(own)).toMatchObject({ title: 'Mibellyuseche💋', original: true });
    for (const name of ['instagram-original', 'instagram-hebrew-original']) {
      const [item] = fixture<unknown[]>('apify', name);
      expect(readInstagramItem(item).original, name).toBe(true);
    }
  });

  it("a TikTok item names the video's own account (its name and nickname)", () => {
    const [own] = fixture<unknown[]>('apify', 'tiktok-own-named-sound');
    expect(readTikTokItem(own).owners).toEqual(['dancer_dan', 'Dan the Dancer']);
    const [keane] = fixture<unknown[]>('apify', 'instagram-song-as-sound');
    expect(readInstagramItem(keane).owners).toEqual(['zianlutfiana']);
    expect(readInstagramItem({ shortCode: 'X' }).owners).toEqual([]);
  });

  it('an item with an error is an error', () => {
    const [item] = fixture<unknown[]>('apify', 'instagram-error');
    expect(readInstagramItem(item).error).toBe('not_found');
  });
});

describe('songNameOfSound', () => {
  it('splits "Song - Artist" and "Song • Artist" when the artist field is the uploader', () => {
    // The real SG13 examples: the uploader is the artist field, the song and its artist are in the title.
    expect(
      songNameOfSound('Somewhere only we know - Keane', 'sofia.peters', 'zianlutfiana'),
    ).toEqual({ title: 'Somewhere only we know', artist: 'Keane' });
    expect(
      songNameOfSound('Atmosphere • Anyma, Chris Avantgarde', 'anyma.fans', 'irvinepolice'),
    ).toEqual({ title: 'Atmosphere', artist: 'Anyma, Chris Avantgarde' });
    expect(songNameOfSound('Song · Artist', 'a_b', '')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
    expect(songNameOfSound('Song – Artist', 'a_b', '')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
    expect(songNameOfSound('שיר - אמן', 'tal.cohen', 'x')).toEqual({ title: 'שיר', artist: 'אמן' });
  });

  it("the uploader is the video's own account, an empty artist, an @name, or one word with no spaces", () => {
    // The video's account (a name or a list of names, as TikTok gives them), however it is spelled.
    expect(
      songNameOfSound('Song - Artist', 'Dan the Dancer', ['dancer_dan', 'Dan the Dancer']),
    ).toEqual({ title: 'Song', artist: 'Artist' });
    expect(songNameOfSound('Song - Artist', 'Mi Belly 💋', 'mibelly')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
    expect(songNameOfSound('Song - Artist', '', '')).toEqual({ title: 'Song', artist: 'Artist' });
    expect(songNameOfSound('Song - Artist', '@some.dj', null)).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
    expect(songNameOfSound('Song - Artist', 'keanefan')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
  });

  it("keeps a real artist's song as it is: a dash in the title is not the artist when the artist field is a name", () => {
    expect(songNameOfSound('Blinding Lights - Something', 'The Weeknd', 'someone')).toEqual({
      title: 'Blinding Lights - Something',
      artist: 'The Weeknd',
    });
    expect(songNameOfSound('Hello - Adele', 'Dua Lipa & Friends', 'x')).toEqual({
      title: 'Hello - Adele',
      artist: 'Dua Lipa & Friends',
    });
    // A creator account's own name with spaces and no match is not the uploader.
    expect(songNameOfSound('Song - Artist', 'Dan the Dancer', ['dancer_dan'])).toEqual({
      title: 'Song - Artist',
      artist: 'Dan the Dancer',
    });
  });

  it('never splits a version of the song: Remix, Live, Remaster, Part 2, From the film', () => {
    for (const title of [
      'Blinding Lights - Remix',
      'Blinding Lights – Slowed + Reverb',
      'Hotel California - 2013 Remaster',
      'Wake Me Up - Radio Edit',
      'Song • Live at Wembley',
      'Hold On - Pt. 2',
      'Hold On - Part II',
      'Let It Go - From "Frozen"',
      'Song - Acoustic Version',
      'שיר - רמיקס',
    ]) {
      expect(songNameOfSound(title, 'sofia.peters', 'x'), title).toEqual({
        title,
        artist: 'sofia.peters',
      });
    }
  });

  it('needs spaces around the separator and a title and an artist on both sides', () => {
    for (const title of ['Spider-Man', 'Song-Artist', 'AC/DC', 'Song -', '- Artist', ' - ', '']) {
      expect(songNameOfSound(title, 'a_b', ''), title).toEqual({
        title: title.trim(),
        artist: 'a_b',
      });
    }
  });

  it('splits at the last separator and leaves credits in the artist', () => {
    expect(songNameOfSound('Song - Mix Two - Artist', 'a_b')).toEqual({
      title: 'Song - Mix Two',
      artist: 'Artist',
    });
    expect(songNameOfSound('Song - Artist feat. Other', 'a_b')).toEqual({
      title: 'Song',
      artist: 'Artist feat. Other',
    });
  });

  it('tolerates things that are not text', () => {
    expect(songNameOfSound(undefined, null, undefined)).toEqual({ title: '', artist: '' });
    expect(songNameOfSound('Song', 'Artist')).toEqual({ title: 'Song', artist: 'Artist' });
    expect(songNameOfSound(5, 5, 5)).toEqual({ title: '', artist: '' });
  });
});

describe('the Apify key', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'songs-env-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('comes from the environment first, then the .env file', () => {
    const file = join(dir, '.env');
    writeFileSync(file, '# keys\nANTHROPIC_API_KEY=\nexport APIFY_TOKEN="from-file-0123456"\n');
    expect(readApifyToken({ APIFY_TOKEN: ' from-env-0123456 ' }, file)).toBe('from-env-0123456');
    expect(readApifyToken({}, file)).toBe('from-file-0123456');
    expect(readApifyToken({ APIFY_TOKEN: '' }, file)).toBe('from-file-0123456');
  });

  it('is null with none, an empty one or no file', () => {
    const file = join(dir, '.env');
    expect(readApifyToken({}, file)).toBeNull();
    writeFileSync(file, 'APIFY_TOKEN=\n');
    expect(readApifyToken({}, file)).toBeNull();
  });

  it('is taken out of every message once it has been read', () => {
    readApifyToken({ APIFY_TOKEN: 'secret-token-abcdef' }, join(dir, 'none'));
    expect(redact('failed with secret-token-abcdef in it')).toBe('failed with [key] in it');
    expect(new SongError('failed', 'bad secret-token-abcdef').message).toBe('bad [key]');
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [key]');
    expect(redact('https://x.test/y?token=abc123&b=1')).toBe('https://x.test/y?token=[key]&b=1');
    expect(redact('apify_api_ABCdef123')).toBe('apify_api_…');
  });
});

describe('the songs-cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'songs-cache-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (name: string, size: number, ageDays: number, now: number) => {
    const file = join(dir, name);
    writeFileSync(file, Buffer.alloc(size, 1));
    const time = new Date(now - ageDays * 86_400_000);
    utimesSync(file, time, time);
  };

  it('removes songs older than 14 days', () => {
    const now = Date.now();
    put('yt-old00000001.m4a', 10, 15, now);
    put('yt-new00000001.m4a', 10, 13, now);
    writeFileSync(join(dir, 'notes.txt'), 'not a song');
    expect(pruneSongsCache(dir, { now })).toEqual(['yt-old00000001.m4a']);
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'yt-new00000001.m4a']);
  });

  it('then removes the oldest until the folder is under the cap', () => {
    const now = Date.now();
    put('yt-a0000000001.m4a', 400, 5, now);
    put('yt-b0000000001.m4a', 400, 3, now);
    put('yt-c0000000001.m4a', 400, 1, now);
    expect(pruneSongsCache(dir, { now, maxBytes: 900 })).toEqual(['yt-a0000000001.m4a']);
    expect(readdirSync(dir).sort()).toEqual(['yt-b0000000001.m4a', 'yt-c0000000001.m4a']);
  });

  it('is fine with a folder that is not there', () => {
    expect(pruneSongsCache(join(dir, 'nope'))).toEqual([]);
  });
});

// --- getSong: what needs no tool -----------------------------------------------------------------

describe('getSong: asks that fail before any tool or network call', () => {
  const noNetwork = fakeFetch(() => undefined);
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'songs-pre-'));
    noNetwork.calls.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    workDir: join(dir, 'work'),
    tools: {
      ytDlp: join(dir, 'no-yt-dlp'),
      deno: join(dir, 'no-deno'),
      ffmpeg: null,
      ffprobe: null,
    },
    env: { PATH: '' },
    envFile: join(dir, 'no.env'),
    fetch: noNetwork.fetch,
  });

  it('a reel link without the Apify key is needs_key, and says where to put it', async () => {
    for (const link of [
      'https://www.instagram.com/reel/DX7lzTOJ1p6/',
      'https://vm.tiktok.com/ZSabc123/',
    ]) {
      const error = await failure(getSong({ ...base(), link }), 'needs_key');
      expect(error.message).toBe('Reel links need an Apify key: add APIFY_TOKEN to .env');
    }
    expect(noNetwork.calls).toEqual([]);
  });

  it('another site is not_found and names the site, with no network call', async () => {
    const error = await failure(
      getSong({ ...base(), link: 'https://soundcloud.com/a/b' }),
      'not_found',
    );
    expect(error.message).toContain('soundcloud.com');
    expect(noNetwork.calls).toEqual([]);
  });

  it('a thing that is not a link, or a link that is not one song, is not_found', async () => {
    await failure(getSong({ ...base(), link: 'two words' }), 'not_found');
    await failure(getSong({ ...base(), link: 'https://open.spotify.com/album/abc' }), 'not_found');
    await failure(
      getSong({ ...base(), link: 'https://www.youtube.com/playlist?list=PLabc' }),
      'not_found',
    );
    await failure(
      getSong({
        ...base(),
        link: 'https://www.instagram.com/someaccount/',
        env: { PATH: '', APIFY_TOKEN: TOKEN },
      }),
      'not_found',
    );
    await failure(getSong({ ...base() }), 'not_found');
    expect(noNetwork.calls).toEqual([]);
  });

  it('a missing yt-dlp or deno is tool_missing, and says what to install', async () => {
    const error = await failure(
      getSong({ ...base(), title: 'Blinding Lights', artist: 'The Weeknd' }),
      'tool_missing',
    );
    expect(error.message).toContain('brew install yt-dlp deno');
    expect(error.message).toContain('yt-dlp');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'yt-dlp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const noDeno = await failure(
      getSong({
        ...base(),
        tools: { ytDlp: join(bin, 'yt-dlp'), deno: join(bin, 'deno'), ffmpeg: null, ffprobe: null },
        title: 'Blinding Lights',
      }),
      'tool_missing',
    );
    expect(noDeno.message).toContain('deno');
    expect(noDeno.message).toContain('brew install yt-dlp deno');
    expect(noNetwork.calls).toEqual([]);
  });

  it('ffmpeg missing is tool_missing, and says brew install ffmpeg', async () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const name of ['yt-dlp', 'deno'])
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const error = await failure(
      getSong({
        ...base(),
        tools: {
          ytDlp: join(bin, 'yt-dlp'),
          deno: join(bin, 'deno'),
          ffmpeg: join(dir, 'no-ffmpeg'),
          ffprobe: null,
        },
        title: 'Blinding Lights',
      }),
      'tool_missing',
    );
    expect(error.message).toContain('brew install ffmpeg');
  });

  it('a stopped call stops before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await getSong({ ...base(), title: 'x', signal: controller.signal }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(SongError);
    expect(error.aborted).toBe(true);
  });
});

// --- getSong: end to end -------------------------------------------------------------------------

/** The first handler that has an answer. */
function either(...handlers: ((call: FetchCall) => Reply | undefined)[]) {
  return (call: FetchCall): Reply | undefined => {
    for (const handler of handlers) {
      const reply = handler(call);
      if (reply !== undefined) return reply;
    }
    return undefined;
  };
}

/** iTunes Search: the fixture for IL and for US (by name), `empty` when not named. */
const itunes =
  (il: string, us = 'empty') =>
  (call: FetchCall) => {
    if (!call.url.startsWith('https://itunes.apple.com/search')) return undefined;
    const country = new URL(call.url).searchParams.get('country');
    return json(fixture('itunes', country === 'IL' ? il : us));
  };

describe.skipIf(!haveTools)('getSong', () => {
  let bench: Bench;
  let media: string;
  let reelM4a: Uint8Array;
  let reelMp3: Uint8Array;

  beforeAll(() => {
    media = mkdtempSync(join(tmpdir(), 'songs-media-'));
    reelM4a = makeAudio(ffmpeg as string, join(media, 'reel.m4a'), 3);
    reelMp3 = makeAudio(ffmpeg as string, join(media, 'reel.mp3'), 3);
  });
  afterAll(() => rmSync(media, { recursive: true, force: true }));
  beforeEach(() => {
    bench = makeBench(ffmpeg as string, ffprobe as string);
  });
  afterEach(() => bench.dispose());

  const NATATI = { title: 'נתתי לך בית', artist: 'אופק אדנק' };
  const BLINDING = { title: 'Blinding Lights', artist: 'The Weeknd' };
  const downloads = () => bench.calls().filter((c) => c.kind === 'download' && c.phase === 'start');
  const searches = () => bench.calls().filter((c) => c.kind === 'search');
  const urlsOf = (calls: FetchCall[], prefix: string) =>
    calls.filter((c) => c.url.startsWith(prefix));

  describe('by name', () => {
    it('gets the Topic track of a Hebrew song, checked against iTunes IL, with exactly the planned calls', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 192 } },
      });
      const net = fakeFetch(itunes('natati-il'));
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI });

      expect(net.calls).toHaveLength(1);
      const call = new URL(net.calls[0]?.url ?? '');
      expect(`${call.origin}${call.pathname}`).toBe('https://itunes.apple.com/search');
      expect(Object.fromEntries(call.searchParams)).toEqual({
        term: 'אופק אדנק נתתי לך בית',
        entity: 'song',
        limit: '5',
        country: 'IL',
      });

      expect(searches().map((c) => c.args)).toEqual([
        [
          '--ignore-config',
          '--js-runtimes',
          `deno:${bench.tools.deno}`,
          '-J',
          '--flat-playlist',
          'ytsearch8:אופק אדנק נתתי לך בית',
        ],
      ]);
      expect(downloads().map((c) => c.args)).toEqual([
        [
          '--ignore-config',
          '--js-runtimes',
          `deno:${bench.tools.deno}`,
          '--no-playlist',
          '-f',
          'bestaudio',
          '-x',
          '--audio-format',
          'm4a',
          '--audio-quality',
          '0',
          '--max-filesize',
          '60M',
          '--socket-timeout',
          '30',
          '--retries',
          '3',
          '--match-filter',
          'duration < 900',
          '--ffmpeg-location',
          dirname(bench.tools.ffmpeg),
          '-o',
          `${bench.workDir}/song-full.%(ext)s`,
          '--print',
          'after_move:filepath',
          'https://www.youtube.com/watch?v=nat0Topic01',
        ],
      ]);

      expect(got.full).toBe(join(bench.workDir, 'song-full.m4a'));
      expect(got.reel).toBeNull();
      expect(got.meta).toMatchObject({
        ...NATATI,
        site: 'youtube-music',
        via: 'yt-dlp',
        url: 'https://www.youtube.com/watch?v=nat0Topic01',
        id: 'nat0Topic01',
      });
      expect(Math.abs(got.meta.fullMs - 192_000)).toBeLessThan(250);
      expect(Math.abs(lengthOf(bench.tools.ffprobe, got.full) - got.meta.fullMs)).toBeLessThan(5);
      expect(asSong(got).source).toEqual({
        site: 'youtube-music',
        via: 'yt-dlp',
        url: 'https://www.youtube.com/watch?v=nat0Topic01',
        id: 'nat0Topic01',
      });
      expect(readdirSync(bench.workDir)).toEqual(['song-full.m4a']);
    });

    it('a Latin song: IL has none, then US; the Topic track wins over the verified official audio', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch(itunes('empty', 'blinding-us'));
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
      expect(net.calls.map((c) => new URL(c.url).searchParams.get('country'))).toEqual([
        'IL',
        'US',
      ]);
      expect(downloads().map((c) => c.args?.at(-1))).toEqual([
        'https://www.youtube.com/watch?v=blnd0Topic1',
      ]);
      expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music', id: 'blnd0Topic1' });
      asSong(got);
    });

    it('a sped-up ask: searches "… sped up", wants a sped-up Topic track of 80 to 91% of the original', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights sped up': 'blinding-sped' },
        downloads: { blnd0SpedTop: { seconds: 168 } },
      });
      const net = fakeFetch(itunes('empty', 'blinding-us'));
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        ...BLINDING,
        version: 'sped up',
      });
      expect(searches().map((c) => c.query)).toEqual(['The Weeknd Blinding Lights sped up']);
      // The canonical length is the original's (iTunes was asked for the song, not the version).
      expect(new URL(net.calls[0]?.url ?? '').searchParams.get('term')).toBe(
        'The Weeknd Blinding Lights',
      );
      expect(got.meta.id).toBe('blnd0SpedTop');
      expect(got.meta.site).toBe('youtube-music');
      expect(got.meta.title).toBe('Blinding Lights');
    });

    it('no canonical length: iTunes has nothing, so the most viewed within 15 s is the reference', async () => {
      bench.set({
        searches: { 'Some Band Quiet Rooms': 'indie' },
        downloads: { ind0Topic01: { seconds: 185 } },
      });
      const net = fakeFetch(itunes('empty', 'empty'));
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        title: 'Quiet Rooms',
        artist: 'Some Band',
      });
      expect(net.calls).toHaveLength(2);
      expect(got.meta.id).toBe('ind0Topic01');
      expect(got.meta.artist).toBe('Some Band');
    });

    it('iTunes failing is not an error: the song is found without a canonical length', async () => {
      bench.set({
        searches: { 'Some Band Quiet Rooms': 'indie' },
        downloads: { ind0Topic01: { seconds: 185 } },
      });
      for (const reply of [new Error('network down'), json({}, 503), html('<html>nope</html>')]) {
        const net = fakeFetch(() => (reply instanceof Response ? reply.clone() : reply));
        const got = await getSong({
          ...bench.options({ fetch: net.fetch }),
          title: 'Quiet Rooms',
          artist: 'Some Band',
        });
        expect(got.meta.id).toBe('ind0Topic01');
      }
    });

    it('a Latin ask for a Hebrew song: the Hebrew spelling is searched too', async () => {
      bench.set({
        searches: {
          'Ofek Adanek Natati Lach Bait': 'natati-latin',
          'אופק אדנק נתתי לך בית': 'natati',
        },
        downloads: { nat0Topic01: { seconds: 192 } },
      });
      const net = fakeFetch(itunes('natati-hebrew-for-latin', 'empty'));
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        title: 'Natati Lach Bait',
        artist: 'Ofek Adanek',
      });
      expect(searches().map((c) => c.query)).toEqual([
        'Ofek Adanek Natati Lach Bait',
        'אופק אדנק נתתי לך בית',
      ]);
      expect(got.meta.id).toBe('nat0Topic01');
      // The song is called what it was asked for, not what iTunes calls it.
      expect(got.meta.title).toBe('Natati Lach Bait');
      expect(got.meta.artist).toBe('Ofek Adanek');
    });

    it('stops searching once the first search has a sure answer', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 192 } },
      });
      const net = fakeFetch(itunes('natati-il'));
      await getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI });
      expect(searches()).toHaveLength(1);
    });

    it('nothing left after the filters is not_found, and names the song and the site', async () => {
      bench.set({ searches: { 'אופק אדנק נתתי לך בית': 'natati-only-bad' } });
      const net = fakeFetch(itunes('natati-il'));
      const error = await failure(
        getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI }),
        'not_found',
      );
      expect(error.message).toContain('נתתי לך בית');
      expect(error.message).toContain('אופק אדנק');
      expect(error.message).toContain('YouTube Music');
      expect(downloads()).toEqual([]);
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it('a search with no results at all is not_found', async () => {
      bench.set({});
      const net = fakeFetch(itunes('empty', 'empty'));
      await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          title: 'Nothing Here',
          artist: 'Nobody',
        }),
        'not_found',
      );
    });

    describe('YouTube Music first', () => {
      const musicSearches = () => bench.calls().filter((c) => c.kind === 'music-search');
      const infos = () => bench.calls().filter((c) => c.kind === 'info');
      /** The yt-dlp calls in order (a download once, at its start). */
      const kinds = () =>
        bench
          .calls()
          .filter((c) => c.phase !== 'end')
          .map((c) => c.kind);
      const prefix = () => ['--ignore-config', '--js-runtimes', `deno:${bench.tools.deno}`];
      const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;
      const SNOWMAN = { title: 'Snowman', artist: 'Sia' };
      const QUIET = { title: 'Quiet Rooms', artist: 'Some Band' };

      it("Sia's Snowman: the song-type result of music.youtube.com wins, with one search and one info call, and no plain search", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'Sia Snowman': 'sia-snowman' },
          // The plain search would have given Sia's own upload (site "youtube").
          searches: { 'Sia Snowman': 'snowman' },
          downloads: { ZSRzCbpIxZo: { seconds: 166 } },
        });
        const net = fakeFetch(itunes('empty', 'snowman-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...SNOWMAN });

        expect(kinds()).toEqual(['music-search', 'info', 'download']);
        expect(musicSearches().map((c) => c.args)).toEqual([
          [...prefix(), '-J', '--flat-playlist', 'https://music.youtube.com/search?q=Sia+Snowman'],
        ]);
        expect(infos().map((c) => c.args)).toEqual([
          [...prefix(), '-J', '--no-playlist', watch('ZSRzCbpIxZo')],
        ]);
        expect(downloads().map((c) => c.args?.at(-1))).toEqual([watch('ZSRzCbpIxZo')]);
        expect(got.meta).toMatchObject({
          ...SNOWMAN,
          site: 'youtube-music',
          via: 'yt-dlp',
          url: watch('ZSRzCbpIxZo'),
          id: 'ZSRzCbpIxZo',
        });
        expect(Math.abs(got.meta.fullMs - 166_000)).toBeLessThan(250);
        expect(asSong(got).source.site).toBe('youtube-music');
        expect(readdirSync(bench.workDir)).toEqual(['song-full.m4a']);
      });

      it("a Hebrew song: the first result is Release - Topic's track, its artist reads 'אופק אדנק - Ofek Adanek', 183 s against iTunes' 183.4 s", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'אופק אדנק נתתי לך בית': 'natati' },
          searches: { 'אופק אדנק נתתי לך בית': 'natati' },
          downloads: { '0gQQE9pb-_8': { seconds: 183 } },
        });
        const net = fakeFetch(itunes('natati-il-183'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI });
        expect(kinds()).toEqual(['music-search', 'info', 'download']);
        expect(infos().map((c) => c.args?.at(-1))).toEqual([watch('0gQQE9pb-_8')]);
        expect(got.meta).toMatchObject({ ...NATATI, site: 'youtube-music', id: '0gQQE9pb-_8' });
        asSong(got);
      });

      it("The Weeknd's Blinding Lights: the first result is the song, 202 s against iTunes' 200.04 s", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights': 'blinding-lights' },
          downloads: { J7p4bzqLvCw: { seconds: 202 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
        expect(infos().map((c) => c.args?.at(-1))).toEqual([watch('J7p4bzqLvCw')]);
        expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music', id: 'J7p4bzqLvCw' });
      });

      it("passes over another artist's song and a music video's length, and takes the next that fits (the first three results are looked at, no more)", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights': 'blinding-others-first' },
          downloads: { blndMusGood: { seconds: 202 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
        expect(infos().map((c) => c.args?.at(-1))).toEqual([
          watch('blndMusCvr1'),
          watch('blndMusMv01'),
          watch('blndMusGood'),
        ]);
        expect(searches()).toEqual([]);
        expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music', id: 'blndMusGood' });
      });

      it('looks at no more than YT_MUSIC.maxInfoCalls results, then the plain search answers as it always did', async () => {
        expect(YT_MUSIC.maxInfoCalls).toBe(3);
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights': 'blinding-five-others' },
          searches: { 'The Weeknd Blinding Lights': 'blinding' },
          downloads: { blnd0Topic1: { seconds: 200 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
        expect(infos().map((c) => c.args?.at(-1))).toEqual([
          watch('blndOther001'),
          watch('blndOther002'),
          watch('blndOther003'),
        ]);
        expect(searches().map((c) => c.query)).toEqual(['The Weeknd Blinding Lights']);
        expect(got.meta.id).toBe('blnd0Topic1');
      });

      it("a lyric video, a live take, a sped-up upload or a 10-hour loop is still refused: by its title in the search (no info call), or by the title yt-dlp's info gives", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights': 'blinding-not-the-song' },
          searches: { 'The Weeknd Blinding Lights': 'blinding' },
          downloads: { blnd0Topic1: { seconds: 200 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
        // Four are named "Lyrics", "Live", "Sped Up" and "10 HOURS" in the search itself, so none of
        // them costs an info call; the other three look like the song until their info says what
        // they are (sped up, a lyric video, live).
        expect(infos().map((c) => c.args?.at(-1))).toEqual([
          watch('blndMusSpd2'),
          watch('blndMusLyr2'),
          watch('blndMusLive2'),
        ]);
        expect(searches()).toHaveLength(1);
        expect(downloads().map((c) => c.args?.at(-1))).toEqual([watch('blnd0Topic1')]);
        expect(got.meta.id).toBe('blnd0Topic1');
      });

      it('a search with only artists, albums and playlists has no info call and falls back', async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights': 'only-browse' },
          searches: { 'The Weeknd Blinding Lights': 'blinding' },
          downloads: { blnd0Topic1: { seconds: 200 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...BLINDING });
        expect(kinds()).toEqual(['music-search', 'search', 'download']);
        expect(got.meta.id).toBe('blnd0Topic1');
      });

      it.each([
        ['finds nothing', undefined],
        [
          'is refused by YouTube',
          { error: 'ERROR: [youtube] Your IP is likely being blocked by YouTube', exit: 1 },
        ],
        ['cannot be read', { error: 'ERROR: something strange happened', exit: 1 }],
      ] as const)(
        'when music.youtube.com %s, the plain YouTube search answers exactly as before',
        async (_name, rule) => {
          bench.set({
            infosFromFixtures: true,
            ...(rule === undefined ? {} : { musicSearches: { 'אופק אדנק נתתי לך בית': rule } }),
            searches: { 'אופק אדנק נתתי לך בית': 'natati' },
            downloads: { nat0Topic01: { seconds: 192 } },
          });
          const net = fakeFetch(itunes('natati-il'));
          const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI });
          expect(kinds()).toEqual(['music-search', 'search', 'download']);
          expect(searches().map((c) => c.args)).toEqual([
            [...prefix(), '-J', '--flat-playlist', 'ytsearch8:אופק אדנק נתתי לך בית'],
          ]);
          expect(got.meta).toMatchObject({ ...NATATI, site: 'youtube-music', id: 'nat0Topic01' });
        },
      );

      it("when music.youtube.com and the plain search both fail, it is the plain search's error that is thrown", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: {
            'אופק אדנק נתתי לך בית': {
              error: 'ERROR: [youtube] Your IP is likely being blocked by YouTube',
              exit: 1,
            },
          },
          searches: {
            'אופק אדנק נתתי לך בית': {
              error: 'ERROR: [youtube] No supported JavaScript runtime could be found',
              exit: 1,
            },
          },
        });
        const net = fakeFetch(itunes('natati-il'));
        const error = await failure(
          getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI }),
          'update_needed',
        );
        expect(error.message).toContain('נתתי לך בית');
        expect(downloads()).toEqual([]);
      });

      it("a result whose info yt-dlp cannot read (a closed video) ends the music search; the plain search gives Sia's own upload, as site youtube", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'Sia Snowman': 'sia-snowman' },
          infos: {
            ZSRzCbpIxZo: { error: 'ERROR: [youtube] ZSRzCbpIxZo: Private video', exit: 1 },
          },
          searches: { 'Sia Snowman': 'snowman' },
          downloads: { J_QGZspO4gg: { seconds: 168 } },
        });
        const net = fakeFetch(itunes('empty', 'snowman-us'));
        const got = await getSong({ ...bench.options({ fetch: net.fetch }), ...SNOWMAN });
        expect(kinds()).toEqual(['music-search', 'info', 'search', 'download']);
        expect(got.meta).toMatchObject({ ...SNOWMAN, site: 'youtube', id: 'J_QGZspO4gg' });
      });

      it('with no canonical length (iTunes has nothing) only the exact title is taken, and its artist must be the one asked for', async () => {
        const net = () => fakeFetch(itunes('empty', 'empty')).fetch;
        // "Quiet Rooms (Acoustic)" is not the song: the plain search runs.
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'Some Band Quiet Rooms': 'quiet-rooms-acoustic' },
          searches: { 'Some Band Quiet Rooms': 'indie' },
          downloads: { ind0Topic01: { seconds: 185 } },
        });
        const plain = await getSong({ ...bench.options({ fetch: net() }), ...QUIET });
        expect(kinds()).toEqual(['music-search', 'info', 'search', 'download']);
        expect(plain.meta.id).toBe('ind0Topic01');

        // "Quiet Rooms" itself is.
        bench.dispose();
        bench = makeBench(ffmpeg as string, ffprobe as string);
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'Some Band Quiet Rooms': 'quiet-rooms' },
          searches: { 'Some Band Quiet Rooms': 'indie' },
          downloads: { quietMusSong: { seconds: 185 } },
        });
        const music = await getSong({ ...bench.options({ fetch: net() }), ...QUIET });
        expect(kinds()).toEqual(['music-search', 'info', 'download']);
        expect(music.meta).toMatchObject({ ...QUIET, site: 'youtube-music', id: 'quietMusSong' });
      });

      it("a Latin ask for a Hebrew song: Apple's Hebrew spelling is searched on YouTube Music too, and its artist is read from the Hebrew name", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'אופק אדנק נתתי לך בית': 'natati' },
          searches: { 'אופק אדנק נתתי לך בית': 'natati' },
          downloads: { '0gQQE9pb-_8': { seconds: 183 } },
        });
        const net = fakeFetch(itunes('natati-hebrew-for-latin', 'empty'));
        const got = await getSong({
          ...bench.options({ fetch: net.fetch }),
          title: 'Natati Lach Bait',
          artist: 'Ofek Adanek',
        });
        expect(musicSearches().map((c) => c.query)).toEqual([
          'Ofek Adanek Natati Lach Bait',
          'אופק אדנק נתתי לך בית',
        ]);
        expect(searches()).toEqual([]);
        expect(got.meta).toMatchObject({
          title: 'Natati Lach Bait',
          artist: 'Ofek Adanek',
          site: 'youtube-music',
          id: '0gQQE9pb-_8',
        });
      });

      it("a sped-up, slowed or remix ask does not use YouTube Music's search (it has its own plain search)", async () => {
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'The Weeknd Blinding Lights sped up': 'blinding-lights' },
          searches: { 'The Weeknd Blinding Lights sped up': 'blinding-sped' },
          downloads: { blnd0SpedTop: { seconds: 168 } },
        });
        const net = fakeFetch(itunes('empty', 'blinding-us'));
        await getSong({
          ...bench.options({ fetch: net.fetch }),
          ...BLINDING,
          version: 'sped up',
        });
        expect(musicSearches()).toEqual([]);
        expect(kinds()).toEqual(['search', 'download']);
      });

      it('a stopped call is not mistaken for "nothing usable": it stops yt-dlp and does not go on to the plain search', async () => {
        const pids = join(bench.root, 'pids.json');
        bench.set({
          infosFromFixtures: true,
          musicSearches: { 'אופק אדנק נתתי לך בית': { hang: true, pids } },
          searches: { 'אופק אדנק נתתי לך בית': 'natati' },
          downloads: { nat0Topic01: { seconds: 192 } },
        });
        const controller = new AbortController();
        const promise = getSong({
          ...bench.options({
            fetch: fakeFetch(itunes('natati-il')).fetch,
            signal: controller.signal,
          }),
          ...NATATI,
        });
        const end = Date.now() + 6000;
        while (!existsSync(pids) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
        const { parent, child } = JSON.parse(readFileSync(pids, 'utf8')) as {
          parent: number;
          child: number;
        };
        controller.abort();
        const error = await promise.catch((e) => e);
        expect(error).toBeInstanceOf(SongError);
        expect(error.aborted).toBe(true);
        const gone = (pid: number) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        };
        while (!(gone(parent) && gone(child)) && Date.now() < end + 6000) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(gone(parent) && gone(child)).toBe(true);
        expect(kinds()).toEqual(['music-search']);
        expect(readdirSync(bench.workDir)).toEqual([]);
      });
    });

    it('the key and the Apify env never reach yt-dlp', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 5 } },
      });
      const net = fakeFetch(itunes('natati-il'));
      await getSong({ ...bench.options({ fetch: net.fetch }), ...NATATI });
      for (const call of bench.calls()) {
        expect(call.env).not.toContain('APIFY_TOKEN');
        expect(call.env).toContain('FAKE_YTDLP');
        expect(call.env).toContain('PATH');
      }
      expect(net.calls.every((c) => !c.headers.authorization)).toBe(true);
    });
  });

  describe('a YouTube link', () => {
    it('a YouTube Music link: the metadata (-J --no-playlist), then that video', async () => {
      bench.set({
        infos: { nat0Topic01: 'nat0Topic01' },
        downloads: { nat0Topic01: { seconds: 192 } },
      });
      const net = fakeFetch(() => undefined);
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://music.youtube.com/watch?v=nat0Topic01&si=abc',
      });
      expect(net.calls).toEqual([]);
      expect(bench.calls().find((c) => c.kind === 'info')?.args).toEqual([
        '--ignore-config',
        '--js-runtimes',
        `deno:${bench.tools.deno}`,
        '-J',
        '--no-playlist',
        'https://www.youtube.com/watch?v=nat0Topic01',
      ]);
      expect(got.meta).toMatchObject({
        title: 'נתתי לך בית',
        artist: 'אופק אדנק',
        site: 'youtube-music',
        via: 'yt-dlp',
        id: 'nat0Topic01',
        url: 'https://www.youtube.com/watch?v=nat0Topic01',
      });
      expect(Math.abs(got.meta.fullMs - 192_000)).toBeLessThan(250);
      asSong(got, 'link');
    });

    it('a plain YouTube video: the artist and title are read from "Artist - Title (Official Video)"', async () => {
      bench.set({
        infos: { quiet0Video: 'quiet0Video' },
        downloads: { quiet0Video: { seconds: 20 } },
      });
      const got = await getSong({ ...bench.options(), link: 'https://youtu.be/quiet0Video' });
      expect(got.meta).toMatchObject({
        title: 'Quiet Rooms',
        artist: 'Some Band',
        site: 'youtube',
        id: 'quiet0Video',
      });
    });

    it('a live stream is unavailable, a long mix is not_found, a closed video is unavailable', async () => {
      bench.set({ infos: { live0Stream1: 'live0Stream1', mix0Long001: 'mix0Long001' } });
      await failure(
        getSong({ ...bench.options(), link: 'https://youtu.be/live0Stream1' }),
        'unavailable',
      );
      const long = await failure(
        getSong({ ...bench.options(), link: 'https://youtu.be/mix0Long001' }),
        'not_found',
      );
      expect(long.message).toContain('15 minutes');
      const gone = await failure(
        getSong({ ...bench.options(), link: 'https://youtu.be/gone0Video1' }),
        'unavailable',
      );
      expect(gone.message).toContain('YouTube');
      expect(downloads()).toEqual([]);
    });
  });

  describe('a Spotify or Apple Music link', () => {
    it('Spotify: oEmbed gives the title, the page the artist, then it is found by name', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const link = 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc';
      const net = fakeFetch(
        either(itunes('empty', 'blinding-us'), (call) => {
          if (call.url.startsWith('https://open.spotify.com/oembed')) {
            expect(new URL(call.url).searchParams.get('url')).toBe(link);
            return json({ title: 'Blinding Lights', provider_name: 'Spotify', type: 'rich' });
          }
          if (call.url === link) {
            return html(
              '<html><head><meta property="og:title" content="Blinding Lights"/>' +
                '<meta property="og:description" content="The Weeknd · After Hours · Song · 2020"/></head></html>',
            );
          }
          return undefined;
        }),
      );
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), link });
      expect(got.meta).toMatchObject({
        ...BLINDING,
        site: 'youtube-music',
        via: 'yt-dlp',
        id: 'blnd0Topic1',
      });
      expect(new URL(net.calls[0]?.url ?? '').pathname).toBe('/oembed');
    });

    it('Spotify: the other form of the description, and a page that cannot be read', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const link = 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b';
      const page = (description: string) =>
        either(itunes('empty', 'blinding-us'), (call) => {
          if (call.url.startsWith('https://open.spotify.com/oembed'))
            return json({ title: 'Blinding Lights' });
          if (call.url === link) {
            return html(`<meta content="${description}" property="og:description">`);
          }
          return undefined;
        });
      const got = await getSong({
        ...bench.options({
          fetch: fakeFetch(page('Listen to Blinding Lights on Spotify. Song · The Weeknd · 2020'))
            .fetch,
        }),
        link,
      });
      expect(got.meta.artist).toBe('The Weeknd');
      const noPage = fakeFetch(
        either(itunes('empty', 'blinding-us'), (call) =>
          call.url.startsWith('https://open.spotify.com/oembed')
            ? json({ title: 'Blinding Lights' })
            : call.url === link
              ? json({}, 500)
              : undefined,
        ),
      );
      const bare = await getSong({ ...bench.options({ fetch: noPage.fetch }), link });
      expect(bare.meta.title).toBe('Blinding Lights');
      expect(bare.meta.id).toBe('blnd0Topic1');
    });

    it('Spotify with nothing readable is not_found', async () => {
      const net = fakeFetch(() => json({}, 404));
      await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
        }),
        'not_found',
      );
    });

    it('Apple Music: iTunes Lookup by the song id gives the name and the length, with no search', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch((call) =>
        call.url.startsWith('https://itunes.apple.com/lookup')
          ? json(fixture('itunes', 'lookup-blinding'))
          : undefined,
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://music.apple.com/us/album/blinding-lights/1499378081?i=1499378108',
      });
      expect(net.calls).toHaveLength(1);
      const lookup = new URL(net.calls[0]?.url ?? '');
      expect(lookup.pathname).toBe('/lookup');
      expect(Object.fromEntries(lookup.searchParams)).toEqual({ id: '1499378108', country: 'US' });
      expect(got.meta).toMatchObject({ ...BLINDING, id: 'blnd0Topic1' });
    });

    it('Apple Music with no such song is not_found', async () => {
      const net = fakeFetch(() => json({ resultCount: 0, results: [] }));
      await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://music.apple.com/us/song/x/1499378108',
        }),
        'not_found',
      );
    });
  });

  describe('an Instagram reel', () => {
    const REEL = 'https://www.instagram.com/reel/DX7lzTOJ1p6/?igsh=MWZvdnM5';
    const apifyReply = (name: string) => (call: FetchCall) =>
      call.url.startsWith(`${APIFY.base}/`) ? json(fixture('apify', name), 201) : undefined;
    const cdn = (call: FetchCall) =>
      call.url.startsWith('https://scontent-fra5-1.cdninstagram.com/')
        ? bytes(reelM4a, 'audio/mp4')
        : undefined;

    it('Apify reads the song, the reel audio is kept, the clean track is got by that name', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch(
        either(apifyReply('instagram-song'), cdn, itunes('empty', 'blinding-us')),
      );
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), link: REEL });

      const apify = urlsOf(net.calls, APIFY.base);
      expect(apify).toHaveLength(1);
      const call = apify[0] as FetchCall;
      const url = new URL(call.url);
      expect(call.method).toBe('POST');
      expect(url.origin + url.pathname).toBe(
        'https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        timeout: '90',
        maxTotalChargeUsd: '0.05',
        maxItems: '1',
        limit: '1',
        format: 'json',
        clean: '1',
      });
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(call.body ?? '')).toEqual({
        username: ['https://www.instagram.com/reel/DX7lzTOJ1p6/'],
        resultsLimit: 1,
      });

      // The reel's own audio came from its URL, with no key.
      const audio = net.calls.find((c) => c.url.includes('/audio.mp4'));
      expect(audio?.method).toBe('GET');
      expect(audio?.headers.authorization).toBeUndefined();

      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(got.full).toBe(join(bench.workDir, 'song-full.m4a'));
      expect(Math.abs(lengthOf(bench.tools.ffprobe, got.reel as string) - 3000)).toBeLessThan(250);
      expect(got.meta).toMatchObject({
        ...BLINDING,
        site: 'youtube-music',
        via: 'yt-dlp',
        id: 'blnd0Topic1',
      });
      asSong(got, 'link');
      expect(readdirSync(bench.workDir).sort()).toEqual(['song-full.m4a', 'song-reel.m4a']);
    });

    it("a reel's audio that does not download (its CDN host times out) does not stop the clean track by name", async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch(
        either(
          apifyReply('instagram-song'),
          (call) =>
            call.url.includes('cdninstagram.com')
              ? new Error('fetch failed (connect timeout)')
              : undefined,
          itunes('empty', 'blinding-us'),
        ),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DX7lzTOJ1p6/',
      });
      // No reel audio was kept, and the clean track is the song.
      expect(got.reel).toBeNull();
      expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music' });
      expect(readdirSync(bench.workDir)).toEqual(['song-full.m4a']);
    });

    it("a reel's audio that does not download and a clean track that is not found say why the audio failed", async () => {
      bench.set({
        searches: {
          'Nobody Known A Song Nobody Has Heard': {
            error: 'ERROR: No video results found',
            exit: 1,
          },
        },
      });
      const net = fakeFetch(
        either(
          apifyReply('instagram-unknown-song'),
          (call) =>
            call.url.includes('cdninstagram.com')
              ? new Error('fetch failed (connect timeout)')
              : undefined,
          itunes('empty', 'empty'),
        ),
      );
      const error = await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.instagram.com/reel/DY1abcDEF23/',
        }),
        'unavailable',
      );
      expect(error.message).toContain('did not download');
    });

    it('when the clean track cannot be found, the reel audio is the song', async () => {
      bench.set({});
      const link = 'https://www.instagram.com/reel/DY1abcDEF23/';
      const net = fakeFetch(
        either(apifyReply('instagram-unknown-song'), cdn, itunes('empty', 'empty')),
      );
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), link });
      expect(got.full).toBe(got.reel);
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(got.meta).toMatchObject({
        title: 'A Song Nobody Has Heard',
        artist: 'Nobody Known',
        site: 'instagram',
        via: 'apify',
        url: link,
        id: 'DY1abcDEF23',
      });
      expect(Math.abs(got.meta.fullMs - 3000)).toBeLessThan(250);
      expect(SONG_SITES).toContain(got.meta.site);
      expect(SONG_VIAS).toContain(got.meta.via);
      asSong(got, 'link');
      expect(readdirSync(bench.workDir)).toEqual(['song-reel.m4a']);
    });

    it('"Original audio" has no song to look up: original_audio, and nothing else is fetched', async () => {
      const net = fakeFetch(apifyReply('instagram-original'));
      const error = await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.instagram.com/reel/DZ9originAL1/',
        }),
        'original_audio',
      );
      expect(error.message).toContain('Original audio');
      expect(error.message).toContain('someaccount');
      expect(error.message).toContain('Instagram');
      expect(net.calls).toHaveLength(1);
      expect(bench.calls()).toEqual([]);
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it('Instagram\'s Hebrew "original audio" is the same', async () => {
      const net = fakeFetch(apifyReply('instagram-hebrew-original'));
      await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.instagram.com/reel/DZ9hebrewOR1/',
        }),
        'original_audio',
      );
    });

    it('a song uploaded as a sound (the flag says original, the author is another account) is looked up by its name', async () => {
      // "Somewhere only we know - Keane" by sofia.peters on a reel of zianlutfiana (SG13, C74): the
      // artist field is the uploader and the title carries the song and its artist (C76), so the
      // lookup is "Keane Somewhere only we know", never "sofia.peters Somewhere only we know - Keane".
      bench.set({});
      const net = fakeFetch(
        either(apifyReply('instagram-song-as-sound'), cdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DKeaneSound1/',
      });
      // It was looked up (not refused as "Original audio") ...
      expect(searches().map((c) => c.query)).toEqual(['Keane Somewhere only we know']);
      expect(bench.calls().every((c) => !(c.query ?? '').includes('sofia.peters'))).toBe(true);
      // ... and, not found, the sound's own audio is the song, under the song's own name.
      expect(got.full).toBe(got.reel);
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(got.meta).toMatchObject({
        title: 'Somewhere only we know',
        artist: 'Keane',
        site: 'instagram',
        via: 'apify',
        id: 'DKeaneSound1',
      });
      asSong(got, 'link');
      expect(readdirSync(bench.workDir)).toEqual(['song-reel.m4a']);
    });

    it("a song uploaded as a sound is found as the artist's own track: iTunes, YouTube Music and the search all get the split name", async () => {
      bench.set({
        searches: { 'Keane Somewhere only we know': 'keane' },
        downloads: { kean0Topic1: { seconds: 239 } },
      });
      const net = fakeFetch(
        either(apifyReply('instagram-song-as-sound'), cdn, itunes('empty', 'keane-us')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DKeaneSound1/',
      });
      // Apple's canonical length (238.787 s) was looked up for the split name.
      expect(urlsOf(net.calls, 'https://itunes.apple.com/search').length).toBeGreaterThan(0);
      for (const call of urlsOf(net.calls, 'https://itunes.apple.com/search')) {
        expect(new URL(call.url).searchParams.get('term')).toBe('Keane Somewhere only we know');
      }
      expect(
        bench
          .calls()
          .filter((c) => c.kind === 'music-search')
          .map((c) => c.query),
      ).toEqual(['Keane Somewhere only we know']);
      expect(searches().map((c) => c.query)).toEqual(['Keane Somewhere only we know']);
      // The Topic track within 5 s of Apple's length is the song, not the uploader's cover.
      expect(downloads().map((c) => c.id)).toEqual(['kean0Topic1']);
      expect(got.meta).toMatchObject({
        title: 'Somewhere only we know',
        artist: 'Keane',
        site: 'youtube-music',
        via: 'yt-dlp',
        id: 'kean0Topic1',
      });
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(Math.abs(got.meta.fullMs - 239_000)).toBeLessThan(250);
      asSong(got, 'link');
    });

    it('a real artist\'s sound with a version in its title keeps its name: "Blinding Lights - Remix" by The Weeknd is not split', async () => {
      bench.set({});
      const net = fakeFetch(
        either(apifyReply('instagram-song-with-version'), cdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DRemixSound1/',
      });
      expect(searches().map((c) => c.query)).toEqual(['The Weeknd Blinding Lights - Remix']);
      expect(got.meta).toMatchObject({ title: 'Blinding Lights - Remix', artist: 'The Weeknd' });
    });

    it("a creator's own named sound (the flag, and the author is the account) has no song to look up", async () => {
      const net = fakeFetch(apifyReply('instagram-own-named-sound'));
      const error = await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.instagram.com/reel/DOwnNamed01/',
        }),
        'original_audio',
      );
      expect(error.message).toContain('Mibellyuseche');
      expect(net.calls).toHaveLength(1);
      expect(bench.calls()).toEqual([]);
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it("a sound that is the creator's own, with a name from the caller: the name is looked up, no reel audio is kept", async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch(
        either(apifyReply('instagram-original'), cdn, itunes('empty', 'blinding-us')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: REEL,
        ...BLINDING,
      });
      expect(got.reel).toBeNull();
      expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music', id: 'blnd0Topic1' });
      expect(net.calls.some((c) => c.url.includes('cdninstagram'))).toBe(false);
    });

    it('a search with no results (yt-dlp says so) also falls back to the reel audio', async () => {
      bench.set({
        searches: {
          'Nobody Known A Song Nobody Has Heard': {
            error: 'ERROR: No video results found',
            exit: 1,
          },
        },
      });
      const net = fakeFetch(
        either(apifyReply('instagram-unknown-song'), cdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DY1abcDEF23/',
      });
      expect(got.full).toBe(got.reel);
      expect(got.meta.site).toBe('instagram');
    });

    it('a yt-dlp that is too old is not hidden by the fallback', async () => {
      bench.set({
        searches: {
          'Nobody Known A Song Nobody Has Heard': {
            error: 'ERROR: n challenge solving failed',
            exit: 1,
          },
        },
      });
      const net = fakeFetch(
        either(apifyReply('instagram-unknown-song'), cdn, itunes('empty', 'empty')),
      );
      await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.instagram.com/reel/DY1abcDEF23/',
        }),
        'update_needed',
      );
    });

    it('a reel Apify found nothing at is unavailable', async () => {
      for (const name of ['empty', 'instagram-error']) {
        const net = fakeFetch(apifyReply(name));
        const error = await failure(
          getSong({ ...bench.options({ fetch: net.fetch }), link: REEL }),
          'unavailable',
        );
        expect(error.message).toContain('Instagram');
      }
    });

    it('a reel audio url that fails is unavailable and keeps nothing', async () => {
      const net = fakeFetch(
        either(apifyReply('instagram-song'), (call) =>
          call.url.includes('cdninstagram') ? json({}, 403) : undefined,
        ),
      );
      await failure(getSong({ ...bench.options({ fetch: net.fetch }), link: REEL }), 'unavailable');
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it('an audio that is too big is not downloaded', async () => {
      const net = fakeFetch(
        either(apifyReply('instagram-song'), (call) =>
          call.url.includes('cdninstagram')
            ? new Response('x', {
                headers: {
                  'content-length': String(61 * 1024 * 1024),
                  'content-type': 'audio/mp4',
                },
              })
            : undefined,
        ),
      );
      await failure(getSong({ ...bench.options({ fetch: net.fetch }), link: REEL }), 'failed');
    });

    it('the key comes from the .env file when the environment has none', async () => {
      bench.set({});
      const envFile = join(bench.root, 'repo.env');
      writeFileSync(envFile, 'APIFY_TOKEN=file-token-0123456789\n');
      const net = fakeFetch(either(apifyReply('instagram-original'), cdn));
      const options = bench.options({ fetch: net.fetch, envFile });
      options.env = { PATH: process.env.PATH ?? '' };
      await failure(getSong({ ...options, link: REEL }), 'original_audio');
      expect(net.calls[0]?.headers.authorization).toBe('Bearer file-token-0123456789');
      expect(net.calls[0]?.url).not.toContain('file-token');
    });
  });

  describe('a TikTok video', () => {
    it("Apify's TikTok actor reads the music; the mp3 is kept as m4a; then the clean track", async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const link =
        'https://www.tiktok.com/@dancer/video/7333300000000000001?is_from_webapp=1&sender_device=pc';
      const net = fakeFetch(
        either(
          (call) =>
            call.url.startsWith(`${APIFY.base}/`)
              ? json(fixture('apify', 'tiktok-song'), 201)
              : undefined,
          (call) => (call.url.includes('tiktokcdn.com') ? bytes(reelMp3, 'audio/mpeg') : undefined),
          itunes('empty', 'blinding-us'),
        ),
      );
      const got = await getSong({ ...bench.options({ fetch: net.fetch }), link });
      const apify = urlsOf(net.calls, APIFY.base)[0] as FetchCall;
      expect(new URL(apify.url).pathname).toBe(
        '/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items',
      );
      expect(apify.headers.authorization).toBe(`Bearer ${TOKEN}`);
      // The TikTok actor refuses a cap under $0.50 (a real run answered 400, SG13), so its cap is
      // that minimum; one post is still one result (about $0.005 at the free tier).
      const params = new URL(apify.url).searchParams;
      expect(params.get('maxTotalChargeUsd')).toBe(String(APIFY.tiktokMaxChargeUsd));
      expect(APIFY.tiktokMaxChargeUsd).toBeGreaterThanOrEqual(0.5);
      expect(params.get('maxItems')).toBe('1');
      expect(JSON.parse(apify.body ?? '')).toMatchObject({
        postURLs: ['https://www.tiktok.com/@dancer/video/7333300000000000001'],
        shouldDownloadVideos: false,
      });
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(Math.abs(lengthOf(bench.tools.ffprobe, got.reel as string) - 3000)).toBeLessThan(300);
      expect(got.meta).toMatchObject({ ...BLINDING, site: 'youtube-music' });
      expect(readdirSync(bench.workDir).sort()).toEqual(['song-full.m4a', 'song-reel.m4a']);
    });

    it('a TikTok that is not found by name falls back to the sound itself, as tiktok', async () => {
      bench.set({});
      const net = fakeFetch(
        either(
          (call) =>
            call.url.startsWith(`${APIFY.base}/`)
              ? json(fixture('apify', 'tiktok-song'), 201)
              : undefined,
          (call) => (call.url.includes('tiktokcdn.com') ? bytes(reelMp3, 'audio/mpeg') : undefined),
          itunes('empty', 'empty'),
        ),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.tiktok.com/@dancer/video/7333300000000000001',
      });
      expect(got.full).toBe(got.reel);
      expect(got.meta).toMatchObject({ site: 'tiktok', via: 'apify', id: '7333300000000000001' });
      asSong(got, 'link');
    });

    const tiktok = (name: string) => (call: FetchCall) =>
      call.url.startsWith(`${APIFY.base}/`) ? json(fixture('apify', name), 201) : undefined;
    const tiktokCdn = (call: FetchCall) =>
      call.url.includes('tiktokcdn.com') ? bytes(reelMp3, 'audio/mpeg') : undefined;

    it('a song uploaded as a sound (КРУЖИТЬ by Dmytro Monatik, flag "original", on the video of @nrkdnk) is looked up by its name', async () => {
      bench.set({
        searches: { 'Dmytro Monatik КРУЖИТЬ': 'kruzhit' },
        downloads: { kruzh0Topic1: { seconds: 187 } },
      });
      const net = fakeFetch(
        either(tiktok('tiktok-song-as-sound'), tiktokCdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.tiktok.com/@nrkdnk/video/7700258159444643092',
      });
      expect(got.meta).toMatchObject({
        title: 'КРУЖИТЬ',
        artist: 'Dmytro Monatik',
        site: 'youtube-music',
        via: 'yt-dlp',
        id: 'kruzh0Topic1',
      });
      expect(got.full).toBe(join(bench.workDir, 'song-full.m4a'));
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(Math.abs(got.meta.fullMs - 187_000)).toBeLessThan(1500);
      asSong(got, 'link');
      expect(readdirSync(bench.workDir).sort()).toEqual(['song-full.m4a', 'song-reel.m4a']);
    });

    it('a TikTok song uploaded as a sound called "Song - Artist" is looked up by the song and its real artist', async () => {
      bench.set({});
      const net = fakeFetch(
        either(tiktok('tiktok-song-as-sound-dash'), tiktokCdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.tiktok.com/@nrkdnk/video/7700258159444643999',
      });
      expect(searches().map((c) => c.query)).toEqual(['Keane Somewhere only we know']);
      expect(got.meta).toMatchObject({
        title: 'Somewhere only we know',
        artist: 'Keane',
        site: 'tiktok',
        via: 'apify',
      });
    });

    it('a song uploaded as a sound that is not found by name falls back to the sound itself', async () => {
      bench.set({});
      const net = fakeFetch(
        either(tiktok('tiktok-song-as-sound'), tiktokCdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.tiktok.com/@nrkdnk/video/7700258159444643092',
      });
      expect(searches().map((c) => c.query)).toEqual(['Dmytro Monatik КРУЖИТЬ']);
      expect(got.full).toBe(got.reel);
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      expect(got.meta).toMatchObject({
        title: 'КРУЖИТЬ',
        artist: 'Dmytro Monatik',
        site: 'tiktok',
        via: 'apify',
        id: '7700258159444643092',
      });
      asSong(got, 'link');
      expect(readdirSync(bench.workDir)).toEqual(['song-reel.m4a']);
    });

    it('a named sound that is not flagged (Car Music 37 by Fabrício Cesar) still works: found on YouTube, 150 s, the sound kept', async () => {
      bench.set({
        searches: { 'Fabrício Cesar Car Music 37': 'car-music-37' },
        downloads: { carm0Music37: { seconds: 150 } },
      });
      const net = fakeFetch(
        either(tiktok('tiktok-car-music'), tiktokCdn, itunes('empty', 'empty')),
      );
      const got = await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.tiktok.com/@mgdtop/video/7699877818225757454',
      });
      expect(got.meta).toMatchObject({
        title: 'Car Music 37',
        artist: 'Fabrício Cesar',
        site: 'youtube',
        via: 'yt-dlp',
        id: 'carm0Music37',
      });
      expect(Math.abs(got.meta.fullMs - 150_000)).toBeLessThan(1500);
      expect(got.reel).toBe(join(bench.workDir, 'song-reel.m4a'));
      asSong(got, 'link');
      expect(readdirSync(bench.workDir).sort()).toEqual(['song-full.m4a', 'song-reel.m4a']);
    });

    it("a creator's own named sound (the flag, and the author is the account's nickname) has no song to look up", async () => {
      const net = fakeFetch(tiktok('tiktok-own-named-sound'));
      const error = await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.tiktok.com/@dancer/video/7333300000000000003',
        }),
        'original_audio',
      );
      expect(error.message).toContain('my beat');
      expect(net.calls).toHaveLength(1);
      expect(bench.calls()).toEqual([]);
    });

    it('"original sound" is original_audio', async () => {
      const net = fakeFetch((call) =>
        call.url.startsWith(`${APIFY.base}/`)
          ? json(fixture('apify', 'tiktok-original'), 201)
          : undefined,
      );
      const error = await failure(
        getSong({
          ...bench.options({ fetch: net.fetch }),
          link: 'https://www.tiktok.com/@dancer/video/7333300000000000002',
        }),
        'original_audio',
      );
      expect(error.message).toContain('TikTok');
    });
  });

  describe('when Apify fails', () => {
    const link = 'https://www.instagram.com/reel/DX7lzTOJ1p6/';
    const original = () => json(fixture('apify', 'instagram-original'), 201);

    /** Answers the Apify calls with `replies` in turn. */
    function turns(...replies: Reply[]) {
      let n = 0;
      return fakeFetch((call) => {
        if (!call.url.startsWith(`${APIFY.base}/`)) return undefined;
        const reply = replies[Math.min(n++, replies.length - 1)];
        return reply instanceof Response ? reply.clone() : reply;
      });
    }

    it('a 5xx once is tried again, and the second answer is used', async () => {
      const net = turns(json({ error: 'boom' }, 502), original());
      await failure(getSong({ ...bench.options({ fetch: net.fetch }), link }), 'original_audio');
      expect(net.calls).toHaveLength(2);
    });

    it.each([500, 503, 408, 429])(
      'a %i twice is blocked, with a plain sentence',
      async (status) => {
        const net = turns(json({ error: 'busy' }, status));
        const error = await failure(
          getSong({ ...bench.options({ fetch: net.fetch }), link }),
          'blocked',
        );
        expect(net.calls).toHaveLength(2);
        expect(error.message).toContain('Apify');
        expect(error.message).toContain('Instagram');
      },
    );

    it('no answer (a timeout, a network error) is tried again, then blocked', async () => {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const net = turns(timeout);
      await failure(getSong({ ...bench.options({ fetch: net.fetch }), link }), 'blocked');
      expect(net.calls).toHaveLength(2);
      const net2 = turns(new TypeError('fetch failed'), original());
      await failure(getSong({ ...bench.options({ fetch: net2.fetch }), link }), 'original_audio');
      expect(net2.calls).toHaveLength(2);
    });

    it('a refused key or no credit is needs_key and is not tried again', async () => {
      for (const status of [401, 403, 402]) {
        const net = turns(json({ error: { message: `no ${TOKEN}` } }, status));
        const error = await failure(
          getSong({ ...bench.options({ fetch: net.fetch }), link }),
          'needs_key',
        );
        expect(net.calls).toHaveLength(1);
        expect(error.message).toContain('Apify');
      }
    });

    it('a bad request or an answer that is not a list is failed', async () => {
      await failure(
        getSong({ ...bench.options({ fetch: turns(json({}, 400)).fetch }), link }),
        'failed',
      );
      await failure(
        getSong({ ...bench.options({ fetch: turns(json({ not: 'a list' }, 201)).fetch }), link }),
        'failed',
      );
      await failure(
        getSong({ ...bench.options({ fetch: turns(html('<html>', 201)).fetch }), link }),
        'failed',
      );
    });

    it('the key is only ever in the Authorization header of an Apify call', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 200 } },
      });
      const net = fakeFetch(
        either(
          (call) =>
            call.url.startsWith(`${APIFY.base}/`)
              ? json(fixture('apify', 'instagram-song'), 201)
              : undefined,
          (call) => (call.url.includes('cdninstagram') ? bytes(reelM4a, 'audio/mp4') : undefined),
          itunes('empty', 'blinding-us'),
        ),
      );
      await getSong({ ...bench.options({ fetch: net.fetch }), link });
      expect(net.calls.length).toBeGreaterThan(3);
      for (const call of net.calls) {
        expect(call.url).not.toContain(TOKEN);
        expect(call.body ?? '').not.toContain(TOKEN);
        const apify = call.url.startsWith(`${APIFY.base}/`);
        expect(call.headers.authorization).toBe(apify ? `Bearer ${TOKEN}` : undefined);
      }
      for (const call of bench.calls()) {
        expect(call.args ?? []).not.toContain(TOKEN);
        expect(JSON.stringify(call)).not.toContain(TOKEN);
        expect(call.env).not.toContain('APIFY_TOKEN');
      }
    });
  });

  describe('when yt-dlp fails', () => {
    const stage = (
      rule: { error: string; exit?: number },
      where: 'search' | 'download' | 'info',
    ) => {
      if (where === 'search') {
        bench.set({ searches: { 'אופק אדנק נתתי לך בית': rule } });
      } else {
        bench.set({
          searches: { 'אופק אדנק נתתי לך בית': 'natati' },
          downloads: { nat0Topic01: rule },
        });
      }
    };
    const run = () =>
      getSong({ ...bench.options({ fetch: fakeFetch(itunes('natati-il')).fetch }), ...NATATI });

    it.each([
      [
        'update_needed',
        'WARNING: [youtube] nat0Topic01: n challenge solving failed\nERROR: [youtube] nat0Topic01: Requested format is not available',
        'download',
      ],
      [
        'update_needed',
        'ERROR: [youtube] nat0Topic01: No supported JavaScript runtime could be found',
        'search',
      ],
      ['blocked', "ERROR: [youtube] nat0Topic01: Sign in to confirm you're not a bot", 'download'],
      ['blocked', 'ERROR: [youtube] Your IP is likely being blocked by YouTube', 'search'],
      [
        'blocked',
        'ERROR: unable to download video data: HTTP Error 429: Too Many Requests',
        'download',
      ],
      // What yt-dlp really printed on 26 Oct (C81): the API page answered 429. It is a refusal for
      // now ("blocked"), not YouTube being out of reach ("unavailable", check the internet).
      [
        'blocked',
        'ERROR: [youtube] nat0Topic01: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)',
        'search',
      ],
      [
        'blocked',
        'ERROR: [youtube] nat0Topic01: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)',
        'download',
      ],
      ['unavailable', 'ERROR: [youtube] nat0Topic01: Video unavailable', 'download'],
      ['unavailable', 'ERROR: [youtube] nat0Topic01: Private video', 'download'],
      [
        'unavailable',
        'ERROR: [youtube] nat0Topic01: The uploader has not made this video available in your country',
        'download',
      ],
      ['unavailable', 'ERROR: [youtube] nat0Topic01: Sign in to confirm your age', 'download'],
      ['failed', 'ERROR: something strange happened', 'download'],
    ] as const)('%s: %s (%s)', async (code, error, where) => {
      stage({ error, exit: 1 }, where);
      const failed = await failure(run(), code);
      expect(failed.message).toContain('נתתי לך בית');
      expect(failed.message).toContain('YouTube');
      expect(failed.message).not.toMatch(/https?:\/\//);
      expect(SONG_FAILURE_CODES).toContain(failed.code);
      // Nothing half-downloaded is left behind.
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it('a failed call does not leave partial files, and the last thing yt-dlp said is in a "failed" sentence', async () => {
      stage({ error: 'ERROR: something strange happened', exit: 1 }, 'download');
      const failed = await failure(run(), 'failed');
      expect(failed.message).toContain('something strange happened');
    });

    it('a download that yt-dlp skipped (too long) is not_found', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: {
          nat0Topic01: {
            silent: '[download] nat0Topic01 does not pass filter (duration < 900), skipping ..',
          },
        },
      });
      const error = await failure(run(), 'not_found');
      expect(error.message).toContain('15 minutes');
    });

    it('a download that printed no file is failed', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { silent: '/nowhere/song-full.m4a' } },
      });
      await failure(run(), 'failed');
    });
  });

  describe('stopping, time and order', () => {
    const waitFor = async (check: () => boolean, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timed out waiting');
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const hang = () => {
      const pids = join(bench.root, 'pids.json');
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { hang: true, pids } },
      });
      return pids;
    };
    const net = () => fakeFetch(itunes('natati-il')).fetch;

    it('the signal stops yt-dlp and everything it started', async () => {
      const pids = hang();
      const controller = new AbortController();
      const promise = getSong({
        ...bench.options({ fetch: net(), signal: controller.signal }),
        ...NATATI,
      });
      await waitFor(() => existsSync(pids));
      const { parent, child } = JSON.parse(readFileSync(pids, 'utf8')) as {
        parent: number;
        child: number;
      };
      expect(alive(parent) && alive(child)).toBe(true);
      controller.abort();
      const error = await promise.catch((e) => e);
      expect(error).toBeInstanceOf(SongError);
      expect(error.aborted).toBe(true);
      await waitFor(() => !alive(parent) && !alive(child));
      expect(readdirSync(bench.workDir)).toEqual([]);
    });

    it('a download that takes too long is stopped and is unavailable', async () => {
      const pids = hang();
      const started = Date.now();
      const error = await failure(
        getSong({ ...bench.options({ fetch: net(), timeouts: { download: 400 } }), ...NATATI }),
        'unavailable',
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(error.message).toContain('YouTube Music did not answer in time');
      const { parent, child } = JSON.parse(readFileSync(pids, 'utf8')) as {
        parent: number;
        child: number;
      };
      await waitFor(() => !alive(parent) && !alive(child));
    });

    it('one call at a time per work folder', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 5, delayMs: 300 } },
      });
      const options = bench.options({ fetch: net() });
      await Promise.all([getSong({ ...options, ...NATATI }), getSong({ ...options, ...NATATI })]);
      expect(
        bench
          .calls()
          .filter((c) => c.kind === 'download')
          .map((c) => c.phase),
      ).toEqual(['start', 'end', 'start', 'end']);
    });
  });

  describe('the songs-cache', () => {
    it('keeps a download and reuses it, but not past 14 days', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 6 } },
      });
      const cacheDir = join(bench.root, 'songs-cache');
      const fetchFn = fakeFetch(itunes('natati-il')).fetch;
      const first = await getSong({ ...bench.options({ fetch: fetchFn, cacheDir }), ...NATATI });
      expect(readdirSync(cacheDir)).toEqual(['yt-nat0Topic01.m4a']);
      expect(downloads()).toHaveLength(1);

      const other = join(bench.root, 'job2', 'edit', 'music');
      const second = await getSong({
        ...bench.options({ fetch: fetchFn, cacheDir, workDir: other }),
        ...NATATI,
      });
      expect(downloads()).toHaveLength(1);
      expect(second.full).toBe(join(other, 'song-full.m4a'));
      expect(statSync(second.full).size).toBe(statSync(first.full).size);
      expect(second.meta).toEqual(first.meta);

      const later = Date.now() + 15 * 86_400_000;
      await getSong({
        ...bench.options({ fetch: fetchFn, cacheDir, now: () => later }),
        ...NATATI,
      });
      expect(downloads()).toHaveLength(2);
    });

    it('a 429 is not kept as a not-found: nothing goes into the cache, and the same ask gets the song once YouTube answers (C81)', async () => {
      const cacheDir = join(bench.root, 'songs-cache');
      const fetchFn = fakeFetch(itunes('natati-il')).fetch;
      const ask = () => getSong({ ...bench.options({ fetch: fetchFn, cacheDir }), ...NATATI });
      const tooMany =
        'ERROR: [youtube] nat0Topic01: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)';

      // The download is refused: blocked, with the words to try again, and nothing is written.
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { error: tooMany, exit: 1 } },
      });
      const refused = await failure(ask(), 'blocked');
      expect(refused.message).toContain('Try again in a while');
      expect(refused.message.toLowerCase()).not.toContain('internet');
      expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
      expect(readdirSync(bench.workDir)).toEqual([]);

      // The search is refused (YouTube Music's and the plain one): blocked too, still nothing kept.
      bench.set({ searches: { 'אופק אדנק נתתי לך בית': { error: tooMany, exit: 1 } } });
      await failure(ask(), 'blocked');
      expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);

      // YouTube answers again: the very same ask is asked again and gets the song, which is kept.
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 6 } },
      });
      const got = await ask();
      expect(got.meta.id).toBe('nat0Topic01');
      expect(readdirSync(cacheDir)).toEqual(['yt-nat0Topic01.m4a']);
    });

    it('is not touched when no cache folder is given', async () => {
      bench.set({
        searches: { 'אופק אדנק נתתי לך בית': 'natati' },
        downloads: { nat0Topic01: { seconds: 6 } },
      });
      await getSong({
        ...bench.options({ fetch: fakeFetch(itunes('natati-il')).fetch }),
        ...NATATI,
      });
      expect(existsSync(join(bench.root, 'songs-cache'))).toBe(false);
    });
  });

  describe('what it writes', () => {
    it('only inside the work folder', async () => {
      bench.set({
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 6 } },
      });
      const before = readdirSync(bench.root);
      const net = fakeFetch(
        either(
          (call) =>
            call.url.startsWith(`${APIFY.base}/`)
              ? json(fixture('apify', 'instagram-song'), 201)
              : undefined,
          (call) => (call.url.includes('cdninstagram') ? bytes(reelM4a, 'audio/mp4') : undefined),
          itunes('empty', 'blinding-us'),
        ),
      );
      await getSong({
        ...bench.options({ fetch: net.fetch }),
        link: 'https://www.instagram.com/reel/DX7lzTOJ1p6/',
      });
      const added = readdirSync(bench.root).filter((name) => !before.includes(name));
      expect(added.sort()).toEqual(['audio', 'job']);
      expect(readdirSync(join(bench.root, 'job'))).toEqual(['edit']);
      expect(readdirSync(join(bench.root, 'job', 'edit'))).toEqual(['music']);
      expect(readdirSync(bench.workDir).sort()).toEqual(['song-full.m4a', 'song-reel.m4a']);
    });
  });
});

describe('the contract', () => {
  it('every code the getter threw above is one of SONG_FAILURE_CODES', () => {
    expect(seenCodes.size).toBeGreaterThan(0);
    for (const code of seenCodes) expect(SONG_FAILURE_CODES).toContain(code);
  });

  it('knows no code the contract does not (and never throws no_trending)', () => {
    const own = [
      'not_found',
      'unavailable',
      'blocked',
      'update_needed',
      'tool_missing',
      'needs_key',
      'original_audio',
      'failed',
    ];
    for (const code of own) expect(SONG_FAILURE_CODES).toContain(code);
  });
});
