// Unsplash, photos only (Stock media, ST2). Plain Node, no dependencies.
//
//   GET /search/photos?query=…&per_page=…&orientation=…&content_filter=high   Authorization: Client-ID <key>
//   GET /photos/<id>/download        must be called every time a photo is used (Unsplash's API
//                                    guidelines); it only counts the download
//
// Unsplash's license is its own (free to use, no selling a photo unaltered), and the guidelines ask
// for the photographer and Unsplash to be named with links carrying utm_source and
// utm_medium=referral. The file comes from images.unsplash.com through the photo's `raw` URL, which
// keeps its ixid; it is asked for as a 2160 px JPEG.
//
// Tests: UNSPLASH_API_BASE (a loopback http URL only), and the options of createUnsplash.

import { apiBase, clipTitle, requestJson, StockError } from './stock-env.mjs';

export const API_BASE = 'https://api.unsplash.com';
export const API_BASE_ENV = 'UNSPLASH_API_BASE';
export const LICENSE_URL = 'https://unsplash.com/license';
export const UTM = 'utm_source=studio_engine&utm_medium=referral';
export const ORIENTATIONS = ['landscape', 'portrait', 'squarish'];

/** The API's base for this environment. */
export function unsplashBase(env = process.env) {
  return apiBase(API_BASE, env[API_BASE_ENV]);
}

/** A link of Unsplash's with the referral parameters its guidelines ask for. */
export function withUtm(url) {
  if (typeof url !== 'string' || url === '') return null;
  return `${url}${url.includes('?') ? '&' : '?'}${UTM}`;
}

/** The file URL for a photo: its raw URL as a 2160 px JPEG, or `null` when it is not on Unsplash's image host. */
export function photoFileUrl(raw, { allowLoopback = false } = {}) {
  try {
    const url = new URL(raw);
    const ok = url.protocol === 'https:' && url.hostname === 'images.unsplash.com';
    const local =
      allowLoopback &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!ok && !local) return null;
    url.searchParams.set('w', '2160');
    url.searchParams.set('fit', 'max');
    url.searchParams.set('q', '85');
    url.searchParams.set('fm', 'jpg');
    return url.toString();
  } catch {
    return null;
  }
}

/** A search result as a candidate, or `null` when it is not one the edit may use. */
export function toCandidate(result, { allowLoopback = false } = {}) {
  if (result === null || typeof result !== 'object' || typeof result.id !== 'string') return null;
  const downloadUrl = photoFileUrl(result.urls?.raw, { allowLoopback });
  if (downloadUrl === null) return null;
  const width = Number(result.width);
  const height = Number(result.height);
  return {
    sourceId: result.id,
    title: clipTitle(result.description ?? result.alt_description),
    creator: String(result.user?.name ?? '').trim(),
    creatorUrl: withUtm(result.user?.links?.html),
    license: 'unsplash',
    licenseUrl: LICENSE_URL,
    sourceUrl: withUtm(result.links?.html) ?? `https://unsplash.com/photos/${result.id}?${UTM}`,
    downloadUrl,
    trackUrl: null,
    fileType: null,
    durationMs: null,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
  };
}

/** The Unsplash client. `fetch` is for tests. */
export function createUnsplash({
  accessKey,
  base = API_BASE,
  fetch: fetchFn = fetch,
  log = () => {},
}) {
  if (typeof accessKey !== 'string' || accessKey === '') {
    throw new StockError(
      'key_missing',
      'UNSPLASH_ACCESS_KEY is not set in the environment or in the .env file.',
    );
  }
  const headers = {
    accept: 'application/json',
    'accept-version': 'v1',
    authorization: `Client-ID ${accessKey}`,
  };
  const allowLoopback = base !== API_BASE;

  return {
    /** Photos for some words, at most `limit` of them. */
    async searchPhotos(query, { orientation, limit }) {
      const params = new URLSearchParams({
        query,
        per_page: String(Math.min(30, limit)),
        content_filter: 'high',
      });
      if (orientation) params.set('orientation', orientation);
      const { json, headers: responseHeaders } = await requestJson(
        fetchFn,
        `${base}/search/photos?${params}`,
        { headers },
        { service: 'Unsplash' },
      );
      const results = Array.isArray(json?.results) ? json.results : [];
      const candidates = [];
      for (const result of results) {
        const candidate = toCandidate(result, { allowLoopback });
        if (candidate !== null) {
          candidate.trackUrl = `${base}/photos/${encodeURIComponent(candidate.sourceId)}/download`;
          candidates.push(candidate);
        }
        if (candidates.length >= limit) break;
      }
      log(
        `unsplash: ${results.length} results, ${candidates.length} usable, ${responseHeaders.get('x-ratelimit-remaining') ?? '?'} requests left this hour`,
      );
      return candidates;
    },

    /** Tells Unsplash a photo is being used: required by its API guidelines. */
    async trackDownload(trackUrl) {
      if (!trackUrl.startsWith(`${base}/photos/`)) {
        throw new StockError('bad_request', 'The download address is not Unsplash’s.');
      }
      await requestJson(fetchFn, trackUrl, { headers }, { service: 'Unsplash' });
    },
  };
}
