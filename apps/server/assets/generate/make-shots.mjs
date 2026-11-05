#!/usr/bin/env node
// The shots script (Generated videos, GN3; plan: ~/.studio-engine/handoff/generate-design/plan.md
// sections 2.1 and 2.3, facts: higgsfield-api.md next to it). The only thing that calls Higgsfield:
// the Generate run calls `node make-shots.mjs <command> "<edit dir>" …` from Bash and reads back ONE
// JSON line, the same contract as make-music.mjs and packages/shared/src/domain/generate.ts.
// Plain Node, no dependencies; it runs from the engine's assets/ folder in src and dist alike.
//
//   estimate "<edit dir>" --kind clip --tier easy|people|tilt --seconds N [--aspect 9:16]
//   estimate "<edit dir>" --kind still --model soul|soul-i2i|qwen-edit|qwen|z-image [--ref F …]
//   estimate --slug <model slug> --body '<json>'      the price of an exact body (free)
//   upload   "<edit dir>" --file F                    the public URL of an image (free; cached)
//   still    "<edit dir>" <id> --into looks|keyframes --model <name> --prompt "…" --budget <usd>
//                              [--ref F …] [--aspect 9:16] [--take N]
//   clip     "<edit dir>" <id> --tier easy|people|tilt --start F [--end F] --seconds N
//                              --prompt "…" --budget <usd> [--take N] [--aspect 9:16] [--negative "…"]
//   reframe  …                                        answers bad_request: no Higgsfield model does it
//
// ON THE PLAN'S CREDITS (U26 to U29, 27 Oct). The Generate run now makes pictures and clips through the
// Higgsfield connector (the plan's credits), not this script's API calls, so these four commands keep
// the same files and the same ledger around what the connector makes. They need no API key:
//   book     "<edit dir>" <id> --kind look|keyframe|clip --model <id> --credits N --budget <usd>
//                              [--take N] [--seconds S] [--job <id>]
//                                                             books the price BEFORE the run submits;
//                                                             asked again with --job it keeps the id of
//                                                             the request the connector made, and every
//                                                             answer says state, requestId and file
//   save     "<edit dir>" <id> --kind look|keyframe|clip --url <https result> [--job <id>] [--take N]
//                                                             downloads what the connector made
//   void     "<edit dir>" <id> --kind look|keyframe|clip [--take N] --reason "…"
//                                                             a generation that failed: not charged
//   put      "<edit dir>" --file F --url <upload url>         PUTs an image to the URL media_upload gave
// A booking is dollars = credits x STUDIO_HIGGSFIELD_USD_PER_CREDIT (what a plan credit is worth), and
// `book` refuses (exit 2, over_budget) when the total would pass --budget, booking nothing.
//
// Files are relative to <edit dir>/generate/ (or absolute, or relative to the edit or job folder) and
// must be images inside the job folder. Results land in generate/keyframes|looks/<id>.png (or the type
// returned) and generate/clips/<id>/take-<n>.mp4. `still` and `clip` take --budget (required): they
// price the request with the free estimate first and refuse (exit 2, over_budget) when spend.json's
// total plus the price would pass it, creating nothing.
//
// The key: HIGGSFIELD_API_KEY from the environment, else from the .env named by STUDIO_ENV_FILE (the
// engine passes the PATH only), else the repo's. Never printed, logged, put in an argument or in an
// error text; a missing key is key_rejected.
//
// MONEY. Every request that can cost is written to generate/spend.json BEFORE it is sent (atomic
// write, under a lock, so parallel clips share one budget), at the estimate's price (a model priced
// per second, Wan 3.0, is booked at its list price times the seconds: the worst case). A request
// Higgsfield did not accept (401, 403, 400) or one that ends failed, nsfw or canceled is marked
// refunded and no longer counts; one that may have been accepted (no answer, 5xx) stays counted.
// The Idempotency-Key is derived from (job folder, kind, id, take, model, the request) so sending
// the same thing again never makes or charges a second one. To make a new try, use a new --take.
//
// RESUMABLE. A Wan 3.0 clip takes about 30 s per second of video and a tool call is limited to
// 10 minutes, so `clip` and `still` wait at most about 9 minutes (STUDIO_SHOTS_MAX_WAIT_MS). If the
// request is still running they print {"ok":false,"code":"pending","requestId":…} and exit 3: that is
// not a failure. Running the SAME command again re-attaches to the same request (no second one, no
// second charge), keeps waiting and downloads the file the moment it is ready, even when it finished
// while nobody was waiting. A take that is already on disk is answered at once ("reused": true).
//
// Output: one JSON line on stdout; exit 0 done, 1 failed (bad_request, generation_failed), 2 refused
// (key_rejected, balance_empty, over_budget), 3 the service is down or the request is pending.
// stderr gets a few progress lines (never a key).
//
// STUDIO_GENERATE_FAKE=1 runs make-shots-fake.mjs instead: GN0's stub (placeholder files, no network,
// no key) for the engine's and the Generate run's tests; it knows only the GN0 command forms.
//
// For tests: HIGGSFIELD_API_BASE (a loopback http server; ignored for any other URL),
// STUDIO_SHOTS_MAX_WAIT_MS, STUDIO_SHOTS_POLL_MS, STUDIO_SHOTS_RETRY_MS, STUDIO_SHOTS_HTTP_TIMEOUT_MS,
// STUDIO_FFPROBE; and runShots's `io` (fetch, sleep, now, log).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_BASE,
  ApiError,
  apiBase,
  createBackend,
  envFile,
  readKey,
  redact,
} from './backends/higgsfield-api.mjs';
import {
  clipBody,
  clipSeconds,
  imageModel,
  ModelError,
  priceOf,
  stillBody,
  TIER_NAMES,
  TIERS,
  tierForSlug,
} from './models.mjs';

export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };

/** The words of each error code for Higgsfield: generateErrorMessage(code) in the shared contract. */
export const MESSAGES = {
  balance_empty:
    'Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept).',
  key_rejected: 'Higgsfield key not accepted: check HIGGSFIELD_API_KEY in .env',
  over_budget: (need, budget) =>
    `This video needs about ${dollars(need)}, over the budget of ${dollars(budget, true)}: add a note like 'budget $5' and Retry.`,
  bad_request:
    'Higgsfield did not accept a request: the details are in the job’s log. Retry once; if it stops again, the engine needs a fix.',
  unavailable:
    'Higgsfield is not answering right now: wait a few minutes, then Retry (what was already made is kept).',
  generation_failed:
    'Higgsfield could not make a shot, even after retakes: Retry, or say in a note what to change.',
};

/** `pending` is not an error: the request is still being made and the same command picks it up. */
export const PENDING_MESSAGE =
  'Still being made at Higgsfield: run the same command again to pick it up (it will not be made or charged twice).';

export const EXIT_FOR = {
  balance_empty: EXIT.refused,
  key_rejected: EXIT.refused,
  over_budget: EXIT.refused,
  unavailable: EXIT.down,
  pending: EXIT.down,
  bad_request: EXIT.failed,
  generation_failed: EXIT.failed,
};

/**
 * What one Higgsfield plan credit is worth in dollars when the engine does not say (U29): the 1,000
 * credit pack ($55.56) on 27 Oct. The engine passes the real rate in STUDIO_HIGGSFIELD_USD_PER_CREDIT.
 * packages/shared keeps its own copy (this script has no imports); a test keeps the two equal.
 */
export const DEFAULT_USD_PER_CREDIT = 0.056;

export const LIMITS = {
  /** The longest a download or an upload of a file may take. */
  transferTimeoutMs: 120_000,
  /** `clip` and `still` wait this long for a request before they answer `pending` (a tool call lasts 10 minutes). */
  maxWaitMs: 540_000,
  /** The first wait between two looks at a request, and the longest. */
  pollMs: 3_000,
  pollMaxMs: 10_000,
  /** An uploaded image's public URL is trusted this long (Higgsfield calls the upload temporary). */
  uploadMaxAgeMs: 12 * 3_600_000,
  /** Failed looks at a running request, one after another, before the command gives up (`unavailable`). */
  pollFailures: 5,
  /** spend.json's lock: how long a command waits for it, and when a left-over one is taken over. */
  lockWaitMs: 15_000,
  lockStaleMs: 30_000,
};

/** The files the script owns, relative to <edit dir>/generate/. */
export const FILES = {
  dir: 'generate',
  spend: 'spend.json',
  uploads: 'uploads.json',
};

/** Where the estimate is asked about a start frame that is not made yet (any URL passes it). */
const PLACEHOLDER_URL = 'https://example.com/frame.png';

const cents = (usd) => Math.round(usd * 100) / 100;

/** "$4.10" for a price; "$3" for a whole-dollar budget. */
function dollars(usd, whole = false) {
  const rounded = cents(usd);
  return whole && Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** The dollars of the entries that still count (not refunded), to six decimals like the shared spendTotal. */
export function spendTotal(entries) {
  let total = 0;
  for (const entry of entries) if (!entry.refunded) total += entry.usd;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** A failure the script answers with: a code of the shared contract and the API's or our own words. */
export class ShotsError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ?? code);
    this.name = 'ShotsError';
    this.code = code;
    this.detail = detail === undefined ? undefined : redact(detail);
    this.extra = extra;
  }
}

/** The request is still being made: not a failure. */
export class Pending extends Error {
  constructor(requestId, extra = {}) {
    super(PENDING_MESSAGE);
    this.name = 'Pending';
    this.requestId = requestId;
    this.extra = extra;
  }
}

/** Flags may repeat (--ref a --ref b): every flag keeps all its values. */
export function parseArgs(argv) {
  const flags = new Map();
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const values = flags.get(arg.slice(2)) ?? [];
      values.push(argv[i + 1] ?? '');
      flags.set(arg.slice(2), values);
      i += 1;
    } else words.push(arg);
  }
  return {
    flag: (name) => flags.get(name)?.[0],
    all: (name) => flags.get(name) ?? [],
    words,
  };
}

/** A whole number from a flag, or the default. */
function wholeFlag(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ShotsError('bad_request', `${name} must be a whole number from 1 (got "${raw}").`);
  }
  return value;
}

function positiveMs(raw, fallback) {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The script's timings: the defaults, moved only by the STUDIO_SHOTS_* variables (tests). */
export function settingsOf(env) {
  const rate = Number(env.STUDIO_HIGGSFIELD_USD_PER_CREDIT);
  return {
    usdPerCredit: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_PER_CREDIT,
    maxWaitMs: positiveMs(env.STUDIO_SHOTS_MAX_WAIT_MS, LIMITS.maxWaitMs),
    pollMs: positiveMs(env.STUDIO_SHOTS_POLL_MS, LIMITS.pollMs),
    pollMaxMs: positiveMs(env.STUDIO_SHOTS_POLL_MS, LIMITS.pollMaxMs),
    retryMs: positiveMs(env.STUDIO_SHOTS_RETRY_MS, undefined),
    httpTimeoutMs: positiveMs(env.STUDIO_SHOTS_HTTP_TIMEOUT_MS, undefined),
  };
}

// --- files --------------------------------------------------------------------------------------

/** Writes a file so a reader never sees half of it. */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** JSON on disk, with any key taken out (the files hold strings an answer sent). */
const writeJsonAtomic = (path, value) =>
  writeAtomic(path, `${redact(JSON.stringify(value, null, 2))}\n`);

/** A JSON file, or `null` when there is none. A cache (`lenient`) that cannot be read counts as none. */
function readJson(path, { lenient = false } = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || lenient) return null;
    throw new ShotsError(
      'bad_request',
      `${path} cannot be read (${error.message}); fix or remove it.`,
    );
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` holding a lock file next to the file it protects; a lock left by a dead process is taken over. */
async function withLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LIMITS.lockStaleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LIMITS.lockWaitMs) {
        throw new ShotsError('unavailable', `${lockPath} stayed locked; try again in a moment.`);
      }
      await realSleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

// --- the money ledger (spend.json) --------------------------------------------------------------

function readSpend(path) {
  const spend = readJson(path);
  if (spend === null) return { entries: [], total: 0 };
  if (!Array.isArray(spend.entries)) {
    throw new ShotsError('bad_request', `${path} is not a spend ledger; fix or remove it.`);
  }
  return spend;
}

/** Changes spend.json under its lock: `mutate(spend)` may change `spend.entries` or throw (nothing is written). */
async function updateSpend(ctx, mutate) {
  return withLock(`${ctx.spendPath}.lock`, () => {
    const spend = readSpend(ctx.spendPath);
    const result = mutate(spend);
    spend.total = spendTotal(spend.entries);
    writeJsonAtomic(ctx.spendPath, spend);
    return result;
  });
}

/** The newest entry of a request (rejected ones never reached Higgsfield, so they are not the request). */
const entryFor = (spend, key) =>
  [...spend.entries].reverse().find((entry) => entry.key === key && entry.state !== 'rejected');

/** Changes an entry; a value of `undefined` removes the field. */
async function patchEntry(ctx, key, patch) {
  return updateSpend(ctx, (spend) => {
    const entry = entryFor(spend, key);
    if (!entry) throw new ShotsError('bad_request', 'The request is not in spend.json any more.');
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) delete entry[name];
      else entry[name] = value;
    }
    return { ...entry };
  });
}

/** JSON with the keys in order, so the same request always gives the same text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The Idempotency-Key of a request: the same job folder, kind, id, take, model and request always
 * give the same key, so a retry after a timeout (or a rerun of the whole command) is a receipt for
 * the first request and never a second charge. `logical` is the request with each image named by the
 * hash of its bytes, not by its upload URL, so uploading the file again does not change it.
 */
export function idempotencyKey({ jobFolder, kind, id, take, slug, logical }) {
  const text = JSON.stringify([jobFolder, kind, id, take, slug, canonical(logical)]);
  return `studio-${createHash('sha256').update(text).digest('hex').slice(0, 48)}`;
}

// --- images -------------------------------------------------------------------------------------

/** The type of an image from its first bytes, or `null`: only these are uploaded and only these are kept. */
export function imageType(bytes) {
  if (bytes.length > 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  if (bytes.length > 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  return null;
}

/** Whether bytes are an MP4/MOV file: "ftyp" at byte 4. */
const isMp4 = (bytes) => bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';

/** An input file of the job, as a real path inside the job folder; anything else is refused. */
function resolveInput(ctx, name) {
  if (!name) throw new ShotsError('bad_request', 'A file name is missing.');
  const candidates = isAbsolute(name)
    ? [name]
    : [join(ctx.genDir, name), join(ctx.editDir, name), join(ctx.jobFolder, name)];
  for (const candidate of candidates) {
    let real;
    try {
      if (!statSync(candidate).isFile()) continue;
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (real !== ctx.jobFolder && !real.startsWith(`${ctx.jobFolder}${sep}`)) {
      throw new ShotsError(
        'bad_request',
        `${name} is outside the job folder: only its files can be sent.`,
      );
    }
    return real;
  }
  throw new ShotsError(
    'bad_request',
    `File not found: ${name} (looked in generate/, edit/ and the job folder).`,
  );
}

/**
 * The public URL of an image file, uploaded once: the answer is cached by the hash of the bytes in
 * generate/uploads.json ({ files: { <sha256>: { url, contentType, bytes, at } } }) and trusted for 12 hours.
 */
async function ensureUploaded(ctx, name) {
  const path = resolveInput(ctx, name);
  const bytes = readFileSync(path);
  const type = imageType(bytes);
  if (!type) {
    throw new ShotsError(
      'bad_request',
      `${name} is not an image Higgsfield takes (png, jpg, webp or gif).`,
    );
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const cached = readJson(ctx.uploadsPath, { lenient: true })?.files?.[sha];
  if (cached && ctx.now() - Date.parse(cached.at) < LIMITS.uploadMaxAgeMs) {
    return { url: cached.url, sha, cached: true, contentType: cached.contentType };
  }
  const backend = ctx.backend();
  const slot = await backend.uploadUrl(type.contentType);
  await backend.putFile(
    slot.upload_url,
    slot.upload_headers ?? { 'Content-Type': type.contentType },
    bytes,
  );
  await withLock(`${ctx.uploadsPath}.lock`, () => {
    const uploads = readJson(ctx.uploadsPath, { lenient: true }) ?? { files: {} };
    uploads.files = {
      ...uploads.files,
      [sha]: {
        url: slot.public_url,
        contentType: type.contentType,
        bytes: bytes.length,
        at: new Date(ctx.now()).toISOString(),
      },
    };
    writeJsonAtomic(ctx.uploadsPath, uploads);
  });
  return { url: slot.public_url, sha, cached: false, contentType: type.contentType };
}

// --- a finished video ---------------------------------------------------------------------------

/** Where ffprobe is: STUDIO_FFPROBE, the PATH, then Homebrew's (launchd has no Homebrew PATH). */
export function findFfprobe(env) {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const candidates = [env.STUDIO_FFPROBE, ...dirs.map((dir) => dir && join(dir, 'ffprobe'))];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** Where ffmpeg is: STUDIO_FFMPEG, the PATH, then Homebrew's (launchd has no Homebrew PATH). */
export function findFfmpeg(env) {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const candidates = [env.STUDIO_FFMPEG, ...dirs.map((dir) => dir && join(dir, 'ffmpeg'))];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** Whether a video file has an audio stream; `null` when ffprobe is not there or cannot tell. */
function hasAudio(file, env) {
  const ffprobe = findFfprobe(env);
  if (!ffprobe) return null;
  const ran = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return ran.status === 0 ? ran.stdout.trim() !== '' : null;
}

/**
 * Takes the audio track out of a clip, copying the picture as it is. Kling 4.0 puts a generated
 * soundtrack in every clip even when the prompt says no speech or music, and the edit needs silent
 * footage (the voice is ElevenLabs'). Answers `none` (it had no audio), `dropped`, or `kept` when it
 * could not be taken out (no ffmpeg, or ffmpeg failed): the file is never left half written.
 */
function dropAudio(file, env) {
  const audio = hasAudio(file, env);
  if (audio === false) return 'none';
  const ffmpeg = findFfmpeg(env);
  if (!ffmpeg) return 'kept';
  const tmp = `${file}.silent.mp4`;
  const ran = spawnSync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-c:v', 'copy', tmp],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (ran.status !== 0 || !existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing was written.
    }
    return 'kept';
  }
  renameSync(tmp, file);
  return 'dropped';
}

/** A clip's real length, frame rate and size (they differ per model: Kling 24 fps, Wan 30); nulls without ffprobe. */
export function probeVideo(file, env) {
  const none = { fps: null, durationSec: null, width: null, height: null };
  const ffprobe = findFfprobe(env);
  if (!ffprobe) return none;
  const ran = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=r_frame_rate,width,height:format=duration',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (ran.status !== 0) return none;
  try {
    const out = JSON.parse(ran.stdout);
    const stream = out.streams?.[0] ?? {};
    const [num, den] = String(stream.r_frame_rate ?? '')
      .split('/')
      .map(Number);
    const fps = den > 0 && Number.isFinite(num) ? Math.round((num / den) * 1000) / 1000 : null;
    const duration = Number(out.format?.duration);
    return {
      fps,
      durationSec: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
      width: Number.isInteger(stream.width) ? stream.width : null,
      height: Number.isInteger(stream.height) ? stream.height : null,
    };
  } catch {
    return none;
  }
}

// --- one request, from the price to the file ------------------------------------------------------

const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

/** The price of a request: the free estimate, read as ModelError-free `bad_request`s. */
async function priceRequest(ctx, slug, body) {
  const answer = await ctx.backend().estimate(slug, body);
  try {
    return priceOf(answer, body);
  } catch (error) {
    if (error instanceof ModelError) throw new ShotsError('bad_request', error.message);
    throw error;
  }
}

/** Waits for a request to reach a final status; `Pending` when the command's time is up first. */
async function waitForRequest(ctx, requestId, extra) {
  const backend = ctx.backend();
  const { pollMs, pollMaxMs } = ctx.settings;
  let delay = pollMs;
  let last = '';
  let failures = 0;
  for (;;) {
    let answer = null;
    try {
      answer = await backend.status(requestId);
      failures = 0;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'unavailable') throw error;
      failures += 1;
      // Each failed look has already been tried again with backoff: this many in a row is a service that is down.
      if (failures >= LIMITS.pollFailures) {
        throw new ShotsError(
          'unavailable',
          'Higgsfield stopped answering while a request was running.',
          {
            requestId,
          },
        );
      }
    }
    if (answer) {
      if (TERMINAL.has(answer.status)) return answer;
      if (answer.status !== last) {
        last = answer.status;
        ctx.log(`${extra.label}: ${answer.status}`);
      }
    }
    if (ctx.now() + delay > ctx.deadline) {
      if (failures >= 3) {
        throw new ShotsError(
          'unavailable',
          'Higgsfield stopped answering while a request was running.',
          {
            requestId,
          },
        );
      }
      throw new Pending(requestId, extra.pending);
    }
    await ctx.sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), pollMaxMs);
  }
}

/**
 * Makes one thing (a still or a clip) from its priced request, or picks up where an earlier call of the
 * same command stopped. Returns `{ entry, file (relative to generate/), reused }`.
 *
 * job: { kind: 'look'|'keyframe'|'clip', id, take, slug, body, logical, budget, media: 'image'|'video',
 *        outDir, base, seconds? }
 */
async function generate(ctx, job) {
  const { kind, id, take, slug, media } = job;
  const label = `${kind} ${id}${take > 1 || kind === 'clip' ? ` take ${take}` : ''}`;
  const key = idempotencyKey({
    jobFolder: ctx.jobFolder,
    kind,
    id,
    take,
    slug,
    logical: job.logical,
  });

  let entry = entryFor(readSpend(ctx.spendPath), key);
  if (entry?.state === 'failed') {
    throw new ShotsError(
      'generation_failed',
      entry.error ?? `the request ended ${entry.status ?? 'failed'}`,
      {
        requestId: entry.requestId ?? null,
        status: entry.status ?? 'failed',
      },
    );
  }
  if (entry?.state === 'completed' && entry.file && existsSync(join(ctx.genDir, entry.file))) {
    return { entry, file: entry.file, reused: true };
  }

  if (!entry) {
    const spend = readSpend(ctx.spendPath);
    const clash = spend.entries.find(
      (other) =>
        other.kind === kind &&
        other.id === id &&
        other.take === take &&
        other.state !== 'rejected' &&
        other.state !== 'failed',
    );
    if (clash) {
      throw new ShotsError(
        'bad_request',
        `${label} was already ${clash.state === 'completed' ? 'made' : 'started'} with other settings (model, prompt or pictures): use --take ${take + 1} for a different one.`,
      );
    }
    const price = await priceRequest(ctx, slug, job.body);
    entry = await updateSpend(ctx, (current) => {
      const raced = entryFor(current, key);
      if (raced) return raced;
      const total = spendTotal(current.entries);
      const need = total + price.usd;
      if (cents(need) > cents(job.budget)) {
        throw new ShotsError('over_budget', undefined, {
          needUsd: cents(need),
          budgetUsd: job.budget,
        });
      }
      const booked = {
        at: new Date(ctx.now()).toISOString(),
        kind,
        slug,
        usd: price.usd,
        requestId: null,
        refunded: false,
        // Not in the shared schema (it ignores them): what lets a rerun pick the request up again.
        id,
        take,
        key,
        state: 'booked',
        basis: price.basis,
        ...(job.seconds === undefined ? {} : { seconds: job.seconds }),
        body: job.body,
      };
      current.entries.push(booked);
      return booked;
    });
  }

  if (entry.state === 'booked') {
    ctx.log(`${label}: sending (about ${dollars(entry.usd)})`);
    let sent;
    try {
      sent = await ctx.backend().submit(slug, entry.body, key);
    } catch (error) {
      // Higgsfield did not take it (key, balance, a bad request): nothing was made or charged.
      if (
        error instanceof ApiError &&
        ['key_rejected', 'balance_empty', 'bad_request'].includes(error.code)
      ) {
        await patchEntry(ctx, key, { state: 'rejected', refunded: true, error: error.detail });
      }
      throw error;
    }
    entry = await patchEntry(ctx, key, {
      state: 'submitted',
      requestId: sent.request_id,
      statusUrl: typeof sent.status_url === 'string' ? sent.status_url : undefined,
      body: undefined,
    });
  }

  const final = await waitForRequest(ctx, entry.requestId, {
    label,
    pending: { id, take, kind },
  });

  if (final.status !== 'completed') {
    const why = typeof final.error === 'string' && final.error !== '' ? final.error : final.status;
    // Failed, nsfw and canceled requests are not charged.
    await patchEntry(ctx, key, {
      state: 'failed',
      refunded: true,
      status: final.status,
      error: why,
    });
    throw new ShotsError('generation_failed', `The request ended ${final.status}: ${why}`, {
      requestId: entry.requestId,
      status: final.status,
    });
  }

  const url =
    media === 'video'
      ? (final.video?.url ?? final.videos?.[0]?.url)
      : (final.images?.[0]?.url ?? final.image?.url);
  if (typeof url !== 'string' || url === '') {
    throw new ShotsError('generation_failed', 'The request completed without a file.', {
      requestId: entry.requestId,
      status: 'completed',
    });
  }
  const bytes = await ctx.backend().download(url);
  let ext = 'mp4';
  if (media === 'video') {
    if (!isMp4(bytes)) {
      throw new ShotsError(
        'unavailable',
        'The downloaded clip is not a video file; run the same command again.',
      );
    }
  } else {
    const type = imageType(bytes);
    if (!type) {
      throw new ShotsError(
        'unavailable',
        'The downloaded picture is not an image; run the same command again.',
      );
    }
    ext = type.ext;
  }
  const rel = `${job.outDir}/${job.base}.${ext}`;
  const target = join(ctx.genDir, rel);
  writeAtomic(target, bytes);
  const probe = media === 'video' ? probeVideo(target, ctx.env) : {};
  entry = await patchEntry(ctx, key, { state: 'completed', file: rel, ...probe });
  ctx.log(`${label}: done (${rel})`);
  return { entry, file: rel, reused: false };
}

// --- the commands -------------------------------------------------------------------------------

/** Where the money stands, for the answers of the commands that spend. */
function moneyOf(ctx, budget) {
  return { spentUsd: spendTotal(readSpend(ctx.spendPath).entries), budgetUsd: budget };
}

function requireBudget(raw, command) {
  const budget = Number(raw);
  if (raw === undefined || !Number.isFinite(budget) || budget <= 0) {
    throw new ShotsError(
      'bad_request',
      `${command} needs --budget <usd> (the dollars this video may spend in all).`,
    );
  }
  return budget;
}

function requireText(value, what) {
  if (value === undefined || value.trim() === '') {
    throw new ShotsError('bad_request', `${what} is missing.`);
  }
  return value;
}

/** Answers a ModelError (a request that cannot be made) as bad_request. */
function modelProblem(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ModelError) throw new ShotsError('bad_request', error.message);
    throw error;
  }
}

async function cmdEstimate({ flag, all }, ctx) {
  const slugFlag = flag('slug') ?? flag('model');
  if (flag('body') !== undefined) {
    const slug = slugFlag;
    if (!slug) throw new ShotsError('bad_request', 'estimate --body needs --slug <model slug>.');
    let body;
    try {
      body = JSON.parse(flag('body'));
    } catch {
      throw new ShotsError('bad_request', 'estimate --body is not JSON.');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ShotsError('bad_request', 'estimate --body must be a JSON object.');
    }
    const price = await priceRequest(ctx, slug, body);
    return { ok: true, command: 'estimate', slug, usd: price.usd, basis: price.basis };
  }

  const hasEnd = flag('end') !== undefined;
  let kind = flag('kind');
  let tier = flag('tier');
  if (!tier && slugFlag) tier = tierForSlug(slugFlag, hasEnd) ?? undefined;
  if (!kind && tier) kind = 'clip';
  if (!kind && (slugFlag || all('ref').length > 0)) kind = 'still';
  if (kind === 'reframe') reframeRefused();

  if (kind === 'clip') {
    if (!tier) {
      throw new ShotsError(
        'bad_request',
        `estimate --kind clip needs --tier ${TIER_NAMES.join('|')}.`,
      );
    }
    const { seconds, rounded } = modelProblem(() => clipSeconds(tier, Number(flag('seconds'))));
    const body = modelProblem(() =>
      clipBody(tier, {
        prompt: 'estimate',
        startUrl: PLACEHOLDER_URL,
        endUrl: tier === 'tilt' || hasEnd ? PLACEHOLDER_URL : undefined,
        seconds,
        aspect: flag('aspect'),
      }),
    );
    const slug = TIERS[tier].slug;
    const price = await priceRequest(ctx, slug, body);
    return {
      ok: true,
      command: 'estimate',
      kind: 'clip',
      tier,
      slug,
      seconds,
      requestedSeconds: Number(flag('seconds')),
      rounded,
      usd: price.usd,
      basis: price.basis,
    };
  }
  if (kind === 'still') {
    const refs = all('ref');
    const model = modelProblem(() => imageModel(slugFlag, refs.length));
    const body = modelProblem(() =>
      stillBody(model, {
        prompt: 'estimate',
        aspect: flag('aspect'),
        urls: refs.map(() => PLACEHOLDER_URL),
      }),
    );
    const price = await priceRequest(ctx, model.slug, body);
    return {
      ok: true,
      command: 'estimate',
      kind: 'still',
      slug: model.slug,
      usd: price.usd,
      basis: price.basis,
    };
  }
  throw new ShotsError(
    'bad_request',
    "estimate needs --kind clip|still (or --slug S --body '{…}').",
  );
}

function reframeRefused() {
  throw new ShotsError(
    'bad_request',
    'reframe is not available: Higgsfield has no model that reframes a video to another shape. Crop the 9:16 clip to the centre square with ffmpeg on the Mac (free), or make the clip again at 1:1 with clip --aspect 1:1 (tier people or tilt).',
  );
}

async function cmdUpload({ flag }, ctx) {
  const file = requireText(flag('file'), 'upload --file');
  const up = await ensureUploaded(ctx, file);
  return {
    ok: true,
    command: 'upload',
    file,
    url: up.url,
    cached: up.cached,
    contentType: up.contentType,
  };
}

async function cmdStill({ flag, all, words }, ctx) {
  const id = words[2] ?? flag('id');
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new ShotsError(
      'bad_request',
      'still needs an id of letters, digits and dashes, such as K1 or homeowner.',
    );
  }
  const into = flag('into') ?? 'keyframes';
  if (into !== 'looks' && into !== 'keyframes') {
    throw new ShotsError('bad_request', 'still needs --into looks or --into keyframes.');
  }
  const prompt = requireText(flag('prompt'), 'still --prompt');
  const refs = all('ref');
  const model = modelProblem(() => imageModel(flag('model') ?? flag('slug'), refs.length));
  const take = wholeFlag(flag('take'), 1, '--take');
  const budget = requireBudget(flag('budget'), 'still');
  const aspect = flag('aspect');
  // Refused before anything is uploaded.
  modelProblem(() => stillBody(model, { prompt, aspect, urls: refs.map(() => PLACEHOLDER_URL) }));

  const uploads = [];
  for (const ref of refs) uploads.push(await ensureUploaded(ctx, ref));
  const body = stillBody(model, { prompt, aspect, urls: uploads.map((up) => up.url) });
  const logical = stillBody(model, {
    prompt,
    aspect,
    urls: uploads.map((up) => `sha256:${up.sha}`),
  });

  const kind = into === 'looks' ? 'look' : 'keyframe';
  const made = await generate(ctx, {
    kind,
    id,
    take,
    slug: model.slug,
    body,
    logical,
    budget,
    media: 'image',
    outDir: into,
    base: take === 1 ? id : `${id}-take${take}`,
  });
  return {
    ok: true,
    command: 'still',
    id,
    take,
    file: made.file,
    usd: made.entry.usd,
    requestId: made.entry.requestId,
    model: model.slug,
    reused: made.reused,
    ...moneyOf(ctx, budget),
  };
}

async function cmdClip({ flag, all, words }, ctx) {
  const id = words[2] ?? flag('id');
  if (!id || !/^[A-Za-z0-9]{1,8}$/.test(id)) {
    throw new ShotsError('bad_request', 'clip needs an id of letters and digits, such as A or B2.');
  }
  const take = wholeFlag(flag('take'), 1, '--take');
  const hasEnd = flag('end') !== undefined && flag('end') !== '';
  const slugFlag = flag('model') ?? flag('slug');
  const tier = flag('tier') ?? (slugFlag ? tierForSlug(slugFlag, hasEnd) : null);
  if (!tier || !Object.hasOwn(TIERS, tier)) {
    throw new ShotsError('bad_request', `clip needs --tier ${TIER_NAMES.join('|')}.`);
  }
  if (slugFlag && slugFlag !== TIERS[tier].slug) {
    throw new ShotsError(
      'bad_request',
      `--model ${slugFlag} is not the model of tier ${tier} (${TIERS[tier].slug}).`,
    );
  }
  if (all('ref').length > 0) {
    throw new ShotsError(
      'bad_request',
      'clip takes no --ref: the video models used take a start frame (and an end frame). Put the references into the keyframe with still.',
    );
  }
  const prompt = requireText(flag('prompt'), 'clip --prompt');
  const start = requireText(flag('start'), 'clip --start <the start frame>');
  const asked = Number(flag('seconds'));
  const { seconds, rounded } = modelProblem(() => clipSeconds(tier, asked));
  const budget = requireBudget(flag('budget'), 'clip');
  const options = { prompt, seconds, aspect: flag('aspect'), negative: flag('negative') };
  // Refused before anything is uploaded.
  modelProblem(() =>
    clipBody(tier, {
      ...options,
      startUrl: PLACEHOLDER_URL,
      endUrl: hasEnd ? PLACEHOLDER_URL : undefined,
    }),
  );

  const first = await ensureUploaded(ctx, start);
  const last = hasEnd ? await ensureUploaded(ctx, flag('end')) : null;
  const body = clipBody(tier, { ...options, startUrl: first.url, endUrl: last?.url });
  const logical = clipBody(tier, {
    ...options,
    startUrl: `sha256:${first.sha}`,
    endUrl: last ? `sha256:${last.sha}` : undefined,
  });

  const made = await generate(ctx, {
    kind: 'clip',
    id,
    take,
    slug: TIERS[tier].slug,
    body,
    logical,
    budget,
    media: 'video',
    outDir: `clips/${id}`,
    base: `take-${take}`,
    seconds,
  });
  const entry = made.entry;
  return {
    ok: true,
    command: 'clip',
    id,
    take,
    file: made.file,
    // The length it was made at; Kling 2.5 Turbo only makes 5 s or 10 s, so a shorter ask is rounded UP.
    seconds,
    requestedSeconds: asked,
    rounded,
    tier,
    model: TIERS[tier].slug,
    usd: entry.usd,
    basis: entry.basis ?? null,
    requestId: entry.requestId,
    // Not every model makes the same: Kling 24 fps, Wan 30 fps. The edit conforms them.
    fps: entry.fps ?? null,
    durationSec: entry.durationSec ?? null,
    width: entry.width ?? null,
    height: entry.height ?? null,
    reused: made.reused,
    ...moneyOf(ctx, budget),
  };
}

// --- the plan's credits: book, save, void, put (U27) ----------------------------------------------

const STILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLIP_ID = /^[A-Za-z0-9]{1,8}$/;

/** What each kind of request makes, and where it lands inside generate/. */
const KINDS = {
  look: { into: 'looks', media: 'image', id: STILL_ID },
  keyframe: { into: 'keyframes', media: 'image', id: STILL_ID },
  clip: { into: null, media: 'video', id: CLIP_ID },
};

/** The kind, id and take a plan-credit command is about. */
function targetOf({ flag, words }, command) {
  const kind = flag('kind');
  if (!kind || !Object.hasOwn(KINDS, kind)) {
    throw new ShotsError('bad_request', `${command} needs --kind ${Object.keys(KINDS).join('|')}.`);
  }
  const id = words[2] ?? flag('id');
  if (!id || !KINDS[kind].id.test(id)) {
    throw new ShotsError(
      'bad_request',
      kind === 'clip'
        ? `${command} needs a clip id of letters and digits, such as A or B2.`
        : `${command} needs an id of letters, digits and dashes, such as K1 or homeowner.`,
    );
  }
  return { kind, id, take: wholeFlag(flag('take'), 1, '--take') };
}

/** One ledger key per kind, id and take. */
const bookingKey = ({ kind, id, take }) => `${kind}:${id}:${take}`;

/** The booking of a take: its newest entry, unless that one was voided (a voided take may be booked again). */
function bookingOf(spend, target) {
  const entry = entryFor(spend, bookingKey(target));
  return entry && entry.state !== 'failed' ? entry : undefined;
}

/** A take's file inside generate/: looks/K1.png, keyframes/K1-take2.png, clips/A/take-2.mp4. */
function targetFile({ kind, id, take }, ext) {
  if (kind === 'clip') return `clips/${id}/take-${take}.${ext}`;
  return `${KINDS[kind].into}/${take === 1 ? id : `${id}-take${take}`}.${ext}`;
}

/**
 * An address the plan-credit commands may fetch from or send to: https on Higgsfield's own hosts, its
 * result CDN and the storage its upload addresses point at, or (tests) the loopback server named by
 * HIGGSFIELD_API_BASE. The run chooses the address, so anything else is refused.
 */
function checkedUrl(raw, env, what) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ShotsError('bad_request', `${what}: "${raw}" is not an address.`);
  }
  const host = url.hostname.toLowerCase();
  const base = apiBase(env);
  const loopback = base !== API_BASE && url.origin === base;
  const known = ['higgsfield.ai', 'cloudfront.net', 'amazonaws.com'].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!loopback && !(url.protocol === 'https:' && known)) {
    throw new ShotsError(
      'bad_request',
      `${what}: only an https address of Higgsfield's files can be used (got ${url.protocol}//${host}).`,
    );
  }
  return url;
}

/** One transfer with the retry rules of the backend's: a 5xx or no answer is tried again, twice, with backoff. */
async function transfer(ctx, label, url, init) {
  const fetchImpl = ctx.fetch ?? fetch;
  const wait = ctx.settings.retryMs ?? 1_500;
  for (let attempt = 1; ; attempt += 1) {
    let status = 0;
    let res;
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(LIMITS.transferTimeoutMs),
      });
      status = res.status;
    } catch {
      if (attempt >= 3) throw new ShotsError('unavailable', `${label}: no answer`);
    }
    if (res && status >= 200 && status < 300) return res;
    if (res && status < 500) {
      throw new ShotsError(
        'bad_request',
        `${label}: HTTP ${status}${status === 403 || status === 404 ? ' (Higgsfield keeps a finished file for 7 days, and an upload address for a short time)' : ''}`,
      );
    }
    if (attempt >= 3) throw new ShotsError('unavailable', `${label}: HTTP ${status}`);
    await ctx.sleep(wait * 2 ** (attempt - 1));
  }
}

/** The dollars of a number of plan credits, to six decimals. */
const usdOfCredits = (credits, rate) => Math.round(credits * rate * 1_000_000) / 1_000_000;

async function cmdBook(args, ctx) {
  const { flag } = args;
  const target = targetOf(args, 'book');
  const model = requireText(flag('model') ?? flag('slug'), 'book --model');
  const credits = Number(flag('credits'));
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new ShotsError(
      'bad_request',
      'book needs --credits N: what the connector said the request costs (generate_video with get_cost).',
    );
  }
  const budget = requireBudget(flag('budget'), 'book');
  const seconds = flag('seconds') === undefined ? undefined : Number(flag('seconds'));
  if (seconds !== undefined && !(seconds > 0)) {
    throw new ShotsError('bad_request', 'book --seconds must be above 0.');
  }
  const usd = usdOfCredits(credits, ctx.settings.usdPerCredit);
  const job = flag('job') === undefined || flag('job') === '' ? null : flag('job');
  const booked = await updateSpend(ctx, (spend) => {
    const same = bookingOf(spend, target);
    if (same) {
      // The id of the request the connector made, kept so a rerun waits for that request and saves
      // it instead of making (and paying for) the take again.
      if (job !== null && !same.requestId) same.requestId = job;
      return { entry: same, reused: true };
    }
    const need = spendTotal(spend.entries) + usd;
    if (cents(need) > cents(budget)) {
      throw new ShotsError('over_budget', undefined, { needUsd: cents(need), budgetUsd: budget });
    }
    const entry = {
      at: new Date(ctx.now()).toISOString(),
      kind: target.kind,
      slug: model,
      usd,
      credits,
      requestId: null,
      refunded: false,
      // Not in the shared schema (it ignores them): what lets `save` and `void` find the booking.
      id: target.id,
      take: target.take,
      key: bookingKey(target),
      state: 'booked',
      basis: 'credits',
      ...(seconds === undefined ? {} : { seconds }),
    };
    spend.entries.push(entry);
    return { entry, reused: false };
  });
  const money = moneyOf(ctx, budget);
  return {
    ok: true,
    command: 'book',
    ...target,
    model: booked.entry.slug,
    credits: booked.entry.credits ?? credits,
    usd: booked.entry.usd,
    reused: booked.reused,
    ...money,
    leftUsd: cents(Math.max(0, budget - money.spentUsd)),
    // Where the take stands: a rerun that finds a requestId and no file waits for that request.
    state: booked.entry.state,
    requestId: booked.entry.requestId ?? null,
    file: booked.entry.file ?? null,
  };
}

/** The answer line of a saved take. */
function savedLine(ctx, target, entry, reused) {
  return {
    ok: true,
    command: 'save',
    ...target,
    file: entry.file,
    model: entry.slug,
    credits: entry.credits ?? null,
    usd: entry.usd,
    seconds: entry.seconds ?? null,
    requestId: entry.requestId ?? null,
    fps: entry.fps ?? null,
    durationSec: entry.durationSec ?? null,
    width: entry.width ?? null,
    height: entry.height ?? null,
    // A clip is saved silent: dropped (it had a soundtrack), none (it had none) or kept (could not be taken out).
    audio: entry.audio ?? null,
    reused,
    spentUsd: spendTotal(readSpend(ctx.spendPath).entries),
  };
}

async function cmdSave(args, ctx) {
  const { flag } = args;
  const target = targetOf(args, 'save');
  const url = checkedUrl(requireText(flag('url'), 'save --url'), ctx.env, 'save --url');
  const entry = bookingOf(readSpend(ctx.spendPath), target);
  if (!entry) {
    throw new ShotsError(
      'bad_request',
      `Nothing is booked for ${target.kind} ${target.id} take ${target.take}: run book first, before the request is sent.`,
    );
  }
  if (entry.state === 'completed' && entry.file && existsSync(join(ctx.genDir, entry.file))) {
    return savedLine(ctx, target, entry, true);
  }
  const res = await transfer(ctx, 'download', url, { method: 'GET' });
  const bytes = Buffer.from(await res.arrayBuffer());
  let ext = 'mp4';
  if (KINDS[target.kind].media === 'video') {
    if (!isMp4(bytes)) {
      throw new ShotsError(
        'unavailable',
        'The downloaded clip is not a video file; run the same command again.',
      );
    }
  } else {
    const type = imageType(bytes);
    if (!type) {
      throw new ShotsError(
        'unavailable',
        'The downloaded picture is not an image; run the same command again.',
      );
    }
    ext = type.ext;
  }
  const rel = targetFile(target, ext);
  const path = join(ctx.genDir, rel);
  writeAtomic(path, bytes);
  const isVideo = KINDS[target.kind].media === 'video';
  const audio = isVideo ? dropAudio(path, ctx.env) : undefined;
  const probe = isVideo ? probeVideo(path, ctx.env) : {};
  const job = flag('job');
  const done = await patchEntry(ctx, bookingKey(target), {
    state: 'completed',
    file: rel,
    ...(audio === undefined ? {} : { audio }),
    ...(job === undefined || job === '' ? {} : { requestId: job }),
    ...probe,
  });
  ctx.log(`${target.kind} ${target.id} take ${target.take}: saved (${rel})`);
  return savedLine(ctx, target, done, false);
}

async function cmdVoid(args, ctx) {
  const { flag } = args;
  const target = targetOf(args, 'void');
  const reason = requireText(flag('reason'), 'void --reason');
  const entry = await updateSpend(ctx, (spend) => {
    const booking = bookingOf(spend, target);
    if (!booking) {
      throw new ShotsError(
        'bad_request',
        `Nothing is booked for ${target.kind} ${target.id} take ${target.take}.`,
      );
    }
    if (booking.state === 'completed') {
      throw new ShotsError(
        'bad_request',
        `${target.kind} ${target.id} take ${target.take} is already saved: a saved take is kept and charged.`,
      );
    }
    // A request that failed, was blocked or cancelled is not charged.
    booking.state = 'failed';
    booking.refunded = true;
    booking.error = String(reason).slice(0, 300);
    return { ...booking };
  });
  return {
    ok: true,
    command: 'void',
    ...target,
    usd: entry.usd,
    refunded: true,
    spentUsd: spendTotal(readSpend(ctx.spendPath).entries),
  };
}

async function cmdPut({ flag, all }, ctx) {
  const file = requireText(flag('file'), 'put --file');
  const url = checkedUrl(requireText(flag('url'), 'put --url'), ctx.env, 'put --url');
  const path = resolveInput(ctx, file);
  const bytes = readFileSync(path);
  const type = imageType(bytes);
  if (!type) {
    throw new ShotsError(
      'bad_request',
      `${file} is not an image Higgsfield takes (png, jpg, webp or gif).`,
    );
  }
  // The headers media_upload asked for (the storage signs them), else just the type.
  const headers = { 'Content-Type': type.contentType };
  for (const line of all('header')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  await transfer(ctx, 'upload', url, { method: 'PUT', headers, body: bytes });
  return { ok: true, command: 'put', file, bytes: bytes.length, contentType: type.contentType };
}

const COMMANDS = {
  estimate: cmdEstimate,
  upload: cmdUpload,
  still: cmdStill,
  clip: cmdClip,
  book: cmdBook,
  save: cmdSave,
  void: cmdVoid,
  put: cmdPut,
};

// --- running it ---------------------------------------------------------------------------------

/** The failure line of an error. */
function failureLine(error) {
  if (error instanceof Pending) {
    return {
      line: {
        ok: false,
        code: 'pending',
        message: PENDING_MESSAGE,
        requestId: error.requestId,
        ...error.extra,
      },
      exit: EXIT_FOR.pending,
    };
  }
  const known = error instanceof ShotsError || error instanceof ApiError;
  const code = known && error.code in MESSAGES ? error.code : 'bad_request';
  const extra = error instanceof ShotsError ? error.extra : {};
  const message =
    code === 'over_budget'
      ? MESSAGES.over_budget(extra.needUsd ?? 0, extra.budgetUsd ?? 0)
      : MESSAGES[code];
  const detail = known ? error.detail : redact(String(error?.message ?? error)).slice(0, 400);
  return {
    line: { ok: false, code, message, ...(detail ? { detail } : {}), ...extra },
    exit: EXIT_FOR[code],
  };
}

/**
 * Runs one command. Returns `{ line, exit }`: the JSON line to print (with any key taken out) and the
 * exit code. `io` is for tests: `fetch`, `sleep`, `now`, `log`.
 */
export async function runShots(argv, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? ((text) => process.stderr.write(`${redact(`[make-shots] ${text}`)}\n`));
  try {
    const args = parseArgs(argv);
    const [command] = args.words;
    const run = COMMANDS[command];
    if (command === 'reframe') reframeRefused();
    if (!run) {
      throw new ShotsError(
        'bad_request',
        'Usage: make-shots.mjs book|save|void|put "<edit dir>" … (see the top of the script).',
      );
    }
    const settings = settingsOf(env);
    const now = io.now ?? Date.now;
    const sleep = io.sleep ?? realSleep;

    let editDir = args.words[1];
    let jobFolder = null;
    let genDir = null;
    if (command === 'estimate' && (editDir === undefined || editDir === '')) editDir = undefined;
    if (editDir !== undefined) {
      if (!isAbsolute(editDir) || !existsSync(editDir) || !statSync(editDir).isDirectory()) {
        throw new ShotsError(
          'bad_request',
          `"${editDir}" is not an existing absolute edit folder.`,
        );
      }
      editDir = realpathSync(editDir);
      jobFolder = dirname(editDir);
      genDir = join(editDir, FILES.dir);
    } else if (command !== 'estimate') {
      throw new ShotsError(
        'bad_request',
        `${command} needs the absolute edit folder as its first argument.`,
      );
    }

    const ctx = {
      env,
      settings,
      editDir,
      jobFolder,
      genDir,
      spendPath: genDir && join(genDir, FILES.spend),
      uploadsPath: genDir && join(genDir, FILES.uploads),
      now,
      sleep,
      log,
      fetch: io.fetch,
      deadline: now() + settings.maxWaitMs,
      /** The Higgsfield backend; made on first use, so a command that does not need the key never reads it. */
      backend() {
        if (!ctx.backendInstance) {
          const key = readKey(env, envFile(env));
          if (key === null) {
            throw new ShotsError(
              'key_rejected',
              'HIGGSFIELD_API_KEY is not set in the environment or in the .env file.',
            );
          }
          ctx.backendInstance = createBackend({
            key,
            base: apiBase(env),
            fetch: io.fetch,
            sleep,
            now,
            deadline: ctx.deadline,
            httpTimeoutMs: settings.httpTimeoutMs,
            retryMs: settings.retryMs,
            log,
          });
        }
        return ctx.backendInstance;
      },
      backendInstance: null,
    };
    if (genDir) mkdirSync(genDir, { recursive: true });
    const line = await run(args, ctx);
    return clean({ line, exit: EXIT.ok });
  } catch (error) {
    return clean(failureLine(error));
  }
}

/** The answer with any key taken out of every string in it (a server could echo one back). */
function clean(answer) {
  return { line: JSON.parse(redact(JSON.stringify(answer.line))), exit: answer.exit };
}

async function main() {
  if (process.env.STUDIO_GENERATE_FAKE === '1') {
    const fake = await import('./make-shots-fake.mjs');
    fake.main();
    return;
  }
  const { line, exit } = await runShots(process.argv.slice(2));
  console.log(redact(JSON.stringify(line)));
  process.exit(exit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
