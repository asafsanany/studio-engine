import { z } from 'zod';
import { formatIdSchema } from './formats.ts';
import { isoTimestampSchema } from './job.ts';
import { noteRouteSchema, noteRouteStatusSchema } from './quick-fixes.ts';

/** A review note is typed (`text`) or recorded (`voice`). */
export const REVIEW_NOTE_KINDS = ['text', 'voice'] as const;
export const reviewNoteKindSchema = z.enum(REVIEW_NOTE_KINDS);
export type ReviewNoteKind = z.infer<typeof reviewNoteKindSchema>;

/** Where a voice note's transcript stands. A text note has none (`null`). */
export const TRANSCRIPT_STATUSES = ['pending', 'done', 'failed'] as const;
export const transcriptStatusSchema = z.enum(TRANSCRIPT_STATUSES);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

/** The longest text note once trimmed, in UTF-16 code units (like NOTE_MAX_LENGTH and an HTML maxlength). */
export const REVIEW_NOTE_MAX_LENGTH = 2000;
/** What the browsers record: Chrome's MediaRecorder (webm/Opus) and Safari's (mp4/AAC). */
export const VOICE_NOTE_TYPES = ['audio/webm', 'audio/mp4'] as const;
export type VoiceNoteType = (typeof VOICE_NOTE_TYPES)[number];
/** The largest voice-note recording the engine takes: 25 MB. */
export const VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024;
/** The longest voice note: the browser stops recording at 5 minutes. */
export const VOICE_NOTE_MAX_SEC = 300;

/** The voice-note type of a Content-Type or Blob type ("audio/webm;codecs=opus" is "audio/webm"), or null. */
export function voiceNoteType(contentType: string): VoiceNoteType | null {
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return (VOICE_NOTE_TYPES as readonly string[]).includes(base) ? (base as VoiceNoteType) : null;
}

/**
 * One review note, as the server sends it (Phase 3 §6). Pinned to a moment of the live preview.
 * Unsent while `round` is null; Send stamps the round. Satisfies W16's ReviewNoteForFile as it is.
 */
export const reviewNoteSchema = z.object({
  /** A uuid. A voice note's audio file is named after it. */
  id: z.string().min(1),
  jobId: z.string().min(1),
  /** The round it was sent in; `null` while it is unsent. */
  round: z.number().int().positive().nullable(),
  /** Where it is pinned on the preview's timeline, in seconds. */
  atSec: z.number().nonnegative(),
  kind: reviewNoteKindSchema,
  /** A text note's body (trimmed), or a voice note's transcript once it is done; else null. */
  text: z.string().min(1).nullable(),
  /** A voice note's recording, relative to the job folder: `edit/review/voice/<id>.webm` or `.m4a`. */
  audioFile: z.string().min(1).nullable(),
  /** A voice note's length in seconds. */
  audioSec: z.number().positive().nullable(),
  /** A voice note's transcript: pending, done or failed. `null` for a text note. */
  transcriptStatus: transcriptStatusSchema.nullable(),
  /** "Add to style": on Send it also goes into the client's style (W7). */
  addToStyle: z.boolean(),
  /** "Series", on an episode: on Send it also goes into the job's series (Series plan §6). */
  addToSeries: z.boolean(),
  createdAt: isoTimestampSchema,
  /** When it was sent; `null` while it is unsent. */
  sentAt: isoTimestampSchema.nullable(),
  /**
   * Quick fixes (QF0): where Auto's sorting of this note stands, `pending` while the router reads
   * it and `routed` once it has answered; `null` for a note Auto never read (Auto was off, or the
   * note is from before quick fixes).
   */
  routeStatus: noteRouteStatusSchema.nullable(),
  /** The router's answer once `routeStatus` is `routed`: its tier, what it asks for, and why it waits for Send. */
  route: noteRouteSchema.nullable(),
  /**
   * The format of the preview the note was written on (Generated videos, GN8): the `id` of one of
   * the job's `formats` ("1x1") for a note written on an extra format. `null` for the main format
   * and for every job with one format. Left out by a note from before formats, which reads the same
   * (`note.format ?? null`); the engine always sends it.
   */
  format: formatIdSchema.nullable().optional(),
  /** The quick fix made for this note (`QuickFix.id`); `null` for a note with none. */
  fixId: z.string().min(1).nullable(),
  /** When that fix was made and the preview changed; `null` until then (and again after Undo). */
  fixedAt: isoTimestampSchema.nullable(),
});
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
