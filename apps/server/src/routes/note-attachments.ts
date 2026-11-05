// The note view and the pictures attached to a job's note (Songs, SG5), mounted at /api/jobs next to
// the jobs routes. Only while the Songs switch is on (and Soundtrack); off, they do not exist and
// those paths answer the ordinary 404, as before Songs.
//
//   GET    /:id/note                        { note, attachments }: the note as `Job.note` has it and the
//                                           pictures attached to it, oldest first (`noteViewSchema`).
//                                           Allowed in every state: it only reads
//   POST   /:id/note/attachments            multipart/form-data, field `file`: keeps the picture in
//                                           edit/brief/from-you/ and answers 201 with it as kept
//                                           (`addNoteAttachmentResponseSchema`; its name may carry a
//                                           number when the name was taken, and a HEIC is kept as a
//                                           JPEG: "IMG_4412.HEIC" is answered as "IMG_4412.jpg")
//   DELETE /:id/note/attachments/:name      the picture is gone; 200 { ok: true }
//   GET    /:id/note/attachments/:name      the picture itself, inline (for the dialog's thumbnail
//                                           of a picture attached in an earlier opening; HEAD too).
//                                           Added by SG5 on top of the SG0 contract
//
// Answers: 404 for an unknown job (and for a picture that is not on the note); POST and DELETE 409
// "Cannot edit the note of a job that is <state>." in any state but the ones `canEditNote` allows,
// the same words the note's PUT uses; POST 400 for a body that is not a form with a `file`, a file
// that is not a picture of an allowed type, an empty one, one over `NOTE_ATTACHMENTS.maxBytes`, or a
// note that has `maxFiles` pictures already. Every error is `{ error: string }`.
//
// The rules of the folder live in pipeline/note-attachments.ts; this file is HTTP only.

import { join } from 'node:path';
import {
  addNoteAttachmentResponseSchema,
  canEditNote,
  type DeleteNoteAttachmentResponse,
  deleteNoteAttachmentResponseSchema,
  isNoteAttachmentName,
  type Job,
  NOTE_ATTACHMENTS,
  type NoteView,
  noteAttachmentType,
  noteViewSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type JobRepository, NoteNotEditableError } from '../db/index.js';
import type { HeicToJpeg } from '../pipeline/heic-to-jpeg.js';
import {
  deleteNoteAttachment,
  listNoteAttachments,
  NOTE_ATTACHMENT_MESSAGES,
  NoteAttachmentError,
  noteAttachmentOf,
  noteAttachmentPath,
  saveNoteAttachment,
} from '../pipeline/note-attachments.js';
import { serveFile } from './download.js';

export interface NoteAttachmentRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** The largest picture, in bytes. Default `NOTE_ATTACHMENTS.maxBytes`; tests pass a small one. */
  maxBytes?: number;
  /**
   * Turns a HEIC (a phone's Photos or Files app can hand one over) into the JPEG that is kept,
   * because the Brief run's Read tool cannot read HEIC. The engine passes `sipsHeicToJpeg`; left
   * out, a HEIC is kept as it came (tests).
   */
  heicToJpeg?: HeicToJpeg;
}

/** Room for the form's own boundaries and field headers, on top of the picture. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  webp: 'image/webp',
  gif: 'image/gif',
} as const satisfies Record<(typeof NOTE_ATTACHMENTS.types)[number], string>;

/**
 * The extension a picture's own type gives, for a file that arrives without one (a browser's
 * pasted image can be called just "blob"): only for the types we keep.
 */
const EXTENSION_OF_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The name to keep for an uploaded file: its own, or one with the extension its type gives. */
function uploadedName(file: File): string {
  const name = file.name === '' ? 'image' : file.name;
  const mime = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = EXTENSION_OF_TYPE[mime];
  if (extension === undefined || noteAttachmentType(name) !== null) return name;
  return `${name}.${extension}`;
}

/** Whether the file says it is something else than a picture (a PDF named like one). */
function declaresNotAPicture(file: File): boolean {
  const mime = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime !== '' && mime !== 'application/octet-stream' && !mime.startsWith('image/');
}

export function createNoteAttachmentRoutes({
  jobs,
  inboxPath,
  maxBytes = NOTE_ATTACHMENTS.maxBytes,
  heicToJpeg,
}: NoteAttachmentRouteOptions): Hono {
  const routes = new Hono();

  /** The 409 answer unless the job's note can be edited now (the words of the note's PUT). */
  function notEditable(c: Context, job: Job): Response | null {
    return canEditNote(job) ? null : c.json({ error: new NoteNotEditableError(job).message }, 409);
  }

  const unknownJob = (c: Context, id: string): Response =>
    c.json({ error: `There is no job ${id}.` }, 404);

  function failure(c: Context, err: unknown): Response {
    if (err instanceof NoteAttachmentError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  routes.get('/:id/note', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return unknownJob(c, c.req.param('id'));
    const stored = await listNoteAttachments(join(inboxPath, job.relPath));
    const view: NoteView = { note: job.note, attachments: stored.map(noteAttachmentOf) };
    return c.json(noteViewSchema.parse(view));
  });

  routes.post(
    '/:id/note/attachments',
    bodyLimit({
      maxSize: maxBytes + FORM_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: NOTE_ATTACHMENT_MESSAGES.tooBig }, 400),
    }),
    async (c) => {
      const job = jobs.get(c.req.param('id'));
      if (job === null) return unknownJob(c, c.req.param('id'));
      const refused = notEditable(c, job);
      if (refused !== null) return refused;

      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return c.json({ error: NOTE_ATTACHMENT_MESSAGES.form }, 400);
      }
      const file = form.file;
      if (!(file instanceof File)) return c.json({ error: NOTE_ATTACHMENT_MESSAGES.form }, 400);
      if (declaresNotAPicture(file)) {
        return c.json({ error: NOTE_ATTACHMENT_MESSAGES.type }, 400);
      }
      if (file.size > maxBytes) return c.json({ error: NOTE_ATTACHMENT_MESSAGES.tooBig }, 400);

      try {
        const kept = await saveNoteAttachment(
          join(inboxPath, job.relPath),
          { name: uploadedName(file), bytes: new Uint8Array(await file.arrayBuffer()) },
          heicToJpeg === undefined ? {} : { heicToJpeg },
        );
        return c.json(addNoteAttachmentResponseSchema.parse(kept), 201);
      } catch (err) {
        return failure(c, err);
      }
    },
  );

  routes.delete('/:id/note/attachments/:name', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return unknownJob(c, c.req.param('id'));
    const refused = notEditable(c, job);
    if (refused !== null) return refused;
    try {
      await deleteNoteAttachment(join(inboxPath, job.relPath), c.req.param('name'));
      const done: DeleteNoteAttachmentResponse = { ok: true };
      return c.json(deleteNoteAttachmentResponseSchema.parse(done));
    } catch (err) {
      return failure(c, err);
    }
  });

  // Hono answers HEAD with this GET handler; serveFile then sends the headers only.
  routes.get('/:id/note/attachments/:name', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return unknownJob(c, c.req.param('id'));
    const name = c.req.param('name');
    const path = await noteAttachmentPath(join(inboxPath, job.relPath), name);
    const type = noteAttachmentType(name);
    if (path === null || type === null || !isNoteAttachmentName(name)) {
      return c.json({ error: NOTE_ATTACHMENT_MESSAGES.missing }, 404);
    }
    const response = await serveFile(c, {
      path,
      contentType: CONTENT_TYPES[type],
      disposition: 'inline',
      missingMessage: NOTE_ATTACHMENT_MESSAGES.missing,
      cache: 'revalidate',
    });
    // The bytes are whatever was uploaded under a picture's name: never let a browser guess.
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  });

  return routes;
}
