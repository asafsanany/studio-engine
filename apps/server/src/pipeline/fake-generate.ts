// The fake Generate run (Generated videos, GN5): the Generate stage's writer under
// `STUDIO_RUNNER=fake`. Like the fake edit runner it asks no model and spends nothing, but it makes
// the files a real run makes, in the same order, by calling the SAME two scripts with their fake
// path (STUDIO_GENERATE_FAKE=1: tiny placeholder files, no key, no network), so dev, tests and e2e
// go through the whole stage (the progress, the spend ledger, the History, the hand-off, the
// footage section) with no service and no cent.
//
//   plan       reference.md and plan.json: the brief's voice lines word for word, a cast of three,
//              six clips of four seconds (A to F) over the voice, one of them with an end frame
//   voice      one `line` and one `check` per voice line, then `assemble` (1 s a line, no service)
//   estimate   one take of every clip plus the stills, free; over the budget the stage stops with
//              over_budget, after the voice and before any look
//   looks      one still per cast
//   keyframes  a start frame per clip and the end frame of the one that has it
//   clips      one take each; clip B always "fails its check": it is retaken on the other tier when
//              the budget allows, and kept below the bar when it does not (the budget ran out, which
//              is not a failure)
//   sound      one sound effect (alert)
//   hand-off   shots.json in the order to cut them (the engine copies the kept takes to shots/)
//
// Pace: about 26 s at speed 1 (`STUDIO_FAKE_SPEED` divides it), spread over the steps, so the Jobs
// row moves through voice 1/7 … clips 6/6 as a real run's does.
//
// Failure injection: a file named `.fail-at-generate` in the JOB folder (not in edit/) makes the
// scripts fail the way a service does. Its text is `[code] [after=N] [voice]`: the error code
// (default balance_empty), `after=N` lets N requests that spend succeed first, and `voice` makes
// the voice script fail instead of the shots script. Remove the file and press Retry to see the
// stage carry on from what was made: nothing made is made again, and nothing is charged twice.
//
// It keeps what exists, like the real stage: a voice take, a still, a clip that is on disk is not
// asked for again, and a plan whose voice lines are still the brief's is kept.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type Brief,
  clipTakeFile,
  GENERATE_ERROR_CODES,
  GENERATE_FILES,
  type GenerateClip,
  type GenerateErrorCode,
  type GeneratePlan,
  type GenerateService,
  type GenerateShots,
  generateErrorMessage,
  type Job,
  spendTotal,
} from '@studio/shared';
import { execa } from 'execa';
import { GENERATE_ASSETS } from '../generate/generate-assets.js';
import { changedVoiceLines } from '../generate/generate-existing.js';
import { readPlan } from '../generate/generate-progress.js';
import { childEnv } from './claude-command.js';
import { realSleep, type Sleep } from './fake-runner.js';
import type {
  GenerateRefusal,
  GenerateWrite,
  GenerateWriteOutcome,
  GenerateWriter,
} from './generate-step.js';

/** The marker that makes the fake stage's scripts fail. */
export const FAIL_AT_GENERATE = '.fail-at-generate';

/** How long each part takes at speed 1, in milliseconds (the whole stage is about 26 s). */
export const FAKE_GENERATE_MS = {
  plan: 2_000,
  voice: 6_000,
  looks: 3_000,
  keyframes: 4_000,
  clips: 9_000,
  sound: 2_000,
} as const;

/** The seconds each fake clip is made at. */
export const FAKE_CLIP_SECONDS = 4;

/** The clip that always fails its first check, so a retake (or the budget running out) shows. */
export const FAKE_WEAK_CLIP = 'B';

/** The fake shots script's steady prices (make-shots-fake.mjs): a still, and a second of clip. */
const STILL_USD = 0.004;
const CLIP_USD_PER_SECOND = 0.036;

const FALLBACK_LINES = [
  'This is a stand-in voice line.',
  'The fake stage made it without a service.',
  'Nothing was spent.',
];

const KLING = 'kling-video/v2.5-turbo/standard/image-to-video';
const WAN = 'alibaba/wan-3.0/image-to-video';

export interface FakeGenerateWriterOptions {
  /** How much faster than the default pace to go. Above 0. */
  speed?: number;
  /** Replaces the waiting, for tests. */
  sleep?: Sleep;
  /** The scripts to call (default the engine's own); tests point them elsewhere. */
  scripts?: { voice: string; shots: string };
}

const STOPPED: GenerateWriteOutcome = { ok: false, error: 'The fake Generate run was stopped.' };

/** `[code] [after=N] [voice]` of a `.fail-at-generate` marker. */
export interface InjectedFailure {
  code: GenerateErrorCode;
  after: number;
  service: 'voice' | 'shots';
}

export function parseInjectedFailure(text: string): InjectedFailure {
  const failure: InjectedFailure = { code: 'balance_empty', after: 0, service: 'shots' };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((GENERATE_ERROR_CODES as readonly string[]).includes(word)) {
      failure.code = word as GenerateErrorCode;
    } else if (/^after=\d+$/.test(word)) {
      failure.after = Number(word.slice('after='.length));
    } else if (word === 'voice') {
      failure.service = 'voice';
    }
  }
  return failure;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** The voice lines of the brief, or a few stand-ins for a brief with no script. */
function voiceLines(
  brief: Pick<Brief, 'voiceover'>,
): { id: string; text: string; direction: string | null }[] {
  const lines = brief.voiceover?.lines ?? [];
  if (lines.length > 0) return lines.map((line) => ({ ...line }));
  return FALLBACK_LINES.map((text, index) => ({ id: `L${index + 1}`, text, direction: null }));
}

/**
 * The plan the fake run makes for a brief: its voice lines, a cast of three (the homeowner, the
 * technician, the hero skylight) and six clips of four seconds over the voice, one of them (`E`) with an
 * end frame. The windows split the voice (a second a line) evenly.
 */
export function fakePlan(brief: Pick<Brief, 'voiceover'>): GeneratePlan {
  const voice = voiceLines(brief);
  const slice = Math.max(voice.length, 6) / 6;
  const tiers = ['easy', 'people', 'easy', 'people', 'tilt', 'easy'] as const;
  const shows = [
    'the hero skylight',
    'the homeowner at the skylight',
    'the flashlight inside the unit',
    'the squeegee press',
    'the tilt up to the skylight',
    'the sleeping man',
  ];
  const clips: GenerateClip[] = 'ABCDEF'.split('').map((id, index) => ({
    id,
    covers: [
      {
        beat: `beat ${index + 1}`,
        startSec: Number((index * slice).toFixed(3)),
        endSec: Number(((index + 1) * slice).toFixed(3)),
      },
    ],
    shows: shows[index] as string,
    tier: tiers[index] as GenerateClip['tier'],
    seconds: FAKE_CLIP_SECONDS,
    start: { prompt: `start frame of clip ${id}, face fully in frame`, file: null },
    end: id === 'E' ? { prompt: 'the skylight, centred', file: null } : null,
    references: [],
    prompt: `${shows[index]}, slow move`,
  }));
  return {
    voice,
    cast: [
      {
        id: 'homeowner',
        kind: 'person',
        name: 'the homeowner',
        look: 'a man in their fifties in a grey sweater',
        prompt: 'a man in their fifties in a grey sweater, face fully in frame',
        references: [],
      },
      {
        id: 'technician',
        kind: 'person',
        name: 'the technician with the logo',
        look: 'a technician in a blue shirt with the logo',
        prompt: 'a technician in a blue shirt with a logo, face fully in frame',
        references: [],
      },
      {
        id: 'hero-skylight',
        kind: 'prop',
        name: 'the hero skylight',
        look: 'a white skylight',
        prompt: 'a white skylight, centred',
        references: [],
      },
    ],
    clips,
  };
}

/** What a script call came to: its answer line, loosely read. */
interface ScriptCall {
  ok: boolean;
  code: GenerateErrorCode | 'pending' | null;
  message: string | null;
  needUsd?: number;
  budgetUsd?: number;
  usd?: number;
  characters?: number;
}

export class FakeGenerateWriter implements GenerateWriter {
  private readonly speed: number;
  private readonly sleep: Sleep;
  private readonly scripts: { voice: string; shots: string };

  constructor({ speed = 1, sleep = realSleep, scripts }: FakeGenerateWriterOptions = {}) {
    if (!(Number.isFinite(speed) && speed > 0)) {
      throw new RangeError(
        `The fake Generate run's speed must be a number above 0 (got ${speed}).`,
      );
    }
    this.speed = speed;
    this.sleep = sleep;
    this.scripts = scripts ?? { voice: GENERATE_ASSETS.voice, shots: GENERATE_ASSETS.shots };
  }

  async write(_job: Job, run: GenerateWrite): Promise<GenerateWriteOutcome> {
    const { jobDir, editDir, brief, budgetUsd, signal } = run;
    const dir = join(editDir, GENERATE_FILES.dir);
    const injected = await this.injectedFailure(jobDir);
    const voiceEnv = this.envFor(injected, 'voice');
    const shotsEnv = this.envFor(injected, 'shots');
    const pause = async (ms: number): Promise<boolean> => {
      await this.sleep(ms / this.speed, signal);
      return signal.aborted;
    };
    const stop = (call: ScriptCall, service: GenerateService): GenerateWriteOutcome => {
      const code = call.code === 'pending' || call.code === null ? 'bad_request' : call.code;
      const refusal: GenerateRefusal = {
        code,
        service,
        ...(call.needUsd === undefined ? {} : { needUsd: call.needUsd }),
        ...(call.budgetUsd === undefined ? {} : { budgetUsd: call.budgetUsd }),
      };
      const message = call.message ?? generateErrorMessage(code, { service });
      return { ok: false, error: message, blocked: message, refusal };
    };

    // --- plan ---------------------------------------------------------------------------------
    if (await pause(FAKE_GENERATE_MS.plan)) return STOPPED;
    let plan = await readPlan(editDir);
    if (plan === null || changedVoiceLines(plan, brief).length > 0) {
      // A plan that exists keeps its cast and clips; only a script that changed is written again.
      const next = fakePlan(brief);
      plan = plan === null ? next : { ...plan, voice: next.voice };
      await writeAtomic(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    }
    if (!(await exists(join(dir, 'reference.md')))) {
      await writeAtomic(
        join(dir, 'reference.md'),
        '# Reference\n\nA stand-in: the fake Generate run watched nothing.\n',
      );
    }

    // --- voice --------------------------------------------------------------------------------
    const picks: string[] = [];
    const perLine = FAKE_GENERATE_MS.voice / Math.max(plan.voice.length, 1);
    const spoken = await this.spokenTexts(dir);
    for (const line of plan.voice) {
      if (await pause(perLine)) return STOPPED;
      let take = (await this.voiceTakes(dir, line.id)).at(-1) ?? 0;
      const upToDate = take > 0 && spoken.get(`${line.id}-take${take}`) === squash(line.text);
      if (!upToDate) {
        take += 1;
        const made = await this.callVoice(
          [
            'line',
            editDir,
            '--id',
            line.id,
            '--text',
            line.text,
            ...(line.direction ? ['--direction', line.direction] : []),
            '--take',
            String(take),
          ],
          voiceEnv,
          signal,
        );
        if (!made.ok) return stop(made, 'elevenlabs');
        run.addVoiceChars(made.characters ?? 0);
        const checked = await this.callVoice(
          ['check', editDir, '--file', `voice/${line.id}-take${take}.mp3`, '--text', line.text],
          voiceEnv,
          signal,
        );
        if (!checked.ok) return stop(checked, 'elevenlabs');
      }
      picks.push(`${line.id}:${take}`);
    }
    if (signal.aborted) return STOPPED;
    const assembled =
      (await exists(join(dir, 'voice.mp3'))) && (await exists(join(dir, 'voice-words.json')));
    if (!assembled || (await this.picksChanged(dir, picks))) {
      const done = await this.callVoice(
        ['assemble', editDir, '--order', picks.join(',')],
        voiceEnv,
        signal,
      );
      if (!done.ok) return stop(done, 'elevenlabs');
      await writeAtomic(join(dir, 'voice-picks.txt'), `${picks.join(',')}\n`);
    }

    // --- estimate: one take of every clip plus the stills, free; over the budget it stops here ----
    const stills =
      plan.cast.length + plan.clips.reduce((n, clip) => n + 1 + (clip.end === null ? 0 : 1), 0);
    let need = (await this.spent(dir)) + stills * STILL_USD;
    for (const clip of plan.clips) {
      if (await exists(join(dir, clipTakeFile(clip.id, 1)))) continue;
      const estimate = await this.callShots(
        [
          'estimate',
          editDir,
          '--kind',
          'clip',
          '--tier',
          clip.tier,
          '--seconds',
          String(clip.seconds),
        ],
        shotsEnv,
        signal,
      );
      if (!estimate.ok) return stop(estimate, 'higgsfield');
      need += estimate.usd ?? 0;
    }
    if (cents(need) > cents(budgetUsd)) {
      return stop(
        {
          ok: false,
          code: 'over_budget',
          message: generateErrorMessage('over_budget', { needUsd: need, budgetUsd }),
          needUsd: cents(need),
          budgetUsd,
        },
        'higgsfield',
      );
    }

    // --- looks and keyframes ------------------------------------------------------------------
    const budget = String(cents(budgetUsd));
    for (const cast of plan.cast) {
      if (await pause(FAKE_GENERATE_MS.looks / plan.cast.length)) return STOPPED;
      if (await this.hasStill(dir, 'looks', cast.id)) continue;
      const still = await this.callShots(
        [
          'still',
          editDir,
          cast.id,
          '--into',
          'looks',
          '--model',
          'soul',
          '--prompt',
          cast.prompt,
          '--budget',
          budget,
        ],
        shotsEnv,
        signal,
      );
      if (!still.ok) return stop(still, 'higgsfield');
    }
    const frames = plan.clips.flatMap((clip) => [
      ...(clip.start === null ? [] : [{ id: clip.id, prompt: clip.start.prompt }]),
      ...(clip.end === null ? [] : [{ id: `${clip.id}-end`, prompt: clip.end.prompt }]),
    ]);
    for (const frame of frames) {
      if (await pause(FAKE_GENERATE_MS.keyframes / frames.length)) return STOPPED;
      if (await this.hasStill(dir, 'keyframes', frame.id)) continue;
      const still = await this.callShots(
        [
          'still',
          editDir,
          frame.id,
          '--into',
          'keyframes',
          '--model',
          'soul',
          '--prompt',
          frame.prompt,
          '--budget',
          budget,
        ],
        shotsEnv,
        signal,
      );
      if (!still.ok) return stop(still, 'higgsfield');
    }

    // --- clips: one take each first, then the retake of the one that failed its check -----------
    const tiers = new Map<string, string>();
    for (const clip of plan.clips) {
      if (await pause(FAKE_GENERATE_MS.clips / plan.clips.length)) return STOPPED;
      tiers.set(clip.id, clip.tier);
      if ((await this.topTake(dir, clip.id)) > 0) continue;
      const made = await this.callClip(editDir, clip, 1, clip.tier, budget, shotsEnv, signal);
      if (!made.ok) return stop(made, 'higgsfield');
    }
    // Clip B's first take fails its check: it is retaken on the other tier when what is left of the
    // budget allows it, and kept below the bar when it does not (the budget ran out: not an error).
    const kept = new Map<string, { take: number; model: string; belowBar: boolean }>();
    for (const clip of plan.clips) {
      let take = await this.topTake(dir, clip.id);
      let belowBar = false;
      if (clip.id === FAKE_WEAK_CLIP) {
        if (take === 1) {
          const price = clip.seconds * CLIP_USD_PER_SECOND;
          if (cents((await this.spent(dir)) + price) > cents(budgetUsd)) {
            belowBar = true;
          } else {
            const made = await this.callClip(editDir, clip, 2, 'people', budget, shotsEnv, signal);
            if (made.ok) take = 2;
            else if (made.code === 'over_budget') belowBar = true;
            else return stop(made, 'higgsfield');
          }
        }
        if (take === 2) tiers.set(clip.id, 'people');
      }
      kept.set(clip.id, {
        take,
        model: tiers.get(clip.id) === 'easy' ? KLING : WAN,
        belowBar,
      });
    }

    // --- sound --------------------------------------------------------------------------------
    if (await pause(FAKE_GENERATE_MS.sound)) return STOPPED;
    if (!(await exists(join(dir, 'sfx', 'alert.mp3')))) {
      const sfx = await this.callVoice(
        ['sfx', editDir, '--id', 'alert', '--prompt', 'two short news alert pulses'],
        voiceEnv,
        signal,
      );
      if (!sfx.ok) return stop(sfx, 'elevenlabs');
    }

    // --- hand-off -----------------------------------------------------------------------------
    const shots: GenerateShots = {
      shots: plan.clips.map((clip) => {
        const choice = kept.get(clip.id) as { take: number; model: string; belowBar: boolean };
        return {
          id: clip.id,
          file: clipTakeFile(clip.id, choice.take),
          take: choice.take,
          windows: clip.covers.map((cover) => ({ startSec: cover.startSec, endSec: cover.endSec })),
          seconds: clip.seconds,
          shows: clip.shows,
          model: choice.model,
          usd: Number((clip.seconds * CLIP_USD_PER_SECOND).toFixed(3)),
          belowBar: choice.belowBar,
        };
      }),
    };
    await writeAtomic(join(dir, 'shots.json'), `${JSON.stringify(shots, null, 2)}\n`);
    return { ok: true, refusal: null };
  }

  // --- the scripts --------------------------------------------------------------------------------

  private async injectedFailure(jobDir: string): Promise<InjectedFailure | null> {
    try {
      return parseInjectedFailure(await readFile(join(jobDir, FAIL_AT_GENERATE), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The scripts' environment: the engine's minimal one, the fake switch, and the injected failure for its script. */
  private envFor(
    injected: InjectedFailure | null,
    script: 'voice' | 'shots',
  ): Record<string, string> {
    const env = childEnv({ home: process.env.HOME ?? '/', env: process.env });
    env.STUDIO_GENERATE_FAKE = '1';
    if (injected !== null && injected.service === script) {
      env.STUDIO_GENERATE_STUB_FAIL = injected.code;
      env.STUDIO_GENERATE_STUB_FAIL_AFTER = String(injected.after);
    }
    return env;
  }

  /** Runs one command of a script and reads the JSON line it prints (its last line that is one). */
  private async call(
    script: string,
    args: string[],
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ScriptCall> {
    const result = await execa(process.execPath, [script, ...args], {
      env,
      extendEnv: false,
      reject: false,
      cancelSignal: signal,
      stdin: 'ignore',
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    for (const text of stdout.split('\n').reverse()) {
      if (!text.trim().startsWith('{')) continue;
      try {
        const line = JSON.parse(text) as Record<string, unknown>;
        const number = (value: unknown): number | undefined =>
          typeof value === 'number' ? value : undefined;
        return {
          ok: line.ok === true,
          code: typeof line.code === 'string' ? (line.code as ScriptCall['code']) : null,
          message: typeof line.message === 'string' ? line.message : null,
          ...(number(line.needUsd) === undefined
            ? {}
            : { needUsd: number(line.needUsd) as number }),
          ...(number(line.budgetUsd) === undefined
            ? {}
            : { budgetUsd: number(line.budgetUsd) as number }),
          ...(number(line.usd) === undefined ? {} : { usd: number(line.usd) as number }),
          ...(number(line.characters ?? line.chars) === undefined
            ? {}
            : { characters: number(line.characters ?? line.chars) as number }),
        };
      } catch {
        // Not JSON: an earlier line.
      }
    }
    return { ok: false, code: 'bad_request', message: 'The fake script printed no answer.' };
  }

  private callVoice(args: string[], env: Record<string, string>, signal: AbortSignal) {
    return this.call(this.scripts.voice, args, env, signal);
  }

  private callShots(args: string[], env: Record<string, string>, signal: AbortSignal) {
    return this.call(this.scripts.shots, args, env, signal);
  }

  private callClip(
    editDir: string,
    clip: GenerateClip,
    take: number,
    tier: string,
    budget: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ) {
    return this.callShots(
      [
        'clip',
        editDir,
        clip.id,
        '--tier',
        tier,
        '--start',
        `keyframes/${clip.id}.png`,
        ...(clip.end === null ? [] : ['--end', `keyframes/${clip.id}-end.png`]),
        '--seconds',
        String(clip.seconds),
        '--prompt',
        clip.prompt,
        '--budget',
        budget,
        '--take',
        String(take),
      ],
      env,
      signal,
    );
  }

  // --- what is on disk ------------------------------------------------------------------------------

  private async names(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((name) => !name.startsWith('.')).sort();
    } catch {
      return [];
    }
  }

  private async voiceTakes(dir: string, id: string): Promise<number[]> {
    const takes: number[] = [];
    for (const name of await this.names(join(dir, 'voice'))) {
      const match = new RegExp(`^${id}-take(\\d+)\\.mp3$`).exec(name);
      if (match !== null) takes.push(Number(match[1]));
    }
    return takes.sort((a, b) => a - b);
  }

  /** The text each checked voice take was made from, from the words file `check` keeps: "L1-take1" → its text. */
  private async spokenTexts(dir: string): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (const name of await this.names(join(dir, 'voice'))) {
      if (!name.endsWith('.words.json')) continue;
      try {
        const words = JSON.parse(await readFile(join(dir, 'voice', name), 'utf8')) as {
          text?: string;
        };
        if (typeof words.text === 'string') {
          texts.set(name.slice(0, -'.words.json'.length), squash(words.text));
        }
      } catch {
        // A damaged words file: the take is made again.
      }
    }
    return texts;
  }

  /** Whether the assembled voice was made from other takes than these. */
  private async picksChanged(dir: string, picks: string[]): Promise<boolean> {
    try {
      return (await readFile(join(dir, 'voice-picks.txt'), 'utf8')).trim() !== picks.join(',');
    } catch {
      return true;
    }
  }

  private async hasStill(dir: string, folder: 'looks' | 'keyframes', id: string): Promise<boolean> {
    return (await this.names(join(dir, folder))).some(
      (name) => name.replace(/\.[^.]+$/, '') === id,
    );
  }

  private async topTake(dir: string, clipId: string): Promise<number> {
    let top = 0;
    for (const name of await this.names(join(dir, 'clips', clipId))) {
      const match = /^take-(\d+)\.mp4$/.exec(name);
      if (match !== null) top = Math.max(top, Number(match[1]));
    }
    return top;
  }

  /** The dollars in spend.json that were not refunded. */
  private async spent(dir: string): Promise<number> {
    try {
      const spend = JSON.parse(await readFile(join(dir, 'spend.json'), 'utf8')) as {
        entries?: { usd: number; refunded: boolean }[];
      };
      return spendTotal(spend.entries ?? []);
    } catch {
      return 0;
    }
  }
}
