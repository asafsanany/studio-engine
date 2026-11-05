// What the phone Review decides before it draws anything (boards MReview, MReviewNotes,
// MReviewWrite, MReviewRec, MReviewEffort, MReviewDone, canvas page Mobile): how tall the video's
// stage is with the notes open or shut and while a note is written, what sits under the notes
// (the footer, the note box or the recording bar) and what steps aside while the keyboard is up,
// which footer shows (Approve; Effort and Send N notes; or the done line), the choices of the
// Effort sheet and the done line's words, where a note is pinned and what a hidden page does to a
// recording. Pure, so each state is tested without a browser. The rules themselves are the Mac's
// (`reviewFooter`, `sentHead`, `EFFORT_OPTIONS`, the recorder); this file only chooses and orders
// them for a narrow screen.

import { DEFAULT_EFFORT, type Effort, effortLabel } from '@studio/shared';
import type { LucideIcon } from 'lucide-react';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import {
  EFFORT_OPTIONS,
  effortOfOption,
  optionIdOf,
  REVIEW_EFFORT_OPTIONS,
  REVIEW_EFFORT_WORDS,
  reviewChoiceOf,
} from '@/features/jobs/effort-options';
import { type FooterView, sentHead } from '@/features/review/notes-logic';
import { clampTime } from '@/features/review/player-state';
import type { ReviewSubmitAction } from '@/features/review/review-dialog';
import { onPhone, REVIEW_DIALOG_TEXT } from '@/features/review/review-text';
import type { RecorderPhase } from '@/features/review/voice-recorder';

/** The video's stage with the notes list open (board MReviewNotes), in px. */
export const NOTES_STAGE_HEIGHT = 260;
/** The video's stage while a note is written (board MReviewWrite), in px. */
export const WRITE_STAGE_HEIGHT = 200;
/** The least the stage keeps while the keyboard is up, on a phone too short for more. */
export const WRITE_STAGE_MIN_HEIGHT = 120;

/** The timeline row under the video (32 px) and the row of buttons under it (52 px). */
export const TIMELINE_HEIGHT = 32;
export const CONTROLS_ROW_HEIGHT = 52;

/** The words only the phone's Review has (the rest are the Mac's, in `review-text`). */
export const PHONE_REVIEW_TEXT = {
  notes: 'Notes',
  record: 'Record',
  write: 'Write',
  close: REVIEW_DIALOG_TEXT.close,
  /** The line under the Effort sheet's title. */
  effortHint: 'Your notes are fixed at this level. Approve takes no level.',
  /** With Quick fixes on the sheet has no line under its title (Auto's own line is on its row); screen readers still get this one. */
  effortHintAuto:
    'Auto picks the level for each note. A level you choose holds every note for Send.',
  /** The done line after Approve (board MReviewDone). */
  approvedDone: 'Approved. The final video is rendering; the job shows Approved when it’s done.',
} as const;

// --- the stage ----------------------------------------------------------------------------------

/**
 * How the video's stage is laid out. The stage is the black area the 9:16 video fills; nothing is
 * ever drawn over it.
 * - `fill`: the notes are shut. It takes everything between the header and the controls.
 * - `shrunk`: the notes are open. It is 260 px and the list takes the rest.
 * - `write`: a note is being written (board MReviewWrite). It is 200 px, above the list and the
 *   note box (with the notes shut it fills, as above). While the keyboard is up the list steps aside and the stage takes what is left
 *   between the timeline and the note box: 241 px on a 390×844 phone with its 336 px keyboard, and
 *   never less than 120 px on a shorter one.
 *
 * `column` is the classes of the player column (stage and controls), `stage` the stage's own.
 */
export interface PhoneStageLayout {
  mode: 'fill' | 'shrunk' | 'write';
  /** The stage's height in px when shrunk or writing; `null` while it fills what is left. */
  height: number | null;
  column: string;
  stage: string;
}

export interface PhoneStageInput {
  notesOpen: boolean;
  /** The note box is open (Write). */
  writing?: boolean;
  /** The keyboard is up (`keyboardFrame`). */
  keyboardOpen?: boolean;
}

export function phoneStageLayout({
  notesOpen,
  writing = false,
  keyboardOpen = false,
}: PhoneStageInput): PhoneStageLayout {
  if (writing && keyboardOpen) {
    return { mode: 'write', height: null, column: 'min-h-0 flex-1', stage: 'min-h-[120px] flex-1' };
  }
  if (notesOpen && writing) {
    return {
      mode: 'write',
      height: WRITE_STAGE_HEIGHT,
      column: 'flex-none',
      stage: 'h-[200px] shrink-0',
    };
  }
  if (notesOpen) {
    return {
      mode: 'shrunk',
      height: NOTES_STAGE_HEIGHT,
      column: 'flex-none',
      stage: 'h-[260px] shrink-0',
    };
  }
  return { mode: 'fill', height: null, column: 'min-h-0 flex-1', stage: 'min-h-0 flex-1' };
}

// --- what sits under the notes, and what steps aside -------------------------------------------

/**
 * What the review shows under the video and the notes, one thing at a time:
 * - `footer`: Approve, or Effort and Send N notes, or (after either) the done line;
 * - `write`: the note box (board MReviewWrite), from Write until Comment or Cancel;
 * - `record`: the red recording bar (board MReviewRec), from Record until the note is added (or
 *   until Discard after a failed upload).
 */
export type PhoneBottom = 'footer' | 'write' | 'record';

export interface PhoneReviewMode {
  bottom: PhoneBottom;
  /**
   * The 48 px header. It steps aside while the keyboard is up, so the paused frame keeps at least
   * its 200 px above the note box on a 390×844 phone (the note box has Cancel, so nothing is lost).
   */
  showHeader: boolean;
  /** The notes list, when it is open. It steps aside while the keyboard is up, for the frame. */
  showNotes: boolean;
  /** The row of Play, Notes, Record and Write: not while recording, the keyboard is up, or after Send/Approve. */
  showButtons: boolean;
  /** The video can't start: the frame stays where the note goes (boards: Play does nothing). */
  playLocked: boolean;
}

export function phoneReviewMode({
  writing,
  recorderPhase,
  finished,
  keyboardOpen,
}: {
  /** The note box is open. */
  writing: boolean;
  recorderPhase: RecorderPhase;
  /** Send or Approve went through. */
  finished: boolean;
  keyboardOpen: boolean;
}): PhoneReviewMode {
  if (finished) {
    return {
      bottom: 'footer',
      showHeader: true,
      showNotes: false,
      showButtons: false,
      playLocked: false,
    };
  }
  if (recorderPhase !== 'idle') {
    return {
      bottom: 'record',
      showHeader: true,
      showNotes: true,
      showButtons: false,
      playLocked: true,
    };
  }
  if (writing) {
    return {
      bottom: 'write',
      showHeader: !keyboardOpen,
      showNotes: !keyboardOpen,
      showButtons: !keyboardOpen,
      playLocked: true,
    };
  }
  return {
    bottom: 'footer',
    showHeader: true,
    showNotes: true,
    showButtons: true,
    playLocked: false,
  };
}

// --- the keyboard -------------------------------------------------------------------------------

/** Less than this between the page and what is visible is not a keyboard (a toolbar, a rounding). */
export const KEYBOARD_MIN_HEIGHT = 120;

/** Where the review goes while the keyboard is up: the part of the page the keyboard leaves visible. */
export interface KeyboardFrame {
  keyboardOpen: boolean;
  /** The visible part's top and height in px, for the dialog's box; `null` while there is no keyboard. */
  box: { top: number; height: number } | null;
}

/**
 * iPhone Safari lays the page out as if the keyboard weren't there: `100vh` and `100dvh` stay the
 * whole screen, and the keyboard covers the bottom of it (and Safari may scroll what is visible
 * down to the focused field). Only `visualViewport` says what is visible: `viewportHeight` and
 * `offsetTop` are its height and top, `layoutHeight` the page's own height. When the keyboard
 * covers some of the page, the review is pinned to the visible part, so the note box sits right on
 * top of the keyboard.
 */
export function keyboardFrame({
  layoutHeight,
  viewportHeight,
  offsetTop,
}: {
  layoutHeight: number;
  viewportHeight: number;
  offsetTop: number;
}): KeyboardFrame {
  if (layoutHeight - viewportHeight < KEYBOARD_MIN_HEIGHT)
    return { keyboardOpen: false, box: null };
  return {
    keyboardOpen: true,
    box: { top: Math.max(0, Math.round(offsetTop)), height: Math.round(viewportHeight) },
  };
}

// --- notes --------------------------------------------------------------------------------------

/**
 * Where a note is pinned: the playhead when Record was tapped (a voice note) or when Comment was
 * (a typed one; the video is paused and can't start meanwhile), within the video. Before the
 * length is known, anything from 0 up.
 */
export function pinTime(playheadSec: number, durationSec: number): number {
  if (durationSec > 0) return clampTime(playheadSec, durationSec);
  return Number.isFinite(playheadSec) ? Math.max(0, playheadSec) : 0;
}

/**
 * What happens to a recording when the page is hidden (the screen locks, or another app comes up):
 * one that runs stops and is added, like Stop and add, so nothing said is lost; one still waiting
 * for the microphone is dropped (nothing was recorded). Anything else goes on.
 */
export function recorderWhenHidden(phase: RecorderPhase): 'stop' | 'cancel' | null {
  if (phase === 'recording') return 'stop';
  if (phase === 'starting') return 'cancel';
  return null;
}

// --- the footer ---------------------------------------------------------------------------------

/** What was sent, kept for the done line (the notes are gone from the list once they are sent). */
export interface PhoneDone {
  action: ReviewSubmitAction;
  /** How many notes went with Send; 0 for Approve. */
  notes: number;
  /** How many of them were also saved to the client's style. */
  styled: number;
  /** The job's effort when Send was pressed: the fixes run at it. */
  effort: Effort | null;
  /** Quick fixes were on: `effort` is the review effort and `null` is Auto, not Default. */
  auto?: boolean;
}

/** The done line (board MReviewDone). */
export function phoneDoneLine(done: PhoneDone): string {
  if (done.action === 'approve') return PHONE_REVIEW_TEXT.approvedDone;
  // Auto has no one level: each note runs at the level it needs.
  const level =
    done.auto === true && done.effort === null
      ? 'the level each one needs'
      : effortLabel(done.effort ?? DEFAULT_EFFORT);
  return `${sentHead(done.notes, done.styled)}. The fixes run at ${level}; the job comes back to Review when they’re done.`;
}

/**
 * The footer, one action at a time (boards MReview / MReviewNotes / MReviewDone):
 * - `approve`: no notes to send. No button: its line says where Approve is (the row's sheet, by
 *   press and hold; the owner, 31 Oct: never inside the job), or, with Quick fixes, what the notes are
 *   doing ("Fixing it here. Approve waits for it.").
 * - `send`: notes. The outlined "Effort: <level> ▾" before "Send N notes".
 * - `done`: after Send went through. The done line and Close.
 */
export type PhoneFooterView =
  | {
      kind: 'approve';
      /** The Mac's footer line, said the phone's way (`onPhone`). */
      text: string;
    }
  | {
      kind: 'send';
      label: string;
      disabled: boolean;
      busy: boolean;
      /** Why Send waits (a transcript is on its way), or `null`. */
      disabledReason: string | null;
      /** The Effort button's words: "Effort: Default". */
      effortLabel: string;
      /** The Effort button waits too (Quick fixes: a note is being read or a fix runs). */
      effortDisabled?: boolean;
      /** Quick fixes: what the notes are doing and what happens next ("Auto sends 2 notes to Sonnet at High, 2 to 10 min."); `null` or absent otherwise. */
      note?: string | null;
    }
  | { kind: 'done'; text: string };

/** Which footer shows: the Mac's rule (`reviewFooter`), unless a Send has gone through. */
export function phoneFooter({
  footer,
  effort,
  done,
  auto = false,
}: {
  footer: FooterView;
  effort: Effort | null;
  done: PhoneDone | null;
  /** Quick fixes are on: `effort` is the review effort and `null` is Auto ("Effort: Auto"). */
  auto?: boolean;
}): PhoneFooterView {
  if (done !== null) return { kind: 'done', text: phoneDoneLine(done) };
  // Only with Quick fixes on: the footer's line (the phone has no tooltip, so it says why the action waits).
  const note = footer.quickFix === undefined ? {} : { note: footer.text };
  if (footer.action === 'send_notes') {
    return {
      kind: 'send',
      label: footer.label,
      disabled: footer.disabled,
      busy: footer.busy,
      disabledReason: footer.disabledReason,
      effortLabel: `Effort: ${auto && effort === null ? REVIEW_EFFORT_WORDS.auto : effortLabel(effort)}`,
      ...(footer.effortDisabled === true ? { effortDisabled: true } : {}),
      ...note,
    };
  }
  return { kind: 'approve', text: onPhone(footer.text) };
}

// --- the Effort sheet ---------------------------------------------------------------------------

/** One row of the Effort sheet (board MReviewEffort): a gauge (sparkles for Auto), the level, its hint and a check. */
export interface PhoneEffortChoice {
  id: string;
  label: string;
  hint: string;
  /** A second muted line under the label (Auto's), or `null`. */
  sub: string | null;
  icon: LucideIcon;
  checked: boolean;
  /** A 1 px rule goes above this row (after Default, or after Auto). */
  ruleAbove: boolean;
}

/**
 * The four choices (Default · Extra high, Medium, High, Extra high) with the job's level checked.
 * With Quick fixes on (`auto`) they are Auto (Default, with its line of help, sparkles), then the
 * levels, each waiting for Send, the same as the Mac's menu; `effort` is then the review effort.
 */
export function effortChoices(effort: Effort | null, auto = false): PhoneEffortChoice[] {
  const rows = auto
    ? REVIEW_EFFORT_OPTIONS.map((option) => ({ option, icon: effortIcon(option.id) }))
    : EFFORT_OPTIONS.map((option) => ({ option, icon: gaugeIcon(effortOfOption(option.id)) }));
  const options = rows.map((row) => row.option);
  const current = auto ? reviewChoiceOf(effort) : optionIdOf(effort);
  return rows.map(({ option, icon }, index) => ({
    id: option.id,
    label: option.label,
    hint: option.hint,
    sub: option.sub ?? null,
    icon,
    checked: option.id === current,
    ruleAbove: index > 0 && options[index - 1]?.separatorAfter === true,
  }));
}
