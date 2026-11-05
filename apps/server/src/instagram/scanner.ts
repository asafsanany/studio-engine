// The scanner of Clients × Instagram (IG3): one scan of one client's Instagram account. It runs the
// two Apify actors through the IG2 client (the profile, then the reels), maps what they answered into
// the IG1 tables, saves the profile picture and ends the scan row with what it read and what it cost.
// When scans run, Scan now, and what a rename or delete waits for is IG4's: it calls `scan()` from its
// own queue, with an AbortSignal, and asks `isScanning()` for the clients being scanned.
//
//   1. a scan row is started (no outcome yet);
//   2. apify/instagram-profile-scraper for the handle: private ends the scan as `private`, a missing
//      account as `not-found`;
//   3. apify/instagram-reel-scraper with the shares add-on on: the reels of the last 28 days (the
//      first scan of an account, or of a new handle: 90), 60 at the most;
//   4. the profile picture is saved to <dataDir>/instagram/photos/<clientId>.jpg, through a temp file
//      and a rename (a download that fails keeps the old file and never fails the scan);
//   5. in one transaction: the account's name, bio, private flag and Instagram id, the reels, one
//      read per reel, and the end of the scan row: `ok`, the followers, following and posts, the
//      reels read, the cost (the runs' `costUsd` added up) and the run ids.
//
// A scan that does not end `ok` writes no reel and no account field: the row only says how it ended,
// what it cost and which runs it started, and the last numbers stay as they were. The cost is written
// whatever the outcome, because Apify charged it (Money reads it from the scan rows).
//
// That cost is the one Apify reports as the runs end, which is early: Apify tallies the charges a few
// seconds later. `settleCosts()` reads the runs again some minutes after (./scan-costs.ts) and writes
// what they really cost; IG4's queue calls it at every check.
//
// What the actors answered is written down in ./README.md; the answers of real runs are in
// ./testdata/. Everything is read defensively: an item that is not a reel is skipped, a number that
// is missing is 0 (a hidden like count is -1 on Instagram: it is 0 here), and the shares, which the
// actor only gives on a paid Apify plan, are `null` when they are not there.

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { instagramPhotoFor, instagramPhotosDirFor } from '../clients/paths.js';
import {
  handleOf,
  type InstagramReelInput,
  type InstagramRepository,
  type InstagramScan,
  type InstagramScanEnd,
  type InstagramScanOutcome,
} from '../db/instagram-repository.js';
import {
  ApifyError,
  type FetchLike,
  PROFILE_ACTOR,
  profileScraperInput,
  REEL_ACTOR,
  type RunActorOptions,
  type RunActorResult,
  readRunCost,
  reelScraperInput,
  runActor,
} from './apify.js';
import { type RunCostReader, settleScanCosts } from './scan-costs.js';

// --- what a scan reads ---------------------------------------------------------------------------

/** The reels of the last this many days are read by the first scan of an account (or a new handle). */
export const FIRST_SCAN_DAYS = 90;
/** The reels of the last this many days are read by every other scan. Older reels keep their numbers. */
export const SCAN_DAYS = 28;
/** The most reels one scan reads. */
export const REELS_LIMIT = 60;

/**
 * The most each run may cost, in US dollars: Apify stops a pay-per-event run at it. The price list
 * (README.md) has a profile at $0.0026 and a reel at $0.0026 with $0.007 more for the shares add-on,
 * so the most a run can come to is $0.01 and $0.58; these leave room and stop a run that goes wrong.
 */
export const PROFILE_MAX_CHARGE_USD = 0.25;
export const REELS_MAX_CHARGE_USD = 1;

/** What the sound of a reel that uses the account's own audio is called. */
export const ORIGINAL_AUDIO = 'Original audio';
/** Between a song's name and its artist in the sound of a reel. */
export const SOUND_SEPARATOR = ' · ';

/** The most a profile picture may weigh, in bytes. Instagram's are about 100 KB. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** The most one try at downloading the picture may take, in milliseconds. */
export const PHOTO_TIMEOUT_MS = 30_000;
/**
 * How many times the picture is asked for: Instagram's CDN sometimes does not take the connection,
 * or answers 5xx. Each try after the first waits PHOTO_RETRY_GAP_MS longer than the one before.
 */
export const PHOTO_TRIES = 3;
export const PHOTO_RETRY_GAP_MS = 2_000;
/**
 * The hosts the picture is downloaded from: Instagram's own and its CDNs (any host under them). The
 * profile scraper gives a link on cdninstagram.com or on Meta's fbcdn.net, run by run.
 */
const PHOTO_HOSTS = ['cdninstagram.com', 'instagram.com', 'fbcdn.net'];

/** The words of a scan's `error`, for the page. */
export const SCAN_MESSAGES = {
  /** A run that went over its time. */
  noAnswer: "Instagram didn't answer",
  /** The caller's signal stopped the scan. */
  stopped: 'The scan was stopped',
  /** The account was removed, or its handle changed, before the scan could write. */
  accountChanged: 'The Instagram account was changed or removed while the scan ran',
} as const;

// --- the interface ---------------------------------------------------------------------------------

export interface InstagramScanOptions {
  /**
   * Whether this is the first scan of the account or of a new handle, which reads 90 days instead
   * of 28. Default: it is, unless the client's latest `ok` scan was of this handle.
   */
  first?: boolean;
  /** Stops the scan (the Apify run is aborted too). It then ends `failed` with `cancelled`. */
  signal?: AbortSignal;
}

export interface InstagramScanResult {
  /** The scan's row as it was finished. */
  scan: InstagramScan;
  outcome: InstagramScanOutcome;
  /** Why it did not end `ok` (a plain sentence); `null` for `ok`. */
  error: string | null;
  /** True when the caller's signal stopped the scan (it ends `failed`, with {@link SCAN_MESSAGES}.stopped). */
  cancelled: boolean;
  /** Whether this scan saved a new profile picture. */
  photoSaved: boolean;
}

/**
 * What IG4 calls, and what the fake scanner is too. `scan` always resolves with the scan's finished
 * row, whatever happened to it; it rejects only when the database itself fails. Scans of one client
 * run one after another.
 */
export interface InstagramScanner {
  /**
   * Scans the client's account, `handle`, and writes what it read. The client needs an Instagram
   * account row (a client without one ends `failed` before anything is sent to Apify).
   */
  scan(
    clientId: string,
    handle: string,
    options?: InstagramScanOptions,
  ): Promise<InstagramScanResult>;
  /** True from the moment `scan` is called for the client until its result is in. */
  isScanning(clientId: string): boolean;
  /**
   * Reads the Apify runs of the scans that ended a few minutes ago again and writes what they really
   * cost (C90): a scan's cost is read as its runs end, before Apify has tallied the charges. Also
   * corrects the scans stored before this existed. Resolves with how many scans' cost changed; it
   * never throws for Apify, only for the database. Optional: a scanner that never spends (a test
   * stand-in) has nothing to settle.
   */
  settleCosts?(options?: { signal?: AbortSignal }): Promise<number>;
}

/** Runs an Apify actor and gives back its items: `runActor` of ./apify.ts, or a stand-in for it. */
export type ActorRunner = <T = unknown>(
  actorId: string,
  input: unknown,
  options?: RunActorOptions,
) => Promise<RunActorResult<T>>;

export interface InstagramScannerOptions {
  instagram: InstagramRepository;
  /** The data folder (`Config.dataDir`): the picture goes to <dataDir>/instagram/photos/. */
  dataDir: string;
  /** The clock for `photo_saved_at`. Default: the system's. */
  clock?: () => Date;
  /** Apify's `fetch`, and the picture's. Injected in tests (it must answer both). Default: the global one. */
  fetch?: FetchLike;
  /** Runs an actor. Default: `runActor`. The fake scanner swaps it for an answer from fixtures. */
  runActor?: ActorRunner;
  /** Reads a finished run's cost again. Default: `readRunCost`. The fake scanner swaps it too. */
  readRunCost?: RunCostReader;
  /** The Apify key (tests); default: APIFY_TOKEN from `env`, then the .env file (see ./apify.ts). */
  token?: string;
  env?: Record<string, string | undefined>;
  envFile?: string;
  /** The most one run may take (default 10 minutes), and the pauses of the client (tests: 0). */
  timeoutMs?: number;
  pollSecs?: number;
  pollGapMs?: number;
  /** The pause before the picture's second try (default {@link PHOTO_RETRY_GAP_MS}; tests: 0). */
  photoRetryGapMs?: number;
}

// --- mapping what Apify answered ---------------------------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string that is not empty, else `null`. */
const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** A whole number from 0 up: a number Instagram hides is -1, and that is 0; `null` when it is no number. */
const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;

/** A number that is really there, from 0 up: `null` for a missing one and for a hidden one (-1). */
const readCountOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** What the profile scraper read of the account. */
export interface InstagramProfileRead {
  /** Instagram's id of the account. */
  instagramId: string | null;
  fullName: string | null;
  biography: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  private: boolean;
  /** The profile picture's link (signed: it expires). */
  pictureUrl: string | null;
}

/** Why a scan ends before it can write: how it ends and what the page says. */
class ScanStop extends Error {
  readonly outcome: InstagramScanOutcome;
  readonly cancelled: boolean;

  constructor(outcome: InstagramScanOutcome, message: string, cancelled = false) {
    super(message);
    this.name = 'ScanStop';
    this.outcome = outcome;
    this.cancelled = cancelled;
  }
}

/**
 * The stop an item that is no profile or reel stands for. Both actors answer a missing account with a
 * run that SUCCEEDED and one item `{ error: "not_found", errorDescription }`; any other `error` is
 * Instagram's own reason (rate limits, a blocked page) and the scan fails with it.
 */
function stopOfErrorItem(item: Json, handle: string): ScanStop | null {
  const code = textOf(item.error);
  if (code === null || textOf(item.shortCode) !== null) return null;
  if (code.toLowerCase().replace(/[\s-]+/g, '_') === 'not_found') {
    return new ScanStop('not-found', `@${handle} was not found on Instagram`);
  }
  return new ScanStop('failed', `Instagram said: ${textOf(item.errorDescription) ?? code}`);
}

/** The reel run's answer for an account with no reels: `{ error: "no_items", errorDescription }`. */
function isNoItems(item: Json): boolean {
  return (
    textOf(item.error)
      ?.toLowerCase()
      .replace(/[\s-]+/g, '_') === 'no_items'
  );
}

/**
 * The profile in the items of the profile run. Throws the stop for a missing account (`not-found`)
 * and for an answer that is no profile (`failed`).
 */
export function readProfile(items: readonly unknown[], handle: string): InstagramProfileRead {
  const records = items.filter(isRecord);
  const item =
    records.find((record) => textOf(record.username)?.toLowerCase() === handle) ?? records[0];
  if (item === undefined) throw new ScanStop('failed', `Instagram answered nothing for @${handle}`);
  const stop = stopOfErrorItem(item, handle);
  if (stop !== null) throw stop;

  const id = item.id;
  const profile: InstagramProfileRead = {
    instagramId:
      typeof id === 'number' && Number.isFinite(id) ? String(id) : (textOf(id)?.trim() ?? null),
    fullName: textOf(item.fullName),
    biography: textOf(item.biography),
    followers: readCountOf(item.followersCount),
    following: readCountOf(item.followsCount),
    posts: readCountOf(item.postsCount),
    private: item.private === true,
    pictureUrl: textOf(item.profilePicUrlHD) ?? textOf(item.profilePicUrl),
  };
  if (!profile.private && profile.followers === null) {
    throw new ScanStop('failed', `Instagram's answer for @${handle} had no follower count`);
  }
  return profile;
}

/**
 * The shares of a reel: `sharesCount`, else the first number under a key that matches /share/i, else
 * `null`. The add-on that gives them is only on a paid Apify plan, and on the free one the answer has
 * no such field at all, so a reel without shares is normal and never fails a scan.
 */
export function sharesOf(item: Json): number | null {
  const direct = readCountOf(item.sharesCount);
  if (direct !== null) return direct;
  for (const [key, value] of Object.entries(item)) {
    if (!/share/i.test(key)) continue;
    const found = readCountOf(value);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The sound of a reel: "Original audio" for the account's own audio, else the song's name and its
 * artist (`Song · Artist`, just the name when the artist is not given); `null` when there is none.
 */
export function soundOf(musicInfo: unknown): string | null {
  if (!isRecord(musicInfo)) return null;
  const song = textOf(musicInfo.song_name)?.trim() ?? null;
  if (
    musicInfo.uses_original_audio === true ||
    song?.toLowerCase() === ORIGINAL_AUDIO.toLowerCase()
  ) {
    return ORIGINAL_AUDIO;
  }
  if (song === null) return null;
  const artist = textOf(musicInfo.artist_name)?.trim() ?? null;
  return artist === null ? song : `${song}${SOUND_SEPARATOR}${artist}`;
}

/**
 * The other authors of a reel, for the "with" column: the owner of a collab reel that the client
 * is only a co-author of, then the co-authors, without the client and without repeats.
 * `coauthorProducers` is missing from a reel that has none.
 */
function coauthorsOf(item: Json, handle: string): string[] {
  const names: string[] = [];
  const owner = textOf(item.ownerUsername);
  if (owner !== null) names.push(owner);
  if (Array.isArray(item.coauthorProducers)) {
    for (const producer of item.coauthorProducers) {
      const name = isRecord(producer) ? textOf(producer.username) : null;
      if (name !== null) names.push(name);
    }
  }
  const seen = new Set<string>([handle]);
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SHORTCODE = /^[A-Za-z0-9_-]+$/;

/**
 * One reel of the reel scraper as the table keeps it (field names in README.md); `null` for an item
 * that is not a reel (no usable shortcode or time). The plays are `videoPlayCount`, else
 * `videoViewCount` (`null` in real runs). Collab reels are kept as they are: they show on the
 * client's grid too.
 */
export function mapReel(item: Json, clientId: string, handle: string): InstagramReelInput | null {
  const shortcode = textOf(item.shortCode);
  if (shortcode === null || !SHORTCODE.test(shortcode)) return null;
  const postedAt = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : Number.NaN;
  if (!Number.isFinite(postedAt) || postedAt < 0) return null;

  const duration = item.videoDuration;
  return {
    shortcode,
    clientId,
    url: textOf(item.url) ?? `https://www.instagram.com/reel/${shortcode}/`,
    postedAt,
    caption: typeof item.caption === 'string' ? item.caption : null,
    durationSec:
      typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    plays: countOf(item.videoPlayCount) ?? countOf(item.videoViewCount) ?? 0,
    likes: countOf(item.likesCount) ?? 0,
    comments: countOf(item.commentsCount) ?? 0,
    shares: sharesOf(item),
    sound: soundOf(item.musicInfo),
    coauthors: coauthorsOf(item, handle),
    hashtags: Array.isArray(item.hashtags)
      ? item.hashtags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
      : [],
    pinned: item.isPinned === true,
    paidPartnership: item.paidPartnership === true,
  };
}

/**
 * The reels in the items of the reel run, each once (a shortcode listed twice takes the later). An
 * answer that is only the not-found item is the stop `not-found`, like the profile's. Items that are
 * not reels are left out, and so is the `no_items` item ("Empty or private data for provided
 * input"): the profile run already read the account as public, so it means the account has no reels
 * yet (only photos), which is a scan like any other with nothing to list.
 */
export function readReels(
  items: readonly unknown[],
  clientId: string,
  handle: string,
): InstagramReelInput[] {
  const records = items.filter(isRecord);
  const reels = new Map<string, InstagramReelInput>();
  let stop: ScanStop | null = null;
  for (const record of records) {
    if (isNoItems(record)) continue;
    const failure = stopOfErrorItem(record, handle);
    if (failure !== null) {
      stop ??= failure;
      continue;
    }
    const reel = mapReel(record, clientId, handle);
    if (reel !== null) reels.set(reel.shortcode, reel);
  }
  if (reels.size === 0 && stop !== null) throw stop;
  return [...reels.values()];
}

// --- the scanner -------------------------------------------------------------------------------------

/** What the Apify runs of a scan cost and which they were. */
interface Spent {
  costUsd: number;
  runIds: string[];
}

function addRun(spent: Spent, run: { runId: string | null; costUsd: number | null }): void {
  if (run.runId !== null) spent.runIds.push(run.runId);
  spent.costUsd = Math.round((spent.costUsd + (run.costUsd ?? 0)) * 1e6) / 1e6;
}

/** What a scan found, and what is left to write of it. */
interface Plan {
  outcome: InstagramScanOutcome;
  error: string | null;
  cancelled: boolean;
  /** What to write; `null` when the scan ended before it read anything worth writing. */
  write: {
    profile: InstagramProfileRead;
    reels: InstagramReelInput[];
    photoSavedAt: number | null;
  } | null;
}

/** The stop that an error stands for. */
function stopOfError(error: unknown): ScanStop {
  if (error instanceof ScanStop) return error;
  if (error instanceof ApifyError) {
    if (error.cancelled) return new ScanStop('failed', SCAN_MESSAGES.stopped, true);
    if (error.code === 'no-token') return new ScanStop('no-token', error.message);
    if (error.code === 'no-credit') return new ScanStop('no-credit', error.message);
    if (error.code === 'timeout') return new ScanStop('failed', SCAN_MESSAGES.noAnswer);
    return new ScanStop('failed', error.message);
  }
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
  return new ScanStop('failed', message === '' ? 'The scan failed' : message.slice(0, 300));
}

class Scanner implements InstagramScanner {
  private readonly options: InstagramScannerOptions;
  private readonly instagram: InstagramRepository;
  private readonly runActor: ActorRunner;
  private readonly readRunCost: RunCostReader;
  private readonly clock: () => Date;
  /** The scans of a client that are queued or running, and where its next one waits. */
  private readonly pending = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: InstagramScannerOptions) {
    this.options = options;
    this.instagram = options.instagram;
    this.runActor = options.runActor ?? runActor;
    this.readRunCost =
      options.readRunCost ??
      ((runId, read) => {
        const { fetch, token, env, envFile, pollGapMs } = this.options;
        return readRunCost(runId, { fetch, token, env, envFile, pollGapMs, ...read });
      });
    this.clock = options.clock ?? (() => new Date());
  }

  isScanning(clientId: string): boolean {
    return (this.pending.get(clientId) ?? 0) > 0;
  }

  async settleCosts(options: { signal?: AbortSignal } = {}): Promise<number> {
    const { changed } = await settleScanCosts({
      instagram: this.instagram,
      readRunCost: this.readRunCost,
      clock: this.clock,
      signal: options.signal,
    });
    return changed;
  }

  async scan(
    clientId: string,
    handle: string,
    options: InstagramScanOptions = {},
  ): Promise<InstagramScanResult> {
    this.pending.set(clientId, (this.pending.get(clientId) ?? 0) + 1);
    const before = this.tails.get(clientId) ?? Promise.resolve();
    const mine = before.then(() => this.perform(clientId, handleOf(handle), options));
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(clientId, tail);
    try {
      return await mine;
    } finally {
      const left = (this.pending.get(clientId) ?? 1) - 1;
      if (left > 0) {
        this.pending.set(clientId, left);
      } else {
        this.pending.delete(clientId);
        if (this.tails.get(clientId) === tail) this.tails.delete(clientId);
      }
    }
  }

  private async perform(
    clientId: string,
    handle: string,
    options: InstagramScanOptions,
  ): Promise<InstagramScanResult> {
    const first = options.first ?? this.isFirstScan(clientId, handle);
    const started = this.instagram.startScan({ clientId, handle });
    const spent: Spent = { costUsd: 0, runIds: [] };

    let plan: Plan;
    try {
      plan = await this.read(clientId, handle, first, options.signal, spent);
    } catch (error) {
      const stop = stopOfError(error);
      plan = { outcome: stop.outcome, error: stop.message, cancelled: stop.cancelled, write: null };
    }

    let scan: InstagramScan;
    try {
      scan = this.commit(started.id, clientId, handle, plan, spent);
    } catch (error) {
      // The write broke (the database, not Apify): nothing of it is kept, the scan row still ends.
      const stop = stopOfError(error);
      plan = { outcome: 'failed', error: stop.message, cancelled: false, write: null };
      scan = this.instagram.finishScan(started.id, this.endOf(plan, spent));
    }
    return {
      scan,
      outcome: scan.outcome ?? plan.outcome,
      error: scan.error,
      cancelled: plan.cancelled,
      // A write that was dropped (the account changed under it) saved nothing of the scan's.
      photoSaved: scan.outcome === plan.outcome && plan.write?.photoSavedAt != null,
    };
  }

  /** The first scan of an account (or of a new handle) reads further back than the others. */
  private isFirstScan(clientId: string, handle: string): boolean {
    return this.instagram.latestOkScan(clientId)?.handle !== handle;
  }

  /** Whether the client still has this account: the handle may have changed while a scan ran. */
  private isStillThe(clientId: string, handle: string): boolean {
    return this.instagram.getAccount(clientId)?.handle === handle;
  }

  /** One Apify run, its cost and id noted whether it worked or not. */
  private async run(
    actorId: string,
    input: unknown,
    maxChargeUsd: number,
    signal: AbortSignal | undefined,
    spent: Spent,
  ): Promise<unknown[]> {
    const { fetch, token, env, envFile, timeoutMs, pollSecs, pollGapMs } = this.options;
    try {
      const result = await this.runActor<unknown>(actorId, input, {
        signal,
        maxChargeUsd,
        fetch,
        token,
        env,
        envFile,
        timeoutMs,
        pollSecs,
        pollGapMs,
      });
      addRun(spent, result);
      return result.items;
    } catch (error) {
      if (error instanceof ApifyError) addRun(spent, error);
      throw error;
    }
  }

  /** The Apify runs and the picture: what the scan found. Throws the stop when it cannot go on. */
  private async read(
    clientId: string,
    handle: string,
    first: boolean,
    signal: AbortSignal | undefined,
    spent: Spent,
  ): Promise<Plan> {
    // No account, nothing to scan: ends before a cent is spent.
    if (!this.isStillThe(clientId, handle)) {
      throw new ScanStop('failed', SCAN_MESSAGES.accountChanged);
    }

    const profile = readProfile(
      await this.run(
        PROFILE_ACTOR,
        profileScraperInput([handle]),
        PROFILE_MAX_CHARGE_USD,
        signal,
        spent,
      ),
      handle,
    );
    if (profile.private) {
      const photoSavedAt = await this.savePhoto(clientId, handle, profile.pictureUrl, signal);
      return {
        outcome: 'private',
        error: `@${handle} is a private account, so its reels can't be read`,
        cancelled: false,
        write: { profile, reels: [], photoSavedAt },
      };
    }

    const reels = readReels(
      await this.run(
        REEL_ACTOR,
        reelScraperInput({
          usernames: [handle],
          resultsLimit: REELS_LIMIT,
          newerThanDays: first ? FIRST_SCAN_DAYS : SCAN_DAYS,
          shares: true,
        }),
        REELS_MAX_CHARGE_USD,
        signal,
        spent,
      ),
      clientId,
      handle,
    );
    // Stopped after the runs: what they read is dropped, as it is for a scan stopped during them.
    if (signal?.aborted) throw new ScanStop('failed', SCAN_MESSAGES.stopped, true);

    const photoSavedAt = await this.savePhoto(clientId, handle, profile.pictureUrl, signal);
    return {
      outcome: 'ok',
      error: null,
      cancelled: false,
      write: { profile, reels, photoSavedAt },
    };
  }

  /**
   * Saves the profile picture as <dataDir>/instagram/photos/<clientId>.jpg, through a temp file and a
   * rename, and gives the time it was saved. Anything that goes wrong (no link, a host that is not
   * Instagram's, an answer that is no picture, too big, the network after its tries, the disk) gives
   * `null` and leaves the file that was there. The picture's link is signed, so nothing but the link
   * is sent.
   */
  private async savePhoto(
    clientId: string,
    handle: string,
    url: string | null,
    signal: AbortSignal | undefined,
  ): Promise<number | null> {
    if (url === null || !this.isStillThe(clientId, handle)) return null;
    const { dataDir } = this.options;
    let temporary: string | null = null;
    try {
      const link = new URL(url);
      const host = link.hostname.toLowerCase();
      if (
        link.protocol !== 'https:' ||
        !PHOTO_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
      ) {
        return null;
      }
      const bytes = await this.downloadPhoto(link, signal);
      if (bytes === null) return null;

      await mkdir(instagramPhotosDirFor(dataDir), { recursive: true });
      temporary = join(
        instagramPhotosDirFor(dataDir),
        `.${clientId}.${randomBytes(4).toString('hex')}.tmp`,
      );
      await writeFile(temporary, bytes);
      await rename(temporary, instagramPhotoFor(dataDir, clientId));
      temporary = null;
      return this.clock().getTime();
    } catch {
      return null;
    } finally {
      if (temporary !== null) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * The picture's bytes, or `null` for an answer that is no picture (an error status, not an image,
   * empty, too big). A connection that fails and a 5xx or 429 answer are tried again, PHOTO_TRIES
   * times in all; the last failure throws. The caller's signal stops the tries.
   */
  private async downloadPhoto(link: URL, signal: AbortSignal | undefined): Promise<Buffer | null> {
    const fetchPicture = this.options.fetch ?? ((input, init) => fetch(input, init));
    const gapMs = this.options.photoRetryGapMs ?? PHOTO_RETRY_GAP_MS;
    for (let tries = 1; ; tries += 1) {
      const last = tries >= PHOTO_TRIES;
      let response: Response;
      try {
        const timer = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
        response = await fetchPicture(link.toString(), {
          signal: signal === undefined ? timer : AbortSignal.any([timer, signal]),
        });
      } catch (error) {
        if (last || signal?.aborted === true) throw error;
        await delay(gapMs * tries, undefined, { signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (last || (response.status < 500 && response.status !== 429)) return null;
        await delay(gapMs * tries, undefined, { signal });
        continue;
      }
      if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) {
        return null;
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > PHOTO_MAX_BYTES) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES ? null : bytes;
    }
  }

  private endOf(plan: Plan, spent: Spent): InstagramScanEnd {
    const profile = plan.outcome === 'ok' ? plan.write?.profile : undefined;
    return {
      outcome: plan.outcome,
      error: plan.error,
      followers: profile?.followers ?? null,
      following: profile?.following ?? null,
      posts: profile?.posts ?? null,
      reelsRead: plan.outcome === 'ok' ? (plan.write?.reels.length ?? 0) : 0,
      costUsd: spent.costUsd,
      apifyRunIds: [...spent.runIds],
    };
  }

  /**
   * The one write of a scan: the account, the reels, their reads and the end of the scan row, all or
   * none. A scan that ended before it read anything only gets its row ended. If the account was
   * removed or given another handle in the meantime, nothing is written but the row, `failed`.
   */
  private commit(
    scanId: number,
    clientId: string,
    handle: string,
    plan: Plan,
    spent: Spent,
  ): InstagramScan {
    const { instagram } = this;
    return instagram.atomically(() => {
      const write = plan.write;
      if (write === null) return instagram.finishScan(scanId, this.endOf(plan, spent));

      const account = instagram.getAccount(clientId);
      if (account === null || account.handle !== handle) {
        const gone: Plan = {
          outcome: 'failed',
          error: SCAN_MESSAGES.accountChanged,
          cancelled: false,
          write: null,
        };
        return instagram.finishScan(scanId, this.endOf(gone, spent));
      }

      const { profile } = write;
      instagram.upsertAccount({
        clientId,
        client: account.client,
        handle,
        ...(profile.instagramId === null ? {} : { instagramId: profile.instagramId }),
        fullName: profile.fullName,
        biography: profile.biography,
        private: profile.private,
        ...(write.photoSavedAt === null ? {} : { photoSavedAt: write.photoSavedAt }),
      });
      if (write.reels.length > 0) {
        instagram.upsertReels(scanId, write.reels);
        instagram.addReelReads(
          scanId,
          write.reels.map((reel) => ({
            shortcode: reel.shortcode,
            plays: reel.plays,
            likes: reel.likes,
            comments: reel.comments,
            shares: reel.shares ?? null,
          })),
        );
      }
      return instagram.finishScan(scanId, this.endOf(plan, spent));
    });
  }
}

/** A scanner that runs the real Apify actors. IG4 holds one for the engine. */
export function createInstagramScanner(options: InstagramScannerOptions): InstagramScanner {
  return new Scanner(options);
}
