// The prompts of the style runs (Phase 2 plan §5), rendered by the same template code as the edit
// and Brief prompts (pipeline/prompts.ts). Both include the style-shape.md partial.
//
// The Read pass, apps/server/prompts/style-read.md. The engine computes two of its variables:
//
//   {{files}}     one "- name (size)" line per new file
//   {{modeText}}  what the mode asks of the run, with the file names and today's date filled in.
//                 Word for word from the plan, except `replace` (C17): it drops ## Kit, because
//                 the engine moves the client's kit to history with the old style.md
//
// The Learn pass, apps/server/prompts/style-learn.md: {{client}}, {{job}}, {{date}}, {{styleDir}}
// (the absolute path of `_Style`), {{kit}} (what was copied into kit/: the slot folders, or the
// edit's one composition, or "none"; style-kit.ts) and
// {{step5}}, what the mode asks of the run (C10): `create` and `replace` write the style from this
// video, `merge` adds its look to the current style.md. Word for word from the work item, with the
// job, the date and the style folder filled in.

import {
  briefFileSize,
  oneLine,
  PROMPTS_DIR,
  readTemplate,
  renderTemplate,
} from '../pipeline/prompts.js';
import { COMPOSITION_KIT_NAME } from './style-kit.js';
import type { LearnMode, ReadMode, StyleFile } from './style-pass.js';

export interface StyleReadPromptVars {
  client: string;
  /** Already settled against the folder: `create` when there is no style.md. */
  mode: ReadMode;
  files: readonly StyleFile[];
  /** Today as YYYY-MM-DD, for “Plus <files> (<date>).” */
  date: string;
}

/** A file name on one line: line breaks and other control characters become spaces. */
function flat(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** The `{{files}}` list: `- <name> (<size>)` per file. */
export function formatStyleFiles(files: readonly StyleFile[]): string {
  return files.map((file) => `- ${flat(file.name)} (${briefFileSize(file.size)})`).join('\n');
}

/** "logo.png", "logo.png and notes.txt", "logo.png, notes.txt and brand.pdf". */
export function joinFileNames(files: readonly StyleFile[]): string {
  const names = files.map((file) => flat(file.name));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The `{{modeText}}` of each mode (plan §5, "Read prompt"). */
export function readModeText(mode: ReadMode, files: readonly StyleFile[], date: string): string {
  const names = joinFileNames(files);
  switch (mode) {
    case 'create':
      return `There is no style yet. Write it from the new files. The line under the title is “From your files: ${names}.”`;
    case 'add':
      return `style.md is the current style. Merge the new files into it: keep everything they don’t contradict, and where they disagree, the new files win. Keep the line under the title and add “Plus ${names} (${date}).” Keep ## Kit as it is.`;
    case 'replace':
      return `Write a new style from the new files only and ignore style.md. The line under the title is “From your files: ${names}.” Leave out ## Kit: the client’s old graphics go to history with the old style, so the new style has no kit.`;
  }
}

/** YYYY-MM-DD in the Mac's own time zone: the date the owner would write. */
export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The prompt of one Read pass. Templates are read on every run, like the other prompts. */
export async function buildStyleReadPrompt(
  vars: StyleReadPromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    files: formatStyleFiles(vars.files),
    modeText: readModeText(vars.mode, vars.files, vars.date),
  };
  const partials = { 'style-shape': await readTemplate(dir, 'style-shape') };
  const template = await readTemplate(dir, 'style-read');
  return `${renderTemplate(template, values, partials).trim()}\n`;
}

export interface StyleLearnPromptVars {
  client: string;
  /** Already settled against the folder: `merge` only when there is a style.md. */
  mode: LearnMode;
  /** The job folder's name. */
  job: string;
  /** Today as YYYY-MM-DD, for “Learned from <job> (<date>).” and “Plus <job> (<date>).” */
  date: string;
  /** The absolute path of the client's `_Style` folder. */
  styleDir: string;
  /** What was copied into `_Style/kit/`: the slot folders, or `composition` (C14); none is "none". */
  kit: readonly string[];
}

/** The `{{step5}}` of each mode, with the job, the date and the style folder already in it. */
export function learnStep5(
  mode: LearnMode,
  { job, date, styleDir }: { job: string; date: string; styleDir: string },
): string {
  switch (mode) {
    case 'create':
    case 'replace':
      return `5. Write ${styleDir}/style.md.new in this shape, with “Learned from ${job} (${date}).” as the line under the title. Describe what this video does, as rules for the next one:`;
    case 'merge':
      return `5. Merge this video’s look into ${styleDir}/style.md, the client’s current style, and write the result to ${styleDir}/style.md.new in the same shape. Keep everything this video doesn’t contradict; where they disagree, this video wins, since it is the newest one the owner approved. Keep the line under the title and add “Plus ${job} (${date}).” Keep Do, Don’t and Reference, adding only rules from this video’s edit/brief.md. Write ## Kit for the graphics now in kit/:`;
  }
}

/** What `{{kit}}` says about the `composition` folder, so the run knows where to look in the job. */
const COMPOSITION_KIT_TEXT =
  'composition (the edit’s one composition, copied from edit/preview/ or edit/composition/: index.html with its compositions, fonts and assets)';

/** The `{{kit}}` text: "slot_title, slot_captions and slot_end", the composition, or "none". */
export function kitNames(kit: readonly string[]): string {
  if (kit.length === 0) return 'none';
  return joinFileNames(
    kit.map((name) => ({
      name: name === COMPOSITION_KIT_NAME ? COMPOSITION_KIT_TEXT : name,
      size: 0,
    })),
  );
}

/** The prompt of one Learn pass. Templates are read on every run, like the other prompts. */
export async function buildStyleLearnPrompt(
  vars: StyleLearnPromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const job = oneLine(vars.job);
  const styleDir = flat(vars.styleDir);
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    job,
    date: vars.date,
    styleDir,
    kit: kitNames(vars.kit),
    step5: learnStep5(vars.mode, { job, date: vars.date, styleDir }),
  };
  const partials = { 'style-shape': await readTemplate(dir, 'style-shape') };
  const template = await readTemplate(dir, 'style-learn');
  return `${renderTemplate(template, values, partials).trim()}\n`;
}
