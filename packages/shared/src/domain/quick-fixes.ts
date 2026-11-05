import { z } from 'zod';
import { EFFORT_LEVELS, type Effort, effortSchema, runEffort } from './effort.ts';
import {
  isoTimestampSchema,
  type Job,
  jobSchema,
  type ReviseMinutes,
  type ReviseTier,
} from './job.ts';
import { firstStepOf, type RunKind } from './run-kind.ts';
import { CHECK_STEP, type StepId } from './steps.ts';

// Quick fixes (Plane items QF0–QF9, CVP-372 to CVP-381; plan page "Quick fixes & Auto effort —
// architecture & idea (CVP-332)"): with Auto, the effort for review rounds, a small Haiku pass reads
// each note the moment it is added and sorts it with the difficulty index
// (apps/server/prompts/fix-index.md) into one of three tiers. A quick note is fixed right there in
// Review by a Sonnet run that changes only the live composition; the other two wait for Send and run
// at the tier their biggest note needs. This file is the contract every QF item builds on, behind
// the `quickFixes` switch (server: config.ts), which stays off until QF9.
//
// The contract has three parts:
//   - the tiers and what each runs at (`TIER_RUNS`, `ROUTER_MODEL`, `biggestTier`), the note's route
//     (`NoteRoute`), and the fix itself (`QuickFix`, one row of the `quick_fixes` table);
//   - the limits and the 404/409 texts;
//   - the wire shapes. The job and the review note carry the rest (`Job.reviewEffort`,
//     `Job.reviseTier`, and `ReviewNote.routeStatus`, `route`, `fixId`, `fixedAt`), and
//     `job.fix` (events.ts) tells the page when a fix changes.
//
// On disk, per job (relative to the job's edit/ folder), one folder per fix, `<fixId>` being
// `QuickFix.id` (server: review/fix-service.ts, built by QF2 and QF3):
//
//   review/fixes/<fixId>/before/preview/    edit/preview/ as it was before the fix (an APFS clone) }
//   review/fixes/<fixId>/before/project.md  edit/project.md as it was (none if it had none)  } what Undo puts back
//   review/fixes/<fixId>/reply.json    the fix run's answer
//   review/fixes/<fixId>/before.png    the note's moment as a still, before the fix  } Compare
//   review/fixes/<fixId>/after.png     the same moment after the fix               } (`FIX_COMPARE_FILES`)
//
// The API, mounted at /api/jobs (built by QF3 and QF4; every route answers 404
// {@link FIX_MESSAGES}.off while the switch is off):
//
//   GET  /:id/fixes                       the fixes of the job's next round (JobFixesResponse)
//   POST /:id/fixes/:fixId/undo           200 UndoFixResponse; 409 {@link FIX_MESSAGES}.notNewest
//                                         unless it is the newest fixed one, .busy while a fix runs
//   GET  /:id/fixes/:fixId/compare/:file  before.png | after.png, the fix's still of the note's
//                                         moment (404 unless the fix has both)
//   PUT  /:id/review-effort               body ReviewEffortRequest: 200 with the Job (job.upsert is
//                                         published); 409 unless the job is in Review; 404
//                                         {@link FIX_MESSAGES}.off while the switch is off (QF4, in
//                                         routes/jobs.ts)
//
// Send and Approve with fixed notes (QF4, review/review-service.ts): a note whose fix landed is
// still unsent (`ReviewNote.fixId` is set, see {@link isFixedNote}). Send writes it into the round
// file under "Already changed in Review (keep these)" and needs at least one waiting note
// ({@link FIX_MESSAGES}.onlyFixed otherwise); with Auto it saves `Job.reviseTier` from the waiting
// notes ({@link biggestTier}); Approve works when every unsent note is fixed. The revise run then
// takes its model, effort and self-check from {@link reviseRunOf}.

// --- tiers ---------------------------------------------------------------------------------------

/**
 * The three kinds of note, smallest first. `quick`: only the layer on top of the cut changes (text,
 * fonts, colours, positions, timing of text and graphics), fixed at once in Review. `revise`: one
 * part of the cut or one baked step, a revise run on Send. `full`: the whole video, or taste across
 * it, today's revise run on Send. The difficulty index decides.
 */
export const FIX_TIERS = ['quick', 'revise', 'full'] as const;
export const fixTierSchema = z.enum(FIX_TIERS);
export type FixTier = z.infer<typeof fixTierSchema>;

/** What a tier runs with: the `claude --model` (`null` is the model the engine is configured with), the effort and the self-check. */
export interface TierRun {
  /** `null`: the configured model (`STUDIO_MODEL`, else the CLI's own default). */
  readonly model: string | null;
  readonly effort: Effort;
  /**
   * How much of the revise self-check the run does: `slim` (new partial self-eval-slim.md, only
   * around what changed) or `full` (today's check). A quick fix has none; it has its own checks (lint,
   * and a still at the changed moment).
   */
  readonly checks?: 'slim' | 'full';
}

/**
 * The tier → model/effort/checks map: code, not part of the index, so it can be tuned in one place.
 * If the Revise tier's re-cuts disappoint, change `revise` to `model: null` at `high`.
 */
export const TIER_RUNS: Readonly<Record<FixTier, TierRun>> = {
  quick: { model: 'sonnet', effort: 'medium' },
  revise: { model: 'sonnet', effort: 'high', checks: 'slim' },
  full: { model: null, effort: 'xhigh', checks: 'full' },
};

/**
 * How long a round of notes takes, by the tier it runs at, as the Review footer says it when the job
 * has too little history of its own to go by ("Auto sends 2 notes to Sonnet at High, 2 to 10 min.").
 * Whole minutes, wall time from Send to back in Review (CVP-407, C61), set from the engine's real
 * revise runs on 25 Oct (job logs and `step_runs`):
 *   - `full` is today's run, the configured model at Extra high: 17 runs (16 in the job logs and
 *     the 42 min one the QF9 acceptance run found, a Full on a job of 14 rounds) took 4.3 to 42 min,
 *     the median 15; the footer's old "about 12 min" was 3.5x off for that one;
 *   - `revise` is Sonnet at High with the slim check, which has no runs of its own yet: the lighter
 *     Opus runs (Medium and High, 8 of them) took 0.9 to 10 min, the median 2.6.
 * Change a range here when the real runs say otherwise.
 */
export const TIER_MINUTES: Readonly<Record<ReviseTier, ReviseMinutes>> = {
  revise: { min: 2, max: 10 },
  full: { min: 4, max: 40 },
};

/** A job's own history of revise runs counts once it has this many. */
export const REVISE_HISTORY_RUNS = 2;

/** Two timed steps of one revise run this far apart (a failure waiting for Retry) are not one stretch of work. */
export const REVISE_GAP_MS = 2 * 60 * 60 * 1000;

/** One timed step of one run of a job, as {@link revisePassSeconds} reads it: epoch milliseconds, `endedAt` null while it is open or left open. */
export interface TimedStepRun {
  step: StepId;
  runKind: RunKind;
  startedAt: number;
  endedAt: number | null;
}

/** The wall time of one revise run (its timed steps, `rows` oldest first), in seconds; `null` when it did not get back to Review or took no time. */
function passSeconds(rows: readonly TimedStepRun[]): number | null {
  const last = rows.at(-1);
  const first = rows[0];
  // A run whose last step is still open (a failure, a cancel, a crash) never got back to Review.
  if (first === undefined || last === undefined || last.endedAt === null) return null;
  let total = 0;
  let from = first.startedAt;
  let to = first.startedAt;
  for (const row of rows) {
    if (row.startedAt - to >= REVISE_GAP_MS) {
      total += to - from;
      from = row.startedAt;
      to = row.startedAt;
    }
    to = Math.max(to, row.endedAt ?? row.startedAt);
  }
  total += to - from;
  return total > 0 ? total / 1000 : null;
}

/**
 * How long each of a job's revise runs took, start to back in Review, in seconds, oldest first
 * (`runs`: every timed step of the job, oldest first). The job sheet's rounds (`roundsOfRuns`) are
 * not used here: a revise run that began at Cut instead of Plan counts as part of the round before
 * it there, and two such runs are hours apart. A new revise run starts at:
 *   - Plan, the first step of its kind;
 *   - the step after any other kind of run;
 *   - the step after a Check that ended: that run reached the end, the next one is another.
 * A run whose last timed step is still open never got back to Review and is left out. The hours a
 * failed run waited for Retry ({@link REVISE_GAP_MS}) are not counted.
 */
export function revisePassSeconds(runs: readonly TimedStepRun[]): number[] {
  const passes: TimedStepRun[][] = [];
  let current: TimedStepRun[] | null = null;
  let previous: TimedStepRun | null = null;
  for (const run of runs) {
    if (run.runKind !== 'revise') {
      current = null;
    } else if (
      current === null ||
      run.step === firstStepOf('revise') ||
      (previous?.runKind === 'revise' && previous.step === CHECK_STEP && previous.endedAt !== null)
    ) {
      current = [];
      passes.push(current);
    }
    current?.push(run);
    previous = run;
  }
  return passes.flatMap((rows) => passSeconds(rows) ?? []);
}

/**
 * A job's own range for the Review footer, from how long its revise runs took ({@link
 * revisePassSeconds}): shortest to longest in whole minutes. `null` with fewer than
 * {@link REVISE_HISTORY_RUNS} runs, when the footer says the tier's {@link TIER_MINUTES} instead.
 */
export function reviseMinutesOf(seconds: readonly number[]): ReviseMinutes | null {
  if (seconds.length < REVISE_HISTORY_RUNS) return null;
  const min = Math.max(1, Math.round(Math.min(...seconds) / 60));
  const max = Math.max(min, Math.round(Math.max(...seconds) / 60));
  return { min, max };
}

/** The model that sorts a note (`claude -p --model haiku`, no tools; usage tag `fix-route`). */
export const ROUTER_MODEL = 'haiku';

/** What a revise run uses (QF4): `model` null is the configured one, `checks` is how much self-check its prompt asks for. */
export interface ReviseRun {
  /** The `claude --model`; `null` is the model the engine is configured with. */
  readonly model: string | null;
  readonly effort: Effort;
  /** `slim`: self-eval only around what the round changed; `full`: today's check. */
  readonly checks: 'slim' | 'full';
}

/**
 * The model, effort and self-check of a job's revise run (the Send notes round), from the job as it
 * is when the run starts, so a retry or a resume of the run chooses the same:
 *
 *   - `reviewEffort` is set (Review's Effort was a level): the configured model at that level, the
 *     full check, as before Auto;
 *   - else `reviseTier` is set (Send with Auto saved it): that tier's {@link TIER_RUNS} entry, a
 *     `null` model being the configured one;
 *   - else today's run: the configured model at the edit's effort (`effort`, Default Extra high).
 *
 * Only a revise run asks (the engine also asks only while the Quick fixes switch is on); an edit
 * and a render run keep their own.
 */
export function reviseRunOf(job: Pick<Job, 'effort' | 'reviewEffort' | 'reviseTier'>): ReviseRun {
  if (job.reviewEffort !== null) {
    return { model: null, effort: job.reviewEffort, checks: 'full' };
  }
  if (job.reviseTier !== null) {
    const run = TIER_RUNS[job.reviseTier];
    return { model: run.model, effort: run.effort, checks: run.checks ?? 'full' };
  }
  return { model: null, effort: runEffort(job.effort), checks: 'full' };
}

const TIER_RANK: Readonly<Record<FixTier, number>> = { quick: 0, revise: 1, full: 2 };

/**
 * The biggest of these tiers (quick < revise < full); `null` for none. A round on Send runs at the
 * tier of its biggest waiting note. With `goesWithSend`, the tiers are those of notes that wait for
 * Send, and a waiting quick note (one the live fix did not do, or has not done yet) counts as
 * `revise`, since the run that takes it is at least a revise run: the answer is then a
 * {@link ReviseTier} (what `Job.reviseTier` holds).
 */
export function biggestTier(
  tiers: readonly FixTier[],
  options: { goesWithSend: true },
): ReviseTier | null;
export function biggestTier(
  tiers: readonly FixTier[],
  options?: { goesWithSend?: boolean },
): FixTier | null;
export function biggestTier(
  tiers: readonly FixTier[],
  options: { goesWithSend?: boolean } = {},
): FixTier | null {
  let biggest: FixTier | null = null;
  for (const tier of tiers) {
    const counted: FixTier = options.goesWithSend === true && tier === 'quick' ? 'revise' : tier;
    if (biggest === null || TIER_RANK[counted] > TIER_RANK[biggest]) biggest = counted;
  }
  return biggest;
}

// --- a note's route ------------------------------------------------------------------------------

/** Where the sorting of a note stands: `pending` while the router reads it, `routed` once it has answered. A note Auto never read has none (`null`). */
export const NOTE_ROUTE_STATUSES = ['pending', 'routed'] as const;
export const noteRouteStatusSchema = z.enum(NOTE_ROUTE_STATUSES);
export type NoteRouteStatus = z.infer<typeof noteRouteStatusSchema>;

/**
 * The router's answer for one note. `kind` is what the note asks for in 2–5 English words
 * ("Changing the caption font"), whatever language the note is in; `why` is the reason a note that
 * is not quick waits for Send, a short line starting "it …" ("it changes the cut"), and empty for a
 * quick note. A router that cannot read a note answers `full` (today's behaviour).
 */
export const noteRouteSchema = z
  .object({
    tier: fixTierSchema,
    kind: z.string().trim().min(1).max(80),
    why: z.string().trim().max(200),
  })
  .refine((route) => route.tier !== 'quick' || route.why === '', {
    message: 'A quick note has no why',
    path: ['why'],
  });
export type NoteRoute = z.infer<typeof noteRouteSchema>;

/**
 * Whether a note was fixed in Review (QF4): a quick fix landed for it and has not been undone. Such a
 * note is still unsent; Send lists it as already changed and Approve stamps it sent. (The service
 * sets `fixId` only when a fix lands and clears it on Undo.)
 */
export function isFixedNote(note: { readonly fixId: string | null }): boolean {
  return note.fixId !== null;
}

// --- the fix -------------------------------------------------------------------------------------

/**
 * Where a fix stands. `queued`: waiting its turn (quick notes of a job fix one at a time).
 * `running`: the Sonnet run is at it. `fixed`: done, the preview changed. `escalated`: it could not
 * be done in the composition alone, the note goes with Send (`QuickFix.why` says why). `failed`: the
 * run or its checks failed, or the engine stopped mid-fix; the preview is as it was. `undone`:
 * The owner took a fixed one back. `cancelled`: its note was deleted before it ran.
 */
export const FIX_STATUSES = [
  'queued',
  'running',
  'fixed',
  'escalated',
  'failed',
  'undone',
  'cancelled',
] as const;
export const fixStatusSchema = z.enum(FIX_STATUSES);
export type FixStatus = z.infer<typeof fixStatusSchema>;

/** The stills Compare serves for a fix, in the fix's folder: the note's moment before and after. */
export const FIX_COMPARE_FILES = ['before.png', 'after.png'] as const;
export const fixCompareFileSchema = z.enum(FIX_COMPARE_FILES);
export type FixCompareFile = z.infer<typeof fixCompareFileSchema>;

/**
 * One fix of one note, as the server sends it: a row of `quick_fixes`. The steps of the run, from
 * its tool calls, are Reading the edit (0) → Changing the <kind> (1) → Checking it (2) → Looking at
 * the frames (3).
 */
export const quickFixSchema = z.object({
  /** A uuid; its folder is edit/review/fixes/<id>/. */
  id: z.string().min(1),
  jobId: z.string().min(1),
  noteId: z.string().min(1),
  /** The round its note will be stamped with: `job.round + 1`. */
  round: z.number().int().positive(),
  status: fixStatusSchema,
  /** 0–3 while the run is on; `null` before it starts and once it has ended. */
  step: z.number().int().min(0).max(3).nullable(),
  /** The words of the step ("Changing the caption font"); `null` when there is no step. */
  stepLabel: z.string().min(1).nullable(),
  /** The run's reply to the owner, once fixed ("The captions are Heebo Bold now."); else `null`. */
  said: z.string().min(1).nullable(),
  /** Why it could not be done here (escalated, failed); else `null`. */
  why: z.string().min(1).nullable(),
  /** What the run used: the `claude --model` and `--effort`. */
  model: z.string().min(1),
  effort: effortSchema,
  /** When the run started; `null` while the fix is queued. */
  startedAt: isoTimestampSchema.nullable(),
  /** When the fix ended, fixed or not; `null` while it has not. */
  endedAt: isoTimestampSchema.nullable(),
  /** `endedAt` − `startedAt` in seconds; `null` until it ends (and for a fix that never started). */
  durationSec: z.number().nonnegative().nullable(),
  /** Whether before.png and after.png both exist, so Compare can be offered. */
  hasCompare: z.boolean(),
});
export type QuickFix = z.infer<typeof quickFixSchema>;

// --- limits and texts ----------------------------------------------------------------------------

export const FIX_LIMITS = {
  /** A fix run is stopped after this many seconds (4 minutes). */
  runSec: 240,
  /** The router gets this long to sort one note; one retry, then the note is `full`. */
  routeSec: 20,
  /** Jobs that fix at the same time. */
  jobsAtOnce: 2,
} as const;

export const FIX_MESSAGES = {
  /** 409, an action that must wait while a fix runs (Approve, Send, Export MP4, music, going back to an earlier cut, Undo). */
  busy: 'A quick fix is running. Wait for it to finish.',
  /** 409, Undo on a fix that is not the newest fixed one (fixes edit the same files). */
  notNewest: 'Only the newest fix can be undone.',
  /** 409, editing the text of a note a fix has been made for. */
  editFixed: 'Undo the fix before changing this note.',
  /** 409, deleting a fixed note that is not the newest fix. */
  deleteFixed: 'Only the newest fix can be deleted; it is undone first.',
  /** 404, any fix route while the `quickFixes` switch is off. */
  off: 'Quick fixes are off.',
  /** 409, Send when every unsent note is already fixed in Review (QF4): nothing is left for a revise run. */
  onlyFixed: 'Every note is already fixed here. Approve instead.',
  /** 409, Send while Auto is still reading a note (QF4): the run's tier depends on the answer. */
  waitForAuto: 'Wait for Auto to read the notes.',
  /** 409, `PUT /api/jobs/:id/review-effort` for a job that is not in Review (QF4). */
  effortNotInReview: "Review's effort can only be changed while the job is in Review.",
} as const;

// --- wire shapes ---------------------------------------------------------------------------------

/** `GET /api/jobs/:id/fixes`: the fixes of the job's next round (`job.round + 1`), oldest first. */
export const jobFixesResponseSchema = z.object({ fixes: z.array(quickFixSchema) });
export type JobFixesResponse = z.infer<typeof jobFixesResponseSchema>;

/** `POST /api/jobs/:id/fixes/:fixId/undo`: the fix, now `undone`, and the job. */
export const undoFixResponseSchema = z.object({ fix: quickFixSchema, job: jobSchema });
export type UndoFixResponse = z.infer<typeof undoFixResponseSchema>;

/** The choices of the Effort menu in Review: Auto first, then the three levels. */
export const REVIEW_EFFORT_CHOICES = ['auto', ...EFFORT_LEVELS] as const;
export const reviewEffortChoiceSchema = z.enum(REVIEW_EFFORT_CHOICES);
export type ReviewEffortChoice = z.infer<typeof reviewEffortChoiceSchema>;

/** `PUT /api/jobs/:id/review-effort` body: `auto` saves `Job.reviewEffort` as `null`, a level as itself. */
export const reviewEffortRequestSchema = z.object({ effort: reviewEffortChoiceSchema });
export type ReviewEffortRequest = z.infer<typeof reviewEffortRequestSchema>;
