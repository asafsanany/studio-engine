import {
  type Effort,
  effortLabel,
  type QuickFix,
  type ReviewNote,
  type ReviseMinutes,
  TIER_MINUTES,
  TIER_RUNS,
  type TierRun,
} from '@studio/shared';
import { type FooterInput, type FooterView, reviewFooter } from './notes-logic';
import { FIX_TEXT } from './review-text';

// What Review says about Quick fixes (canvas page "Quick fixes", boards QFReview and QFStates): the
// line under each note that answers it, and the footer that says what will happen. No React, no
// network: tested on plain values. The words are in `FIX_TEXT` (review-text.ts).
//
// A note is in one of five places:
//   reading  Auto's router has not answered yet
//   queued   its quick fix waits its turn ("next in line")
//   running  the fix is at it
//   fixed    the fix landed; the note stays, unsent, and Approve takes it as it is
//   waiting  it goes with Send: routed `revise` or `full`, or a quick note whose fix did not land
//            (escalated, failed, undone, cancelled), or a note Auto never read
// Everything here is only for Quick fixes that are on; the callers use `reviewFooter` and draw no
// lines while they are off.

/** Where a note stands. */
export type FixNoteState = 'reading' | 'queued' | 'running' | 'fixed' | 'waiting';

/** What the rules need to know besides the notes and their fixes. */
export interface FixContext {
  /** The job's review effort is Auto (`reviewEffort` is `null`): notes are read and quick ones fixed. A level makes every note wait for Send. */
  auto: boolean;
  /** The job's fixes have been asked for and answered. Until then a quick note's fix is not known. */
  loaded: boolean;
}

/** The fix that counts for a note: its newest one that was not cancelled (a cancelled fix is a fix that never ran). */
export function activeFixByNote(fixes: readonly QuickFix[]): Map<string, QuickFix> {
  const byNote = new Map<string, QuickFix>();
  for (const fix of fixes) {
    if (fix.status !== 'cancelled') byNote.set(fix.noteId, fix);
  }
  return byNote;
}

/** The fixed fix that ended last, the only one Undo takes back (fixes edit the same files). `null` when none. */
export function newestFixedId(fixes: readonly QuickFix[]): string | null {
  let newest: QuickFix | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const fix of fixes) {
    if (fix.status !== 'fixed') continue;
    const at = fix.endedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(fix.endedAt);
    // Equal times: the later row (the later in the queue) wins, like the server's.
    if (newest === null || at >= newestAt) {
      newest = fix;
      newestAt = at;
    }
  }
  return newest?.id ?? null;
}

/** Whether some fix is queued or running: Undo, Approve and Send wait for it. */
export function fixIsBusy(fixes: readonly QuickFix[]): boolean {
  return fixes.some((fix) => fix.status === 'queued' || fix.status === 'running');
}

/** Where a note stands, given its fix (from `activeFixByNote`) or none. */
export function fixNoteState(
  note: Pick<ReviewNote, 'routeStatus' | 'route'>,
  fix: QuickFix | null,
  context: FixContext,
): FixNoteState {
  if (fix !== null) {
    if (fix.status === 'running') return 'running';
    if (fix.status === 'queued') return 'queued';
    if (fix.status === 'fixed') return 'fixed';
  }
  if (context.auto) {
    if (note.routeStatus === 'pending') return 'reading';
    // Routed quick and the fixes are not in yet: its fix may be on its way, so the page doesn't call it done.
    if (!context.loaded && note.route?.tier === 'quick' && fix === null) return 'reading';
  }
  return 'waiting';
}

// --- the line under a note -------------------------------------------------------------------------

export type NoteFixLineKind =
  | 'reading'
  | 'queued'
  | 'running'
  | 'fixed'
  | 'sends'
  | 'escalated'
  | 'undone';

/** What the card draws under a note's words. */
export interface NoteFixLine {
  kind: NoteFixLineKind;
  /** The line's words. */
  text: string;
  /** The fix's reply, set apart after `text` in its own text direction ("The captions are Heebo Bold now."); only on `fixed`. */
  tail: string | null;
  /** The bar under the line while the fix runs: 25, 50, 75 or 100 (%); `null` when there is none. */
  progress: number | null;
  /** The fix the Undo button takes back: set on the newest fixed fix only; `null` for no button. */
  undoFixId: string | null;
  /** Undo would be refused now (another fix is queued or running). */
  undoBlocked: boolean;
  /** The note's delete button: `hidden` on a fixed note that isn't the newest fix, `disabled` while its fix runs. */
  deleteMode: 'ok' | 'hidden' | 'disabled';
}

/** `template` with each `{name}` replaced. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/**
 * Whether a text reads right to left: its first letter is Hebrew or Arabic, which is what
 * `dir="auto"` goes by (digits, quotes and punctuation before it don't count).
 */
export function startsRtl(text: string): boolean {
  return /^[^\p{L}]*[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(text);
}

/** A reason without its closing full stop ("it changes the cut." → "it changes the cut"): the line adds its own. */
function plainReason(why: string): string {
  return why.trim().replace(/[.\s]+$/, '');
}

function line(kind: NoteFixLineKind, text: string, rest: Partial<NoteFixLine> = {}): NoteFixLine {
  return {
    kind,
    text,
    tail: null,
    progress: null,
    undoFixId: null,
    undoBlocked: false,
    deleteMode: 'ok',
    ...rest,
  };
}

export interface FixLineContext extends FixContext {
  /** `newestFixedId(fixes)`. */
  newestFixedId: string | null;
  /** `fixIsBusy(fixes)`. */
  busy: boolean;
}

/**
 * The line under a note, or `null` for none. Only the notes of a job with Quick fixes on are asked.
 * - Auto reading the note, a fix queued or running, a fix that landed, a quick note whose fix did
 *   not land, a note that goes with Send: each has its line.
 * - A level instead of Auto means no line for a note that was never fixed (today's cards); a fix
 *   that exists (landed before, or could not be done) still says so.
 */
export function noteFixLine(
  note: Pick<ReviewNote, 'routeStatus' | 'route'>,
  fix: QuickFix | null,
  context: FixLineContext,
): NoteFixLine | null {
  if (fix !== null) {
    switch (fix.status) {
      case 'running': {
        const step = fix.stepLabel === null ? '' : `${FIX_TEXT.runningStep}${fix.stepLabel}`;
        return line('running', `${FIX_TEXT.running}${step}`, {
          progress: ((fix.step ?? 0) + 1) * 25,
          deleteMode: 'disabled',
        });
      }
      case 'queued':
        return line('queued', FIX_TEXT.queued);
      case 'fixed': {
        const newest = fix.id === context.newestFixedId;
        const secs = fix.durationSec === null ? null : Math.max(1, Math.round(fix.durationSec));
        return line('fixed', secs === null ? FIX_TEXT.fixed : fill(FIX_TEXT.fixedIn, { n: secs }), {
          tail: fix.said,
          undoFixId: newest ? fix.id : null,
          undoBlocked: newest && context.busy,
          deleteMode: newest ? 'ok' : 'hidden',
        });
      }
      default:
        break;
    }
  }
  if (context.auto && note.routeStatus === 'pending') return line('reading', FIX_TEXT.reading);
  if (fix !== null) {
    if (fix.status === 'escalated' || fix.status === 'failed') {
      const why = fix.why === null ? '' : plainReason(fix.why);
      return line(
        'escalated',
        why === '' ? FIX_TEXT.couldNotNoWhy : fill(FIX_TEXT.couldNot, { why }),
      );
    }
    if (fix.status === 'undone') return line('undone', FIX_TEXT.undone);
  }
  if (!context.auto || note.routeStatus !== 'routed' || note.route === null) return null;
  if (note.route.tier !== 'quick') {
    const why = plainReason(note.route.why);
    return line(
      'sends',
      why === ''
        ? FIX_TEXT.goesWithSend
        : `${FIX_TEXT.goesWithSend}${FIX_TEXT.goesWithSendWhy}${why}`,
    );
  }
  // A quick note without a fix that counts: its fix was cancelled, or Auto never made one. It waits for
  // Send. (Until the fixes are in, its fix may be on its way: no line yet.)
  return context.loaded ? line('sends', FIX_TEXT.goesWithSend) : null;
}

/** The lines of a list of notes, by note id: only the notes that have one. */
export function noteFixLines(
  notes: readonly ReviewNote[],
  fixes: readonly QuickFix[],
  context: FixContext,
): Map<string, NoteFixLine> {
  const active = activeFixByNote(fixes);
  const lineContext: FixLineContext = {
    ...context,
    newestFixedId: newestFixedId(fixes),
    busy: fixIsBusy(fixes),
  };
  const lines = new Map<string, NoteFixLine>();
  for (const note of notes) {
    const found = noteFixLine(note, active.get(note.id) ?? null, lineContext);
    if (found !== null) lines.set(note.id, found);
  }
  return lines;
}

// --- the footer ------------------------------------------------------------------------------------

/**
 * How long a round of notes takes, as the footer says it (C61): "12 to 40 min", shortest to longest
 * (the job's own revise runs, `Job.reviseMinutes`, else the tier's `TIER_MINUTES`), or "about 5 min"
 * when the two are the same.
 */
export function minutesText(range: ReviseMinutes): string {
  return range.min === range.max
    ? fill(FIX_TEXT.minutesAbout, { n: range.max })
    : fill(FIX_TEXT.minutesRange, { min: range.min, max: range.max });
}

/** The name of a run's model: "Sonnet", "Opus"; the editor's own when the run uses the configured model, which the page isn't told. */
export function modelName(model: TierRun['model']): string {
  if (model === null || model === '') return FIX_TEXT.theEditor;
  return model.charAt(0).toUpperCase() + model.slice(1);
}

function noteWord(count: number): string {
  return count === 1 ? '1 note' : `${count} notes`;
}

/** "Sonnet at High" / "the editor at Extra high": who runs a tier and at what. */
export function tierRunName(tier: 'revise' | 'full'): string {
  const run = TIER_RUNS[tier];
  return `${modelName(run.model)} at ${effortLabel(run.effort)}`;
}

/** The tier the notes that wait for Send run at: the biggest one, a waiting quick note and a note Auto never read counting as `revise` and `full`. */
export function waitingTier(notes: readonly Pick<ReviewNote, 'route'>[]): 'revise' | 'full' {
  return notes.some((note) => note.route === null || note.route.tier === 'full')
    ? 'full'
    : 'revise';
}

export interface FixFooterInput extends FooterInput {
  fixes: readonly QuickFix[];
  auto: boolean;
  loaded: boolean;
  /** The level of the job's review rounds when it is not Auto (`reviewEffort`); the footer names it. Left out or `null`: no level to name. */
  level?: Effort | null;
  /** How long this job's earlier revise runs took (`Job.reviseMinutes`); left out or `null`: the footer says the tier's range. */
  reviseMinutes?: ReviseMinutes | null;
}

/**
 * The review footer with Quick fixes on: one line and one action, as before.
 * - A note being read or a fix queued or running: what is going on, and that Send (with notes that
 *   wait) or Approve (without) waits for it; the action and the Effort button are off.
 * - Notes that wait for Send on Auto: the plan, "Auto sends 2 notes to Sonnet at High, 2 to 10
 *   min." (the range of the job's own earlier revise runs, else the tier's). A level instead of
 *   Auto: "Your notes go to the editor together, at Extra high.", the board's line; without a
 *   level to name, today's.
 * - Only fixed notes: Approve, "Fixed here…".
 * - No notes: today's.
 * "Send N notes" counts the notes that wait; the fixed ones go along with them or with Approve.
 */
export function fixFooter(input: FixFooterInput): FooterView {
  const { notes, fixes, auto, loaded, level = null, reviseMinutes = null, ...rest } = input;
  if (notes === undefined || notes.length === 0) return reviewFooter({ ...rest, notes });

  const active = activeFixByNote(fixes);
  const context: FixContext = { auto, loaded };
  const waiting: ReviewNote[] = [];
  let reading = 0;
  let fixing = 0;
  let fixed = 0;
  for (const note of notes) {
    switch (fixNoteState(note, active.get(note.id) ?? null, context)) {
      case 'reading':
        reading += 1;
        break;
      case 'queued':
      case 'running':
        fixing += 1;
        break;
      case 'fixed':
        fixed += 1;
        break;
      default:
        waiting.push(note);
    }
  }

  // What Send and Approve decide on is the notes that wait: fixed ones don't need Send.
  const base = reviewFooter({ ...rest, notes: waiting });

  if (reading + fixing > 0) {
    const what =
      fixing === 0
        ? FIX_TEXT.footReading
        : fixing === 1
          ? FIX_TEXT.footFixingOne
          : fill(FIX_TEXT.footFixingMany, { n: fixing });
    return {
      ...base,
      text: `${what}${waiting.length > 0 ? FIX_TEXT.sendWaits : FIX_TEXT.approveWaits}`,
      disabled: true,
      disabledReason: FIX_TEXT.waitTip,
      effortDisabled: true,
      quickFix: 'busy',
    };
  }

  if (waiting.length > 0) {
    if (!auto) {
      return level === null
        ? base
        : { ...base, text: fill(FIX_TEXT.levelSends, { level: effortLabel(level) }) };
    }
    const tier = waitingTier(waiting);
    return {
      ...base,
      text: fill(FIX_TEXT.autoSends, {
        notes: noteWord(waiting.length),
        who: tierRunName(tier),
        why: tier === 'full' ? FIX_TEXT.autoWhole : '',
        time: minutesText(reviseMinutes ?? TIER_MINUTES[tier]),
      }),
      quickFix: 'auto',
    };
  }

  // Only fixed notes.
  return {
    ...base,
    text: fixed === 1 ? FIX_TEXT.fixedOne : fill(FIX_TEXT.fixedAll, { n: fixed }),
    quickFix: 'fixed',
  };
}

/** The notes that wait for Send (everything that is not read, being fixed or fixed): what "Send N notes" counts. */
export function waitingNotes(
  notes: readonly ReviewNote[],
  fixes: readonly QuickFix[],
  context: FixContext,
): ReviewNote[] {
  const active = activeFixByNote(fixes);
  return notes.filter(
    (note) => fixNoteState(note, active.get(note.id) ?? null, context) === 'waiting',
  );
}
