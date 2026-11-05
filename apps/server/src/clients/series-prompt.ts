// The prompt of the series passes (Series plan §3), rendered by the same template code as the
// style prompts (style-prompt.ts), with the series-shape.md partial.
//
// A `series` pass, apps/server/prompts/series-learn.md: {{client}}, {{series}}, {{job}}, {{date}},
// {{seriesDir}} (the absolute path of `_Series/<name>`) and four that depend on the pass:
//
//   {{styleTarget}}  " and <styleDir>/style.md.new", or nothing
//   {{step5}}        step 5, which takes what only this series does out of style.md, or nothing.
//                    It ends with what to do with ## Kit, for the kit `_Style/kit/` holds once the
//                    start is in place (C23, `StartStyleKit`): keep it, remove it, or write it for
//                    the client's earlier kit, which comes back
//   {{doneFiles}}    series.md.new, and style.md.new when step 5 is there
//   {{notes}}        for an approved episode with review notes marked Series (C26): the notes files,
//                    the `## Round N` sections of its edit/project.md, and how each note becomes a
//                    rule under ## Notes with the exact value the episode has; or nothing
//
// The style is rewritten only by a `start` while the client has a style.md, and only an approval
// carries notes.
//
// Word for word from the plan, plus the paragraph naming the Bash forms the run is allowed (as in
// style-learn.md and style-read.md, C16).

import {
  briefFileSize,
  oneLine,
  PROMPTS_DIR,
  readTemplate,
  renderTemplate,
} from '../pipeline/prompts.js';
import { SERIES_FILE_NAME } from './paths.js';
import { joinFileNames } from './style-prompt.js';
import type { SeriesNotesContext, StartStyleKit } from './style-run.js';

/** A path on one line: line breaks and other control characters become spaces. */
function flatName(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: folder names can hold them
  return path.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

export interface SeriesLearnPromptVars {
  client: string;
  /** The series folder's name. */
  series: string;
  /** The episode's folder name: the run's working directory. */
  job: string;
  /** Today as YYYY-MM-DD, for “Format from <job> (<date>).” */
  date: string;
  /** The absolute path of the series folder, `<inbox>/<Client>/_Series/<name>`. */
  seriesDir: string;
  /** The absolute path of the client's `_Style` folder. */
  styleDir: string;
  /** Whether the run also writes style.md.new: a `start` while the client has a style.md. */
  writesStyle: boolean;
  /** With `writesStyle`: what `_Style/kit/` holds once the start is in place. Default none. */
  styleKit?: StartStyleKit;
  /** An approved episode's review notes marked Series, and its rounds (C26). Default none. */
  notes?: SeriesNotesContext;
}

/** "kit/composition" or "kit/slot_title and kit/slot_end": the top folders of a kit. */
function kitFolders(names: readonly string[]): string {
  return joinFileNames(names.map((name) => ({ name: `kit/${flatName(name)}`, size: 0 })));
}

/** How step 5 ends: what style.md.new's ## Kit says, so it matches what `_Style/kit/` will hold (C23). */
export function seriesStep5Kit(styleDir: string, kit: StartStyleKit): string {
  switch (kit.kind) {
    case 'keep':
      return `Keep ## Kit as it is: the graphics in ${styleDir}/kit/ stay the client’s.`;
    case 'none':
      return `Remove the ## Kit section: the graphics in ${styleDir}/kit/ go to the series, and the client has no other kit.`;
    case 'restore': {
      const from = kit.job === null ? '' : `, from ${oneLine(kit.job)}`;
      const back = `The graphics in ${styleDir}/kit/ go to the series, and the client’s kit from before them comes back in their place: ${kitFolders(kit.names)}${from}. Write ## Kit for that kit`;
      return kit.section === null
        ? `${back}, naming it.`
        : `${back}, as the style it came with did:\n## Kit\n${kit.section}`;
    }
  }
}

/** The `{{step5}}` of a `start` with a style.md, with the style folder, the series, the date and the kit in it. */
export function seriesStep5({
  styleDir,
  series,
  date,
  kit = { kind: 'none' },
}: {
  styleDir: string;
  series: string;
  date: string;
  kit?: StartStyleKit;
}): string {
  return `5. Read ${styleDir}/style.md, the client’s style. It may hold things only this series does. Write ${styleDir}/style.md.new: the same style without them, since they are in series.md now. Keep what every video of this client shares (colours, fonts, captions, logo, Do and Don’t that are not about this show). Keep the line under the title and add “Moved what only ${series} does into the series (${date}).” ${seriesStep5Kit(styleDir, kit)}`;
}

/** The files a series run must leave behind: series.md.new, and style.md.new when it writes one. */
export function seriesDoneFiles({
  seriesDir,
  styleDir,
  writesStyle,
}: Pick<SeriesLearnPromptVars, 'seriesDir' | 'styleDir' | 'writesStyle'>): string {
  const series = `${seriesDir}/series.md.new`;
  return writesStyle ? `${series} and ${styleDir}/style.md.new` : series;
}

/** A `## Round N` heading of project.md, where a revise run writes what it did with each note. */
const ROUND_HEADING = /^## Round \d+\b/;

/**
 * The `## Round N` sections of an episode's edit/project.md, in order, each up to the next heading
 * of its level or above; null when there is none. The revise prompt has the editor write one per
 * round, a line per note: what it changed, with the values it chose (C26).
 */
export function roundSections(projectMd: string): string | null {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of projectMd.replace(/\r\n?/g, '\n').split('\n')) {
    if (ROUND_HEADING.test(line)) {
      current = [line];
      sections.push(current);
    } else if (/^#{1,2} /.test(line)) {
      current = null;
    } else {
      current?.push(line);
    }
  }
  if (sections.length === 0) return null;
  return sections.map((lines) => lines.join('\n').trim()).join('\n\n');
}

/**
 * The `{{notes}}` of an approved episode's `replace` (C26): read the notes files, see what the
 * revise runs did with each (the rounds, quoted), and write each as a rule under ## Notes with the
 * exact value the episode has, keeping the rules the format it was rebuilt from had.
 */
export function seriesNotesText({
  seriesDir,
  notes,
}: {
  seriesDir: string;
  notes: SeriesNotesContext;
}): string {
  const files = notes.files
    .map((file) => `- ${seriesDir}/${flatName(file.name)} (${briefFileSize(file.size)})`)
    .join('\n');
  const rounds =
    notes.rounds === null
      ? 'edit/project.md has no ## Round section saying what the editor did for them, so take each value from the composition in the kit and the frames.'
      : `What the editor did for each note is in these sections of edit/project.md:\n\n${notes.rounds.trim()}`;
  return [
    `The owner approved this episode after review notes they marked for the series, so it is the series’ new format. The notes are in these files (read each one):\n${files}`,
    `The episode’s revise runs applied them. ${rounds}`,
    `Under ## Notes write each note as a rule with the exact value this episode has, never the note’s own loose words: “Stamp: 0.5 s after the cut”, not “a beat later”. The lines above must say the same. Read ${seriesDir}/${SERIES_FILE_NAME}, the format this episode was rebuilt from, and keep the rules under its ## Notes unless a note changes them.`,
  ].join('\n\n');
}

/** Two blank lines or more as one: an empty `{{step5}}` leaves its line behind. */
function tidy(text: string): string {
  return `${text.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** The prompt of one `series` pass. Templates are read on every run, like the other prompts. */
export async function buildSeriesLearnPrompt(
  vars: SeriesLearnPromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const series = oneLine(vars.series);
  const seriesDir = flatName(vars.seriesDir);
  const styleDir = flatName(vars.styleDir);
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    series,
    job: oneLine(vars.job),
    date: vars.date,
    seriesDir,
    styleTarget: vars.writesStyle ? ` and ${styleDir}/style.md.new` : '',
    step5: vars.writesStyle
      ? seriesStep5({
          styleDir,
          series,
          date: vars.date,
          ...(vars.styleKit === undefined ? {} : { kit: vars.styleKit }),
        })
      : '',
    doneFiles: seriesDoneFiles({ seriesDir, styleDir, writesStyle: vars.writesStyle }),
    notes: vars.notes === undefined ? '' : seriesNotesText({ seriesDir, notes: vars.notes }),
  };
  const partials = { 'series-shape': await readTemplate(dir, 'series-shape') };
  const template = await readTemplate(dir, 'series-learn');
  return tidy(renderTemplate(template, values, partials));
}
