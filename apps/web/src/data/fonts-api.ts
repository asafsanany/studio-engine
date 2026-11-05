// Typed wrappers for the Fonts API (Fonts plan, "API"), one per route, built like luts-api.ts:
// every answer is parsed with the shared schemas, and every failure is an `ApiError` carrying the
// server's words (FONT_MESSAGES). The files of an import go as multipart through an XMLHttpRequest,
// like a style upload, so their progress can be shown and there is no time limit. While the Fonts
// switch is off every route answers 404 "Fonts are off."; the pages ask `useFontsEnabled` first and
// ask nothing then.

import {
  cancelFontStageResponseSchema,
  type DeleteFontResponse,
  deleteFontResponseSchema,
  dismissFontRequestResponseSchema,
  FONT_STAGE_FIELD,
  type FontFamilyDetail,
  type FontImportRequest,
  type FontImportResponse,
  type FontStageResponse,
  type FontsListResponse,
  fontFamilyDetailSchema,
  fontImportResponseSchema,
  fontStageResponseSchema,
  fontsListResponseSchema,
  revealFontResponseSchema,
} from '@studio/shared';
import { type ApiOptions, createFormSender, createJsonClient, type JsonClientOptions } from './api';

/** The files of one import step 1, with the upload's progress and its cancel. */
export interface FontStageSend {
  files: readonly File[];
  /** Told the share of the bytes sent so far (0 to 100). */
  onProgress?: (percent: number) => void;
  /** Aborts the request. */
  signal?: AbortSignal;
}

export interface FontsApi {
  /** `GET /api/fonts`: every family A to Z, every face (the catalog) and the open requests. */
  listFonts(signal?: AbortSignal): Promise<FontsListResponse>;
  /** `GET /api/fonts/:slug`: one family with everything its pane shows. 404 for an unknown one. */
  getFont(slug: string, signal?: AbortSignal): Promise<FontFamilyDetail>;
  /** `POST /api/fonts/:slug/reveal`: Finder shows the family's folder. */
  revealFont(slug: string, signal?: AbortSignal): Promise<void>;
  /** `DELETE /api/fonts/:slug`: the whole family to the Trash; answers where the files went. */
  deleteFont(slug: string, signal?: AbortSignal): Promise<DeleteFontResponse>;
  /** `DELETE /api/fonts/requests/:id`: "Not a font", the bar's request dismissed (C52). */
  dismissRequest(requestId: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/fonts/stage`: import step 1, the files checked and grouped by family. */
  stageFonts(send: FontStageSend): Promise<FontStageResponse>;
  /** `DELETE /api/fonts/stage/:stageId`: throws an upload away. */
  cancelStage(stageId: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/fonts/import`: import step 3, the chosen items copied into `_Fonts`. */
  importStaged(request: FontImportRequest, signal?: AbortSignal): Promise<FontImportResponse>;
}

function fontPath(slug: string): string {
  return `/api/fonts/${encodeURIComponent(slug)}`;
}

/**
 * The address of a font file: what a specimen's `@font-face` points at. `fileId` is a face's
 * `fileId`; `version` (the file's modified time, when the page has it) goes in as `?v=` so the
 * server lets the browser keep the file for good and a replaced file is asked for again.
 */
export function fontFileUrl(fileId: string, version?: string | number | null): string {
  const url = `/api/fonts/file/${encodeURIComponent(fileId)}`;
  return version === undefined || version === null
    ? url
    : `${url}?v=${encodeURIComponent(version)}`;
}

/**
 * The multipart body of an upload: one `files[]` part per file. A file picked from a folder is
 * sent under its path inside that folder (`Heebo/Heebo-Bold.ttf`), which the server uses only to
 * group and for the verdict; any other file under its own name.
 */
export function fontStageForm(files: readonly File[]): FormData {
  const form = new FormData();
  for (const file of files) {
    // `webkitRelativePath` is '' for a file that was not picked from a folder (and absent in a
    // test environment that has none).
    const name = file.webkitRelativePath ? file.webkitRelativePath : file.name;
    form.append(FONT_STAGE_FIELD, file, name);
  }
  return form;
}

export function createFontsApi(
  options: JsonClientOptions & Pick<ApiOptions, 'createXhr'> = {},
): FontsApi {
  const { request, parse } = createJsonClient(options);
  const sendForm = createFormSender(options);

  return {
    async listFonts(signal) {
      return parse(fontsListResponseSchema, await request('/api/fonts', { signal }));
    },
    async getFont(slug, signal) {
      return parse(fontFamilyDetailSchema, await request(fontPath(slug), { signal }));
    },
    async revealFont(slug, signal) {
      const answer = await request(`${fontPath(slug)}/reveal`, { method: 'POST', signal });
      parse(revealFontResponseSchema, answer);
    },
    async deleteFont(slug, signal) {
      const answer = await request(fontPath(slug), { method: 'DELETE', signal });
      return parse(deleteFontResponseSchema, answer);
    },
    async dismissRequest(requestId, signal) {
      const path = `/api/fonts/requests/${encodeURIComponent(requestId)}`;
      const answer = await request(path, { method: 'DELETE', signal });
      parse(dismissFontRequestResponseSchema, answer);
    },
    async stageFonts({ files, onProgress, signal }) {
      const answer = await sendForm('/api/fonts/stage', fontStageForm(files), onProgress, signal);
      return parse(fontStageResponseSchema, answer);
    },
    async cancelStage(stageId, signal) {
      const path = `/api/fonts/stage/${encodeURIComponent(stageId)}`;
      const answer = await request(path, { method: 'DELETE', signal });
      parse(cancelFontStageResponseSchema, answer);
    },
    async importStaged(importRequest, signal) {
      const answer = await request('/api/fonts/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importRequest),
        signal,
      });
      return parse(fontImportResponseSchema, answer);
    },
  };
}

/** The app's Fonts client: same origin. Hooks use this one; tests build their own. */
export const fontsApi: FontsApi = createFontsApi();
