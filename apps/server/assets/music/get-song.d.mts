// Types of get-song.mjs, the song getter (Songs, SG2), for its tests, the music script's `song`
// command (SG3) and the trending pick (SG10). The shapes it returns are the shared contract's
// (packages/shared/src/domain/music.ts: songSchema's source and fullMs, SONG_FAILURE_CODES).

import type { YtDlpErrorCode } from './yt-dlp-errors.mjs';

export type SongVersionName = 'original' | 'sped up' | 'slowed' | 'remix';
export type SongSiteName = 'youtube-music' | 'youtube' | 'instagram' | 'tiktok';
export type SongViaName = 'yt-dlp' | 'apify';

/** The song failure codes the getter throws (SONG_FAILURE_CODES; never `no_trending`). */
export type GetSongCode = YtDlpErrorCode | 'needs_key' | 'original_audio';

export const VERSIONS: readonly SongVersionName[];
export const WORK_FILES: { full: 'song-full'; reel: 'song-reel' };
export const DEFAULT_TOOLS: { ytDlp: string; deno: string };
export const APIFY_TOKEN_ENV: 'APIFY_TOKEN';
/** The repo's git-ignored .env, where the Apify key is read from (after the environment). */
export const ENV_FILE: string;

export const APIFY: {
  base: string;
  instagramActor: string;
  tiktokActor: string;
  runTimeoutS: number;
  maxChargeUsd: number;
  /** The TikTok actor's own minimum cap ($0.50): a lower one is refused with a 400. */
  tiktokMaxChargeUsd: number;
  callTimeoutMs: number;
  retryMs: number;
};

export const ITUNES: {
  base: string;
  countries: readonly string[];
  limit: number;
  timeoutMs: number;
};

export const YT_DLP: {
  searchCount: number;
  maxFileSize: string;
  maxSeconds: number;
  socketTimeoutS: number;
  retries: number;
  searchTimeoutMs: number;
  infoTimeoutMs: number;
  downloadTimeoutMs: number;
};

/** YouTube Music's own search, tried before the plain YouTube search when a song is asked by name. */
export const YT_MUSIC: {
  searchUrl: string;
  /** The most results looked at in one song's lookup (one yt-dlp info call each). */
  maxInfoCalls: number;
};

export const RANK: {
  toleranceMs: number;
  looseToleranceMs: number;
  spedUp: { min: number; max: number };
  slowed: { min: number; max: number };
};

export const SONGS_CACHE: { maxAgeDays: number; maxBytes: number };
export const REEL_AUDIO_MAX_BYTES: number;

/** A failure with its code: what the music script prints and exits with. */
export class SongError extends Error {
  constructor(code: GetSongCode, message: string);
  readonly code: GetSongCode;
  /** Set when the call was stopped by its signal. */
  aborted?: true;
}

/** Text with the Apify key (and anything shaped like a key or a Bearer value) taken out. */
export function redact(text: unknown): string;

/** APIFY_TOKEN from `env`, then from the .env file (default ENV_FILE); `null` when neither has one. */
export function readApifyToken(
  env?: Record<string, string | undefined>,
  file?: string,
): string | null;

/** What `apifyItems` needs: the key, the fetch, the signal (made by `apifyContext`). */
export interface ApifyContext {
  env: Record<string, string | undefined>;
  envFile: string;
  signal?: AbortSignal;
  fetch: typeof fetch;
  retryMs: number;
  timeouts: { apify: number };
}

/** The context for Apify calls without a work folder (the trending pick). */
export function apifyContext(options?: {
  env?: Record<string, string | undefined>;
  envFile?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  retryMs?: number;
  timeouts?: Partial<{ apify: number }>;
}): ApifyContext;

/** What one Apify run may take and cost, and the words of its failures (all optional). */
export interface ApifyLimits {
  /** Items charged and returned (default 1). */
  maxItems?: number;
  /** The most the run may cost, in US dollars (default APIFY.maxChargeUsd). */
  maxChargeUsd?: number;
  /** The run's own time limit in seconds (default APIFY.runTimeoutS). */
  timeoutS?: number;
  /** How long the call waits (default the context's timeouts.apify). */
  callTimeoutMs?: number;
  /** `false`: a call that timed out is not tried again (a run is paid for once). */
  retryOnTimeout?: boolean;
  says?: Partial<{
    down: string;
    status: (code: number) => string;
    unreadable: string;
    noKey: string;
    noCredit: string;
  }>;
}

/**
 * One Apify run of an actor, synchronously: the dataset's items. The key goes in an Authorization
 * header; 401/402/403 are `needs_key`, a 5xx, 408, 429 or no answer is tried once more and then
 * `blocked`, anything else `failed`.
 */
export function apifyItems(
  ctx: ApifyContext,
  actor: string,
  input: unknown,
  site: string,
  limits?: ApifyLimits,
): Promise<unknown[]>;

/** The executable `name` ($MUSIC_<NAME>, PATH, Homebrew's and /usr/local's bin), or `null`. */
export function findTool(name: string, env?: Record<string, string | undefined>): string | null;

/** A song's or an artist's name for comparing: no brackets, no "feat. …", lower case, plain words. */
export function normName(text: unknown): string;

export type LinkKind = 'instagram' | 'tiktok' | 'youtube' | 'spotify' | 'apple' | 'other';

export interface ClassifiedLink {
  kind: LinkKind;
  /** Without "www.". */
  host: string;
  url: URL;
  /** instagram, tiktok: the reel's or video's code. */
  code?: string;
  /** youtube: the video id. */
  id?: string;
  /** youtube: music.youtube.com. */
  music?: boolean;
  /** spotify, apple: the track id. */
  trackId?: string;
  /** apple: the storefront. */
  country?: string;
  /** Why a link of a known site cannot be read (a profile, an album, a playlist). */
  problem?: string;
}

/** What a link is; `null` when it is not a link. */
export function classifyLink(text: unknown): ClassifiedLink | null;

/** One entry of yt-dlp's flat-playlist search. */
export interface SearchEntry {
  id?: string;
  title?: string;
  /** From a yt-dlp info call: the song's own title (a song-type result of YouTube Music has one). */
  track?: string | null;
  duration?: number | null;
  channel?: string | null;
  uploader?: string | null;
  channel_is_verified?: boolean | null;
  view_count?: number | null;
  live_status?: string | null;
}

export interface Candidate {
  id: string;
  url: string;
  title: string;
  channel: string;
  durationMs: number;
  views: number;
  topic: boolean;
  verified: boolean;
  artistInChannel: boolean;
  titleMatch: boolean;
}

/** YouTube's search results for the song asked, filtered and best first. */
export function rankCandidates(
  entries: readonly SearchEntry[],
  want: {
    title: string;
    artist?: string;
    version?: SongVersionName | null;
    canonicalMs?: number | null;
    names?: readonly string[];
  },
): Candidate[];

export interface ITunesResult {
  kind?: string;
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
}

/** The iTunes result that is the song asked for (its length is the canonical one), or `null`. */
export function pickCanonical(
  results: readonly ITunesResult[],
  title: string,
  artist: string,
): ITunesResult | null;

/** What a reel scraper's item says (`readInstagramItem`, `readTikTokItem`). */
export interface ReelItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  /** The names of the video's own account (Instagram's username; TikTok's name and nickname). */
  owners: string[];
  original: boolean;
  audioUrl: string | null;
  durationMs: number | null;
  error: string;
}

/**
 * Whether a sound is the creator's own (no song to look up): "Original audio" in any language, no
 * name, or the actor's flag with the sound's author being the video's own account (`owner`, a name
 * or a list of names). With no author or no owner known, the flag decides.
 */
export function isOriginalSound(
  name: unknown,
  flag: unknown,
  author?: unknown,
  owner?: unknown,
): boolean;
/**
 * The song's name from a sound's title and artist. A song uploaded as a sound has the uploader as
 * its artist and reads "Somewhere only we know - Keane" (or "Song • Artist"): split into the title
 * "Somewhere only we know" and the artist "Keane" when the artist field is the uploader (empty, the
 * video's own account `owner`, a name or a list of names, or one account-like word) and what follows
 * the separator is not a version ("Song - Remix"). Any other sound keeps its title and artist.
 */
export function songNameOfSound(
  title: unknown,
  artist: unknown,
  owner?: unknown,
): { title: string; artist: string };
export function readInstagramItem(item: unknown): ReelItem;
export function readTikTokItem(item: unknown): ReelItem;

/** Removes songs-cache files older than 14 days, then the oldest until under 300 MB; returns the removed names. */
export function pruneSongsCache(
  dir: string,
  options?: { now?: number; maxAgeDays?: number; maxBytes?: number },
): string[];

export interface GetSongOptions {
  /** The song's name; empty with a link. */
  title?: string | null;
  artist?: string | null;
  version?: SongVersionName | null;
  /** An Instagram reel, TikTok, YouTube, YouTube Music, Spotify or Apple Music link. */
  link?: string | null;
  /** Where song-full.* and song-reel.* are written (made if missing). */
  workDir: string;
  /** Absolute paths: yt-dlp and deno (config's songTools); ffmpeg and ffprobe default to the ones found. */
  tools?: { ytDlp?: string; deno?: string; ffmpeg?: string | null; ffprobe?: string | null };
  /** Default process.env: APIFY_TOKEN is read from it first. */
  env?: Record<string, string | undefined>;
  /** Stops the call and kills yt-dlp's and ffmpeg's process trees. */
  signal?: AbortSignal;
  /** Default the repo's .env. */
  envFile?: string;
  /** Default the global fetch. Replaced in tests. */
  fetch?: typeof fetch;
  /** The songs-cache folder (~/.studio-engine/songs-cache): when given, downloads are kept there and reused. */
  cacheDir?: string | null;
  now?: () => number;
  /** Wait before the one retry of an Apify call, in ms. */
  retryMs?: number;
  timeouts?: Partial<{
    apify: number;
    itunes: number;
    page: number;
    reelAudio: number;
    search: number;
    info: number;
    download: number;
    ffmpeg: number;
  }>;
}

export interface GotSong {
  /** The clean full track (an m4a in workDir), or the reel's own audio when no clean track was found. */
  full: string;
  /** The reel's own audio (an m4a in workDir); `null` unless a reel link was asked for. */
  reel: string | null;
  meta: {
    title: string;
    artist: string;
    site: SongSiteName;
    via: SongViaName;
    url: string;
    id: string;
    fullMs: number;
  };
}

/** Gets the song asked for, or throws a SongError. One call at a time per workDir. */
export function getSong(options: GetSongOptions): Promise<GotSong>;
