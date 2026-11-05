// What a Generate stage finds when it starts again (Generated videos, GN5): the hand-off check, the
// kept shots, and the sentence that tells the run what is already made.
//
// A Retry or a Resume reuses the voice, the plan and every kept clip, the way music keeps its
// versions. The engine never decides to make something again; it checks what is on disk and
//   - when the hand-off is complete (a valid shots.json whose clips are there, the assembled voice,
//     a plan whose voice lines are still the brief's script), lets the stage finish without a run,
//   - otherwise tells the run what exists (`describeExisting`, the `{{> generate-existing}}` part of
//     the prompt), so it makes only what is missing.

import { copyFile, constants as fsConstants, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  budgetLeftUsd,
  budgetUsdText,
  GENERATE_FILES,
  type GenerateHistoryEvent,
  type GeneratePlan,
  type GenerateShots,
  generateStopReason,
  shotFile,
  spendUsdText,
} from '@studio/shared';
import type { GenerateProgressBrief, GenerateSnapshot } from './generate-progress.js';

/** The brief's voiceover lines, or none. */
export function briefVoiceLines(brief: GenerateProgressBrief): { id: string; text: string }[] {
  return (brief.voiceover?.lines ?? []).map((line) => ({ id: line.id, text: line.text }));
}

/**
 * A script line as it is compared: spacing, and the typography a copy may change (curly quotes,
 * dashes, the ellipsis character), flattened. Other words are other words: they remake the voice.
 */
const squash = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The ids of the voice lines whose words in the plan are not the brief's any more (or that the plan
 * lacks), so the voice has to be made again for them. A brief without a voiceover changes nothing.
 */
export function changedVoiceLines(
  plan: Pick<GeneratePlan, 'voice'>,
  brief: GenerateProgressBrief,
): string[] {
  const planned = new Map(plan.voice.map((line) => [line.id, squash(line.text)]));
  return briefVoiceLines(brief)
    .filter((line) => planned.get(line.id) !== squash(line.text))
    .map((line) => line.id);
}

/** The path of `file` inside `<editDir>/generate/`, or `null` for one that climbs out of it. */
function insideGenerate(editDir: string, file: string): string | null {
  const root = resolve(editDir, GENERATE_FILES.dir);
  const target = resolve(root, file);
  return target.startsWith(`${root}${sep}`) ? target : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether the run handed off something the edit can cut. */
export type Handoff = { ok: true } | { ok: false; problem: string };

/**
 * Checks a hand-off: every kept clip of `shots` is a file inside `generate/`, and the assembled
 * voice is there. The problem is plain words naming the file.
 */
export async function checkHandoff(editDir: string, shots: GenerateShots): Promise<Handoff> {
  for (const shot of shots.shots) {
    const path = insideGenerate(editDir, shot.file);
    if (path === null) {
      return {
        ok: false,
        problem: `shots.json names ${shot.file}, which is outside edit/generate/.`,
      };
    }
    if (!(await isFile(path))) {
      return {
        ok: false,
        problem: `shots.json names ${shot.file} for clip ${shot.id}, but that file is not there.`,
      };
    }
  }
  if (!(await isFile(join(editDir, GENERATE_FILES.voice)))) {
    return { ok: false, problem: 'edit/generate/voice.mp3 is not there.' };
  }
  if (!(await isFile(join(editDir, GENERATE_FILES.voiceWords)))) {
    return { ok: false, problem: 'edit/generate/voice-words.json is not there.' };
  }
  return { ok: true };
}

/**
 * Puts the kept take of every shot in `generate/shots/<id>.mp4`, the file the edit cuts (and the
 * brief's "Generated footage" names), from the `file` shots.json gives. A shot whose copy is
 * already the same file is left alone; one the run chose again is copied over, in one move. The
 * files `shots.json` names are checked first (`checkHandoff`).
 */
export async function materializeShots(editDir: string, shots: GenerateShots): Promise<void> {
  for (const shot of shots.shots) {
    const source = insideGenerate(editDir, shot.file);
    if (source === null) continue;
    const target = join(editDir, GENERATE_FILES.dir, shotFile(shot.id));
    const [from, to] = await Promise.all([stat(source), stat(target).catch(() => null)]);
    if (to?.isFile() && to.size === from.size && to.mtimeMs >= from.mtimeMs) continue;
    const staging = `${target}.copying`;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, staging, fsConstants.COPYFILE_FICLONE);
    await rename(staging, target);
  }
}

/** Seconds as "31.1 s". */
const secondsText = (sec: number): string => `${Math.round(sec * 10) / 10} s`;

const list = (items: readonly string[]): string => items.join(', ');

/** What the last stop was, from the History: "the Higgsfield balance is empty"; `null` for none. */
export function lastStopOf(events: readonly GenerateHistoryEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind !== 'stopped') continue;
    return generateStopReason(event.code, {
      ...(event.service === undefined ? {} : { service: event.service }),
      ...(event.needUsd === undefined ? {} : { needUsd: event.needUsd }),
      ...(event.budgetUsd === undefined ? {} : { budgetUsd: event.budgetUsd }),
    });
  }
  return null;
}

export interface ExistingOptions {
  /** The job's budget in dollars (the brief's, else the configured one). */
  budgetUsd: number;
  /** The History so far, for the reason the last try stopped. */
  history: readonly GenerateHistoryEvent[];
}

/**
 * The part of the Generate prompt that says what an earlier try already made and must not be made
 * again; empty for a first try (nothing in `edit/generate/` yet), which takes its line out of the
 * prompt. Plain sentences and a list, nothing the run could read as a command.
 */
export function describeExisting(
  snapshot: GenerateSnapshot,
  brief: GenerateProgressBrief,
  { budgetUsd, history }: ExistingOptions,
): string {
  const { plan } = snapshot;
  const made =
    plan !== null ||
    snapshot.voiceTakes.size > 0 ||
    snapshot.looks.length > 0 ||
    snapshot.keyframes.length > 0 ||
    snapshot.clipTakes.size > 0 ||
    snapshot.spendUsd > 0;
  if (!made) return '';

  const lines: string[] = [
    'An earlier try of this stage already made part of it. What is in ./edit/generate/ is kept: use it, never make it again, and make only what is missing.',
  ];
  const stop = lastStopOf(history);
  if (stop !== null) lines.push(`- That try stopped because ${stop}.`);

  if (plan !== null) {
    lines.push(
      `- The plan is plan.json (${plan.clips.length} clip${plan.clips.length === 1 ? '' : 's'}, ${plan.voice.length} voice line${plan.voice.length === 1 ? '' : 's'}, ${plan.cast.length} in the cast). Keep it; change it only where this try needs to.`,
    );
  }

  const taken = [...snapshot.voiceTakes].map(
    ([id, takes]) => `${id} (take${takes.length === 1 ? '' : 's'} ${takes.join(', ')})`,
  );
  if (snapshot.voiceAssembled) {
    const length = snapshot.voiceSec === null ? '' : `, ${secondsText(snapshot.voiceSec)}`;
    lines.push(
      `- The voice is made and assembled (voice.mp3 and voice-words.json${length}): ${list(taken)}.`,
    );
  } else if (taken.length > 0) {
    const missing =
      plan === null
        ? []
        : plan.voice.filter((line) => !snapshot.voiceTakes.has(line.id)).map((line) => line.id);
    lines.push(
      `- Voice lines made: ${list(taken)}.${missing.length > 0 ? ` Not made yet: ${list(missing)}.` : ''} The voice is not assembled yet.`,
    );
  }
  if (plan !== null) {
    const changed = changedVoiceLines(plan, brief);
    if (changed.length > 0) {
      lines.push(
        `- The script in brief.md changed since the plan: ${list(changed)} ${changed.length === 1 ? 'is' : 'are'} not the words in plan.json. Make ${changed.length === 1 ? 'that line' : 'those lines'} again as a new take, check ${changed.length === 1 ? 'it' : 'them'}, assemble the voice again, and set the clip windows from the new word times.`,
      );
    }
  }

  if (snapshot.looks.length > 0) lines.push(`- Looks made: ${list(snapshot.looks)}.`);
  if (snapshot.keyframes.length > 0) lines.push(`- Keyframes made: ${list(snapshot.keyframes)}.`);
  const clips = [...snapshot.clipTakes].map(([id, take]) => `${id} (take ${take})`);
  if (clips.length > 0) {
    const missing =
      plan === null
        ? []
        : plan.clips.filter((clip) => !snapshot.clipTakes.has(clip.id)).map((clip) => clip.id);
    lines.push(
      `- Clips made: ${list(clips)}.${missing.length > 0 ? ` No take yet: ${list(missing)}.` : ''} A take that is there is not made again (book answers reused with its file, and a booked take with a requestId and no file is a request still running: wait for it and save it); a retake is a new take number.`,
    );
  }
  if (snapshot.sfx.length > 0) lines.push(`- Sound effects made: ${list(snapshot.sfx)}.`);

  const left = budgetLeftUsd({ spendUsd: snapshot.spendUsd, budgetUsd });
  lines.push(
    `- Spent on Higgsfield so far: ${spendUsdText(snapshot.spendUsd)} of the ${budgetUsdText(budgetUsd)} budget, ${budgetUsdText(left)} left. It counts for every try of this video, review rounds included.`,
  );
  return lines.join('\n');
}
