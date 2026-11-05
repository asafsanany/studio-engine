import { clock, type ReviewNote } from '@studio/shared';
import { compareNotes } from '@/data/notes-cache';
import type { ReviewSubmitAction } from './review-dialog';
import { FOOTER_TEXT, VOICE_TEXT } from './review-text';
import type { RecorderSnapshot } from './voice-recorder';

// The rules of the notes panel, the timeline dots, the voice notes and the footer. No React, no
// network: tested on plain values.

/** The note colour: the dots, the dot on each time chip and the hover tint (#3B82F6, the "Editing" blue). */
export const NOTE_COLOR = '#3B82F6';

/** While playing, a note is active from its time to this long after it. */
export const NOTE_ACTIVE_WINDOW_SEC = 1.5;

/** A note's time as m:ss, rounded down like the playhead: 2.4 → "0:02", 65.9 → "1:05". */
export function noteTime(sec: number): string {
  return clock(Math.floor(Math.max(0, sec)));
}

/** "Note at 0:02" / "Voice note at 0:07": a dot's accessible name. */
export function noteDotLabel(note: Pick<ReviewNote, 'kind' | 'atSec'>): string {
  return `${note.kind === 'voice' ? 'Voice note' : 'Note'} at ${noteTime(note.atSec)}`;
}

/** "Go to 0:02": a time chip's accessible name. */
export function goToLabel(atSec: number): string {
  return `Go to ${noteTime(atSec)}`;
}

/** The notes by time: the server's order (`compareNotes`), on a copy. */
export function sortNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return [...notes].sort(compareNotes);
}

export interface ActiveInput {
  /** The note that was clicked (a dot or a time chip); stays until the video plays. */
  selectedId: string | null;
  playing: boolean;
  currentSec: number;
}

/** Selected, or (while playing) under the playhead: `currentSec` in [atSec, atSec + 1.5). */
export function isNoteActive(note: Pick<ReviewNote, 'id' | 'atSec'>, input: ActiveInput): boolean {
  if (input.selectedId === note.id) return true;
  if (!input.playing) return false;
  return input.currentSec >= note.atSec && input.currentSec < note.atSec + NOTE_ACTIVE_WINDOW_SEC;
}

/** 10 px when hovered or active, else 8. */
export function noteDotSize(hovered: boolean, active: boolean): 8 | 10 {
  return hovered || active ? 10 : 8;
}

function noteWord(count: number): string {
  return count === 1 ? 'note' : 'notes';
}

/** "Send 1 note", "Send 3 notes". */
export function sendLabel(count: number): string {
  return `Send ${count} ${noteWord(count)}`;
}

/** "Sent 3 notes (1 saved to the client style)": the start of the toast after Send and of the phone's done line. */
export function sentHead(count: number, styleCount: number): string {
  const style = styleCount > 0 ? ` (${styleCount} saved to the client style)` : '';
  return `Sent ${count} ${noteWord(count)}${style}`;
}

/**
 * The toast after Send: "Sent 3 notes (1 saved to the client style). The job comes back to Review
 * when the changes are done." The parenthesis only when `styleCount` is above 0; "Sent 1 note" for
 * one.
 */
export function sentToast(count: number, styleCount: number): string {
  return `${sentHead(count, styleCount)}. ${FOOTER_TEXT.sentTail}`;
}

export interface FooterInput {
  /** The unsent notes; undefined while they load (or failed to load). */
  notes: readonly ReviewNote[] | undefined;
  /** A note is being written: the draft is not blank, or a typed or recorded note is being added. */
  writing: boolean;
  submitting: ReviewSubmitAction | null;
  /** Why Send can't go now (`sendBlockedByTranscripts`); null when it can. */
  sendDisabledReason: string | null;
}

export interface FooterView {
  /**
   * 'send_notes' with notes, else 'approve': nothing to send, the way on is Approve, which is in
   * the row's right-click menu only (the footer has no button then, and `text` says where it is).
   */
  action: ReviewSubmitAction;
  /** FOOTER_TEXT.withNotes / withoutNotes. */
  text: string;
  /** sendLabel(n) / 'Approve'. */
  label: string;
  disabled: boolean;
  /** This action is on its way: the button shows a spinner. */
  busy: boolean;
  /** The tooltip of a disabled Send (`sendDisabledReason`), else null. */
  disabledReason: string | null;
  /** The Effort button waits too (a note is being read or a fix runs; Quick fixes only). Absent: it doesn't. */
  effortDisabled?: boolean;
  /**
   * Quick fixes only (`fix-lines.ts`): which of its lines `text` is. `busy`: a note is being read or
   * a fix is queued or running; `fixed`: only fixed notes are left; `auto`: Auto's plan for the notes
   * that wait for Send. Absent: today's text. The music's line leaves these alone (`musicFooter`).
   */
  quickFix?: 'busy' | 'fixed' | 'auto';
}

/** The footer's one action. Nothing loaded yet reads as "no notes" with Approve off. */
export function reviewFooter({
  notes,
  writing,
  submitting,
  sendDisabledReason,
}: FooterInput): FooterView {
  if (notes !== undefined && notes.length > 0) {
    return {
      action: 'send_notes',
      text: FOOTER_TEXT.withNotes,
      label: sendLabel(notes.length),
      disabled: submitting !== null || sendDisabledReason !== null,
      busy: submitting === 'send_notes',
      disabledReason: sendDisabledReason,
    };
  }
  return {
    action: 'approve',
    text: FOOTER_TEXT.withoutNotes,
    label: FOOTER_TEXT.approve,
    disabled: notes === undefined || writing || submitting !== null,
    busy: submitting === 'approve',
    disabledReason: null,
  };
}

/** A voice note still waits for its transcript: Send must wait too (the server would answer 409). */
export function hasPendingTranscript(notes: readonly ReviewNote[] | undefined): boolean {
  return (
    notes?.some((note) => note.kind === 'voice' && note.transcriptStatus === 'pending') ?? false
  );
}

/** Why Send is disabled because of the transcripts (`VOICE_TEXT.waitingForTranscripts`), or null. */
export function sendBlockedByTranscripts(notes: readonly ReviewNote[] | undefined): string | null {
  return hasPendingTranscript(notes) ? VOICE_TEXT.waitingForTranscripts : null;
}

/**
 * Why Send is disabled because a voice note is being recorded (`VOICE_TEXT.finishRecordingFirst`),
 * or null. Send closes the dialog, which would throw the recording away without a word, so it
 * waits for any phase but idle: starting, recording, saving, and also a failed upload (that
 * recording is kept for Try again or Discard).
 */
export function sendBlockedByRecording(snapshot: Pick<RecorderSnapshot, 'phase'>): string | null {
  return snapshot.phase === 'idle' ? null : VOICE_TEXT.finishRecordingFirst;
}

/**
 * A voice note's transcript line: "Transcribing…", the text, "Couldn't transcribe. The editor will
 * listen to it.", or "" for a text note (and for a voice note with nothing to say yet).
 */
export function transcriptLine(
  note: Pick<ReviewNote, 'kind' | 'transcriptStatus' | 'text'>,
): string {
  if (note.kind !== 'voice') return '';
  switch (note.transcriptStatus) {
    case 'pending':
      return VOICE_TEXT.transcribing;
    case 'done':
      return note.text ?? '';
    case 'failed':
      return VOICE_TEXT.notTranscribed;
    default:
      return '';
  }
}

/**
 * The recording box's line for a phase: "Waiting for the microphone…", "Recording 0:07" (the
 * seconds round down, like every clock here), "Adding the voice note…", or the error.
 */
export function recordingLine(snapshot: RecorderSnapshot): string {
  switch (snapshot.phase) {
    case 'starting':
      return VOICE_TEXT.waitingForMic;
    case 'recording':
      return `${VOICE_TEXT.recording} ${noteTime(snapshot.elapsedSec)}`;
    case 'saving':
      return VOICE_TEXT.saving;
    default:
      return snapshot.error ?? '';
  }
}

/**
 * What a screen reader gets of `recordingLine`: the same, except that while recording it is just
 * "Recording", without the clock. The clock changes every second, and the box is a live region
 * that should speak only when the phase changes (recording started, saving, failed).
 */
export function recordingSpokenLine(snapshot: RecorderSnapshot): string {
  return snapshot.phase === 'recording' ? VOICE_TEXT.recording : recordingLine(snapshot);
}

/** What a key in the composer does: Enter adds the note; Shift+Enter and an IME composition type. */
export function composerKeyAction(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): 'add' | null {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return null;
  return 'add';
}
