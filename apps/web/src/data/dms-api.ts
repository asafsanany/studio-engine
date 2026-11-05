// Typed wrappers for the Instagram DMs API (/api/dms, the admin's only): every answer is parsed with
// the shared schemas, and every failure is an `ApiError` carrying the server's words.

import { type DmsResponse, dmsResponseSchema, revealDmResponseSchema } from '@studio/shared';
import { createJsonClient, type JsonClientOptions } from './api';

/** Reading the DMs asks Instagram for every new message and downloads the files: it may take a while. */
export const DM_CHECK_TIMEOUT_MS = 120_000;

export interface DmsApi {
  /** `GET /api/dms`: the connection and every item, newest first. */
  listDms(signal?: AbortSignal): Promise<DmsResponse>;
  /** `POST /api/dms/check`: the DMs read now, then the same answer. */
  checkDms(signal?: AbortSignal): Promise<DmsResponse>;
  /** `POST /api/dms/:id/reveal`: Finder shows the item's file. */
  revealDm(id: string, signal?: AbortSignal): Promise<void>;
}

/** The address of an item's downloaded file (the player's source, and the download). */
export function dmFileUrl(name: string): string {
  return `/api/dms/file/${encodeURIComponent(name)}`;
}

export function createDmsApi(options: JsonClientOptions = {}): DmsApi {
  const { request, parse } = createJsonClient(options);
  return {
    async listDms(signal) {
      return parse(dmsResponseSchema, await request('/api/dms', { signal }));
    },
    async checkDms(signal) {
      const answer = await request(
        '/api/dms/check',
        { method: 'POST', signal },
        DM_CHECK_TIMEOUT_MS,
      );
      return parse(dmsResponseSchema, answer);
    },
    async revealDm(id, signal) {
      const path = `/api/dms/${encodeURIComponent(id)}/reveal`;
      parse(revealDmResponseSchema, await request(path, { method: 'POST', signal }));
    },
  };
}

/** The app's DMs client: same origin. Hooks use this one; tests build their own. */
export const dmsApi: DmsApi = createDmsApi();
