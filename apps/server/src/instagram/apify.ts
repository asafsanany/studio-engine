// The Apify client of Clients × Instagram (IG2): start an actor, wait for it, read its items and say
// what the run cost. Plain fetch to api.apify.com, with `fetch` injected so the tests never reach the
// network. The scan (IG4) calls `runActor` once for the profiles and once for the reels of a client.
//
// The token is APIFY_TOKEN (see APIFY_TOKEN_ENV in ../config.ts), from the environment and then the
// repo's git-ignored .env, the same key Songs uses. It only ever goes in an Authorization header:
// never in a URL, a log, an error message or a result.
//
// The actors' inputs and outputs are written down in ./README.md; the answers of real runs are in
// ./testdata/.

import { readFileSync } from 'node:fs';
import { APIFY_TOKEN_ENV, envFilePath } from '../config.js';

export const APIFY_API = 'https://api.apify.com';

/** The two Apify actors a scan uses. */
export const PROFILE_ACTOR = 'apify/instagram-profile-scraper';
export const REEL_ACTOR = 'apify/instagram-reel-scraper';

/** The most one run may take before it is stopped, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// --- the actors' inputs --------------------------------------------------------------------------

/** The input of apify/instagram-profile-scraper: the usernames (no @, no link). */
export function profileScraperInput(usernames: readonly string[]): { usernames: string[] } {
  return { usernames: [...usernames] };
}

export interface ReelScraperInputOptions {
  /** The usernames (no @, no link). */
  usernames: readonly string[];
  /** The most reels per username. */
  resultsLimit: number;
  /** Only reels newer than this many days (the actor reads it as "28 days"). */
  newerThanDays?: number;
  /** The shares add-on (paid per reel, and only on a paid Apify plan). */
  shares?: boolean;
}

/** The input of apify/instagram-reel-scraper. The transcript and video-download add-ons stay off. */
export function reelScraperInput(options: ReelScraperInputOptions): Record<string, unknown> {
  const input: Record<string, unknown> = {
    username: [...options.usernames],
    resultsLimit: options.resultsLimit,
  };
  if (options.newerThanDays !== undefined) {
    input.onlyPostsNewerThan = `${options.newerThanDays} ${options.newerThanDays === 1 ? 'day' : 'days'}`;
  }
  input.includeSharesCount = options.shares === true;
  input.includeTranscript = false;
  input.includeDownloadedVideo = false;
  return input;
}

// --- errors --------------------------------------------------------------------------------------

/**
 * - `no-token`   there is no APIFY_TOKEN, or Apify refused it (HTTP 401)
 * - `no-credit`  Apify refuses for usage: HTTP 402, or one of the error types in NO_CREDIT_TYPES
 * - `timeout`    the run went over the cap (the run is aborted), or Apify timed it out itself
 * - `failed`     the run FAILED or was ABORTED, Apify answered with an error, the network broke, or
 *                an answer was not JSON; the message says which
 */
export type ApifyErrorCode = 'no-token' | 'no-credit' | 'timeout' | 'failed';

export class ApifyError extends Error {
  readonly code: ApifyErrorCode;
  /** The HTTP status of Apify's answer, when the error is one. */
  readonly status: number | null;
  /** The run, when it had started: look it up in the Apify console. */
  runId: string | null;
  /** What the run cost until it stopped, when Apify said. */
  costUsd: number | null;
  /** True when the caller's signal stopped the run (the run is aborted on Apify too). */
  readonly cancelled: boolean;

  constructor(
    code: ApifyErrorCode,
    message: string,
    extra: { status?: number; runId?: string; costUsd?: number | null; cancelled?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApifyError';
    this.code = code;
    this.status = extra.status ?? null;
    this.runId = extra.runId ?? null;
    this.costUsd = extra.costUsd ?? null;
    this.cancelled = extra.cancelled === true;
  }
}

/** Apify's error types (the `error.type` of an answer) that mean "no usage left", whatever the status. */
const NO_CREDIT_TYPES = new Set([
  'not-enough-usage-to-run-paid-actor',
  'apify-plan-required-to-use-paid-actor',
  'failed-to-charge-user',
  'x402-payment-required',
]);

/** Apify's error types that mean the token is missing, wrong or unknown. */
const NO_TOKEN_TYPES = new Set([
  'invalid-token',
  'token-not-provided',
  'missing-api-token',
  'user-or-token-not-found',
]);

// --- the token -----------------------------------------------------------------------------------

/** The value of `name` in the text of a .env file; `null` when it is not there. */
export function dotenvValue(text: string, name: string): string | null {
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

/**
 * The Apify key: APIFY_TOKEN in `env`, then in the .env file; `null` when neither has one. The
 * value is for the caller's Authorization header only.
 */
export function readApifyToken(
  env: Record<string, string | undefined> = process.env,
  envFile: string = envFilePath(env),
): string | null {
  const given = env[APIFY_TOKEN_ENV]?.trim() ?? '';
  if (given !== '') return given;
  try {
    const fromFile = (dotenvValue(readFileSync(envFile, 'utf8'), APIFY_TOKEN_ENV) ?? '').trim();
    return fromFile === '' ? null : fromFile;
  } catch {
    return null; // no .env: no key
  }
}

// --- the run -------------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RunActorOptions {
  /** Stops the run (on Apify too) when it aborts; `runActor` then throws a cancelled `failed`. */
  signal?: AbortSignal;
  /** The most the whole run may take (start, wait, items). Default 10 minutes. */
  timeoutMs?: number;
  /** The most the run may cost in US dollars (Apify stops a pay-per-event actor at it). */
  maxChargeUsd?: number;
  /** Injected in tests. Default: the global fetch. */
  fetch?: FetchLike;
  /** The key itself (tests). Default: APIFY_TOKEN from `env`, then the .env file. */
  token?: string;
  /** Where the key is read from. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** The .env file the key is read from. Default: the repo's (or STUDIO_ENV_FILE). */
  envFile?: string;
  /** How long one wait on Apify's side is (its `waitForFinish`, 0 to 60). Default 30. */
  pollSecs?: number;
  /** The pause between two waits, and before a retry of a read. Default 1000. */
  pollGapMs?: number;
}

export interface RunActorResult<T = unknown> {
  /** The dataset items of the run, as the actor wrote them. */
  items: T[];
  runId: string;
  /**
   * The run's `usageTotalUsd` as it stood when the run ended; `null` when Apify did not say. Apify
   * tallies a pay-per-event run's charges a few seconds after it ends, so this is early and low:
   * `readRunCost` reads it again later (the scan's cost check, ./scan-costs.ts).
   */
  costUsd: number | null;
}

interface ApifyRun {
  id: string;
  status: string;
  statusMessage: string | null;
  defaultDatasetId: string | null;
  costUsd: number | null;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const READ_ATTEMPTS = 3;
const ABORT_CALL_MS = 15_000;

interface Context {
  token: string;
  fetch: FetchLike;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  deadline: number;
  pollSecs: number;
  pollGapMs: number;
}

/** A message with the token taken out and no more than 300 characters. */
function clean(ctx: { token: string }, text: string): string {
  const withoutToken = ctx.token === '' ? text : text.split(ctx.token).join('[token]');
  const flat = withoutToken.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

function errorText(ctx: { token: string }, error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return clean(ctx, typeof cause?.code === 'string' ? `${base} (${cause.code})` : base);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function timeoutError(ctx: Context, runId?: string): ApifyError {
  const seconds = Math.max(1, Math.round(ctx.timeoutMs / 1000));
  return new ApifyError(
    'timeout',
    `The Apify run took longer than ${seconds} s and was stopped`,
    runId === undefined ? {} : { runId },
  );
}

/** One request to Apify. Throws `timeout` at the deadline, a cancelled `failed` when the caller aborts. */
async function once(
  ctx: Context,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string>,
  body: unknown,
  limits: { bound?: boolean } = {},
): Promise<Response> {
  const bound = limits.bound !== false;
  if (bound && ctx.signal?.aborted) {
    throw new ApifyError('failed', 'The Apify run was cancelled', { cancelled: true });
  }
  const remaining = ctx.deadline - Date.now();
  if (bound && remaining <= 0) throw timeoutError(ctx);
  const url = new URL(path, APIFY_API);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const timer = AbortSignal.timeout(bound ? remaining : ABORT_CALL_MS);
  const signals = bound && ctx.signal ? [timer, ctx.signal] : [timer];
  try {
    return await ctx.fetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (bound && ctx.signal?.aborted) {
      throw new ApifyError('failed', 'The Apify run was cancelled', { cancelled: true });
    }
    if (timer.aborted && bound) throw timeoutError(ctx);
    throw new ApifyError('failed', `Apify could not be reached: ${errorText(ctx, error)}`);
  }
}

/** Apify's answer to a request that did not go through, as the error the caller gets. */
async function httpError(ctx: Context, response: Response): Promise<ApifyError> {
  const { status } = response;
  let type = '';
  let message = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
      if (typeof parsed.error?.type === 'string') type = parsed.error.type;
      if (typeof parsed.error?.message === 'string') message = parsed.error.message;
    } catch {
      message = text;
    }
  } catch {
    // The body is only for the message.
  }
  const detail = clean(ctx, [type, message].filter((part) => part !== '').join(': '));
  if (status === 402 || NO_CREDIT_TYPES.has(type)) {
    return new ApifyError(
      'no-credit',
      `Apify refuses the run for usage (HTTP ${status}${detail === '' ? '' : `, ${detail}`}). Check the Apify account's credit.`,
      { status },
    );
  }
  if (status === 401 || NO_TOKEN_TYPES.has(type)) {
    return new ApifyError(
      'no-token',
      `Apify refused the key (HTTP ${status}${detail === '' ? '' : `, ${detail}`}). Check APIFY_TOKEN in .env.`,
      { status },
    );
  }
  return new ApifyError('failed', `Apify answered ${status}${detail === '' ? '' : `: ${detail}`}`, {
    status,
  });
}

/** A request whose answer is Apify's JSON `{ data }`. A read is tried again when the network or Apify breaks. */
async function send(
  ctx: Context,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
  retry = false,
): Promise<Response> {
  const attempts = retry ? READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await once(ctx, method, path, query, body);
    } catch (error) {
      // Only the network breaking is tried again, not the cap, a cancel or anything else.
      const retryable = error instanceof ApifyError && error.code === 'failed' && !error.cancelled;
      if (!retryable || attempt >= attempts) throw error;
      await sleep(ctx.pollGapMs, ctx.signal);
      continue;
    }
    if (response.ok) return response;
    const failure = await httpError(ctx, response);
    const again = response.status >= 500 || response.status === 429;
    if (!again || attempt >= attempts) throw failure;
    await sleep(ctx.pollGapMs, ctx.signal);
  }
}

/** The run object of an answer (`{ data: run }`). */
async function readRun(ctx: Context, response: Response): Promise<ApifyRun> {
  let data: Record<string, unknown> | undefined;
  try {
    const parsed = (await response.json()) as { data?: Record<string, unknown> };
    data = parsed.data;
  } catch {
    data = undefined;
  }
  if (!data || typeof data.id !== 'string' || typeof data.status !== 'string') {
    throw new ApifyError('failed', "Apify's answer about the run could not be read");
  }
  return {
    id: data.id,
    status: data.status,
    statusMessage:
      typeof data.statusMessage === 'string' && data.statusMessage !== ''
        ? clean(ctx, data.statusMessage)
        : null,
    defaultDatasetId: typeof data.defaultDatasetId === 'string' ? data.defaultDatasetId : null,
    costUsd: typeof data.usageTotalUsd === 'number' ? data.usageTotalUsd : null,
  };
}

/** "apify/instagram-reel-scraper" is "apify~instagram-reel-scraper" in a path. */
const actorPath = (actorId: string) => encodeURIComponent(actorId.replace('/', '~'));

/** Aborts the run on Apify and notes what it cost; never throws. */
async function stopRun(ctx: Context, error: ApifyError, runId: string): Promise<void> {
  try {
    const path = `/v2/actor-runs/${encodeURIComponent(runId)}`;
    await once(ctx, 'POST', `${path}/abort`, {}, undefined, { bound: false });
    const run = await readRun(ctx, await once(ctx, 'GET', path, {}, undefined, { bound: false }));
    error.costUsd = run.costUsd;
  } catch {
    // The run may already be over; its id is on the error for the Apify console.
  }
}

/** The key and the limits of a call; throws `no-token` when there is no key (nothing is sent). */
function contextOf(options: RunActorOptions, timeoutMs: number): Context {
  const env = options.env ?? process.env;
  const token = options.token ?? readApifyToken(env, options.envFile ?? envFilePath(env));
  if (token === null || token === '') {
    throw new ApifyError('no-token', `There is no Apify key: add ${APIFY_TOKEN_ENV} to .env`);
  }
  return {
    token,
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    signal: options.signal,
    timeoutMs,
    deadline: Date.now() + timeoutMs,
    pollSecs: Math.min(60, Math.max(0, Math.floor(options.pollSecs ?? 30))),
    pollGapMs: options.pollGapMs ?? 1000,
  };
}

/**
 * Runs an Apify actor and gives back what it wrote: starts the run, waits for it (Apify's
 * `waitForFinish`, a minute at the most per wait), aborts it when `timeoutMs` passes, then reads the
 * dataset items. `costUsd` is the run's `usageTotalUsd`. Throws an `ApifyError`.
 */
export async function runActor<T = unknown>(
  actorId: string,
  input: unknown,
  options: RunActorOptions = {},
): Promise<RunActorResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx = contextOf(options, timeoutMs);

  let runId: string | null = null;
  let finished = false;
  try {
    // The run's own limits too, so Apify stops it even if this process is gone.
    const startQuery: Record<string, string> = {
      timeout: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    };
    if (options.maxChargeUsd !== undefined) {
      startQuery.maxTotalChargeUsd = String(options.maxChargeUsd);
    }
    let run = await readRun(
      ctx,
      await send(ctx, 'POST', `/v2/acts/${actorPath(actorId)}/runs`, startQuery, input ?? {}),
    );
    runId = run.id;

    for (let first = true; !TERMINAL.has(run.status); first = false) {
      if (!first) await sleep(ctx.pollGapMs, ctx.signal);
      const remainingMs = ctx.deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError(ctx, run.id);
      const waitSecs = Math.min(ctx.pollSecs, Math.floor(remainingMs / 1000));
      run = await readRun(
        ctx,
        await send(
          ctx,
          'GET',
          `/v2/actor-runs/${encodeURIComponent(run.id)}`,
          { waitForFinish: String(waitSecs) },
          undefined,
          true,
        ),
      );
    }
    finished = true;

    if (run.status === 'TIMED-OUT') {
      throw new ApifyError(
        'timeout',
        `The Apify run timed out${run.statusMessage ? `: ${run.statusMessage}` : ''}`,
        {
          runId: run.id,
          costUsd: run.costUsd,
        },
      );
    }
    if (run.status !== 'SUCCEEDED') {
      throw new ApifyError(
        'failed',
        `The Apify run ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ''}`,
        { runId: run.id, costUsd: run.costUsd },
      );
    }
    if (run.defaultDatasetId === null) {
      throw new ApifyError('failed', 'The Apify run has no dataset', {
        runId: run.id,
        costUsd: run.costUsd,
      });
    }

    const response = await send(
      ctx,
      'GET',
      `/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items`,
      { format: 'json', clean: '1' },
      undefined,
      true,
    );
    let items: unknown;
    try {
      items = JSON.parse(await response.text());
    } catch {
      items = undefined;
    }
    if (!Array.isArray(items)) {
      throw new ApifyError('failed', "Apify's items could not be read (not a JSON list)", {
        runId: run.id,
        costUsd: run.costUsd,
      });
    }
    return { items: items as T[], runId: run.id, costUsd: run.costUsd };
  } catch (caught) {
    const error =
      caught instanceof ApifyError
        ? caught
        : new ApifyError('failed', `Apify failed: ${errorText(ctx, caught)}`);
    if (runId !== null && error.runId === null) error.runId = runId;
    // The cap or the caller stopped us while the run was still going: stop it on Apify too.
    if (runId !== null && !finished && (error.code === 'timeout' || error.cancelled)) {
      await stopRun(ctx, error, runId);
    }
    throw error;
  }
}

// --- the cost, read again --------------------------------------------------------------------------

/** The most one read of a finished run may take, in milliseconds. */
export const READ_COST_TIMEOUT_MS = 30_000;

export type ReadRunCostOptions = Pick<
  RunActorOptions,
  'signal' | 'fetch' | 'token' | 'env' | 'envFile' | 'pollGapMs'
> & {
  /** The most the read may take, retries included. Default {@link READ_COST_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/** What Apify says about a run that has started: whether it is over, and what it cost so far. */
export interface RunCostReading {
  /** Apify's status of the run (`SUCCEEDED`, `RUNNING`, ...). */
  status: string;
  /** True when the run is over (SUCCEEDED, FAILED, ABORTED or TIMED-OUT): its cost can only be the last one. */
  finished: boolean;
  /** The run's `usageTotalUsd` now; `null` when Apify does not say. */
  costUsd: number | null;
}

/**
 * Reads a run again (`GET /v2/actor-runs/<id>`) for what it cost. `runActor` takes the cost as the
 * run ends, and Apify tallies a pay-per-event run's charges a few seconds after that, so the scan's
 * cost check calls this some minutes later. A read that breaks (network, 5xx, 429) is tried again,
 * up to 3 times. Throws an `ApifyError` (`no-token`, `timeout`, or `failed`, with `status` for an
 * answer such as 404 for a run Apify no longer has).
 */
export async function readRunCost(
  runId: string,
  options: ReadRunCostOptions = {},
): Promise<RunCostReading> {
  const ctx = contextOf(options, options.timeoutMs ?? READ_COST_TIMEOUT_MS);
  try {
    const run = await readRun(
      ctx,
      await send(ctx, 'GET', `/v2/actor-runs/${encodeURIComponent(runId)}`, {}, undefined, true),
    );
    return { status: run.status, finished: TERMINAL.has(run.status), costUsd: run.costUsd };
  } catch (caught) {
    if (caught instanceof ApifyError) {
      caught.runId ??= runId;
      throw caught;
    }
    throw new ApifyError('failed', `Apify failed: ${errorText(ctx, caught)}`, { runId });
  }
}
