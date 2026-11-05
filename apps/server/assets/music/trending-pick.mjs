// The trending pick (Songs, SG10; plan: Plane page "Songs — architecture & dev plan", "The flow").
// "A trending song" for one job, on demand: the music script's `song --trending` calls it, and it
// answers the song to get, which the command then gets and cuts like a named one. A plain-Node ES
// module next to the getter, like get-song.mjs: no TypeScript, no workspace imports. What it
// returns matches the shared contract (packages/shared/src/domain/music.ts: songTrendingSchema;
// domain/songs.ts: trendingCacheSchema, songTrendingEventSchema), and its tests check that.
//
//   const pick = await pickTrending({ clientId, client, niche, lengthMs, cutBpm, dropMs, env,
//                                      dataDir, cacheDir });
//
//   pick  { title, artist, link, trending: { reels, isTrending, nicheTop20, niche }, note, event,
//           considered, cached, cost }
//         title / artist are as Instagram shows the sound (what its Add audio picker says); link is
//         the YouTube link of the copy that was measured; note is one sentence for the command's
//         line when the pick is not a clean fit (else null); event is SG0's `music.song.trending`
//         event (niche, how many songs were looked at, the pick); considered lists the songs
//         looked at, with what was measured.
//   throws SongError { code, message }: needs_key (no APIFY_TOKEN, or Apify refused it or has no
//         credit), no_trending (no niche, no song in the niche's reels, or none of the top ones can
//         be found on YouTube Music), blocked (Apify down), and what the getter throws (tool_missing,
//         update_needed, failed …). The command turns them into songFailure.
//
// How it picks. ONLY Instagram's own signals rank a sound; a hit on Spotify, Apple or Shazam's
// charts is not a Reels trend (the owner), and no chart is ever asked.
//   1. The niche is the client's "Reels niche:" line (hashtags and @accounts), read by the song
//      command. Hashtags go to Apify's Instagram hashtag scraper (recent reels), accounts to its
//      reel scraper; the reels of the last 30 days are sorted by plays and the top 20 kept.
//   2. The top 20 are grouped by sound; "Original audio" is not a song and is dropped. Few songs
//      there: the next reels' songs are added after them (they count 0 of the top 20).
//   3. One run of the Instagram audio scraper (memo23/instagram-audio-scraper, by track id) gives each
//      sound's reel count and Instagram's trending flag and rank.
//   4. Rank: how many of the top 20 use it, then Instagram's trending flag (then its rank), then its
//      reel count (`rankSounds`).
//   5. The top 3 are got (the getter, into the songs-cache: 14 days, 300 MB) and measured as the
//      song command measures (song-part.mjs): tempo against the cut's (within 4% of 1, 2 or 0.5
//      times), a clear rise in a song that holds the cut (the part starts on it and the editor
//      lines the cut's drop up with it), a hook in the first 3 s of the part (`measureFit`). The
//      first of them, in rank order, that fits is the pick; when none fits it is the top-ranked
//      one that could be got, and the note says so.
// The niche's lookup is kept in <dataDir>/trends/<clientId>.json for 7 days (same niche only); a
// fresh lookup costs well under $1 (every run has a max charge) and its estimated cost is logged to
// <dataDir>/trends/apify-runs.jsonl. The key is read by the getter's code (env, then the repo's
// .env) and only ever sent in an Authorization header.
//
// Writes: the cache file (atomically), the cost log, and a hidden work folder in the songs-cache
// (removed at the end). Network: Apify, and what the getter reaches (iTunes, YouTube Music).
//
// For tests: `fetch` (a fake), `getSong` (a fake getter), `beatFinder`, `envFile`, `now`, `retryMs`,
// `timeouts`, `tools` and `signal` are options.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apifyContext,
  apifyItems,
  findTool,
  isOriginalSound,
  normName,
  readApifyToken,
  getSong as realGetSong,
  SongError,
  songNameOfSound,
} from './get-song.mjs';
import { findBeats as realFindBeats } from './song-beats.mjs';
import { choosePart, energyEnvelope, PART, readWavInfo, windowPower } from './song-part.mjs';

const DAY_MS = 86_400_000;

/** What the pick reads, asks for and decides with. */
export const TRENDING = {
  /** TRENDING_CACHE in the shared contract: <dataDir>/trends/<clientId>.json. */
  cache: { dir: 'trends', maxAgeDays: 7 },
  /** The cost log, next to the cache files. */
  costLog: 'apify-runs.jsonl',
  /** Reels older than this are not trending now. */
  lookbackDays: 30,
  /** The reels that decide: the most played ones. */
  topReels: 20,
  /** Hashtags and accounts read from a niche. */
  hashtagsMax: 5,
  accountsMax: 3,
  /** Reels asked for per hashtag (about 220 in all, which is about $0.60) and per account. */
  perHashtag: { total: 220, min: 30, max: 120 },
  perAccount: 25,
  /** Songs with fewer than this many in the top 20 get the next reels' songs as extra candidates. */
  wantSongs: 5,
  /** Sound ids sent to the audio scraper. */
  soundsMax: 12,
  /** Songs got and measured, best ranked first. */
  candidates: 3,
  /** The most each run may cost in US dollars (together under $1). */
  budget: { hashtags: 0.6, accounts: 0.25, sounds: 0.1 },
  /** Prices at Apify's free tier, for the logged estimate (a run is never charged above its max). */
  prices: { result: 0.0026, reel: 0.0026, reelStart: 0.006, sound: 0.004 },
  run: { timeoutS: 240, callTimeoutMs: 290_000, soundsTimeoutS: 120, soundsCallTimeoutMs: 150_000 },
  fit: {
    /** The song's tempo must be this close to 1, 2 or 0.5 times the cut's. */
    tempoTolerance: 0.04,
    /** The hook: the part's first 3 s are at least this much of its loudest 3 s (-6 dB in power). */
    hookMs: 3_000,
    hookShare: 0.25,
    hookStepMs: 500,
  },
  ffmpegTimeoutMs: 120_000,
};

/** The Apify actors (ids as the API takes them: owner~name). */
export const ACTORS = {
  hashtags: 'apify~instagram-hashtag-scraper',
  accounts: 'apify~instagram-reel-scraper',
  sounds: 'memo23~instagram-audio-scraper',
};

const text = (value) =>
  typeof value === 'string' ? value.trim() : Number.isFinite(value) ? String(value) : '';
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const wholeOrNull = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

// --- the niche -----------------------------------------------------------------------------------

/**
 * A niche line's hashtags and accounts: `{ hashtags, accounts, text }`. "#FPV #fpvdrone @falcon_fpv"
 * is hashtags ["fpv", "fpvdrone"], accounts ["falcon_fpv"] and text "#fpv #fpvdrone @falcon_fpv"
 * (lower case, no repeats, at most 5 hashtags and 3 accounts).
 */
export function parseNiche(line) {
  const tags = String(line ?? '').match(/#[\p{L}\p{N}_]+|@[\p{L}\p{N}_.]*[\p{L}\p{N}_]/gu) ?? [];
  const hashtags = [];
  const accounts = [];
  for (const tag of tags) {
    const name = tag.slice(1).toLowerCase();
    const list = tag[0] === '#' ? hashtags : accounts;
    const max = tag[0] === '#' ? TRENDING.hashtagsMax : TRENDING.accountsMax;
    if (!list.includes(name) && list.length < max) list.push(name);
  }
  return {
    hashtags,
    accounts,
    text: [...hashtags.map((h) => `#${h}`), ...accounts.map((a) => `@${a}`)].join(' '),
  };
}

/** A niche for comparing two lookups: its tags, sorted. */
const nicheKey = (niche) => niche.text.split(' ').sort().join(' ');

// --- the cache -----------------------------------------------------------------------------------

/** A client id that is safe as a file name. */
const safeId = (clientId) => String(clientId ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'client';

/** <dataDir>/trends/<clientId>.json (trendingCacheFile in the shared contract). */
export function trendingCachePath(dataDir, clientId) {
  return join(dataDir, TRENDING.cache.dir, `${safeId(clientId)}.json`);
}

/** One cached sound if it has the contract's shape (trendingSoundSchema), else `null`. */
function cachedSound(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const title = text(raw.title);
  const top = raw.nicheTop20;
  if (title === '' || typeof raw.isSong !== 'boolean') return null;
  if (!Number.isInteger(top) || top < 0 || top > 20) return null;
  return {
    igAudioId: text(raw.igAudioId) || null,
    title,
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    isSong: raw.isSong,
    reels: wholeOrNull(raw.reels),
    isTrending: typeof raw.isTrending === 'boolean' ? raw.isTrending : null,
    nicheTop20: top,
    url: text(raw.url) || null,
  };
}

/**
 * The cached lookup for this niche if it is there, less than 7 days old and not from the future;
 * else `null` (a broken file, another niche or an old one is no cache).
 */
export function readTrendingCache(file, niche, now) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (cache === null || typeof cache !== 'object' || cache.v !== 1) return null;
  if (typeof cache.niche !== 'string' || !Array.isArray(cache.sounds)) return null;
  if (nicheKey(parseNiche(cache.niche)) !== nicheKey(niche)) return null;
  const age = now - Date.parse(cache.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age >= TRENDING.cache.maxAgeDays * DAY_MS) return null;
  const sounds = cache.sounds.map(cachedSound).filter((sound) => sound !== null);
  return sounds.length === 0 ? null : { fetchedAt: cache.fetchedAt, sounds };
}

/** The cache file's content (trendingCacheSchema). */
function cacheDocument(clientId, niche, fetchedAt, sounds) {
  return {
    v: 1,
    clientId: safeId(clientId),
    niche: niche.text,
    fetchedAt: new Date(fetchedAt).toISOString(),
    sounds: sounds.map((s) => ({
      igAudioId: s.igAudioId,
      title: s.title,
      artist: s.artist,
      isSong: s.isSong,
      reels: s.reels,
      isTrending: s.isTrending,
      nicheTop20: s.nicheTop20,
      url: s.url,
    })),
  };
}

/** Writes a file whole or not at all: a temporary file beside it, then a rename. */
function writeAtomic(file, content) {
  mkdirSync(join(file, '..'), { recursive: true });
  const part = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(part, content);
    renameSync(part, file);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}

// --- reels and sounds ----------------------------------------------------------------------------

/**
 * What a reel scraper item (the hashtag scraper's or the reel scraper's) says that the pick uses:
 * `{ id, plays, at, audioId, title, artist, original }`, or `null` for an item that is no reel (an
 * error row, no id). Fields (from the actors' pages): shortCode / id, videoPlayCount (igPlayCount,
 * videoViewCount), timestamp (ISO), ownerUsername, musicInfo { audio_id, song_name, artist_name,
 * uses_original_audio }. A named sound is a song unless its artist is the reel's own account (the
 * flag alone is not enough: a hit song uploaded as a sound has it too), and a song uploaded as a
 * sound ("Somewhere only we know - Keane" by sofia.peters) is named by its title and artist
 * ("Somewhere only we know" by Keane), as in get-song.mjs.
 */
export function readReel(item) {
  if (item === null || typeof item !== 'object' || text(item.error) !== '') return null;
  const id = text(item.shortCode) || text(item.id);
  if (id === '') return null;
  const music = item.musicInfo !== null && typeof item.musicInfo === 'object' ? item.musicInfo : {};
  const audioId = text(music.audio_id);
  const plays =
    finite(item.videoPlayCount) ?? finite(item.igPlayCount) ?? finite(item.videoViewCount);
  const at = Date.parse(text(item.timestamp));
  const owner = text(item.ownerUsername);
  const song = songNameOfSound(music.song_name, music.artist_name, owner);
  return {
    id,
    plays: plays ?? 0,
    at: Number.isFinite(at) ? at : null,
    audioId: audioId === '0' ? '' : audioId,
    title: song.title,
    artist: song.artist,
    original: isOriginalSound(music.song_name, music.uses_original_audio, music.artist_name, owner),
  };
}

/** The reels of the last 30 days, each once, the most played first. */
export function recentReels(items, now) {
  const seen = new Set();
  const reels = [];
  for (const item of items) {
    const reel = readReel(item);
    if (reel === null || seen.has(reel.id)) continue;
    if (
      reel.at !== null &&
      (now - reel.at > TRENDING.lookbackDays * DAY_MS || reel.at - now > DAY_MS)
    ) {
      continue;
    }
    seen.add(reel.id);
    reels.push(reel);
  }
  return reels.sort((a, b) => b.plays - a.plays || (b.at ?? 0) - (a.at ?? 0));
}

/** One song's key: the same title and artist under two sound ids is one song. */
const songKey = (title, artist) => `${normName(title)}|${normName(artist)}`;

/**
 * The songs in the reels (sorted most played first): `[{ ids, igAudioId, title, artist, isSong,
 * reels: null, isTrending: null, trendRank: null, nicheTop20, url }]`. `nicheTop20` is how many of
 * the top 20 reels use the song; when fewer than `wantSongs` songs are in the top 20, the next
 * reels' songs follow with 0. "Original audio" and reels with no sound are not songs.
 */
export function soundsOfReels(reels) {
  const bySong = new Map();
  const add = (reel, inTop) => {
    if (reel.original || reel.audioId === '' || reel.title === '') return;
    const key = songKey(reel.title, reel.artist);
    let sound = bySong.get(key);
    if (sound === undefined) {
      if (!inTop && bySong.size >= TRENDING.wantSongs * 2) return;
      sound = {
        ids: [],
        igAudioId: reel.audioId,
        title: reel.title,
        artist: reel.artist,
        isSong: true,
        reels: null,
        isTrending: null,
        trendRank: null,
        nicheTop20: 0,
        url: null,
      };
      bySong.set(key, sound);
    }
    if (!sound.ids.includes(reel.audioId)) sound.ids.push(reel.audioId);
    if (inTop) sound.nicheTop20 = Math.min(TRENDING.topReels, sound.nicheTop20 + 1);
  };
  const top = reels.slice(0, TRENDING.topReels);
  for (const reel of top) add(reel, true);
  if (bySong.size < TRENDING.wantSongs) {
    for (const reel of reels.slice(TRENDING.topReels)) {
      if (bySong.size >= TRENDING.wantSongs) break;
      add(reel, false);
    }
  }
  for (const sound of bySong.values()) {
    sound.url = `https://www.instagram.com/reels/audio/${sound.igAudioId}/`;
  }
  return [...bySong.values()];
}

/**
 * Puts Instagram's numbers on the sounds from the audio scraper's rows (`rowType: "sound"`:
 * trackId, totalReelsUsingSound, isTrending, trendRank, isOriginalAudio). A song under several ids
 * takes the biggest count, the trending flag if any id has it and the best rank. A sound the
 * scraper calls original audio is no song.
 */
export function addInstagramNumbers(sounds, rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || text(row.error) !== '') continue;
    const id = text(row.trackId);
    if (id !== '') byId.set(id, row);
  }
  for (const sound of sounds) {
    const found = sound.ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
    if (found.length === 0) continue;
    const counts = found
      .map((row) => wholeOrNull(row.totalReelsUsingSound))
      .filter((n) => n !== null);
    if (counts.length > 0) sound.reels = Math.max(...counts);
    const flags = found.map((row) => row.isTrending).filter((flag) => typeof flag === 'boolean');
    if (flags.length > 0) sound.isTrending = flags.some((flag) => flag);
    const ranks = found.map((row) => finite(row.trendRank)).filter((rank) => rank !== null);
    if (ranks.length > 0) sound.trendRank = Math.min(...ranks);
    if (found.every((row) => row.isOriginalAudio === true)) sound.isSong = false;
  }
  return sounds;
}

/**
 * The songs, best first, by Instagram's own signals only: how many of the niche's top 20 reels use
 * it, then Instagram's trending flag (a lower trend rank first), then its reel count. Never a chart.
 */
export function rankSounds(sounds) {
  const trending = (sound) => (sound.isTrending === true ? 1 : 0);
  // A trending sound with a rank comes before one without; the lower rank comes first.
  const rank = (sound) => sound.trendRank ?? Number.POSITIVE_INFINITY;
  return sounds
    .filter((sound) => sound.isSong)
    .sort(
      (a, b) =>
        b.nicheTop20 - a.nicheTop20 ||
        trending(b) - trending(a) ||
        (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) ||
        (b.reels ?? -1) - (a.reels ?? -1) ||
        a.title.localeCompare(b.title),
    );
}

// --- the fit -------------------------------------------------------------------------------------

/** Whether a song's tempo is the cut's, doubled or halved, within the tolerance; `null` when either is unknown. */
export function tempoFits(songBpm, cutBpm, tolerance = TRENDING.fit.tempoTolerance) {
  if (!(songBpm > 0) || !(cutBpm > 0)) return null;
  return [1, 2, 0.5].some((times) => Math.abs(songBpm / (cutBpm * times) - 1) <= tolerance);
}

/** m:ss for messages. */
function clock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Decodes a song to the 48 kHz stereo float WAV that song-part.mjs reads. */
function decode(ffmpeg, file, wav) {
  const ran = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      file,
      '-vn',
      '-ac',
      '2',
      '-af',
      `aresample=${PART.sampleRate}`,
      '-c:a',
      'pcm_f32le',
      '-f',
      'wav',
      wav,
    ],
    { timeout: TRENDING.ffmpegTimeoutMs },
  );
  if (ran.status !== 0 || !existsSync(wav)) {
    throw new SongError('failed', 'The song could not be decoded to measure it.');
  }
}

/**
 * Whether a song fits the cut: reads the audio file `file`, finds the part of it the song command
 * would cut (the same `choosePart` of song-part.mjs, with the beat finder's beats and sections, or
 * by loudness alone when the beat finder does not run) and judges three things.
 *   tempo  within 4% of 1, 2 or 0.5 times the cut's BPM (`cutBpm`); unknown (no cut tempo, or the
 *          beat finder did not give one) does not count against it.
 *   drop   the song holds the whole cut and the part has a clear rise of loudness (at least
 *          `PART.minRiseDb`). The part starts on the downbeat before the biggest rise and the
 *          editor then lines the cut's drop (plan.json's) up with it, so the cut's own drop is not
 *          judged here.
 *   hook   the first 3 s of the part are at least a quarter of the power of its loudest 3 s.
 * Resolves `{ fits, why, durationMs, bpm, tempo, partStartMs, dropAtMs, riseDb, hook }`; `why` lists
 * in plain words what does not fit, `dropAtMs` is where the part's biggest rise is in the song.
 * `work` is a folder for the temporary WAV (removed again).
 */
export async function measureFit({
  file,
  work,
  lengthMs,
  cutBpm = null,
  env = process.env,
  tools = {},
  beatFinder = realFindBeats,
}) {
  // A tool given as null is "not installed"; one left out is looked for.
  const ffmpeg = tools.ffmpeg !== undefined ? tools.ffmpeg : findTool('ffmpeg', env);
  if (ffmpeg === null) {
    throw new SongError(
      'tool_missing',
      'ffmpeg is missing, so the song cannot be measured. Run brew install ffmpeg',
    );
  }
  mkdirSync(work, { recursive: true });
  const wav = join(work, 'measure.wav');
  const why = [];
  try {
    decode(ffmpeg, file, wav);
    const info = readWavInfo(wav);
    const durationMs = (info.frames * 1000) / info.rate;
    const envelope = energyEnvelope(wav, info);
    const beats = (await beatFinder(wav, env, work, { findTool }))?.data ?? null;
    const bpm = beats?.bpm ?? null;

    const tempo = tempoFits(bpm, cutBpm);
    if (tempo === false) {
      why.push(`its tempo (${Math.round(bpm)} BPM) is not the cut's ${Math.round(cutBpm)} BPM`);
    }

    // The part the song command would cut: does it have a drop, in a song that holds the cut?
    const cut = Number.isFinite(lengthMs) && lengthMs > 0 ? lengthMs : 30_000;
    const part = choosePart({
      durationMs,
      cutMs: cut,
      envelope,
      beatsMs: beats?.beatsMs ?? [],
      downbeatsMs: beats?.downbeatsMs ?? [],
      sectionStartsMs: beats?.sectionStartsMs ?? [],
      bpm,
    });
    // A cut over the longest part there can be is held by a part of that length.
    const holdsCut = durationMs >= Math.min(cut, PART.maxMs);
    if (!holdsCut) why.push(`it is ${clock(durationMs)}, shorter than the ${clock(cut)} cut`);
    else if (!part.clear) why.push('it has no clear drop');

    // The hook: does the part open at nearly its loudest?
    const { hookMs, hookShare, hookStepMs } = TRENDING.fit;
    const opening = windowPower(envelope, part.startMs, part.startMs + hookMs);
    let loudest = opening;
    const last = Math.min(part.startMs + part.lengthMs, durationMs) - hookMs;
    for (let at = part.startMs; at <= last; at += hookStepMs) {
      loudest = Math.max(loudest, windowPower(envelope, at, at + hookMs));
    }
    const hook = loudest <= 0 || opening >= loudest * hookShare;
    if (holdsCut && part.clear && !hook) why.push('it opens quietly');

    return {
      fits: tempo !== false && holdsCut && part.clear && hook,
      why,
      durationMs: Math.round(durationMs),
      bpm,
      tempo,
      partStartMs: Math.round(part.startMs),
      dropAtMs: part.clear && part.dropMs !== null ? Math.round(part.dropMs) : null,
      riseDb: Math.round(part.riseDb * 10) / 10,
      hook,
    };
  } finally {
    rmSync(wav, { force: true });
  }
}

// --- Apify ---------------------------------------------------------------------------------------

/** YYYY-MM-DD, UTC. */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The words of Apify's failures for this lookup. */
function says(niche) {
  return {
    down: `Apify did not answer, so the reels in ${niche.text} could not be read. Try again in a while.`,
    status: (code) => `Apify could not read the reels in ${niche.text} (it answered ${code}).`,
    unreadable: `Apify's answer for the reels in ${niche.text} could not be read.`,
    noKey: 'Apify refused the key. Check APIFY_TOKEN in .env.',
    noCredit:
      'Apify says the account has no credit or hit its limit, so a trending song cannot be picked. Check the Apify account.',
  };
}

/**
 * Asks Apify for the niche's recent reels and the sounds' numbers. Resolves
 * `{ sounds, reels, items, degraded }`: the songs found (see `soundsOfReels`), how many reels were
 * read, the items each run gave (for the cost), and whether the numbers of the audio scraper are
 * missing (the pick then goes by the reels alone).
 */
async function lookUp(ctx, niche, now) {
  const items = { hashtags: 0, accounts: 0, sounds: 0 };
  const all = [];
  const limits = (maxItems, maxChargeUsd) => ({
    maxItems,
    maxChargeUsd,
    timeoutS: TRENDING.run.timeoutS,
    callTimeoutMs: TRENDING.run.callTimeoutMs,
    retryOnTimeout: false,
    says: says(niche),
  });
  if (niche.hashtags.length > 0) {
    const { total, min, max } = TRENDING.perHashtag;
    const each = Math.max(min, Math.min(max, Math.floor(total / niche.hashtags.length)));
    const got = await apifyItems(
      ctx,
      ACTORS.hashtags,
      { hashtags: niche.hashtags, resultsType: 'reels', resultsLimit: each },
      'Instagram',
      limits(each * niche.hashtags.length, TRENDING.budget.hashtags),
    );
    items.hashtags = got.length;
    all.push(...got);
  }
  if (niche.accounts.length > 0) {
    const got = await apifyItems(
      ctx,
      ACTORS.accounts,
      {
        username: niche.accounts,
        resultsLimit: TRENDING.perAccount,
        onlyPostsNewerThan: isoDay(now - TRENDING.lookbackDays * DAY_MS),
        skipPinnedPosts: true,
      },
      'Instagram',
      limits(TRENDING.perAccount * niche.accounts.length, TRENDING.budget.accounts),
    );
    items.accounts = got.length;
    all.push(...got);
  }
  const reels = recentReels(all, now);
  if (reels.length === 0) {
    throw new SongError(
      'no_trending',
      `Apify found no reels from the last ${TRENDING.lookbackDays} days in ${niche.text}. Check the Reels niche line in the client's style, or name a song.`,
    );
  }
  const sounds = soundsOfReels(reels);
  if (sounds.length === 0) {
    throw new SongError(
      'no_trending',
      `None of the top reels in ${niche.text} uses a song (they are all original audio). Name a song instead.`,
    );
  }

  // Instagram's own numbers for the sounds, best placed first, at most 12 ids.
  const ids = [];
  for (const sound of [...sounds].sort((a, b) => b.nicheTop20 - a.nicheTop20)) {
    for (const id of sound.ids) if (ids.length < TRENDING.soundsMax) ids.push(id);
  }
  let degraded = false;
  try {
    const rows = await apifyItems(ctx, ACTORS.sounds, { trackIds: ids }, 'Instagram', {
      maxItems: ids.length,
      maxChargeUsd: TRENDING.budget.sounds,
      timeoutS: TRENDING.run.soundsTimeoutS,
      callTimeoutMs: TRENDING.run.soundsCallTimeoutMs,
      retryOnTimeout: false,
      says: {
        ...says(niche),
        down: 'Apify did not answer for the sounds of the reels.',
        status: (code) => `Apify could not read the sounds of the reels (it answered ${code}).`,
        unreadable: "Apify's answer for the sounds of the reels could not be read.",
      },
    });
    items.sounds = rows.filter(
      (row) => row?.rowType === 'sound' || row?.trackId !== undefined,
    ).length;
    addInstagramNumbers(sounds, rows);
  } catch (error) {
    // A key that is refused or out of credit, or a stopped call, ends the pick; anything else only
    // costs the sounds' numbers (the niche's top 20 already ranks them).
    if (error?.aborted || error?.code === 'needs_key') throw error;
    degraded = true;
  }
  return { sounds, reels: reels.length, items, degraded };
}

/** What a lookup cost at the free tier's prices: an estimate, never above the runs' max charges. */
export function estimateCost(items) {
  const { result, reel, reelStart, sound } = TRENDING.prices;
  const usd =
    items.hashtags * result +
    (items.accounts > 0 ? reelStart + items.accounts * reel : 0) +
    items.sounds * sound;
  return Math.round(usd * 10_000) / 10_000;
}

/** One line in the cost log; never fails the pick. */
function logCost(dataDir, entry) {
  try {
    const dir = join(dataDir, TRENDING.cache.dir);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, TRENDING.costLog), `${JSON.stringify(entry)}\n`);
  } catch {
    // A log is only a convenience.
  }
}

// --- the pick ------------------------------------------------------------------------------------

/** Errors that end the pick whichever song was tried: the same thing would happen to the next. */
const ENDS_THE_PICK = ['tool_missing', 'update_needed', 'blocked', 'needs_key'];
/** Errors of one song: it is not on YouTube Music, or not any more. */
const ONE_SONG = ['not_found', 'unavailable', 'original_audio'];

/** The names of the tools the getter takes (the script's STUDIO_YT_DLP / STUDIO_DENO). */
function toolsFrom(env, given) {
  return {
    ...(env.STUDIO_YT_DLP ? { ytDlp: env.STUDIO_YT_DLP } : {}),
    ...(env.STUDIO_DENO ? { deno: env.STUDIO_DENO } : {}),
    ...(given ?? {}),
  };
}

/** Removes work folders an earlier, killed pick left in the songs-cache (older than an hour). */
function clearOldWork(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('.pick-')) continue;
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > 3_600_000) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // No cache folder yet.
  }
}

/** Takes the sound's numbers as the song command stores them (songTrendingSchema). */
function trendingOf(sound, niche) {
  return {
    reels: sound.reels,
    isTrending: sound.isTrending,
    nicheTop20: Math.max(0, Math.min(TRENDING.topReels, sound.nicheTop20)),
    niche: niche.text,
  };
}

/**
 * The trending song for a job: see the top of this file. `clientId` names the cache file, `client`
 * the folder name for the messages; `niche` is the "Reels niche:" line (or the run's --niche);
 * `lengthMs` and `cutBpm` are the cut's, from plan.json (`cutBpm` may be null; `dropMs`, the cut's
 * drop, is accepted and not judged, see `measureFit`); `dataDir` is the engine's data folder
 * (~/.studio-engine: the cache is <dataDir>/trends/) and `cacheDir` the songs-cache
 * (~/.studio-engine/songs-cache).
 */
export async function pickTrending(options) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const started = now();
  const niche = parseNiche(options.niche);
  const who = text(options.client) === '' ? 'the client' : `${text(options.client)}`;
  if (niche.text === '') {
    throw new SongError('no_trending', `Add a Reels niche line to ${who}'s style, or name a song.`);
  }
  const dataDir = options.dataDir;
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new SongError('failed', 'The trending pick needs the engine’s data folder.');
  }
  const signal = options.signal;
  const stopped = () => {
    if (!signal?.aborted) return;
    const error = new SongError('failed', 'Picking the trending song was stopped.');
    error.aborted = true;
    throw error;
  };
  stopped();

  // The niche's sounds: this week's lookup, else a fresh one.
  const cacheFile = trendingCachePath(dataDir, options.clientId);
  let sounds;
  let cached = false;
  let cost = null;
  let degraded = false;
  const hit = readTrendingCache(cacheFile, niche, started);
  if (hit !== null) {
    sounds = hit.sounds.map((sound) => ({
      ...sound,
      ids: sound.igAudioId === null ? [] : [sound.igAudioId],
      trendRank: null,
    }));
    cached = true;
  } else {
    if (readApifyToken(env, options.envFile) === null) {
      throw new SongError(
        'needs_key',
        'A trending song needs an Apify key: add APIFY_TOKEN to .env',
      );
    }
    const ctx = apifyContext({
      env,
      envFile: options.envFile,
      signal,
      fetch: options.fetch,
      retryMs: options.retryMs,
      timeouts: options.timeouts,
    });
    const found = await lookUp(ctx, niche, started);
    sounds = found.sounds;
    degraded = found.degraded;
    cost = { estimatedUsd: estimateCost(found.items), items: found.items };
    logCost(dataDir, {
      at: new Date(started).toISOString(),
      clientId: safeId(options.clientId),
      niche: niche.text,
      reels: found.reels,
      ...cost,
      maxUsd:
        Math.round(
          (TRENDING.budget.hashtags + TRENDING.budget.accounts + TRENDING.budget.sounds) * 100,
        ) / 100,
    });
    // Without Instagram's numbers the lookup is not worth a week.
    if (!degraded) {
      try {
        writeAtomic(
          cacheFile,
          `${JSON.stringify(cacheDocument(options.clientId, niche, started, sounds), null, 2)}\n`,
        );
      } catch {
        // The cache is only a convenience.
      }
    }
  }

  const ranked = rankSounds(sounds);
  if (ranked.length === 0) {
    throw new SongError(
      'no_trending',
      `No song is rising on Reels in ${niche.text} right now. Name a song instead.`,
    );
  }

  // The top 3, got and measured in rank order; the first that fits is the pick.
  const getSong = options.getSong ?? realGetSong;
  const songsCache = typeof options.cacheDir === 'string' ? options.cacheDir : null;
  const work = join(songsCache ?? tmpdir(), `.pick-${process.pid}`);
  if (songsCache !== null) clearOldWork(songsCache, started);
  const considered = [];
  const errors = [];
  let chosen = null;
  let first = null;
  try {
    for (const [index, sound] of ranked.slice(0, TRENDING.candidates).entries()) {
      stopped();
      const dir = join(work, String(index));
      const row = {
        title: sound.title,
        artist: sound.artist,
        nicheTop20: sound.nicheTop20,
        reels: sound.reels,
        isTrending: sound.isTrending,
        got: false,
        fits: false,
        why: [],
      };
      considered.push(row);
      try {
        const got = await getSong({
          title: sound.title,
          artist: sound.artist,
          version: null,
          link: null,
          workDir: dir,
          tools: toolsFrom(env, options.tools),
          env,
          signal,
          cacheDir: songsCache,
          ...options.getSongOptions,
        });
        row.got = true;
        const fit = await measureFit({
          file: got.full,
          work: dir,
          lengthMs: options.lengthMs,
          cutBpm: Number.isFinite(options.cutBpm) ? options.cutBpm : null,
          env,
          tools: options.tools,
          beatFinder: options.beatFinder,
        });
        row.fits = fit.fits;
        row.why = fit.why;
        const entry = { sound, meta: got.meta, fit };
        if (first === null) first = entry;
        if (fit.fits) {
          chosen = entry;
          break;
        }
      } catch (error) {
        if (error?.aborted) throw error;
        if (typeof error?.code !== 'string') {
          row.why = ['it could not be measured'];
          errors.push(
            new SongError('failed', `Measuring ${sound.title} failed: ${error?.message ?? error}`),
          );
        } else {
          row.why = [
            error.code === 'not_found' ? 'it is not on YouTube Music' : 'it could not be got',
          ];
          errors.push(error);
          if (ENDS_THE_PICK.includes(error.code)) throw error;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (chosen === null && first === null) {
    const other = errors.find((error) => !ONE_SONG.includes(error.code));
    if (other !== undefined) throw other;
    const names = considered.map((row) => row.title).join(', ');
    throw new SongError(
      'no_trending',
      `None of the songs rising on Reels in ${niche.text} (${names}) could be found on YouTube Music. Name a song instead.`,
    );
  }

  const notes = [];
  const pick = chosen ?? first;
  if (chosen === null) {
    const reasons = first.fit.why.length === 0 ? 'it does not fit' : first.fit.why.join(' and ');
    notes.push(
      considered.length === 1
        ? `The one song rising on Reels in ${niche.text} does not fit the cut (${reasons}), but it is the pick.`
        : `None of the ${considered.length} songs rising on Reels in ${niche.text} fits the cut, so this is the one most used there (${reasons}).`,
    );
  }
  if (degraded) {
    notes.push(
      'Instagram’s reel counts were not available, so the songs are ranked by the top reels alone.',
    );
  }
  const artist = pick.sound.artist === '' ? text(pick.meta?.artist) : pick.sound.artist;
  return {
    title: pick.sound.title,
    artist,
    link: text(pick.meta?.url) || null,
    trending: trendingOf(pick.sound, niche),
    note: notes.length === 0 ? null : notes.join(' '),
    event: {
      type: 'music.song.trending',
      at: new Date(now()).toISOString(),
      niche: niche.text,
      looked: considered.length,
      pick: { title: pick.sound.title, artist: artist === '' ? 'Unknown' : artist },
    },
    considered,
    cached,
    cost,
  };
}
