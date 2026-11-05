// The `claude -p` command of a style run (Phase 2 plan §5): the Brief run's flag style
// (pipeline/claude-command.ts, `briefClaudeArgs`) with the style run's own tools.
//
//   claude -p <prompt> --output-format stream-json --verbose --model sonnet
//     --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep,Write,Bash
//     --allowedTools <the pass's rules> --strict-mcp-config --settings {"disableAllHooks":true}
//
// The environment is the edit run's (`childEnv`), and the working directory is the pass's: the
// client's `_Style` folder for a Read pass, the job folder for a Learn pass.
//
// The series passes (Series plan §3) use the same command with their own rules: a `series` pass
// runs in the episode's folder and writes `<series>/series.md.new` (and, for a Start a series that
// rewrites the style, `<_Style>/style.md.new`), both by absolute path.

import { join } from 'node:path';
import {
  KIT_DIR_NAME,
  SERIES_NEW_FILE_NAME,
  STYLE_FILE_NAME,
  STYLE_NEW_FILE_NAME,
} from './paths.js';
import type { LearnMode } from './style-pass.js';

/** Reading a few files and writing one Markdown file needs no Opus. */
export const STYLE_MODEL = 'sonnet';

/** The built-in tools a style run gets. No Edit, Skill or Task: it writes one new file. */
export const STYLE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Bash'] as const;

/**
 * What a Read pass may do without asking (cwd = `_Style`); anything else is denied (`dontAsk`).
 * The rule syntax is the Brief run's (`briefAllowedTools`): `*` matches any run of characters.
 *
 * - Read, Glob, Grep: anywhere (the files, a PDF, an image, a frame under /tmp).
 * - Write: only `./style.md.new`. Every file the run reads stays as it is.
 * - Bash: `ls`, `ffprobe`, `textutil -convert txt -stdout` (never one that writes a file next to
 *   the original) and `ffmpeg` only for a single frame into /tmp, as the prompt spells it.
 */
export function styleReadAllowedTools(): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    `Edit(./${STYLE_NEW_FILE_NAME})`,
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(ffprobe *)',
    'Bash(ffmpeg * -frames:v 1 /tmp/*)',
    'Bash(textutil -convert txt -stdout *)',
  ];
}

/** A path in a rule, with the characters a rule's pattern reads as wildcards taken literally. */
function literalPath(path: string): string {
  return path.replace(/[\\*?[\]]/g, '\\$&');
}

/**
 * What a Learn pass may do without asking (cwd = the job folder, plan §5): Read, Glob and Grep
 * anywhere; Write only `<styleDir>/style.md.new`, an absolute path (`//` starts one in the rule
 * syntax), since the style folder is outside the working directory; and Bash limited to `ls`,
 * `ffprobe` and `ffmpeg` single frames into /tmp. A `merge` also names `<styleDir>/style.md` for
 * Read (C10): it reads the current style from outside its working directory, and writes nothing
 * more.
 */
export function styleLearnAllowedTools(styleDir: string, mode: LearnMode): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    ...(mode === 'merge' ? [`Read(/${literalPath(join(styleDir, STYLE_FILE_NAME))})`] : []),
    `Edit(/${literalPath(join(styleDir, STYLE_NEW_FILE_NAME))})`,
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(ffprobe *)',
    'Bash(ffmpeg * -frames:v 1 /tmp/*)',
  ];
}

/**
 * What a `series` pass may do without asking (cwd = the episode's folder, Series plan §3): Read,
 * Glob and Grep, naming the series' kit for Read since it is outside the working directory; Write
 * only `<seriesDir>/series.md.new` by its absolute path; and Bash limited to `ls`, `ffprobe` and
 * `ffmpeg` single frames into /tmp, as series-learn.md spells them. A start that rewrites the
 * style (`writesStyle`) may also Read `<styleDir>/style.md` and Write `<styleDir>/style.md.new`.
 * An approved episode's pass with review notes (`readsNotes`, C26) may also Read the Markdown files
 * at the top of the series folder: the notes files and series.md. A rule names no notes file, since
 * a job's name in it could hold the comma that separates the rules.
 */
export function seriesLearnAllowedTools({
  seriesDir,
  styleDir,
  writesStyle,
  readsNotes = false,
}: {
  seriesDir: string;
  styleDir: string;
  writesStyle: boolean;
  readsNotes?: boolean;
}): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    `Read(/${literalPath(join(seriesDir, KIT_DIR_NAME))}/**)`,
    ...(readsNotes ? [`Read(/${literalPath(seriesDir)}/*.md)`] : []),
    ...(writesStyle ? [`Read(/${literalPath(join(styleDir, STYLE_FILE_NAME))})`] : []),
    `Edit(/${literalPath(join(seriesDir, SERIES_NEW_FILE_NAME))})`,
    ...(writesStyle ? [`Edit(/${literalPath(join(styleDir, STYLE_NEW_FILE_NAME))})`] : []),
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(ffprobe *)',
    'Bash(ffmpeg * -frames:v 1 /tmp/*)',
  ];
}

/** Arguments of a style run after the binary. */
export function styleClaudeArgs({
  prompt,
  allowedTools,
}: {
  prompt: string;
  allowedTools: readonly string[];
}): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    STYLE_MODEL,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    STYLE_TOOLS.join(','),
    '--allowedTools',
    allowedTools.join(','),
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
  ];
}
