// The song getter (Songs, SG2; plan: Plane page "Songs — architecture & dev plan", "The flow").
// A plain-Node ES module the music script imports (SG3's `song` command), so it lives next to it.
// No TypeScript and no workspace imports, like make-music.mjs; what it returns matches the shared
// contract (packages/shared/src/domain/music.ts: songSchema's source / fullMs, SONG_FAILURE_CODES),
// and its tests check that. It never writes music.json or preview/music.mp3.
//
//   const { full, reel, meta } = await getSong({ title, artist, version, link, workDir, tools, env, signal });
//
//   full  the clean full track (workDir/song-full.m4a), or, when only the reel's own audio could be
//         had, the reel's audio (then full === reel)
//   reel  the reel's own audio (workDir/song-reel.m4a), kept for later (SG16); null for a name or a
//         YouTube/Spotify/Apple link
//   meta  { title, artist, site, via, url, id, fullMs }: songSchema's title and artist (as asked, or
//         as the reel says), source { site, via, url, id } and the whole song's length
//   throws SongError { code, message } with SONG_FAILURE_CODES' codes (needs_key, tool_missing,
//         original_audio, not_found, unavailable, blocked, update_needed, failed)
//
// How it gets a song:
// - An Instagram reel or a TikTok link goes through Apify (a downloader API), never through the site
//   itself and never with a browser's cookies: the actor's answer has the song's name and artist
//   and the reel's audio. Then the clean full track is got by that name (below). If no clean track
//   is found, the reel's audio is the song. "Original audio" has no song to look up: original_audio.
//   A song somebody uploaded as a sound (the actor's flag says "original" too, but the sound's author
//   is not the video's own account) is a song: it is looked up by its name (see `isOriginalSound`).
//   Such a sound is titled "Somewhere only we know - Keane" with the uploader as its artist: the
//   song and its real artist are read from the title (see `songNameOfSound`).
//   Needs APIFY_TOKEN (the environment, then the repo's git-ignored .env); it is only ever sent in
//   an Authorization header. One retry when Apify is down, then `blocked`.
// - A YouTube / YouTube Music link: yt-dlp -J --no-playlist for its metadata, then that video is
//   downloaded. A Spotify or Apple Music link only gives the name (Spotify's oEmbed and page, Apple's
//   iTunes Lookup). Any other site: not_found, naming the site.
// - A name (title + artist): the canonical length from iTunes Search (IL, then US; one call per
//   song), then YouTube Music's own search (music.youtube.com/search: its first results are the
//   song's official track; one yt-dlp info call per result looked at, see `findInMusic`), and, when
//   that gives nothing usable, yt-dlp's plain YouTube search ("ytsearch8:"), ranked (see
//   `rankCandidates`); then the download.
// - yt-dlp is for YouTube only; every yt-dlp failure goes through classifyYtDlpError. Tools are
//   absolute paths (launchd has no Homebrew PATH). A missing one is tool_missing.
//
// Writes: only inside `workDir` (song-full.*, song-reel.*), and, when `cacheDir` is given, one copy
// of each YouTube download there (the songs-cache, pruned to 14 days and 300 MB). Network: Apify,
// iTunes, Spotify, the reel's own audio URL and YouTube through yt-dlp, and nothing else. One
// getSong at a time per workDir; the process tree of yt-dlp / ffmpeg is stopped on `signal`.
//
// Plain Node, no dependencies. For tests: `fetch` (a fake), `tools` (a fake yt-dlp), `envFile`,
// `timeouts`, `retryMs` and `cacheDir` are options.

import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyYtDlpError } from './yt-dlp-errors.mjs';

/** SONG_VERSIONS in the shared contract. */
export const VERSIONS = ['original', 'sped up', 'slowed', 'remix'];

/** The files in workDir, without their extension (MUSIC_FILES' songFull and songReel in the script). */
export const WORK_FILES = { full: 'song-full', reel: 'song-reel' };

/** Where Homebrew puts the tools (DEFAULT_SONG_TOOLS in the server's config). */
export const DEFAULT_TOOLS = {
  ytDlp: '/opt/homebrew/bin/yt-dlp',
  deno: '/opt/homebrew/bin/deno',
};

/** APIFY_TOKEN_ENV in the server's config, and the repo's git-ignored .env it is read from. */
export const APIFY_TOKEN_ENV = 'APIFY_TOKEN';
export const ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));

/** Apify: the actors, and the limits every run gets (the most it may take and cost). */
export const APIFY = {
  base: 'https://api.apify.com',
  instagramActor: 'apify~instagram-reel-scraper',
  tiktokActor: 'clockworks~tiktok-scraper',
  /** The run's own time limit, in seconds (the synchronous endpoint gives up after 300). */
  runTimeoutS: 90,
  /** The most one run may cost, in US dollars (a reel costs about $0.003). */
  maxChargeUsd: 0.05,
  /**
   * The TikTok actor refuses a run whose cap is under $0.50 ("max-total-charge-usd-below-minimum", a
   * 400), so a TikTok link's cap is that minimum. One video still costs about $0.008 ($0.005 to start
   * plus $0.003 for the result), which is all the run is asked for (one post, one result).
   */
  tiktokMaxChargeUsd: 0.5,
  callTimeoutMs: 110_000,
  retryMs: 2_000,
};

/** iTunes Search and Lookup (about 20 calls a minute: one call per song, two at the most). */
export const ITUNES = {
  base: 'https://itunes.apple.com',
  countries: ['IL', 'US'],
  limit: 5,
  timeoutMs: 15_000,
};

/** How yt-dlp is called. */
export const YT_DLP = {
  searchCount: 8,
  maxFileSize: '60M',
  maxSeconds: 900,
  socketTimeoutS: 30,
  retries: 3,
  searchTimeoutMs: 60_000,
  infoTimeoutMs: 60_000,
  downloadTimeoutMs: 240_000,
};

/** YouTube Music's own search, tried before the plain YouTube search (see `findInMusic`). */
export const YT_MUSIC = {
  searchUrl: 'https://music.youtube.com/search',
  /**
   * The most results looked at in one song's lookup, over all its searches. Each costs one yt-dlp
   * info call (about 3 s) because the search's flat answer has only an id and a title.
   */
  maxInfoCalls: 3,
};

/** The ranking of YouTube's results (see `rankCandidates`). */
export const RANK = {
  /**
   * How far off the canonical length a result may be. An artist's own "Official Audio" upload is a
   * few seconds longer than the album track (Blinding Lights 204 s against iTunes' 200.0 s, Snowman
   * 168 s against 165.9 s), and with 3 s it was thrown out, so a hit song was not found at all or came
   * from a stranger's re-upload (SG13, real searches). The music video (263 s) stays out.
   */
  toleranceMs: 5_000,
  /** How far off the most viewed result's length, when there is no canonical length. */
  looseToleranceMs: 15_000,
  /** A sped-up version's length, as a share of the original's. */
  spedUp: { min: 0.8, max: 0.91 },
  /** A slowed version's. */
  slowed: { min: 1.05, max: 1.4 },
};

/** The songs-cache: downloaded songs, kept so the same song needs no new download. */
export const SONGS_CACHE = { maxAgeDays: 14, maxBytes: 300 * 1024 * 1024 };

/** The biggest reel audio (or video) taken from a reel's URL. */
export const REEL_AUDIO_MAX_BYTES = 60 * 1024 * 1024;

/** Words in a title that make a result something else than the song (unless it was asked for). */
const BANNED_WORDS = [
  'lyrics',
  'lyric',
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'loop',
  'looped',
  'hour',
  'hours',
  'reaction',
  'nightcore',
  'slowed',
  'reverb',
  '8d',
  // Hebrew: lyrics, live, cover, karaoke, playback, reaction.
  'מילים',
  'לייב',
  'קאבר',
  'קריוקי',
  'פלייבק',
  'ריאקשן',
];

/** Added to the banned words for a version that is not asking for them. */
const VERSION_WORDS = {
  'sped up': ['sped', 'speed', 'spedup', 'nightcore'],
  slowed: ['slowed', 'slow', 'reverb'],
  remix: ['remix'],
};
const KINDS_OF_VERSION = ['sped', 'speed', 'spedup', 'nightcore', 'slowed', 'slow', 'remix'];

/** A failure with its code (SONG_FAILURE_CODES): what the music script prints and exits with. */
export class SongError extends Error {
  constructor(code, message) {
    super(redact(message));
    this.name = 'SongError';
    this.code = code;
  }
}

/** Keys this process has read: `redact` takes each of them out, whatever they look like. */
const secrets = new Set();

/** Text with the Apify key taken out: the key this process read, anything shaped like one, and Bearer values. */
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('[key]');
  return out
    .replace(/apify_api_[A-Za-z0-9_-]+/g, 'apify_api_…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[key]')
    .replace(/([?&](?:token|key|api_key|apikey)=)[^&\s"']+/gi, '$1[key]');
}

/** One variable's value in a .env text, or `null`. */
function dotenvValue(text, name) {
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

/**
 * The Apify key: APIFY_TOKEN in `env`, then in the .env file; `null` when neither has one. The key
 * is remembered so `redact` can take it out of any message.
 */
export function readApifyToken(env = process.env, file = ENV_FILE) {
  let token = typeof env[APIFY_TOKEN_ENV] === 'string' ? env[APIFY_TOKEN_ENV].trim() : '';
  if (token === '') {
    try {
      token = (dotenvValue(readFileSync(file, 'utf8'), APIFY_TOKEN_ENV) ?? '').trim();
    } catch {
      // No .env: no key.
    }
  }
  if (token === '') return null;
  secrets.add(token);
  return token;
}

// --- words ---------------------------------------------------------------------------------------

/** The lower-case words of a text (letters and digits of any script, accents and niqqud dropped). */
function wordsOf(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * A song's or an artist's name for comparing: plain lower-case words, accents dropped, and the
 * credits ("(feat. X)", "feat. X") taken off. Other brackets stay: "(Remix)" is not the song.
 */
export function normName(text) {
  const base = String(text ?? '')
    .replace(/[([{]\s*(?:feat|ft|featuring|with|prod)\b[^)\]}]*[)\]}]/gi, ' ')
    .replace(/\b(?:feat|ft|featuring)\b.*$/i, ' ');
  return wordsOf(base).join(' ');
}

const hasHebrew = (text) => /[֐-׿]/.test(String(text ?? ''));
const hasLatin = (text) => /[A-Za-z]/.test(String(text ?? ''));

/** Whether two titles are the same song's: the same words, or one inside the other (3+ letters). */
function titlesMatch(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && ` ${long} `.includes(` ${short} `);
}

/** Whether two artists are the same: either name inside the other, or a shared word of 3+ letters. */
function artistsMatch(wanted, got) {
  const x = normName(wanted);
  const y = normName(got);
  if (x === '') return true;
  if (y === '') return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const inY = new Set(y.split(' '));
  return x.split(' ').some((word) => word.length >= 3 && inY.has(word));
}

// --- links ---------------------------------------------------------------------------------------

const INSTAGRAM_HOSTS = ['instagram.com', 'instagr.am'];
const TIKTOK_HOSTS = ['tiktok.com'];
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

const onHost = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * What a link is: `{ kind, host, url }` with `kind` instagram, tiktok, youtube, spotify, apple or
 * other; instagram has `code` (the reel's shortcode), youtube `id` and `music` (music.youtube.com),
 * spotify `trackId`, apple `trackId` and `country`. `problem` says why a link of a known site
 * cannot be read (a profile, an album, a playlist). `null` when it is not a link.
 */
export function classifyLink(text) {
  let raw = String(text ?? '').trim();
  if (raw === '' || /\s/.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return null;
  const parts = url.pathname.split('/').filter(Boolean);

  if (onHost(host, INSTAGRAM_HOSTS)) {
    const at = parts.findIndex((part) => ['reel', 'reels', 'p', 'tv'].includes(part));
    const code = at >= 0 ? parts[at + 1] : undefined;
    if (code === undefined || code === 'audio' || !/^[\w-]{5,}$/.test(code)) {
      return { kind: 'instagram', host, url, problem: 'it is not the link of a reel' };
    }
    return { kind: 'instagram', host, url, code };
  }
  if (onHost(host, TIKTOK_HOSTS)) {
    const short = host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || parts[0] === 't';
    const at = parts.indexOf('video');
    const code = short ? parts[parts.length - 1] : at >= 0 ? parts[at + 1] : undefined;
    if (code === undefined || !/^[\w-]{4,}$/.test(code)) {
      return { kind: 'tiktok', host, url, problem: 'it is not the link of a video' };
    }
    return { kind: 'tiktok', host, url, code };
  }
  if (onHost(host, YOUTUBE_HOSTS)) {
    let id = null;
    if (host === 'youtu.be') id = parts[0] ?? null;
    else if (['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
    else id = url.searchParams.get('v');
    const music = host === 'music.youtube.com';
    if (id === null || !/^[\w-]{6,20}$/.test(id)) {
      return { kind: 'youtube', host, url, music, problem: 'it is not the link of one video' };
    }
    return { kind: 'youtube', host, url, id, music };
  }
  if (host === 'open.spotify.com' || host === 'spotify.link') {
    const at = parts.indexOf('track');
    const trackId = at >= 0 ? parts[at + 1] : undefined;
    if (host === 'open.spotify.com' && trackId === undefined) {
      return { kind: 'spotify', host, url, problem: 'it is not the link of one song' };
    }
    return { kind: 'spotify', host, url, trackId };
  }
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    const country = /^[a-z]{2}$/i.test(parts[0] ?? '') ? parts[0].toLowerCase() : 'us';
    const fromQuery = url.searchParams.get('i');
    const last = parts[parts.length - 1] ?? '';
    const trackId = fromQuery ?? (parts.includes('song') && /^\d+$/.test(last) ? last : undefined);
    if (trackId === undefined || !/^\d+$/.test(trackId)) {
      return { kind: 'apple', host, url, country, problem: 'it is not the link of one song' };
    }
    return { kind: 'apple', host, url, country, trackId };
  }
  return { kind: 'other', host, url };
}

// --- ranking -------------------------------------------------------------------------------------

/** The words a title may not have, for this ask: the banned words, less those the ask has itself. */
function bannedWords(names, artist, version) {
  const askedWords = new Set(wordsOf(`${names.join(' ')} ${artist ?? ''}`));
  const banned = new Set(BANNED_WORDS.filter((word) => !askedWords.has(word)));
  if (version === 'slowed') for (const word of ['slowed', 'reverb']) banned.delete(word);
  if (version === 'sped up') banned.delete('nightcore');
  for (const word of KINDS_OF_VERSION) {
    if (!askedWords.has(word) && !(VERSION_WORDS[version] ?? []).includes(word)) banned.add(word);
  }
  return banned;
}

/** Whether a title's words (`wordsOf`) have a banned word or a length like "10 hours". */
const hasBannedWord = (words, banned) =>
  words.some((word) => banned.has(word) || /^\d+(?:h|hr|hrs|hour|hours)$/.test(word));

/**
 * YouTube's search results, best first, for the song asked. `entries` are yt-dlp's flat-playlist
 * entries (id, title, duration in s, channel, channel_is_verified, view_count; an info call's
 * `track` is the song's own title, which counts as the title too); `want` is
 * `{ title, artist, version, canonicalMs, names }` (`names`: other spellings of the title).
 *
 * Dropped: entries with no id or no length, live streams, 15 minutes or longer; titles with lyrics,
 * live, cover, karaoke, instrumental, loop, hour, reaction, nightcore, slowed, reverb or 8d (and
 * sped up / remix, when the version is not that), unless the version asks for it or the title asked
 * for has the word itself; entries more than 5 s off the canonical length (more than 15 s off the
 * most viewed entry's when there is none). A sped-up version must say so and be 80 to 91% of the
 * original's length (a slowed one 105 to 140%); a remix must say remix.
 * Preferred: a title that is the song's, then a channel ending " - Topic", then a verified channel,
 * then the artist's name in the channel, then the closest length (the most viewed, with no
 * canonical length).
 */
export function rankCandidates(entries, want) {
  const version = VERSIONS.includes(want.version) ? want.version : 'original';
  const canonicalMs =
    Number.isFinite(want.canonicalMs) && want.canonicalMs > 0 ? want.canonicalMs : null;
  const names = [want.title, ...(want.names ?? [])].filter((name) => name);
  const banned = bannedWords(names, want.artist, version);

  const artist = normName(want.artist);
  let list = [];
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!/^[\w-]{6,20}$/.test(id)) continue;
    if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') continue;
    if (!Number.isFinite(entry.duration) || entry.duration <= 0) continue;
    const durationMs = Math.round(entry.duration * 1000);
    if (durationMs >= YT_DLP.maxSeconds * 1000) continue;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const words = wordsOf(title);
    if (hasBannedWord(words, banned)) continue;
    if (version !== 'original' && !words.some((word) => VERSION_WORDS[version].includes(word))) {
      continue;
    }
    const channel = String(entry.channel ?? entry.uploader ?? '');
    list.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title,
      channel,
      durationMs,
      views: Number.isFinite(entry.view_count) ? entry.view_count : 0,
      topic: /\s-\sTopic$/i.test(channel),
      verified: entry.channel_is_verified === true,
      artistInChannel: artist.length >= 2 && normName(channel).includes(artist),
      // A song's own title (yt-dlp's `track`, when an info call had it) counts too.
      titleMatch: names.some(
        (name) =>
          titlesMatch(name, title) ||
          (typeof entry.track === 'string' && titlesMatch(name, entry.track)),
      ),
    });
  }

  let target = null;
  if (canonicalMs !== null && version !== 'remix') {
    const window =
      version === 'sped up' ? RANK.spedUp : version === 'slowed' ? RANK.slowed : { min: 1, max: 1 };
    const min = canonicalMs * window.min - RANK.toleranceMs;
    const max = canonicalMs * window.max + RANK.toleranceMs;
    list = list.filter((item) => item.durationMs >= min && item.durationMs <= max);
    target = (canonicalMs * (window.min + window.max)) / 2;
  } else if (canonicalMs === null && list.length > 0) {
    const reference = list.reduce((best, item) => (item.views > best.views ? item : best), list[0]);
    list = list.filter(
      (item) => Math.abs(item.durationMs - reference.durationMs) <= RANK.looseToleranceMs,
    );
  }

  const flag = (value) => (value ? 1 : 0);
  return list.sort(
    (a, b) =>
      flag(b.titleMatch) - flag(a.titleMatch) ||
      flag(b.topic) - flag(a.topic) ||
      flag(b.verified) - flag(a.verified) ||
      flag(b.artistInChannel) - flag(a.artistInChannel) ||
      (target === null ? 0 : Math.abs(a.durationMs - target) - Math.abs(b.durationMs - target)) ||
      b.views - a.views,
  );
}

/**
 * The iTunes result that is the song asked for (its length is the canonical one), or `null`: a song
 * (not a podcast, a video) with a length whose title is the asked title (or has it in it, and is
 * not a remix, live take … of it) and whose artist matches. An exact title comes first.
 */
export function pickCanonical(results, title, artist) {
  const exact = [];
  const loose = [];
  const wanted = normName(title);
  for (const result of Array.isArray(results) ? results : []) {
    if (result === null || typeof result !== 'object') continue;
    if (result.kind !== undefined && result.kind !== 'song') continue;
    if (!Number.isFinite(result.trackTimeMillis) || result.trackTimeMillis <= 0) continue;
    if (!artistsMatch(artist, result.artistName)) continue;
    if (normName(result.trackName) === wanted) exact.push(result);
    else if (titlesMatch(result.trackName, title) && !isAnotherVersion(result.trackName, title)) {
      loose.push(result);
    }
  }
  return exact[0] ?? loose[0] ?? null;
}

/** Whether a title has a word (remix, live, sped up …) that the asked title does not: another take. */
function isAnotherVersion(got, asked) {
  const known = new Set(wordsOf(asked));
  return wordsOf(got).some(
    (word) => !known.has(word) && (BANNED_WORDS.includes(word) || KINDS_OF_VERSION.includes(word)),
  );
}

// --- running tools -------------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((done, fail) => {
    if (signal?.aborted) return fail(stopped());
    const onAbort = () => {
      clearTimeout(timer);
      fail(stopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function stopped() {
  const error = new SongError('failed', 'Getting the song was stopped.');
  error.aborted = true;
  return error;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where a tool is: the env's MUSIC_<NAME> override, then PATH, Homebrew's and /usr/local's bin. */
export function findTool(name, env = process.env) {
  const override = env[`MUSIC_${name.toUpperCase()}`];
  if (override) return override;
  const dirs = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (dir !== '' && isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Stops a child and everything it started (its own process group), politely first. */
function killTree(child) {
  const send = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  send('SIGTERM');
  const hard = setTimeout(() => send('SIGKILL'), 2_000);
  hard.unref();
  child.once('close', () => clearTimeout(hard));
}

const OUTPUT_CAP = 32 * 1024 * 1024;

/**
 * Runs a program; resolves `{ code, stdout, stderr }` when it exits (any code) and rejects with
 * `{ timedOut: true }` (a SongError, `unavailable`), the stopped error or tool_missing. The whole
 * process tree is killed on the signal and on the timeout.
 */
function runTool(ctx, command, args, { timeoutMs, missing }) {
  return new Promise((done, fail) => {
    if (ctx.signal?.aborted) return fail(stopped());
    let child;
    try {
      child = spawn(command, args, {
        env: ctx.childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch {
      return fail(new SongError('tool_missing', missing));
    }
    let stdout = '';
    let stderr = '';
    let over = false;
    let timedOut = false;
    let aborted = false;
    const add = (text, chunk) => {
      const next = text + chunk.toString('utf8');
      if (next.length > OUTPUT_CAP) over = true;
      return over ? next.slice(0, OUTPUT_CAP) : next;
    };
    child.stdout.on('data', (chunk) => {
      stdout = add(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = add(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      finish();
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        fail(new SongError('tool_missing', missing));
      } else {
        fail(new SongError('failed', `Could not start ${command}: ${error.message}`));
      }
    });
    child.on('close', (code) => {
      finish();
      if (aborted) return fail(stopped());
      if (timedOut) {
        const error = new SongError('unavailable', 'It took too long, so it was stopped.');
        error.timedOut = true;
        return fail(error);
      }
      done({ code, stdout, stderr });
    });
  });
}

// --- the call's context --------------------------------------------------------------------------

/** Names that never reach yt-dlp or ffmpeg. */
const SECRET_NAME = /token|key|secret|password|credential/i;

function makeContext(options) {
  const env = options.env ?? process.env;
  const tools = { ...DEFAULT_TOOLS, ...(options.tools ?? {}) };
  // A tool given as null is "not installed"; one left out is looked for.
  const ffmpeg =
    options.tools?.ffmpeg !== undefined ? options.tools.ffmpeg : findTool('ffmpeg', env);
  const ffprobe =
    options.tools?.ffprobe !== undefined ? options.tools.ffprobe : findTool('ffprobe', env);
  const dirs = [ffmpeg, tools.ytDlp, tools.deno]
    .filter((path) => typeof path === 'string' && path.startsWith('/'))
    .map((path) => dirname(path));
  const childEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && !SECRET_NAME.test(name)) childEnv[name] = value;
  }
  childEnv.PATH = [...new Set([...dirs, ...(env.PATH ?? '').split(delimiter), '/usr/bin', '/bin'])]
    .filter(Boolean)
    .join(delimiter);
  return {
    workDir: resolve(options.workDir),
    tools: { ...tools, ffmpeg, ffprobe },
    env,
    envFile: options.envFile ?? ENV_FILE,
    childEnv,
    signal: options.signal,
    fetch: options.fetch ?? globalThis.fetch,
    cacheDir: options.cacheDir ?? null,
    now: options.now ?? (() => Date.now()),
    retryMs: options.retryMs ?? APIFY.retryMs,
    timeouts: {
      apify: APIFY.callTimeoutMs,
      itunes: ITUNES.timeoutMs,
      page: ITUNES.timeoutMs,
      reelAudio: 60_000,
      search: YT_DLP.searchTimeoutMs,
      info: YT_DLP.infoTimeoutMs,
      download: YT_DLP.downloadTimeoutMs,
      ffmpeg: 120_000,
      ...(options.timeouts ?? {}),
    },
  };
}

function throwIfStopped(ctx) {
  if (ctx.signal?.aborted) throw stopped();
}

const MISSING = {
  ytDlp: 'yt-dlp is missing, so the song cannot be downloaded. Run brew install yt-dlp deno',
  deno: 'deno is missing, and yt-dlp needs it to read YouTube. Run brew install yt-dlp deno',
  ffmpeg: 'ffmpeg is missing, so the song cannot be converted. Run brew install ffmpeg',
};

/** Throws tool_missing unless yt-dlp, deno and ffmpeg are there. */
function needYtDlp(ctx) {
  if (!isExecutable(ctx.tools.ytDlp)) throw new SongError('tool_missing', MISSING.ytDlp);
  if (!isExecutable(ctx.tools.deno)) throw new SongError('tool_missing', MISSING.deno);
  needFfmpeg(ctx);
}

function needFfmpeg(ctx) {
  if (ctx.tools.ffmpeg === null || !isExecutable(ctx.tools.ffmpeg)) {
    throw new SongError('tool_missing', MISSING.ffmpeg);
  }
}

/** A fetch that gives up after `timeoutMs` and when the call is stopped. */
async function fetchWith(ctx, url, init, timeoutMs) {
  throwIfStopped(ctx);
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  try {
    return await ctx.fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (ctx.signal?.aborted) throw stopped();
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw wrapped;
  }
}

/** The words that name what was asked for in a message: `"Title" by Artist`. */
function nameOf(want) {
  if (want.title) return want.artist ? `"${want.title}" by ${want.artist}` : `"${want.title}"`;
  return 'that song';
}

// --- yt-dlp --------------------------------------------------------------------------------------

function ytDlpArgs(ctx, rest) {
  return ['--ignore-config', '--js-runtimes', `deno:${ctx.tools.deno}`, ...rest];
}

/** Runs yt-dlp; a failure becomes the SongError classifyYtDlpError says. */
async function ytDlp(ctx, rest, { timeoutMs, song, site }) {
  needYtDlp(ctx);
  let result;
  try {
    result = await runTool(ctx, ctx.tools.ytDlp, ytDlpArgs(ctx, rest), {
      timeoutMs,
      missing: MISSING.ytDlp,
    });
  } catch (error) {
    if (error?.timedOut) {
      throw new SongError('unavailable', `${site} did not answer in time for ${song}. Try again.`);
    }
    throw error;
  }
  if (result.code !== 0) {
    const { code, message } = classifyYtDlpError(`${result.stderr}\n${result.stdout}`, {
      song,
      site,
    });
    throw new SongError(code, message);
  }
  return result;
}

/** Parses yt-dlp's -J output. */
function parseJson(text, song, site) {
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object') return value;
  } catch {
    // Falls through.
  }
  throw new SongError('failed', `${site} gave an answer for ${song} that could not be read.`);
}

async function ytSearch(ctx, query, want) {
  const { stdout } = await ytDlp(
    ctx,
    ['-J', '--flat-playlist', `ytsearch${YT_DLP.searchCount}:${query}`],
    { timeoutMs: ctx.timeouts.search, song: nameOf(want), site: 'YouTube Music' },
  );
  const found = parseJson(stdout, nameOf(want), 'YouTube Music');
  return Array.isArray(found.entries) ? found.entries : [];
}

/**
 * YouTube Music's search for `query`: the results that are videos or songs, in its order (the song
 * the query names comes first). The flat answer has only an id and a title for each; artists,
 * albums and playlists (`ie_key` YoutubeTab, browse pages) are left out.
 */
async function ytMusicSearch(ctx, query, want) {
  const url = `${YT_MUSIC.searchUrl}?${new URLSearchParams({ q: query })}`;
  const { stdout } = await ytDlp(ctx, ['-J', '--flat-playlist', url], {
    timeoutMs: ctx.timeouts.search,
    song: nameOf(want),
    site: 'YouTube Music',
  });
  const found = parseJson(stdout, nameOf(want), 'YouTube Music');
  return (Array.isArray(found.entries) ? found.entries : []).filter(
    (entry) => entry?.ie_key === 'Youtube' && typeof entry.id === 'string',
  );
}

async function ytInfo(ctx, url, song, site) {
  const { stdout } = await ytDlp(ctx, ['-J', '--no-playlist', url], {
    timeoutMs: ctx.timeouts.info,
    song,
    site,
  });
  return parseJson(stdout, song, site);
}

function removeWork(ctx, name) {
  let names = [];
  try {
    names = readdirSync(ctx.workDir);
  } catch {
    return;
  }
  for (const file of names) {
    if (file === name || file.startsWith(`${name}.`)) {
      rmSync(join(ctx.workDir, file), { force: true, recursive: true });
    }
  }
}

/** Downloads a YouTube video's audio to workDir/song-full.m4a; returns its path. */
async function ytDownload(ctx, url, song, site) {
  removeWork(ctx, WORK_FILES.full);
  const args = [
    '--no-playlist',
    '-f',
    'bestaudio',
    '-x',
    '--audio-format',
    'm4a',
    '--audio-quality',
    '0',
    '--max-filesize',
    YT_DLP.maxFileSize,
    '--socket-timeout',
    String(YT_DLP.socketTimeoutS),
    '--retries',
    String(YT_DLP.retries),
    '--match-filter',
    `duration < ${YT_DLP.maxSeconds}`,
    '--ffmpeg-location',
    dirname(ctx.tools.ffmpeg),
    '-o',
    `${ctx.workDir.replaceAll('%', '%%')}/${WORK_FILES.full}.%(ext)s`,
    '--print',
    'after_move:filepath',
    url,
  ];
  let result;
  try {
    result = await ytDlp(ctx, args, { timeoutMs: ctx.timeouts.download, song, site });
  } catch (error) {
    removeWork(ctx, WORK_FILES.full);
    throw error;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const printed = lines[lines.length - 1];
  if (printed !== undefined && existsSync(printed) && statSync(printed).size > 0) return printed;
  const left = readdirSync(ctx.workDir).find(
    (file) => file.startsWith(`${WORK_FILES.full}.`) && !file.endsWith('.part'),
  );
  if (left !== undefined) return join(ctx.workDir, left);
  removeWork(ctx, WORK_FILES.full);
  const said = `${result.stdout}\n${result.stderr}`;
  if (/does not pass filter|longer than|duration/i.test(said)) {
    throw new SongError(
      'not_found',
      `${song} on ${site} is longer than 15 minutes, so it is not a song.`,
    );
  }
  if (/max-filesize|larger than/i.test(said)) {
    throw new SongError('not_found', `${song} on ${site} is too big to be a song (over 60 MB).`);
  }
  throw new SongError(
    'failed',
    `${site} gave no file for ${song} (it may be longer than 15 minutes or bigger than 60 MB).`,
  );
}

/** The length of an audio file in ms, from ffprobe; `null` when it cannot be read. */
async function probeMs(ctx, file) {
  if (ctx.tools.ffprobe === null || !isExecutable(ctx.tools.ffprobe)) return null;
  try {
    const result = await runTool(
      ctx,
      ctx.tools.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeoutMs: 30_000, missing: MISSING.ffmpeg },
    );
    const seconds = Number.parseFloat(result.stdout.trim());
    return result.code === 0 && Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : null;
  } catch (error) {
    if (error?.aborted) throw error;
    return null;
  }
}

// --- the songs-cache -----------------------------------------------------------------------------

const cacheName = (id) => `yt-${id}.m4a`;

/** Takes a song out of the cache into workDir/song-full.m4a; `null` when it is not there or too old. */
function cacheTake(ctx, id) {
  if (ctx.cacheDir === null) return null;
  const file = join(ctx.cacheDir, cacheName(id));
  try {
    const age = ctx.now() - statSync(file).mtimeMs;
    if (age > SONGS_CACHE.maxAgeDays * 86_400_000 || statSync(file).size === 0) return null;
    const out = join(ctx.workDir, `${WORK_FILES.full}.m4a`);
    removeWork(ctx, WORK_FILES.full);
    copyFileSync(file, out, constants.COPYFILE_FICLONE);
    const stamp = new Date(ctx.now());
    utimesSync(file, stamp, stamp);
    return out;
  } catch {
    return null;
  }
}

/** Keeps a download in the cache, then prunes the cache. Never fails the call. */
function cachePut(ctx, id, file) {
  if (ctx.cacheDir === null || extname(file) !== '.m4a') return;
  try {
    mkdirSync(ctx.cacheDir, { recursive: true });
    const target = join(ctx.cacheDir, cacheName(id));
    const part = `${target}.part`;
    copyFileSync(file, part, constants.COPYFILE_FICLONE);
    renameSync(part, target);
    pruneSongsCache(ctx.cacheDir, { now: ctx.now() });
  } catch {
    // The cache is only a convenience.
  }
}

/** Removes cached songs older than 14 days, then the oldest until the folder is under 300 MB. */
export function pruneSongsCache(dir, { now = Date.now(), ...limits } = {}) {
  const maxAgeMs = (limits.maxAgeDays ?? SONGS_CACHE.maxAgeDays) * 86_400_000;
  const maxBytes = limits.maxBytes ?? SONGS_CACHE.maxBytes;
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((name) => /^yt-[\w-]+\.m4a(\.part)?$/.test(name))
      .map((name) => {
        const stat = statSync(join(dir, name));
        return { name, size: stat.size, time: stat.mtimeMs };
      });
  } catch {
    return [];
  }
  const removed = [];
  const drop = (file) => {
    rmSync(join(dir, file.name), { force: true });
    removed.push(file.name);
  };
  const keep = [];
  for (const file of files) {
    if (now - file.time > maxAgeMs) drop(file);
    else keep.push(file);
  }
  keep.sort((a, b) => a.time - b.time);
  let total = keep.reduce((sum, file) => sum + file.size, 0);
  for (const file of keep) {
    if (total <= maxBytes) break;
    drop(file);
    total -= file.size;
  }
  return removed;
}

// --- Apify (reels) -------------------------------------------------------------------------------

/**
 * Names that mean "no song": Instagram's and TikTok's words for the creator's own sound, in the
 * languages the reels came in (English, Hebrew, German, Spanish, French, Italian, Portuguese,
 * Russian, Ukrainian). "Original audio", "original sound - [account]", "Originalton", ...
 */
const ORIGINAL_SOUND = new RegExp(
  `^(?:${[
    'original (?:audio|sound)',
    'originalton',
    '(?:audio|áudio|sonido|son|som) original',
    '(?:audio|suono) originale',
    'оригинальный звук',
    'оригінальний (?:аудіозапис|звук)',
    'אודיו מקורי|צליל מקורי|סאונד מקורי|קול מקורי|שמע מקורי',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** An account name for comparing: lower-case letters and digits only ("Mibellyuseche💋" = "mibellyuseche"). */
const accountKey = (value) => wordsOf(value).join('');

/**
 * Whether a sound is the creator's own, so that there is no song to look up. It is when it is called
 * "Original audio" (or the same words in another language) or has no name. The actors' flag
 * (`uses_original_audio`, `musicOriginal`) is true for those, but also for a real song somebody
 * uploaded as a sound ("КРУЖИТЬ" by Dmytro Monatik on a TikTok of @nrkdnk; "Somewhere only we know"
 * on a reel of another account), so a named sound with the flag is the creator's own only when its
 * author (`author`) is the video's own account (`owner`: a name, or a list of names such as TikTok's
 * username and nickname). When the author or the owner is not known, the flag decides, as it did.
 */
export function isOriginalSound(name, flag, author = '', owner = '') {
  const label = String(name ?? '')
    .normalize('NFC')
    .trim();
  if (label === '' || ORIGINAL_SOUND.test(label)) return true;
  if (flag !== true) return false;
  const by = accountKey(author);
  const accounts = [owner].flat().map(accountKey).filter(Boolean);
  if (by === '' || accounts.length === 0) return true;
  return accounts.includes(by);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * "Song - Artist" or "Song • Artist" (also an en or em dash, or a middle dot, with a space on each
 * side): split at the last separator, so "Spider-Man" and "Song - Remix - Artist" keep their dashes.
 */
const SOUND_TITLE = /^(.+)\s+[-–—•·]\s+(.+)$/u;

/**
 * Words that make what follows the dash a version of the song and not its artist ("Blinding Lights -
 * Remix", "Song - 2011 Remaster", "Song - From the Motion Picture", "Song - Part 2").
 */
const VERSION_TAIL = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    'remix(?:ed)?',
    'live',
    'acoustic',
    'instrumental',
    'remaster(?:ed)?',
    'version',
    'edit',
    'mix',
    'slowed',
    'sped',
    'reverb',
    'extended',
    'mashup',
    'cover',
    'karaoke',
    'lyrics?',
    'demo',
    'reprise',
    'deluxe',
    'bonus',
    'radio',
    'nightcore',
    'part',
    'pt',
    'from',
    'ost',
    'soundtrack',
    'רמיקס|גרסה|גרסת|לייב|אקוסטי',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/**
 * Whether the artist field of a sound is the one who uploaded it, not the song's artist: it is empty,
 * it is the video's own account (`owner`: a name or a list of names, as for `isOriginalSound`), or
 * it looks like an account name (one word with no spaces: "sofia.peters", "anyma_fans", "keanefan").
 */
function isUploader(artist, owner) {
  const by = String(artist ?? '')
    .trim()
    .replace(/^@/, '');
  if (by === '') return true;
  const key = accountKey(by);
  if (key !== '' && [owner].flat().map(accountKey).filter(Boolean).includes(key)) {
    return true;
  }
  return !/\s/u.test(by);
}

/**
 * The song's name from a sound's title and artist: `{ title, artist }`. For an Instagram or TikTok
 * song uploaded as a sound the artist field is the uploader ("sofia.peters") and the title reads
 * "Somewhere only we know - Keane" (or "Song • Artist"), so it is split into the title "Somewhere
 * only we know" and the artist "Keane". It is only split when the artist field is the uploader (empty,
 * the video's own account, or an account-like name) and what follows the separator is not a version
 * ("Song - Remix"); every other sound keeps its title and artist as they are. `owner` is the
 * video's account, a name or a list of names.
 */
export function songNameOfSound(title, artist, owner = '') {
  const name = text(title);
  const by = text(artist);
  const found = SOUND_TITLE.exec(name);
  if (found === null) return { title: name, artist: by };
  const head = found[1].trim();
  const tail = found[2].trim();
  if (head === '' || tail === '' || VERSION_TAIL.test(tail) || !isUploader(by, owner)) {
    return { title: name, artist: by };
  }
  return { title: head, artist: tail };
}

/** A host that is this Mac or its network (an audio url must never point there). */
const PRIVATE_HOST =
  /^(?:localhost|.*\.local|.*\.internal|\[.*\]|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;

const httpsUrl = (value) => {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && !PRIVATE_HOST.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * An Instagram reel scraper item: `{ id, url, title, artist, owners, original, audioUrl, durationMs,
 * error }`. `owners` are the names of the video's own account (for `songNameOfSound`).
 */
export function readInstagramItem(item) {
  const music = item?.musicInfo ?? {};
  return {
    id: text(item?.shortCode),
    url: text(item?.url),
    title: text(music.song_name),
    artist: text(music.artist_name),
    owners: [text(item?.ownerUsername)].filter(Boolean),
    original: isOriginalSound(
      music.song_name,
      music.uses_original_audio,
      music.artist_name,
      item?.ownerUsername,
    ),
    audioUrl: httpsUrl(item?.audioUrl) ?? httpsUrl(item?.videoUrl),
    durationMs: Number.isFinite(item?.videoDuration) ? Math.round(item.videoDuration * 1000) : null,
    error: text(item?.error) || text(item?.errorDescription),
  };
}

/** A TikTok scraper item, the same shape. */
export function readTikTokItem(item) {
  const music = item?.musicMeta ?? {};
  const name = text(music.musicName);
  return {
    id: text(item?.id),
    url: text(item?.webVideoUrl),
    title: name,
    artist: text(music.musicAuthor),
    owners: [text(item?.authorMeta?.name), text(item?.authorMeta?.nickName)].filter(Boolean),
    original: isOriginalSound(name, music.musicOriginal, music.musicAuthor, [
      item?.authorMeta?.name,
      item?.authorMeta?.nickName,
    ]),
    audioUrl: httpsUrl(music.playUrl),
    durationMs: Number.isFinite(item?.videoMeta?.duration)
      ? Math.round(item.videoMeta.duration * 1000)
      : null,
    error: text(item?.error) || text(item?.errorDescription),
  };
}

function needToken(ctx) {
  const token = readApifyToken(ctx.env, ctx.envFile);
  if (token === null) {
    throw new SongError('needs_key', 'Reel links need an Apify key: add APIFY_TOKEN to .env');
  }
  return token;
}

/**
 * The context Apify calls need (`apifyItems`) without a work folder: for the trending pick, which
 * makes its own. Same options as `getSong` (`env`, `envFile`, `signal`, `fetch`, `retryMs`,
 * `timeouts.apify`).
 */
export function apifyContext(options = {}) {
  const env = options.env ?? process.env;
  return {
    env,
    envFile: options.envFile ?? ENV_FILE,
    signal: options.signal,
    fetch: options.fetch ?? globalThis.fetch,
    retryMs: options.retryMs ?? APIFY.retryMs,
    timeouts: { apify: APIFY.callTimeoutMs, ...(options.timeouts ?? {}) },
  };
}

/**
 * One Apify run of an actor, synchronously: the dataset's items. The key goes in an Authorization
 * header (never in the URL); the run has a time limit, a charge limit and a number of items. A 5xx, a
 * 429, a 408 or no answer is tried once more, then `blocked`.
 *
 * `limits` (all optional; a reel link's call, one item for at most $0.05, takes none): `maxItems`
 * (charged and returned), `maxChargeUsd`, `timeoutS` (the run's own), `callTimeoutMs`,
 * `retryOnTimeout: false` (a call that timed out is not paid for twice) and `says`, the messages
 * (`down`, `status(code)`, `unreadable`, `noKey`, `noCredit`) for something other than a reel link.
 * Exported for the trending pick, which reads a niche's reels and sounds.
 */
export async function apifyItems(ctx, actor, input, site, limits = {}) {
  const token = needToken(ctx);
  const maxItems = limits.maxItems ?? 1;
  const query = new URLSearchParams({
    timeout: String(limits.timeoutS ?? APIFY.runTimeoutS),
    maxTotalChargeUsd: String(limits.maxChargeUsd ?? APIFY.maxChargeUsd),
    maxItems: String(maxItems),
    limit: String(maxItems),
    format: 'json',
    clean: '1',
  });
  const url = `${APIFY.base}/v2/acts/${actor}/run-sync-get-dataset-items?${query}`;
  const init = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(input),
  };
  const says = {
    down: `Apify did not answer, so the song of that ${site} link could not be read. Try again in a while.`,
    status: (code) => `Apify could not read that ${site} link (it answered ${code}).`,
    unreadable: `Apify's answer for that ${site} link could not be read.`,
    noKey: 'Apify refused the key. Check APIFY_TOKEN in .env.',
    noCredit:
      'Apify says the account has no credit or hit its limit, so reel links cannot be read. Check the Apify account.',
    ...(limits.says ?? {}),
  };
  const down = new SongError('blocked', says.down);
  const callTimeoutMs = limits.callTimeoutMs ?? ctx.timeouts.apify;
  const mayRetry = (timedOut) => !(timedOut && limits.retryOnTimeout === false);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchWith(ctx, url, init, callTimeoutMs);
    } catch (error) {
      if (error?.aborted) throw error;
      if (attempt === 0 && mayRetry(error?.timedOut === true)) {
        await sleep(ctx.retryMs, ctx.signal);
        continue;
      }
      throw down;
    }
    const { status } = response;
    if (status === 401 || status === 403) throw new SongError('needs_key', says.noKey);
    if (status === 402) throw new SongError('needs_key', says.noCredit);
    if (status >= 500 || status === 408 || status === 429) {
      if (attempt === 0 && mayRetry(status === 408)) {
        await sleep(ctx.retryMs, ctx.signal);
        continue;
      }
      throw down;
    }
    if (status < 200 || status >= 300) throw new SongError('failed', says.status(status));
    let items;
    try {
      items = await response.json();
    } catch {
      throw new SongError('failed', says.unreadable);
    }
    if (!Array.isArray(items)) throw new SongError('failed', says.unreadable);
    return items;
  }
  throw down;
}

/** A link without its query and fragment (share ids and tracking stay with the one who shared it). */
const cleanHref = (url) => `${url.origin}${url.pathname}`;

/** The extension a downloaded audio is saved with. */
function audioExtension(url, contentType) {
  const byType = {
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  };
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (byType[type]) return byType[type];
  const ext = extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{2,4}$/.test(ext) ? ext : 'bin';
}

/**
 * Downloads the reel's own audio (no key sent) and keeps it as workDir/song-reel.m4a (a video or
 * another format is converted with ffmpeg, audio only). Returns the path.
 */
async function downloadReelAudio(ctx, url, site) {
  needFfmpeg(ctx);
  let response;
  try {
    response = await fetchWith(ctx, url, { method: 'GET' }, ctx.timeouts.reelAudio);
  } catch (error) {
    if (error?.aborted) throw error;
    throw new SongError(
      'unavailable',
      `The audio of that ${site} reel did not download. Try again.`,
    );
  }
  if (!response.ok) {
    throw new SongError(
      'unavailable',
      `The audio of that ${site} reel is not available any more (it answered ${response.status}).`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > REEL_AUDIO_MAX_BYTES) {
    throw new SongError('failed', `The audio of that ${site} reel is too big (over 60 MB).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > REEL_AUDIO_MAX_BYTES) {
    throw new SongError('failed', `The audio of that ${site} reel could not be used.`);
  }
  removeWork(ctx, WORK_FILES.reel);
  const ext = audioExtension(url, response.headers.get('content-type'));
  const raw = join(ctx.workDir, `${WORK_FILES.reel}.${ext}`);
  writeFileSync(raw, bytes);
  if (ext === 'm4a') return raw;
  const out = join(ctx.workDir, `${WORK_FILES.reel}.m4a`);
  const result = await runTool(
    ctx,
    ctx.tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      raw,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      out,
    ],
    { timeoutMs: ctx.timeouts.ffmpeg, missing: MISSING.ffmpeg },
  );
  rmSync(raw, { force: true });
  if (result.code !== 0 || !existsSync(out)) {
    rmSync(out, { force: true });
    throw new SongError('failed', `The audio of that ${site} reel could not be converted.`);
  }
  return out;
}

/**
 * A reel link: the song's name and the reel's audio from Apify; then the clean full track by that
 * name; else the reel's audio is the song.
 */
async function fromReel(ctx, link, want) {
  const site = link.kind === 'instagram' ? 'Instagram' : 'TikTok';
  if (link.problem) {
    throw new SongError('not_found', `That ${site} link is not one I can read: ${link.problem}.`);
  }
  needToken(ctx);
  const [actor, input, read] =
    link.kind === 'instagram'
      ? [
          APIFY.instagramActor,
          { username: [cleanHref(link.url)], resultsLimit: 1 },
          readInstagramItem,
        ]
      : [
          APIFY.tiktokActor,
          {
            postURLs: [cleanHref(link.url)],
            resultsPerPage: 1,
            scrapeRelatedVideos: false,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false,
            shouldDownloadMusicCovers: false,
            shouldDownloadSubtitles: false,
          },
          readTikTokItem,
        ];
  const items = await apifyItems(
    ctx,
    actor,
    input,
    site,
    link.kind === 'tiktok' ? { maxChargeUsd: APIFY.tiktokMaxChargeUsd } : {},
  );
  const item = items.length > 0 ? read(items[0]) : null;
  if (item === null || item.error !== '') {
    throw new SongError(
      'unavailable',
      `Apify found nothing at that ${site} link. The ${link.kind === 'instagram' ? 'reel' : 'video'} may be private or deleted.`,
    );
  }
  // The sound is the creator's own ("Original audio", or a sound named by the video's own account):
  // the song is only known when the caller already had its name. A named sound by someone else is
  // not this: it goes on to the name lookup below, and the sound's own audio is the fallback.
  const ownSound = item.original;
  if (ownSound && want.title !== '') {
    return await getByName(ctx, want);
  }
  if (ownSound) {
    const by = item.artist === '' ? '' : ` by ${item.artist}`;
    throw new SongError(
      'original_audio',
      `The sound of that ${site} ${link.kind === 'instagram' ? 'reel' : 'video'} is "${item.title === '' ? 'Original audio' : item.title}"${by}, so there is no song to look up. Send the song's name, or the link of the reel it came from.`,
    );
  }
  let reel = null;
  let reelProblem = null;
  if (item.audioUrl !== null) {
    try {
      reel = await downloadReelAudio(ctx, item.audioUrl, site);
    } catch (error) {
      // The reel's own audio is only the fallback (and what SG16 will match against). Its CDN host
      // may not answer (Instagram hands out a far-away edge now and then: a connect timeout in the
      // real acceptance run, SG13), and the song's name is known, so the clean track is still
      // looked up. If that fails too, this is the reason given.
      if (!(error instanceof SongError) || error.code !== 'unavailable') throw error;
      reelProblem = error;
    }
  }
  // A song uploaded as a sound is "Somewhere only we know - Keane" by its uploader: the song is
  // Keane's, so that is what is looked up (and what the sound is called if it is not found).
  const song = songNameOfSound(item.title, item.artist, item.owners);
  const named = { ...want, title: song.title, artist: song.artist };
  const found = await getByName(ctx, named, { quietNotFound: true });
  if (found !== null) return { ...found, reel };
  if (reel === null) {
    throw (
      reelProblem ??
      new SongError(
        'not_found',
        `${nameOf(named)} was not found on YouTube Music, and that ${site} reel gave no audio.`,
      )
    );
  }
  const fullMs = (await probeMs(ctx, reel)) ?? item.durationMs;
  if (fullMs === null) {
    throw new SongError(
      'failed',
      `The length of the audio of that ${site} reel could not be read.`,
    );
  }
  return {
    full: reel,
    reel,
    meta: {
      title: song.title,
      artist: song.artist === '' ? 'Unknown' : song.artist,
      site: link.kind,
      via: 'apify',
      url: cleanHref(link.url),
      id: item.id || link.code,
      fullMs,
    },
  };
}

// --- iTunes, Spotify -----------------------------------------------------------------------------

async function getJson(ctx, url, timeoutMs) {
  try {
    const response = await fetchWith(
      ctx,
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    if (error?.aborted) throw error;
    return null;
  }
}

/**
 * The song as Apple knows it: `{ canonical, alt }`. `canonical` is the iTunes result that is the
 * song asked for (its length is the canonical one), IL's storefront first, then US's; `alt` is
 * another spelling of the title and artist (Hebrew for Latin or the other way round, from the
 * first result of a storefront that has no match in the asked script) used only for a second
 * YouTube search, never to judge a result. iTunes failing is never an error: no canonical length
 * is used then.
 */
async function itunesLookup(ctx, want) {
  const term = `${want.artist} ${want.title}`.trim();
  let alt = null;
  for (const country of ITUNES.countries) {
    const query = new URLSearchParams({
      term,
      entity: 'song',
      limit: String(ITUNES.limit),
      country,
    });
    const body = await getJson(ctx, `${ITUNES.base}/search?${query}`, ctx.timeouts.itunes);
    const results = Array.isArray(body?.results) ? body.results : [];
    const canonical = pickCanonical(results, want.title, want.artist);
    if (canonical !== null) {
      const other =
        canonical.trackName !== want.title &&
        normName(canonical.trackName) !== normName(want.title);
      return {
        canonical,
        alt: other ? { title: canonical.trackName, artist: canonical.artistName } : alt,
      };
    }
    const first = results.find((result) => typeof result?.trackName === 'string');
    const scriptDiffers =
      first !== undefined &&
      ((hasHebrew(first.trackName) && !hasHebrew(want.title) && hasLatin(want.title)) ||
        (hasLatin(first.trackName) && !hasLatin(want.title) && hasHebrew(want.title)));
    if (alt === null && scriptDiffers) alt = { title: first.trackName, artist: first.artistName };
  }
  return { canonical: null, alt };
}

/** The content of an og: meta tag in an HTML page, or `null`. */
function metaContent(html, property) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*>|<meta[^>]+content=["'][^"']*["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
    'i',
  );
  const tag = pattern.exec(html)?.[0];
  if (tag === undefined) return null;
  const content = /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const value = content?.[1] ?? content?.[2];
  return value === undefined
    ? null
    : value
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&#x27;', "'")
        .trim();
}

/** A Spotify song's title and artist: oEmbed gives the title; the page's og tags the artist. */
async function fromSpotify(ctx, link) {
  if (link.problem) {
    throw new SongError(
      'not_found',
      `That Spotify link is not a song I can read: ${link.problem}.`,
    );
  }
  let title = '';
  if (link.host === 'open.spotify.com') {
    const body = await getJson(
      ctx,
      `https://open.spotify.com/oembed?${new URLSearchParams({ url: link.url.href })}`,
      ctx.timeouts.page,
    );
    title = text(body?.title);
  }
  let artist = '';
  let html = '';
  try {
    const response = await fetchWith(
      ctx,
      link.url.href,
      { method: 'GET', headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (Macintosh)' } },
      ctx.timeouts.page,
    );
    if (response.ok) html = await response.text();
  } catch (error) {
    if (error?.aborted) throw error;
  }
  if (html !== '') {
    if (title === '') title = metaContent(html, 'og:title') ?? '';
    const description = metaContent(html, 'og:description') ?? '';
    const parts = description
      .split(/\s*[·•|]\s*/)
      .map((part) => part.trim())
      .filter(
        (part) =>
          part !== '' &&
          !/^(?:song|single|track|listen to .*)$/i.test(part) &&
          !/^\d{4}$/.test(part) &&
          !titlesMatch(part, title),
      );
    artist = parts[0] ?? '';
  }
  if (title === '') {
    throw new SongError('not_found', 'The Spotify link gave no song name. Send the name instead.');
  }
  return { title, artist };
}

/** An Apple Music song's title, artist and length: iTunes Lookup by its id. */
async function fromApple(ctx, link) {
  if (link.problem) {
    throw new SongError(
      'not_found',
      `That Apple Music link is not a song I can read: ${link.problem}.`,
    );
  }
  const query = new URLSearchParams({ id: link.trackId, country: link.country.toUpperCase() });
  const body = await getJson(ctx, `${ITUNES.base}/lookup?${query}`, ctx.timeouts.itunes);
  const result = Array.isArray(body?.results) ? body.results.find((r) => r?.trackName) : undefined;
  if (result === undefined) {
    throw new SongError(
      'not_found',
      'Apple Music has no song at that link. Send the name instead.',
    );
  }
  return {
    title: text(result.trackName),
    artist: text(result.artistName),
    canonicalMs: Number.isFinite(result.trackTimeMillis) ? result.trackTimeMillis : null,
  };
}

// --- by name -------------------------------------------------------------------------------------

function searchQuery(want, title, artist) {
  const suffix = want.version && want.version !== 'original' ? ` ${want.version}` : '';
  return `${artist} ${title}${suffix}`.replace(/\s+/g, ' ').trim();
}

/** Whether the best result is one to stop at: the song's own title on a Topic or the artist's channel. */
const isSure = (candidate) =>
  candidate?.titleMatch && (candidate.topic || candidate.verified || candidate.artistInChannel);

/** Whether two artists' names are the same by whole words: one is the other, or inside it. */
function sameArtist(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (x === '' || y === '') return false;
  return ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/**
 * The song from YouTube Music's own search, or `null` when it gives nothing usable (the plain
 * YouTube search then runs as before). A result is the song when its video title (or yt-dlp's
 * `track`) is the title asked for (or Apple's spelling of it), it has none of the banned words
 * (lyrics, live, cover, sped up …), its channel or artist is the artist asked for (or Apple's
 * spelling of it) and its length is within the same 5 s window of iTunes' (`rankCandidates`). With no
 * canonical length the title must be exactly the one asked for. The first such result wins: YouTube
 * Music puts the song itself first. At most `YT_MUSIC.maxInfoCalls` results are looked at, one yt-dlp
 * info call each, and only those whose title could be the song's. A failure of yt-dlp here (it
 * blocks, the video is closed …) is not the answer: the plain search runs and says it if it fails
 * too. Only a stop or a missing tool is thrown.
 */
async function findInMusic(ctx, queries, want, { canonicalMs, names, alt }) {
  const askedTitles = [...new Set([want.title, names.title, alt?.title].filter(Boolean))];
  const askedArtists = [...new Set([want.artist, names.artist, alt?.artist].filter(Boolean))];
  const ask = { title: want.title, artist: want.artist, version: want.version, canonicalMs };
  const banned = bannedWords(askedTitles, want.artist, 'original');
  const looked = new Set();
  try {
    for (const query of queries) {
      throwIfStopped(ctx);
      for (const found of await ytMusicSearch(ctx, query, want)) {
        const flatTitle = typeof found.title === 'string' ? found.title : '';
        if (looked.has(found.id)) continue;
        if (!askedTitles.some((name) => titlesMatch(name, flatTitle))) continue;
        if (hasBannedWord(wordsOf(flatTitle), banned)) continue;
        if (looked.size >= YT_MUSIC.maxInfoCalls) return null;
        looked.add(found.id);
        const info = await ytInfo(
          ctx,
          `https://www.youtube.com/watch?v=${found.id}`,
          nameOf(want),
          'YouTube Music',
        );
        const channel = text(info.channel) || text(info.uploader);
        const [best] = rankCandidates(
          [
            {
              id: found.id,
              title: text(info.title) || flatTitle,
              track: text(info.track),
              duration: info.duration,
              channel,
              uploader: text(info.uploader),
              channel_is_verified: info.channel_is_verified,
              view_count: info.view_count,
              live_status: info.live_status,
            },
          ],
          { ...ask, names: askedTitles.slice(1) },
        );
        if (best === undefined || !best.titleMatch) continue;
        const credited = [info.artist, info.creator, channel.replace(/\s-\sTopic$/i, '')]
          .map(text)
          .filter(Boolean);
        const artistMatches =
          askedArtists.length === 0 ||
          askedArtists.some((artist) => credited.some((name) => sameArtist(artist, name)));
        if (!artistMatches) continue;
        // Nothing to check the length against: only the exact title is sure enough.
        const exact = askedTitles.some(
          (name) =>
            normName(name) === normName(best.title) || normName(name) === normName(info.track),
        );
        if (canonicalMs === null && !exact) continue;
        return { ...best, artist: credited[0] ?? '' };
      }
    }
  } catch (error) {
    if (error instanceof SongError && !error.aborted && error.code !== 'tool_missing') return null;
    throw error;
  }
  return null;
}

/**
 * A song by its name: the canonical length from iTunes, YouTube Music's own search and then
 * YouTube's results ranked, the best one downloaded. `want` is `{ title, artist, version, canonicalMs? }`. With `quietNotFound` a song
 * that is not there resolves `null` (a reel then falls back to its own audio) instead of throwing.
 */
async function getByName(ctx, want, { quietNotFound = false } = {}) {
  try {
    return await findByName(ctx, want, { quietNotFound });
  } catch (error) {
    if (quietNotFound && error instanceof SongError && error.code === 'not_found') return null;
    throw error;
  }
}

async function findByName(ctx, want, { quietNotFound }) {
  const notFound = (message) => {
    if (quietNotFound) return null;
    throw new SongError('not_found', message);
  };
  if (want.title === '') {
    return notFound('There is no song name to look up. Send the name and the artist.');
  }
  needYtDlp(ctx);
  let canonicalMs = want.canonicalMs ?? null;
  let alt = null;
  let names = {};
  if (canonicalMs === null) {
    const found = await itunesLookup(ctx, want);
    if (found.canonical !== null) {
      canonicalMs = found.canonical.trackTimeMillis;
      names = { title: found.canonical.trackName, artist: found.canonical.artistName };
    }
    alt = found.alt;
  }
  // A title with no artist (a Spotify page that did not say) is searched with Apple's artist.
  if (want.artist === '' && names.artist) want = { ...want, artist: names.artist };
  const queries = [searchQuery(want, want.title, want.artist)];
  if (alt !== null) queries.push(searchQuery(want, alt.title, alt.artist || want.artist));

  // YouTube Music first, for the song itself (a version has its own plain search below); what it
  // gives nothing usable for goes to the plain YouTube search, exactly as it always did.
  const original = !want.version || want.version === 'original';
  let best = original ? await findInMusic(ctx, queries, want, { canonicalMs, names, alt }) : null;
  const fromMusic = best !== null;
  if (best === null) {
    const seen = new Map();
    let ranked = [];
    for (const query of queries) {
      throwIfStopped(ctx);
      const entries = await ytSearch(ctx, query, want);
      for (const entry of entries) if (entry?.id && !seen.has(entry.id)) seen.set(entry.id, entry);
      ranked = rankCandidates([...seen.values()], {
        title: want.title,
        artist: want.artist,
        version: want.version,
        canonicalMs,
      });
      if (isSure(ranked[0])) break;
    }
    best = ranked[0];
  }
  if (best === undefined) {
    return notFound(
      `${nameOf(want)} was not found on YouTube Music. Check the name, or send the link of the song.`,
    );
  }
  const site = fromMusic || best.topic ? 'youtube-music' : 'youtube';
  const siteName = fromMusic || best.topic ? 'YouTube Music' : 'YouTube';
  let full = cacheTake(ctx, best.id);
  if (full === null) {
    full = await ytDownload(ctx, best.url, nameOf(want), siteName);
    cachePut(ctx, best.id, full);
  }
  const fullMs = (await probeMs(ctx, full)) ?? best.durationMs;
  return {
    full,
    reel: null,
    meta: {
      title: want.title,
      artist:
        want.artist ||
        names.artist ||
        best.artist ||
        best.channel.replace(/\s-\sTopic$/i, '') ||
        'Unknown',
      site,
      via: 'yt-dlp',
      url: best.url,
      id: best.id,
      fullMs,
    },
  };
}

// --- a YouTube link ------------------------------------------------------------------------------

/** A video's song title and artist from yt-dlp's metadata. */
function namesFromInfo(info) {
  const channel = text(info.channel) || text(info.uploader);
  const topic = /\s-\sTopic$/i.test(channel);
  let title = text(info.track);
  let artist = text(info.artist) || text(info.creator);
  if (title === '') {
    const video = text(info.title);
    const split = video.split(/\s[-–—]\s/);
    if (split.length >= 2 && artist === '') {
      artist = split[0].trim();
      title = split.slice(1).join(' - ');
    } else {
      title = video;
    }
    title = title
      .replace(/\s*[([](?:official|lyric|audio|video|music|hd|4k)[^)\]]*[)\]]/gi, '')
      .trim();
  }
  if (artist === '') artist = channel.replace(/\s-\sTopic$/i, '');
  return { title: title || text(info.title), artist: artist || 'Unknown', topic };
}

async function fromYouTube(ctx, link) {
  if (link.problem) {
    throw new SongError(
      'not_found',
      `That YouTube link is not a song I can read: ${link.problem}.`,
    );
  }
  needYtDlp(ctx);
  const siteName = link.music ? 'YouTube Music' : 'YouTube';
  const url = `https://www.youtube.com/watch?v=${link.id}`;
  const info = await ytInfo(ctx, url, 'that song', siteName);
  if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new SongError('unavailable', `That ${siteName} link is a live stream, not a song.`);
  }
  const { title, artist, topic } = namesFromInfo(info);
  const song = nameOf({ title, artist });
  if (Number.isFinite(info.duration) && info.duration >= YT_DLP.maxSeconds) {
    throw new SongError(
      'not_found',
      `${song} on ${siteName} is longer than 15 minutes, so it is not a song.`,
    );
  }
  const site = link.music || topic ? 'youtube-music' : 'youtube';
  let full = cacheTake(ctx, link.id);
  if (full === null) {
    full = await ytDownload(ctx, url, song, siteName);
    cachePut(ctx, link.id, full);
  }
  const fullMs =
    (await probeMs(ctx, full)) ??
    (Number.isFinite(info.duration) ? Math.round(info.duration * 1000) : null);
  if (fullMs === null) {
    throw new SongError('failed', `The length of ${song} could not be read.`);
  }
  return {
    full,
    reel: null,
    meta: { title, artist, site, via: 'yt-dlp', url, id: link.id, fullMs },
  };
}

// --- getSong -------------------------------------------------------------------------------------

/** One getSong at a time per workDir. */
const queues = new Map();
function inQueue(key, work) {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(work, work);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * Gets the song asked for: `{ title, artist, version, link, workDir, tools, env, signal }` (see the
 * top of this file); `title` and `artist` may be empty with a link. Resolves
 * `{ full, reel, meta }` or throws a SongError.
 */
export async function getSong(options) {
  if (options === null || typeof options !== 'object' || !options.workDir) {
    throw new SongError('failed', 'getSong needs a work folder.');
  }
  const ctx = makeContext(options);
  const want = {
    title: text(options.title),
    artist: text(options.artist),
    version: VERSIONS.includes(options.version) ? options.version : null,
    canonicalMs: null,
  };
  const link = text(options.link);
  return inQueue(ctx.workDir, async () => {
    try {
      mkdirSync(ctx.workDir, { recursive: true });
      throwIfStopped(ctx);
      if (link === '') {
        if (want.title === '') {
          throw new SongError('not_found', 'There is no song name or link to look up.');
        }
        return await getByName(ctx, want);
      }
      const parsed = classifyLink(link);
      if (parsed === null) {
        throw new SongError(
          'not_found',
          'That is not a link I can read. Send a link that starts with https://',
        );
      }
      switch (parsed.kind) {
        case 'instagram':
        case 'tiktok':
          return await fromReel(ctx, parsed, want);
        case 'youtube':
          return await fromYouTube(ctx, parsed);
        case 'spotify': {
          const named = await fromSpotify(ctx, parsed);
          return await getByName(ctx, {
            ...want,
            title: named.title,
            artist: named.artist || want.artist,
          });
        }
        case 'apple': {
          const named = await fromApple(ctx, parsed);
          return await getByName(ctx, { ...want, ...named });
        }
        default:
          throw new SongError(
            'not_found',
            `Songs cannot be got from ${parsed.host}. Send a YouTube, Instagram, TikTok, Spotify or Apple Music link, or the song's name.`,
          );
      }
    } catch (error) {
      if (error instanceof SongError) throw error;
      throw new SongError(
        'failed',
        `Getting the song failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
