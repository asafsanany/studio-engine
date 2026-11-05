// Openverse, sound effects only (Stock media, ST1). Plain Node, no dependencies.
//
// Searches the audio endpoint for sound effects under licenses that fit a client video: CC0, the
// public domain mark and CC BY (no NC, no ND). The OAuth client id and secret are optional: with
// them the search runs as a registered application (higher limits), without them it runs as an
// anonymous one (low limits, but it works).
//
//   POST /v1/auth_tokens/token/   form body grant_type=client_credentials&client_id=…&client_secret=…
//   GET  /v1/audio/?q=…&source=freesound&license=cc0,pdm,by&length=shortest&page_size=…
//
// Sound effects are asked for by SOURCE, not by `category=sound_effect`: Openverse leaves the
// category of every Freesound sound empty, so that filter finds nothing (checked live, 26 Oct
// 2026). Freesound is Openverse's sound-effect library; its other audio sources are music (Jamendo)
// and Wikimedia's recordings. `length=shortest` is what Openverse calls under about 30 s.
//
// Tests: OPENVERSE_API_BASE (a loopback http URL only), and the options of createOpenverse.

import { apiBase, clipTitle, requestJson, StockError } from './stock-env.mjs';

export const API_BASE = 'https://api.openverse.org';
export const API_BASE_ENV = 'OPENVERSE_API_BASE';
/** The licenses a sound effect may have (OPENVERSE_LICENSE_FILTER in the shared contract). */
export const LICENSES = ['cc0', 'pdm', 'by'];
/** Where sound effects come from in Openverse. */
export const SFX_SOURCE = 'freesound';
/** The categories Openverse gives audio that is not a sound effect; an empty one is a Freesound sound. */
const NOT_SFX = new Set(['music', 'podcast', 'audiobook', 'news', 'pronunciation']);
const AUDIO_TYPES = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac']);

/** The API's base for this environment. */
export function openverseBase(env = process.env) {
  return apiBase(API_BASE, env[API_BASE_ENV]);
}

/** A file type as the script keeps it ("MP3" and "audio/mpeg" both become "mp3"), or `null`. */
export function audioFileType(value) {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/^audio\//, '')
    .replace(/^\./, '');
  const type = raw === 'mpeg' ? 'mp3' : raw === 'x-wav' || raw === 'wave' ? 'wav' : raw;
  return AUDIO_TYPES.has(type) ? type : null;
}

/** A search result as a candidate, or `null` when it is not one the edit may use. */
export function toCandidate(result, { maxMs }) {
  if (result === null || typeof result !== 'object') return null;
  const license = String(result.license ?? '').toLowerCase();
  if (!LICENSES.includes(license)) return null;
  if (NOT_SFX.has(String(result.category ?? '').toLowerCase())) return null;
  const durationMs = Number(result.duration);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maxMs) return null;
  if (typeof result.id !== 'string' || typeof result.url !== 'string') return null;
  return {
    sourceId: result.id,
    title: clipTitle(result.title),
    creator: String(result.creator ?? '').trim(),
    creatorUrl:
      typeof result.creator_url === 'string' && result.creator_url !== ''
        ? result.creator_url
        : null,
    license,
    licenseUrl:
      typeof result.license_url === 'string' && result.license_url !== ''
        ? result.license_url
        : null,
    sourceUrl: String(result.foreign_landing_url ?? result.detail_url ?? result.url),
    downloadUrl: result.url,
    trackUrl: null,
    fileType:
      audioFileType(result.filetype) ?? audioFileType(result.url.split('?')[0].split('.').pop()),
    durationMs: Math.round(durationMs),
    width: null,
    height: null,
  };
}

/**
 * The Openverse client. `fetch` is for tests. The token is asked for once and kept in memory: one
 * run of the script is one process.
 */
export function createOpenverse({
  clientId = null,
  clientSecret = null,
  base = API_BASE,
  fetch: fetchFn = fetch,
  log = () => {},
} = {}) {
  let token = null;

  async function bearer() {
    if (clientId === null || clientSecret === null) return null;
    if (token !== null) return token;
    const { json } = await requestJson(
      fetchFn,
      `${base}/v1/auth_tokens/token/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      },
      { service: 'Openverse' },
    );
    if (typeof json?.access_token !== 'string' || json.access_token === '') {
      throw new StockError(
        'key_rejected',
        'Openverse did not give a token: check the client id and secret in .env.',
      );
    }
    token = json.access_token;
    return token;
  }

  return {
    /** Sound effects for some words: at most `maxSeconds` long, at most `limit` of them. */
    async searchSfx(query, { maxSeconds, limit }) {
      const params = new URLSearchParams({
        q: query,
        source: SFX_SOURCE,
        license: LICENSES.join(','),
        length: 'shortest',
        mature: 'false',
        page_size: String(Math.min(20, Math.max(limit * 2, limit))),
      });
      const headers = { accept: 'application/json' };
      const auth = await bearer();
      if (auth !== null) headers.authorization = `Bearer ${auth}`;
      const { json } = await requestJson(
        fetchFn,
        `${base}/v1/audio/?${params}`,
        { headers },
        { service: 'Openverse' },
      );
      const results = Array.isArray(json?.results) ? json.results : [];
      const maxMs = maxSeconds * 1000;
      const candidates = [];
      for (const result of results) {
        const candidate = toCandidate(result, { maxMs });
        if (candidate !== null) candidates.push(candidate);
        if (candidates.length >= limit) break;
      }
      log(`openverse: ${results.length} results, ${candidates.length} usable`);
      return candidates;
    },
  };
}
