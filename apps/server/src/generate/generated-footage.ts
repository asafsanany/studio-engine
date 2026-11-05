// What the edit run is told about the footage of a generated job (Generated videos, GN4 · CVP-413).
//
// A generated job has no footage in its folder. After the Generate run, `edit/generate/` holds the
// kept clips (`shots/`), the voice (`voice.mp3` and `voice-words.json`), the sound effects
// (`sfx/`) and what the run learned from the reference video (`reference.md`), and
// `edit/generate/shots.json` says which clip covers which stretch of the voice. The edit run reads
// `edit/brief.md` first, so the engine appends a "Generated footage" section to it: the clips in
// cut order, each with its stretches of the voice, what it shows and whether it is below the bar;
// the voice as the speech; the sound effects; the reference as the style to match.
//
// `appendGeneratedFootage(editDir)` is called by the Generate stage (GN5) once the run has handed
// off. It is idempotent: a second call replaces the section instead of adding another. The brief
// step writes brief.md from scratch every time it runs (a Retry or a Resume), which drops the
// section, so the stage calls this again after each Generate run.

import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  GENERATE_FILES,
  type GenerateShot,
  type GenerateShots,
  generateShotsSchema,
  shotFile,
} from '@studio/shared';

/** The heading of the section; the next `## ` heading (or the end of the file) ends it. */
export const GENERATED_FOOTAGE_HEADING = '## Generated footage';

/** A problem with what the section is made from. `message` is plain and names the file. */
export class GeneratedFootageError extends Error {
  override readonly name = 'GeneratedFootageError';
}

/** Which of the files the section can point at are there. */
export interface GeneratedFiles {
  /** The clip files of `shots/` that exist, by clip id. */
  readonly clips: ReadonlySet<string>;
  readonly voice: boolean;
  readonly voiceWords: boolean;
  readonly reference: boolean;
  /** The names in `sfx/`, sorted. */
  readonly sfx: readonly string[];
}

const EDIT = 'edit';

/** `edit/generate/shots/A.mp4`: a path of the generate folder as the brief names it, from the job folder. */
const inJob = (inside: string): string => `${EDIT}/${GENERATE_FILES.dir}/${inside}`;

/** Seconds as "0:07.5" or "0:03": whole seconds without a fraction, otherwise one decimal. */
export function windowStamp(sec: number): string {
  const rounded = Math.round(Math.max(0, sec) * 10) / 10;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded - minutes * 60;
  const seconds = Number.isInteger(rest)
    ? String(rest).padStart(2, '0')
    : rest.toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

/** "10 s", "7.5 s". */
function secondsText(sec: number): string {
  return `${Math.round(sec * 10) / 10} s`;
}

/** One line: line breaks and runs of spaces flattened, so a clip stays one list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** "0:00–0:03", "0:00–0:03 and 0:08–0:10", "0:00–0:03, 0:08–0:10 and 0:12–0:16". */
function windowsText(shot: GenerateShot): string {
  const parts = shot.windows.map(
    (window) => `${windowStamp(window.startSec)}–${windowStamp(window.endSec)}`,
  );
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function shotLine(shot: GenerateShot, present: boolean): string {
  const parts = [
    `\`${inJob(shotFile(shot.id))}\``,
    secondsText(shot.seconds),
    `over ${windowsText(shot)} of the voice`,
    `shows: ${oneLine(shot.shows)}`,
  ];
  let line = `  - ${parts.join(' · ')}`;
  if (shot.belowBar) {
    line +=
      ' · BELOW THE BAR: this take failed its check and no better one could be paid for. Cut around it or hide it behind graphics, and say so in Assumptions.';
  }
  if (!present) line += ' · THE FILE IS MISSING: do not cut it; say so in Assumptions.';
  return line;
}

/**
 * The "Generated footage" section for brief.md, ending without a blank line. Pure: `files` says
 * which files exist, so a clip or the voice that is not there is told as missing and the speech,
 * the effects and the style are only named when they are there.
 */
export function renderGeneratedFootage(shots: GenerateShots, files: GeneratedFiles): string {
  const lines = [
    GENERATED_FOOTAGE_HEADING,
    'There is no footage in the folder: this video is cut from clips and a voice that were made for it, in `edit/generate/`. The voice is the timing master: cut the clips to it, never the other way round, and never drop or reorder a story beat.',
    '',
    '- Clips, in the order to cut them (each file is the take that was kept; a clip that covers more than one stretch of the voice is cut in once for each):',
  ];
  for (const shot of shots.shots) lines.push(shotLine(shot, files.clips.has(shot.id)));
  if (shots.shots.length === 0) lines.push('  - (none were made)');

  if (files.voice) {
    // With the word times there is nothing to transcribe (GN6): they were worked out when the voice
    // was assembled, and a second transcription would cost money and could disagree with them.
    const words = files.voiceWords
      ? ` Its word times are in \`${inJob(basename(GENERATE_FILES.voiceWords))}\`: every spoken word with its line (L1, L2, …) and its time in the voice. Do not transcribe it again; cut to it.`
      : ' Transcribe it like the speech in footage, and cut to it.';
    lines.push(`- Speech: \`${inJob(basename(GENERATE_FILES.voice))}\` is the narrator.${words}`);
  }
  if (files.sfx.length > 0) {
    lines.push(
      `- Sound effects: ${files.sfx.map((name) => `\`${inJob(`${basename(GENERATE_FILES.sfxDir)}/${name}`)}\``).join(', ')}. Place them where the brief asks for them.`,
    );
  }
  if (files.reference) {
    lines.push(
      `- Style to match: \`${inJob(basename(GENERATE_FILES.reference))}\` has the reference video’s shot order, timing, captions and offer graphics. Match that style; don’t copy the reference.`,
    );
  }
  return lines.join('\n');
}

/** `brief.md` without an earlier "Generated footage" section (from its heading to the next `## ` or the end). */
export function withoutGeneratedFootage(markdown: string): string {
  const heading = `${GENERATED_FOOTAGE_HEADING}\n`;
  let start = 0;
  if (!markdown.startsWith(heading)) {
    const at = markdown.indexOf(`\n${heading}`);
    if (at === -1) return markdown;
    start = at + 1;
  }
  const next = markdown.indexOf('\n## ', start + heading.length);
  return `${markdown.slice(0, start)}${next === -1 ? '' : markdown.slice(next + 1)}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GeneratedFootageError(`${what} is missing.`);
    }
    throw err;
  }
}

/** The names of the files directly in `dir`, sorted, dot files left out; none for a folder that is not there. */
async function listNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Appends the "Generated footage" section to `<editDir>/brief.md`, made from
 * `<editDir>/generate/shots.json` and the files next to it, and replaces the one that is there
 * from an earlier call. `editDir` is the job's `edit/` folder. Throws {@link GeneratedFootageError}
 * (a plain message) when shots.json or brief.md is missing or shots.json is not the hand-off's
 * shape; nothing is written then. brief.md is replaced in one move, so a reader never sees half of it.
 */
export async function appendGeneratedFootage(editDir: string): Promise<void> {
  const shotsPath = join(editDir, GENERATE_FILES.shots);
  const briefPath = join(editDir, 'brief.md');

  const text = await readText(shotsPath, 'edit/generate/shots.json');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GeneratedFootageError('edit/generate/shots.json is not valid JSON.');
  }
  const parsed = generateShotsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? '' : ` (${issue.path.join('.')})`;
    throw new GeneratedFootageError(
      `edit/generate/shots.json doesn’t match its shape${where}: ${issue?.message ?? 'unknown problem'}.`,
    );
  }
  const brief = await readText(briefPath, 'edit/brief.md');

  const clips = new Set<string>();
  for (const shot of parsed.data.shots) {
    if (await isFile(join(editDir, GENERATE_FILES.dir, shotFile(shot.id)))) clips.add(shot.id);
  }
  const section = renderGeneratedFootage(parsed.data, {
    clips,
    voice: await isFile(join(editDir, GENERATE_FILES.voice)),
    voiceWords: await isFile(join(editDir, GENERATE_FILES.voiceWords)),
    reference: await isFile(join(editDir, GENERATE_FILES.reference)),
    sfx: await listNames(join(editDir, GENERATE_FILES.sfxDir)),
  });

  const body = withoutGeneratedFootage(brief).trimEnd();
  const temporary = join(dirname(briefPath), `.${basename(briefPath)}.tmp`);
  await writeFile(temporary, `${body}\n\n${section}\n`);
  await rename(temporary, briefPath);
}
