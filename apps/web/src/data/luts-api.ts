// Typed wrappers for the LUTs API (LUTs plan, "API"), one per route, built like graphics-api.ts:
// every answer is parsed with the shared schemas, and every failure is an `ApiError` carrying the
// server's words (LUT_MESSAGES). The files of an import go as multipart through an XMLHttpRequest,
// like a style upload, so their progress can be shown and there is no time limit. While the LUTs
// switch is off every route answers 404 "LUTs are off."; the pages ask `useLutsEnabled` first and
// ask nothing then.

import {
  cancelLutStageResponseSchema,
  type DeleteLutResponse,
  deleteLutResponseSchema,
  type LutDetail,
  type LutFrame,
  type LutImportRequest,
  type LutImportResponse,
  type LutListResponse,
  type LutPreviewSide,
  type LutStageResponse,
  lutDetailSchema,
  lutImportResponseSchema,
  lutListResponseSchema,
  lutStageResponseSchema,
  revealLutResponseSchema,
  type UpdateLutRequest,
} from '@studio/shared';
import { type ApiOptions, createFormSender, createJsonClient, type JsonClientOptions } from './api';

/** The files of one import step 1, with the upload's progress and its cancel. */
export interface LutStageSend {
  files: readonly File[];
  /** Told the share of the bytes sent so far (0 to 100). */
  onProgress?: (percent: number) => void;
  /** Aborts the request. */
  signal?: AbortSignal;
}

export interface LutsApi {
  /** `GET /api/luts`: Yours, Built in and whether the colour grade is installed. */
  listLuts(signal?: AbortSignal): Promise<LutListResponse>;
  /** `GET /api/luts/:slug`: one LUT with everything its pane shows. 404 for an unknown one. */
  getLut(slug: string, signal?: AbortSignal): Promise<LutDetail>;
  /** `PATCH /api/luts/:slug`: rename and/or mark a kind (Yours only). */
  updateLut(slug: string, patch: UpdateLutRequest, signal?: AbortSignal): Promise<LutDetail>;
  /** `DELETE /api/luts/:slug`: to the Trash (Yours only); answers where the file went. */
  deleteLut(slug: string, signal?: AbortSignal): Promise<DeleteLutResponse>;
  /** `POST /api/luts/:slug/duplicate`: Yours: "X (2)"; Built in: a copy in Yours. Answers the copy. */
  duplicateLut(slug: string, signal?: AbortSignal): Promise<LutDetail>;
  /** `POST /api/luts/:slug/reveal`: Finder shows the LUT's file. */
  revealLut(slug: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/luts/stage`: import step 1, the files checked one by one. */
  stageLuts(send: LutStageSend): Promise<LutStageResponse>;
  /** `DELETE /api/luts/stage/:stageId`: throws an upload away. */
  cancelStage(stageId: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/luts/import`: import step 3, the staged files marked Look, Camera or Fix. */
  importStaged(request: LutImportRequest, signal?: AbortSignal): Promise<LutImportResponse>;
}

function lutPath(slug: string): string {
  return `/api/luts/${encodeURIComponent(slug)}`;
}

/**
 * The address of a preview still: `frame` (person, street, interior) before or after the LUT. The
 * server makes it on the first request and caches it, so an `<img src>` is all the page needs.
 */
export function lutPreviewUrl(
  slug: string,
  frame: LutFrame,
  side: LutPreviewSide,
  previewKey?: string | null,
): string {
  const url = `${lutPath(slug)}/preview/${frame}/${side}.jpg`;
  // The LUT's `previewKey` (first 8 of its file's sha256) lets the server cache the still for good.
  return previewKey ? `${url}?v=${encodeURIComponent(previewKey)}` : url;
}

/** What a frame of the job's preview is asked for besides its time (LU11). */
export interface ReviewFrameOptions {
  /** The job's round: a new round has a new preview, so the browser must not reuse a frame of the last. */
  round?: number;
  /** The music's `rev` (Soundtrack): the preview changes with it inside a round. */
  musicRev?: number | null;
}

/**
 * The address of a frame of a job's preview at `atSec` (to the nearest tenth of a second), for the
 * look on the paused frame in Review (LU11): with `lutSlug` it has that LUT applied, without it is the
 * plain frame (what Compare shows). The server takes the frame from the round's small preview video
 * and caches it, so an `<img src>` is all the page needs; a 404 means there is no frame to show yet.
 */
export function reviewFrameUrl(
  jobId: string,
  atSec: number,
  lutSlug?: string | null,
  options: ReviewFrameOptions = {},
  baseUrl = '',
): string {
  const t = Math.max(0, Math.round(atSec * 10) / 10);
  const query = [`t=${t}`];
  if (lutSlug) query.push(`lut=${encodeURIComponent(lutSlug)}`);
  if (options.round !== undefined) query.push(`r=${options.round}`);
  if (options.musicRev !== undefined && options.musicRev !== null)
    query.push(`m=${options.musicRev}`);
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/review/frame?${query.join('&')}`;
}

/** The multipart body of an upload: one `files[]` part per file, under its own name. */
export function lutStageForm(files: readonly File[]): FormData {
  const form = new FormData();
  for (const file of files) form.append('files[]', file, file.name);
  return form;
}

export function createLutsApi(
  options: JsonClientOptions & Pick<ApiOptions, 'createXhr'> = {},
): LutsApi {
  const { request, parse } = createJsonClient(options);
  const sendForm = createFormSender(options);

  const jsonBody = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  return {
    async listLuts(signal) {
      return parse(lutListResponseSchema, await request('/api/luts', { signal }));
    },
    async getLut(slug, signal) {
      return parse(lutDetailSchema, await request(lutPath(slug), { signal }));
    },
    async updateLut(slug, patch, signal) {
      return parse(lutDetailSchema, await request(lutPath(slug), jsonBody('PATCH', patch, signal)));
    },
    async deleteLut(slug, signal) {
      const answer = await request(lutPath(slug), { method: 'DELETE', signal });
      return parse(deleteLutResponseSchema, answer);
    },
    async duplicateLut(slug, signal) {
      const answer = await request(`${lutPath(slug)}/duplicate`, { method: 'POST', signal });
      return parse(lutDetailSchema, answer);
    },
    async revealLut(slug, signal) {
      const answer = await request(`${lutPath(slug)}/reveal`, { method: 'POST', signal });
      parse(revealLutResponseSchema, answer);
    },
    async stageLuts({ files, onProgress, signal }) {
      const answer = await sendForm('/api/luts/stage', lutStageForm(files), onProgress, signal);
      return parse(lutStageResponseSchema, answer);
    },
    async cancelStage(stageId, signal) {
      const path = `/api/luts/stage/${encodeURIComponent(stageId)}`;
      parse(cancelLutStageResponseSchema, await request(path, { method: 'DELETE', signal }));
    },
    async importStaged(importRequest, signal) {
      const answer = await request('/api/luts/import', jsonBody('POST', importRequest, signal));
      return parse(lutImportResponseSchema, answer);
    },
  };
}

/** The app's LUTs client: same origin. Hooks use this one; tests build their own. */
export const lutsApi: LutsApi = createLutsApi();
