import {
  formatScopeOf,
  type GenerateNotePlan,
  type GenerateState,
  generateNoteHint,
  type Job,
  type JobFormat,
  type NoteHintLine,
  newTakesCostUsd,
  newTakesSentence,
  noteHintLine,
  type ReviewNote,
} from '@studio/shared';
import type { FooterView } from '../notes-logic';
import { FOOTER_TEXT, REVIEW_DIALOG_TEXT } from '../review-text';

// The rules of Review's format switch and the note hints on a generated video (Generated videos,
// GN8; boards GNReview, GNPhone, GNStates). No React, no network: tested on plain values.
//
// A job with two or more formats (`Job.formats`, main first) gets a switch; the format it is on
// stamps new notes (`ReviewNote.format`: an extra format's id, null for the main one). A job with
// fewer has none of this: every function here is a no-op for it.

/** The job's formats when it has more than one; `undefined` for every other job. */
export function formatsOf(job: Pick<Job, 'formats'>): readonly JobFormat[] | undefined {
  return job.formats !== undefined && job.formats.length >= 2 ? job.formats : undefined;
}

/** The format with this id, or the main one (a format the job no longer has is the main one). */
export function selectedFormat(formats: readonly JobFormat[], id: string | null): JobFormat {
  const main = formats[0] as JobFormat;
  return formats.find((format) => format.id === id) ?? main;
}

/** What a new note is stamped with when written on `format`: its id, or `null` for the main format. */
export function formatStamp(formats: readonly JobFormat[], format: JobFormat): string | null {
  return format.id === formats[0]?.id ? null : format.id;
}

/** The format a note was written on (the main one for `null`, and for a format the job no longer has). */
export function noteFormat(
  note: Pick<ReviewNote, 'format'>,
  formats: readonly JobFormat[],
): JobFormat {
  return selectedFormat(formats, note.format ?? null);
}

/** "1:1" for a note written on an extra format: the notes list prints it after the time. `null` for the main format. */
export function noteFormatLabel(
  note: Pick<ReviewNote, 'format'>,
  formats: readonly JobFormat[],
): string | null {
  const format = noteFormat(note, formats);
  return format.id === formats[0]?.id ? null : format.label;
}

/**
 * The words of the format switch (the group's accessible name and the notes' composer line).
 * The switch itself shows the formats' labels ("9:16", "1:1").
 */
export const FORMAT_TEXT = {
  group: 'Format',
  /** After "New note at 0:07": " on 9:16". */
  composerOn: 'on',
} as const;

// --- Export MP4 --------------------------------------------------------------------------------------

/** The words of the header's Export MP4 / Save MP4 button and its tooltip. */
export interface ExportWords {
  /** The button before the video is made: "Export MP4", on two formats "Export MP4 · 1:1". */
  mp4: string;
  /** The button once it is ready: "Save MP4", on two formats "Save MP4 · 1:1". */
  save: string;
  tip: string;
  readyTip: string;
}

/**
 * What Export MP4 says (C65). On a job with two formats the button exports the format on show, and
 * each format has an export of its own, so the size is in the label and the tooltip says the other
 * size is a separate export: the button never reads as if it made the other one. Approving never
 * reuses these exports on such a job (it renders every format), so the tooltip does not say it does.
 * A job with one format (`undefined`) has the words it always had.
 */
export function exportWords(shown: Pick<JobFormat, 'label'> | undefined): ExportWords {
  const text = REVIEW_DIALOG_TEXT;
  if (shown === undefined) {
    return {
      mp4: text.exportMp4,
      save: text.exportSave,
      tip: text.exportTip,
      readyTip: text.exportReadyTip,
    };
  }
  return {
    mp4: `${text.exportMp4} · ${shown.label}`,
    save: `${text.exportSave} · ${shown.label}`,
    tip: `Renders the full-quality ${shown.label} video now. The other size has an export of its own.`,
    readyTip: `The full-quality ${shown.label} video is ready to save. The other size has an export of its own.`,
  };
}

// --- the hints and the marks -------------------------------------------------------------------------

/** What a note's card shows besides its words on a job with two formats and/or a generated video. */
export interface NoteMark {
  /** "1:1" for a note written on an extra format; `null` for the main one (printed after the time). */
  formatLabel: string | null;
  /** What Send will probably do (generated videos only); `null` for no line. */
  hint: NoteHintLine | null;
}

export interface NoteMarks {
  marks: ReadonlyMap<string, NoteMark>;
  /** Whether a note's change is made in `both` formats or only `own` (the one it was written on). */
  scopes: ReadonlyMap<string, 'both' | 'own'>;
  /** What the notes' new takes cost together (one take per clip); `null` unless hints are on. */
  takesUsd: number | null;
}

export interface NoteMarksInput {
  notes: readonly ReviewNote[] | undefined;
  /** The job's formats, or `undefined` for a job with one. */
  formats: readonly JobFormat[] | undefined;
  /** The plan the hints read, once known; `null`/`undefined`: no hint is drawn. */
  plan: GenerateNotePlan | null | undefined;
  /** The job's Generate state; `undefined` for a job that is not generated (no hint is drawn). */
  generate: Pick<GenerateState, 'spendUsd' | 'budgetUsd'> | undefined;
  where?: 'mac' | 'phone';
}

/** The text a hint reads: a typed note's words, a voice note's transcript once it is done. */
function wordsOf(note: ReviewNote): string | null {
  const text = (note.text ?? '').trim();
  return text === '' ? null : text;
}

/**
 * The format stamp, the hint line and the scope of every note, and what the new takes cost. The hint
 * lines exist only for a generated job whose plan is known; the format stamp only for a job with
 * two formats.
 */
export function noteMarksOf({
  notes,
  formats,
  plan,
  generate,
  where = 'mac',
}: NoteMarksInput): NoteMarks {
  const marks = new Map<string, NoteMark>();
  const scopes = new Map<string, 'both' | 'own'>();
  const hints = generate !== undefined && plan !== null && plan !== undefined;
  const found: ReturnType<typeof generateNoteHint>[] = [];
  for (const note of notes ?? []) {
    const text = wordsOf(note);
    const hint = hints && text !== null ? generateNoteHint(text, note.atSec * 1000, plan) : null;
    if (hint !== null) found.push(hint);
    scopes.set(note.id, hint?.formatScope ?? (text === null ? 'both' : formatScopeOf(text)));
    const line =
      hint === null
        ? null
        : noteHintLine(hint, {
            ...(formats === undefined
              ? {}
              : { formats: { ownLabel: noteFormat(note, formats).label } }),
            where,
            ...(generate === undefined ? {} : { state: generate }),
          });
    const formatLabel = formats === undefined ? null : noteFormatLabel(note, formats);
    if (line !== null || formatLabel !== null) marks.set(note.id, { formatLabel, hint: line });
  }
  return { marks, scopes, takesUsd: hints ? newTakesCostUsd(found) : null };
}

/**
 * The notes whose dots sit on the timeline of the format on show: the notes written on it, and
 * those that change every format (anything but a size or position). Everything for a job with one.
 */
export function markerNotes(
  notes: readonly ReviewNote[] | undefined,
  formats: readonly JobFormat[] | undefined,
  shown: JobFormat | undefined,
  scopes: ReadonlyMap<string, 'both' | 'own'>,
): readonly ReviewNote[] {
  if (notes === undefined) return [];
  if (formats === undefined || shown === undefined) return notes;
  return notes.filter(
    (note) =>
      noteFormat(note, formats).id === shown.id || (scopes.get(note.id) ?? 'both') === 'both',
  );
}

// --- the footer --------------------------------------------------------------------------------------

/** "9:16 and 1:1", "9:16, 1:1 and 4:5". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The plain line with no notes, without its full stop: the formats take "the final video"'s place. */
const APPROVE_PLAIN = FOOTER_TEXT.withoutNotes.replace(/\.$/, '');

/** "both formats, 9:16 and 1:1" for two; "all 3 formats, …" for more. */
export function formatsRenderText(formats: readonly JobFormat[]): string {
  const labels = listText(formats.map((format) => format.label));
  return formats.length === 2
    ? `both formats, ${labels}`
    : `all ${formats.length} formats, ${labels}`;
}

export interface FormatsFooterInput {
  formats: readonly JobFormat[] | undefined;
  /** The notes "Send N notes" counts. */
  sendCount: number;
  /** What the notes' new takes cost; `null` unless the job is generated and its plan is known. */
  takesUsd: number | null;
  generate: Pick<GenerateState, 'spendUsd' | 'budgetUsd'> | undefined;
}

/**
 * The footer of a job with two formats and/or a generated video (board GNReview):
 * - Approve with two formats says it renders both ("Happy with it? Approve it from the job's
 *   right-click menu to render both formats, 9:16 and 1:1."); the music's line keeps its end
 *   ("…, with music v2.");
 * - Send on a generated job adds up the new takes against what is left of the budget
 *   ("3 notes. New takes use about $0.51 of the $0.67 left of the $3."). While Quick fixes have a
 *   line of their own it comes after it.
 * Any other footer is returned as it is.
 */
export function formatsFooter(
  footer: FooterView,
  { formats, sendCount, takesUsd, generate }: FormatsFooterInput,
): FooterView {
  if (footer.action === 'approve') {
    if (formats === undefined || !footer.text.startsWith(APPROVE_PLAIN)) return footer;
    return {
      ...footer,
      text: `${FOOTER_TEXT.approveLead} ${formatsRenderText(formats)}${footer.text.slice(APPROVE_PLAIN.length)}`,
    };
  }
  if (takesUsd === null || generate === undefined) return footer;
  const money = newTakesSentence(takesUsd, generate);
  const noun = sendCount === 1 ? 'note' : 'notes';
  return {
    ...footer,
    text:
      footer.quickFix === undefined ? `${sendCount} ${noun}. ${money}` : `${footer.text} ${money}`,
  };
}
