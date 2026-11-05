import type { GenerateState } from '@studio/shared';
import type { Config } from '../config.js';
import type { GenerateRepository } from '../db/generate-repository.js';
import { BriefStep, type BriefStepOptions } from './brief-step.js';
import { ClaudeBriefWriter } from './claude-brief.js';
import { ClaudeGenerateWriter } from './claude-generate.js';
import type { RunnerLogger } from './claude-process.js';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claude-runner.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FakeGenerateWriter } from './fake-generate.js';
import { createFakeRunner, fakeSpeedFromEnv } from './fake-runner.js';
import { GenerateStep } from './generate-step.js';
import type { Runner } from './runner.js';
import { createVoiceTranscriber, type VoiceTranscriber } from './voice-transcriber.js';

/** Thrown by `createRunner` for a runner that has not been written yet. */
export class RunnerUnavailableError extends Error {
  readonly runner: Config['runner'];

  constructor(runner: Config['runner'], workItem: string) {
    super(
      `The "${runner}" runner is not available yet (${workItem}). Set "runner" in ~/.studio-engine/config.json or STUDIO_RUNNER to another one.`,
    );
    this.name = 'RunnerUnavailableError';
    this.runner = runner;
  }
}

/**
 * The runner `config.runner` names. E3 provides the real `claude -p` runner; the fake one (E7,
 * for development and tests) needs the inbox to find job folders and reads `STUDIO_FAKE_SPEED`.
 * `config.review` (the Review switch) is optional so a config built without it is valid; both
 * runners read it to know whether an edit run ends in Review (W2). `config.graphicsInEdits` (with
 * `config.graphics`) is optional the same way: the Claude runner tells the run about the Graphics
 * library when both are on. So is `config.music` (the Soundtrack switch): the Claude runner gives
 * the prompts their music part while it is on, and the fake runner makes music v1 with the music
 * script's fake path (step 6) and plays it in its composition. `config.quickFixes` is optional the same
 * way: the Claude runner then takes a revise run's model, effort and self-check from the job's
 * review effort or the tier its Send saved (QF4). `config.songs` and `config.songTools` are optional
 * the same way: the Claude runner then adds the song lines to the music parts of its prompts and gives
 * the run the song command's tools (SG4); the Brief step reads `config.songs` too (`createBriefStep`).
 * `config.stock` (the Stock switch) is optional the same way: the Claude runner then tells edit and
 * revise runs about the stock script and gives them the env file's path (ST4). `config.draftChat`
 * (Draft & chat) is optional the same way: the Claude runner then runs an edit as the Draft (DR4).
 */
export function createRunner(
  config: Pick<
    Config,
    'runner' | 'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin' | 'model' | 'runTimeoutMin'
  > &
    Partial<
      Pick<
        Config,
        'review' | 'graphics' | 'graphicsInEdits' | 'music' | 'quickFixes' | 'songs' | 'stock'
      >
    > &
    Partial<Pick<Config, 'songTools' | 'claudePlanOnly' | 'draftChat' | 'generate'>>,
  /** For the claude runner: its logger and the progress tracker hook (E4). */
  options: Pick<ClaudeRunnerOptions, 'logger' | 'track'> = {},
): Runner {
  switch (config.runner) {
    case 'claude':
      return new ClaudeRunner({ config, ...options });

    case 'fake':
      // The fake runner gets the song a brief asks for with the music script's `song` command, so
      // it reads `config.songs` too (SG12).
      return createFakeRunner(config);
  }
}

/**
 * The Brief step (B4) that goes with the runner `config.runner` names: the Claude Brief run for
 * `claude`, the fake one (at `STUDIO_FAKE_SPEED`) for `fake`. The engine-owned part (fingerprint,
 * reuse, skip, validation, brief.md) is the same for both.
 */
export function createBriefStep(
  config: Pick<
    Config,
    'runner' | 'inboxPath' | 'exportsDir' | 'logsDir' | 'dataDir' | 'claudeBin'
  > &
    Partial<Pick<Config, 'music' | 'songs' | 'generate' | 'claudePlanOnly' | 'draftChat'>>,
  options: {
    logger?: RunnerLogger;
    env?: Record<string, string | undefined>;
    /** Where an episode finds its series (`BriefStepOptions.series`). */
    series?: BriefStepOptions['series'];
    /** The Graphics library for edits (`BriefStepOptions.graphics`); left out, edits get none. */
    graphics?: BriefStepOptions['graphics'];
  } = {},
): BriefStep {
  const writer =
    config.runner === 'claude'
      ? new ClaudeBriefWriter({ config, logger: options.logger })
      : new FakeBriefWriter({
          speed: fakeSpeedFromEnv(options.env),
          generate: config.generate === true,
          // Music only when asked (U21): the canned brief asks for music when the instructions do.
          music: config.music === true,
        });
  return new BriefStep({
    inboxPath: config.inboxPath,
    exportsDir: config.exportsDir,
    writer,
    logger: options.logger,
    series: options.series,
    graphics: options.graphics,
    // Music only when asked (U21): brief.md says whether music was asked for.
    music: config.music === true,
    // Songs: the pictures attached to a note are part of what the brief reads (SG5).
    songs: config.songs === true,
    // Generated videos: zips are unpacked and the four Generated-video keys are kept (GN4).
    generate: config.generate === true,
    // Draft & chat: a job with footage has no Brief run; the Draft reads the instructions (DR4).
    draft: config.draftChat === true,
  });
}

/**
 * The Generate step (Generated videos, GN5) that goes with the runner `config.runner` names: the
 * Claude Generate run for `claude`, the fake one (at `STUDIO_FAKE_SPEED`, calling the scripts' fake
 * path) for `fake`. The engine-owned part (the row, the History, the hand-off check, the footage
 * section) is the same for both. The engine builds it only while the Generate switch is on.
 */
export function createGenerateStep(
  config: Pick<
    Config,
    | 'runner'
    | 'inboxPath'
    | 'logsDir'
    | 'dataDir'
    | 'claudeBin'
    | 'model'
    | 'generateBudgetUsd'
    | 'generateVoiceId'
  > &
    Partial<Pick<Config, 'claudePlanOnly'>>,
  options: {
    repo: Pick<GenerateRepository, 'start' | 'update' | 'addVoiceChars' | 'get' | 'remove'>;
    /** Told whenever a job's Generate row changes (the engine publishes `job.generate`). */
    onChanged?: (jobId: string, state: GenerateState) => void;
    logger?: RunnerLogger;
    env?: Record<string, string | undefined>;
  },
): GenerateStep {
  const writer =
    config.runner === 'claude'
      ? new ClaudeGenerateWriter({
          config,
          inboxPath: config.inboxPath,
          logger: options.logger,
          env: options.env,
        })
      : new FakeGenerateWriter({ speed: fakeSpeedFromEnv(options.env) });
  return new GenerateStep({
    inboxPath: config.inboxPath,
    repo: options.repo,
    budgetUsd: config.generateBudgetUsd,
    writer,
    onChanged: options.onChanged,
    logger: options.logger,
  });
}

/**
 * The voice-note transcriber (W6) that goes with the runner `config.runner` names: the fake one
 * (at `STUDIO_FAKE_SPEED`) for `fake`, video-use's real helper for `claude`. A bad
 * `STUDIO_FAKE_SPEED` throws, as for the runner.
 */
export function createTranscriber(
  config: Pick<Config, 'runner'>,
  options: {
    logger?: RunnerLogger;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {},
): VoiceTranscriber {
  return createVoiceTranscriber({
    kind: config.runner === 'fake' ? 'fake' : 'real',
    logger: options.logger,
    env: options.env,
    home: options.home,
    speed: config.runner === 'fake' ? fakeSpeedFromEnv(options.env) : undefined,
  });
}
