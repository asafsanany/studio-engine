// Types of trending-pick.mjs, the trending pick (Songs, SG10), for its tests and the music script's
// `song --trending` (SG3). What it returns matches the shared contract (domain/music.ts:
// songTrendingSchema; domain/songs.ts: trendingCacheSchema, songTrendingEventSchema).

import type { GetSongOptions, GotSong } from './get-song.mjs';
import type { findBeats } from './song-beats.mjs';

export const TRENDING: {
  cache: { dir: string; maxAgeDays: number };
  costLog: string;
  lookbackDays: number;
  topReels: number;
  hashtagsMax: number;
  accountsMax: number;
  perHashtag: { total: number; min: number; max: number };
  perAccount: number;
  wantSongs: number;
  soundsMax: number;
  candidates: number;
  budget: { hashtags: number; accounts: number; sounds: number };
  prices: { result: number; reel: number; reelStart: number; sound: number };
  run: {
    timeoutS: number;
    callTimeoutMs: number;
    soundsTimeoutS: number;
    soundsCallTimeoutMs: number;
  };
  fit: { tempoTolerance: number; hookMs: number; hookShare: number; hookStepMs: number };
  ffmpegTimeoutMs: number;
};

export const ACTORS: { hashtags: string; accounts: string; sounds: string };

export interface Niche {
  /** Lower case, without the #. */
  hashtags: string[];
  /** Lower case, without the @. */
  accounts: string[];
  /** "#fpv #fpvdrone @falcon_fpv". */
  text: string;
}

/** A niche line's hashtags and accounts (at most 5 and 3). */
export function parseNiche(line: unknown): Niche;

/** <dataDir>/trends/<clientId>.json. */
export function trendingCachePath(dataDir: string, clientId: string): string;

/** One sound as the cache file keeps it (trendingSoundSchema). */
export interface CachedSound {
  igAudioId: string | null;
  title: string;
  artist: string;
  isSong: boolean;
  reels: number | null;
  isTrending: boolean | null;
  nicheTop20: number;
  url: string | null;
}

/** A sound while the pick works: the cache's fields and the Instagram ids that are this song. */
export interface Sound extends CachedSound {
  ids: string[];
  /** Instagram's trend rank (lower is better); `null` when it did not say. */
  trendRank: number | null;
}

/** The cached lookup for this niche, if it is there and under 7 days old; else `null`. */
export function readTrendingCache(
  file: string,
  niche: Niche,
  now: number,
): { fetchedAt: string; sounds: CachedSound[] } | null;

export interface Reel {
  id: string;
  plays: number;
  at: number | null;
  audioId: string;
  title: string;
  artist: string;
  original: boolean;
}

/** What a reel scraper item says that the pick uses; `null` for an item that is no reel. */
export function readReel(item: unknown): Reel | null;
/** The reels of the last 30 days, each once, the most played first. */
export function recentReels(items: readonly unknown[], now: number): Reel[];
/** The songs in the reels (see the file's top), with how many of the top 20 reels use each. */
export function soundsOfReels(reels: readonly Reel[]): Sound[];
/** Puts Instagram's reel count, trending flag and rank on the sounds from the audio scraper's rows. */
export function addInstagramNumbers(sounds: Sound[], rows: readonly unknown[]): Sound[];
/** The songs best first, by Instagram's own signals only. */
export function rankSounds<T extends Sound>(sounds: readonly T[]): T[];
/** Whether a tempo is the cut's, doubled or halved, within the tolerance; `null` when unknown. */
export function tempoFits(
  songBpm: number | null,
  cutBpm: number | null,
  tolerance?: number,
): boolean | null;
/** The estimated cost of a lookup at Apify's free-tier prices. */
export function estimateCost(items: { hashtags: number; accounts: number; sounds: number }): number;

export interface Fit {
  fits: boolean;
  /** In plain words, what does not fit. */
  why: string[];
  durationMs: number;
  bpm: number | null;
  /** `null` when the cut or the song has no known tempo. */
  tempo: boolean | null;
  /** Where the part the song command would cut starts in the song. */
  partStartMs: number;
  /** Where the part's biggest rise is in the song; `null` when none is clear. */
  dropAtMs: number | null;
  riseDb: number;
  hook: boolean;
}

/** Reads a song, finds the part the song command would cut and judges whether it fits the cut (tempo, a clear rise, a hook). */
export function measureFit(options: {
  file: string;
  /** A folder for the temporary WAV. */
  work: string;
  lengthMs: number;
  cutBpm?: number | null;
  env?: Record<string, string | undefined>;
  tools?: { ffmpeg?: string | null };
  beatFinder?: typeof findBeats;
}): Promise<Fit>;

export interface TrendingNumbers {
  reels: number | null;
  isTrending: boolean | null;
  nicheTop20: number;
  niche: string;
}

export interface PickedSong {
  title: string;
  artist: string;
  /** The YouTube link of the copy that was measured. */
  link: string | null;
  trending: TrendingNumbers;
  /** One sentence for the song command's line when the pick fits the cut badly, else `null`. */
  note: string | null;
  /** SG0's `music.song.trending` event. */
  event: {
    type: 'music.song.trending';
    at: string;
    niche: string;
    looked: number;
    pick: { title: string; artist: string };
  };
  /** The songs looked at, best ranked first. */
  considered: {
    title: string;
    artist: string;
    nicheTop20: number;
    reels: number | null;
    isTrending: boolean | null;
    got: boolean;
    fits: boolean;
    why: string[];
  }[];
  /** Whether the niche's lookup came from the 7-day cache. */
  cached: boolean;
  /** What the fresh lookup cost (an estimate; `null` for a cached one). */
  cost: {
    estimatedUsd: number;
    items: { hashtags: number; accounts: number; sounds: number };
  } | null;
}

export interface PickTrendingOptions {
  /** Names the cache file. */
  clientId: string;
  /** The client's folder name, for messages. */
  client?: string | null;
  /** The "Reels niche:" line (or the run's --niche): "#fpv #fpvdrone @falcon". */
  niche: string | null;
  /** The cut's length in ms. */
  lengthMs: number;
  /** The cut's tempo from plan.json, or `null`. */
  cutBpm?: number | null;
  /** Where the cut's drop is (plan.json); accepted, not judged. */
  dropMs?: number | null;
  env?: Record<string, string | undefined>;
  /** The engine's data folder (~/.studio-engine): the cache is <dataDir>/trends/<clientId>.json. */
  dataDir: string;
  /** The songs-cache (~/.studio-engine/songs-cache). */
  cacheDir?: string | null;
  signal?: AbortSignal;
  // For tests:
  fetch?: typeof fetch;
  getSong?: (options: GetSongOptions) => Promise<GotSong>;
  /** Extra options for the getter (a fake fetch, envFile, retryMs …). */
  getSongOptions?: Partial<GetSongOptions>;
  beatFinder?: typeof findBeats;
  tools?: { ytDlp?: string; deno?: string; ffmpeg?: string | null; ffprobe?: string | null };
  envFile?: string;
  now?: () => number;
  retryMs?: number;
  timeouts?: Partial<{ apify: number }>;
}

/** The trending song for a job: see the file's top. Throws a SongError (`needs_key`, `no_trending`, `blocked`, …). */
export function pickTrending(options: PickTrendingOptions): Promise<PickedSong>;
