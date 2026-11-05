// What the progress tracker (E4) reads in the stream and in edl.json. Pure functions: the tracker
// (progress.ts) feeds them, the reducer (progress-reducer.ts) decides what they mean.
//
// The stream tells two things the files tell too late:
//   - a render was started. render.py writes preview.mp4 / final.mp4 only at the end of a render
//     that can take minutes, so the command is the start of Preview and Render. What a render is
//     comes from the file it writes (final*.mp4, preview*.mp4): render.py is also run early, to
//     make the base cut (cut.mp4) the graphics are laid over, and that is neither.
//   - a critic sub-agent was started (it looks at frames it keeps outside edit/).
//   - a HyperFrames command was run on the composition (lint, check, snapshot, preview): how a run
//     that ends in Review (W2) shows it is checking its edit/preview/. What those commands write
//     (HyperFrames' own folders) is not something the watcher lists, so the command is the signal.
//   - the music is being made (Soundtrack, SD3; Songs, SG3): a call to the music script's `make` or
//     `song`. ElevenLabs takes a minute or two and a song's download and cut can take as long, and
//     the script writes edit/preview/music.mp3 only once it is done.
// Everything else (transcripts, plan, EDL, graphics, check frames) shows up in edit/ within a poll.
//
// Commands are matched loosely but only as invocations: `$P render.py --help` and
// `grep ... render.py` start nothing; `$P ~/Developer/video-use/helpers/render.py edl.json -o
// final.mp4` does. Sub-agents' commands count too (an editor sub-agent may render the preview).

import type { CompositionTool, ProgressSignal } from './progress-reducer.js';
import type { StreamEvent } from './stream-parser.js';

/** The renders a command starts, in the order it starts them. */
export type RenderTarget = 'preview' | 'final';

/** Words that can stand before the program of a simple command. */
const PREFIX_WORDS = new Set([
  'then',
  'do',
  'else',
  'time',
  'nohup',
  'nice',
  'exec',
  'command',
  'env',
  '!',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Characters that end a simple command outside quotes (`&` only when it is not `2>&1` / `&>`). */
const OPERATORS = new Set([';', '|', '&', '(', ')', '{', '}', '`']);

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Drops leading `VAR=value`, `time`, `then`, ... */
function program(words: string[]): string[] {
  let start = 0;
  while (
    start < words.length &&
    (PREFIX_WORDS.has(words[start] as string) || ASSIGNMENT.test(words[start] as string))
  ) {
    start += 1;
  }
  return words.slice(start);
}

/** The delimiter of a heredoc starting at `at` (just after `<<`), and where it ends. */
function heredocDelimiter(text: string, at: number): { delimiter: string; end: number } {
  let i = at;
  if (text[i] === '-') i += 1;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  const quote = text[i];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, i + 1);
    const end = close === -1 ? text.length : close + 1;
    return { delimiter: text.slice(i + 1, close === -1 ? text.length : close), end };
  }
  let end = i;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end] as string)) end += 1;
  return { delimiter: text.slice(i, end), end };
}

/**
 * The words of each simple command in a shell command line, with quotes removed and leading
 * `VAR=value`, `time`, `then`, ... dropped. Splits on newlines and `;`, `|`, `&&`, `||`, `&`,
 * parentheses, braces and backticks outside quotes. Heredoc bodies are skipped: they are file
 * contents (an EDL, a script), not commands.
 */
function simpleCommands(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  let heredocs: string[] = [];

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    const rest = program(words);
    if (rest.length > 0) result.push(rest);
    words = [];
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) {
        i += 1;
        word += command[i];
      } else word += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      i += 1;
      continue;
    }
    if (c === '\\') {
      // `\` + newline continues the line; otherwise the next character is literal.
      if (command[i + 1] !== '\n' && i + 1 < command.length) {
        word += command[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === '$' && command[i + 1] === '{') {
      // `${VAR}` / `${VAR:-x}` is part of the word, not a brace group.
      const close = command.indexOf('}', i + 2);
      const end = close === -1 ? command.length : close + 1;
      word += command.slice(i, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '\n') {
      endCommand();
      i += 1;
      for (const delimiter of heredocs) {
        // Skip the body: every line up to the one that is the delimiter.
        for (;;) {
          const newline = command.indexOf('\n', i);
          const line = command.slice(i, newline === -1 ? command.length : newline);
          i = newline === -1 ? command.length : newline + 1;
          if (line.trim() === delimiter || newline === -1) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord();
      const { delimiter, end } = heredocDelimiter(command, i + 2);
      if (delimiter !== '') heredocs.push(delimiter);
      i = end;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
      continue;
    }
    if (OPERATORS.has(c) && !(c === '&' && (command[i - 1] === '>' || command[i + 1] === '>'))) {
      endCommand();
      i += 1;
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  endCommand();
  return result;
}

/** `python`, `python3.12`, `.venv/bin/python`, or a variable holding one (`$P`, `"${PY}"`). */
function isInterpreter(word: string): boolean {
  return /^python[0-9.]*$/.test(basename(word)) || /^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/.test(word);
}

/** The arguments of a `render.py` invocation, or `null` when the command does not run it. */
function renderPyArgs(words: readonly string[]): string[] | null {
  let i = 0;
  if (words[i] === 'uv' && words[i + 1] === 'run') i += 2;
  if (words[i] !== undefined && isInterpreter(words[i] as string)) {
    i += 1;
    while (words[i]?.startsWith('-')) i += 1; // python -u, -X ...
  }
  const script = words[i];
  if (script === undefined || basename(script) !== 'render.py') return null;
  return words.slice(i + 1);
}

/** The output of a `render.py` run (`-o x`, `--output x`, `--output=x`, `-ox`), or `null`. */
function renderPyOutput(args: readonly string[]): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg === '-o' || arg === '--output') return args[index + 1] ?? null;
    if (arg.startsWith('--output=')) return arg.slice('--output='.length);
    if (arg.startsWith('-o') && !arg.startsWith('--')) return arg.slice('-o'.length);
  }
  return null;
}

/**
 * A `hyperframes` invocation (`npx`, `bunx`, `pnpm dlx`, `pnpm exec` or the bare tool, with any
 * version suffix): its sub-command and the arguments after it, or `null` when the command does not
 * run it.
 */
function hyperframesCall(words: readonly string[]): { sub: string; args: string[] } | null {
  let i = 0;
  if (words[i] === 'npx' || words[i] === 'bunx') i += 1;
  else if (words[i] === 'pnpm' && (words[i + 1] === 'dlx' || words[i + 1] === 'exec')) i += 2;
  while (words[i]?.startsWith('-')) i += 1; // npx --yes
  const tool = words[i];
  if (tool === undefined || !/^hyperframes(@\S*)?$/.test(tool)) return null;
  const sub = words[i + 1];
  if (sub === undefined) return null;
  return { sub, args: words.slice(i + 2) };
}

/** The output of a `hyperframes render` invocation (`-o x`, `--output x`, `--output=x`). */
function hyperframesOutput(words: readonly string[]): string | null | undefined {
  const call = hyperframesCall(words);
  if (call === null || call.sub !== 'render') return undefined;
  const { args } = call;
  for (const [index, arg] of args.entries()) {
    if (arg === '-o' || arg === '--output') return args[index + 1] ?? null;
    if (arg.startsWith('--output=')) return arg.slice('--output='.length);
  }
  return null;
}

/** What a render to `output` is, by the file name video-use gives it. */
function targetOf(output: string): RenderTarget | null {
  const name = basename(output);
  if (/^final.*\.mp4$/i.test(name)) return 'final';
  if (/^preview.*\.mp4$/i.test(name)) return 'preview';
  return null;
}

/** Flags of a render.py run that makes a base cut: no captions burnt in, no loudness pass. */
const INTERMEDIATE_FLAGS = ['--no-subtitles', '--no-loudnorm'];

/** A word that is only a variable (`$OUT`, `${OUT}`): the file it names is not in the command. */
const VARIABLE_ONLY = /^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;

/** What a `render.py` run is. `null`: a cut that is neither the preview nor the deliverable. */
function renderPyTarget(args: readonly string[]): RenderTarget | null {
  if (args.includes('--preview')) return 'preview';
  const output = renderPyOutput(args);
  if (output === null) return null;
  const target = targetOf(output);
  if (target !== null) return target;
  // Any other file name (cut.mp4, base.mp4, cut_nohold.mp4) is an intermediate: the files in
  // edit/ show what is done with it. A name that is only a variable cannot be read from the
  // command, so there the flags of a base cut decide, and a run without them is read as the final.
  if (!VARIABLE_ONLY.test(basename(output))) return null;
  return INTERMEDIATE_FLAGS.some((flag) => args.includes(flag)) ? null : 'final';
}

/**
 * The renders a Bash command starts. What a render is comes from the file it writes, by the names
 * video-use gives them:
 * - `render.py ... -o final*.mp4` -> final; `-o preview*.mp4` or `--preview` -> preview. Any other
 *   output starts no step. render.py is also run early, to make the base cut the graphics are laid
 *   over (`-o cut.mp4 --no-subtitles --no-loudnorm`), and E1 rendered its final as `cut_nohold.mp4`
 *   and added the end hold with ffmpeg (or the graphics are laid over the cut with ffmpeg): there
 *   Render starts when final.mp4 shows in edit/, which ffmpeg creates as soon as it starts writing.
 *   `--draft` (720p cut-point check, used while cutting) and `--help` start no step either.
 * - `hyperframes render -o <x>` -> by the output's name: final*.mp4 / preview*.mp4. Slot renders
 *   (`render.mov`) are graphics, which the files show.
 */
export function rendersInCommand(command: string): RenderTarget[] {
  const targets: RenderTarget[] = [];
  for (const words of simpleCommands(command)) {
    const args = renderPyArgs(words);
    if (args !== null) {
      if (args.includes('--help') || args.includes('-h') || args.includes('--draft')) continue;
      const target = renderPyTarget(args);
      if (target !== null) targets.push(target);
      continue;
    }
    const output = hyperframesOutput(words);
    if (typeof output === 'string') {
      const target = targetOf(output);
      if (target !== null) targets.push(target);
    }
  }
  return targets;
}

/**
 * The HyperFrames sub-commands that tell where a run that ends in a preview is, and what each is.
 * `validate`, `inspect` and `layout` are the CLI's deprecated aliases of `check`. A Map, so
 * "constructor" is never a key.
 */
const COMPOSITION_TOOLS = new Map<string, CompositionTool>([
  ['lint', 'lint'],
  ['check', 'check'],
  ['validate', 'check'],
  ['inspect', 'check'],
  ['layout', 'check'],
  ['snapshot', 'snapshot'],
  ['preview', 'preview'],
]);

/**
 * The HyperFrames commands on a composition that a Bash command runs, in the order it runs them.
 * `--help` and `-h` start nothing; neither does a command that only mentions one (`grep
 * "hyperframes lint" project.md`) or a heredoc body.
 */
export function compositionToolsInCommand(command: string): CompositionTool[] {
  const tools: CompositionTool[] = [];
  for (const words of simpleCommands(command)) {
    const call = hyperframesCall(words);
    if (call === null) continue;
    const tool = COMPOSITION_TOOLS.get(call.sub);
    if (tool === undefined) continue;
    if (call.args.includes('--help') || call.args.includes('-h')) continue;
    tools.push(tool);
  }
  return tools;
}

/** The music script's file (apps/server/assets/music/make-music.mjs, `MUSIC_SCRIPT`). */
const MUSIC_SCRIPT_NAME = 'make-music.mjs';

/**
 * The music script's options that take a value (`--ask "<words>"`, `--by revise`, and the song
 * command's `--title "…"`, `--from note`), so a value is never taken for the sub-command.
 */
const MUSIC_VALUE_OPTIONS = new Set([
  '--ask',
  '--by',
  '--title',
  '--artist',
  '--version',
  '--link',
  '--from',
  '--file',
  '--niche',
  '--length-ms',
]);

/** The music script's sub-commands that take a while and write the music: make, and song. */
const MUSIC_MAKING = new Set(['make', 'song']);

/** `node`, `node22`, `/opt/homebrew/bin/node`, or a variable holding one (`$NODE`). */
function isNode(word: string): boolean {
  return /^node[0-9.]*$/.test(basename(word)) || VARIABLE_ONLY.test(word);
}

/**
 * The arguments of a music script invocation (`node "<engine>/make-music.mjs" …`, or the script
 * run on its own), or `null` when the command does not run it.
 */
function musicScriptArgs(words: readonly string[]): string[] | null {
  let i = 0;
  if (words[i] !== undefined && isNode(words[i] as string)) {
    i += 1;
    while (words[i]?.startsWith('-')) i += 1; // node --no-warnings
  }
  const script = words[i];
  if (script === undefined || basename(script) !== MUSIC_SCRIPT_NAME) return null;
  return words.slice(i + 1);
}

/** The music script's sub-command (make, pick, supplied, series, none, song): its first word that is not an option. */
function musicSubCommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (MUSIC_VALUE_OPTIONS.has(arg)) i += 1;
    else if (!arg.startsWith('-')) return arg;
  }
  return null;
}

/**
 * Whether a Bash command makes music: `node "<engine>/make-music.mjs" make "<edit dir>" …`, with
 * or without `--again`, `--ask` and `--by`, or gets a song for it: `… song "<edit dir>" --title …`
 * (Songs). The script's other sub-commands (pick, supplied, series, none) take a moment and make
 * nothing; `--help` and a mention (`grep make-music.mjs`, a heredoc body) start nothing either.
 */
export function startsMusicMake(command: string): boolean {
  return simpleCommands(command).some((words) => {
    const args = musicScriptArgs(words);
    if (args === null || args.includes('--help') || args.includes('-h')) return false;
    const sub = musicSubCommand(args);
    return sub !== null && MUSIC_MAKING.has(sub);
  });
}

/** A sub-agent whose description says it reviews the work (video-use's critic pass). */
const REVIEW_AGENT = /\b(critic|critique|review|reviewer|qa|self[- ]?eval|roast)\b/i;

export function isReviewAgent(description: string): boolean {
  return REVIEW_AGENT.test(description);
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The signals in one stream event (most events have none). A Bash command gives its renders, then
 * its HyperFrames commands, then the music make last: the make is what the command waits on, so
 * the step says "making the music" until the next signal.
 */
export function signalsFromStreamEvent(event: StreamEvent): ProgressSignal[] {
  if (event.kind !== 'tool_use') return [];
  if (event.name === 'Bash') {
    const command = stringField(event.input, 'command');
    return [
      ...rendersInCommand(command).map((target): ProgressSignal => ({ type: 'render', target })),
      ...compositionToolsInCommand(command).map(
        (tool): ProgressSignal => ({ type: 'composition', tool }),
      ),
      ...(startsMusicMake(command) ? [{ type: 'music' } satisfies ProgressSignal] : []),
    ];
  }
  if (event.name === 'Agent' || event.name === 'Task') {
    return isReviewAgent(stringField(event.input, 'description')) ? [{ type: 'review' }] : [];
  }
  return [];
}

/**
 * How many overlays an edl.json places (`overlays: [...]`), or `null` when the text is not a
 * complete EDL yet (it is read while being written).
 */
export function edlOverlayCount(text: string): number | null {
  let edl: unknown;
  try {
    edl = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof edl !== 'object' || edl === null || Array.isArray(edl)) return null;
  const overlays = (edl as { overlays?: unknown }).overlays;
  return Array.isArray(overlays) ? overlays.length : 0;
}
