// Where a Generate stage stands, read from the files it leaves (Generated videos, GN5).
//
// The Generate run and the two scripts write into `<job>/edit/generate/`; those files are the truth
// about what was made, so the engine reads them instead of trusting what the run says. One look
// (`GenerateProgressReader.read`) gives the numbers the Jobs row and the job sheet show
// (`GenerateState`, minus the budget), plus what the History needs. It polls nothing by itself:
// the step calls it about once a second while the run goes, and once more when the run is over.
//
//   phase      plan      no plan.json yet
//              voice     the plan is there, voice.mp3 is not assembled yet
//              looks     the voice is assembled, a look of the cast is missing
//              keyframes the looks are done, a keyframe is missing
//              clips     the keyframes are done, a clip has no take yet
//              sound     every clip has a take, or the run handed off (it makes the effects, then ends)
//              (`done` is never read from the files: the step sets it once the hand-off is valid)
//   voice      lines of the plan with a take in voice/ (all of them once voice.mp3 is there)
//   looks      cast of the plan with a still in looks/
//   keyframes  files in keyframes/, out of one start frame per clip and an end frame where it has one
//   clips      clips of the plan with a take in clips/<id>/ (all of them once shots.json is valid)
//   spend      the entries of spend.json that were not refunded (never its `total` field)
//
// Every file may be half written when it is read (the run writes plan.json with its Write tool, a
// script rewrites spend.json), so a file that does not parse keeps the last good reading of it.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GENERATE_FILES,
  type GenerateCounts,
  type GeneratePhase,
  type GeneratePlan,
  type GenerateShots,
  type GenerateVoiceLine,
  generatePlanSchema,
  generateShotsSchema,
  spendTotal,
} from '@studio/shared';

/** One look at the Generate folder. */
export interface GenerateSnapshot {
  /** The stage the files show; never `done`. */
  readonly phase: Exclude<GeneratePhase, 'done'>;
  readonly counts: GenerateCounts;
  /** Higgsfield dollars: the entries of spend.json that were not refunded. */
  readonly spendUsd: number;
  /** The plan, or the last good reading of it; `null` before it is written. */
  readonly plan: GeneratePlan | null;
  /** shots.json when it parses and holds at least one shot; else `null`. */
  readonly shots: GenerateShots | null;
  /** The assembled voice's length in seconds, once voice.mp3 and voice-words.json are there. */
  readonly voiceSec: number | null;
  /** voice.mp3 and voice-words.json are both there. */
  readonly voiceAssembled: boolean;
  /** The highest take made of each clip, by clip id. */
  readonly clipTakes: ReadonlyMap<string, number>;
  /** The lines of the plan that have a take, by line id, with their takes in order. */
  readonly voiceTakes: ReadonlyMap<string, readonly number[]>;
  /** The names (without extension) of the stills in looks/, keyframes/ and the files of sfx/. */
  readonly looks: readonly string[];
  readonly keyframes: readonly string[];
  readonly sfx: readonly string[];
}

/** What the reader needs of the job's brief: the voiceover's lines (the plan's voice mirrors them). */
export interface GenerateProgressBrief {
  readonly voiceover?: { readonly lines: readonly Pick<GenerateVoiceLine, 'id' | 'text'>[] } | null;
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** "homeowner.png" is "homeowner". */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

const TAKE_FILE = /^(L[1-9]\d*)-take(\d+)\.mp3$/;
const CLIP_TAKE_FILE = /^take-(\d+)\.mp4$/;

/** The sum of a spend.json's entries that were not refunded; `null` when the file is not a spend list. */
export function spendOf(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const entries = (json as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const counted: { usd: number; refunded: boolean }[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { usd, refunded } = entry as { usd?: unknown; refunded?: unknown };
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) {
      counted.push({ usd, refunded: refunded === true });
    }
  }
  return spendTotal(counted);
}

/** The length in seconds a voice-words.json says: its `ms`, else the end of its last word. */
export function voiceSecondsOf(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const { ms, words } = json as { ms?: unknown; words?: unknown };
  if (typeof ms === 'number' && ms > 0) return Math.round(ms) / 1000;
  if (Array.isArray(words)) {
    let end = 0;
    for (const word of words) {
      const sec = (word as { endSec?: unknown } | null)?.endSec;
      if (typeof sec === 'number' && sec > end) end = sec;
    }
    return end > 0 ? end : null;
  }
  return null;
}

/** shots.json read from `editDir`: the hand-off with at least one shot, or `null`. */
export async function readShots(editDir: string): Promise<GenerateShots | null> {
  const json = await readJson(join(editDir, GENERATE_FILES.shots));
  const parsed = generateShotsSchema.safeParse(json);
  return parsed.success && parsed.data.shots.length > 0 ? parsed.data : null;
}

/**
 * Why shots.json is not a hand-off, in a plain sentence naming the file: it is missing, it is not
 * JSON, it is not the shape (the first issue), or it lists no shot. For the failure line of a run
 * that ended without one.
 */
export async function shotsProblem(editDir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(editDir, GENERATE_FILES.shots), 'utf8');
  } catch {
    return 'edit/generate/shots.json was not written.';
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'edit/generate/shots.json is not valid JSON.';
  }
  const parsed = generateShotsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? '' : ` (${issue.path.join('.')})`;
    return `edit/generate/shots.json doesn’t match its shape${where}: ${issue?.message ?? 'unknown problem'}.`;
  }
  return 'edit/generate/shots.json lists no shots.';
}

/** plan.json read from `editDir`, or `null` when it is missing or not a plan. */
export async function readPlan(editDir: string): Promise<GeneratePlan | null> {
  const parsed = generatePlanSchema.safeParse(await readJson(join(editDir, GENERATE_FILES.plan)));
  return parsed.success ? parsed.data : null;
}

/** Reads the Generate folder of one job, remembering the last good reading of plan.json and spend.json. */
export class GenerateProgressReader {
  private readonly generateDir: string;
  private readonly editDir: string;
  private plan: GeneratePlan | null = null;
  private spend = 0;

  constructor(editDir: string) {
    this.editDir = editDir;
    this.generateDir = join(editDir, GENERATE_FILES.dir);
  }

  async read(): Promise<GenerateSnapshot> {
    const dir = this.generateDir;

    const plan = await readPlan(this.editDir);
    if (plan !== null) this.plan = plan;
    const spent = spendOf(await readJson(join(this.editDir, GENERATE_FILES.spend)));
    if (spent !== null) this.spend = spent;
    const shots = await readShots(this.editDir);

    const voiceFiles = await listNames(join(dir, 'voice'));
    const voiceTakes = new Map<string, number[]>();
    for (const name of voiceFiles) {
      const match = TAKE_FILE.exec(name);
      if (match === null) continue;
      const id = match[1] as string;
      voiceTakes.set(
        id,
        [...(voiceTakes.get(id) ?? []), Number(match[2])].sort((a, b) => a - b),
      );
    }
    const voiceAssembled =
      (await isFile(join(this.editDir, GENERATE_FILES.voice))) &&
      (await isFile(join(this.editDir, GENERATE_FILES.voiceWords)));
    const voiceSec = voiceAssembled
      ? voiceSecondsOf(await readJson(join(this.editDir, GENERATE_FILES.voiceWords)))
      : null;

    const looks = (await listNames(join(dir, 'looks'))).map(stem);
    const keyframes = (await listNames(join(dir, 'keyframes'))).map(stem);
    const sfx = await listNames(join(dir, 'sfx'));

    const clipTakes = new Map<string, number>();
    for (const clipId of await listNames(join(dir, 'clips'))) {
      let top = 0;
      for (const name of await listNames(join(dir, 'clips', clipId))) {
        const match = CLIP_TAKE_FILE.exec(name);
        if (match !== null) top = Math.max(top, Number(match[1]));
      }
      if (top > 0) clipTakes.set(clipId, top);
    }

    const counts = this.countsOf({
      voiceTakes,
      voiceAssembled,
      looks,
      keyframes,
      clipTakes,
      shots,
    });
    return {
      phase: phaseOf(this.plan, voiceAssembled, counts, shots !== null),
      counts,
      spendUsd: this.spend,
      plan: this.plan,
      shots,
      voiceSec,
      voiceAssembled,
      clipTakes,
      voiceTakes,
      looks,
      keyframes,
      sfx,
    };
  }

  private countsOf(found: {
    voiceTakes: ReadonlyMap<string, readonly number[]>;
    voiceAssembled: boolean;
    looks: readonly string[];
    keyframes: readonly string[];
    clipTakes: ReadonlyMap<string, number>;
    shots: GenerateShots | null;
  }): GenerateCounts {
    const plan = this.plan;
    if (plan === null) {
      return {
        voice: { done: 0, total: 0 },
        looks: { done: 0, total: 0 },
        keyframes: { done: 0, total: 0 },
        clips: { done: 0, total: 0 },
        belowBar: 0,
      };
    }
    const voiceTotal = plan.voice.length;
    const voiceDone = found.voiceAssembled
      ? voiceTotal
      : plan.voice.filter((line) => found.voiceTakes.has(line.id)).length;

    const lookTotal = plan.cast.length;
    const lookDone = plan.cast.filter((cast) => found.looks.includes(cast.id)).length;

    // A scene with no start frame (text to video, U31) waits for no keyframe.
    const keyframeTotal = plan.clips.reduce(
      (sum, clip) => sum + (clip.start === null ? 0 : 1) + (clip.end === null ? 0 : 1),
      0,
    );
    const keyframeDone = Math.min(found.keyframes.length, keyframeTotal);

    const clipTotal = plan.clips.length;
    const clipDone =
      found.shots !== null
        ? clipTotal
        : plan.clips.filter((clip) => found.clipTakes.has(clip.id)).length;

    return {
      voice: { done: voiceDone, total: voiceTotal },
      looks: { done: lookDone, total: lookTotal },
      keyframes: { done: keyframeDone, total: keyframeTotal },
      clips: { done: clipDone, total: clipTotal },
      belowBar: found.shots === null ? 0 : found.shots.shots.filter((shot) => shot.belowBar).length,
    };
  }
}

function phaseOf(
  plan: GeneratePlan | null,
  voiceAssembled: boolean,
  counts: GenerateCounts,
  handedOff: boolean,
): Exclude<GeneratePhase, 'done'> {
  if (plan === null) return 'plan';
  // A hand-off is the end of the shots whatever was left out on the way (a clip cut to a still).
  if (handedOff && voiceAssembled) return 'sound';
  if (!voiceAssembled) return 'voice';
  if (counts.looks.done < counts.looks.total) return 'looks';
  if (counts.keyframes.done < counts.keyframes.total) return 'keyframes';
  if (counts.clips.done < counts.clips.total) return 'clips';
  return 'sound';
}

/** Whether two snapshots show the same numbers (what the row stores), so an unchanged look makes no write. */
export function sameProgress(a: GenerateSnapshot | null, b: GenerateSnapshot): boolean {
  if (a === null) return false;
  return (
    a.phase === b.phase &&
    a.spendUsd === b.spendUsd &&
    JSON.stringify(a.counts) === JSON.stringify(b.counts)
  );
}
