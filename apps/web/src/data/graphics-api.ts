// Typed wrappers for the graphics API (Graphics plan, "API"), one per route, built like
// series-api.ts: every answer is parsed with the shared schemas, and every failure is an `ApiError`
// carrying the server's words (GRAPHIC_MESSAGES). A message with files goes as multipart through an
// XMLHttpRequest, like a style upload, so its progress can be shown and it has no time limit. While
// the Graphics switch is off every route answers 404 "Graphics are off."; the pages ask
// `useGraphicsEnabled` first and ask nothing then.

import {
  type DeleteGraphicResponse,
  deleteGraphicResponseSchema,
  type Effort,
  type GraphicDetail,
  type GraphicListResponse,
  graphicDetailSchema,
  graphicListResponseSchema,
  graphicVoiceResponseSchema,
  revealGraphicResponseSchema,
  type UpdateGraphicRequest,
  voiceNoteType,
} from '@studio/shared';
import { type ApiOptions, createFormSender, createJsonClient, type JsonClientOptions } from './api';

/** One message the owner sends: the text, the effort picked next to Send and the attached files. */
export interface GraphicSend {
  text: string;
  /** `null`: the default (Extra high); nothing is sent. */
  effort: Effort | null;
  files: readonly File[];
  /** Told the share of the bytes sent so far (0 to 100). */
  onProgress?: (percent: number) => void;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * How long a voice note may take, upload and transcription together: the route answers once the
 * transcriber has typed it out (2 minutes at most, after any note waiting before it).
 */
export const GRAPHIC_VOICE_TIMEOUT_MS = 180_000;

export interface GraphicsApi {
  /** `GET /api/graphics`: the graphics that are not empty, newest change first. */
  listGraphics(signal?: AbortSignal): Promise<GraphicListResponse>;
  /** `GET /api/graphics/:id`: one graphic with its chat. 404 for one that is unknown or deleted. */
  getGraphic(id: string, signal?: AbortSignal): Promise<GraphicDetail>;
  /** `POST /api/graphics`: a new graphic from the owner's first message; v1 is being made. */
  createGraphic(send: GraphicSend): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/messages`: a change; the next version is being made. 409 while making. */
  sendMessage(id: string, send: GraphicSend): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/messages/:mid/stop`: Stop. */
  stopMessage(id: string, messageId: string, signal?: AbortSignal): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/messages/:mid/retry`: Retry of a failed or stopped run. */
  retryMessage(id: string, messageId: string, signal?: AbortSignal): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/versions/:n/restore`: "Use vN again". */
  restoreVersion(id: string, version: number, signal?: AbortSignal): Promise<GraphicDetail>;
  /** `PUT /api/graphics/:id`: rename, the When line, "Edits can use it". */
  updateGraphic(
    id: string,
    patch: UpdateGraphicRequest,
    signal?: AbortSignal,
  ): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/duplicate`: answers the copy. */
  duplicateGraphic(id: string, signal?: AbortSignal): Promise<GraphicDetail>;
  /** `POST /api/graphics/:id/reveal`: Finder shows the graphic's folder. */
  revealGraphic(id: string, signal?: AbortSignal): Promise<void>;
  /** `DELETE /api/graphics/:id`: answers where the folder went. */
  deleteGraphic(id: string, signal?: AbortSignal): Promise<DeleteGraphicResponse>;
  /** `POST /api/graphics/voice`: a recording, typed out. */
  transcribeVoice(audio: Blob, signal?: AbortSignal): Promise<string>;
}

function graphicPath(id: string): string {
  return `/api/graphics/${encodeURIComponent(id)}`;
}

function messagePath(id: string, messageId: string): string {
  return `${graphicPath(id)}/messages/${encodeURIComponent(messageId)}`;
}

/** The multipart body of a message: `text`, `effort` (only when picked) and `files[]`. */
export function graphicMessageForm(send: Pick<GraphicSend, 'text' | 'effort' | 'files'>): FormData {
  const form = new FormData();
  form.append('text', send.text);
  if (send.effort !== null) form.append('effort', send.effort);
  for (const file of send.files) form.append('files[]', file, file.name);
  return form;
}

export function createGraphicsApi(
  options: JsonClientOptions & Pick<ApiOptions, 'createXhr'> = {},
): GraphicsApi {
  const { request, parse } = createJsonClient(options);
  const sendForm = createFormSender(options);

  const post = async (path: string, signal?: AbortSignal) =>
    parse(graphicDetailSchema, await request(path, { method: 'POST', signal }));

  return {
    async listGraphics(signal) {
      return parse(graphicListResponseSchema, await request('/api/graphics', { signal }));
    },
    async getGraphic(id, signal) {
      return parse(graphicDetailSchema, await request(graphicPath(id), { signal }));
    },
    async createGraphic(send) {
      const answer = await sendForm(
        '/api/graphics',
        graphicMessageForm(send),
        send.onProgress,
        send.signal,
      );
      return parse(graphicDetailSchema, answer);
    },
    async sendMessage(id, send) {
      const answer = await sendForm(
        `${graphicPath(id)}/messages`,
        graphicMessageForm(send),
        send.onProgress,
        send.signal,
      );
      return parse(graphicDetailSchema, answer);
    },
    stopMessage: (id, messageId, signal) => post(`${messagePath(id, messageId)}/stop`, signal),
    retryMessage: (id, messageId, signal) => post(`${messagePath(id, messageId)}/retry`, signal),
    restoreVersion: (id, version, signal) =>
      post(`${graphicPath(id)}/versions/${version}/restore`, signal),
    async updateGraphic(id, patch, signal) {
      const init: RequestInit = {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        signal,
      };
      return parse(graphicDetailSchema, await request(graphicPath(id), init));
    },
    duplicateGraphic: (id, signal) => post(`${graphicPath(id)}/duplicate`, signal),
    async revealGraphic(id, signal) {
      const answer = await request(`${graphicPath(id)}/reveal`, { method: 'POST', signal });
      parse(revealGraphicResponseSchema, answer);
    },
    async deleteGraphic(id, signal) {
      const answer = await request(graphicPath(id), { method: 'DELETE', signal });
      return parse(deleteGraphicResponseSchema, answer);
    },
    async transcribeVoice(audio, signal) {
      const form = new FormData();
      const file = voiceNoteType(audio.type) === 'audio/mp4' ? 'voice.m4a' : 'voice.webm';
      form.append('audio', audio, file);
      // No content-type: fetch adds multipart/form-data with its boundary.
      const init: RequestInit = { method: 'POST', body: form, signal };
      const answer = await request('/api/graphics/voice', init, GRAPHIC_VOICE_TIMEOUT_MS);
      return parse(graphicVoiceResponseSchema, answer).text;
    },
  };
}

/** The app's graphics client: same origin. Hooks use this one; tests build their own. */
export const graphicsApi: GraphicsApi = createGraphicsApi();
