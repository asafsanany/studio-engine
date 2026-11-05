// The review notes API (Phase 3 · W5), mounted at /api/jobs next to the jobs routes:
//
//   GET    /:id/notes                 the job's unsent notes, by atSec
//   POST   /:id/notes                 body { atSec, text, format? }: a text note (trimmed, 1-2000
//                                     characters); 201 with the note. `format` (Generated videos) is
//                                     the id of the job's format it was written on ("1x1"); left out
//                                     or the main one, it is stored as null; a format the job does not
//                                     have is 400
//   POST   /:id/notes/voice           multipart/form-data { audio, atSec, audioSec, format? }: audio/webm or
//                                     audio/mp4, at most 25 MB and 5 minutes; saved under
//                                     edit/review/voice/ and transcribed by itself; 201 with the note
//                                     (transcriptStatus pending), the transcript follows as note.upsert
//   PATCH  /:id/notes/:noteId         body { text?, addToStyle?, addToSeries? }: the note changed (text
//                                     only for a typed note; addToSeries: true only on a job in a
//                                     series, while series are on, else 422); 200 with the note
//   DELETE /:id/notes/:noteId         the note, its recording and its transcript removed; 200 { ok: true }
//   GET    /:id/notes/:noteId/audio   the recording, inline, with byte ranges (HEAD too)
//
// Every route answers 404 for an unknown job, then 409 "Notes can only be changed while the job is
// in Review." in any state but review, then 400 for a body it cannot use, then 404 for an unknown
// note (one that is sent already is unknown too). The one answer that comes earlier is the voice
// route's 413 for a body over the limit. The one 422 is the PATCH that marks a note Series (the
// job is in no series, or series are off). Every error is `{ error: string }`.
//
// The rules live in the review service (review/review-service.ts); this file is HTTP only.

import {
  addNoteRequestSchema,
  formatIdSchema,
  patchNoteRequestSchema,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_MAX_SEC,
  voiceNoteType,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { JobNotFoundError } from '../db/index.js';
import { REVIEW_MESSAGES, ReviewError, type ReviewService } from '../review/review-service.js';
import { serveFile } from './download.js';

export interface NotesRouteOptions {
  review: ReviewService;
  /** The largest recording, in bytes. Default VOICE_NOTE_MAX_BYTES; tests pass a small one. */
  voiceMaxBytes?: number;
}

/** Room for the form's other fields and its boundaries, on top of the recording. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** The recorder's own timer can run a little past the limit: one second of slack. */
const VOICE_SLACK_SEC = 1;

const seconds = z.string().trim().min(1).transform(Number);
const voiceFormSchema = z.object({
  audio: z.instanceof(File),
  atSec: seconds.pipe(z.number().nonnegative()),
  audioSec: seconds.pipe(z.number().positive()),
  /** Generated videos: the id of the format the note was recorded on ("1x1"); left out, the main one. */
  format: formatIdSchema.optional(),
});

/** The JSON answer for a failure the rules know; anything else is rethrown (app.ts answers 500). */
function failure(c: Context, err: unknown): Response {
  if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
  throw err;
}

/** The JSON body of the request, or the 400 with `message` when it is not JSON. */
async function jsonBody(c: Context, message: string): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ReviewError(400, message);
  }
}

export function createNotesRoutes({
  review,
  voiceMaxBytes = VOICE_NOTE_MAX_BYTES,
}: NotesRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/notes', (c) => {
    try {
      return c.json(review.listNotes(c.req.param('id')));
    } catch (err) {
      return failure(c, err);
    }
  });

  routes.post('/:id/notes', async (c) => {
    const id = c.req.param('id');
    try {
      review.requireReview(id);
      const parsed = addNoteRequestSchema.safeParse(await jsonBody(c, REVIEW_MESSAGES.noteBody));
      if (!parsed.success) throw new ReviewError(400, REVIEW_MESSAGES.noteBody);
      return c.json(review.addTextNote(id, parsed.data), 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  routes.post(
    '/:id/notes/voice',
    bodyLimit({
      maxSize: voiceMaxBytes + FORM_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: REVIEW_MESSAGES.voiceTooLarge }, 413),
    }),
    async (c) => {
      const id = c.req.param('id');
      try {
        review.requireReview(id);
        let form: unknown;
        try {
          form = await c.req.parseBody();
        } catch {
          throw new ReviewError(400, REVIEW_MESSAGES.voiceForm);
        }
        const parsed = voiceFormSchema.safeParse(form);
        if (!parsed.success) throw new ReviewError(400, REVIEW_MESSAGES.voiceForm);
        const { audio, atSec, audioSec, format } = parsed.data;

        const type = voiceNoteType(audio.type);
        if (type === null) throw new ReviewError(400, REVIEW_MESSAGES.voiceType);
        if (audio.size === 0) throw new ReviewError(400, REVIEW_MESSAGES.voiceEmpty);
        if (audio.size > voiceMaxBytes) throw new ReviewError(413, REVIEW_MESSAGES.voiceTooLarge);
        if (audioSec > VOICE_NOTE_MAX_SEC + VOICE_SLACK_SEC) {
          throw new ReviewError(400, REVIEW_MESSAGES.voiceTooLong);
        }

        const note = await review.addVoiceNote(id, {
          audio: new Uint8Array(await audio.arrayBuffer()),
          type,
          atSec,
          audioSec,
          ...(format === undefined ? {} : { format }),
        });
        return c.json(note, 201);
      } catch (err) {
        return failure(c, err);
      }
    },
  );

  routes.patch('/:id/notes/:noteId', async (c) => {
    const id = c.req.param('id');
    try {
      review.requireReview(id);
      const parsed = patchNoteRequestSchema.safeParse(await jsonBody(c, REVIEW_MESSAGES.patchBody));
      if (!parsed.success) throw new ReviewError(400, REVIEW_MESSAGES.patchBody);
      return c.json(review.updateNote(id, c.req.param('noteId'), parsed.data));
    } catch (err) {
      return failure(c, err);
    }
  });

  routes.delete('/:id/notes/:noteId', async (c) => {
    try {
      await review.deleteNote(c.req.param('id'), c.req.param('noteId'));
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  // Hono answers HEAD with this GET handler; serveFile then sends the headers only.
  routes.get('/:id/notes/:noteId/audio', async (c) => {
    let audio: Awaited<ReturnType<ReviewService['noteAudio']>>;
    try {
      audio = await review.noteAudio(c.req.param('id'), c.req.param('noteId'));
    } catch (err) {
      return failure(c, err);
    }
    return serveFile(c, {
      path: audio.path,
      contentType: audio.contentType,
      disposition: 'inline',
      missingMessage: REVIEW_MESSAGES.audioMissing,
      cache: 'revalidate',
    });
  });

  return routes;
}
