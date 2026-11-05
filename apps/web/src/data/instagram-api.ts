// Typed fetch wrappers for the Instagram API (Clients × Instagram, IG0), one per route, built like
// series-api.ts's: every answer is parsed with the shared schemas, and every failure is an
// `ApiError` carrying the server's words (a 400 says what is wrong with the handle, a 409 says why
// a reel cannot be linked, in INSTAGRAM_LINK_MESSAGES). While the Instagram switch is off every
// route answers 404 "Clients × Instagram is off."; the page asks `useInstagramEnabled` first and
// shows nothing of Instagram then.

import {
  type ClientInstagram,
  clientInstagramSchema,
  DEFAULT_INSTAGRAM_RANGE,
  deleteClientInstagramResponseSchema,
  type InstagramLinkRequest,
  type InstagramRange,
  type InstagramReel,
  instagramLinkResponseSchema,
  type JobReelResponse,
  jobReelResponseSchema,
  type SetClientInstagramRequest,
} from '@studio/shared';
import { createJsonClient, type JsonClientOptions } from './api';

export interface InstagramApi {
  /**
   * `GET /api/clients/:clientId/instagram`: the client's Instagram for `range` (the numbers are
   * the range's). Rejects with an `ApiError` 404 for a client the engine does not know.
   */
  getClientInstagram(
    clientId: string,
    range?: InstagramRange,
    signal?: AbortSignal,
  ): Promise<ClientInstagram>;
  /**
   * `PUT /api/clients/:clientId/instagram`: the account to read, as typed (the server reads the
   * handle out of a link, and refuses what is no handle with 400 and the words). Answers the
   * client's Instagram with its first scan queued.
   */
  setClientInstagram(
    clientId: string,
    account: SetClientInstagramRequest,
    signal?: AbortSignal,
  ): Promise<ClientInstagram>;
  /** `DELETE /api/clients/:clientId/instagram`: the client has no account any more. */
  deleteClientInstagram(clientId: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/clients/:clientId/instagram/scan`: Scan now. Answers (202) with the scan queued. */
  scanClientInstagram(clientId: string, signal?: AbortSignal): Promise<ClientInstagram>;
  /**
   * `POST /api/instagram/reels/:shortcode/link`: links the reel to the job and answers the reel.
   * 409 (with the reason in words) when the job is not this client's or not delivered, or either
   * is linked already.
   */
  linkReel(shortcode: string, jobId: string, signal?: AbortSignal): Promise<InstagramReel>;
  /** `DELETE /api/instagram/reels/:shortcode/link`: unlinks the reel and answers it. */
  unlinkReel(shortcode: string, signal?: AbortSignal): Promise<InstagramReel>;
  /**
   * `GET /api/jobs/:jobId/reel`: the reel linked to the job with its numbers (the job sheet's "On
   * Instagram" line), `reel: null` for a job none links. Rejects with an `ApiError`: 404 for an
   * unknown job and while Clients × Instagram is off.
   */
  getJobReel(jobId: string, signal?: AbortSignal): Promise<JobReelResponse>;
}

function clientPath(clientId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/instagram`;
}

function linkPath(shortcode: string): string {
  return `/api/instagram/reels/${encodeURIComponent(shortcode)}/link`;
}

/** A request with a JSON body. */
function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

export function createInstagramApi(options: JsonClientOptions = {}): InstagramApi {
  const { request, parse } = createJsonClient(options);

  return {
    async getClientInstagram(clientId, range = DEFAULT_INSTAGRAM_RANGE, signal) {
      const path = `${clientPath(clientId)}?range=${range}`;
      return parse(clientInstagramSchema, await request(path, { signal }));
    },
    async setClientInstagram(clientId, account, signal) {
      const answer = await request(clientPath(clientId), jsonInit('PUT', account, signal));
      return parse(clientInstagramSchema, answer);
    },
    async deleteClientInstagram(clientId, signal) {
      const answer = await request(clientPath(clientId), { method: 'DELETE', signal });
      parse(deleteClientInstagramResponseSchema, answer);
    },
    async scanClientInstagram(clientId, signal) {
      const answer = await request(`${clientPath(clientId)}/scan`, { method: 'POST', signal });
      return parse(clientInstagramSchema, answer);
    },
    async linkReel(shortcode, jobId, signal) {
      const body: InstagramLinkRequest = { jobId };
      const answer = await request(linkPath(shortcode), jsonInit('POST', body, signal));
      return parse(instagramLinkResponseSchema, answer);
    },
    async unlinkReel(shortcode, signal) {
      const answer = await request(linkPath(shortcode), { method: 'DELETE', signal });
      return parse(instagramLinkResponseSchema, answer);
    },
    async getJobReel(jobId, signal) {
      const path = `/api/jobs/${encodeURIComponent(jobId)}/reel`;
      return parse(jobReelResponseSchema, await request(path, { signal }));
    },
  };
}

/** The app's Instagram client: same origin. Hooks use this one; tests build their own with `createInstagramApi`. */
export const instagramApi: InstagramApi = createInstagramApi();

/**
 * The address of a client's Instagram picture (`GET /api/clients/:clientId/photo`, a JPEG). Give it
 * the account's `photoSavedAt` so that a new picture is fetched again instead of the cached one.
 * The picture is there only once a scan has saved it: until then the address answers 404 and the
 * avatar shows the initials.
 */
export function clientPhotoUrl(clientId: string, photoSavedAt?: string | null): string {
  const path = `/api/clients/${encodeURIComponent(clientId)}/photo`;
  return photoSavedAt ? `${path}?v=${encodeURIComponent(photoSavedAt)}` : path;
}

/**
 * The address of a client's picture for the time the client list gives (`photoAt`, an ISO time):
 * `?v=` is that time in milliseconds, which is what the engine sends the picture for good under
 * (an immutable, year-long cache), so the picture is fetched once and again only when a new one is
 * saved.
 */
export function clientPhotoSrc(clientId: string, photoAt: string): string {
  const savedAt = Date.parse(photoAt);
  return clientPhotoUrl(clientId, Number.isFinite(savedAt) ? String(savedAt) : null);
}
