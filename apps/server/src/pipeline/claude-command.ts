// The exact `claude -p` command and environment E1 verified (docs/reference.md "Running edits": why each flag,
// what the child's environment needs).

import { readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { Effort } from '@studio/shared';
import { ENV_FILE_ENV } from '../config.js';
import { isReservedName, SHARED_DIR_NAME } from '../inbox/classify.js';
import { extraBinDirs } from './claude-bin.js';
import { RUN_TAG_VAR } from './process-tree.js';

/** The only built-in tools a run gets, and the ones it may use without asking. */
export const CLAUDE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Skill', 'Task'] as const;

/**
 * How a headless run names the Higgsfield connector's tools (U26, 27 Oct): the connector "claude.ai
 * Higgsfield" (https://mcp.higgsfield.ai/mcp) keeps its name with the space and the dot turned into
 * underscores. It is the Higgsfield plan's own door: its credits are the Starter plan's, not the API's
 * prepaid dollars. A claude.ai connector exists only on the plan login (a run with ANTHROPIC_API_KEY
 * has none) and `--strict-mcp-config` hides every one, so the runs that use it are the only ones
 * without that flag and always get `planOnly`.
 */
export const HIGGSFIELD_MCP_PREFIX = 'mcp__claude_ai_Higgsfield__';

/**
 * The connector's tools a run may call; the connector holds about two hundred more (websites, TikTok,
 * publishing, deleting, buying credits) and a run needs none of them, so anything else is denied
 * (`dontAsk`). `ToolSearch` is how the CLI loads the schema of a connector tool before it is called.
 *
 * Since 27 Oct 2026 (U31) a run makes video scenes only (Kling 4.0 text to video, as the test that
 * worked did): no generate_image, no reference elements. `media_upload` and `media_confirm` are for
 * the one picture that goes in, the client's own logo for the people who wear it.
 */
export const HIGGSFIELD_TOOLS = [
  'generate_video',
  'generate_video_batch',
  'jobs_wait',
  'media_upload',
  'media_confirm',
  'models_explore',
  'balance',
] as const;

/** The permission rules that let a run use the connector: its tools and the tool that loads them. */
export function higgsfieldAllowedTools(): string[] {
  return ['ToolSearch', ...HIGGSFIELD_TOOLS.map((tool) => `${HIGGSFIELD_MCP_PREFIX}${tool}`)];
}

/**
 * `Read` deny rules for every folder of the inbox that is not on the way to the job (CVP-258). From
 * the job folder up to the inbox, each level's other folders: the client's other jobs, `_Style`,
 * `_Series` and `_Shared` next to the job, then the other clients, `_Fonts` and `_Exports` next to
 * the client. A run has no reason to open them: the client's style, the job's series and the shared
 * fonts are copied into edit/style/, edit/series/ and edit/fonts/ before it starts. With `shared`
 * (the edit and Generate runs) the client's `_Shared` next to the job is left readable: brief.md
 * lists its files, and the run copies the ones it uses into edit/shared/ (shared-files.ts). Nothing the
 * skill needs is in the inbox (~/.claude/skills, ~/Developer/video-use, /tmp and the HyperFrames
 * CLI are elsewhere), so no other read is affected.
 *
 * Checked with claude 2.1.299, in `dontAsk` mode and through `--settings`: an absolute rule
 * (`Read(//…/**)`) stops the Read tool and the shell commands the CLI knows read a path (`cat`,
 * `ls`, `find`, `grep`, `head`, `sed`, a `cd` first), but not a program that opens the file itself
 * (`python3 -c 'open(…)'`), so the "read only this folder" line in unattended.md stays the main
 * rule. A relative `Read(../**)` rule denies nothing. The folders are listed when the run starts,
 * so one made during the run isn't covered. Paths are the real ones, which is how the CLI sees them.
 */
export function readDenyRulesOutsideJob(
  inboxPath: string,
  jobDir: string,
  { shared = false }: { shared?: boolean } = {},
): string[] {
  const rules: string[] = [];
  const root = realPathOf(inboxPath);
  const job = realPathOf(jobDir);
  let dir = job;
  while (dir.startsWith(`${root}${sep}`)) {
    const parent = dirname(dir);
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (shared && dir === job && isReservedName(entry.name, SHARED_DIR_NAME)) continue;
        if (entry.isDirectory() && entry.name !== basename(dir)) {
          rules.push(`Read(/${ruleLiteral(join(parent, entry.name))}/**)`);
        }
      }
    } catch {
      // A folder that can't be listed has nothing to deny.
    }
    dir = parent;
  }
  return rules.sort();
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A path as a permission rule reads it: pattern characters escaped, so `Job (2) [new]` is that folder only. */
function ruleLiteral(path: string): string {
  return path.replace(/[\\()[\]{}*]/g, '\\$&');
}

/**
 * Arguments after the binary. `model` or `effort` unset leaves the CLI's own default. `denyRead`
 * is `readDenyRulesOutsideJob`'s list; empty adds nothing to the settings. `higgsfield` is for the
 * revise run of a generated video (U26): it may retake a shot through the Higgsfield connector, so
 * it gets the connector's tools and no `--strict-mcp-config`.
 */
export function claudeArgs({
  prompt,
  model,
  effort,
  denyRead = [],
  higgsfield = false,
}: {
  prompt: string;
  model?: string;
  effort?: Effort;
  denyRead?: readonly string[];
  higgsfield?: boolean;
}): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    (higgsfield ? [...CLAUDE_TOOLS, 'ToolSearch'] : CLAUDE_TOOLS).join(','),
    '--allowedTools',
    (higgsfield ? [...CLAUDE_TOOLS, ...higgsfieldAllowedTools()] : CLAUDE_TOOLS).join(' '),
    ...(higgsfield ? [] : ['--strict-mcp-config']),
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      ...(denyRead.length > 0 ? { permissions: { deny: denyRead } } : {}),
    }),
  ];
}

/** The Brief run's model (B4): reading a folder and writing one JSON file needs no Opus. */
export const BRIEF_MODEL = 'sonnet';

/** The render run's model (Phase 3 §4): it renders and checks the approved preview, it doesn't edit. */
export const RENDER_MODEL = 'sonnet';

/** The built-in tools the Brief run gets. No Edit, Skill or Task: it writes one new file. */
export const BRIEF_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Bash'] as const;

/** video-use's transcription helper, as the Brief prompt spells it (`~` is the home folder). */
export const TRANSCRIBE_PYTHON = '~/Developer/video-use/.venv/bin/python';
export const TRANSCRIBE_SCRIPT = '~/Developer/video-use/helpers/transcribe.py';

/**
 * What the Brief run may do without asking; anything else is denied (`dontAsk`). Checked against
 * `claude --help` (2.1.299) and in headless runs: a rule is `Tool(pattern)`, `*` matches the rest
 * of a Bash command, and a compound command (`a && b`, `a; b`) needs every part allowed.
 *
 * - Read, Glob, Grep: anywhere (the folder, a PDF, an image).
 * - Write: only under ./edit/ (an `Edit(...)` rule covers every file-writing tool). The job's own
 *   files are read-only, and the brief is edit/brief.json.
 * - Bash: `ls`, `ffprobe`, `textutil -convert txt -stdout` (never one that writes a file next to
 *   the original) and the transcribe helper, written both with `~` and with the home folder,
 *   because the run may type either. Claude Code itself also lets through commands it knows are
 *   read-only (`cat`, `echo`); everything that changes something (`rm`, `cp`, `mkdir`, `touch`,
 *   `ffmpeg`, `curl`, a `>` redirect, python with any other script) is refused.
 */
export function briefAllowedTools(home: string): string[] {
  const expand = (path: string) => `${home}${path.slice(1)}`;
  return [
    'Read',
    'Glob',
    'Grep',
    'Edit(./edit/**)',
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(ffprobe *)',
    'Bash(textutil -convert txt -stdout *)',
    `Bash(${TRANSCRIBE_PYTHON} ${TRANSCRIBE_SCRIPT} *)`,
    `Bash(${expand(TRANSCRIBE_PYTHON)} ${expand(TRANSCRIBE_SCRIPT)} *)`,
  ];
}

/** Arguments of the Brief run after the binary: E1's flag style with the Brief run's tools. */
export function briefClaudeArgs({ prompt, home }: { prompt: string; home: string }): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    BRIEF_MODEL,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    BRIEF_TOOLS.join(','),
    '--allowedTools',
    briefAllowedTools(home).join(','),
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
  ];
}

/**
 * The built-in tools the Generate run gets (Generated videos, GN5): the Brief run's, no Edit, Skill
 * or Task, plus `ToolSearch`, which loads the connector's tools (U26).
 */
export const GENERATE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'ToolSearch'] as const;

/** video-use's frame-strip helper, as the Generate prompt spells it (it watches the reference video). */
export const TIMELINE_VIEW_SCRIPT = '~/Developer/video-use/helpers/timeline_view.py';

/** The two scripts of the Generate stage, absolute paths (`apps/server/assets/generate/`). */
export interface GenerateScripts {
  /** make-voice.mjs (ElevenLabs). */
  readonly voice: string;
  /** make-shots.mjs (Higgsfield). */
  readonly shots: string;
}

/**
 * What the Generate run may do without asking; anything else is denied (`dontAsk`), as for the Brief
 * run (`briefAllowedTools`). The run reads anywhere (the folder, the unpacked references, the
 * frames it makes), writes only under ./edit/, and runs only these Bash forms, one per call:
 *
 * - `node <script> …` for the two scripts, written with and without quotes around the path;
 * - `ffmpeg …` and `ffprobe …` (frames, strips and lengths for the clip checks), `ls`;
 * - `mkdir -p ./edit/…` for the frame folders it makes;
 * - video-use's `transcribe.py` and `timeline_view.py`, with `~` and with the home folder.
 *
 * Nothing in the list can reach a key: the scripts read their own, and the run's environment holds
 * only the PATH of the env file (`generateEnv`).
 */
export function generateAllowedTools(home: string, scripts: GenerateScripts): string[] {
  const expand = (path: string) => `${home}${path.slice(1)}`;
  const node = (script: string) => [`Bash(node ${script} *)`, `Bash(node "${script}" *)`];
  const python = (script: string) => [
    `Bash(${TRANSCRIBE_PYTHON} ${script} *)`,
    `Bash(${expand(TRANSCRIBE_PYTHON)} ${expand(script)} *)`,
  ];
  return [
    'Read',
    'Glob',
    'Grep',
    'Edit(./edit/**)',
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(ffprobe *)',
    'Bash(ffmpeg *)',
    'Bash(mkdir -p ./edit/*)',
    'Bash(mkdir -p "./edit/*)',
    ...node(scripts.voice),
    ...node(scripts.shots),
    ...python(TRANSCRIBE_SCRIPT),
    ...python(TIMELINE_VIEW_SCRIPT),
    // The pictures and clips are made through the Higgsfield connector, on the plan's credits (U26).
    ...higgsfieldAllowedTools(),
  ];
}

/**
 * Arguments of the Generate run after the binary (GN5): the edit run's model and effort (an unset
 * one leaves the CLI's own default) with the Brief run's tool list and permission style.
 * `denyRead` is the key files the run must not open (`generateDenyRead`) and the inbox folders it
 * has no reason to (`readDenyRulesOutsideJob`).
 */
export function generateClaudeArgs({
  prompt,
  model,
  effort,
  home,
  scripts,
  denyRead = [],
}: {
  prompt: string;
  model?: string;
  effort?: Effort;
  home: string;
  scripts: GenerateScripts;
  denyRead?: readonly string[];
}): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    GENERATE_TOOLS.join(','),
    '--allowedTools',
    generateAllowedTools(home, scripts).join(','),
    // No `--strict-mcp-config` (U26): it would hide the Higgsfield connector. Every other connector
    // the account has is denied by `dontAsk`, as anything not listed above.
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      ...(denyRead.length > 0 ? { permissions: { deny: denyRead } } : {}),
    }),
  ];
}

/**
 * `Read` deny rules for the files that hold the two keys (the repo's .env and video-use's .env): a
 * Generate run has no reason to open them, because the scripts read their own key themselves, and
 * everything the run prints is logged. Like `readDenyRulesOutsideJob` this stops the Read tool and
 * the shell commands the CLI knows read a path (`cat`, `head`, `grep`, …), not a program that opens
 * the file itself, so the scripts are unaffected.
 */
export function generateDenyRead(envFile: string, home: string): string[] {
  const files = [envFile, join(home, 'Developer', 'video-use', '.env')];
  return [...new Set(files)].map((file) => `Read(/${ruleLiteral(file)})`);
}

/**
 * The `Read` deny rule for the repo's .env while a run can call the stock script (ST4): the script
 * reads its own keys, so the run has no reason to open the file that holds them, and everything the
 * run prints is logged. Like `generateDenyRead` it stops the Read tool and the shell commands the
 * CLI knows read a path, not the script, which opens the file itself.
 */
export function stockDenyRead(envFile: string): string[] {
  return [`Read(/${ruleLiteral(envFile)})`];
}

/**
 * Variables passed through from the server's environment when set. Everything else is left
 * out, on purpose: no ELEVENLABS_API_KEY (it stays in ~/Developer/video-use/.env, E1's decision),
 * and none of the variables of a Claude Code session the server may have been started from.
 * ANTHROPIC_API_KEY is not here either: `childEnv` never passes it (the music script and the
 * transcribe helper are not Claude runs), and `claudeEnv` adds it for a `claude` process only when
 * the Claude billing switch (`Config.claudePlanOnly`) is off.
 */
const PASS_THROUGH = [
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'HYPERFRAMES_BROWSER_PATH',
] as const;

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * PATH for the run: Homebrew (ffmpeg, ffprobe), ~/.local/bin (uv), the Node 22 the server runs
 * on (npx for HyperFrames), then whatever the server's own PATH has, then the system folders.
 * A launchd job's default PATH has none of the first three.
 */
export function childPath(
  home: string,
  serverPath: string | undefined,
  nodeBinDir: string,
): string {
  const dirs = [
    ...extraBinDirs(home),
    nodeBinDir,
    ...(serverPath ?? '').split(':'),
    ...SYSTEM_DIRS,
  ].filter((dir) => dir !== '');
  return [...new Set(dirs)].join(':');
}

export interface ChildEnvOptions {
  home: string;
  /** The server's environment, the source of PATH and the pass-through variables. */
  env: Record<string, string | undefined>;
  /** Folder of the node binary; defaults to the running one. */
  nodeBinDir?: string;
  /** Unique id of the run, set as STUDIO_ENGINE_RUN so all its processes can be found. */
  runTag?: string;
  /**
   * The programs the music script's `song` command runs for YouTube (`Config.songTools`, SG4):
   * given, they go to the child as `STUDIO_YT_DLP` and `STUDIO_DENO` (absolute paths, because a
   * launchd job has no Homebrew in its PATH). Left out for a run that never calls it, which then
   * gets neither, whatever the server's own environment holds. Nothing else of Songs is passed:
   * the script reads its Apify key from .env itself.
   */
  songTools?: { readonly ytDlp: string; readonly deno: string };
  /**
   * The Generate stage's settings (GN5), given only to its run: the PATH of the env file the
   * shots script reads its Higgsfield key from (`STUDIO_ENV_FILE`; never the key's value), the
   * ElevenLabs voice (`STUDIO_GENERATE_VOICE_ID`), and the Bash timeouts a clip needs (see
   * `GENERATE_BASH_TIMEOUT_MS`). Left out for every other run.
   */
  generate?: GenerateEnv;
  /**
   * Stock media (ST4), given to an edit or revise run while the Stock switch is on: the PATH of the
   * env file the stock script reads its Openverse and Unsplash keys from (`STUDIO_ENV_FILE`; never
   * a key's value). Left out for every other run.
   */
  stock?: StockEnv;
  /**
   * `STUDIO_GENERATE_FAKE=1` for the run: both scripts then run their fake (placeholder files, no
   * key, no network). For tests of the Generate run only; ignored without `generate`.
   */
  generateFake?: boolean;
  /**
   * `Config.claudePlanOnly`, read by `claudeEnv` only. Anything but an explicit `false` keeps the
   * run on the plan login, so a caller that forgets it can't bill the API.
   */
  planOnly?: boolean;
}

/** What a run's environment carries for Stock media. */
export interface StockEnv {
  /** Absolute path of the env file (`envFilePath()`). */
  readonly envFile: string;
}

/** What a Generate run's environment carries beyond any other run's. */
export interface GenerateEnv {
  /** Absolute path of the env file (`envFilePath()`). */
  readonly envFile: string;
  /** The ElevenLabs voice id (`Config.generateVoiceId`). */
  readonly voiceId: string;
  /**
   * What one Higgsfield plan credit is worth in dollars (`Config.generateUsdPerCredit`): the shots
   * script books the credits the connector charges at this rate. Unset leaves the script's default.
   */
  readonly usdPerCredit?: number;
}

/**
 * How long one Bash command of a Generate run may take: 10 minutes, Claude Code's own maximum. A
 * `clip` call waits for Higgsfield for up to about 9 minutes (then answers `pending` and is run
 * again), and Claude Code's default of 2 minutes would cut every such wait short. It is the default
 * and the maximum, so the prompt does not have to ask for it on each call.
 */
export const GENERATE_BASH_TIMEOUT_MS = 600_000;

/** The variables the `song` command reads its tools from (`Config.songTools`). */
export const SONG_TOOL_VARS = { ytDlp: 'STUDIO_YT_DLP', deno: 'STUDIO_DENO' } as const;

/** The complete environment of the Claude process (spawned with `extendEnv: false`). */
export function childEnv({
  home,
  env,
  nodeBinDir = dirname(process.execPath),
  runTag,
  songTools,
  generate,
  stock,
  generateFake,
}: ChildEnvOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  out.HOME = home;
  out.PATH = childPath(home, env.PATH, nodeBinDir);
  // Without it the Bash tool uses the login shell (zsh), where a glob that matches nothing aborts
  // the whole command; video-use's snippets are written for bash.
  out.CLAUDE_CODE_SHELL = '/bin/bash';
  out.LANG ??= 'en_US.UTF-8';
  if (runTag !== undefined) out[RUN_TAG_VAR] = runTag;
  if (songTools !== undefined) {
    out[SONG_TOOL_VARS.ytDlp] = songTools.ytDlp;
    out[SONG_TOOL_VARS.deno] = songTools.deno;
  }
  if (stock !== undefined) {
    // The stock script finds its keys in this file; the run only ever sees where the file is.
    out[ENV_FILE_ENV] = stock.envFile;
  }
  if (generate !== undefined) {
    // The shots script finds its key in this file; the run only ever sees where the file is.
    out[ENV_FILE_ENV] = generate.envFile;
    out.STUDIO_GENERATE_VOICE_ID = generate.voiceId;
    if (generate.usdPerCredit !== undefined) {
      out.STUDIO_HIGGSFIELD_USD_PER_CREDIT = String(generate.usdPerCredit);
    }
    out.BASH_DEFAULT_TIMEOUT_MS = String(GENERATE_BASH_TIMEOUT_MS);
    out.BASH_MAX_TIMEOUT_MS = String(GENERATE_BASH_TIMEOUT_MS);
    if (generateFake === true) out.STUDIO_GENERATE_FAKE = '1';
  }
  return out;
}

/**
 * The environment of a `claude` process: `childEnv`, plus ANTHROPIC_API_KEY only when the Claude
 * billing switch is off (`planOnly: false`, Settings > Claude plan only) and the server has a key
 * (its git-ignored .env or its environment). That run bills the Anthropic API instead of the
 * claude.ai plan login. Otherwise, which is the default (the owner, 25 Oct 2026, "use only the plan for
 * everything"), the key is left out even when the server has one, so a key in `.env` or in the
 * environment can't bill the API or stop the runs at its usage limit. With the switch off and no
 * key, the CLI falls back to the login. The name stays so every place that starts `claude` says
 * what it starts.
 */
export function claudeEnv(options: ChildEnvOptions): Record<string, string> {
  const out = childEnv(options);
  if (options.planOnly === false) {
    const key = options.env.ANTHROPIC_API_KEY?.trim();
    if (key !== undefined && key !== '') out.ANTHROPIC_API_KEY = key;
  }
  return out;
}

/** `~/…` for paths under home, for messages and logs. */
export function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
