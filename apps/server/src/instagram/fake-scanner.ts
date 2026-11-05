// The fake scanner of Clients × Instagram (IG3): the real scanner (./scanner.ts) with Apify swapped
// for answers from fixture JSON, so tests, e2e and the dev seed (IG13) go through the same mapping,
// the same transaction, the same picture file and the same scan rows as a real scan, and touch no
// network, no key and no money.
//
// It answers the way the actors do. A handle that has fixtures gets its profile and reel items; a
// handle that has none gets the "not found" item both actors answer a missing account with. A
// fixture may also fail the way Apify does (`fails`: no-token, no-credit, timeout, failed). Every
// run reports a made-up id (`fake-run-N`) and the cost the price list gives (README.md): $0.0026 for
// a profile, $0.001 and $0.0026 a reel for the reels. The scan's cost check (`settleCosts`) reads
// those same made-up runs back from memory, so it never reaches Apify either. The profile picture of every account is a small
// JPEG, served as if it came from the Instagram CDN, unless the options give other bytes.
//
// `loadFakeInstagramFixtures()` reads the real answers in ./testdata/ (natgeo, a private account and
// one that does not exist). A test or the seed that wants its own accounts passes `fixtures`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApifyError,
  type ApifyErrorCode,
  type RunActorOptions,
  type RunCostReading,
} from './apify.js';
import {
  type ActorRunner,
  createInstagramScanner,
  type InstagramScanner,
  type InstagramScannerOptions,
} from './scanner.js';

/**
 * The real answers of ./testdata/. tsc doesn't copy testdata/ into dist/, and this path works from
 * src/instagram/ (dev, tests) and from dist/instagram/ (the built server, e2e) alike: both are two
 * folders below apps/server/.
 */
const TESTDATA_DIR = fileURLToPath(new URL('../../src/instagram/testdata/', import.meta.url));

/** What a fixture that answers by the scan is told: which scan of the handle this is, and when. */
export interface FakeInstagramContext {
  /** 1 for the first scan of the handle since the fake started, 2 for the next, and so on. */
  scan: number;
  /** The scanner's clock when the run started. */
  now: Date;
}

/** The items of a run: fixed, or worked out for the scan (an account that grows, a reel not posted yet). */
export type FakeInstagramItems = unknown[] | ((context: FakeInstagramContext) => unknown[]);

/** What the actors answer for one account. */
export interface FakeInstagramAccount {
  /** The items of the profile scraper's run. */
  profile: FakeInstagramItems;
  /** The items of the reel scraper's run. */
  reels: FakeInstagramItems;
  /** The profile run fails the way Apify does, and nothing is read. */
  fails?: ApifyErrorCode;
  /**
   * The scan of the handle from which `fails` applies (default 1: every scan). 2 makes the first
   * scan work and every later one fail: the "numbers from the last scan" state of a failed scan.
   */
  failsFrom?: number;
  /** This account's picture, served for the link its profile item names. Default: the options' `photo`. */
  photo?: Uint8Array;
}

/** The accounts the fake knows, by handle (lower case, no `@`). */
export type FakeInstagramFixtures = Record<string, FakeInstagramAccount>;

/** The price of a profile run and of a reel run, in dollars (README.md, the free plan's prices). */
export const FAKE_PROFILE_COST_USD = 0.0026;
export const FAKE_REEL_START_COST_USD = 0.001;
export const FAKE_REEL_COST_USD = 0.0026;

const FAILURES: Record<ApifyErrorCode, string> = {
  'no-token': 'There is no Apify key: add APIFY_TOKEN to .env',
  'no-credit':
    "Apify refuses the run for usage (HTTP 402). Check the Apify account's credit (fake failure)",
  timeout: 'The Apify run took longer than 600 s and was stopped (fake failure)',
  failed: 'The Apify run failed (fake failure)',
};

/** A 1×1 JPEG: what every fake account's picture is unless the options give another. */
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

function readJson(dir: string, name: string): unknown[] {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as unknown[];
}

/**
 * The fixtures of ./testdata/ (the real answers of IG2's runs): `natgeo` (a profile and five
 * reels, one a collab owned by another account), `example_private_creator` (a private account) and
 * `studio_engine_no_such_user_8f3k2` (an account that does not exist).
 */
export function loadFakeInstagramFixtures(dir: string = TESTDATA_DIR): FakeInstagramFixtures {
  return {
    natgeo: { profile: readJson(dir, 'profile'), reels: readJson(dir, 'reels') },
    example_private_creator: { profile: readJson(dir, 'profile-private'), reels: [] },
    studio_engine_no_such_user_8f3k2: {
      profile: readJson(dir, 'profile-not-found'),
      reels: readJson(dir, 'reels-not-found'),
    },
  };
}

export interface FakeInstagramScannerOptions
  extends Pick<InstagramScannerOptions, 'instagram' | 'dataDir' | 'clock'> {
  /** The accounts it knows. Default: {@link loadFakeInstagramFixtures}. */
  fixtures?: FakeInstagramFixtures;
  /**
   * How long each of a scan's two runs takes, in milliseconds (default 0): long enough to see
   * "Scanning". A function is asked at the start of every run, so the seed can make its own history
   * scans instant and the live ones slow.
   */
  delayMs?: number | (() => number);
  /** The bytes of every account's picture. Default: a 1×1 JPEG. */
  photo?: Uint8Array;
}

/** Waits `ms`, or less when the signal aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The handle a run was asked for: the actors' inputs name it (`usernames` for profiles, `username` for reels). */
function askedHandle(input: unknown): string {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const names = record.usernames ?? record.username;
  const first = Array.isArray(names) ? names[0] : undefined;
  return typeof first === 'string' ? first.trim().replace(/^@+/, '').toLowerCase() : '';
}

/** The not-found item the actors answer a missing account with. */
function notFoundItem(handle: string): unknown {
  return {
    url: `https://www.instagram.com/${handle}`,
    username: handle,
    error: 'not_found',
    errorDescription: 'Profile does not exist',
  };
}

/** The scanner of ./scanner.ts with the answers of `options.fixtures` in place of Apify's. */
export function createFakeInstagramScanner(options: FakeInstagramScannerOptions): InstagramScanner {
  const fixtures = options.fixtures ?? loadFakeInstagramFixtures();
  const delayOf = (): number =>
    typeof options.delayMs === 'function' ? options.delayMs() : (options.delayMs ?? 0);
  const photo = options.photo ?? PLACEHOLDER_JPEG;
  let runs = 0;
  /** What each made-up run cost, for the cost check to read back. */
  const runCosts = new Map<string, number>();
  const clock = options.clock ?? (() => new Date());
  /** The scans of each handle so far: a profile run starts one, the reel run after it belongs to it. */
  const scansOf = new Map<string, number>();
  /** The picture of each link a profile item names, for the accounts that have their own. */
  const photoOfLink = new Map<string, Uint8Array>();

  const runActor: ActorRunner = async <T>(
    actorId: string,
    input: unknown,
    run?: RunActorOptions,
  ) => {
    await pause(delayOf(), run?.signal);
    if (run?.signal?.aborted) {
      throw new ApifyError('failed', 'The Apify run was cancelled', { cancelled: true });
    }
    const handle = askedHandle(input);
    const account = fixtures[handle];
    runs += 1;
    const runId = `fake-run-${runs}`;
    const isProfile = actorId.includes('profile');
    if (isProfile) scansOf.set(handle, (scansOf.get(handle) ?? 0) + 1);
    const context: FakeInstagramContext = { scan: scansOf.get(handle) ?? 1, now: clock() };
    if (account?.fails !== undefined && isProfile && context.scan >= (account.failsFrom ?? 1)) {
      runCosts.set(runId, 0);
      throw new ApifyError(account.fails, FAILURES[account.fails], { runId, costUsd: 0 });
    }
    const answer = isProfile ? account?.profile : account?.reels;
    let items: unknown[] =
      typeof answer === 'function' ? answer(context) : (answer ?? [notFoundItem(handle)]);
    if (isProfile && account?.photo !== undefined) {
      for (const item of items) {
        const link = (item as { profilePicUrlHD?: unknown } | null)?.profilePicUrlHD;
        if (typeof link === 'string') photoOfLink.set(link, account.photo);
      }
    }
    if (!isProfile && typeof (input as { resultsLimit?: unknown }).resultsLimit === 'number') {
      items = items.slice(0, (input as { resultsLimit: number }).resultsLimit);
    }
    const costUsd = isProfile
      ? FAKE_PROFILE_COST_USD
      : FAKE_REEL_START_COST_USD + FAKE_REEL_COST_USD * items.length;
    const rounded = Math.round(costUsd * 1e6) / 1e6;
    runCosts.set(runId, rounded);
    return { items: items as T[], runId, costUsd: rounded };
  };

  // A run of an earlier scanner (before a restart) is not known: no number, the stored cost stays.
  const readRunCost = async (runId: string): Promise<RunCostReading> => ({
    status: 'SUCCEEDED',
    finished: true,
    costUsd: runCosts.get(runId) ?? null,
  });

  return createInstagramScanner({
    instagram: options.instagram,
    dataDir: options.dataDir,
    clock: options.clock,
    runActor,
    readRunCost,
    // Every picture, from any link the scanner accepts, is the same small JPEG, unless the
    // account's fixture has a picture of its own.
    fetch: async (input) =>
      new Response(photoOfLink.get(String(input)) ?? photo, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  });
}
