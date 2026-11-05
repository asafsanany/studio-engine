// The Higgsfield API backend of make-shots.mjs (Generated videos, GN3). It is the only code that
// talks to Higgsfield; make-shots.mjs only uses the six functions of the object `createBackend`
// returns, so a CLI backend could be added beside this file later without touching the script:
//
//   estimate(slug, body)               free: the price answer of POST /estimate/<slug>
//   uploadUrl(contentType)             POST /files/generate-upload-url -> { public_url, upload_url, upload_headers }
//   putFile(url, headers, bytes)       PUT of the bytes to the presigned storage URL (no key sent)
//   submit(slug, body, idemKey)        POST /<slug> with an Idempotency-Key -> { request_id, ... }
//   status(requestId)                  GET /requests/<id>/status -> { status, video | images, error, ... }
//   download(url)                      plain GET of a finished file (public URL, no key) -> Buffer
//
// Facts: ~/.studio-engine/handoff/generate-design/higgsfield-api.md (live-checked 25 Oct 2026).
//
// The key (`id:secret`, sent as `Authorization: Key id:secret`) is read from the environment, then
// from the repo's git-ignored .env (or the file named by STUDIO_ENV_FILE: the engine passes a run
// that PATH only, never the value). It is only ever sent in that header, only to the API's own host
// (never to a URL an answer names), and every text this module returns or throws passes `redact`.
//
// Errors are `ApiError`s with the code of the shared contract (GENERATE_ERROR_CODES):
//   401 -> key_rejected        403 -> balance_empty (ANY 403: the body is {"detail":"not_enough_credits"})
//   400, 404, 409, 422 -> bad_request, with the API's own detail text
//   429 -> waits Retry-After and sends the same request again (nothing was created or charged)
//   5xx, 423, no answer -> tried again with backoff, then unavailable
//
// Plain Node, no dependencies. For tests: HIGGSFIELD_API_BASE (a loopback http URL only: the key
// must not be sent anywhere else), and the options of createBackend (fetch, sleep, now, timeouts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_BASE = 'https://api.higgsfield.ai';
/** The name of the key's variable (HIGGSFIELD_API_KEY_ENV in the server's config). */
export const KEY_ENV = 'HIGGSFIELD_API_KEY';
/** The variable that moves the .env file (ENV_FILE_ENV in the server's config): a path. */
export const ENV_FILE_ENV = 'STUDIO_ENV_FILE';
/** Moves the API (tests): honoured only for a loopback http URL. */
export const API_BASE_ENV = 'HIGGSFIELD_API_BASE';
/** The repo's git-ignored .env, found from this file (apps/server/assets/generate/backends/). */
export const REPO_ENV_FILE = fileURLToPath(new URL('../../../../../.env', import.meta.url));

export const LIMITS = {
  /** One HTTP call may take this long before it counts as no answer. */
  httpTimeoutMs: 30_000,
  /** Downloads and uploads move megabytes. */
  transferTimeoutMs: 120_000,
  /** The wait before the first retry of a 5xx or a missing answer; it doubles each time. */
  retryMs: 2_000,
  /** Tries of a call that gets a 5xx or no answer. */
  attempts: 4,
  /** Times a 429 (queue full) is waited out. */
  throttleTries: 8,
  /** The longest one 429 wait, whatever Retry-After says. */
  throttleMaxMs: 90_000,
};

// --- the key ------------------------------------------------------------------------------------

/** Pieces of the key this process has read: `redact` takes each of them out of any text. */
const secrets = new Set();

/** Remembers a key (and its two halves) so `redact` can take it out of anything printed. */
export function rememberKey(key) {
  for (const part of [key, ...key.split(':')]) if (part.length >= 6) secrets.add(part);
}

/** Text with the key taken out: what this process read, and anything shaped like `Key id:secret`. */
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('[key]');
  return out.replace(/(Key\s+)[A-Za-z0-9_-]{6,}:[A-Za-z0-9_-]{6,}/g, '$1[key]');
}

/** One variable's value in a .env text, or `null` (the doctor's parseDotenv rules). */
export function dotenvValue(text, name) {
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

/** The .env file: STUDIO_ENV_FILE (absolute or `~/…`) when set, else the repo's. */
export function envFile(env = process.env, home = homedir()) {
  const given = (env[ENV_FILE_ENV] ?? '').trim();
  if (given !== '') {
    const path = given === '~' || given.startsWith('~/') ? join(home, given.slice(1)) : given;
    if (isAbsolute(path)) return path;
  }
  return REPO_ENV_FILE;
}

/**
 * The Higgsfield key, or `null` when there is none: the environment's first, then the .env file's.
 * The value is remembered so `redact` removes it from every message; it is never returned in one.
 */
export function readKey(env = process.env, file = envFile(env)) {
  let key = typeof env[KEY_ENV] === 'string' ? env[KEY_ENV].trim() : '';
  if (key === '') {
    try {
      key = (dotenvValue(readFileSync(file, 'utf8'), KEY_ENV) ?? '').trim();
    } catch {
      // No .env: no key.
    }
  }
  if (key === '') return null;
  rememberKey(key);
  return key;
}

/** Where the API is: Higgsfield's, or (tests only) a loopback http server named by HIGGSFIELD_API_BASE. */
export function apiBase(env = process.env) {
  const given = (env[API_BASE_ENV] ?? '').trim().replace(/\/+$/, '');
  return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(given) ? given : API_BASE;
}

// --- errors -------------------------------------------------------------------------------------

/** A failure with the shared contract's code; `detail` is the API's own words. */
export class ApiError extends Error {
  constructor(code, detail, status = null, extra = {}) {
    super(redact(detail));
    this.name = 'ApiError';
    this.code = code;
    this.detail = redact(detail);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** The API's own words out of an error answer: FastAPI's `detail` (text, object or list), else the body. */
export function detailOf(json, text = '') {
  const detail = json && typeof json === 'object' ? json.detail : undefined;
  let out = '';
  if (typeof detail === 'string') out = detail;
  else if (Array.isArray(detail)) {
    out = detail
      .map((item) =>
        item && typeof item === 'object'
          ? `${Array.isArray(item.loc) ? `${item.loc.join('.')}: ` : ''}${item.msg ?? JSON.stringify(item)}`
          : String(item),
      )
      .join('; ');
  } else if (detail && typeof detail === 'object') {
    out = [detail.code, detail.message].filter((part) => typeof part === 'string').join(': ');
    if (out === '') out = JSON.stringify(detail);
  } else if (json && typeof json === 'object' && typeof json.error === 'string') out = json.error;
  else out = String(text ?? '').trim();
  return redact(out).replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** The error an unsuccessful HTTP answer means. */
export function errorForReply(status, json, text, label) {
  const detail = detailOf(json, text) || `HTTP ${status}`;
  if (status === 401) return new ApiError('key_rejected', detail, status);
  if (status === 403) return new ApiError('balance_empty', detail, status);
  if (status === 429 || status === 423 || status >= 500) {
    return new ApiError('unavailable', `${label}: HTTP ${status} ${detail}`, status);
  }
  return new ApiError('bad_request', `${label}: HTTP ${status} ${detail}`, status);
}

/** How long a 429 asks to wait: Retry-After seconds (or a date), else the body's retry_after_seconds, else 5 s. */
export function retryAfterMs(headers, json) {
  const header = headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const fromBody = Number(json?.detail?.retry_after_seconds);
  return Number.isFinite(fromBody) && fromBody >= 0 ? Math.round(fromBody * 1000) : 5_000;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorName = (error) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? 'timed out'
    : 'network error';

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- the backend --------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.key        the Higgsfield key (`id:secret`)
 * @param {string} [options.base]     the API's base URL
 * @param {typeof fetch} [options.fetch]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {number} [options.deadline] epoch ms after which a wait is refused (`unavailable`)
 * @param {number} [options.httpTimeoutMs]
 * @param {number} [options.retryMs]
 * @param {(line: string) => void} [options.log]
 */
export function createBackend(options) {
  const key = options.key;
  const base = options.base ?? API_BASE;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const httpTimeoutMs = options.httpTimeoutMs ?? LIMITS.httpTimeoutMs;
  const retryMs = options.retryMs ?? LIMITS.retryMs;
  const log = options.log ?? (() => {});
  rememberKey(key);

  /** Waits `ms`, or refuses (`unavailable`) when that would pass the command's deadline. */
  async function pause(ms, why) {
    if (now() + ms > deadline) {
      throw new ApiError('unavailable', `${why}: still not answering when this call had to end`);
    }
    await sleep(ms);
  }

  /**
   * One call with the retry rules: a 429 is waited out (Retry-After) and sent again; a 5xx, 423 or no
   * answer is tried again with backoff. Returns `{ status, headers, text, json }` for any other answer.
   */
  async function call(
    label,
    url,
    init,
    { auth = true, timeoutMs = httpTimeoutMs, binary = false } = {},
  ) {
    let attempt = 0;
    let throttled = 0;
    for (;;) {
      attempt += 1;
      let res;
      let text;
      try {
        res = await fetchImpl(url, {
          ...init,
          headers: { ...(auth ? { Authorization: `Key ${key}` } : {}), ...init.headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = binary && res.status === 200 ? null : await res.text();
      } catch (error) {
        if (attempt >= LIMITS.attempts) {
          throw new ApiError('unavailable', `${label}: no answer (${errorName(error)})`);
        }
        log(`${label}: no answer (${errorName(error)}), trying again`);
        await pause(retryMs * 2 ** (attempt - 1), label);
        continue;
      }
      const json = text === null ? null : parse(text);
      if (res.status === 429 && throttled < LIMITS.throttleTries) {
        throttled += 1;
        const wait = Math.min(retryAfterMs(res.headers, json), LIMITS.throttleMaxMs);
        log(`${label}: the queue is full, waiting ${Math.ceil(wait / 1000)} s`);
        await pause(wait, label);
        continue;
      }
      if ((res.status >= 500 || res.status === 423) && attempt < LIMITS.attempts) {
        log(`${label}: HTTP ${res.status}, trying again`);
        await pause(retryMs * 2 ** (attempt - 1), label);
        continue;
      }
      return { status: res.status, headers: res.headers, text, json, res };
    }
  }

  const post = (label, url, body, headers = {}) =>
    call(label, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return {
    base,

    /** The answer of `POST /estimate/<slug>`; free, and validates the body like a real call. */
    async estimate(slug, body) {
      const reply = await post('estimate', `${base}/estimate/${slug}`, body);
      if (reply.status !== 200 || !reply.json)
        throw errorForReply(reply.status, reply.json, reply.text, 'estimate');
      return reply.json;
    },

    /** A presigned upload: `{ public_url, upload_url, upload_headers }`. */
    async uploadUrl(contentType) {
      const reply = await post('upload', `${base}/files/generate-upload-url`, {
        content_type: contentType,
      });
      const json = reply.json;
      if (reply.status !== 200 || !json?.public_url || !json?.upload_url) {
        throw errorForReply(reply.status, json, reply.text, 'upload');
      }
      return json;
    },

    /** The PUT of the bytes to the storage URL: with exactly `headers`, and never with the key. */
    async putFile(url, headers, bytes) {
      const reply = await call(
        'upload',
        url,
        { method: 'PUT', headers, body: bytes },
        { auth: false, timeoutMs: LIMITS.transferTimeoutMs },
      );
      if (reply.status < 200 || reply.status >= 300) {
        throw errorForReply(reply.status, reply.json, reply.text, 'upload');
      }
    },

    /** Submits a request. The same key and body again returns the ORIGINAL request_id (a receipt). */
    async submit(slug, body, idempotencyKey) {
      const reply = await post('submit', `${base}/${slug}`, body, {
        'Idempotency-Key': idempotencyKey,
      });
      if (reply.status !== 200 || !reply.json || typeof reply.json.request_id !== 'string') {
        throw errorForReply(reply.status, reply.json, reply.text, 'submit');
      }
      return reply.json;
    },

    /** The state of a request. The URL is built here, not taken from an answer: the key goes only to `base`. */
    async status(requestId) {
      const reply = await call(
        'status',
        `${base}/requests/${encodeURIComponent(requestId)}/status`,
        { method: 'GET', headers: {} },
      );
      if (reply.status !== 200 || !reply.json)
        throw errorForReply(reply.status, reply.json, reply.text, 'status');
      return reply.json;
    },

    /** A finished file (a public URL, downloaded with no key). */
    async download(url) {
      const reply = await call(
        'download',
        url,
        { method: 'GET', headers: {} },
        { auth: false, timeoutMs: LIMITS.transferTimeoutMs, binary: true },
      );
      if (reply.status !== 200) {
        throw new ApiError(
          reply.status >= 500 ? 'unavailable' : 'generation_failed',
          `download: HTTP ${reply.status}${reply.status >= 400 && reply.status < 500 ? ' (Higgsfield keeps a finished file for 7 days)' : ''}`,
          reply.status,
        );
      }
      return Buffer.from(await reply.res.arrayBuffer());
    },
  };
}
