// The prompts a run starts with: apps/server/prompts/{start,resume,retry}.md for the edit run, one
// per mode, revise.md for a revise run (it applies one round of the owner's review notes), render.md for
// a render run (it renders the approved preview), and apps/server/prompts/brief.md for the Brief
// run that comes before an edit (B4).
//
// Templates are plain Markdown with `{{name}}` variables and `{{> partial}}` includes. A partial is
// either another file in the same folder (`{{> unattended}}`, `{{> brief-use}}`), rendered with the
// same variables, or computed by the engine and put in as it is (`{{> brief-schema}}`, the JSON
// Schema of the brief). Templates are read on every run, so editing one takes effect on the next
// run without a rebuild. The folder sits outside src/ and is found from this file's URL, which
// works from src/ (dev, tests) and from dist/ (the built server) alike.
//
// Which template (W3). The run's kind (`vars.kind`, the job's `runKind`) and mode pick it: an edit
// run has start.md, resume.md and retry.md, one per mode; a revise run has revise.md and a render
// run render.md, whatever the mode. Those two say how a try after the first went in their
// `{{again}}` sentence (`againText`): empty on a run's first try, what became of the last one on a
// resume or a retry. `{{round}}` is the round a revise run applies. Both are computed in code and
// handed in as values, so an error text with `{{` in it is never read as a template.
//
// How an edit run ends (W2). The first line of start.md, resume.md and retry.md says `{{goal}}`,
// and they end with `{{> finish}}`. With the Review switch off the run delivers edit/final.mp4:
// the goal says so, `finish` is empty, and its done line (final-finish.md) stays where it always
// was, in the unattended notes (`{{> unattended-finish}}`). With the switch on the run finishes as
// a live composition: the goal says so, `finish` is preview-finish.md, and `unattended-finish` is
// empty, so the preview's finish closes the prompt. `runFinishOf` (run-finish.ts) picks. A revise
// or render run names its own finish in its template (`{{> preview-finish}}`, `{{> final-finish}}`),
// so for them both of those slots are empty and the done line appears exactly once.
//
// The self-eval line of preview-finish.md is a partial of its own, `{{> self-eval}}` (QF4): the
// whole check (self-eval-full.md, the words preview-finish.md always had) or, for a revise run whose
// job's Send with Auto asked for the Revise tier (`vars.checks` is `slim`, see `reviseRunOf`), the
// slim one (self-eval-slim.md: only around what the round changed). Every other run gets the full
// one, so every prompt that was sent before is what it was, byte for byte.
//
// Two lines of preview-finish.md are a partial of their own, composition-rules.md (the exit rule of a
// `class="clip"` element and the look at what a caption sits on), because the quick fix run
// (review/quick-fix-prompt.ts, quick-fix.md) must follow them too. They render in the same place
// with the same words, so the edit, revise and render prompts are what they were, byte for byte.
//
// The Graphics library (GR8). With the graphicsInEdits switch on (`vars.graphics`) the unattended
// notes get one more line (unattended-graphics.md: the library is already copied into
// edit/graphics/, don't open _Graphics) and brief-use gets one more (brief-use-graphics.md: the
// order of authority). With it off both slots are empty, so every prompt is what it always was.
//
// LUTs in notes (LU9). With the lutsInEdits switch on, a note that names a LUT or a graphic
// (`@luts/golden-hour-warm`) is resolved before the run (luts/lut-job-files.ts) and the answer comes
// in as `vars.libraryRefs`. When it names anything, the prompt gets luts-use.md: in an edit run as
// one more line of the unattended notes (`{{> unattended-luts}}`, after the colour grade), in a
// revise run as one more line of its list (`{{> luts-use}}`, after "Do what each note asks"). Its
// kind parts (look, cinematic, camera, graphic) are included only for the kinds there are, and the
// colour-grade parts end with `{{lutsGradeNote}}`, a sentence that is there only then. With no
// references (the switch off, or notes that name nothing) every slot is empty and takes its line
// with it, so every prompt is what it always was, byte for byte.
//
// Camera log (LU10). With the same switch on, an edit run's libraryRefs also carries `camera`: the
// log curves its footage names and the Camera LUT that matches (luts/camera-luts.ts). The unattended
// notes then get one more bullet (luts-camera.md) after the colour grade, whatever the notes name:
// apply a matched LUT only to a source the grade's report calls log, and end with the exact
// `Blocked: Waiting for a camera LUT: …` sentence otherwise (shared/camera-luts.ts reads it back).
// A revise or render run never gets it.
//
// Fonts in notes (FN15). The fonts a note names (`@Heebo Bold`) join the same block: with the
// fontsInNotes switch on, `withFontRefs` (fonts/font-run-refs.ts) resolves them against the font
// index, makes sure their files are in the job's edit/fonts/ and hands them in as
// `vars.libraryRefs.fonts`. They add one line each to the list of the "Library references" block
// and, after the LUT parts, its last part: fonts-use.md (`{{> fonts-use}}`, only when a font is
// named). A run that names only fonts gets the block with a font intro; one that names both gets
// both. With no font named every font slot is empty, so a prompt is what it was, byte for byte.
// A font name the library does not have (`vars.libraryRefs.unresolvedFonts`, FN16) adds one list
// line, before the fonts that were found (next to the tokens that point at nothing): "The owner asked for Gotham Bold; it is not in edit/fonts/. Use
// the closest font that is there and say which one you used in your answer." It needs no rule part
// of its own, so a note that names only missing fonts gets the block, the intro and those lines.
//
// Soundtrack (SD0; SD3 writes the parts). With the music switch on (`vars.music`) each kind gets
// its music part, with `{{musicScript}}` the music script's path: start.md, resume.md and retry.md
// get music.md as a paragraph of its own after brief-use (`{{> music}}` sits on the line under
// `{{> brief-use}}` and the engine puts the blank line in front of it), revise.md gets
// music-revise.md as lines of its list (after "Do what each note asks"), and render.md gets
// music-render.md as lines of its list (after the render line). With it off every slot is empty and
// takes its line with it, so every prompt is what it always was, byte for byte.
//
// Stock media (ST4). With the stock switch on (`vars.stock`) an edit run gets stock.md (`{{> stock}}`
// sits on the line under `{{> music}}` in start.md, resume.md and retry.md, a paragraph of its own
// like music) and a revise run gets stock-revise.md as a line of its list (after
// `{{> generate-revise}}`), with `{{stockScript}}` the stock script's path. A render run gets
// nothing. With it off every slot is empty, so a prompt is what it was, byte for byte.
//
// Songs (SG4). With the songs switch on too (`vars.songs`, which only counts while `music` is on) the
// same parts get their song lines, each a partial of its own that is empty with the switch off and
// takes its line with it: music.md gets `{{> music-songs-sources}}` (three more sources in "Where the
// music comes from": a song in the brief, a trending one, Original audio) and `{{> music-songs}}`
// (getting the song with the script's `song` command and fitting the cut to it), music-revise.md
// gets `{{> music-revise-songs}}` (a note that asks for another song, or for its timing), and the
// Brief prompt gets `{{> brief-songs}}` (reading the song off a screenshot, a link or the words) and
// its schema with the song keys. music-render.md is the same: the engine makes the second file.
//
// Music only when asked (U21). Music is made or fetched only when the job asks for it explicitly: a
// music file or a series kit, a song, instructions that ask for music (the Brief fills `music.wanted`;
// the Brief prompt gets `{{> brief-music}}` and a schema with `wanted` while the music switch is on), a
// rule in the series or the client's style, or the owner in Review. music.md says so in "Where the music comes
// from"; with nothing asking, the edit run runs the script's `none ... --plan` and makes nothing. A
// revise run (music-revise.md) never makes music for such a job unless a note asks. With the switch
// off none of it is there.
//
// Formats (GN7). A job with two or more formats (`vars.formats`, from `Job.formats`: only when the
// brief or the owner's note explicitly asked for more than one) gets formats-use.md in the place preview-finish.md
// keeps for it (so in an edit run that ends in Review and in a revise run: build and keep in step
// one composition per extra format, edit/preview-<id>/) and formats-render.md in render.md (render
// each format to edit/final-<id>.mp4). With one format both slots are empty and take their lines
// with them, so every prompt is what it always was, byte for byte.
//
// Generated videos (GN6). A job whose brief says `production: generate` (`vars.generated`, read from
// edit/brief.json by the runner) has no footage: its clips, voice and sound effects were made by the
// Generate step into edit/generate/. An edit run (start, resume and retry) then gets generated.md in
// the place after brief-use that music.md also uses (`{{> generated}}`, a paragraph of its own): the
// clips are the footage in shots.json's order, voice.mp3 is the speech and its word times are
// voice-words.json (never transcribed again, never stretched), the cut follows the voice, and the
// captions, offer cards, alert effects and end card are HyperFrames layers. A revise run gets
// generate-revise.md as lines of its list, right after the music part (`{{> generate-revise}}`):
// sort each note into an edit change, what is in a clip (one new take within what is left of the
// budget) or the voice (that line made again, the cut shifted by the length difference), with the two
// scripts' paths, the edit folder and the budget, what is spent and what is left as values
// (`generateVoiceScript`, `generateShotsScript`, `generateEditDir`, `generateBudget`,
// `generateSpent`, `generateLeft`, `generateBudgetNumber`). A render run is never told about it:
// it renders what was approved. Without `vars.generated` both slots are empty and take their lines
// with them, so every footage job's prompt is what it always was, byte for byte.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  briefPromptSchema,
  budgetLeftUsd,
  budgetUsdText,
  cameraLutWaitSentence,
  clock,
  extraFinalName,
  extraFormatsOf,
  extraPreviewDirName,
  firstStepOf,
  fontScriptLabel,
  type JobFormat,
  LUT_KIND_LABELS,
  listByFolder,
  type RunKind,
  STEP_LABELS,
  type StepId,
  spendUsdText,
} from '@studio/shared';
import { budgetNumberText } from '../generate/generated-job.js';
import type { FileKind } from '../inbox/classify.js';
import { type RunFinish, runFinishOf } from './run-finish.js';
import type { RunCameraLuts, RunFont, RunLibraryRefs, RunMode } from './runner.js';

export const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));
/** Repo-owned launcher; resolve from src/ or dist/, never from a job's working directory. */
export const COLOR_GRADE_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/color-grade/run.sh', import.meta.url),
);

export interface PromptVars {
  client: string;
  job: string;
  /** The kind of run (`job.runKind`): edit uses start/resume/retry.md, revise revise.md, render render.md. Default edit. */
  kind?: RunKind;
  /** The Review switch (`Config.review`). On: an edit run finishes as a live preview in edit/preview/ (W2). Only an edit run reads it. */
  review?: boolean;
  /**
   * The graphicsInEdits switch (`Config.graphicsInEdits`). On: the Graphics library is in
   * edit/graphics/ and the prompts say so (GR8). Default off: the prompts are unchanged.
   */
  graphics?: boolean;
  /**
   * The Soundtrack switch (`Config.music`). On: each kind's prompt gets its music part (music.md,
   * music-revise.md or music-render.md). Default off: the prompts are unchanged.
   */
  music?: boolean;
  /** The music script's absolute path (`MUSIC_SCRIPT`), the parts' `{{musicScript}}`. Needed while `music` is on. */
  musicScript?: string;
  /**
   * The Stock switch (`Config.stock`). On: an edit run gets stock.md (a paragraph of its own after
   * the music) and a revise run stock-revise.md (a line of its list). Default off: the prompts are
   * unchanged, byte for byte.
   */
  stock?: boolean;
  /** The stock script's absolute path (`STOCK_SCRIPT`), the parts' `{{stockScript}}`. Needed while `stock` is on. */
  stockScript?: string;
  /**
   * The Songs switch (`Config.songs`, already off whenever `music` is). On, with `music`: the music
   * parts get their song lines (SG4). Default off: the prompts are unchanged.
   */
  songs?: boolean;
  /**
   * What the run's notes name in the library, found and copied into the job (LU9): given only while
   * the lutsInEdits switch is on and a note of an edit or revise run names something. Left out or
   * empty: the prompts are unchanged.
   */
  libraryRefs?: RunLibraryRefs | null;
  /**
   * How much self-check a revise run does (QF4): `slim` is the Revise tier's (`TIER_RUNS.revise.checks`),
   * only around what the round changed. Default `full`, today's; an edit and a render run ignore it.
   */
  checks?: 'slim' | 'full';
  /**
   * The job's formats (`Job.formats`, GN7): given only for a job that has two or more. The edit
   * run that ends in Review, the revise run and the render run then build, keep in step and render
   * one composition per extra format. Left out or fewer than two: the prompts are unchanged.
   */
  formats?: readonly JobFormat[];
  /**
   * A generated video (GN6): given only for a job whose brief says `production: generate`. The edit
   * run then gets the `generated` part and the revise run the `generate-revise` part (see the
   * header). Left out or `null`: the prompts are unchanged.
   */
  generated?: GeneratedPromptVars | null;
  /** Revise runs: the round being applied (`job.round`, 1 or more). */
  round?: number;
  /** Where the job is (resume) or failed (retry). Default: the kind's first step. */
  step?: StepId;
  /** Retry only: why the previous attempt failed. */
  error?: string;
  /**
   * Draft & chat (DR4, `Config.draftChat`): an edit run is the Draft. Its prompt is draft.md
   * (`/video-use`, the owner's note, the job, the finish) whatever the mode, and the rules start.md says
   * inline go to edit/studio/notes.md (`buildStudioNotes`). Default off: every prompt is unchanged.
   */
  draft?: boolean;
  /** The Draft only: The owner's note on the job (`job.note`), put in word for word. */
  note?: string | null;
  /** The Draft only: edit/brief.json is still the placeholder, so the Draft reads the instructions. */
  briefPending?: boolean;
}

/** What the revise part of a generated video is told (GN6): the two scripts, the edit folder and the money. */
export interface GeneratedPromptVars {
  /** Absolute path of make-voice.mjs (ElevenLabs). */
  voiceScript: string;
  /** Absolute path of make-shots.mjs (Higgsfield). */
  shotsScript: string;
  /** Absolute path of the job's edit/ folder (the scripts take it). */
  editDir: string;
  /** The job's budget in dollars, every round included. */
  budgetUsd: number;
  /** Dollars spent on Higgsfield so far (the entries of spend.json that were not refunded). */
  spentUsd: number;
}

/**
 * A partial: a template (rendered with the same variables and partials) or computed text that is
 * put in exactly as it is, so a `{{` inside it is never read as a variable.
 */
export type PromptPartial = string | { readonly raw: string };

const NAME = /^[a-z][a-z0-9-]*$/;

/** `{{name}}` or `{{> name}}`. One pass, so text a variable or a partial brings in is never re-read. */
const PLACEHOLDER = /\{\{(>)?\s*([^}\s>]+)\s*\}\}/g;

/** A `{{> name}}` that is alone on its line. */
const STANDALONE_INCLUDE = /^\{\{>\s*([^}\s>]+)\s*\}\}\n/gm;

/**
 * Fills `{{name}}` from `vars` and `{{> partial}}` with `partials[partial]`. An include that is
 * alone on its line and comes out empty takes its line with it.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  partials: Record<string, PromptPartial> = {},
  depth = 0,
): string {
  if (depth > 4) throw new Error('Prompt partials nest too deep');
  const include = (name: string): string => {
    const partial = partials[name];
    if (partial === undefined) throw new Error(`Unknown prompt partial "${name}"`);
    const text =
      typeof partial === 'string'
        ? renderTemplate(partial, vars, partials, depth + 1)
        : partial.raw;
    return text.trimEnd();
  };
  // An include alone on its line that comes out empty takes the line with it, so an optional part
  // (`{{> unattended-finish}}` inside a list) leaves no blank line. This pass only removes lines,
  // so nothing a variable or a partial brings in is ever read twice.
  const kept = template.replace(STANDALONE_INCLUDE, (line, name: string) =>
    include(name) === '' ? '' : line,
  );
  return kept.replace(PLACEHOLDER, (_, isInclude: string | undefined, name: string) => {
    if (isInclude !== undefined) return include(name);
    const value = vars[name];
    if (value === undefined) throw new Error(`Prompt variable "${name}" has no value`);
    return value;
  });
}

/** Reads `<dir>/<name>.md`. */
export async function readTemplate(dir: string, name: string): Promise<string> {
  if (!NAME.test(name)) throw new Error(`Bad prompt template name "${name}"`);
  return readFile(`${dir}/${name}.md`, 'utf8');
}

/** Error text as one quoted line: no line breaks or `{{` that could break the template. */
export function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\{\{|\}\}/g, '')
    .trim();
}

/** The goal in the first line of start.md, resume.md and retry.md (`{{goal}}`), by how the run ends. */
export const GOALS: Readonly<Record<RunFinish, string>> = {
  final: 'deliver edit/final.mp4',
  preview:
    'finish it as a live preview in edit/preview/ (Studio Engine renders the final video after the owner approves)',
};

/**
 * The `{{again}}` sentence of revise.md and render.md: nothing on a run's first try, else what
 * became of the last one. `error` is already on one line (`oneLine`).
 */
export function againText(
  kind: 'revise' | 'render',
  mode: RunMode,
  step: StepId,
  error: string,
): string {
  const label = STEP_LABELS[step];
  if (mode === 'resume') {
    const what = kind === 'revise' ? 'run of this round' : 'render';
    return `An earlier ${what} was stopped at step ${step} of 8 (${label}). Carry on from what is in ./edit/.`;
  }
  if (mode === 'retry') {
    const what = kind === 'revise' ? 'this round' : 'the render';
    const why = error.replace(/[\s.]+$/, '');
    return `The previous attempt at ${what} failed at step ${step} of 8 (${label}) with: ${why}. Find the cause first and fix it.`;
  }
  return '';
}

/** Where the Draft finds Studio Engine's rules and the brief's shape (DR4), relative to the job folder. */
export const STUDIO_NOTES_PATH = 'edit/studio/notes.md';
export const STUDIO_BRIEF_SCHEMA_PATH = 'edit/studio/brief-schema.json';

/** draft.md's `{{noteBlock}}`: The owner's note word for word, or that they left none. */
export function draftNoteBlock(note: string | null | undefined): string {
  const text = (note ?? '').replace(/\{\{|\}\}/g, '').trim();
  if (text === '') return 'The owner left no note on this job.';
  return `The owner's note on this job, word for word:\n${text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')}`;
}

/** draft.md's `{{briefLine}}`: read the brief, or (the placeholder) read the instructions and write it. */
export function draftBriefLine(pending: boolean): string {
  if (!pending) {
    return "What the client's instructions and the owner's note say is in ./edit/brief.md (./edit/brief.json is the same brief as data): read it before anything else.";
  }
  return `Nobody has read the client's instructions yet: read them yourself first, every brief, chat, screenshot, voice note (transcribe it) and logo in this folder, with the owner's note above. Then write what you understood to ./edit/brief.json, every field, in the shape ./${STUDIO_BRIEF_SCHEMA_PATH} describes: null where they say nothing, every file of the folder in \`files\` with its role, and your guesses in \`assumptions\` and \`assumed\`. Studio Engine shows it to the owner and keeps it for the job.`;
}

/** draft.md's `{{again}}`: nothing on a first Draft, else what became of the last one. */
export function draftAgainText(mode: RunMode, step: StepId, error: string): string {
  const label = STEP_LABELS[step];
  if (mode === 'resume') {
    return `An earlier Draft of this job was stopped at step ${step} of 8 (${label}). Its work is in ./edit/: read edit/project.md and carry on from there instead of starting over, and do not transcribe again (reuse edit/transcripts/).`;
  }
  if (mode === 'retry') {
    const why = error.replace(/[\s.]+$/, '');
    return `The previous Draft failed at step ${step} of 8 (${label}) with: ${why}. Find the cause first and fix it, then carry on from the work in ./edit/ (reuse edit/transcripts/).`;
  }
  return '';
}

/** A path in the job folder, as the prompt names it (the run's working directory is the job folder). */
const inJob = (path: string): string => `./${path}`;

/** What the missing tokens of a run say, one sentence each. */
function missingText(ref: RunLibraryRefs['missing'][number]): string {
  const token = `@${ref.library}/${ref.slug}`;
  const ending = 'Do the closest thing and say so in project.md.';
  switch (ref.reason) {
    case 'notInLibrary':
      return `The note names ${token}, which is not in the library. ${ending}`;
    case 'noFile':
      return `The note names ${token}, but its file could not be copied into this job. ${ending}`;
    case 'notInJob':
      return `The note names ${token}, which is in the library but not in this job’s edit/graphics/. ${ending}`;
  }
}

/** The parts of the "Library references" block that depend on what the notes named (LU9, FN15). */
export interface LibraryRefsText {
  /** What the block's first line says after "Library references:", by the kinds the notes named. */
  intro: string;
  /**
   * The list, one line per item (two spaces in): each LUT, graphic and token that points at
   * nothing, each font name the library lacks, then each font it has, in the order the notes first
   * name them.
   */
  list: string;
  /** `--look-lut ./edit/luts/a.cube --look-lut ./edit/luts/b.cube`: the Look and Fix LUTs, in order; `''` for none. */
  lookLutArgs: string;
  /** Which kind parts apply. */
  has: { look: boolean; cinematic: boolean; camera: boolean; graphic: boolean; font: boolean };
  /** The sentence the colour-grade parts end with; `''` when no Look or Fix LUT is named. */
  gradeNote: string;
}

/** Whether the references name anything the prompt must say. */
export function hasLibraryRefs(refs: RunLibraryRefs | null | undefined): refs is RunLibraryRefs {
  return (
    refs != null &&
    refs.luts.length +
      refs.graphics.length +
      refs.missing.length +
      (refs.fonts?.length ?? 0) +
      (refs.unresolvedFonts?.length ?? 0) >
      0
  );
}

/**
 * What the block's first line says after "Library references:", by what the notes named. The LUT
 * sentence (LU9) is there whenever a LUT, a graphic or a token that points at nothing is; a run
 * that names only fonts (FN15) gets no word about LUTs.
 */
const FOUND = 'and Studio Engine has already found them for you.';
const LUT_RULE =
  ' A LUT named in a note applies to the whole video, at full strength: do what the note says about where, if it says. Whatever a note names, never add another grade in render.py or HyperFrames.';
const LUT_INTRO = `the notes name items of the owner's library with @luts/… and @graphics/… tokens, ${FOUND}${LUT_RULE}`;
const MIXED_INTRO = `the notes name items of the owner's library with @luts/…, @graphics/… and font tokens (an @ and the font's full name, like @Heebo Bold), ${FOUND}${LUT_RULE}`;
const FONT_INTRO = `the notes name fonts of the owner's library with an @ and the font's full name (like @Heebo Bold), ${FOUND}`;
// A note that names a font the library does not have (FN16). With fonts that were found too, only
// those are "already found"; with none, the block says what is wrong.
const FONT_SOME_INTRO = `the notes name fonts of the owner's library with an @ and the font's full name (like @Heebo Bold), and Studio Engine has already found the ones the library has.`;
const FONT_NONE_INTRO =
  "the notes name a font with an @ and the font's full name (like @Heebo Bold) that the owner's library does not have.";

/** A path as one line of the list: no line breaks or other control characters. */
function onePath(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
  return path.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** The list line of a font: its name, script, weight and the file in the job (FN15). */
function fontLine(font: RunFont): string {
  const weight = `weight ${font.weight}${font.italic ? ', italic' : ''}`;
  return `  - @${oneLine(font.face)}: “${oneLine(font.face)}”, script ${fontScriptLabel(font.he)}, family ${oneLine(font.family)}, ${weight}, file ${inJob(onePath(font.path))}`;
}

/**
 * The list line of a font name the library does not have (FN16): what the owner asked for, that the job
 * has no such file, and what to do. The job does not wait for it and does not fail.
 */
function missingFontLine(name: string): string {
  return `  - The owner asked for ${oneLine(name)}; it is not in edit/fonts/. Use the closest font that is there and say which one you used in your answer.`;
}

/**
 * What the block's first line says by what the notes named: LUT or graphic items (or a token that
 * points at nothing) are `lutSide`, `found` is a font the library has, `lacks` a font name it does
 * not have.
 */
function introOf({
  lutSide,
  found,
  lacks,
}: {
  lutSide: boolean;
  found: boolean;
  lacks: boolean;
}): string {
  if (lutSide) return found || lacks ? MIXED_INTRO : LUT_INTRO;
  if (!found) return FONT_NONE_INTRO;
  return lacks ? FONT_SOME_INTRO : FONT_INTRO;
}

/** The texts luts-use.md and its parts are made from. Pure: the same references, the same text. */
export function libraryRefsText(refs: RunLibraryRefs): LibraryRefsText {
  const lines: string[] = [];
  const lookFiles: string[] = [];
  const has = { look: false, cinematic: false, camera: false, graphic: false, font: false };
  for (const lut of refs.luts) {
    const token = `@luts/${lut.slug}`;
    if (lut.look !== null || lut.path === null) {
      has.cinematic = true;
      lines.push(`  - ${token}: “${oneLine(lut.name)}”, the built-in Cinematic look (no file).`);
      continue;
    }
    const kind = LUT_KIND_LABELS[lut.kind];
    if (lut.kind === 'camera') has.camera = true;
    else {
      has.look = true;
      lookFiles.push(inJob(lut.path));
    }
    lines.push(`  - ${token}: “${oneLine(lut.name)}”, a ${kind} LUT, file ${inJob(lut.path)}`);
  }
  for (const graphic of refs.graphics) {
    has.graphic = true;
    lines.push(
      `  - @graphics/${graphic.slug}: the library graphic “${oneLine(graphic.name)}”, its copy is in ${inJob(graphic.path)}/`,
    );
  }
  for (const ref of refs.missing) lines.push(`  - ${missingText(ref)}`);
  const lutSide = lines.length > 0;
  // The names the library lacks sit with the other things that point at nothing (before the fonts
  // it has), so the fonts rule that ends the block follows the font lines it is about (FN16).
  const lacks = refs.unresolvedFonts ?? [];
  for (const name of lacks) lines.push(missingFontLine(name));
  for (const font of refs.fonts ?? []) {
    has.font = true;
    lines.push(fontLine(font));
  }
  return {
    intro: introOf({ lutSide, found: has.font, lacks: lacks.length > 0 }),
    list: lines.join('\n'),
    lookLutArgs: lookFiles.map((file) => `--look-lut ${file}`).join(' '),
    has,
    gradeNote:
      lookFiles.length === 0
        ? ''
        : 'Besides `--look`, the wrapper has `--look-lut FILE.cube` for a LUT the notes name: see Library references.',
  };
}

/** `“a.mp4”, “b.mp4”`: file names as the prompt quotes them. */
function quotedFiles(files: readonly string[]): string {
  return files.map((file) => `“${oneLine(file)}”`).join(', ');
}

/**
 * The lines about camera log in an edit run (luts-camera.md's `{{> camera-lines}}`): one per curve
 * the job's files name, or the one line saying a note's Camera LUT wins; `''` for none (the file
 * names no curve). The exact `Blocked:` sentence is the contract with the page (LU10).
 */
export function cameraLinesText(camera: RunCameraLuts): string {
  if (camera.byNote) {
    return '  - A note already names a Camera LUT (see Library references): it wins, so do not look for another one.';
  }
  return camera.curves
    .map((entry) => {
      const one = entry.files.length === 1;
      const says = `${quotedFiles(entry.files)} say${one ? 's it was' : ' they were'} shot in ${entry.label}`;
      const source = entry.files[0] === undefined ? null : oneLine(entry.files[0]);
      switch (entry.match.kind) {
        case 'one': {
          const { lut } = entry.match;
          const inEdit = lut.path.replace(/^edit\//, '');
          return `  - ${says}. The library has one Camera LUT for that, “${oneLine(lut.name)}”, file ${inJob(lut.path)}. If the report calls their source log or ambiguous, or lists it under weak_log, set color_grade.sources.<source id>.camera_lut to "${inEdit}" in edit/edl.json and run the wrapper again in a fresh output directory; if it calls them display and does not list it under weak_log, leave them alone.`;
        }
        case 'several':
          return `  - ${says}, and more than one Camera LUT names that curve (${quotedFiles(entry.match.names)}), so none was chosen. If the report calls their source log or ambiguous, or lists it under weak_log, and no note names one, finish what does not depend on it and make your last line exactly: Blocked: ${cameraLutWaitSentence({ curve: entry.curve, source, several: true })}`;
        default:
          return `  - ${says}, and no Camera LUT in the library names that curve. If the report calls their source log or ambiguous, or lists it under weak_log, finish what does not depend on it and make your last line exactly: Blocked: ${cameraLutWaitSentence({ curve: entry.curve, source })}`;
      }
    })
    .join('\n');
}

/** "1:1 (1080x1080)": a format as the formats parts name it. */
function formatName(format: JobFormat): string {
  return `${format.label} (${format.width}x${format.height})`;
}

/**
 * The values the formats parts (formats-use.md, formats-render.md) are made from; all empty for a
 * job with fewer than two formats, where those parts are not read. Pure.
 */
export function formatsValues(formats: readonly JobFormat[] | undefined): Record<string, string> {
  const main = formats?.[0];
  const extras = extraFormatsOf(formats);
  if (main === undefined || extras.length === 0) {
    return {
      formatsCount: '',
      formatsMain: '',
      formatsExtraList: '',
      formatsRenderList: '',
      formatsFinals: '',
    };
  }
  return {
    formatsCount: String(extras.length + 1),
    formatsMain: formatName(main),
    formatsExtraList: extras
      .map((format) => `edit/${extraPreviewDirName(format.id)}/ for ${formatName(format)}`)
      .join(', '),
    formatsRenderList: extras
      .map(
        (format) =>
          `  - ${format.label}: from edit/${extraPreviewDirName(format.id)}/, npx hyperframes render -q delivery --strict --no-best-effort -o ../${extraFinalName(format.id)}`,
      )
      .join('\n'),
    formatsFinals: extras.map((format) => `edit/${extraFinalName(format.id)}`).join(', '),
  };
}

/**
 * The values the revise part of a generated video (generate-revise.md) is made from; all empty
 * without `generated`, where that part is not read. Pure.
 */
export function generatedValues(
  generated: GeneratedPromptVars | null | undefined,
): Record<string, string> {
  if (generated == null) {
    return {
      generateVoiceScript: '',
      generateShotsScript: '',
      generateEditDir: '',
      generateBudget: '',
      generateSpent: '',
      generateLeft: '',
      generateBudgetNumber: '',
    };
  }
  const money = { spendUsd: generated.spentUsd, budgetUsd: generated.budgetUsd };
  return {
    generateVoiceScript: generated.voiceScript,
    generateShotsScript: generated.shotsScript,
    generateEditDir: generated.editDir,
    generateBudget: budgetUsdText(generated.budgetUsd),
    generateSpent: spendUsdText(generated.spentUsd),
    generateLeft: budgetUsdText(budgetLeftUsd(money)),
    generateBudgetNumber: budgetNumberText(generated.budgetUsd),
  };
}

/**
 * The prompt for one run. The kind (`vars.kind`, default edit) and the mode pick the template (see
 * the header). `retry` needs `step` and `error`, `resume` needs `step`; a missing step falls back
 * to the kind's first step (1, Brief, for an edit). An edit run includes `brief-use.md`, which
 * points the run at edit/brief.md, and `review` (the Review switch) picks how it ends: the goal
 * line and which of the two finish partials is used. A revise run needs `round`, 1 or more.
 */
export async function buildPrompt(
  mode: RunMode,
  vars: PromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const { kind, values, partials } = await promptParts(mode, vars, dir);
  if (kind === 'edit' && vars.draft === true) {
    // The Draft (DR4): one template whatever the mode. Its optional lines leave no blank run.
    const template = await readTemplate(dir, 'draft');
    return `${renderTemplate(template, values, partials)
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()}\n`;
  }
  const template = await readTemplate(dir, kind === 'edit' ? mode : kind);
  // An empty {{again}} leaves a space at the end of its line; no edit prompt has trailing spaces.
  return `${renderTemplate(template, values, partials)
    .replace(/[ \t]+$/gm, '')
    .trim()}\n`;
}

/**
 * The Draft's edit/studio/notes.md (DR4): the rules an edit prompt says inline (brief-use and its
 * footage-quality rules, the generated, music and stock parts, the unattended notes with the
 * grade, the graphics, LUTs and fonts), rendered with the same variables, in a file the Draft reads
 * at each stage.
 */
export async function buildStudioNotes(
  mode: RunMode,
  vars: PromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const { values, partials } = await promptParts(mode, { ...vars, kind: 'edit' }, dir);
  const template = await readTemplate(dir, 'studio-notes');
  return `${renderTemplate(template, values, partials)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/** The variables and partials every edit, revise and render template is rendered with. */
async function promptParts(
  mode: RunMode,
  vars: PromptVars,
  dir: string,
): Promise<{
  kind: RunKind;
  values: Record<string, string>;
  partials: Record<string, PromptPartial>;
}> {
  const kind = vars.kind ?? 'edit';
  if (kind === 'revise' && !(Number.isInteger(vars.round) && (vars.round ?? 0) >= 1)) {
    throw new Error('A revise prompt needs the round it applies (1 or more)');
  }
  const music = vars.music === true;
  if (music && !vars.musicScript) {
    throw new Error('A prompt with music needs the music script’s path (musicScript)');
  }
  const stock = vars.stock === true;
  if (stock && !vars.stockScript) {
    throw new Error('A prompt with stock media needs the stock script’s path (stockScript)');
  }
  // Songs only count with the music on: they are one more way for the music to come in.
  const songs = music && vars.songs === true;
  const step = vars.step ?? firstStepOf(kind); // edit: 1, as before
  const finish = runFinishOf(kind, vars.review === true);
  const error = oneLine(vars.error ?? 'unknown (it was not recorded)');
  // Only an edit or revise run has notes to read; a render run edits nothing.
  const refs = kind !== 'render' && hasLibraryRefs(vars.libraryRefs) ? vars.libraryRefs : null;
  const refsText = refs === null ? null : libraryRefsText(refs);
  // Formats (GN7): two or more only; anything less leaves both formats parts empty.
  const formats = vars.formats !== undefined && vars.formats.length >= 2 ? vars.formats : null;
  const values: Record<string, string> = {
    ...formatsValues(formats ?? undefined),
    client: oneLine(vars.client),
    job: oneLine(vars.job),
    step: String(step),
    stepLabel: STEP_LABELS[step],
    error,
    goal: GOALS[finish],
    round: String(vars.round ?? 0),
    again: kind === 'edit' ? '' : againText(kind, mode, step, error),
    // A path, put in as it is: one pass, so nothing in it is read as a template.
    musicScript: music ? (vars.musicScript ?? '') : '',
    stockScript: stock ? (vars.stockScript ?? '') : '',
    // Shell-quote the computed path: repository paths can contain spaces or an apostrophe.
    colorGradeScript: `'${COLOR_GRADE_SCRIPT.replaceAll("'", "'\\''")}'`,
    // Library references (LU9, FN15): empty unless an edit or revise run's notes name something.
    libraryIntro: refsText?.intro ?? '',
    libraryRefList: refsText?.list ?? '',
    lookLutArgs: refsText?.lookLutArgs ?? '',
    lutsGradeNote: refsText?.gradeNote ?? '',
    // A generated video (GN6): only the revise part reads these; empty for every other run.
    ...generatedValues(vars.generated),
    // The Draft (DR4): only draft.md reads these.
    noteBlock: draftNoteBlock(vars.note),
    briefLine: draftBriefLine(vars.briefPending === true),
  };
  if (kind === 'edit' && vars.draft === true) values.again = draftAgainText(mode, step, error);
  const finalFinish = await readTemplate(dir, 'final-finish');
  const previewFinish = await readTemplate(dir, 'preview-finish');
  const briefUse = await readTemplate(dir, 'brief-use');
  const graphics = vars.graphics === true;
  const lutsUse = refsText === null ? '' : await readTemplate(dir, 'luts-use');
  // Camera log (LU10): only an edit run whose engine looked at the footage (lutsInEdits on).
  const camera = kind === 'edit' ? (vars.libraryRefs?.camera ?? null) : null;
  const cameraBlock = camera === null ? '' : await readTemplate(dir, 'luts-camera');
  const cameraLines = camera === null ? '' : cameraLinesText(camera);
  // A generated video (GN6): the edit run's part (a paragraph of its own, like music) or the revise
  // run's lines; a render run is told nothing.
  const generated = vars.generated ?? null;
  const partials: Record<string, PromptPartial> = {
    generated:
      generated !== null && kind === 'edit'
        ? `\n${await readTemplate(dir, 'generated')}`
        : { raw: '' },
    'generate-revise':
      generated !== null && kind === 'revise'
        ? await readTemplate(dir, 'generate-revise')
        : { raw: '' },
    unattended: await readTemplate(dir, 'unattended'),
    'color-grade': await readTemplate(dir, kind === 'edit' ? 'color-grade' : `color-grade-${kind}`),
    // With the library on, brief-use ends with one more line: the order of authority (GR8).
    'brief-use': graphics
      ? `${briefUse.trimEnd()}\n${(await readTemplate(dir, 'brief-use-graphics')).trimEnd()}\n`
      : briefUse,
    // ... and the unattended notes say where the library is, right after the read-only line.
    'unattended-graphics': graphics ? await readTemplate(dir, 'unattended-graphics') : { raw: '' },
    'final-finish': finalFinish,
    'preview-finish': previewFinish,
    // Formats (GN7): the build part sits inside preview-finish (an edit run that ends in Review, a
    // revise run), the render part inside render.md. Empty for a job with one format.
    'formats-use': formats === null ? { raw: '' } : await readTemplate(dir, 'formats-use'),
    'formats-render':
      formats === null || kind !== 'render'
        ? { raw: '' }
        : await readTemplate(dir, 'formats-render'),
    // preview-finish's self-eval line: the whole check, or the slim one for a Revise-tier round (QF4).
    'self-eval': await readTemplate(
      dir,
      kind === 'revise' && vars.checks === 'slim' ? 'self-eval-slim' : 'self-eval-full',
    ),
    // The two composition rules preview-finish shares with the quick fix run (quick-fix.md).
    'composition-rules': await readTemplate(dir, 'composition-rules'),
    // The edit prompts end with the finish of a run that ends in Review ...
    finish: kind === 'edit' && finish === 'preview' ? previewFinish : { raw: '' },
    // ... while an edit run that delivers final.mp4 keeps its done line where it always was, in
    // the unattended notes. A revise or render run names its own finish in its template, so both
    // of these slots are empty for it.
    'unattended-finish': kind === 'edit' && finish === 'final' ? finalFinish : { raw: '' },
    // Soundtrack: each kind's music part, only while the switch is on. The edit's is a paragraph of
    // its own after brief-use, so it starts with the blank line its slot leaves out.
    music: kind === 'edit' && music ? `\n${await readTemplate(dir, 'music')}` : { raw: '' },
    'music-revise':
      kind === 'revise' && music ? await readTemplate(dir, 'music-revise') : { raw: '' },
    'music-render':
      kind === 'render' && music ? await readTemplate(dir, 'music-render') : { raw: '' },
    // Stock media: the edit's part is a paragraph of its own after the music (it starts with the
    // blank line its slot leaves out), the revise run's one line of its list. A render run edits
    // nothing, so it is told nothing.
    stock: kind === 'edit' && stock ? `\n${await readTemplate(dir, 'stock')}` : { raw: '' },
    'stock-revise':
      kind === 'revise' && stock ? await readTemplate(dir, 'stock-revise') : { raw: '' },
    // Songs (SG4): the lines the song adds to those parts, there only while the switch is on.
    'music-songs-sources':
      kind === 'edit' && songs ? await readTemplate(dir, 'music-songs-sources') : { raw: '' },
    'music-songs': kind === 'edit' && songs ? await readTemplate(dir, 'music-songs') : { raw: '' },
    'music-revise-songs':
      kind === 'revise' && songs ? await readTemplate(dir, 'music-revise-songs') : { raw: '' },
    // LUTs in notes (LU9): one block for the edit's unattended notes, one for the revise run's list,
    // each made of the kind parts there are.
    'unattended-luts':
      kind === 'edit' && (refsText !== null || cameraBlock !== '')
        ? `${[lutsUse.trimEnd(), cameraBlock.trimEnd()].filter((part) => part !== '').join('\n')}\n`
        : { raw: '' },
    // Camera log (LU10): the lines of luts-camera.md, one per curve the footage names.
    'camera-lines': { raw: cameraLines },
    'luts-use': kind === 'revise' && refsText !== null ? lutsUse : { raw: '' },
    'luts-use-look':
      refsText?.has.look === true ? await readTemplate(dir, 'luts-use-look') : { raw: '' },
    'luts-use-cinematic':
      refsText?.has.cinematic === true
        ? await readTemplate(dir, 'luts-use-cinematic')
        : { raw: '' },
    'luts-use-camera':
      refsText?.has.camera === true ? await readTemplate(dir, 'luts-use-camera') : { raw: '' },
    'luts-use-graphic':
      refsText?.has.graphic === true ? await readTemplate(dir, 'luts-use-graphic') : { raw: '' },
    // Fonts in notes (FN15): the last part of the same block, there only when a font is named.
    'fonts-use': refsText?.has.font === true ? await readTemplate(dir, 'fonts-use') : { raw: '' },
  };
  return { kind, values, partials };
}

/** One file of the job folder as the Brief prompt lists it. */
export interface BriefPromptFile {
  /** Path inside the job folder. */
  relPath: string;
  kind: FileKind;
  /** Bytes. */
  size: number;
  mtimeMs: number;
  /** Seconds, for video and audio; `null` when ffprobe could not read it or the kind has none. */
  durationSec: number | null;
  /**
   * A picture the owner attached to the note in the app (edit/brief/from-you/, Songs): the list says
   * "attached by the owner" for it. Left out for every file of the folder.
   */
  attached?: boolean;
  /**
   * A file unpacked from a zip of the job folder (Generate, GN4): the zip, relative to the job
   * folder. The list says "from <zip>" for it. Left out for every file of the folder.
   */
  fromZip?: string;
}

export interface BriefPromptVars {
  client: string;
  job: string;
  /** The owner's note for the job, word for word; `null` or blank is "(none)". */
  note: string | null;
  /** The files the brief is about, listed in the prompt so the run needs no Bash to list them. */
  files: readonly BriefPromptFile[];
  /**
   * The episode's series, when the engine will add its "Series" section to brief.md below the
   * run's brief (CVP-255). Left out or `null` for any other job: the prompt is then unchanged.
   */
  series?: BriefPromptSeries | null;
  /**
   * The Soundtrack switch (`Config.music`, U21). On: the prompt has the music part (brief-music.md:
   * `music.wanted`, true only when the instructions ask for music) and its schema has `wanted`
   * (`briefPromptSchema({ music: true })`). The Songs switch counts as on too, since Songs only runs
   * with the music. Left out or off: the prompt is exactly what it was before.
   */
  music?: boolean;
  /**
   * The Songs switch (`Config.songs`). On: the prompt has the songs part (brief-songs.md) and its
   * schema has the song keys of `music` (`briefPromptSchema({ songs: true })`). Left out or off:
   * the prompt is exactly what it was before Songs.
   */
  songs?: boolean;
  /**
   * The Generate switch (`Config.generate`). On: the prompt has the rules for the four
   * Generated-video keys (brief-generate.md) and its schema lists `production`, `voiceover`,
   * `formats` and `budgetUsd` (`briefPromptSchema({ generate: true })`). Left out or off: the
   * prompt is exactly what it was before Generated videos.
   */
  generate?: boolean;
  /**
   * The client's shared files (`<Client>/_Shared`, paths inside it), given only while the Generate
   * switch is on and the job folder has no footage: the clips its instructions name may be there,
   * and then the video is an edit of them, not a generated one (`{{> brief-shared}}` inside
   * brief-generate.md). Left out or empty: no such part.
   */
  shared?: readonly string[];
}

/** What the Brief prompt is told about an episode's series. */
export interface BriefPromptSeries {
  /** The series' name, as its folder in `_Series` is called. */
  name: string;
  /** The job's episode number; `null` when its name has none. */
  episode: number | null;
}

/** What the Brief prompt says when the job has no note. */
export const NO_NOTE = '(none)';

/** What the Brief prompt says when the folder has no files. */
export const NO_FILES = '(no files)';

/**
 * What the Brief prompt says about an episode, right after its job line (`{{> episode}}`): empty
 * for any other job, which takes the line with it. Without it the run's summary said everything
 * else follows video-use's defaults, above the Series section that says the opposite (CVP-255).
 */
export function episodeText(series: BriefPromptSeries | null | undefined): string {
  if (!series) return '';
  const which = series.episode === null ? 'an episode' : `episode ${series.episode}`;
  return `This job is ${which} of the series “${oneLine(series.name)}”. The engine adds the series’ format to the brief after yours, and the editor rebuilds the episode from it. So a field you leave null is decided by the series, not by video-use’s defaults, and summary says the episode is rebuilt from the series: never that anything follows video-use’s defaults.`;
}

const KIND_LABELS: Readonly<Record<FileKind, string>> = {
  video: 'video',
  audio: 'audio',
  image: 'image',
  doc: 'text',
  other: 'unknown type',
};

/** "480 bytes", "45 KB", "1.2 MB", "3.4 GB": decimal units, one decimal only under 10. */
export function briefFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000)
    return `${Math.max(0, Math.trunc(bytes) || 0)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/** "2026-10-19 08:03 UTC": the same everywhere, whatever the Mac's time zone. */
function briefFileTime(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The `{{files}}` list of the Brief prompt, one line per file:
 * `- <path> (<kind>, <size>, <duration for video and audio>, [from <zip>,] [attached by the owner,] modified <time>)`. The engine already
 * walked the folder and probed the lengths, so the run needs no Bash for its step 1. The modified
 * time stays in because "the newest message wins (…then file dates)" needs it, and `ls -la` is
 * what used to give it. Line breaks in a name are flattened so one file stays one line.
 */
export function formatBriefFiles(files: readonly BriefPromptFile[]): string {
  if (files.length === 0) return NO_FILES;
  return files
    .map((file) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
      const name = file.relPath.replace(/[\u0000-\u001f\u007f]+/g, ' ');
      const parts: string[] = [KIND_LABELS[file.kind], briefFileSize(file.size)];
      if (file.kind === 'video' || file.kind === 'audio') {
        parts.push(file.durationSec === null ? 'duration unreadable' : clock(file.durationSec));
      }
      if (file.fromZip !== undefined) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
        parts.push(`from ${file.fromZip.replace(/[\u0000-\u001f\u007f]+/g, ' ')}`);
      }
      if (file.attached === true) parts.push('attached by the owner');
      parts.push(`modified ${briefFileTime(file.mtimeMs)}`);
      return `- ${name} (${parts.join(', ')})`;
    })
    .join('\n');
}

/**
 * `{{> brief-shared}}` of brief-generate.md: the client's shared files, listed the way brief.md
 * lists them, for a job folder with no footage of its own. Empty for none, which takes its line with it.
 */
export function briefSharedText(shared: readonly string[] | undefined): string {
  if (shared === undefined || shared.length === 0) return '';
  const { list, folded } = listByFolder(shared);
  return [
    `  - The folder has no footage, but the client keeps files for all of its videos in its _Shared folder (../_Shared/ from the job folder). You don’t open them: the engine lists them in the brief and the edit run copies the ones it uses. They are, one line per folder${folded ? ' (a{1,2}.mp4 means a1.mp4 and a2.mp4)' : ''}:`,
    ...list.map((line) => `    ${oneLine(line)}`),
    '    When the instructions name clips that are in this list (C7909 for C7909.MP4), they are this video’s footage and the video is an edit of them: production is null, and summary says the clips are in the client’s shared files, never that they are missing.',
  ].join('\n');
}

/**
 * The prompt of the Brief run (brief.md). `{{> brief-schema}}` is the JSON Schema of the draft
 * schema the engine validates edit/brief.json with, so the two can't drift apart.
 */
export async function buildBriefPrompt(
  vars: BriefPromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const note = (vars.note ?? '').trim();
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    job: oneLine(vars.job),
    note: note === '' ? NO_NOTE : note,
    files: formatBriefFiles(vars.files),
  };
  const songs = vars.songs === true;
  // Songs only run with the music (the config turns songs off without it), so either one asks for `wanted`.
  const music = vars.music === true || songs;
  const generate = vars.generate === true;
  const partials: Record<string, PromptPartial> = {
    'brief-schema': { raw: briefPromptSchema({ music, songs, generate }) },
    episode: { raw: episodeText(vars.series) },
    // Songs (SG4): reading the song off a screenshot, a link or the words, only while the switch is on.
    'brief-songs': songs ? await readTemplate(dir, 'brief-songs') : { raw: '' },
    // Music only when asked (U21): when the instructions ask for music, only while the music switch is on.
    'brief-music': music ? await readTemplate(dir, 'brief-music') : { raw: '' },
    // Generated videos (GN4): the rules for production, voiceover, formats and budgetUsd, only while the switch is on.
    'brief-generate': generate ? await readTemplate(dir, 'brief-generate') : { raw: '' },
    // A job folder with no footage: the clips its instructions name may be in the client's _Shared.
    'brief-shared': { raw: generate ? briefSharedText(vars.shared) : '' },
  };
  const template = await readTemplate(dir, 'brief');
  return `${renderTemplate(template, values, partials).trim()}\n`;
}
