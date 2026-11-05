// What the fake runner (E7) writes into `edit/`, apart from the videos: the sources it finds in the
// job folder, and the text of the transcripts, takes_packed.md, project.md, edl.json and the
// graphics placeholders. Shapes follow a real video-use run (fixtures/stream/sample-run-tree.txt),
// small enough to read at a glance. Everything is a pure function of its inputs.

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, parse } from 'node:path';
import {
  classifyFile,
  EDIT_DIR_NAME,
  isIgnoredName,
  isPackageName,
  isReservedName,
  isTimedKind,
} from '../inbox/classify.js';

/** A video or audio file in the job folder: what video-use transcribes, one transcript each. */
export interface FakeSource {
  /** Path relative to the job folder, with forward slashes. */
  file: string;
  absPath: string;
  /** The transcript's name: `transcripts/<name>.json`. Unique within the job. */
  name: string;
}

function byCodePoint(a: string, b: string): number {
  const left = a.normalize('NFC');
  const right = b.normalize('NFC');
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Same rules as the inbox scanner: dotfiles, partial downloads and the `edit/` workspace at the
// job root are skipped, macOS packages are not entered, folder symlinks are not followed.
async function walk(dir: string, rel: string, depth: number, found: string[]): Promise<void> {
  for (const entry of await readEntries(dir)) {
    const { name } = entry;
    if (isIgnoredName(name)) continue;
    const relPath = rel === '' ? name : `${rel}/${name}`;
    const absPath = join(dir, name);

    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      isFile = await stat(absPath).then(
        (info) => info.isFile(),
        () => false,
      );
    }

    if (isFile) {
      if (isTimedKind(classifyFile(name))) found.push(relPath);
    } else if (entry.isDirectory()) {
      if (depth === 0 && isReservedName(name, EDIT_DIR_NAME)) continue;
      if (isPackageName(name)) continue;
      await walk(absPath, relPath, depth + 1, found);
    }
  }
}

/**
 * The video and audio files of a job, in path order, each with the unique transcript name video-use
 * would give it (the file name without its extension; `clip-2` for a second `clip.*`).
 */
export async function listSources(jobDir: string): Promise<FakeSource[]> {
  const files: string[] = [];
  await walk(jobDir, '', 0, files);
  files.sort(byCodePoint);

  // macOS volumes are case-insensitive, so two names that differ only in case would collide.
  const taken = new Set<string>();
  return files.map((file) => {
    const base = parse(file).name;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base}-${n}`;
    taken.add(name.toLowerCase());
    return { file, absPath: join(jobDir, file), name };
  });
}

// --- transcripts ------------------------------------------------------------------------------

const WORD_SECONDS = 0.4;
const FIRST_WORD_AT = 0.06;

interface FakeWord {
  text: string;
  start: number;
  end: number;
  type: 'word';
  speaker_id: 'speaker_0';
}

export interface FakeTranscript {
  language_code: string;
  language_probability: number;
  text: string;
  words: FakeWord[];
  /** Added by the fake runner; real transcripts do not have these. */
  source: string;
  fake: true;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A small Scribe-shaped transcript for the `index`-th source (0-based). */
export function fakeTranscript(source: FakeSource, index: number): FakeTranscript {
  const text = `Take ${index + 1}. This is a stand-in transcript from the Studio Engine fake runner. Nothing here was actually heard.`;
  const words = text.split(' ').map((word, position): FakeWord => {
    const start = round2(FIRST_WORD_AT + position * WORD_SECONDS);
    return {
      text: word,
      start,
      end: round2(start + WORD_SECONDS - 0.06),
      type: 'word',
      speaker_id: 'speaker_0',
    };
  });
  return {
    language_code: 'eng',
    language_probability: 1,
    text,
    words,
    source: source.file,
    fake: true,
  };
}

/** Length of a fake transcript in seconds (end of its last word, plus a breath). */
export function transcriptSeconds(transcript: FakeTranscript): number {
  const last = transcript.words[transcript.words.length - 1];
  return round2((last?.end ?? 0) + 0.1);
}

function range(a: number, b: number): string {
  const pad = (value: number): string => value.toFixed(2).padStart(6, '0');
  return `[${pad(a)}-${pad(b)}]`;
}

/** `edit/takes_packed.md`: the phrase-level view of all transcripts that video-use reads. */
export function takesPackedMarkdown(sources: readonly FakeSource[]): string {
  const sections = sources.map((source, index) => {
    const transcript = fakeTranscript(source, index);
    const seconds = transcriptSeconds(transcript);
    const first = transcript.words[0]?.start ?? 0;
    const last = transcript.words[transcript.words.length - 1]?.end ?? 0;
    return [
      `## ${source.name}  (duration: ${seconds.toFixed(1)}s, 1 phrases)`,
      `  ${range(first, last)} S0 ${transcript.text}`,
    ].join('\n');
  });
  return [
    '# Packed transcripts',
    '',
    'Phrase-level, grouped on silences ≥ 0.5s or speaker change.',
    'Use `[start-end]` ranges to address cuts in the EDL.',
    '',
    ...(sections.length === 0 ? ['(no audio or video sources in this job)'] : sections),
    '',
  ].join('\n');
}

// --- plan, EDL, graphics ----------------------------------------------------------------------

export interface PlanInput {
  client: string;
  jobName: string;
  sources: readonly FakeSource[];
  graphics: number;
  date: string;
}

/** `edit/project.md`: the plan written before the cut, as the video-use skill does. */
export function projectMarkdown({ client, jobName, sources, graphics, date }: PlanInput): string {
  const footage =
    sources.length === 0
      ? 'There is no audio or video in the folder.'
      : `${sources.length} source${sources.length === 1 ? '' : 's'}: ${sources.map((s) => s.file).join(', ')}.`;
  return [
    `# ${client} — ${jobName}`,
    '',
    `## Session 1 — ${date}`,
    '',
    `**Assumptions:** This edit was made by the Studio Engine fake runner (STUDIO_RUNNER=fake), which reads no footage and spends no tokens. ${footage} Delivery is 360×640 portrait with no music and no grade.`,
    '',
    `**Strategy:** Keep the first take of every source in order, add ${graphics} graphic${graphics === 1 ? '' : 's'} on a single overlay slot, and finish with a preview, three checks and a render. None of this is real: the files exist so the Jobs page has something to show.`,
    '',
  ].join('\n');
}

/**
 * The "## Round N" section a fake revise run adds to project.md: one line per note of the round
 * file (its "- m:ss.s — …" lines), as revise.md asks of a real one.
 */
export function roundSection(round: number, roundFile: string): string {
  const times = roundFile
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => (line.slice(2).split(' — ')[0] ?? '').trim());
  const lines =
    times.length === 0
      ? ['- No notes in the round file (fake revise).']
      : times.map((time) => `- ${time}: done as asked (fake revise).`);
  return `## Round ${round}\n\n${lines.join('\n')}\n`;
}

const BEATS = ['INTRO', 'BODY', 'CTA'] as const;

export interface EdlInput {
  sources: readonly FakeSource[];
  /** Absolute paths of the graphics renders (`animations/slot_N/render.mov`). */
  overlays: readonly string[];
  /** Length of the finished video, which the overlays are spread over. */
  clipSeconds: number;
}

/** `edit/edl.json` in the shape the render helper takes. */
export function edlJson({ sources, overlays, clipSeconds }: EdlInput): string {
  const ranges = sources.map((source, index) => {
    const transcript = fakeTranscript(source, index);
    const beat = index === 0 ? BEATS[0] : index === sources.length - 1 ? BEATS[2] : BEATS[1];
    return {
      source: source.name,
      start: 0,
      end: transcriptSeconds(transcript),
      beat,
      quote: transcript.text,
      reason: 'Fake runner: the whole first take.',
    };
  });
  const edl = {
    version: 1,
    sources: Object.fromEntries(sources.map((source) => [source.name, source.absPath])),
    ranges,
    grade: 'none',
    overlays: overlays.map((file, index) => ({
      file,
      start_in_output: round2((clipSeconds * index) / Math.max(overlays.length, 1)),
      duration: round2(clipSeconds / Math.max(overlays.length, 1)),
    })),
    total_duration_s: clipSeconds,
  };
  return `${JSON.stringify(edl, null, 2)}\n`;
}

/** `edit/animations/slot_N/index.html`: a stand-in for the HyperFrames composition. */
export function slotHtml(slot: number): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>Fake graphic ${slot}</title></head>\n<body><!-- placeholder written by the Studio Engine fake runner --></body></html>\n`;
}

/** `edit/animations/slot_N/render.mov`: a few bytes standing in for the transparent render. */
export function slotRender(slot: number): string {
  return `placeholder for the render of graphic ${slot}, written by the Studio Engine fake runner\n`;
}
