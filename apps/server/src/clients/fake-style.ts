// The fake style run: the style runner under `STUDIO_RUNNER=fake`. Like the fake Brief run it reads
// nothing and spends nothing: after about a second (divided by `STUDIO_FAKE_SPEED`) it has written
// a canned `_Style/style.md.new` in the right shape, so dev, tests and e2e go through the same
// worker, install, history and events as a real run. A Learn pass gets the same: the engine has
// copied the job's kit by then, and the canned style names it under ## Kit. A Learn pass that
// merges keeps the current style, adds “Plus <job> (<date>).” under the title and names the new
// kit.
//
// `.fail-style` in the client's `_Style` folder fails the run with "Style stopped: injected
// failure (.fail-style)". Remove it and press Retry to see the style made.
//
// Series passes (Series plan §3) go the same way: a `series` pass writes a stand-in series.md.new
// in the series-shape.md shape (“Format from <job> (<date>).”), and a `start` that rewrites the
// style also writes style.md.new: the current style with “Moved what only <series> does into the
// series (<date>).” added under the title and its ## Kit as the engine said the kit will be (C23):
// kept, gone, or the ## Kit of the kit that comes back. An approved episode's pass with review
// notes (C26) adds a ## Notes line per notes file, saying whether it was given the rounds.
// `.fail-series` in the client's `_Series` folder, or in the series' own folder, fails the run with
// "Series stopped: injected failure (.fail-series)".

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { realSleep, type Sleep } from '../pipeline/fake-runner.js';
import { SERIES_NEW_FILE_NAME, STYLE_FILE_NAME, STYLE_NEW_FILE_NAME } from './paths.js';
import type { LearnPass, ReadPass, SeriesPass } from './style-pass.js';
import { joinFileNames, localDate } from './style-prompt.js';
import {
  SERIES_STOPPED,
  type SeriesNotesContext,
  type SeriesRunner,
  type SeriesRunRequest,
  STYLE_STOPPED,
  type StartStyleKit,
  type StyleRunner,
  type StyleRunOutcome,
  type StyleRunRequest,
} from './style-run.js';

/** How long the fake run takes at speed 1. */
export const FAKE_STYLE_MS = 1_000;

/** The marker file that makes the fake run fail, in the client's `_Style` folder. */
export const FAIL_STYLE_MARKER = '.fail-style';

/** The marker file that makes a fake series run fail, in `_Series` or in the series' folder. */
export const FAIL_SERIES_MARKER = '.fail-series';

/** Share of the run that goes by before an injected failure shows up (as in the fake runner). */
const FAILURE_AFTER = 0.4;

const STOPPED: StyleRunOutcome = {
  ok: false,
  error: `${STYLE_STOPPED} the fake style was stopped.`,
};

const SERIES_STOPPED_RUN: StyleRunOutcome = {
  ok: false,
  error: `${SERIES_STOPPED} the fake series run was stopped.`,
};

export interface FakeStyleRunnerOptions {
  /** How much faster than the default one second to go. Above 0. */
  speed?: number;
  /** Replaces the waiting, for tests. */
  sleep?: Sleep;
  /** Today, for the add mode's “Plus <files> (<date>).” */
  clock?: () => Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes through a dotfile, which the inbox watcher never looks at, then renames it. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** `text` with `addition` put at the end of its second line (the line under the title). */
function addUnderTitle(text: string, addition: string): string {
  const lines = text.trimEnd().split('\n');
  lines[1] = `${lines[1] ?? ''} ${addition}`.trim();
  return lines.join('\n');
}

/** The `## Kit` section of a style.md, heading included, or null. */
function kitSection(markdown: string): string | null {
  const match = /^## Kit\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(markdown);
  return match === null ? null : match[0].trimEnd();
}

/**
 * The style the fake run writes. `create` and `replace` get a stand-in style that names the files
 * (`replace` has no ## Kit: the engine moves the client's kit to history with the old style.md,
 * C17); `add` keeps the current style, adds “Plus <files> (<date>).” to the line under the title
 * and lists the files under ## Reference.
 */
export function fakeStyleMarkdown(
  client: string,
  pass: ReadPass,
  current: string | null,
  date: string,
): string {
  const names = joinFileNames(pass.files);
  const references = pass.files.map(
    (file) => `- ${file.name}: a stand-in line; the fake runner read nothing`,
  );

  if (pass.mode === 'add' && current !== null) {
    const lines = current.trimEnd().split('\n');
    lines[1] = `${lines[1] ?? ''} Plus ${names} (${date}).`.trim();
    if (!lines.includes('## Reference')) lines.push('## Reference');
    return `${[...lines, ...references].join('\n')}\n`;
  }

  return `${[
    `# Style: ${client}`,
    `From your files: ${names}.`,
    '## Look',
    '- Colours: Ink #1A1A1A (text), Paper #F5F1EA (background)',
    '- Fonts: Inter Bold for titles, Inter Regular for captions',
    '## Editing',
    '- Pacing: calm, cuts on the beat',
    '## Do',
    '- Keep titles short.',
    '## Don’t',
    '- Don’t use stock music.',
    '## Reference',
    ...references,
  ].join('\n')}\n`;
}

/** The `## Kit` section the fake run writes for the kit it was given. */
function fakeKitSection(kit: readonly string[]): string {
  return [
    '## Kit',
    ...(kit.length === 0
      ? ['No graphics were copied.']
      : kit.map((slot) => `- ${slot}: a stand-in line; the fake runner looked at nothing`)),
  ].join('\n');
}

/**
 * The style the fake run writes for a Learn pass. `create` and `replace` get a stand-in look and
 * the kit it was given; `merge` keeps the current style, adds “Plus <job> (<date>).” to the line
 * under the title and names the new kit under ## Kit.
 */
export function fakeLearnedMarkdown(
  client: string,
  pass: LearnPass,
  kit: readonly string[],
  date: string,
  current: string | null = null,
): string {
  if (pass.mode === 'merge' && current !== null) {
    const lines = current.trimEnd().split('\n');
    lines[1] = `${lines[1] ?? ''} Plus ${pass.job} (${date}).`.trim();
    const merged = lines.join('\n');
    const oldKit = kitSection(merged);
    const newKit = fakeKitSection(kit);
    return `${oldKit === null ? `${merged}\n${newKit}` : merged.replace(oldKit, () => newKit)}\n`;
  }

  return `${[
    `# Style: ${client}`,
    `Learned from ${pass.job} (${date}).`,
    '## Look',
    '- Colours: Ink #1A1A1A (text), Paper #F5F1EA (titles)',
    '- Fonts: Inter Bold for titles, Inter Regular for captions',
    '- Captions: Inter Regular, white, bottom centre',
    '## Editing',
    '- Pacing: calm, cuts on the beat',
    fakeKitSection(kit),
  ].join('\n')}\n`;
}

/**
 * The series.md the fake run writes for a `series` pass: a stand-in format in the series-shape.md
 * shape, from the episode `pass.job`. With review notes (C26), a stand-in rule per notes file under
 * ## Notes, which says whether the run had the episode's rounds.
 */
export function fakeSeriesMarkdown(
  pass: SeriesPass,
  date: string,
  notes?: SeriesNotesContext,
): string {
  const rules =
    notes === undefined || notes.files.length === 0
      ? []
      : [
          '## Notes',
          ...notes.files.map(
            (file) =>
              `- ${file.name}: a stand-in rule ${notes.rounds === null ? 'without' : 'with'} the episode’s rounds; the fake runner read nothing`,
          ),
        ];
  return `${[
    `# Series: ${pass.series}`,
    `Format from ${pass.job} (${date}). Fonts, colours and captions come from the client style.`,
    '## Flow',
    '- 0:00 · Opening: the title card over the first shot, with the theme music',
    '- 0:04 · Body: the speaker on camera, captions at the bottom',
    '- End · Sign-off: the end card',
    '## Same in every episode',
    '- Title card: a stand-in line; the fake runner looked at nothing',
    '## New in each episode',
    '- Title text: from the brief',
    '- Footage: from the footage',
    '- Captions: from the speech',
    '## Kit',
    `- The composition of ${pass.job}, with the title text left open`,
    ...rules,
  ].join('\n')}\n`;
}

/** The ## Kit the fake run writes for a kit that comes back: its own lines, else a stand-in. */
function restoredKitSection(kit: Extract<StartStyleKit, { kind: 'restore' }>): string {
  return [
    '## Kit',
    kit.section ??
      kit.names
        .map((name) => `- ${name}: a stand-in line; the fake runner looked at nothing`)
        .join('\n'),
  ].join('\n');
}

/**
 * The style.md the fake run writes for a `start` that rewrites the client's style: the current
 * style with “Moved what only <series> does into the series (<date>).” added under the title, and
 * its ## Kit kept (`keep`), taken out (`none`, the default) or written for the kit that comes back
 * (`restore`).
 */
export function fakeStyleWithoutSeries(
  current: string,
  series: string,
  date: string,
  kit: StartStyleKit = { kind: 'none' },
): string {
  let style = current;
  if (kit.kind === 'none') {
    style = current.replace(/^## Kit\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
  } else if (kit.kind === 'restore') {
    const oldKit = kitSection(current);
    const newKit = restoredKitSection(kit);
    style =
      oldKit === null ? `${current.trimEnd()}\n${newKit}\n` : current.replace(oldKit, () => newKit);
  }
  return `${addUnderTitle(style, `Moved what only ${series} does into the series (${date}).`)}\n`;
}

export class FakeStyleRunner implements StyleRunner, SeriesRunner {
  private readonly speed: number;
  private readonly sleep: Sleep;
  private readonly clock: () => Date;

  constructor({
    speed = 1,
    sleep = realSleep,
    clock = () => new Date(),
  }: FakeStyleRunnerOptions = {}) {
    if (!(Number.isFinite(speed) && speed > 0)) {
      throw new RangeError(`The fake style's speed must be a number above 0 (got ${speed}).`);
    }
    this.speed = speed;
    this.sleep = sleep;
    this.clock = clock;
  }

  async run({ client, styleDir, pass, learn, signal }: StyleRunRequest): Promise<StyleRunOutcome> {
    if (await exists(join(styleDir, FAIL_STYLE_MARKER))) {
      await this.sleep((FAKE_STYLE_MS * FAILURE_AFTER) / this.speed, signal);
      if (signal.aborted) return STOPPED;
      return { ok: false, error: `${STYLE_STOPPED} injected failure (${FAIL_STYLE_MARKER})` };
    }

    await this.sleep(FAKE_STYLE_MS / this.speed, signal);
    if (signal.aborted) return STOPPED;

    const date = localDate(this.clock());
    const current = await readFile(join(styleDir, STYLE_FILE_NAME), 'utf8').catch(() => null);
    const markdown =
      pass.kind === 'learn'
        ? fakeLearnedMarkdown(client, pass, learn?.kit ?? [], date, current)
        : fakeStyleMarkdown(client, pass, current, date);
    await writeAtomic(join(styleDir, STYLE_NEW_FILE_NAME), markdown);
    return { ok: true };
  }

  async runSeries({
    seriesDir,
    styleDir,
    pass,
    writesStyle,
    styleKit,
    notes,
    signal,
  }: SeriesRunRequest): Promise<StyleRunOutcome> {
    const marked =
      (await exists(join(seriesDir, FAIL_SERIES_MARKER))) ||
      (await exists(join(dirname(seriesDir), FAIL_SERIES_MARKER)));
    if (marked) {
      await this.sleep((FAKE_STYLE_MS * FAILURE_AFTER) / this.speed, signal);
      if (signal.aborted) return SERIES_STOPPED_RUN;
      return { ok: false, error: `${SERIES_STOPPED} injected failure (${FAIL_SERIES_MARKER})` };
    }

    await this.sleep(FAKE_STYLE_MS / this.speed, signal);
    if (signal.aborted) return SERIES_STOPPED_RUN;

    const date = localDate(this.clock());
    await writeAtomic(join(seriesDir, SERIES_NEW_FILE_NAME), fakeSeriesMarkdown(pass, date, notes));
    if (writesStyle) {
      const style = await readFile(join(styleDir, STYLE_FILE_NAME), 'utf8').catch(() => null);
      if (style !== null) {
        await writeAtomic(
          join(styleDir, STYLE_NEW_FILE_NAME),
          fakeStyleWithoutSeries(style, pass.series, date, styleKit),
        );
      }
    }
    return { ok: true };
  }
}
