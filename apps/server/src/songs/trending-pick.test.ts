import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  songTrendingEventSchema,
  songTrendingSchema,
  TRENDING_CACHE,
  trendingCacheFile,
  trendingCacheSchema,
} from '@studio/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  APIFY,
  type GetSongOptions,
  type GotSong,
  SongError,
} from '../../assets/music/get-song.mjs';
import {
  ACTORS,
  addInstagramNumbers,
  estimateCost,
  measureFit,
  type PickTrendingOptions,
  parseNiche,
  pickTrending,
  rankSounds,
  readReel,
  readTrendingCache,
  recentReels,
  soundsOfReels,
  TRENDING,
  tempoFits,
  trendingCachePath,
} from '../../assets/music/trending-pick.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import {
  type FetchCall,
  fakeFetch,
  fixture,
  json,
  makeBench,
  type Reply,
  TOKEN,
} from './test-utils.js';

// The trending pick (assets/music/trending-pick.mjs): the niche, the reels and sounds it reads, the
// ranking by Instagram's own signals, the fit check on audio made here, the 7-day cache and every
// way it fails, against a fake fetch that answers like the Apify actors and a fake getter. No test
// uses the network, a real key or the live inbox; the key must only ever be in an Authorization
// header.
//
// The actors' fields, read from their public pages and README (api.apify.com/v2/acts/<id> and its
// build), not from a run (there is no Apify key on this Mac yet): see testdata/trending.json.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn('trending-pick.test.ts: ffmpeg/ffprobe not found; skipping the runs that need them');
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-25T12:00:00.000Z');

// --- the actors' items ----------------------------------------------------------------------------

interface Music {
  id: string;
  song: string;
  artist: string;
  original?: boolean;
}

/** A reel as the hashtag scraper and the reel scraper write it (the fields the pick reads). */
function reel(code: string, plays: number, music: Music | null, daysAgo = 3) {
  return {
    inputUrl: 'https://www.instagram.com/explore/tags/fpv',
    id: `id-${code}`,
    type: 'Video',
    shortCode: code,
    productType: 'clips',
    url: `https://www.instagram.com/p/${code}/`,
    videoPlayCount: plays,
    igPlayCount: plays,
    timestamp: new Date(NOW - daysAgo * DAY).toISOString(),
    musicInfo:
      music === null
        ? null
        : {
            artist_name: music.artist,
            song_name: music.song,
            uses_original_audio: music.original === true,
            should_mute_audio: false,
            should_mute_audio_reason: '',
            audio_id: music.id,
          },
  };
}

const LOST_A: Music = { id: '111', song: 'Lost In Space', artist: 'Nova' };
/** The same song under a second sound id. */
const LOST_B: Music = { id: '112', song: 'Lost In Space', artist: 'Nova' };
const RISING: Music = { id: '333', song: 'Rising Fast', artist: 'Kite' };
const STEADY: Music = { id: '555', song: 'Steady Hit', artist: 'Orbit' };
const FLAT: Music = { id: '222', song: 'Big Flat Hit', artist: 'Star' };
const LATE: Music = { id: '666', song: 'Late One', artist: 'Ray' };
const ORIGINAL: Music = { id: '444', song: 'Original audio', artist: 'falcon_fpv', original: true };

/**
 * The niche's reels, most played first: the top 20 are Lost In Space x6 (under two sound ids),
 * Rising Fast x3, Steady Hit x3, Big Flat Hit x1, original audio x7; the next ten Late One x5 and
 * Big Flat Hit x5. Plus an old reel with the most plays, a repeat, an error row and a reel with no
 * sound, all of which the pick must ignore.
 */
function niche() {
  const top: (Music | null)[] = [
    ...Array(4).fill(LOST_A),
    ...Array(2).fill(LOST_B),
    ...Array(3).fill(RISING),
    ...Array(3).fill(STEADY),
    FLAT,
    ...Array(7).fill(ORIGINAL),
  ];
  const items = top.map((music, i) => reel(`TOP${i}`, 100_000 - i * 1_000, music));
  const rest: Music[] = [...Array(5).fill(LATE), ...Array(5).fill(FLAT)];
  items.push(...rest.map((music, i) => reel(`LOW${i}`, 30_000 - i * 100, music)));
  items.push(reel('OLD0', 999_999, { id: '777', song: 'Old Hit', artist: 'Past' }, 60));
  items.push(reel('TOP0', 100_000, LOST_A));
  items.push({ error: 'no_items', errorDescription: 'Empty or private data' } as never);
  items.push(reel('NOSND', 90_000, null));
  return items;
}

/** The audio scraper's rows for the sounds above (rowType, trackId, totalReelsUsingSound, isTrending, trendRank). */
function soundRow(trackId: string, reels: number, isTrending: boolean | null, trendRank?: number) {
  return {
    rowType: 'sound',
    source: trackId,
    trackId,
    title: '(as Instagram says)',
    artist: '(as Instagram says)',
    durationMs: 160_000,
    isOriginalAudio: false,
    hasLyrics: false,
    isTrending,
    trendRank: trendRank ?? null,
    totalReelsUsingSound: reels,
    scrapedAt: new Date(NOW).toISOString(),
  };
}

const SOUND_ROWS = [
  soundRow('111', 5_000, false),
  soundRow('112', 3_000, null),
  soundRow('333', 800, true, 12),
  soundRow('555', 120_000, false),
  soundRow('222', 9_000_000, false),
  soundRow('666', 42, null),
];

// --- audio made here -------------------------------------------------------------------------------

/** A mono 16-bit WAV of sine segments: `amp` is each segment's amplitude (0 to 1). */
function writeWav(file: string, segments: { seconds: number; amp: number }[], rate = 8_000) {
  const total = segments.reduce((n, s) => n + Math.round(s.seconds * rate), 0);
  const data = Buffer.alloc(total * 2);
  let at = 0;
  for (const segment of segments) {
    const count = Math.round(segment.seconds * rate);
    for (let i = 0; i < count; i++) {
      const value = Math.sin((2 * Math.PI * 220 * (at + i)) / rate) * segment.amp;
      data.writeInt16LE(Math.round(value * 32_767), (at + i) * 2);
    }
    at += count;
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
}

/** Quiet for 20 s, then a loud drop: 40 s with one clear rise. */
const DROP = [
  { seconds: 20, amp: 0.03 },
  { seconds: 20, amp: 0.5 },
];
/** The same loudness all the way: no drop. */
const NO_DROP = [{ seconds: 40, amp: 0.3 }];
/** A drop in 9 s: shorter than a 15 s cut. */
const SHORT = [
  { seconds: 6, amp: 0.03 },
  { seconds: 3, amp: 0.5 },
];
/** A short burst at 10 s that is the sharpest rise, then 13.5 s of quiet before the loud part. */
const QUIET_OPEN = [
  { seconds: 10, amp: 0.01 },
  { seconds: 1.5, amp: 0.3 },
  { seconds: 13.5, amp: 0.04 },
  { seconds: 15, amp: 0.8 },
];

const media = mkdtempSync(join(tmpdir(), 'trending-media-'));
const songFiles = new Map<string, string>();
for (const [name, segments] of [
  ['drop', DROP],
  ['nodrop', NO_DROP],
  ['short', SHORT],
  ['quietopen', QUIET_OPEN],
] as const) {
  const file = join(media, `${name}.wav`);
  writeWav(file, [...segments]);
  songFiles.set(name, file);
}
afterAll(() => rmSync(media, { recursive: true, force: true }));
const song = (name: string): string => songFiles.get(name) as string;

// --- fakes ----------------------------------------------------------------------------------------

interface ApifyAnswers {
  /** Items for the hashtag scraper, the reel scraper (accounts) and the audio scraper's rows. */
  hashtags?: unknown[] | Reply;
  accounts?: unknown[] | Reply;
  sounds?: unknown[] | Reply;
}

/** A fetch that answers like Apify's run-sync endpoint, and nothing else (anything else fails the test). */
function apify(answers: ApifyAnswers) {
  return fakeFetch((call: FetchCall) => {
    const url = new URL(call.url);
    if (url.origin !== APIFY.base) return undefined;
    const actor = url.pathname.split('/')[3];
    const answer =
      actor === ACTORS.hashtags
        ? answers.hashtags
        : actor === ACTORS.accounts
          ? answers.accounts
          : actor === ACTORS.sounds
            ? answers.sounds
            : undefined;
    if (answer === undefined) return undefined;
    return Array.isArray(answer) ? json(answer, 201) : answer;
  });
}

interface Got {
  title: string | null | undefined;
  artist: string | null | undefined;
  workDir: string;
  cacheDir: string | null | undefined;
}

/** A getter that copies the audio made for a title into the work folder, or throws what was set. */
function getter(songs: Record<string, string | { code: string; message: string }>) {
  const calls: Got[] = [];
  const getSong = async (options: GetSongOptions): Promise<GotSong> => {
    calls.push({
      title: options.title,
      artist: options.artist,
      workDir: options.workDir,
      cacheDir: options.cacheDir,
    });
    const rule = songs[options.title ?? ''];
    if (rule === undefined) throw new SongError('not_found', `${options.title} was not found.`);
    if (typeof rule !== 'string') throw new SongError(rule.code as never, rule.message);
    mkdirSync(options.workDir, { recursive: true });
    const full = join(options.workDir, 'song-full.m4a');
    copyFileSync(rule, full);
    const id = String(options.title).replace(/\W+/g, '').padEnd(11, '0').slice(0, 11);
    return {
      full,
      reel: null,
      meta: {
        title: String(options.title),
        artist: String(options.artist),
        site: 'youtube-music',
        via: 'yt-dlp',
        url: `https://www.youtube.com/watch?v=${id}`,
        id,
        fullMs: 40_000,
      },
    };
  };
  return { getSong, calls };
}

/** A beat finder that says what the test wants (and counts its calls). */
function beats(bpm: number | null) {
  const calls: string[] = [];
  const beatFinder = async (wav: string) => {
    calls.push(wav);
    return bpm === null
      ? { data: null, why: 'it found no beats' }
      : { data: { beatsMs: [500], downbeatsMs: [500], bpm, sectionStartsMs: [] }, why: null };
  };
  return { beatFinder, calls };
}

/** A beat finder whose tempo is the next of `bpms` at every call. */
function beatsInOrder(bpms: number[]) {
  const calls: string[] = [];
  const beatFinder = async (wav: string) => {
    calls.push(wav);
    const bpm = bpms[calls.length - 1] ?? null;
    return bpm === null
      ? { data: null, why: 'it found no beats' }
      : { data: { beatsMs: [500], downbeatsMs: [500], bpm, sectionStartsMs: [] }, why: null };
  };
  return { beatFinder, calls };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bench() {
  const root = mkdtempSync(join(tmpdir(), 'trending-pick-'));
  temps.push(root);
  const dataDir = join(root, '.studio-engine');
  const cacheDir = join(dataDir, 'songs-cache');
  mkdirSync(cacheDir, { recursive: true });
  let now = NOW;
  const base = (extra: Partial<PickTrendingOptions> = {}): PickTrendingOptions => ({
    clientId: 'a1b2c3d4e5f6',
    client: 'Falcon FPV',
    niche: '#fpv #fpvdrone',
    lengthMs: 15_000,
    cutBpm: null,
    dropMs: 7_000,
    env: { PATH: process.env.PATH ?? '', APIFY_TOKEN: TOKEN },
    dataDir,
    cacheDir,
    envFile: join(root, 'none.env'),
    now: () => now,
    retryMs: 1,
    tools: { ffmpeg: ffmpeg as string },
    beatFinder: beats(null).beatFinder,
    ...extra,
  });
  return {
    root,
    dataDir,
    cacheDir,
    base,
    cacheFile: trendingCachePath(dataDir, 'a1b2c3d4e5f6'),
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

/** The failure a promise ends in, as the code and message. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a failure, but it picked a song');
    },
    (reason: unknown) => reason as { code: string; message: string },
  );
  expect(error).toBeInstanceOf(SongError);
  return { code: error.code, message: error.message };
}

// --- the niche -------------------------------------------------------------------------------------

describe('parseNiche', () => {
  it('reads hashtags and accounts, lower case, once each', () => {
    expect(parseNiche('#FPV #fpvdrone @Falcon_FPV #fpv')).toEqual({
      hashtags: ['fpv', 'fpvdrone'],
      accounts: ['falcon_fpv'],
      text: '#fpv #fpvdrone @falcon_fpv',
    });
  });

  it('ignores the words around the tags, such as the guess mark Learn style adds', () => {
    expect(parseNiche('#fpv #fpvisrael (a guess; edit it if it is wrong)').text).toBe(
      '#fpv #fpvisrael',
    );
  });

  it('keeps Hebrew hashtags and an account with dots', () => {
    expect(parseNiche('#רחפנים @falcon.fpv.il').text).toBe('#רחפנים @falcon.fpv.il');
  });

  it('takes at most 5 hashtags and 3 accounts', () => {
    const many = parseNiche('#a #b #c #d #e #f @1 @2 @3 @4');
    expect(many.hashtags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(many.accounts).toEqual(['1', '2', '3']);
  });

  it('is empty for no tags', () => {
    expect(parseNiche('fpv drones').text).toBe('');
    expect(parseNiche(null).text).toBe('');
    expect(parseNiche('').hashtags).toEqual([]);
  });
});

// --- the reels and sounds ----------------------------------------------------------------------------

describe('the actors’ own sample items', () => {
  // Items as the actors' pages print them (trimmed): these are the fields confirmed from the pages.
  const samples = fixture<Record<string, unknown>>('trending', 'actor-samples');

  it('reads the hashtag scraper’s reel (musicInfo with a song)', () => {
    expect(readReel((samples as Record<string, unknown>).hashtagReel)).toEqual({
      id: 'DQt1HbPDFtN',
      plays: 2133,
      at: Date.parse('2025-11-06T13:08:06.000Z'),
      audioId: '138853804759362',
      title: 'The X-Files Theme',
      artist: 'Retrospectre',
      original: false,
    });
  });

  it('reads the reel scraper’s reel with original audio as no song', () => {
    const read = readReel((samples as Record<string, unknown>).reelScraperOriginal);
    expect(read).toMatchObject({ id: 'DX7lzTOJ1p6', plays: 10_977, original: true });
  });

  it('reads the audio scraper’s sound row', () => {
    const [sound] = soundsOfReels([
      readReel(
        reel('R1', 10, { id: '878420731732683', song: 'Bloom', artist: 'LoFi Tokyo' }),
      ) as never,
    ]);
    expect(sound).toBeDefined();
    addInstagramNumbers([sound as never], [(samples as Record<string, unknown>).soundRow]);
    expect(sound).toMatchObject({ reels: 29_677, isTrending: null, trendRank: null, isSong: true });
  });

  it('is no reel for an error row, an item without an id, or an audio id of 0', () => {
    expect(readReel({ error: 'no_items' })).toBeNull();
    expect(readReel({ videoPlayCount: 5 })).toBeNull();
    expect(readReel(null)).toBeNull();
    expect(
      readReel({ shortCode: 'X1', musicInfo: { audio_id: '0', song_name: 'S', artist_name: 'A' } }),
    ).toMatchObject({ audioId: '' });
  });
});

describe('songs uploaded as sounds (C76)', () => {
  // Hashtag-scraper style reels (testdata/trending.json#song-as-sound): a hit song uploaded as a
  // sound by another account has the actor's "original audio" flag too; the artist field is the
  // uploader and the title reads "Song - Artist" (or "Song • Artist").
  const sounds = fixture<Record<string, unknown>>('trending', 'song-as-sound');
  const item = (name: string) => sounds[name];

  it('reads a hit song uploaded as a sound as a song, named by its title and real artist', () => {
    expect(readReel(item('keane'))).toMatchObject({
      id: 'DKeaneHash1',
      audioId: '8800',
      title: 'Somewhere only we know',
      artist: 'Keane',
      original: false,
    });
    expect(readReel(item('anyma'))).toMatchObject({
      audioId: '8803',
      title: 'Atmosphere',
      artist: 'Anyma, Chris Avantgarde',
      original: false,
    });
  });

  it("keeps a creator's own named sound out (the flag, and the artist field is the reel's own account)", () => {
    expect(readReel(item('ownNamed'))).toMatchObject({
      title: 'Mibellyuseche💋',
      artist: 'mibellyuseche',
      original: true,
    });
  });

  it('keeps a version in a title whole: Blinding Lights - Remix by The Weeknd is not split', () => {
    expect(readReel(item('remix'))).toMatchObject({
      title: 'Blinding Lights - Remix',
      artist: 'The Weeknd',
      original: false,
    });
  });

  it('lets the flag decide, as it did, when the reel does not say whose it is', () => {
    const { ownerUsername: _owner, ...noOwner } = item('keane') as Record<string, unknown>;
    expect(readReel(noOwner)).toMatchObject({ original: true });
  });

  it('counts one song under several uploaders and sound ids once, and leaves the own sound out', () => {
    const reels = recentReels(['keane', 'keaneAgain', 'anyma', 'ownNamed', 'remix'].map(item), NOW);
    const found = soundsOfReels(reels);
    expect(found.map((x) => [x.title, x.artist, x.nicheTop20, x.ids])).toEqual([
      ['Somewhere only we know', 'Keane', 2, ['8800', '8802']],
      ['Atmosphere', 'Anyma, Chris Avantgarde', 1, ['8803']],
      ['Blinding Lights - Remix', 'The Weeknd', 1, ['8804']],
    ]);
  });
});

describe('recentReels', () => {
  it('keeps the last 30 days, each reel once, the most played first', () => {
    const reels = recentReels(niche(), NOW);
    expect(reels.some((r) => r.id === 'OLD0')).toBe(false);
    expect(reels.filter((r) => r.id === 'TOP0')).toHaveLength(1);
    expect(reels.some((r) => r.id.startsWith('no_items'))).toBe(false);
    const plays = reels.map((r) => r.plays);
    expect(plays).toEqual([...plays].sort((a, b) => b - a));
    expect(reels[0]?.id).toBe('TOP0');
    expect(reels.some((r) => r.id === 'NOSND')).toBe(true);
  });

  it('keeps a reel with no timestamp and drops one from the future', () => {
    const noTime = { ...reel('NT', 5, LATE), timestamp: undefined };
    const future = reel('FU', 5, LATE, -5);
    const ids = recentReels([noTime, future], NOW).map((r) => r.id);
    expect(ids).toEqual(['NT']);
  });
});

describe('soundsOfReels', () => {
  it('counts the top 20 reels per song, merges one song under two ids and drops original audio', () => {
    const sounds = soundsOfReels(recentReels(niche(), NOW));
    const by = (title: string) => sounds.find((s) => s.title === title);
    expect(by('Lost In Space')).toMatchObject({ nicheTop20: 6, ids: ['111', '112'] });
    expect(by('Rising Fast')?.nicheTop20).toBe(3);
    expect(by('Steady Hit')?.nicheTop20).toBe(3);
    expect(by('Big Flat Hit')?.nicheTop20).toBe(1);
    expect(sounds.some((s) => /original/i.test(s.title))).toBe(false);
    expect(sounds.some((s) => s.title === 'Old Hit')).toBe(false);
  });

  it('adds the next reels’ songs, with 0 of the top 20, when the top 20 hold few songs', () => {
    const sounds = soundsOfReels(recentReels(niche(), NOW));
    expect(sounds.find((s) => s.title === 'Late One')).toMatchObject({ nicheTop20: 0 });
    // Big Flat Hit is used by 5 more reels below the top 20, which do not count.
    expect(sounds.find((s) => s.title === 'Big Flat Hit')?.nicheTop20).toBe(1);
  });

  it('adds none when the top 20 already hold five songs', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((n, i) => ({
      id: String(900 + i),
      song: `Song ${n}`,
      artist: 'X',
    }));
    const items = [
      ...five.map((music, i) => reel(`F${i}`, 50_000 - i, music)),
      ...Array.from({ length: 15 }, (_, i) => reel(`G${i}`, 40_000 - i, five[0] as Music)),
      reel('H', 100, LATE),
    ];
    const sounds = soundsOfReels(recentReels(items, NOW));
    expect(sounds.map((s) => s.title).sort()).toEqual(five.map((m) => m.song));
    expect(sounds.find((s) => s.title === 'Song A')?.nicheTop20).toBe(16);
  });

  it('gives each sound its Instagram sound page', () => {
    const [first] = soundsOfReels(recentReels(niche(), NOW));
    expect(first?.url).toBe(`https://www.instagram.com/reels/audio/${first?.igAudioId}/`);
  });

  it('has no song when every top reel uses original audio', () => {
    const items = Array.from({ length: 5 }, (_, i) => reel(`O${i}`, 100 - i, ORIGINAL));
    expect(soundsOfReels(recentReels(items, NOW))).toEqual([]);
  });
});

describe('addInstagramNumbers', () => {
  it('takes the biggest count, the trending flag from any id and the best rank', () => {
    const sounds = soundsOfReels(recentReels(niche(), NOW));
    addInstagramNumbers(sounds, [...SOUND_ROWS, soundRow('112', 100, true, 3)]);
    const lost = sounds.find((s) => s.title === 'Lost In Space');
    expect(lost).toMatchObject({ reels: 5_000, isTrending: true, trendRank: 3 });
    expect(sounds.find((s) => s.title === 'Big Flat Hit')?.reels).toBe(9_000_000);
    expect(sounds.find((s) => s.title === 'Rising Fast')).toMatchObject({
      isTrending: true,
      trendRank: 12,
    });
  });

  it('leaves a sound with no row alone, ignores error rows, and drops a sound Instagram calls original', () => {
    const sounds = soundsOfReels(recentReels(niche(), NOW));
    addInstagramNumbers(sounds, [
      { error: 'private', message: 'x' },
      { ...soundRow('666', 1, null), isOriginalAudio: true },
    ]);
    expect(sounds.find((s) => s.title === 'Steady Hit')).toMatchObject({
      reels: null,
      isTrending: null,
    });
    expect(sounds.find((s) => s.title === 'Late One')?.isSong).toBe(false);
  });
});

describe('rankSounds', () => {
  const sounds = () => {
    const found = soundsOfReels(recentReels(niche(), NOW));
    addInstagramNumbers(found, SOUND_ROWS);
    return found;
  };

  it('ranks by the niche’s top 20 first: a niche favourite beats a big flat sound', () => {
    const titles = rankSounds(sounds()).map((s) => s.title);
    expect(titles).toEqual([
      'Lost In Space',
      'Rising Fast',
      'Steady Hit',
      'Big Flat Hit',
      'Late One',
    ]);
    // 9 million reels, and still behind a song 6 of the 20 niche reels use.
    expect(titles.indexOf('Big Flat Hit')).toBeGreaterThan(titles.indexOf('Lost In Space'));
  });

  it('breaks a tie of the top 20 by Instagram’s trending flag, then by its reel count', () => {
    const [, second, third] = rankSounds(sounds());
    expect(second).toMatchObject({ title: 'Rising Fast', isTrending: true, reels: 800 });
    expect(third).toMatchObject({ title: 'Steady Hit', isTrending: false, reels: 120_000 });
  });

  it('puts the lower trend rank first among trending sounds, then the bigger count', () => {
    const base = soundsOfReels(recentReels(niche(), NOW)).slice(0, 3);
    const [a, b, c] = base.map((s, i) => ({
      ...s,
      nicheTop20: 2,
      isTrending: true,
      trendRank: [20, 5, null][i] as number | null,
      reels: [10, 10, 99][i] as number,
    }));
    expect(rankSounds([a, b, c] as never).map((s) => s.trendRank)).toEqual([5, 20, null]);
  });

  it('never ranks a sound that is not a song', () => {
    const list = sounds();
    (list[0] as { isSong: boolean }).isSong = false;
    expect(rankSounds(list)).toHaveLength(list.length - 1);
  });
});

describe('tempoFits', () => {
  it('is the cut’s tempo, doubled or halved, within 4%', () => {
    expect(tempoFits(120, 120)).toBe(true);
    expect(tempoFits(124.5, 120)).toBe(true);
    expect(tempoFits(240, 120)).toBe(true);
    expect(tempoFits(60, 120)).toBe(true);
    expect(tempoFits(130, 120)).toBe(false);
    expect(tempoFits(90, 120)).toBe(false);
  });

  it('is unknown when either tempo is', () => {
    expect(tempoFits(null, 120)).toBeNull();
    expect(tempoFits(120, null)).toBeNull();
    expect(tempoFits(0, 120)).toBeNull();
  });
});

describe('estimateCost', () => {
  it('prices the items read, well under a dollar for a normal lookup', () => {
    expect(estimateCost({ hashtags: 220, accounts: 0, sounds: 6 })).toBe(0.596);
    expect(estimateCost({ hashtags: 120, accounts: 25, sounds: 9 })).toBe(0.419);
    expect(estimateCost({ hashtags: 0, accounts: 0, sounds: 0 })).toBe(0);
    const worst = TRENDING.budget.hashtags + TRENDING.budget.accounts + TRENDING.budget.sounds;
    expect(worst).toBeLessThan(1);
  });
});

// --- the cache -----------------------------------------------------------------------------------------

describe('readTrendingCache', () => {
  const sound = {
    igAudioId: '111',
    title: 'Lost In Space',
    artist: 'Nova',
    isSong: true,
    reels: 5_000,
    isTrending: false,
    nicheTop20: 6,
    url: 'https://www.instagram.com/reels/audio/111/',
  };
  const write = (file: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        clientId: 'a1b2c3d4e5f6',
        niche: '#fpv #fpvdrone',
        fetchedAt: new Date(NOW - 2 * DAY).toISOString(),
        sounds: [sound],
        ...extra,
      }),
    );

  it('is the lookup while it is under 7 days old and for the same niche (in any order)', () => {
    const b = bench();
    const file = join(b.root, 'c.json');
    write(file);
    expect(readTrendingCache(file, parseNiche('#fpv #fpvdrone'), NOW)?.sounds).toEqual([sound]);
    expect(readTrendingCache(file, parseNiche('#FPVDRONE #fpv'), NOW)).not.toBeNull();
    expect(readTrendingCache(file, parseNiche('#fpv'), NOW)).toBeNull();
    expect(readTrendingCache(file, parseNiche('#fpv #fpvdrone @falcon'), NOW)).toBeNull();
  });

  it('is nothing at 7 days, from the future, broken, or without a song of the right shape', () => {
    const b = bench();
    const file = join(b.root, 'c.json');
    const n = parseNiche('#fpv #fpvdrone');
    write(file);
    expect(readTrendingCache(file, n, NOW + 5 * DAY - 1)).not.toBeNull();
    expect(readTrendingCache(file, n, NOW + 5 * DAY)).toBeNull();
    write(file, { fetchedAt: new Date(NOW + DAY).toISOString() });
    expect(readTrendingCache(file, n, NOW)).toBeNull();
    writeFileSync(file, '{ not json');
    expect(readTrendingCache(file, n, NOW)).toBeNull();
    write(file, { v: 2 });
    expect(readTrendingCache(file, n, NOW)).toBeNull();
    write(file, { sounds: [{ ...sound, nicheTop20: 21 }, { title: 'x' }] });
    expect(readTrendingCache(file, n, NOW)).toBeNull();
    expect(readTrendingCache(join(b.root, 'missing.json'), n, NOW)).toBeNull();
  });

  it('lives where the shared contract says', () => {
    expect(TRENDING.cache).toEqual(TRENDING_CACHE);
    expect(trendingCachePath('/data', 'a1b2c3d4e5f6')).toBe(
      join('/data', trendingCacheFile('a1b2c3d4e5f6')),
    );
    expect(trendingCachePath('/data', '../x/y')).toBe(join('/data', 'trends', 'xy.json'));
  });
});

// --- the fit -----------------------------------------------------------------------------------------

describe.skipIf(!haveTools)('measureFit (audio made here)', () => {
  const run = async (name: string, extra: Partial<Parameters<typeof measureFit>[0]> = {}) => {
    const b = bench();
    const work = join(b.root, 'fit');
    const fit = await measureFit({
      file: song(name),
      work,
      lengthMs: 15_000,
      env: { PATH: process.env.PATH ?? '' },
      tools: { ffmpeg: ffmpeg as string },
      beatFinder: beats(null).beatFinder,
      ...extra,
    });
    expect(existsSync(join(work, 'measure.wav'))).toBe(false);
    return fit;
  };

  it('fits a song with a clear drop that holds the cut; the tempo is unknown without the cut’s', async () => {
    const finder = beats(120);
    const fit = await run('drop', { beatFinder: finder.beatFinder });
    expect(fit).toMatchObject({ fits: true, why: [], tempo: null, bpm: 120, hook: true });
    expect(fit.durationMs).toBeGreaterThan(39_000);
    expect(fit.dropAtMs).toBeGreaterThan(18_500);
    expect(fit.dropAtMs).toBeLessThan(21_000);
    expect(fit.partStartMs).toBeGreaterThan(18_000);
    expect(fit.partStartMs).toBeLessThanOrEqual(fit.dropAtMs as number);
    expect(fit.riseDb).toBeGreaterThan(15);
    // The beat finder still ran: the part starts where the song command would start it.
    expect(finder.calls).toHaveLength(1);
  });

  it('judges the tempo against the cut’s: 1, 2 or 0.5 times fit, another does not', async () => {
    for (const bpm of [120, 240, 61]) {
      const fit = await run('drop', { cutBpm: 120, beatFinder: beats(bpm).beatFinder });
      expect(fit).toMatchObject({ fits: true, tempo: true, bpm });
    }
    const off = await run('drop', { cutBpm: 120, beatFinder: beats(95).beatFinder });
    expect(off).toMatchObject({ fits: false, tempo: false });
    expect(off.why).toEqual(["its tempo (95 BPM) is not the cut's 120 BPM"]);
  });

  it('does not count an unknown tempo against the song', async () => {
    const fit = await run('drop', { cutBpm: 120, beatFinder: beats(null).beatFinder });
    expect(fit).toMatchObject({ fits: true, tempo: null, bpm: null });
  });

  it('does not fit a song with no clear drop', async () => {
    const fit = await run('nodrop');
    expect(fit).toMatchObject({ fits: false, dropAtMs: null });
    expect(fit.why).toEqual(['it has no clear drop']);
  });

  it('does not fit a song shorter than the cut', async () => {
    const fit = await run('short');
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain('it is 0:09, shorter than the 0:15 cut');
  });

  it('does not fit a song whose first 3 s of the part are quiet next to the rest', async () => {
    const fit = await run('quietopen', { lengthMs: 25_000 });
    expect(fit).toMatchObject({ fits: false, hook: false });
    expect(fit.why).toEqual(['it opens quietly']);
  });

  it('says tool_missing without ffmpeg and failed for a file that is no audio', async () => {
    const b = bench();
    const work = join(b.root, 'fit');
    await expect(
      measureFit({ file: song('drop'), work, lengthMs: 15_000, env: {}, tools: { ffmpeg: null } }),
    ).rejects.toMatchObject({ code: 'tool_missing' });
    const bad = join(b.root, 'bad.m4a');
    writeFileSync(bad, 'not audio');
    await expect(
      measureFit({
        file: bad,
        work,
        lengthMs: 15_000,
        env: {},
        tools: { ffmpeg: ffmpeg as string },
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(existsSync(join(work, 'measure.wav'))).toBe(false);
  });
});

// --- the pick ----------------------------------------------------------------------------------------

describe.skipIf(!haveTools)('pickTrending', () => {
  /** Lost In Space, Rising Fast and Steady Hit can be got; each is the audio named. */
  const allDrop = {
    'Lost In Space': song('drop'),
    'Rising Fast': song('drop'),
    'Steady Hit': song('drop'),
  };
  const answers = (): ApifyAnswers => ({ hashtags: niche(), sounds: SOUND_ROWS });

  describe('a fresh pick', () => {
    it('picks the best ranked song that fits, with Instagram’s numbers, and asks Apify as planned', async () => {
      const b = bench();
      const net = apify(answers());
      const songs = getter(allDrop);
      const pick = await pickTrending(b.base({ fetch: net.fetch, getSong: songs.getSong }));

      expect(pick).toMatchObject({
        title: 'Lost In Space',
        artist: 'Nova',
        link: 'https://www.youtube.com/watch?v=LostInSpace',
        trending: { reels: 5_000, isTrending: false, nicheTop20: 6, niche: '#fpv #fpvdrone' },
        note: null,
        cached: false,
      });
      // The contract's shapes.
      songTrendingSchema.parse(pick.trending);
      songTrendingEventSchema.parse(pick.event);
      expect(pick.event).toMatchObject({
        type: 'music.song.trending',
        at: new Date(NOW).toISOString(),
        niche: '#fpv #fpvdrone',
        looked: 1,
        pick: { title: 'Lost In Space', artist: 'Nova' },
      });
      expect(pick.considered).toEqual([
        {
          title: 'Lost In Space',
          artist: 'Nova',
          nicheTop20: 6,
          reels: 5_000,
          isTrending: false,
          got: true,
          fits: true,
          why: [],
        },
      ]);

      // Two Apify runs, in a header-keyed, capped call each.
      expect(net.calls).toHaveLength(2);
      const [hashtags, sounds] = net.calls as [FetchCall, FetchCall];
      const hUrl = new URL(hashtags.url);
      expect(hUrl.pathname).toBe(`/v2/acts/${ACTORS.hashtags}/run-sync-get-dataset-items`);
      expect(Object.fromEntries(hUrl.searchParams)).toMatchObject({
        maxTotalChargeUsd: '0.6',
        maxItems: '220',
        limit: '220',
        timeout: '240',
      });
      expect(JSON.parse(hashtags.body ?? '')).toEqual({
        hashtags: ['fpv', 'fpvdrone'],
        resultsType: 'reels',
        resultsLimit: 110,
      });
      const sUrl = new URL(sounds.url);
      expect(sUrl.pathname).toBe(`/v2/acts/${ACTORS.sounds}/run-sync-get-dataset-items`);
      expect(Object.fromEntries(sUrl.searchParams)).toMatchObject({
        maxTotalChargeUsd: '0.1',
        maxItems: '6',
      });
      const asked = JSON.parse(sounds.body ?? '') as { trackIds: string[] };
      expect(asked.trackIds.sort()).toEqual(['111', '112', '222', '333', '555', '666']);
      for (const call of net.calls) {
        expect(call.method).toBe('POST');
        expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.url).not.toContain(TOKEN);
        expect(call.body).not.toContain(TOKEN);
      }
      // No chart was asked: Apify is the only host the pick reached.
      expect(new Set(net.calls.map((c) => new URL(c.url).host))).toEqual(
        new Set(['api.apify.com']),
      );
    });

    it('picks a hit song uploaded as a sound, and asks the getter for the song and its real artist', async () => {
      const b = bench();
      const sounds = fixture<Record<string, unknown>>('trending', 'song-as-sound');
      const songs = getter({
        'Somewhere only we know': song('drop'),
        Atmosphere: song('drop'),
      });
      const pick = await pickTrending(
        b.base({
          fetch: apify({
            hashtags: ['keane', 'keaneAgain', 'anyma', 'ownNamed'].map((name) => sounds[name]),
            sounds: [soundRow('8800', 90_000, true, 3), soundRow('8803', 4_000, false)],
          }).fetch,
          getSong: songs.getSong,
        }),
      );
      expect(pick).toMatchObject({ title: 'Somewhere only we know', artist: 'Keane' });
      expect(pick.event).toMatchObject({
        pick: { title: 'Somewhere only we know', artist: 'Keane' },
      });
      songTrendingSchema.parse(pick.trending);
      // The uploader never reaches the lookup, and the creator's own sound is never asked for.
      expect(songs.calls.map((c) => [c.title, c.artist])).toEqual([
        ['Somewhere only we know', 'Keane'],
      ]);
      expect(JSON.stringify(songs.calls)).not.toContain('sofia.peters');
      expect(pick.considered.map((row) => row.title)).toEqual(['Somewhere only we know']);
    });

    it('gets the song by Instagram’s name into the songs-cache, in a work folder it removes', async () => {
      const b = bench();
      mkdirSync(join(b.cacheDir, '.pick-1'), { recursive: true });
      utimesSync(join(b.cacheDir, '.pick-1'), new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
      const songs = getter(allDrop);
      await pickTrending(b.base({ fetch: apify(answers()).fetch, getSong: songs.getSong }));
      expect(songs.calls).toHaveLength(1);
      expect(songs.calls[0]).toMatchObject({
        title: 'Lost In Space',
        artist: 'Nova',
        cacheDir: b.cacheDir,
      });
      expect(songs.calls[0]?.workDir.startsWith(join(b.cacheDir, '.pick-'))).toBe(true);
      // Nothing is left of its own work folder, nor of an old one a killed pick left.
      expect(readdirSync(b.cacheDir)).toEqual([]);
    });

    it('writes the cache atomically, in the shared contract’s shape, and logs the estimated cost', async () => {
      const b = bench();
      await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: getter(allDrop).getSong }),
      );
      const cache = trendingCacheSchema.parse(JSON.parse(readFileSync(b.cacheFile, 'utf8')));
      expect(cache).toMatchObject({
        clientId: 'a1b2c3d4e5f6',
        niche: '#fpv #fpvdrone',
        fetchedAt: new Date(NOW).toISOString(),
      });
      expect(cache.sounds.map((s) => s.title)).toContain('Big Flat Hit');
      expect(cache.sounds.find((s) => s.title === 'Lost In Space')).toMatchObject({
        igAudioId: '111',
        reels: 5_000,
        nicheTop20: 6,
        isSong: true,
      });
      expect(readdirSync(join(b.dataDir, 'trends')).sort()).toEqual([
        'a1b2c3d4e5f6.json',
        'apify-runs.jsonl',
      ]);
      const [line] = readFileSync(join(b.dataDir, 'trends', 'apify-runs.jsonl'), 'utf8')
        .trim()
        .split('\n');
      const run = JSON.parse(line ?? '') as Record<string, unknown>;
      expect(run).toMatchObject({
        clientId: 'a1b2c3d4e5f6',
        niche: '#fpv #fpvdrone',
        items: { hashtags: niche().length, accounts: 0, sounds: 6 },
      });
      expect(run.estimatedUsd).toBe(estimateCost(run.items as never));
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    });

    it('reads a niche’s accounts with the reel scraper, newer than 30 days', async () => {
      const b = bench();
      const net = apify({ ...answers(), accounts: [reel('ACC1', 70_000, LOST_A)] });
      await pickTrending(
        b.base({
          niche: '#fpv @Falcon_FPV',
          fetch: net.fetch,
          getSong: getter(allDrop).getSong,
        }),
      );
      const paths = net.calls.map((c) => new URL(c.url).pathname.split('/')[3]);
      expect(paths).toEqual([ACTORS.hashtags, ACTORS.accounts, ACTORS.sounds]);
      const accounts = net.calls[1] as FetchCall;
      expect(JSON.parse(accounts.body ?? '')).toEqual({
        username: ['falcon_fpv'],
        resultsLimit: 25,
        onlyPostsNewerThan: '2026-09-25',
        skipPinnedPosts: true,
      });
      expect(Object.fromEntries(new URL(accounts.url).searchParams)).toMatchObject({
        maxTotalChargeUsd: '0.25',
        maxItems: '25',
      });
      expect(JSON.parse((net.calls[0] as FetchCall).body ?? '').resultsLimit).toBe(120);
    });

    it('reads accounts alone without the hashtag scraper', async () => {
      const b = bench();
      const net = apify({ accounts: niche(), sounds: SOUND_ROWS });
      const pick = await pickTrending(
        b.base({ niche: '@falcon_fpv', fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(net.calls.map((c) => new URL(c.url).pathname.split('/')[3])).toEqual([
        ACTORS.accounts,
        ACTORS.sounds,
      ]);
      expect(pick.trending.niche).toBe('@falcon_fpv');
    });

    it('goes by the top reels alone, and keeps no cache, when the audio scraper fails', async () => {
      const b = bench();
      const net = apify({ hashtags: niche(), sounds: new Response('down', { status: 500 }) });
      const pick = await pickTrending(
        b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(pick).toMatchObject({
        title: 'Lost In Space',
        trending: { reels: null, isTrending: null, nicheTop20: 6 },
      });
      expect(pick.note).toContain('reel counts were not available');
      expect(existsSync(b.cacheFile)).toBe(false);
      // The audio scraper was tried twice (one retry) and then given up on.
      expect(net.calls.filter((c) => c.url.includes(ACTORS.sounds))).toHaveLength(2);
    });
  });

  describe('the cache', () => {
    it('is reused for the same niche for 7 days: no Apify call, no key needed', async () => {
      const b = bench();
      const net = apify(answers());
      const first = await pickTrending(
        b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(net.calls).toHaveLength(2);
      expect(first.cached).toBe(false);

      b.setNow(NOW + 6 * DAY);
      const again = apify({});
      const second = await pickTrending(
        b.base({
          fetch: again.fetch,
          getSong: getter(allDrop).getSong,
          env: { PATH: process.env.PATH ?? '' },
        }),
      );
      expect(again.calls).toEqual([]);
      expect(second).toMatchObject({
        title: 'Lost In Space',
        cached: true,
        cost: null,
        trending: { reels: 5_000, nicheTop20: 6, isTrending: false },
      });
      // The same niche in another order is the same niche.
      const third = await pickTrending(
        b.base({
          niche: '#fpvdrone #FPV',
          fetch: again.fetch,
          getSong: getter(allDrop).getSong,
        }),
      );
      expect(third.cached).toBe(true);
      expect(third.trending.niche).toBe('#fpvdrone #fpv');
    });

    it('is looked up again after 7 days, and rewritten', async () => {
      const b = bench();
      await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: getter(allDrop).getSong }),
      );
      b.setNow(NOW + 8 * DAY);
      const net = apify(answers());
      const pick = await pickTrending(
        b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(pick.cached).toBe(false);
      expect(net.calls).toHaveLength(2);
      expect(JSON.parse(readFileSync(b.cacheFile, 'utf8')).fetchedAt).toBe(
        new Date(NOW + 8 * DAY).toISOString(),
      );
    });

    it('is looked up again for another niche', async () => {
      const b = bench();
      await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: getter(allDrop).getSong }),
      );
      const net = apify(answers());
      const pick = await pickTrending(
        b.base({ niche: '#fpv #freestyle', fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(pick.cached).toBe(false);
      expect(net.calls).toHaveLength(2);
      expect(JSON.parse(readFileSync(b.cacheFile, 'utf8')).niche).toBe('#fpv #freestyle');
    });

    it('is looked up again when the file is broken', async () => {
      const b = bench();
      mkdirSync(join(b.dataDir, 'trends'), { recursive: true });
      writeFileSync(b.cacheFile, '{"v":1,');
      const net = apify(answers());
      const pick = await pickTrending(
        b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(pick.cached).toBe(false);
      expect(
        trendingCacheSchema.safeParse(JSON.parse(readFileSync(b.cacheFile, 'utf8'))).success,
      ).toBe(true);
    });

    it('keeps one cache per client', async () => {
      const b = bench();
      await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: getter(allDrop).getSong }),
      );
      const net = apify(answers());
      await pickTrending(
        b.base({ clientId: 'ffffffffffff', fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(net.calls).toHaveLength(2);
      expect(
        readdirSync(join(b.dataDir, 'trends'))
          .filter((n) => n.endsWith('.json'))
          .sort(),
      ).toEqual(['a1b2c3d4e5f6.json', 'ffffffffffff.json']);
    });
  });

  describe('the fit step', () => {
    it('takes the next ranked song when the first does not fit (looked at 2)', async () => {
      const b = bench();
      const songs = getter({ ...allDrop, 'Lost In Space': song('nodrop') });
      const pick = await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: songs.getSong }),
      );
      expect(pick).toMatchObject({
        title: 'Rising Fast',
        artist: 'Kite',
        trending: { reels: 800, isTrending: true, nicheTop20: 3 },
        note: null,
      });
      expect(songs.calls.map((c) => c.title)).toEqual(['Lost In Space', 'Rising Fast']);
      expect(pick.event.looked).toBe(2);
      expect(pick.considered.map((c) => [c.title, c.fits, c.why])).toEqual([
        ['Lost In Space', false, ['it has no clear drop']],
        ['Rising Fast', true, []],
      ]);
    });

    it('judges the tempo when the cut has one', async () => {
      const b = bench();
      const songs = getter(allDrop);
      // The first song is 95 BPM, the second 124: only the second is the cut's 120.
      const finder = beatsInOrder([95, 124]);
      const pick = await pickTrending(
        b.base({
          cutBpm: 120,
          fetch: apify(answers()).fetch,
          getSong: songs.getSong,
          beatFinder: finder.beatFinder,
        }),
      );
      expect(pick.title).toBe('Rising Fast');
      expect(pick.considered[0]?.why).toEqual(["its tempo (95 BPM) is not the cut's 120 BPM"]);
      expect(finder.calls).toHaveLength(2);
    });

    it('takes the top ranked song, and says so, when none of the three fits', async () => {
      const b = bench();
      const songs = getter({
        'Lost In Space': song('nodrop'),
        'Rising Fast': song('short'),
        'Steady Hit': song('quietopen'),
      });
      const pick = await pickTrending(
        b.base({ lengthMs: 25_000, fetch: apify(answers()).fetch, getSong: songs.getSong }),
      );
      expect(pick.title).toBe('Lost In Space');
      expect(pick.note).toBe(
        'None of the 3 songs rising on Reels in #fpv #fpvdrone fits the cut, so this is the one most used there (it has no clear drop).',
      );
      expect(pick.event).toMatchObject({ looked: 3, pick: { title: 'Lost In Space' } });
      expect(pick.trending).toMatchObject({ reels: 5_000, nicheTop20: 6 });
      expect(pick.considered.map((c) => c.fits)).toEqual([false, false, false]);
      songTrendingEventSchema.parse(pick.event);
    });

    it('skips a song that is not on YouTube Music', async () => {
      const b = bench();
      const songs = getter({
        'Lost In Space': { code: 'not_found', message: 'Lost In Space was not found.' },
        'Rising Fast': song('drop'),
      });
      const pick = await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: songs.getSong }),
      );
      expect(pick.title).toBe('Rising Fast');
      expect(pick.considered[0]).toMatchObject({ got: false, why: ['it is not on YouTube Music'] });
    });

    it('falls back to the top ranked song that could be got when none fits', async () => {
      const b = bench();
      const songs = getter({
        'Lost In Space': { code: 'unavailable', message: 'It is private.' },
        'Rising Fast': song('nodrop'),
        'Steady Hit': song('nodrop'),
      });
      const pick = await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: songs.getSong }),
      );
      expect(pick.title).toBe('Rising Fast');
      expect(pick.note).toContain('None of the 3 songs');
    });

    it('is no_trending when none of the three can be found, naming them', async () => {
      const b = bench();
      const fail = await failure(
        pickTrending(b.base({ fetch: apify(answers()).fetch, getSong: getter({}).getSong })),
      );
      expect(fail.code).toBe('no_trending');
      expect(fail.message).toContain('Lost In Space, Rising Fast, Steady Hit');
      expect(fail.message).toContain('could be found on YouTube Music');
    });

    it('ends at once with a tool or key problem, which the next song would have too', async () => {
      const b = bench();
      const songs = getter({
        'Lost In Space': {
          code: 'tool_missing',
          message: 'yt-dlp is missing. Run brew install yt-dlp deno',
        },
        'Rising Fast': song('drop'),
      });
      const fail = await failure(
        pickTrending(b.base({ fetch: apify(answers()).fetch, getSong: songs.getSong })),
      );
      expect(fail.code).toBe('tool_missing');
      expect(songs.calls).toHaveLength(1);
      expect(readdirSync(b.cacheDir)).toEqual([]);
    });

    it('stops when its signal is aborted, between two songs, leaving nothing behind', async () => {
      const b = bench();
      const controller = new AbortController();
      const songs = getter({ ...allDrop, 'Lost In Space': song('nodrop') });
      const getSong = async (options: GetSongOptions) => {
        // The first song is got and does not fit; then the pick is stopped.
        const got = await songs.getSong(options);
        controller.abort();
        return got;
      };
      const error = await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong, signal: controller.signal }),
      ).catch((e: unknown) => e as { aborted?: boolean });
      expect(error).toBeInstanceOf(SongError);
      expect((error as { aborted?: boolean }).aborted).toBe(true);
      expect(songs.calls).toHaveLength(1);
      expect(readdirSync(b.cacheDir)).toEqual([]);
    });

    it('does not start when its signal is already aborted', async () => {
      const b = bench();
      const net = apify(answers());
      const controller = new AbortController();
      controller.abort();
      const error = await pickTrending(
        b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong, signal: controller.signal }),
      ).catch((e: unknown) => e as { aborted?: boolean });
      expect((error as { aborted?: boolean }).aborted).toBe(true);
      expect(net.calls).toEqual([]);
    });
  });

  describe('failures', () => {
    it('is no_trending with no niche, and asks nothing', async () => {
      const b = bench();
      const net = apify(answers());
      for (const noNiche of [null, '', 'drones and fpv', '   ']) {
        const fail = await failure(
          pickTrending(
            b.base({ niche: noNiche, fetch: net.fetch, getSong: getter(allDrop).getSong }),
          ),
        );
        expect(fail).toEqual({
          code: 'no_trending',
          message: "Add a Reels niche line to Falcon FPV's style, or name a song.",
        });
      }
      expect(net.calls).toEqual([]);
      expect(existsSync(b.cacheFile)).toBe(false);
    });

    it('names “the client” when it does not know the client', async () => {
      const b = bench();
      const fail = await failure(pickTrending(b.base({ niche: null, client: null })));
      expect(fail.message).toBe("Add a Reels niche line to the client's style, or name a song.");
    });

    it('is needs_key with no key, before any call, and the key is also read from the .env file', async () => {
      const b = bench();
      const net = apify(answers());
      const fail = await failure(
        pickTrending(
          b.base({ env: { PATH: '' }, fetch: net.fetch, getSong: getter(allDrop).getSong }),
        ),
      );
      expect(fail.code).toBe('needs_key');
      expect(fail.message).toContain('APIFY_TOKEN');
      expect(net.calls).toEqual([]);

      const envFile = join(b.root, 'repo.env');
      writeFileSync(envFile, `# keys\nAPIFY_TOKEN=${TOKEN}\n`);
      const pick = await pickTrending(
        b.base({ env: { PATH: '' }, envFile, fetch: net.fetch, getSong: getter(allDrop).getSong }),
      );
      expect(pick.title).toBe('Lost In Space');
      expect((net.calls[0] as FetchCall).headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('is needs_key when Apify refuses the key or has no credit, without the key in the message', async () => {
      for (const status of [401, 403, 402]) {
        const b = bench();
        const fail = await failure(
          pickTrending(
            b.base({
              fetch: apify({ hashtags: new Response('no', { status }) }).fetch,
              getSong: getter(allDrop).getSong,
            }),
          ),
        );
        expect(fail.code).toBe('needs_key');
        expect(fail.message).not.toContain(TOKEN);
        expect(existsSync(b.cacheFile)).toBe(false);
      }
    });

    it('is needs_key (not a degraded pick) when the audio scraper is the one that has no credit', async () => {
      const b = bench();
      const fail = await failure(
        pickTrending(
          b.base({
            fetch: apify({ hashtags: niche(), sounds: new Response('no', { status: 402 }) }).fetch,
            getSong: getter(allDrop).getSong,
          }),
        ),
      );
      expect(fail.code).toBe('needs_key');
    });

    it('is blocked when Apify does not answer (one retry), and failed for another status', async () => {
      const b = bench();
      const down = apify({ hashtags: new Response('down', { status: 503 }) });
      const fail = await failure(
        pickTrending(b.base({ fetch: down.fetch, getSong: getter(allDrop).getSong })),
      );
      expect(fail.code).toBe('blocked');
      expect(fail.message).toContain('#fpv #fpvdrone');
      expect(down.calls).toHaveLength(2);
      const odd = apify({ hashtags: new Response('?', { status: 400 }) });
      const other = await failure(
        pickTrending(b.base({ fetch: odd.fetch, getSong: getter(allDrop).getSong })),
      );
      expect(other.code).toBe('failed');
      expect(odd.calls).toHaveLength(1);
    });

    it('does not pay for a timed-out run twice', async () => {
      const b = bench();
      const slow = fakeFetch(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      const fail = await failure(
        pickTrending(b.base({ fetch: slow.fetch, getSong: getter(allDrop).getSong })),
      );
      expect(fail.code).toBe('blocked');
      expect(slow.calls).toHaveLength(1);
    });

    it('is no_trending when Apify finds no recent reels, or only old ones', async () => {
      const b = bench();
      for (const items of [[], [reel('OLD', 5, LOST_A, 45)], [{ error: 'x' }]]) {
        const net = apify({ hashtags: items });
        const fail = await failure(
          pickTrending(b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong })),
        );
        expect(fail.code).toBe('no_trending');
        expect(fail.message).toContain('no reels from the last 30 days');
        expect(net.calls).toHaveLength(1);
      }
    });

    it('is no_trending when every top reel uses original audio, and asks for no sounds', async () => {
      const b = bench();
      const net = apify({
        hashtags: Array.from({ length: 8 }, (_, i) => reel(`O${i}`, 100 - i, ORIGINAL)),
      });
      const fail = await failure(
        pickTrending(b.base({ fetch: net.fetch, getSong: getter(allDrop).getSong })),
      );
      expect(fail.code).toBe('no_trending');
      expect(fail.message).toContain('original audio');
      expect(net.calls).toHaveLength(1);
      expect(existsSync(b.cacheFile)).toBe(false);
    });

    it('never picks original audio, whatever its numbers', async () => {
      const b = bench();
      const items = [
        ...Array.from({ length: 12 }, (_, i) => reel(`O${i}`, 200_000 - i, ORIGINAL)),
        reel('S1', 1_000, LATE),
      ];
      const songs = getter({ 'Late One': song('drop'), 'Original audio': song('drop') });
      const pick = await pickTrending(
        b.base({
          fetch: apify({
            hashtags: items,
            sounds: [soundRow('666', 42, null), soundRow('444', 9e9, true, 1)],
          }).fetch,
          getSong: songs.getSong,
        }),
      );
      expect(pick.title).toBe('Late One');
      expect(songs.calls.map((c) => c.title)).toEqual(['Late One']);
    });

    it('keeps the key out of the cache file, the cost log and every message', async () => {
      const b = bench();
      await pickTrending(
        b.base({ fetch: apify(answers()).fetch, getSong: getter(allDrop).getSong }),
      );
      for (const name of readdirSync(join(b.dataDir, 'trends'))) {
        expect(readFileSync(join(b.dataDir, 'trends', name), 'utf8')).not.toContain(TOKEN);
      }
    });
  });

  describe('with the real getter and its songs-cache', () => {
    const GIVEN = { id: '777', song: 'Blinding Lights', artist: 'The Weeknd' };

    it('keeps the candidate in the songs-cache (14 days, 300 MB, oldest out) and a second pick reuses it', async () => {
      const b = bench();
      const gb = makeBench(ffmpeg as string, ffprobe as string, {
        searches: { 'The Weeknd Blinding Lights': 'blinding' },
        downloads: { blnd0Topic1: { seconds: 12 } },
      });
      try {
        // An expired download and two 200 MB ones (sparse) already in the cache.
        const old = join(b.cacheDir, 'yt-expired00001.m4a');
        writeFileSync(old, 'x');
        utimesSync(old, new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
        for (const [name, age] of [
          ['yt-bigoldest001.m4a', 3],
          ['yt-bignewer0001.m4a', 1],
        ] as const) {
          const file = join(b.cacheDir, name);
          writeFileSync(file, '');
          truncateSync(file, 200 * 1024 * 1024);
          utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY));
        }
        const net = apify({
          hashtags: Array.from({ length: 6 }, (_, i) => reel(`B${i}`, 1_000 - i, GIVEN)),
          sounds: [soundRow('777', 1_000_000, true, 2)],
        });
        const itunes = fakeFetch((call) =>
          call.url.startsWith('https://itunes.apple.com/') ? json({ results: [] }) : undefined,
        );
        const options = b.base({
          niche: '#fpv',
          fetch: net.fetch,
          tools: gb.tools,
          getSongOptions: {
            fetch: itunes.fetch,
            envFile: gb.options().envFile,
            retryMs: 1,
            now: () => NOW,
          },
          now: () => NOW,
        });
        const pick = await pickTrending({
          ...options,
          env: {
            PATH: process.env.PATH ?? '',
            APIFY_TOKEN: TOKEN,
            HOME: gb.root,
            FAKE_YTDLP: gb.scenarioFile,
          },
        });
        expect(pick).toMatchObject({
          title: 'Blinding Lights',
          artist: 'The Weeknd',
          link: 'https://www.youtube.com/watch?v=blnd0Topic1',
        });
        // The fake yt-dlp's download is silence, which has no drop: the pick says so.
        expect(pick.note).toBe(
          'The one song rising on Reels in #fpv does not fit the cut (it is 0:12, shorter than the 0:15 cut), but it is the pick.',
        );
        expect(gb.calls().filter((c) => c.kind === 'download')).toHaveLength(2);
        // The expired file is gone, the oldest big one went to get under 300 MB, the download stayed.
        const left = readdirSync(b.cacheDir).sort();
        expect(left).toEqual(['yt-bignewer0001.m4a', 'yt-blnd0Topic1.m4a'].sort());
        expect(statSync(join(b.cacheDir, 'yt-blnd0Topic1.m4a')).size).toBeGreaterThan(0);

        // The same song again: the cache is hit (no new download).
        const again = await pickTrending({
          ...options,
          env: { PATH: process.env.PATH ?? '', FAKE_YTDLP: gb.scenarioFile, HOME: gb.root },
        });
        expect(again.cached).toBe(true);
        expect(gb.calls().filter((c) => c.kind === 'download')).toHaveLength(2);
      } finally {
        gb.dispose();
      }
    });
  });
});

// --- the contract ---------------------------------------------------------------------------------

describe('the contract', () => {
  it('declares the Apify actors the plan names, and no chart', () => {
    expect(ACTORS).toEqual({
      hashtags: 'apify~instagram-hashtag-scraper',
      accounts: 'apify~instagram-reel-scraper',
      sounds: 'memo23~instagram-audio-scraper',
    });
    const source = readFileSync(
      new URL('../../assets/music/trending-pick.mjs', import.meta.url),
      'utf8',
    );
    // Strip comments: only code may not reach a chart.
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/spotify|apple|shazam|itunes|billboard/i);
  });

  it('every pick fits a Song’s trending field and the cache fits its schema', () => {
    const b = bench();
    expect(b.cacheFile).toContain(`${TRENDING_CACHE.dir}/`);
    songTrendingSchema.parse({ reels: null, isTrending: null, nicheTop20: 0, niche: '#a' });
  });
});
