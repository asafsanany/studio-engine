// The fake Brief run (B4): the Brief step's writer under `STUDIO_RUNNER=fake`. Like the fake edit
// runner it reads nothing and spends nothing: after about a second (divided by
// `STUDIO_FAKE_SPEED`) it has written a stand-in transcript for every audio file under
// edit/brief/transcripts/ and a canned draft in edit/brief.json, so dev, tests and e2e go through
// the same Brief step (fingerprint, validation, brief.md, progress) as a real run.
//
// `.fail-at-brief` in the job folder fails the step with "Brief failed: injected failure
// (.fail-at-brief)", even for a job whose brief would be reused or skipped.
//
// Songs (SG12): a picture attached to the note (edit/brief/from-you/, only listed while the Songs switch
// is on) is a screenshot of a reel, so the canned draft "reads" a song off it, as the real run would,
// for the fake music path (fake-music.ts) and the e2e specs to follow:
//   IMG_4412.PNG          the song of the boards: נתתי לך בית by Ofek Adanek (sped up)
//   a name with "trend"   no song named: music.wantsTrending (the editor picks a rising one)
//   a name with "fail"    a song the fake getter cannot get ("Fail Song"), so the fallback shows
//   a name with "original"  the label says "Original audio": music.original, no song
//
// Music only when asked (U21): with the music switch on (`music: true`) the canned draft reads the
// instructions the way the real Brief does, as far as a stand-in can: The owner's note and the job
// folder's text files. When they ask for music in so many words ("add music", "with a soundtrack") and
// no picture names a song, `music.wanted` is true and the fake edit makes music; otherwise it is
// false and the fake edit makes none ("Music was not asked for."). A "no music" or "without music"
// is not an ask.
//
// With the Generate switch on (`generate: true`, Generated videos · GN4) the canned brief also
// does what a real one would for a folder with a script and no footage, so dev, tests and e2e can
// drive a PINEWOOD-shaped job: a video under `reference/` or from an unpacked zip is a reference,
// never footage; with no footage and a voiceover script in a text file (the quoted block under a
// "… VOICEOVER SCRIPT" heading, one line per paragraph) it says `production: generate` and copies the
// script into `voiceover`; two or more sizes like "1080 × 1920" in the text are `formats`, and
// the first is the canvas; a phrase like "budget $5" in the owner's note is `budgetUsd`, as the real
// Brief reads it (GN10). Off, it is what it always was.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, parse } from 'node:path';
import {
  BRIEF_CANVASES,
  type BriefCanvas,
  type BriefDraft,
  type BriefFileRole,
  type Job,
} from '@studio/shared';
import { isReferencePath } from '../inbox/classify.js';
import {
  BRIEF_JSON_PATH,
  BRIEF_STEP,
  BRIEF_TRANSCRIPTS_PATH,
  type BriefFile,
  type BriefWrite,
  type BriefWriteOutcome,
  type BriefWriter,
} from './brief-step.js';
import { fakeTranscript } from './fake-content.js';
import { FAKE_STEP_MS, failMarkerName, realSleep, type Sleep } from './fake-runner.js';

export interface FakeBriefWriterOptions {
  /** How much faster than the default one second to go. Above 0. */
  speed?: number;
  /** Replaces the waiting, for tests. */
  sleep?: Sleep;
  /** The Generate switch: the canned brief is a generated one for a folder with a script and no footage. */
  generate?: boolean;
  /** The Soundtrack switch (U21): the canned brief asks for music when the note or a text file does. */
  music?: boolean;
}

/** Share of the step that goes by before an injected failure shows up (as in the fake runner). */
const FAILURE_AFTER = 0.4;

const STOPPED: BriefWriteOutcome = { ok: false, error: 'The fake brief was stopped.' };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** The song on the boards' screenshot (IMG_4412.PNG): what the fake Brief reads off a picture. */
export const FAKE_BRIEF_SONG = {
  title: 'נתתי לך בית',
  artist: 'Ofek Adanek',
  version: 'sped up',
} as const;

/** The song of a picture whose name has "fail": the fake getter (fake-e2e-songs.mjs) cannot get it. */
export const FAKE_BRIEF_UNGETTABLE_SONG = { title: 'Fail Song', artist: 'Nobody', version: null };

/** The account under an "Original audio" label on a picture whose name has "original". */
export const FAKE_BRIEF_ORIGINAL_BY = '@reels.creator';

/**
 * Whether the text (the owner's note and the folder's text files) asks for music to be made or added, the
 * way the real Brief reads `music.wanted`: "add music", "with a soundtrack", "תוסיפו מוזיקה". A "no
 * music" or "without music" is not an ask, and neither is any other mention of music.
 */
export function fakeMusicWanted(text: string | null): boolean {
  if (text === null) return false;
  if (
    /\b(?:no|without|never|skip|don['’]t|do not)\b[^.!?\n]{0,30}\b(?:music|soundtrack)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /\b(?:add|put|use|want|need|include|make|give|with)\b[^.!?\n]{0,40}\b(?:music|soundtrack)\b/i.test(
      text,
    ) || /מוזיקה/.test(text)
  );
}

/**
 * The music a canned draft asks for: what the first picture attached to the note says (a song, a
 * trending one or Original audio), else `wanted` music when the instructions ask for it, else
 * nothing.
 */
export function fakeBriefMusic(files: readonly BriefFile[], wanted = false): BriefDraft['music'] {
  const picture = files.find((file) => file.attached === true && file.kind === 'image');
  const music = {
    file: null,
    note: null,
    wanted: false,
    song: null,
    original: null,
    wantsTrending: false,
  };
  if (picture === undefined) return wanted ? { ...music, wanted: true } : null;
  const name = basename(picture.relPath);
  if (/original/i.test(name)) return { ...music, original: { by: FAKE_BRIEF_ORIGINAL_BY } };
  if (/trend/i.test(name)) return { ...music, wantsTrending: true };
  const song = /fail/i.test(name) ? FAKE_BRIEF_UNGETTABLE_SONG : FAKE_BRIEF_SONG;
  return { ...music, song: { ...song, link: null, fromFile: name } };
}

/** A file that is the client's reference, not footage: under `reference/` or unpacked from a zip. */
function isReference(file: Pick<BriefFile, 'relPath' | 'fromZip'>): boolean {
  return file.fromZip !== undefined || isReferencePath(file.relPath);
}

/** The role a file gets in the canned brief: by kind, as a first guess would. */
function roleOf(file: BriefFile, generate = false): BriefFileRole {
  switch (file.kind) {
    case 'video':
      return generate && isReference(file) ? 'reference' : 'footage';
    case 'audio':
    case 'doc':
      return 'instructions';
    case 'image':
      // A picture attached to the note is a screenshot to read, not a reference to match.
      if (file.attached === true) return 'instructions';
      return /logo/i.test(file.relPath) ? 'logo' : 'reference';
    case 'other':
      return 'ignore';
  }
}

/** The ratios a note can name, and the canvas each one is. */
const NOTE_RATIOS: Readonly<Record<string, BriefCanvas>> = {
  '9:16': '1080x1920',
  '16:9': '1920x1080',
  '1:1': '1080x1080',
  '4:5': '1080x1350',
};

/**
 * The formats a note explicitly asks for (Formats, GN7): two or more of 9:16, 16:9, 1:1 and 4:5 in
 * it, the first named as the main one. `null` otherwise, which is every note that names one size
 * or none, like the real Brief run. Lets dev and tests ask the fake runner for two formats.
 */
export function fakeFormats(note: string | null): BriefCanvas[] | null {
  const named: BriefCanvas[] = [];
  for (const match of (note ?? '').matchAll(/(?<![\d:])(9:16|16:9|1:1|4:5)(?![\d:])/g)) {
    const canvas = NOTE_RATIOS[match[1] ?? ''];
    if (canvas !== undefined && !named.includes(canvas)) named.push(canvas);
  }
  return named.length >= 2 ? named : null;
}

/**
 * The quoted voiceover script under a "… VOICEOVER SCRIPT" heading, one line per paragraph, or
 * `null`. The block opens with “ (or ") and closes with ” (or ") on its last paragraph.
 */
export function scriptLinesOf(text: string): string[] | null {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  // A heading is a short paragraph of its own, not a sentence that happens to say the words.
  const heading = paragraphs.findIndex(
    (paragraph) => paragraph.trim().length <= 60 && /voice-?over script/i.test(paragraph),
  );
  if (heading === -1) return null;
  const lines: string[] = [];
  for (const paragraph of paragraphs.slice(heading + 1)) {
    const line = paragraph.replace(/\s*\n\s*/g, ' ').trim();
    if (lines.length === 0) {
      if (!/^[“"]/.test(line)) return null;
      lines.push(line.slice(1));
    } else lines.push(line);
    const last = lines.at(-1) ?? '';
    if (/[”"]$/.test(last)) {
      lines[lines.length - 1] = last.slice(0, -1);
      return lines.filter((entry) => entry !== '');
    }
  }
  return null;
}

/**
 * The dollars the owner's note names as the budget for one generated video ("budget $5", "budget of
 * $0.50"), or `null`: the only place the real Brief reads `budgetUsd` from.
 */
export function fakeBudgetUsd(note: string | null): number | null {
  const match = /\bbudget\s*(?:of\s+|is\s+)?\$\s*(\d+(?:\.\d+)?)/i.exec(note ?? '');
  const dollars = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(dollars) && dollars > 0 ? dollars : null;
}

/** The sizes the text names, such as "1080 × 1920", in the order it names them; only the ones a brief can ask for. */
export function canvasesIn(text: string): BriefCanvas[] {
  const found: BriefCanvas[] = [];
  for (const match of text.matchAll(/(?<!\d)(\d{3,4})\s*[x×X]\s*(\d{3,4})(?!\d)/g)) {
    const canvas = `${match[1]}x${match[2]}` as BriefCanvas;
    if ((BRIEF_CANVASES as readonly string[]).includes(canvas) && !found.includes(canvas)) {
      found.push(canvas);
    }
  }
  return found;
}

/**
 * The draft the fake run writes: every file with a role, every decision left to the defaults.
 * `generate` (the Generate switch is on) carries the text of the folder's text files, for the
 * script and the formats; see the top of the file.
 */
export function fakeBriefDraft(
  job: Pick<Job, 'client' | 'name'>,
  files: readonly BriefFile[],
  note: string | null,
  generate?: { readonly text: string },
  /** The music switch is on (U21): the text is where the stand-in looks for an ask for music. */
  music?: { readonly text: string },
): BriefDraft {
  const on = generate !== undefined;
  const footage = files.filter(
    (file) => file.kind === 'video' && !(on && isReference(file as BriefFile)),
  ).length;
  const script = on ? scriptLinesOf(generate.text) : null;
  const sizes = on ? canvasesIn(generate.text) : [];
  const formats = sizes.length > 1 ? sizes : null;
  return {
    summary: `A stand-in brief for "${job.name}" (${job.client}), written by the Studio Engine fake runner without reading the folder. It lists ${files.length} file${files.length === 1 ? '' : 's'}, ${footage} of them footage. Every decision is left to video-use's defaults.`,
    goal: null,
    audience: null,
    platform: [],
    canvas: formats === null ? null : (formats[0] ?? null),
    length: null,
    language: null,
    captions: null,
    tone: null,
    pacing: null,
    hook: null,
    mustInclude: [],
    mustAvoid: [],
    onScreenText: { title: null, lowerThirds: [], cta: null, endCard: null },
    look: {
      logo: files.find((file) => roleOf(file, on) === 'logo')?.relPath ?? null,
      colors: [],
      fonts: [],
    },
    music: fakeBriefMusic(
      files,
      music !== undefined && fakeMusicWanted(`${note ?? ''}\n${music.text}`),
    ),
    production: script !== null && footage === 0 ? 'generate' : null,
    voiceover:
      script !== null && footage === 0
        ? { lines: script.map((text, index) => ({ id: `L${index + 1}`, text, direction: null })) }
        : null,
    formats: formats ?? fakeFormats(note),
    budgetUsd: on && script !== null && footage === 0 ? fakeBudgetUsd(note) : null,
    references: [],
    files: files.map((file) => ({
      path: file.relPath,
      role: roleOf(file, on),
      note:
        file.kind === 'audio'
          ? 'Fake voice note (stand-in transcript)'
          : file.attached === true
            ? 'Screenshot attached to the note'
            : null,
    })),
    assumptions: [
      'The fake runner wrote this brief; nothing in the folder was read.',
      ...(note === null ? [] : ['The owner’s note is in brief.md word for word.']),
    ],
    assumed: [],
  };
}

/** The text of the job's own text files (.txt, .md), joined: where the fake looks for a script. */
async function textOf(files: readonly BriefFile[]): Promise<string> {
  const texts = await Promise.all(
    files
      .filter(
        (file) =>
          file.fromZip === undefined &&
          ['.txt', '.md'].includes(extname(file.relPath).toLowerCase()),
      )
      .map((file) => readFile(file.absPath, 'utf8').catch(() => '')),
  );
  return texts.join('\n\n');
}

export class FakeBriefWriter implements BriefWriter {
  private readonly speed: number;
  private readonly sleep: Sleep;
  private readonly generate: boolean;
  private readonly music: boolean;

  constructor({
    speed = 1,
    sleep = realSleep,
    generate = false,
    music = false,
  }: FakeBriefWriterOptions = {}) {
    if (!(Number.isFinite(speed) && speed > 0)) {
      throw new RangeError(`The fake brief's speed must be a number above 0 (got ${speed}).`);
    }
    this.speed = speed;
    this.sleep = sleep;
    this.generate = generate;
    this.music = music;
  }

  async injectedFailure(_job: Job, { jobDir, signal }: Pick<BriefWrite, 'jobDir' | 'signal'>) {
    const marker = failMarkerName(BRIEF_STEP);
    if (!(await exists(join(jobDir, marker)))) return null;
    await this.sleep((FAKE_STEP_MS[BRIEF_STEP] * FAILURE_AFTER) / this.speed, signal);
    return `Brief failed: injected failure (${marker})`;
  }

  async write(job: Job, { jobDir, files, note, signal }: BriefWrite): Promise<BriefWriteOutcome> {
    const audio = files.filter((file) => file.kind === 'audio');
    // Half the time for the voice notes (if any), the rest for "reading" and writing the brief.
    const total = FAKE_STEP_MS[BRIEF_STEP] / this.speed;
    const each = audio.length === 0 ? 0 : total / 2 / audio.length;
    for (const [index, file] of audio.entries()) {
      await this.sleep(each, signal);
      if (signal.aborted) return STOPPED;
      const name = parse(file.relPath).name;
      const target = join(jobDir, BRIEF_TRANSCRIPTS_PATH, `${name}.json`);
      if (await exists(target)) continue;
      const transcript = fakeTranscript({ file: file.relPath, absPath: file.absPath, name }, index);
      await writeAtomic(target, `${JSON.stringify(transcript, null, 2)}\n`);
    }
    await this.sleep(total - each * audio.length, signal);
    if (signal.aborted) return STOPPED;

    // The text of the folder's text files: the script of a generated video, an ask for music.
    const text = this.generate || this.music ? await textOf(files) : '';
    const draft = fakeBriefDraft(
      job,
      files,
      note,
      this.generate ? { text } : undefined,
      this.music ? { text } : undefined,
    );
    await writeAtomic(join(jobDir, BRIEF_JSON_PATH), `${JSON.stringify(draft, null, 2)}\n`);
    return { ok: true };
  }
}
