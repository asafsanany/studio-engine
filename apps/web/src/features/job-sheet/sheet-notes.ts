import {
  canEditNote,
  type Effort,
  effortLabel,
  type Job,
  type JobFormat,
  type ReviewNote,
  runEffort,
  type TimeInput,
} from '@studio/shared';
import { compareNotes } from '@/data/notes-cache';
import { noteFormatLabel } from '@/features/review/formats/format-logic';
import { noteTime } from '@/features/review/notes-logic';
import { NOTES_TEXT as REVIEW_NOTES_TEXT, VOICE_TEXT } from '@/features/review/review-text';
import { historyTime } from './sheet-details';

// The rules of the job sheet's "Notes" part (JobSheetNotes). No React, no network: tested on plain
// values.

/** The words of the part (canvas, page "Job sheet", board JSSheet); the voice words are Review's. */
export const SHEET_NOTES_TEXT = {
  heading: 'Notes',
  forTheEditor: 'For the editor',
  noNote: 'No note',
  add: 'Add',
  edit: 'Edit',
  effort: 'Effort',
  change: 'Change',
  /** Where "Change" was: the edit has started, so the level is the one the run uses. */
  usedForThisRun: 'used for this run',
  voiceNote: REVIEW_NOTES_TEXT.voiceTag,
  transcribing: VOICE_TEXT.transcribing,
  noTranscript: 'No transcript',
  style: 'Style',
  series: 'Series',
} as const;

// --- the note for the editor --------------------------------------------------------------------

export interface NoteRow {
  /** The note, or `null` for "No note". */
  text: string | null;
  /** The button: "Add" until the job has a note, then "Edit". */
  action: typeof SHEET_NOTES_TEXT.add | typeof SHEET_NOTES_TEXT.edit;
  /** The note dialog can open: exactly when the row's "Add note…" / "Edit note…" is on. */
  canChange: boolean;
}

/** What the note row says and whether its button works (the row menu's rule, `canEditNote`). */
export function noteRow(job: Pick<Job, 'note' | 'state'>): NoteRow {
  const hasNote = job.note !== null;
  return {
    text: job.note,
    action: hasNote ? SHEET_NOTES_TEXT.edit : SHEET_NOTES_TEXT.add,
    canChange: canEditNote(job),
  };
}

// --- effort -------------------------------------------------------------------------------------

/**
 * The level the effort row names. A job on Default says the level it runs at ("Extra high"), as
 * the boards do; the list behind "Change" still has Default checked, with that level as its hint.
 */
export function effortValue(effort: Effort | null): string {
  return effortLabel(runEffort(effort));
}

// --- the notes that were sent -------------------------------------------------------------------

/** A voice note's transcript, as the sheet says it. */
export type SentTranscript =
  | { kind: 'text'; text: string }
  /** "Transcribing…" */
  | { kind: 'pending' }
  /** "No transcript": it failed, or there was nothing to write down. */
  | { kind: 'none' };

export interface SentNote {
  id: string;
  /** Where it is pinned in the video, m:ss ("0:04"). */
  time: string;
  /** The format it was written on, printed after the time as Review does ("1:1"); left out on the main format and on a job with one. */
  formatLabel?: string;
  /** A typed note's words; `null` for a voice note (its words are the transcript). */
  text: string | null;
  /** Only a voice note has this: "Voice note · 0:07" ("Voice note" when its length is not known). */
  voice: { label: string; transcript: SentTranscript } | null;
  /** The small tags: "Style" when it also went into the client's style, "Series" into the series. */
  marks: string[];
}

export interface SentRound {
  round: number;
  /** "Your notes in round 1 · sent 12:10", or "· sent 21 Oct" for a round sent on an earlier day. */
  title: string;
  notes: SentNote[];
}

/**
 * "Your notes in round 2 · sent 12:10" (without the time when `sentAt` is not a time). The time is
 * the History part's: the clock time for a round sent today, the day ("21 Oct") for any earlier
 * one, so the two parts name the same moment the same way (`historyTime`, in `timeZone` or this
 * machine's).
 */
export function roundTitle(
  round: number,
  sentAt: string,
  now: TimeInput,
  timeZone?: string,
): string {
  const time = historyTime(sentAt, now, timeZone);
  return `Your notes in round ${round}${time === '' ? '' : ` · sent ${time}`}`;
}

function transcriptOf(note: ReviewNote): SentTranscript {
  switch (note.transcriptStatus) {
    case 'pending':
      return { kind: 'pending' };
    case 'failed':
      return { kind: 'none' };
    default:
      // 'done' (and a voice note that somehow has no status): the words, if there are any.
      return note.text !== null && note.text.trim() !== ''
        ? { kind: 'text', text: note.text }
        : { kind: 'none' };
  }
}

function sentNote(note: ReviewNote, formats: readonly JobFormat[] | undefined): SentNote {
  const marks: string[] = [];
  if (note.addToStyle) marks.push(SHEET_NOTES_TEXT.style);
  if (note.addToSeries) marks.push(SHEET_NOTES_TEXT.series);
  const isVoice = note.kind === 'voice';
  const formatLabel = formats === undefined ? null : noteFormatLabel(note, formats);
  return {
    id: note.id,
    time: noteTime(note.atSec),
    ...(formatLabel === null ? {} : { formatLabel }),
    text: isVoice ? null : note.text,
    voice: isVoice
      ? {
          label:
            note.audioSec === null
              ? SHEET_NOTES_TEXT.voiceNote
              : `${SHEET_NOTES_TEXT.voiceNote} · ${noteTime(note.audioSec)}`,
          transcript: transcriptOf(note),
        }
      : null,
    marks,
  };
}

/** When the first note of a round went (a round is sent together, so this is when the round was). */
function firstSentAt(notes: readonly ReviewNote[]): string {
  let first: { iso: string; ms: number } | null = null;
  for (const { sentAt } of notes) {
    if (sentAt === null) continue;
    const ms = Date.parse(sentAt);
    if (Number.isFinite(ms) && (first === null || ms < first.ms)) first = { iso: sentAt, ms };
  }
  return first?.iso ?? '';
}

/**
 * The notes the owner sent in Review, round by round: oldest round first, each round's notes by their
 * time in the video. A draft (no `sentAt`) never shows, and neither does a note with no round (it
 * cannot be named). A round says when its first note went (see {@link roundTitle}; `now` tells
 * today from an earlier day). `undefined` (not loaded, or failed to load) is no rounds. On a job
 * with two formats (`formats`, Generated videos) a note written on an extra format carries its
 * label, as in Review.
 */
export function sentRounds(
  notes: readonly ReviewNote[] | undefined,
  now: TimeInput,
  timeZone?: string,
  formats?: readonly JobFormat[],
): SentRound[] {
  const byRound = new Map<number, ReviewNote[]>();
  for (const note of notes ?? []) {
    if (note.sentAt === null || note.round === null) continue;
    const inRound = byRound.get(note.round);
    if (inRound === undefined) byRound.set(note.round, [note]);
    else inRound.push(note);
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, inRound]) => ({
      round,
      title: roundTitle(round, firstSentAt(inRound), now, timeZone),
      notes: [...inRound].sort(compareNotes).map((note) => sentNote(note, formats)),
    }));
}
