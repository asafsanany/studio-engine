// What the Generate run's script calls answered (Generated videos, GN5): the engine reads the JSON
// line each call of make-voice.mjs and make-shots.mjs prints, from the tool results in the run's
// stream, for two things it must know without asking the run:
//
//   - the ElevenLabs characters a voice take or a sound effect used (stored in the job's row), and
//   - a REFUSAL: a call that could not make what it was asked to because Higgsfield's balance is
//     empty, a key was not accepted, the budget is spent, or a service is down. If the run then
//     ends "Blocked:" (or without a hand-off), the refusal is the reason shown to the owner, in the
//     plain words of `generateErrorMessage`, whatever words the run used for it.
//
// A later call that worked clears the refusal of its own service: an hour of "Higgsfield is not
// answering" that went away is not why the video stopped. A `pending` answer from the shots script
// (a clip still being made; run the same command again) is neither a refusal nor a success.
//
// Only lines that parse with the shared schemas count; anything else in a tool result is ignored.
// Nothing here reads or keeps a key: the lines hold none.

import {
  type GenerateErrorCode,
  type GenerateService,
  makeShotsLineSchema,
  makeVoiceLineSchema,
} from '@studio/shared';
import type { GenerateRefusal } from '../pipeline/generate-step.js';

/** Which script a Bash call ran. */
export type GenerateScriptName = 'voice' | 'shots';

/** The script a Bash command runs, or `null` when it runs neither (the permission rules allow only these two). */
export function scriptOfCommand(command: string): GenerateScriptName | null {
  if (command.includes('make-voice.mjs')) return 'voice';
  if (command.includes('make-shots.mjs')) return 'shots';
  return null;
}

export type ScriptAnswer =
  /** A call that made something. `chars` is what ElevenLabs charged, when it is known. */
  | { kind: 'ok'; script: GenerateScriptName; chars: number }
  | { kind: 'refused'; script: GenerateScriptName; refusal: GenerateRefusal }
  /** A clip still being made: run the same command again. */
  | { kind: 'pending'; script: GenerateScriptName };

const SERVICES: Record<GenerateScriptName, GenerateService> = {
  voice: 'elevenlabs',
  shots: 'higgsfield',
};

/** Every answer line in a tool result's text, in order. */
export function readScriptAnswers(script: GenerateScriptName, text: string): ScriptAnswer[] {
  const answers: ScriptAnswer[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const answer = script === 'voice' ? voiceAnswer(json) : shotsAnswer(json);
    if (answer !== null) answers.push(answer);
  }
  return answers;
}

function refused(
  script: GenerateScriptName,
  code: GenerateErrorCode,
  extra: { needUsd?: number | undefined; budgetUsd?: number | undefined },
): ScriptAnswer {
  return {
    kind: 'refused',
    script,
    refusal: {
      code,
      service: SERVICES[script],
      ...(extra.needUsd === undefined ? {} : { needUsd: extra.needUsd }),
      ...(extra.budgetUsd === undefined ? {} : { budgetUsd: extra.budgetUsd }),
    },
  };
}

function voiceAnswer(json: unknown): ScriptAnswer | null {
  const parsed = makeVoiceLineSchema.safeParse(json);
  if (!parsed.success) return null;
  const line = parsed.data;
  if (!line.ok) return refused('voice', line.code, line);
  // A voice take and a sound effect are charged in characters; the check and the assembly are not.
  const chars =
    line.command === 'line'
      ? (line.characters ?? line.chars)
      : line.command === 'sfx'
        ? (line.characters ?? 0)
        : 0;
  return { kind: 'ok', script: 'voice', chars };
}

function shotsAnswer(json: unknown): ScriptAnswer | null {
  const parsed = makeShotsLineSchema.safeParse(json);
  if (!parsed.success) return null;
  const line = parsed.data;
  if (!line.ok) {
    if (line.code === 'pending') return { kind: 'pending', script: 'shots' };
    return refused('shots', line.code, line);
  }
  return { kind: 'ok', script: 'shots', chars: 0 };
}

/**
 * The refusal that still stands after these answers, in order: the latest refusal of each service
 * until a call of that service worked. At most one per service; the latest of the two is `latest`.
 */
export class RefusalLedger {
  private readonly standing = new Map<
    GenerateService,
    { refusal: GenerateRefusal; order: number }
  >();
  private order = 0;
  /** ElevenLabs characters the voice and sound-effect calls used, in all. */
  chars = 0;

  /** Takes in one answer. Returns the characters it used (0 for anything but a take or an effect). */
  take(answer: ScriptAnswer): number {
    this.order += 1;
    if (answer.kind === 'refused') {
      this.standing.set(answer.refusal.service, { refusal: answer.refusal, order: this.order });
      return 0;
    }
    if (answer.kind === 'pending') return 0;
    this.standing.delete(SERVICES[answer.script]);
    this.chars += answer.chars;
    return answer.chars;
  }

  /** The newest refusal that still stands, or `null`. */
  latest(): GenerateRefusal | null {
    let newest: { refusal: GenerateRefusal; order: number } | null = null;
    for (const entry of this.standing.values()) {
      if (newest === null || entry.order > newest.order) newest = entry;
    }
    return newest?.refusal ?? null;
  }
}
