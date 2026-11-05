// The Generate stage (Generated videos, GN5): between the Brief step and the edit run, for a job
// whose brief says `production: generate` while the Generate switch is on.
//
//   Brief ──► Generate ──► edit run (step 2, Transcribe … Review)
//
// The worker calls `GenerateStep.prepare(job, brief, context)` after the Brief step. A job that is
// being generated keeps `job.step` at 1 (Brief) the whole time; what it is doing is the `job_generate`
// row (`Job.generate`, `GET /api/jobs/:id/generate`, the `job.generate` event), and the row's text
// is also the step's sub-progress, so any screen that knows nothing of Generate still says
// "Generate · clips 4/6 · $1.65" under Brief. The stage is not timed as a step (the Brief's
// timing ended before it), so it never reaches the ETA of the edit steps.
//
// What the engine does, and what the run does:
//
//   - The RUN (a headless Claude session with the two scripts, `GenerateWriter`) plans the shots,
//     makes the voice, the stills and the clips, and hands off `edit/generate/shots.json`. The
//     engine does not decide any of it.
//   - The ENGINE reads the files the run and the scripts leave in `edit/generate/` about once a
//     second (generate-progress.ts) and keeps the row and the History (generate-history.ts) in step
//     with them: phase, counts, and the Higgsfield spend (the not-refunded entries of spend.json).
//     A long wait for a clip changes no file and is not a stall: nothing here times a silence.
//   - When the run ends, the hand-off is checked (a valid shots.json, every clip it names, the
//     assembled voice); the kept takes are copied into `generate/shots/<id>.mp4`, and the
//     "Generated footage" section is appended to brief.md (`appendGeneratedFootage`). Running out of
//     budget in the middle is not an error: the run finishes with its best takes and the clips below
//     the bar are `belowBar` in shots.json.
//   - A last line "Blocked: …" or a script's refusal (an empty Higgsfield balance, a key not
//     accepted, a budget the cheapest plan is over) fails the job at step 1 with the plain sentence
//     of `generateErrorMessage`, which `parseGenerateErrorMessage` reads back. The History gets a
//     `stopped` line.
//   - Retry and Resume run the stage again from what is on disk: a complete hand-off (and a plan
//     whose voice is still the brief's script) finishes it with no run at all, only the "Generated
//     footage" section written again (the Brief step wrote brief.md from scratch and dropped it);
//     otherwise the run is told what exists (`describeExisting`) and makes only what is missing.
//
// The step never sees a key: the run's environment holds the PATH of the env file and nothing else
// (claude-command.ts), and a spend is read from spend.json, not from any answer.

import { join } from 'node:path';
import {
  type Brief,
  formatRatioText,
  type GenerateErrorCode,
  type GenerateHistoryEvent,
  type GenerateService,
  type GenerateState,
  generateBudgetFor,
  generateErrorMessage,
  generateRowText,
  type Job,
  parseGenerateErrorMessage,
} from '@studio/shared';
import { type GenerateRepository, toGenerateState } from '../db/generate-repository.js';
import {
  changedVoiceLines,
  checkHandoff,
  describeExisting,
  materializeShots,
} from '../generate/generate-existing.js';
import { GenerateHistory } from '../generate/generate-history.js';
import {
  type GenerateProgressBrief,
  GenerateProgressReader,
  type GenerateSnapshot,
  sameProgress,
  shotsProblem,
} from '../generate/generate-progress.js';
import { appendGeneratedFootage, GeneratedFootageError } from '../generate/generated-footage.js';
import { errorText, type RunnerLogger, SILENT_LOGGER } from './claude-process.js';
import { trimMessage } from './failure.js';

/** The prefix of a Generate failure that has no code of its own. */
export const GENERATE_STOPPED = 'Generate stopped:';

/** How often the Generate folder is looked at while the run goes. */
export const GENERATE_POLL_MS = 1_000;

/** What the worker gives the stage for one go. */
export interface GenerateContext {
  /** Aborted when the user cancels the job or the engine shuts down. */
  readonly signal: AbortSignal;
  /**
   * The stage is running a Generate run: show this under Brief. Called as the numbers move, never
   * when the stage finishes from what is already there.
   */
  progress(sub: string): void;
}

export type GenerateOutcome =
  | { ok: true; source: 'ran' | 'reused' }
  /** Fails the job at step 1 with `error` (unless the run was aborted). */
  | { ok: false; error: string };

/** The Generate stage as the worker sees it. */
export interface GenerateRun {
  /** Makes sure the job's generated footage is there and handed off. Never rejects. */
  prepare(job: Job, brief: Brief, context: GenerateContext): Promise<GenerateOutcome>;
  /**
   * The job's new brief is not a generated video (its clips turned out to be in the client's
   * `_Shared`, say): its Generate row goes, so the job stops showing as Generated, unless the stage
   * already spent something on it. Answers whether the row went. Never throws.
   */
  forget?(job: Job): boolean;
}

/** A script's refusal the run saw: why a call that should have made something did not. */
export interface GenerateRefusal {
  code: GenerateErrorCode;
  service: GenerateService;
  needUsd?: number;
  budgetUsd?: number;
}

/** One run of a writer. */
export interface GenerateWrite {
  /** `<inbox>/<Client>/<Job>`. */
  readonly jobDir: string;
  /** `<jobDir>/edit`, what the scripts take. */
  readonly editDir: string;
  readonly brief: Brief;
  /** The job's budget in dollars. */
  readonly budgetUsd: number;
  /** Higgsfield dollars spent before this run (spend.json). */
  readonly spentUsd: number;
  /** What an earlier try made (`describeExisting`); empty for a first try. */
  readonly existing: string;
  readonly signal: AbortSignal;
  /** ElevenLabs characters a voice or sound-effect call used, from the script's answer. */
  addVoiceChars(chars: number): void;
}

export type GenerateWriteOutcome =
  /** The run ended normally; the step then checks the hand-off itself. */
  | { ok: true; refusal?: GenerateRefusal | null }
  | {
      ok: false;
      /** The line to show when nothing better is known (a stop, a timeout, a crash). */
      error: string;
      /** The run's last line after "Blocked:", when it ended that way. */
      blocked?: string | null;
      refusal?: GenerateRefusal | null;
    };

/** Makes the footage: the Claude Generate run (claude-generate.ts), or the fake one (fake-generate.ts). */
export interface GenerateWriter {
  /** Resolves once the run is over and nothing of it is left running. After an abort, whatever it returns is ignored. */
  write(job: Job, run: GenerateWrite): Promise<GenerateWriteOutcome>;
}

export interface GenerateStepOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  repo: Pick<GenerateRepository, 'start' | 'update' | 'addVoiceChars' | 'get' | 'remove'>;
  /** `Config.generateBudgetUsd`: a note's "budget $5" in the brief overrides it for one job. */
  budgetUsd: number;
  writer: GenerateWriter;
  /** Told whenever the row changes: the engine publishes `job.generate`. A throw is logged and ignored. */
  onChanged?: (jobId: string, state: GenerateState) => void;
  logger?: RunnerLogger;
  /** How often the folder is looked at during a run. Default 1 s. */
  pollIntervalMs?: number;
  clock?: () => Date;
}

/** The failure a run came to: the sentence, and the code it has when it is one of the known stops. */
export interface GenerateFailure {
  error: string;
  refusal: GenerateRefusal | null;
}

const OVER_BUDGET_TEXT = /needs? about \$?(\d+(?:\.\d+)?)\D+?budget (?:is|of) \$?(\d+(?:\.\d+)?)/i;

function refusalMessage(refusal: GenerateRefusal): string {
  return generateErrorMessage(refusal.code, {
    service: refusal.service,
    ...(refusal.needUsd === undefined ? {} : { needUsd: refusal.needUsd }),
    ...(refusal.budgetUsd === undefined ? {} : { budgetUsd: refusal.budgetUsd }),
  });
}

/**
 * The job's error for a run that did not hand off. A last line "Blocked: …" is read first: one of
 * the plain sentences of `generateErrorMessage` is kept as it is, "this video needs about $N; the
 * budget is $M" becomes the budget sentence, and any other reason after a refusal the run saw is
 * that refusal's sentence; a reason with no refusal behind it is shown as the run wrote it. With no
 * "Blocked:" line, a refusal the run saw explains the stop, else `fallback` does.
 */
export function generateFailure({
  blocked,
  refusal,
  fallback,
}: {
  blocked?: string | null;
  refusal?: GenerateRefusal | null;
  fallback: string;
}): GenerateFailure {
  const seen = refusal ?? null;
  if (blocked !== undefined && blocked !== null && blocked.trim() !== '') {
    const reason = blocked.trim();
    const parsed = parseGenerateErrorMessage(reason);
    if (parsed !== null) {
      return { error: reason, refusal: parsed };
    }
    const over = OVER_BUDGET_TEXT.exec(reason);
    if (over !== null) {
      const next: GenerateRefusal = {
        code: 'over_budget',
        service: 'higgsfield',
        needUsd: Number(over[1]),
        budgetUsd: Number(over[2]),
      };
      return { error: refusalMessage(next), refusal: next };
    }
    if (seen !== null) return { error: refusalMessage(seen), refusal: seen };
    return { error: trimMessage(`${GENERATE_STOPPED} ${reason}`), refusal: null };
  }
  if (seen !== null) return { error: refusalMessage(seen), refusal: seen };
  return { error: fallback, refusal: null };
}

const STOPPED: GenerateOutcome = { ok: false, error: `${GENERATE_STOPPED} it was stopped.` };

/** The stage: see the top of the file. */
export class GenerateStep implements GenerateRun {
  private readonly inboxPath: string;
  private readonly repo: GenerateStepOptions['repo'];
  private readonly budgetUsd: number;
  private readonly writer: GenerateWriter;
  private readonly onChanged: GenerateStepOptions['onChanged'];
  private readonly logger: RunnerLogger;
  private readonly pollIntervalMs: number;
  private readonly clock: () => Date;

  constructor(options: GenerateStepOptions) {
    this.inboxPath = options.inboxPath;
    this.repo = options.repo;
    this.budgetUsd = options.budgetUsd;
    this.writer = options.writer;
    this.onChanged = options.onChanged;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.pollIntervalMs = options.pollIntervalMs ?? GENERATE_POLL_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  async prepare(job: Job, brief: Brief, context: GenerateContext): Promise<GenerateOutcome> {
    try {
      const outcome = await this.run(job, brief, context);
      if (!outcome.ok && !context.signal.aborted) {
        this.logger.warn({ jobId: job.id, error: outcome.error }, 'generate failed');
      }
      return outcome;
    } catch (err) {
      if (context.signal.aborted) return STOPPED;
      this.logger.error({ jobId: job.id, err }, 'generate broke');
      return { ok: false, error: trimMessage(`${GENERATE_STOPPED} ${errorText(err)}`) };
    }
  }

  forget(job: Job): boolean {
    try {
      const row = this.repo.get(job.id);
      if (row === null) return false;
      if (row.spendUsd > 0 || row.elevenlabsChars > 0) {
        this.logger.info(
          { jobId: job.id, spendUsd: row.spendUsd, elevenlabsChars: row.elevenlabsChars },
          'generate: the brief is no longer a generated video; the stage is kept for what it spent',
        );
        return false;
      }
      const removed = this.repo.remove(job.id);
      if (removed) {
        this.logger.info({ jobId: job.id }, 'generate: the brief is no longer a generated video');
      }
      return removed;
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err },
        'generate: the stage could not be taken off the job',
      );
      return false;
    }
  }

  private async run(job: Job, brief: Brief, context: GenerateContext): Promise<GenerateOutcome> {
    const { signal } = context;
    if (signal.aborted) return STOPPED;
    const jobDir = join(this.inboxPath, job.relPath);
    const editDir = join(jobDir, 'edit');
    const budgetUsd = generateBudgetFor(brief.budgetUsd, this.budgetUsd);

    this.repo.start(job.id, budgetUsd);
    const history = new GenerateHistory(editDir);
    const earlier = await history.load();
    await this.announce(history, brief);
    const reader = new GenerateProgressReader(editDir);
    const first = await reader.read();

    // A complete hand-off of the brief's script: nothing to run. brief.md was written again from
    // scratch by the Brief step, so only its "Generated footage" section is put back.
    if (await this.isComplete(editDir, brief, first)) {
      this.logger.info({ jobId: job.id }, 'generate reused: the hand-off is complete');
      return this.finish(job, brief, editDir, history, reader, 'reused');
    }

    const existing = describeExisting(first, brief, { budgetUsd, history: earlier });
    const tracker = new StageTracker({
      jobId: job.id,
      reader,
      history,
      repo: this.repo,
      publish: (state) => this.publish(job.id, state),
      progress: (sub) => context.progress(sub),
      logger: this.logger,
      budgetUsd,
      clock: this.clock,
    });
    await tracker.once();

    const timer = setInterval(() => void tracker.poll(), this.pollIntervalMs);
    let written: GenerateWriteOutcome;
    try {
      written = await this.writer.write(job, {
        jobDir,
        editDir,
        brief,
        budgetUsd,
        spentUsd: first.spendUsd,
        existing,
        signal,
        addVoiceChars: (chars) => this.addVoiceChars(job.id, chars),
      });
    } catch (err) {
      written = { ok: false, error: trimMessage(`${GENERATE_STOPPED} ${errorText(err)}`) };
    } finally {
      clearInterval(timer);
      await tracker.idle();
    }
    if (signal.aborted) return STOPPED;
    await tracker.once();

    if (!written.ok) {
      return this.fail(
        job,
        history,
        generateFailure({
          blocked: written.blocked ?? null,
          refusal: written.refusal ?? null,
          fallback: written.error,
        }),
        budgetUsd,
      );
    }
    return this.finish(
      job,
      brief,
      editDir,
      history,
      reader,
      'ran',
      written.refusal ?? null,
      budgetUsd,
    );
  }

  /** The first lines of the History of a job that has none: what the brief decided. */
  private async announce(history: GenerateHistory, brief: Brief): Promise<void> {
    const at = this.clock().toISOString();
    const formats =
      brief.formats !== null && brief.formats.length >= 2
        ? brief.formats.map(formatRatioText)
        : null;
    await history.add({ kind: 'decided', at, formats });
    const unpacked = brief.files.filter((file) => file.path.startsWith('edit/brief/unzipped/'));
    if (unpacked.length > 0) {
      await history.add({ kind: 'unpacked', at, count: unpacked.length, what: '' });
    }
  }

  /** Whether `edit/generate/` already holds a hand-off the edit can cut, made for this brief's script. */
  private async isComplete(
    editDir: string,
    brief: GenerateProgressBrief,
    snapshot: GenerateSnapshot,
  ): Promise<boolean> {
    const { plan, shots } = snapshot;
    if (plan === null || shots === null) return false;
    if (changedVoiceLines(plan, brief).length > 0) return false;
    return (await checkHandoff(editDir, shots)).ok;
  }

  /** The run handed off (or the hand-off was there): check it, copy the kept takes, tell the edit. */
  private async finish(
    job: Job,
    brief: Brief,
    editDir: string,
    history: GenerateHistory,
    reader: GenerateProgressReader,
    source: 'ran' | 'reused',
    refusal: GenerateRefusal | null = null,
    budgetUsd: number = generateBudgetFor(brief.budgetUsd, this.budgetUsd),
  ): Promise<GenerateOutcome> {
    const snapshot = await reader.read();
    const { shots } = snapshot;
    if (shots === null) {
      const problem = await shotsProblem(editDir);
      return this.fail(
        job,
        history,
        generateFailure({ refusal, fallback: `${GENERATE_STOPPED} the run ended and ${problem}` }),
        budgetUsd,
      );
    }
    const handoff = await checkHandoff(editDir, shots);
    if (!handoff.ok) {
      return this.fail(
        job,
        history,
        generateFailure({
          refusal,
          fallback: trimMessage(`${GENERATE_STOPPED} ${handoff.problem}`),
        }),
        budgetUsd,
      );
    }
    try {
      await materializeShots(editDir, shots);
      await appendGeneratedFootage(editDir);
    } catch (err) {
      const reason = err instanceof GeneratedFootageError ? err.message : errorText(err);
      return this.fail(
        job,
        history,
        generateFailure({ refusal, fallback: trimMessage(`${GENERATE_STOPPED} ${reason}`) }),
        budgetUsd,
      );
    }

    const at = this.clock().toISOString();
    for (const shot of shots.shots) {
      await history.add({ kind: 'clip', at, id: shot.id, shows: shot.shows, take: shot.take });
    }
    await history.add({ kind: 'clips_done', at, count: shots.shots.length });
    for (const shot of shots.shots) {
      if (shot.belowBar) await history.add({ kind: 'budget', at, id: shot.id });
    }

    const row = this.repo.update(job.id, {
      phase: 'done',
      voice: snapshot.counts.voice,
      looks: snapshot.counts.looks,
      keyframes: snapshot.counts.keyframes,
      clips: { done: snapshot.counts.clips.total, total: snapshot.counts.clips.total },
      belowBar: snapshot.counts.belowBar,
      spendUsd: snapshot.spendUsd,
    });
    if (row !== null) this.publish(job.id, toGenerateState(row));
    return { ok: true, source };
  }

  /** A run that did not hand off: the stop goes in the History, the row keeps what was made. */
  private async fail(
    job: Job,
    history: GenerateHistory,
    failure: GenerateFailure,
    budgetUsd: number,
  ): Promise<GenerateOutcome> {
    const { refusal } = failure;
    if (refusal !== null) {
      const event: GenerateHistoryEvent = {
        kind: 'stopped',
        at: this.clock().toISOString(),
        code: refusal.code,
        service: refusal.service,
        ...(refusal.needUsd === undefined ? {} : { needUsd: refusal.needUsd }),
        ...(refusal.budgetUsd === undefined ? {} : { budgetUsd: refusal.budgetUsd }),
      };
      try {
        await history.add(event);
      } catch (err) {
        this.logger.warn({ jobId: job.id, err }, 'could not write the Generate History');
      }
    }
    // The money and the counts are as the last look left them; the budget is this job's own.
    this.repo.update(job.id, { budgetUsd });
    this.publishRow(job.id);
    return { ok: false, error: failure.error };
  }

  private addVoiceChars(jobId: string, chars: number): void {
    try {
      if (Number.isInteger(chars) && chars > 0) this.repo.addVoiceChars(jobId, chars);
    } catch (err) {
      this.logger.warn({ jobId, err }, 'could not count the voice characters');
    }
  }

  private publishRow(jobId: string): void {
    const row = this.repo.get(jobId);
    if (row !== null) this.publish(jobId, toGenerateState(row));
  }

  private publish(jobId: string, state: GenerateState): void {
    try {
      this.onChanged?.(jobId, state);
    } catch (err) {
      this.logger.warn({ jobId, err }, 'a listener of the Generate state threw');
    }
  }
}

interface TrackerDeps {
  jobId: string;
  reader: GenerateProgressReader;
  history: GenerateHistory;
  repo: GenerateStepOptions['repo'];
  publish: (state: GenerateState) => void;
  progress: (sub: string) => void;
  logger: RunnerLogger;
  budgetUsd: number;
  clock: () => Date;
}

/**
 * Looks at the Generate folder while the run goes and keeps the row, the History and the step's
 * text in step with it. Looks never overlap (`poll` is skipped while one is going), and a look that
 * fails is logged and forgotten: it never stops the run.
 */
class StageTracker {
  private readonly deps: TrackerDeps;
  private last: GenerateSnapshot | null = null;
  private busy: Promise<void> | null = null;

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  /** A look unless one is going. */
  poll(): Promise<void> {
    if (this.busy !== null) return this.busy;
    const look = this.look().finally(() => {
      this.busy = null;
    });
    this.busy = look;
    return look;
  }

  /** A look now, after the one that is going. */
  async once(): Promise<void> {
    if (this.busy !== null) await this.busy;
    await this.poll();
  }

  /** Waits for the look that is going. */
  async idle(): Promise<void> {
    if (this.busy !== null) await this.busy;
  }

  private async look(): Promise<void> {
    const { reader, jobId, repo, logger } = this.deps;
    try {
      const snapshot = await reader.read();
      if (!sameProgress(this.last, snapshot)) {
        const row = repo.update(jobId, {
          phase: snapshot.phase,
          voice: snapshot.counts.voice,
          looks: snapshot.counts.looks,
          keyframes: snapshot.counts.keyframes,
          clips: snapshot.counts.clips,
          belowBar: snapshot.counts.belowBar,
          spendUsd: snapshot.spendUsd,
        });
        if (row !== null) {
          const state = toGenerateState(row);
          this.deps.publish(state);
          this.deps.progress(generateRowText(state));
        }
      }
      await this.remember(snapshot);
      this.last = snapshot;
    } catch (err) {
      logger.warn({ jobId, err }, 'could not read the Generate folder');
    }
  }

  /** The History lines the folder shows now. */
  private async remember(snapshot: GenerateSnapshot): Promise<void> {
    const { history, clock } = this.deps;
    const { plan, counts } = snapshot;
    if (plan === null) return;
    const at = clock().toISOString();
    const events: GenerateHistoryEvent[] = [];
    if (snapshot.voiceAssembled) {
      events.push({ kind: 'voice', at, lines: plan.voice.length, seconds: snapshot.voiceSec ?? 0 });
    }
    if (counts.looks.total > 0 && counts.looks.done === counts.looks.total) {
      events.push({ kind: 'looks', at, names: plan.cast.map((cast) => cast.name) });
    }
    if (counts.keyframes.total > 0 && counts.keyframes.done === counts.keyframes.total) {
      events.push({ kind: 'keyframes', at, clips: plan.clips.length });
    }
    for (const clip of plan.clips) {
      const take = snapshot.clipTakes.get(clip.id);
      if (take !== undefined)
        events.push({ kind: 'clip', at, id: clip.id, shows: clip.shows, take });
    }
    for (const event of events) await history.add(event);
  }
}
