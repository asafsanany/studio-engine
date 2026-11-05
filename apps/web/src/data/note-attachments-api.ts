// Typed fetch wrappers for the note's pictures (Songs, SG5), one per route, built like api.ts's:
// every answer is parsed with the shared schemas, and every failure is an `ApiError` carrying the
// server's words (a 400 says what is wrong with the picture, a 409 that the job started editing).
// While the Songs switch is off there are no such routes (404); the dialog asks `useSongsEnabled`
// first and shows nothing of pictures then.
//
// The upload and the delete are the same for the Mac dialog and for the phone's Add photo (SG6):
// both go through `features/jobs/note-attachments.ts`, which owns the state of an opening.

import {
  addNoteAttachmentResponseSchema,
  deleteNoteAttachmentResponseSchema,
  type NoteAttachment,
  type NoteView,
  noteViewSchema,
} from '@studio/shared';
import { createJsonClient, type JsonClientOptions, UPLOAD_TIMEOUT_MS } from './api';

export interface NoteAttachmentsApi {
  /**
   * `GET /api/jobs/:id/note`: the note and the pictures attached to it, oldest first. Rejects with
   * an `ApiError`: 404 for an unknown job or while Songs is off (no such route).
   */
  getNoteView(jobId: string, signal?: AbortSignal): Promise<NoteView>;
  /**
   * `POST /api/jobs/:id/note/attachments`: keeps `file` (a picture) on the job's note and answers
   * it as kept (its `name` is the one to use afterwards; a name that was taken gets a number).
   * Rejects with an `ApiError`: 400 (not a picture of an allowed type, empty, over 15 MB, or the
   * note has six already), 404, 409 once the job is editing.
   */
  addNoteAttachment(
    jobId: string,
    file: Blob,
    name: string,
    signal?: AbortSignal,
  ): Promise<NoteAttachment>;
  /**
   * `DELETE /api/jobs/:id/note/attachments/:name`: takes the picture off the note. 404 for one
   * that is not there, 409 once the job is editing.
   */
  deleteNoteAttachment(jobId: string, name: string, signal?: AbortSignal): Promise<void>;
}

function attachmentsPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/note/attachments`;
}

/**
 * Where a picture of the note is served from (`GET`, inline): the source of the dialog's thumbnail
 * for a picture attached in an earlier opening. `baseUrl` is only for tests.
 */
export function noteAttachmentUrl(jobId: string, name: string, baseUrl = ''): string {
  return `${baseUrl}${attachmentsPath(jobId)}/${encodeURIComponent(name)}`;
}

export function createNoteAttachmentsApi(
  options: JsonClientOptions & { uploadTimeoutMs?: number } = {},
): NoteAttachmentsApi {
  const { uploadTimeoutMs = UPLOAD_TIMEOUT_MS, ...client } = options;
  const { request, parse } = createJsonClient(client);

  return {
    async getNoteView(jobId, signal) {
      const path = `/api/jobs/${encodeURIComponent(jobId)}/note`;
      return parse(noteViewSchema, await request(path, { signal }));
    },
    async addNoteAttachment(jobId, file, name, signal) {
      const form = new FormData();
      form.append('file', file, name);
      // No content-type: fetch adds multipart/form-data with its boundary.
      const init: RequestInit = { method: 'POST', body: form, signal };
      return parse(
        addNoteAttachmentResponseSchema,
        await request(attachmentsPath(jobId), init, uploadTimeoutMs),
      );
    },
    async deleteNoteAttachment(jobId, name, signal) {
      const path = `${attachmentsPath(jobId)}/${encodeURIComponent(name)}`;
      parse(deleteNoteAttachmentResponseSchema, await request(path, { method: 'DELETE', signal }));
    },
  };
}

/** The app's client: same origin. The dialog uses this one; tests build their own. */
export const noteAttachmentsApi: NoteAttachmentsApi = createNoteAttachmentsApi();
