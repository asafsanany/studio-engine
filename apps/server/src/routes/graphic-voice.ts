// The composer's voice note (Graphics plan, "Studio" › Composer), mounted at /api/graphics while
// the Graphics switch is on:
//
//   POST /voice    multipart/form-data { audio }: audio/webm or audio/mp4, at most 25 MB (the
//                  review voice notes' types and limit) → 200 { text } (graphicVoiceResponseSchema)
//
// The audio goes to <data>/graphic-voice/<uuid>/voice.webm (or .m4a); the route waits for
// transcriber.enqueue (the engine's one transcriber, shared with the review notes: the same queue,
// 2 at a time, 2 minutes each at most), answers the text, and deletes the recording and its
// transcript, whatever came out. Nothing is kept: the text lands in the composer and is sent (or
// not) with the message. Refusals, each one plain sentence from GRAPHIC_MESSAGES and `{ error }`:
// badRecording (400: not a recording, empty or unreadable), recordingTooLarge (413), noSpeech (422)
// and voiceFailed (500: the transcriber failed, or the file could not be written).

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GRAPHIC_MESSAGES,
  VOICE_NOTE_MAX_BYTES,
  type VoiceNoteType,
  voiceNoteType,
} from '@studio/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { TranscriptionError, type VoiceTranscriber } from '../pipeline/voice-transcriber.js';

export interface GraphicVoiceRouteOptions {
  /** The engine's one voice transcriber (the review notes' too). */
  transcriber: VoiceTranscriber;
  /** For <data>/graphic-voice/. */
  dataDir: string;
  /** The largest recording, in bytes. Default VOICE_NOTE_MAX_BYTES; tests pass a small one. */
  voiceMaxBytes?: number;
  /** Told after each recording that was typed out, so the engine can log its usage (`transcribe`). */
  onTranscribed?: () => void;
}

/** The folder name inside the data folder where recordings wait for the transcriber. */
export const GRAPHIC_VOICE_DIR_NAME = 'graphic-voice';

/** Room for the form's boundaries on top of the recording. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const FILE_NAMES: Readonly<Record<VoiceNoteType, string>> = {
  'audio/webm': 'voice.webm',
  'audio/mp4': 'voice.m4a',
};

/** The error and status of a refusal. */
class VoiceRefusal extends Error {
  readonly status: 400 | 413 | 422 | 500;

  constructor(status: 400 | 413 | 422 | 500, message: string) {
    super(message);
    this.status = status;
  }
}

/** The audio of the form, or the 400 it breaks. */
async function audioOf(request: Request): Promise<File> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new VoiceRefusal(400, GRAPHIC_MESSAGES.badRecording);
  }
  const audio = form.get('audio');
  if (!(audio instanceof File)) throw new VoiceRefusal(400, GRAPHIC_MESSAGES.badRecording);
  return audio;
}

/** The voice note route. */
export function createGraphicVoiceRoutes({
  transcriber,
  dataDir,
  voiceMaxBytes = VOICE_NOTE_MAX_BYTES,
  onTranscribed,
}: GraphicVoiceRouteOptions): Hono {
  const routes = new Hono();

  routes.post(
    '/voice',
    bodyLimit({
      maxSize: voiceMaxBytes + FORM_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: GRAPHIC_MESSAGES.recordingTooLarge }, 413),
    }),
    async (c) => {
      let workDir: string | null = null;
      try {
        const audio = await audioOf(c.req.raw);
        const type = voiceNoteType(audio.type);
        if (type === null || audio.size === 0) {
          throw new VoiceRefusal(400, GRAPHIC_MESSAGES.badRecording);
        }
        if (audio.size > voiceMaxBytes) {
          throw new VoiceRefusal(413, GRAPHIC_MESSAGES.recordingTooLarge);
        }

        // One folder per recording: the transcript the helper writes goes next to it, and both
        // go with the folder.
        const dir = join(dataDir, GRAPHIC_VOICE_DIR_NAME, randomUUID());
        workDir = dir;
        const audioPath = join(dir, FILE_NAMES[type]);
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(audioPath, new Uint8Array(await audio.arrayBuffer()));
        } catch {
          throw new VoiceRefusal(500, GRAPHIC_MESSAGES.voiceFailed);
        }

        // No language: Scribe's auto-detect is as good as a forced one and keeps Hebrew and
        // English notes both right.
        const { text } = await transcriber.enqueue({ audioPath, outDir: dir });
        if (text.trim() === '') throw new VoiceRefusal(422, GRAPHIC_MESSAGES.noSpeech);
        try {
          onTranscribed?.();
        } catch {
          // The usage line is a courtesy: it never fails the note.
        }
        return c.json({ text });
      } catch (err) {
        if (err instanceof VoiceRefusal) return c.json({ error: err.message }, err.status);
        if (err instanceof TranscriptionError) {
          return err.code === 'no_speech'
            ? c.json({ error: GRAPHIC_MESSAGES.noSpeech }, 422)
            : c.json({ error: GRAPHIC_MESSAGES.voiceFailed }, 500);
        }
        return c.json({ error: GRAPHIC_MESSAGES.voiceFailed }, 500);
      } finally {
        if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  return routes;
}
