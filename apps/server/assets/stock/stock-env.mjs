// The keys and the plain HTTP of the stock script (Stock media, ST1). Plain Node, no dependencies.
//
// The keys (OPENVERSE_CLIENT_ID, OPENVERSE_CLIENT_SECRET, UNSPLASH_ACCESS_KEY) come from the
// environment, else from the .env named by STUDIO_ENV_FILE (the engine passes the PATH only), else
// the repo's git-ignored .env. They are remembered so `redact` takes them out of everything the
// script prints, and they are only ever sent in an Authorization header (or, for Openverse's token
// request, in the form body) to the service's own host.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The variable that moves the .env file (ENV_FILE_ENV in the server's config): a path. */
export const ENV_FILE_ENV = 'STUDIO_ENV_FILE';
/** The repo's git-ignored .env, found from this file (apps/server/assets/stock/). */
export const REPO_ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));

export const KEY_ENV = {
  openverseId: 'OPENVERSE_CLIENT_ID',
  openverseSecret: 'OPENVERSE_CLIENT_SECRET',
  unsplash: 'UNSPLASH_ACCESS_KEY',
};

export const LIMITS = {
  /** One API call may take this long before it counts as no answer. */
  httpTimeoutMs: 20_000,
  /** A download may take this long. */
  transferTimeoutMs: 90_000,
  /** The biggest file a download may be, in bytes. */
  maxSfxBytes: 25 * 1024 * 1024,
  maxPhotoBytes: 40 * 1024 * 1024,
};

const secrets = new Set();

/** Remembers a key so `redact` can take it out of anything printed. */
export function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

/** Text with every key this process has read taken out, and anything shaped like a bearer token. */
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('[key]');
  return out.replace(/((?:Bearer|Client-ID)\s+)[A-Za-z0-9_.-]{6,}/g, '$1[key]');
}

/** One variable's value in a .env text, or `null`. */
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

/** A key's value, or `null` when there is none: the environment's first, then the .env file's. */
export function readKey(name, env = process.env, file = envFile(env)) {
  let value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (value === '') {
    try {
      value = (dotenvValue(readFileSync(file, 'utf8'), name) ?? '').trim();
    } catch {
      // No .env: no key.
    }
  }
  if (value === '') return null;
  rememberSecret(value);
  return value;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/** A title as the sheet and the run show it: one line, at most `max` characters, cut at a word. */
export function clipTitle(text, max = 90) {
  const one = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A service's base: its own, or (tests only) a loopback http URL named by `override`. */
export function apiBase(defaultBase, override) {
  const given = (override ?? '').trim().replace(/\/+$/, '');
  return LOOPBACK.test(given) ? given : defaultBase;
}

/** Whether a file may be downloaded from this URL: https, or http to this machine (tests). */
export function downloadAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && LOOPBACK.test(`http://${parsed.host}`);
  } catch {
    return false;
  }
}

/** A failure with a code of the stock contract; `detail` is the service's own words. */
export class StockError extends Error {
  constructor(code, message, extra = {}) {
    super(redact(message));
    this.name = 'StockError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * GET or POST with a timeout, mapped to the stock codes: 401/403 key_rejected (403 with a rate
 * words: rate_limited), 429 rate_limited, 5xx and no answer unavailable, other 4xx bad_request.
 * Returns the parsed JSON and the response headers.
 */
export async function requestJson(
  fetchFn,
  url,
  init,
  { service, timeoutMs = LIMITS.httpTimeoutMs },
) {
  let response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new StockError(
      'unavailable',
      `${service} did not answer (${redact(String(error?.cause?.code ?? error?.name ?? 'error'))}).`,
    );
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const lowered = text.toLowerCase();
    if (response.status === 429 || (response.status === 403 && lowered.includes('rate limit'))) {
      throw new StockError('rate_limited', `${service} says too many requests: try again later.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new StockError(
        'key_rejected',
        `${service} did not accept the key (HTTP ${response.status}).`,
      );
    }
    if (response.status >= 500) {
      throw new StockError(
        'unavailable',
        `${service} is not answering right now (HTTP ${response.status}).`,
      );
    }
    throw new StockError(
      'bad_request',
      `${service} refused the request (HTTP ${response.status}): ${redact(text.slice(0, 200))}`,
    );
  }
  try {
    return { json: JSON.parse(text), headers: response.headers };
  } catch {
    throw new StockError('unavailable', `${service} answered something that is not JSON.`);
  }
}

/** Downloads a file into memory, refusing one bigger than `maxBytes` or of an unexpected type. */
export async function downloadBytes(
  fetchFn,
  url,
  { maxBytes, typeOk, timeoutMs = LIMITS.transferTimeoutMs },
) {
  if (!downloadAllowed(url)) {
    throw new StockError(
      'bad_request',
      'The file is not at an https address, so it was not downloaded.',
    );
  }
  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new StockError('unavailable', 'The file could not be downloaded (no answer).');
  }
  if (!response.ok) {
    throw new StockError(
      'unavailable',
      `The file could not be downloaded (HTTP ${response.status}).`,
    );
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== '' && !typeOk(type)) {
    throw new StockError('bad_request', `The file is not the kind expected (${type}).`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new StockError('bad_request', 'The file is too big to use.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new StockError('bad_request', 'The file is too big to use.');
  if (bytes.length === 0) throw new StockError('unavailable', 'The file came back empty.');
  return { bytes, type };
}
