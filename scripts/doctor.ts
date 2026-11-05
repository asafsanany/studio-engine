/**
 * `pnpm doctor`: checks everything a headless video-use edit needs on this Mac and prints
 * pass/fail with the fix for each failure. Exit code 1 when anything fails; `--json` prints
 * the results as JSON instead. A warning (`!`) is a check that passed with something worth
 * knowing: it prints its fix but doesn't change the exit code.
 *
 * Runs on plain Node 22 (built-in type stripping), so it has no dependencies. The
 * section "Running edits" of docs/reference.md explains each prerequisite.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE_ID } from '../apps/server/assets/generate/make-voice.mjs';
import {
  APIFY,
  APIFY_TOKEN_ENV,
  DEFAULT_TOOLS,
  ENV_FILE,
  findTool,
  readApifyToken,
  YT_DLP,
} from '../apps/server/assets/music/get-song.mjs';
import { classifyYtDlpError } from '../apps/server/assets/music/yt-dlp-errors.mjs';
import { API_BASE as OPENVERSE_API } from '../apps/server/assets/stock/openverse.mjs';
import {
  readKey as readStockKey,
  KEY_ENV as STOCK_KEYS,
} from '../apps/server/assets/stock/stock-env.mjs';
import { API_BASE as UNSPLASH_API } from '../apps/server/assets/stock/unsplash.mjs';
import {
  moneyFilePath,
  moneyLastGoodPath,
  readMoneyFile,
} from '../apps/server/src/money/money-file.ts';
import {
  type ClaudeBin,
  claudeLocations,
  extraBinDirs,
  findExecutable,
  isExecutable,
  resolveClaudeBin,
} from '../apps/server/src/pipeline/claude-bin.ts';
import { findTailscale, serveCommand } from '../apps/server/src/remote/tailscale-cli.ts';
import { DEFAULT_PRICE_PER_JOB } from '../packages/shared/src/domain/money.ts';

// The engine's runner resolves `claude` with the same code, so the doctor checks the binary
// that edits will actually use.
export {
  bundledClaudeBins,
  type ClaudeBin,
  type ClaudeBinSource,
  compareVersions,
  extraBinDirs,
  findExecutable,
  isExecutable,
  resolveClaudeBin,
} from '../apps/server/src/pipeline/claude-bin.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Passed, but with a gap worth knowing about: `fix` is printed and the exit code stays 0. */
  warn?: boolean;
  /** Extra lines printed under the check, one per thing the warning is about. */
  notes?: string[];
}

/** Optional overrides in ~/.studio-engine/config.json (see the architecture page, §3). */
export interface EngineConfig {
  claudeBin?: string;
  model?: string;
  dataDir?: string;
  /** The Review switch: `false` turns Review off (it is on unless this or STUDIO_REVIEW says so). */
  review?: boolean;
  /** The Soundtrack switch (on unless this or STUDIO_MUSIC says so): Songs works only while it is on too. */
  music?: boolean;
  /** The Songs switch (on unless this or STUDIO_SONGS says so, and only with music on). */
  songs?: boolean;
  /** The Generated videos switch (default off, or STUDIO_GENERATE). */
  generate?: boolean;
  /** The ElevenLabs voice a generated video's voiceover is made with (or STUDIO_GENERATE_VOICE_ID). */
  generateVoiceId?: string;
  /** The Stock media switch (default off, or STUDIO_STOCK). */
  stock?: boolean;
  /** The engine's port (default 4310, or STUDIO_PORT). */
  port?: number;
}

/** The skill's own text, not upstream's: §0 makes it run without asking questions. */
const WRAPPER_MARKER = 'Operating mode: judgment, not questions';

export function locations(home: string) {
  return {
    config: join(home, '.studio-engine', 'config.json'),
    skillsDir: join(home, '.claude', 'skills'),
    skill: join(home, '.claude', 'skills', 'video-use'),
    videoUse: join(home, 'Developer', 'video-use'),
    ...claudeLocations(home),
    hyperframesChrome: join(home, '.cache', 'hyperframes', 'chrome'),
  };
}

export function expandHome(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;
}

export function tilde(p: string, home: string): string {
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** KEY=value lines; ignores blanks, comments and an `export ` prefix; strips matching quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function readConfig(file: string): EngineConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as EngineConfig) : {};
  } catch {
    return {};
  }
}

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

export function checkNode(version: string): Check {
  const major = Number(version.split('.')[0]);
  return major >= 22
    ? { name: 'Node 22', ok: true, detail: `v${version}` }
    : {
        name: 'Node 22',
        ok: false,
        detail: `v${version}`,
        fix: 'nvm install 22 && nvm use 22 (the repo has an .nvmrc)',
      };
}

function checkClaude(bin: ClaudeBin | null, home: string): Check[] {
  const name = 'Claude CLI';
  const login = 'Claude login';
  if (!bin) {
    return [
      {
        name,
        ok: false,
        detail: 'not found',
        fix: 'Open the Claude desktop app once (it ships the CLI), or install it with `claude install`, or set "claudeBin" in ~/.studio-engine/config.json',
      },
      { name: login, ok: false, detail: 'needs the Claude CLI' },
    ];
  }
  const where = `${bin.source} · ${tilde(bin.path, home)}`;
  if (!isExecutable(bin.path)) {
    return [
      {
        name,
        ok: false,
        detail: `missing: ${where}`,
        fix: 'Fix or remove "claudeBin" in ~/.studio-engine/config.json',
      },
      { name: login, ok: false, detail: 'needs the Claude CLI' },
    ];
  }
  const version = run(bin.path, ['--version']);
  const cli: Check = version.ok
    ? {
        name,
        ok: true,
        detail: `${firstLine(version.stdout).replace(' (Claude Code)', '')} · ${where}`,
      }
    : {
        name,
        ok: false,
        detail: `\`--version\` failed · ${where}`,
        fix: firstLine(version.stderr),
      };

  const loginFix = `Run in Terminal: "${bin.path}" auth login`;
  const status = run(bin.path, ['auth', 'status']);
  let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    auth = JSON.parse(status.stdout);
  } catch {
    // Older CLIs print text; treated as not logged in below.
  }
  const loginCheck: Check = auth.loggedIn
    ? {
        name: login,
        ok: true,
        detail: [auth.authMethod, auth.subscriptionType].filter(Boolean).join(' · ') || 'logged in',
      }
    : { name: login, ok: false, detail: 'not logged in', fix: loginFix };
  return [cli, loginCheck];
}

/** The skill this repo ships. `pnpm run doctor` runs at the repo root, so a fix can name it like this. */
const BUNDLED_SKILL = 'skills/video-use/SKILL.md';

export function checkSkill(
  home: string,
  bundledFile = fileURLToPath(new URL(`../${BUNDLED_SKILL}`, import.meta.url)),
): Check {
  const loc = locations(home);
  const name = 'video-use skill';
  const file = join(loc.skill, 'SKILL.md');
  const copy = `cp ${BUNDLED_SKILL} ~/.claude/skills/video-use/`;
  const install = `mkdir -p ~/.claude/skills/video-use && ${copy}`;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { name, ok: false, detail: `missing: ${tilde(file, home)}`, fix: install };
  }
  if (!/^name:\s*["']?video-use["']?\s*$/m.test(text)) {
    return { name, ok: false, detail: `${tilde(file, home)} is not named video-use`, fix: install };
  }
  if (!text.includes(WRAPPER_MARKER)) {
    // Upstream's own SKILL.md (what its installer symlinks here) asks before cutting, so an
    // unattended run would stop at the plan.
    const linked = lstatSync(loc.skill).isSymbolicLink();
    return {
      name,
      ok: false,
      detail: "upstream's SKILL.md, which asks questions; the Studio Engine skill is needed",
      fix: linked ? `rm ~/.claude/skills/video-use && ${install}` : install,
    };
  }
  if (differsFromRepoCopy(text, bundledFile)) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `live edits use an older copy of the skill than ${BUNDLED_SKILL}`,
      notes: [`${tilde(file, home)} differs from ${BUNDLED_SKILL}`],
      fix: copy,
    };
  }
  return { name, ok: true, detail: tilde(file, home) };
}

/**
 * Live edits read the installed copy, but fixes to a skill land in this repo's copy first
 * (~/.claude is protected, so a person copies it over). A difference means edits are running an
 * older skill. No repo copy means there is nothing to compare.
 */
function differsFromRepoCopy(installedText: string, bundledFile: string): boolean {
  try {
    return readFileSync(bundledFile, 'utf8') !== installedText;
  } catch {
    return false;
  }
}

function checkHyperframesSkills(home: string): Check {
  const loc = locations(home);
  const installed = listDir(loc.skillsDir).filter(
    (d) => d.startsWith('hyperframes') && existsSync(join(loc.skillsDir, d, 'SKILL.md')),
  );
  return installed.includes('hyperframes')
    ? { name: 'HyperFrames skills', ok: true, detail: `${installed.length} in ~/.claude/skills` }
    : {
        name: 'HyperFrames skills',
        ok: false,
        detail: 'not in ~/.claude/skills',
        fix: 'npx --yes hyperframes skills',
      };
}

/** The other skill this repo ships. */
const BUNDLED_EDIT_VIDEO = 'skills/edit-video/SKILL.md';

/** video-use looks for edit-video only at ~/.claude/skills/edit-video (HyperFrames captions builder, Mode B). */
export function checkEditVideoSkill(
  home: string,
  bundledFile = fileURLToPath(new URL(`../${BUNDLED_EDIT_VIDEO}`, import.meta.url)),
): Check {
  const name = 'edit-video skill';
  const dir = join(locations(home).skillsDir, 'edit-video');
  const file = join(dir, 'SKILL.md');
  const copy = `cp ${BUNDLED_EDIT_VIDEO} ~/.claude/skills/edit-video/`;
  const install = `mkdir -p ~/.claude/skills/edit-video && ${copy}`;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    let broken = false;
    try {
      broken = lstatSync(dir).isSymbolicLink();
    } catch {
      // Nothing at that path.
    }
    return broken
      ? {
          name,
          ok: false,
          detail: 'broken link: ~/.claude/skills/edit-video',
          fix: `rm ~/.claude/skills/edit-video && ${install}`,
        }
      : { name, ok: false, detail: `missing: ${tilde(file, home)}`, fix: install };
  }
  if (!/^name:\s*["']?edit-video["']?\s*$/m.test(text)) {
    return {
      name,
      ok: false,
      detail: `${tilde(file, home)} is not named edit-video`,
      fix: install,
    };
  }
  if (differsFromRepoCopy(text, bundledFile)) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `live edits use an older copy of the skill than ${BUNDLED_EDIT_VIDEO}`,
      notes: [`${tilde(file, home)} differs from ${BUNDLED_EDIT_VIDEO}`],
      fix: copy,
    };
  }
  return { name, ok: true, detail: tilde(file, home) };
}

function checkVideoUseRepo(home: string): Check {
  const dir = locations(home).videoUse;
  const name = 'video-use repo';
  const shown = tilde(dir, home);
  const setup = `git clone --depth 1 https://github.com/browser-use/video-use ${shown} && cd ${shown} && uv sync`;
  if (!existsSync(join(dir, 'helpers', 'render.py'))) {
    return { name, ok: false, detail: `not cloned: ${shown}`, fix: setup };
  }
  const python = join(dir, '.venv', 'bin', 'python');
  if (!isExecutable(python)) {
    return { name, ok: false, detail: 'no .venv', fix: `cd ${shown} && uv sync` };
  }
  const helpers = run(python, [join(dir, 'helpers', 'timeline_view.py'), '--help'], dir);
  return helpers.ok
    ? { name, ok: true, detail: `${shown} (.venv, helpers run)` }
    : {
        name,
        ok: false,
        detail: `helpers fail: ${firstLine(helpers.stderr)}`,
        fix: `cd ${shown} && uv sync`,
      };
}

function checkTool(
  name: string,
  bin: string,
  versionArgs: string[],
  fix: string,
  home: string,
  pathEnv: string | undefined,
): Check {
  const found = findExecutable(bin, pathEnv, extraBinDirs(home));
  if (!found) return { name, ok: false, detail: 'not found', fix };
  const version = run(found.path, versionArgs);
  const where = `${tilde(found.path, home)}${found.onPath ? '' : " (not on this shell's PATH)"}`;
  return version.ok
    ? { name, ok: true, detail: `${firstLine(version.stdout)} · ${where}` }
    : { name, ok: false, detail: `\`${bin} ${versionArgs.join(' ')}\` failed · ${where}`, fix };
}

/**
 * What a stock Homebrew ffmpeg lacks that changes how edits come out. A gap is met by any one
 * of its filters. The edit still runs without them (the skill takes another route), so a gap
 * is a warning, not a failure.
 */
export interface FfmpegGap {
  /** Shown in the report, e.g. "zscale". */
  name: string;
  /** The ffmpeg library that provides it, e.g. "zimg". */
  library: string;
  /** Any one of these filters meets it. */
  filters: string[];
  /** What changes in the edit, in plain words. */
  effect: string;
}

export const FFMPEG_GAPS: FfmpegGap[] = [
  {
    name: 'zscale',
    library: 'zimg',
    filters: ['zscale'],
    effect:
      "iPhone HDR clips can't be converted to normal colours by video-use's own render, so the edit improvises with a hardware scaler, which once turned a portrait clip sideways",
  },
  {
    name: 'subtitles/ass',
    library: 'libass',
    filters: ['subtitles', 'ass'],
    effect:
      "captions can't be burned in straight from the subtitle file, so they are built as a separate graphics layer instead",
  },
  {
    name: 'drawtext',
    library: 'freetype',
    filters: ['drawtext'],
    effect:
      "ffmpeg can't draw text itself, so titles and labels have to be made as separate graphics instead",
  },
];

/** `ffmpeg -hide_banner -filters`: legend lines, then ` TSC name  V->V  description` rows. */
export function parseFfmpegFilters(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*[T.][S.][C.]?\s+([\w.-]+)\s+[AVN|]+->[AVN|]+(?:\s|$)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

const gapLabel = (gap: FfmpegGap) => `${gap.name} (${gap.library})`;

export function missingFfmpegGaps(filters: ReadonlySet<string>): FfmpegGap[] {
  return FFMPEG_GAPS.filter((gap) => !gap.filters.some((f) => filters.has(f)));
}

export function ffmpegFiltersCheck(listing: string, fix: string): Check {
  const name = 'ffmpeg filters';
  const filters = parseFfmpegFilters(listing);
  if (filters.size === 0) {
    // An unrecognised format must not turn into a false "everything is missing".
    return { name, ok: true, warn: true, detail: "couldn't read ffmpeg's filter list" };
  }
  const missing = missingFfmpegGaps(filters);
  if (missing.length === 0) {
    return { name, ok: true, detail: FFMPEG_GAPS.map(gapLabel).join(', ') };
  }
  return {
    name,
    ok: true,
    warn: true,
    detail: `missing ${missing.map(gapLabel).join(', ')}`,
    notes: missing.map((g) => `${g.name}: ${g.effect}`),
    fix,
  };
}

/**
 * Homebrew's own build with zimg, libass and freetype. It is keg-only, so it has to take over
 * the plain ffmpeg's links to become the `ffmpeg` that edits find.
 */
const FFMPEG_FULL_FIX =
  'brew install ffmpeg-full && brew unlink ffmpeg && brew link --force ffmpeg-full';

function checkFfmpegFilters(home: string, pathEnv: string | undefined, fix: string): Check | null {
  const found = findExecutable('ffmpeg', pathEnv, extraBinDirs(home));
  if (!found) return null; // The ffmpeg check already fails and says how to install it.
  const listing = run(found.path, ['-hide_banner', '-filters']);
  return listing.ok
    ? ffmpegFiltersCheck(listing.stdout, fix)
    : {
        name: 'ffmpeg filters',
        ok: true,
        warn: true,
        detail: "couldn't list ffmpeg's filters (`ffmpeg -filters` failed)",
      };
}

function checkChrome(home: string, env: NodeJS.ProcessEnv): Check {
  const name = 'Chrome for HyperFrames';
  const fromEnv = env.HYPERFRAMES_BROWSER_PATH;
  if (fromEnv && isExecutable(fromEnv))
    return { name, ok: true, detail: 'HYPERFRAMES_BROWSER_PATH' };
  const cache = join(locations(home).hyperframesChrome, 'chrome-headless-shell');
  for (const build of listDir(cache)) {
    for (const platform of listDir(join(cache, build))) {
      const shell = join(cache, build, platform, 'chrome-headless-shell');
      if (isExecutable(shell)) return { name, ok: true, detail: `headless shell ${build}` };
    }
  }
  if (existsSync('/Applications/Google Chrome.app')) {
    return { name, ok: true, detail: '/Applications/Google Chrome.app' };
  }
  return { name, ok: false, detail: 'not found', fix: 'npx --yes hyperframes browser ensure' };
}

/** What a failing HyperFrames CLI costs, printed under it. Which one depends on the Review switch. */
export const HYPERFRAMES_CLI_NOTE = {
  reviewOn:
    'Review is on, so every edit checks its live preview with this CLI (lint and snapshots) and every Approve renders the final video with it. Without it every job fails.',
  reviewOff:
    'Review is off, so a new edit renders its own video and can still finish. This CLI is still used for HyperFrames graphics and captions, and by the revise and render runs of a job that is already in Review.',
};

/**
 * The verdict on one `npx --yes hyperframes --version` (`null`: no npx on PATH), given whether the
 * engine's Review switch is on.
 *
 * - Review on (the default): a failure is an error. Every edit lints and snapshots its live preview
 *   with the CLI and every Approve renders with it, so without it every job fails.
 * - Review off: a failure is only a warning. A new edit renders its own video and can still finish;
 *   only HyperFrames graphics and captions, and the revise and render runs of a job that is already
 *   in Review, need the CLI.
 *
 * A working CLI passes either way.
 */
export function hyperframesCliCheck(
  result: { ok: boolean; stdout: string; stderr: string } | null,
  review: boolean,
): Check {
  const name = 'HyperFrames CLI';
  const notes = [review ? HYPERFRAMES_CLI_NOTE.reviewOn : HYPERFRAMES_CLI_NOTE.reviewOff];
  const failed = (detail: string, fix: string): Check =>
    review
      ? { name, ok: false, detail, notes, fix }
      : { name, ok: true, warn: true, detail, notes, fix };
  if (result === null) {
    return failed('npx not found on PATH', 'nvm use 22, then: npx --yes hyperframes --version');
  }
  if (result.ok) {
    return {
      name,
      ok: true,
      detail: `${firstLine(result.stdout) || 'installed'} (npx hyperframes)`,
    };
  }
  const why = firstLine(result.stderr) || firstLine(result.stdout) || 'no output';
  return failed(
    `\`npx hyperframes --version\` failed: ${why}`,
    'npx --yes hyperframes --version (the first run downloads it, so it needs the network)',
  );
}

/**
 * Runs `npx --yes hyperframes --version`. npx is looked up on PATH only (no extra folders), so a
 * test's empty PATH never spawns anything. The first run downloads the CLI, hence the long timeout.
 */
function checkHyperframesCli(env: NodeJS.ProcessEnv, review: boolean): Check {
  const npx = findExecutable('npx', env.PATH);
  if (npx === null) return hyperframesCliCheck(null, review);
  const r = spawnSync(npx.path, ['--yes', 'hyperframes', '--version'], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_SKIP_SKILLS: '1' },
  });
  return hyperframesCliCheck(
    {
      ok: r.status === 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    },
    review,
  );
}

/** What a missing key costs, printed under the ElevenLabs check when the key can't be found. */
export const ELEVENLABS_MISSING_NOTE =
  "Without it, voice notes won't be transcribed, and edits can't transcribe the footage.";

/**
 * The key lives in ~/Developer/video-use/.env, where video-use's transcribe.py reads it, so it
 * never has to be in the environment of the Claude process (or in its logs). Edits through Claude
 * and the engine's own voice-note transcriber (apps/server/src/pipeline/voice-transcriber.ts) both
 * run the helper with a minimal environment that leaves the key out, so a key only in the shell
 * doesn't count. Only reports whether it is set and the file's mode; the value is never printed.
 */
export function checkElevenLabsKey(home: string, env: NodeJS.ProcessEnv): Check {
  const name = 'ElevenLabs key';
  const file = join(locations(home).videoUse, '.env');
  const shown = tilde(file, home);
  const fix = `cd ${tilde(locations(home).videoUse, home)} && cp -n .env.example .env; chmod 600 .env && open -e .env  then paste the key after ELEVENLABS_API_KEY= and save (key: https://elevenlabs.io/app/settings/api-keys)`;
  let inFile = false;
  try {
    inFile = Boolean(parseDotenv(readFileSync(file, 'utf8')).ELEVENLABS_API_KEY);
  } catch {
    // No .env yet.
  }
  if (inFile) {
    const mode = statSync(file).mode & 0o777;
    return mode & 0o077
      ? {
          name,
          ok: false,
          detail: `set in ${shown}, but readable by others (mode ${mode.toString(8)})`,
          fix: `chmod 600 ${shown}`,
        }
      : { name, ok: true, detail: `set in ${shown} (mode 600)` };
  }
  if (env.ELEVENLABS_API_KEY) {
    return {
      name,
      ok: false,
      detail: `only in this shell's environment; edits started by the engine read ${shown}`,
      fix,
      notes: [ELEVENLABS_MISSING_NOTE],
    };
  }
  return { name, ok: false, detail: `not set in ${shown}`, fix, notes: [ELEVENLABS_MISSING_NOTE] };
}

/** The free call the music check makes: ElevenLabs' /v1/music/plan costs no credits. */
export const MUSIC_CHECK_URL = 'https://api.elevenlabs.io/v1/music/plan';
export const MUSIC_CHECK_BODY = {
  prompt: 'short calm piano',
  music_length_ms: 10_000,
  model_id: 'music_v2_5',
};

/** The fix when the key can't make music. */
export const MUSIC_PERMISSION_FIX =
  "the key can't make music: give it the Music permission at https://elevenlabs.io/app/settings/api-keys";

/**
 * The part of `fetch` the network checks use (ElevenLabs' music call, Apify's account calls), so
 * tests can answer for them. The music call has a body; Apify's are plain GETs.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * "ElevenLabs music": whether the key can make music (Soundtrack's make-music.mjs), asked with
 * the free /v1/music/plan call. The key is read as the music script reads it (video-use's .env,
 * then the environment) and only sent in the request's header; it is never printed. A refused
 * key fails with its fix; no answer (offline, a timeout, ElevenLabs down or busy) only warns.
 */
export async function checkElevenLabsMusic(
  home: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<Check> {
  const name = 'ElevenLabs music';
  const file = join(locations(home).videoUse, '.env');
  const shown = tilde(file, home);
  let key = '';
  try {
    key = (parseDotenv(readFileSync(file, 'utf8')).ELEVENLABS_API_KEY ?? '').trim();
  } catch {
    // No .env: the environment's, if any.
  }
  if (key === '') key = (env.ELEVENLABS_API_KEY ?? '').trim();
  if (key === '') {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'not checked: there is no key (see ElevenLabs key)',
      fix: `put the key after ELEVENLABS_API_KEY= in ${shown}`,
    };
  }
  const offline = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm doctor again when ElevenLabs can be reached',
  });
  let status: number;
  let text = '';
  try {
    const res = await fetchImpl(MUSIC_CHECK_URL, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(MUSIC_CHECK_BODY),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    if (status !== 200) text = await res.text();
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return offline(
      timedOut
        ? `ElevenLabs didn't answer within ${timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} s` : `${timeoutMs} ms`}`
        : "ElevenLabs can't be reached (offline?)",
    );
  }
  if (status === 200) {
    return { name, ok: true, detail: 'the key can make music (checked with the free plan call)' };
  }
  let names: string[] = [];
  try {
    const detail = (JSON.parse(text) as { detail?: Record<string, unknown> }).detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      names = [detail.type, detail.code, detail.status]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
    }
  } catch {
    // Not JSON: the status says enough.
  }
  if (names.includes('invalid_api_key')) {
    return {
      name,
      ok: false,
      detail: `ElevenLabs says the key in ${shown} is invalid`,
      fix: `paste a valid key after ELEVENLABS_API_KEY= in ${shown} (key: https://elevenlabs.io/app/settings/api-keys)`,
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    names.some((value) =>
      ['missing_permissions', 'insufficient_permissions', 'authorization_error'].includes(value),
    )
  ) {
    return {
      name,
      ok: false,
      detail: `ElevenLabs refused the key (${status})`,
      fix: MUSIC_PERMISSION_FIX,
    };
  }
  if (status === 429) return offline('ElevenLabs is busy (429); try again in a minute');
  if (status >= 500) return offline(`ElevenLabs is down (${status})`);
  return offline(`ElevenLabs answered ${status}`);
}

// --- Generated videos: the voice (GN2) ---------------------------------------------------------
// Checked while Generated videos is on (STUDIO_GENERATE). Three free calls with the key video-use
// uses: the configured voice exists (GET /v1/voices/<id>), and the key is allowed to make speech and
// sound effects. The last two are asked with an empty text: ElevenLabs checks the key's permissions
// first and then refuses the empty text, so nothing is made and nothing is charged.

export const VOICE_CHECK_NAME = 'ElevenLabs voice and sound effects';
const ELEVENLABS_API = 'https://api.elevenlabs.io';
const API_KEYS_PAGE = 'https://elevenlabs.io/app/settings/api-keys';

/** The permissions make-voice.mjs needs, in the words of ElevenLabs' key page. */
const VOICE_PERMISSIONS: Record<string, string> = {
  text_to_speech: 'Text to Speech',
  sound_generation: 'Sound Effects',
  speech_to_text: 'Speech to Text',
  voices_read: 'Voices (read)',
};

interface Probe {
  status: number;
  /** The permission ElevenLabs says the key lacks, when it says one. */
  missing: string | null;
  invalidKey: boolean;
}

/** Sends one probe; `null` when nothing answered (offline, a timeout), with a word for why. */
async function probeElevenLabs(
  fetchImpl: FetchLike,
  key: string,
  method: 'GET' | 'POST',
  path: string,
  body: object | undefined,
  timeoutMs: number,
): Promise<Probe | { offline: string }> {
  let status: number;
  let text = '';
  try {
    const res = await fetchImpl(`${ELEVENLABS_API}${path}`, {
      method,
      headers: {
        'xi-api-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    if (status !== 200) text = await res.text();
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      offline: timedOut
        ? `ElevenLabs didn't answer within ${timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} s` : `${timeoutMs} ms`}`
        : "ElevenLabs can't be reached (offline?)",
    };
  }
  let names: string[] = [];
  let message = '';
  try {
    const detail = (JSON.parse(text) as { detail?: Record<string, unknown> }).detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      names = [detail.type, detail.code, detail.status]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
      if (typeof detail.message === 'string') message = detail.message;
    }
  } catch {
    // Not JSON: the status says enough.
  }
  const missing = names.includes('missing_permissions')
    ? (/permission\s+([a-z_]+)/i.exec(message)?.[1] ?? 'a permission')
    : null;
  return { status, missing, invalidKey: names.includes('invalid_api_key') };
}

/**
 * "ElevenLabs voice and sound effects": while Generated videos is on, whether the configured voice
 * exists and the key may make speech and sound effects (make-voice.mjs). With the switch off it is
 * skipped with a note. The key is read as the voice script reads it (video-use's .env, then the
 * environment), only sent in the request's header and never printed. A key that lacks a permission
 * fails with the fix; a missing Voices (read) permission alone only warns (the voice script does not
 * need it); no answer (offline, a timeout, ElevenLabs down or busy) only warns.
 */
export async function checkElevenLabsVoice(
  home: string,
  env: NodeJS.ProcessEnv,
  config: EngineConfig,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<Check> {
  const name = VOICE_CHECK_NAME;
  if (!resolveGenerate(env, config)) {
    return { name, ok: true, detail: 'skipped: Generated videos is off (STUDIO_GENERATE)' };
  }
  const file = join(locations(home).videoUse, '.env');
  const shown = tilde(file, home);
  let key = '';
  try {
    key = (parseDotenv(readFileSync(file, 'utf8')).ELEVENLABS_API_KEY ?? '').trim();
  } catch {
    // No .env: the environment's, if any.
  }
  if (key === '') key = (env.ELEVENLABS_API_KEY ?? '').trim();
  if (key === '') {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'not checked: there is no key (see ElevenLabs key)',
      fix: `put the key after ELEVENLABS_API_KEY= in ${shown}`,
    };
  }
  const voice = resolveGenerateVoiceId(env, config);
  const [voiceProbe, speechProbe, soundProbe] = await Promise.all([
    probeElevenLabs(fetchImpl, key, 'GET', `/v1/voices/${voice}`, undefined, timeoutMs),
    probeElevenLabs(
      fetchImpl,
      key,
      'POST',
      `/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      { text: '', model_id: 'eleven_multilingual_v2' },
      timeoutMs,
    ),
    probeElevenLabs(fetchImpl, key, 'POST', '/v1/sound-generation', { text: '' }, timeoutMs),
  ]);
  const probes = [voiceProbe, speechProbe, soundProbe];
  const offline = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm doctor again when ElevenLabs can be reached',
  });
  for (const probe of probes) if ('offline' in probe) return offline(probe.offline);
  const [voiceAnswer, speechAnswer, soundAnswer] = probes as [Probe, Probe, Probe];
  if (probes.some((probe) => (probe as Probe).invalidKey)) {
    return {
      name,
      ok: false,
      detail: `ElevenLabs says the key in ${shown} is invalid`,
      fix: `paste a valid key after ELEVENLABS_API_KEY= in ${shown} (key: ${API_KEYS_PAGE})`,
    };
  }
  // The voice script needs these two; Voices (read) only lets this check look the voice up.
  const lacking = [
    ['text_to_speech', speechAnswer],
    ['sound_generation', soundAnswer],
  ].flatMap(([permission, probe]) =>
    (probe as Probe).missing !== null
      ? [VOICE_PERMISSIONS[permission as string] ?? (permission as string)]
      : [],
  );
  const voiceRead = voiceAnswer.missing !== null;
  if (lacking.length > 0) {
    const more = voiceRead ? ' and Voices (read)' : '';
    return {
      name,
      ok: false,
      detail: `the key may not use ${lacking.join(' and ')}`,
      fix: `at ${API_KEYS_PAGE} allow ${lacking.join(', ')}${more} for the key in ${shown}, then run pnpm doctor again`,
    };
  }
  for (const probe of [speechAnswer, soundAnswer]) {
    if (probe.status === 401 || probe.status === 403) {
      return {
        name,
        ok: false,
        detail: `ElevenLabs refused the key (${probe.status})`,
        fix: `check the key in ${shown} and its permissions at ${API_KEYS_PAGE}`,
      };
    }
  }
  if (voiceAnswer.status === 404 || voiceAnswer.status === 400 || speechAnswer.status === 404) {
    return {
      name,
      ok: false,
      detail: `ElevenLabs has no voice ${voice}`,
      fix: 'set STUDIO_GENERATE_VOICE_ID (or "generateVoiceId" in ~/.studio-engine/config.json) to the id of a voice in your ElevenLabs account',
    };
  }
  if ((probes as Probe[]).some((probe) => probe.status === 429)) {
    return offline('ElevenLabs is busy (429); try again in a minute');
  }
  const down = (probes as Probe[]).find((probe) => probe.status >= 500);
  if (down) return offline(`ElevenLabs is down (${down.status})`);
  if (voiceRead) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `the key can make speech and sound effects, but may not read voices, so voice ${voice} is not checked`,
      fix: `at ${API_KEYS_PAGE} allow Voices (read) for the key in ${shown}, then run pnpm doctor again`,
    };
  }
  return {
    name,
    ok: true,
    detail: `voice ${voice} exists; the key can make speech and sound effects (checked with free calls)`,
  };
}

// --- Generated videos: the Higgsfield connector (U26) ----------------------------------------------
// Checked while Generated videos is on (STUDIO_GENERATE). Since 27 Oct 2026 the pictures and clips are
// made on the Higgsfield PLAN's credits through the "Higgsfield" connector of the Claude account (the
// Generate run's `mcp__claude_ai_Higgsfield__*` tools), not through an API key. `claude mcp list`, run
// with the same binary the runs use and on the plan login, says whether the connector is connected.
// The plan's balance can only be read by a Claude run, so there is no balance check.

export const HIGGSFIELD_CHECK_NAME = 'Higgsfield connector';

/** The line of `claude mcp list` for the connector: "claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✔ Connected". */
const HIGGSFIELD_MCP_LINE = /^claude\.ai Higgsfield:\s*\S+\s+-\s*(.*)$/m;

/** Runs `claude mcp list` with `bin`; `ok` is false when it did not answer. */
export type McpListRunner = (
  bin: string,
  env: NodeJS.ProcessEnv,
) => { ok: boolean; stdout: string };

function claudeMcpList(bin: string, env: NodeJS.ProcessEnv): { ok: boolean; stdout: string } {
  // The plan login, like the runs: an API key in the environment would hide the account's connectors.
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  const r = spawnSync(bin, ['mcp', 'list'], {
    encoding: 'utf8',
    timeout: 90_000,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

/**
 * "Higgsfield connector": while Generated videos is on, whether the Claude account has the
 * Higgsfield connector and it is connected. With the switch off it is skipped with a note. A missing
 * or unauthenticated connector fails with its fix; no answer from `claude mcp list` only warns.
 */
export function checkHiggsfieldConnector(
  env: NodeJS.ProcessEnv,
  config: EngineConfig,
  home: string,
  mcpList: McpListRunner = claudeMcpList,
): Check {
  const name = HIGGSFIELD_CHECK_NAME;
  if (!resolveGenerate(env, config)) {
    return { name, ok: true, detail: 'skipped: Generated videos is off (STUDIO_GENERATE)' };
  }
  const fix =
    'in the Claude app open Settings, Connectors and add (or reconnect) Higgsfield, then run pnpm run doctor again';
  const bin = resolveClaudeBin({ home, pathEnv: env.PATH, configBin: config.claudeBin });
  if (bin === null) {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'not checked: Claude Code was not found (see the Claude Code check)',
      fix: 'fix the Claude Code check first',
    };
  }
  const listed = mcpList(bin.path, env);
  if (!listed.ok) {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'not checked: claude mcp list did not answer',
      fix: 'run pnpm run doctor again in a minute',
    };
  }
  const line = HIGGSFIELD_MCP_LINE.exec(listed.stdout);
  if (line === null) {
    return {
      name,
      ok: false,
      detail: 'the Higgsfield connector is not in your Claude account',
      fix,
    };
  }
  const status = line[1] ?? '';
  if (/needs authentication/i.test(status)) {
    return { name, ok: false, detail: 'the Higgsfield connector needs signing in again', fix };
  }
  if (/failed|error/i.test(status)) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `not checked: the connector did not connect (${status.replace(/^\W+/, '')})`,
      fix: 'run pnpm run doctor again in a minute',
    };
  }
  if (/connected/i.test(status)) {
    return {
      name,
      ok: true,
      detail:
        "connected: pictures and clips are made on the Higgsfield plan's credits (the balance can only be read by a Claude run)",
    };
  }
  return {
    name,
    ok: true,
    warn: true,
    detail: `not checked: the connector says "${status.trim()}"`,
    fix: 'run pnpm run doctor again in a minute',
  };
}

// --- Songs (SG1) -----------------------------------------------------------------------------
// Checked only while Songs is on (on by default since U22, with music; STUDIO_SONGS=0 or
// STUDIO_MUSIC=0 turns it off; resolveSongs). With it off nothing here runs and nothing is
// printed. yt-dlp is for YouTube and YouTube Music only: Instagram and TikTok links go through
// Apify. Nothing is ever downloaded: the YouTube check is a simulate.

/** yt-dlp is checked against YouTube's changes: older than this many days is a warning. */
export const YT_DLP_MAX_AGE_DAYS = 60;

/** The oldest deno yt-dlp's YouTube JavaScript solver is relied on with. */
export const DENO_MIN_VERSION = [2, 3] as const;

/** A video that has been public since 2005 ("Me at the zoo", YouTube's first), for the simulate. */
export const YOUTUBE_TEST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** Below this much Apify credit left, the check warns: a trending pick can cost up to $1. */
export const APIFY_LOW_CREDIT_USD = 1;

const DAY_MS = 86_400_000;

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A wait in words: "10 s", or "50 ms" under a second. */
const waited = (ms: number) => (ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`);

/** Where a tool is, as the song getter looks (its `findTool`); replaced in tests. */
type FindTool = (name: string, env: NodeJS.ProcessEnv) => string | null;

/**
 * A line saying the Songs switch was turned on by name but is not effective: the engine leaves
 * Songs off without music, so none of the song checks run. Only when songs was written down as on
 * (STUDIO_SONGS=1, or "songs": true) and music was turned off; songs on by default with music off
 * is just songs off.
 */
export function songsNeedMusicCheck(): Check {
  return {
    name: 'Songs',
    ok: true,
    warn: true,
    detail: 'asked for, but music is off, so songs stays off',
    fix: 'Turn music back on: remove STUDIO_MUSIC=0 (or "music": false in ~/.studio-engine/config.json)',
  };
}

/** The first line of `ffmpeg -version`, without the copyright: "ffmpeg version 8.0". */
const ffmpegVersionOf = (stdout: string) => firstLine(stdout).replace(/\s+Copyright.*$/i, '');

/**
 * yt-dlp at the configured path (`songTools.ytDlp`, the one the engine runs): it runs, and
 * `--version` is a date. Missing is a failure; older than {@link YT_DLP_MAX_AGE_DAYS} days only
 * warns (YouTube changes, and an old yt-dlp stops reading it).
 */
export function checkYtDlp(
  ytDlp: string,
  env: NodeJS.ProcessEnv,
  home: string,
  nowMs = Date.now(),
  find: FindTool = findTool,
): Check {
  const name = 'yt-dlp';
  const shown = tilde(ytDlp, home);
  const install = 'Run brew install yt-dlp deno';
  if (!isExecutable(ytDlp)) {
    // Installed, but not where the engine looks (an Intel Mac's /usr/local/bin, say)?
    const elsewhere = find('yt-dlp', env);
    return elsewhere !== null && elsewhere !== ytDlp
      ? {
          name,
          ok: false,
          detail: `not at ${shown}, but found at ${tilde(elsewhere, home)}`,
          fix: `Set STUDIO_YT_DLP=${elsewhere} for the engine (or ${install.toLowerCase()})`,
        }
      : { name, ok: false, detail: `not found: ${shown}`, fix: install };
  }
  const version = run(ytDlp, ['--ignore-config', '--version']);
  if (!version.ok) {
    return {
      name,
      ok: false,
      detail: `\`yt-dlp --version\` failed: ${firstLine(version.stderr) || 'no output'} · ${shown}`,
      fix: 'Run brew reinstall yt-dlp',
    };
  }
  const text = firstLine(version.stdout);
  const date = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.\d+)?$/.exec(text);
  if (date === null) {
    return {
      name,
      ok: false,
      detail: `\`yt-dlp --version\` printed "${text}", which is not a date · ${shown}`,
      fix: 'Run brew reinstall yt-dlp',
    };
  }
  const released = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  const days = Math.max(0, Math.floor((nowMs - released) / DAY_MS));
  if (days > YT_DLP_MAX_AGE_DAYS) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `yt-dlp is ${days} days old (${text}) · ${shown}`,
      notes: ['YouTube changes often, and an old yt-dlp stops being able to read it.'],
      fix: 'Run brew upgrade yt-dlp',
    };
  }
  return { name, ok: true, detail: `${text} (${days} days old) · ${shown}` };
}

/** deno at the configured path (`songTools.deno`): it runs and is 2.3 or newer. */
export function checkDeno(deno: string, home: string): Check {
  const name = 'deno';
  const shown = tilde(deno, home);
  const [major, minor] = DENO_MIN_VERSION;
  if (!isExecutable(deno)) {
    return { name, ok: false, detail: `not found: ${shown}`, fix: 'Run brew install yt-dlp deno' };
  }
  const version = run(deno, ['--version']);
  if (!version.ok) {
    return {
      name,
      ok: false,
      detail: `\`deno --version\` failed: ${firstLine(version.stderr) || 'no output'} · ${shown}`,
      fix: 'Run brew reinstall deno',
    };
  }
  const found = /deno (\d+)\.(\d+)\.(\d+)/i.exec(version.stdout);
  if (found === null) {
    return {
      name,
      ok: false,
      detail: `\`deno --version\` printed "${firstLine(version.stdout)}", which is not a version · ${shown}`,
      fix: 'Run brew reinstall deno',
    };
  }
  const text = `${found[1]}.${found[2]}.${found[3]}`;
  const tooOld =
    Number(found[1]) < major || (Number(found[1]) === major && Number(found[2]) < minor);
  return tooOld
    ? {
        name,
        ok: false,
        detail: `deno ${text} is too old: ${major}.${minor} or newer is needed · ${shown}`,
        notes: ["yt-dlp runs YouTube's JavaScript with deno."],
        fix: 'Run brew upgrade deno',
      }
    : { name, ok: true, detail: `deno ${text} · ${shown}` };
}

/**
 * ffmpeg as the song getter finds it (its `findTool`: $MUSIC_FFMPEG, PATH, Homebrew's and
 * /usr/local's bin), because the getter converts the download with it and the launchd agent has no
 * Homebrew PATH.
 */
export function checkSongFfmpeg(
  env: NodeJS.ProcessEnv,
  home: string,
  find: FindTool = findTool,
): Check {
  const name = 'ffmpeg for songs';
  const fix = 'Run brew install ffmpeg';
  const found = find('ffmpeg', env);
  if (found === null) return { name, ok: false, detail: 'not found', fix };
  const shown = tilde(found, home);
  const version = run(found, ['-version']);
  return version.ok
    ? { name, ok: true, detail: `${ffmpegVersionOf(version.stdout)} · ${shown}` }
    : { name, ok: false, detail: `\`ffmpeg -version\` failed · ${shown}`, fix };
}

/**
 * The Apify key (`APIFY_TOKEN`) in the repo's .env. Instagram and TikTok links and trending picks
 * need it; a song by name, or a YouTube link, does not, so a missing key only warns. The value is
 * never printed. Edits reach the music script without the shell's environment, so a key only in the
 * shell does not count (as with the ElevenLabs key).
 */
export function checkApifyKey(env: NodeJS.ProcessEnv, envFile: string = ENV_FILE): Check {
  const name = 'Apify key';
  const need =
    'Reel links and trending songs need an Apify key. A song by name, or a YouTube link, works without it.';
  if (readApifyToken({}, envFile) !== null) return { name, ok: true, detail: 'set in .env' };
  const fix = 'add APIFY_TOKEN to .env (key: https://console.apify.com/settings/integrations)';
  if ((env[APIFY_TOKEN_ENV] ?? '').trim() !== '') {
    return {
      name,
      ok: true,
      warn: true,
      detail: "only in this shell's environment; the engine reads .env",
      notes: [need],
      fix,
    };
  }
  return { name, ok: true, warn: true, detail: 'not set in .env', notes: [need], fix };
}

/** What a finished (or stopped) yt-dlp run left. */
export interface Ran {
  /** The exit code; `null` when it never ran or was stopped. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not start. */
  spawnError: string | null;
}

/** Runs a program without waiting on the event loop; stopped (SIGKILL) after `timeoutMs`. */
export function runAsync(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const cap = 2_000_000;
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (ran: Omit<Ran, 'stdout' | 'stderr'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...ran, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, timedOut: true, spawnError: null });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < cap) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < cap) stderr += chunk;
    });
    child.on('error', (error) =>
      finish({ code: null, timedOut: false, spawnError: error.message }),
    );
    child.on('close', (code) => finish({ code, timedOut: false, spawnError: null }));
  });
}

/**
 * What `yt-dlp -v` says about deno, from its "JS Challenge Providers: bun (unavailable), deno, …"
 * line (yt-dlp lists each provider, with "(unavailable)" for one it cannot use):
 * `available`, `unavailable`, `not listed` (the line has no deno), or `no line` (an older yt-dlp,
 * from before it solved YouTube's JavaScript challenges with a runtime).
 */
export function denoChallengeState(
  stderr: string,
): 'available' | 'unavailable' | 'not listed' | 'no line' {
  const marker = 'JS Challenge Providers:';
  const line = stderr.split(/\r?\n/).find((l) => l.includes(marker));
  if (line === undefined) return 'no line';
  const providers = line.slice(line.indexOf(marker) + marker.length);
  const deno = /(?:^|,)\s*deno\b[^,(]*(?:\(([^)]*)\))?/i.exec(providers);
  if (deno === null) return 'not listed';
  return /unavailable/i.test(deno[1] ?? '') ? 'unavailable' : 'available';
}

/** What yt-dlp prints when YouTube answers HTTP 429: a temporary "too many requests". */
const YOUTUBE_TOO_MANY_REQUESTS = /http error 429|too many requests/i;

/**
 * The verdict on one simulated YouTube download (`yt-dlp -v -s` of a public test video):
 * - Green: it worked and yt-dlp lists deno as usable for YouTube's JavaScript challenges.
 * - Error: deno unusable, or yt-dlp too old, or YouTube refusing this Mac, or any other complaint,
 *   in the words of `classifyYtDlpError` (the same reader the song getter uses).
 * - Warning: no answer (offline, a timeout, the video not shown), YouTube answering HTTP 429 (too
 *   many requests: temporary, after heavy use), or it worked but yt-dlp does not list deno at all
 *   (an old yt-dlp).
 */
export function youtubeCheck(ran: Ran, timeoutMs: number): Check {
  const name = 'YouTube';
  const notChecked = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm run doctor again when YouTube can be reached',
  });
  if (ran.spawnError !== null) {
    return {
      name,
      ok: false,
      detail: `yt-dlp could not start: ${ran.spawnError}`,
      fix: 'Run brew reinstall yt-dlp',
    };
  }
  if (ran.timedOut) {
    return notChecked(`YouTube didn't answer within ${waited(timeoutMs)}`);
  }
  const deno = denoChallengeState(ran.stderr);
  const denoFix = 'Run brew upgrade yt-dlp deno';
  if (ran.code === 0) {
    if (deno === 'available') {
      return {
        name,
        ok: true,
        detail: 'a test video answers (simulated, nothing downloaded), and yt-dlp can use deno',
      };
    }
    if (deno === 'unavailable') {
      return {
        name,
        ok: false,
        detail: 'yt-dlp lists deno as unavailable, so it cannot solve YouTube’s JavaScript checks',
        fix: denoFix,
      };
    }
    return {
      name,
      ok: true,
      warn: true,
      detail: 'a test video answers, but yt-dlp does not list deno as its JavaScript helper',
      notes: ['This yt-dlp is probably too old for YouTube’s newer checks.'],
      fix: 'Run brew upgrade yt-dlp',
    };
  }
  // HTTP 429 is YouTube saying "too many requests": after a lot of songs in a short time it asks
  // this Mac to wait. It clears by itself and says nothing about the install, so it is a warning,
  // not a failure. Read before the classifier, which would take yt-dlp's "Unable to download API
  // page: HTTP Error 429" for YouTube not answering.
  if (YOUTUBE_TOO_MANY_REQUESTS.test(`${ran.stderr}\n${ran.stdout}`)) {
    return {
      name,
      ok: true,
      warn: true,
      detail:
        'YouTube said too many requests (HTTP 429): this Mac asked a lot lately and has to wait. This is not a problem with yt-dlp or deno',
      notes: ['This goes away by itself, usually within an hour. Nothing to install or fix.'],
      fix: 'Run pnpm run doctor again later',
    };
  }
  const { code, message } = classifyYtDlpError(`${ran.stderr}\n${ran.stdout}`, {
    song: 'the test video',
    site: 'YouTube',
  });
  // The reader ends its advice with "Run: …, then ask again": the fix line says that here.
  const said = message.replace(/\s+Run: .*$/, '');
  if (code === 'unavailable') return notChecked(said);
  if (code === 'update_needed') {
    return deno === 'unavailable'
      ? {
          name,
          ok: false,
          detail: 'yt-dlp cannot use deno, so it cannot solve YouTube’s JavaScript checks',
          fix: denoFix,
        }
      : { name, ok: false, detail: said, fix: 'Run brew upgrade yt-dlp' };
  }
  if (code === 'blocked') {
    return { name, ok: false, detail: said, fix: 'Wait a while, then run pnpm run doctor again' };
  }
  if (code === 'tool_missing') {
    return { name, ok: false, detail: said, fix: 'Run brew install yt-dlp deno ffmpeg' };
  }
  return { name, ok: false, detail: said, fix: 'Run brew upgrade yt-dlp, then run this again' };
}

/**
 * "YouTube": a simulated download (`-s`, nothing is saved) of a public test video, run as the
 * engine runs yt-dlp (`--ignore-config`, `--js-runtimes deno:<path>`), then read by youtubeCheck.
 * Asks for the network, so it lives with the other network checks (runAllChecks). Skipped, with a
 * warning, when yt-dlp or deno is missing: their own checks fail first.
 */
export async function checkYouTube(
  tools: { ytDlp: string; deno: string },
  env: NodeJS.ProcessEnv,
  timeoutMs: number = YT_DLP.infoTimeoutMs,
): Promise<Check> {
  if (!isExecutable(tools.ytDlp) || !isExecutable(tools.deno)) {
    return {
      name: 'YouTube',
      ok: true,
      warn: true,
      detail: 'not checked: yt-dlp or deno is missing (see above)',
      fix: 'Run brew install yt-dlp deno',
    };
  }
  // As the getter runs it: no key-like variable, and the tools' own folders on PATH.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && !/token|key|secret|password|credential/i.test(key)) {
      childEnv[key] = value;
    }
  }
  childEnv.PATH = [
    ...new Set([
      dirname(tools.ytDlp),
      dirname(tools.deno),
      ...(env.PATH ?? '').split(':'),
      '/usr/bin',
      '/bin',
    ]),
  ]
    .filter(Boolean)
    .join(':');
  const ran = await runAsync(
    tools.ytDlp,
    [
      '--ignore-config',
      '-v',
      '-s',
      '--no-playlist',
      '--js-runtimes',
      `deno:${tools.deno}`,
      YOUTUBE_TEST_URL,
    ],
    childEnv,
    timeoutMs,
  );
  return youtubeCheck(ran, timeoutMs);
}

/** The numbers out of Apify's JSON, as far as they are there. */
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * "Apify": whether the key works and how much of the month's credit is left, from two free account
 * calls (`GET /v2/users/me` for the key and the plan, `GET /v2/users/me/limits` for the usage so
 * far). Neither runs anything or costs credit. The key is sent only in an Authorization header and
 * is never printed. A refused key fails with its fix; no answer (offline, a timeout, Apify down or
 * busy) only warns.
 */
export async function checkApify(
  env: NodeJS.ProcessEnv,
  envFile: string = ENV_FILE,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<Check> {
  const name = 'Apify';
  const token = readApifyToken(env, envFile);
  if (token === null) {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'not checked: there is no key (see Apify key)',
      fix: 'add APIFY_TOKEN to .env',
    };
  }
  const offline = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm run doctor again when Apify can be reached',
  });
  const get = async (path: string) => {
    const res = await fetchImpl(`${APIFY.base}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.status === 200 ? await res.text() : '';
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: res.status, data: obj(obj(body).data) };
  };

  let me: Awaited<ReturnType<typeof get>>;
  try {
    me = await get('/v2/users/me');
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return offline(
      timedOut
        ? `Apify didn't answer within ${waited(timeoutMs)}`
        : "Apify can't be reached (offline?)",
    );
  }
  if (me.status === 401) {
    return {
      name,
      ok: false,
      detail: 'Apify says the key in .env is not valid',
      fix: 'paste a valid key after APIFY_TOKEN= in .env (key: https://console.apify.com/settings/integrations)',
    };
  }
  if (me.status === 403) {
    return offline('Apify refused the account lookup (403); the key may still run the scrapers');
  }
  if (me.status === 429) return offline('Apify is busy (429); try again in a minute');
  if (me.status >= 500) return offline(`Apify is down (${me.status})`);
  if (me.status !== 200) return offline(`Apify answered ${me.status}`);

  const plan = obj(me.data.plan);
  const planName =
    (typeof plan.description === 'string' && plan.description) ||
    (typeof plan.id === 'string' && plan.id) ||
    'plan not shown';
  const credit = num(plan.monthlyUsageCreditsUsd);
  let used: number | null = null;
  let cycleEnd = '';
  try {
    const limits = await get('/v2/users/me/limits');
    if (limits.status === 200) {
      used = num(obj(limits.data.current).monthlyUsageUsd);
      const end = obj(limits.data.monthlyUsageCycle).endAt;
      cycleEnd = typeof end === 'string' ? end.slice(0, 10) : '';
    }
  } catch {
    // The key works; only the usage so far is unknown.
  }
  if (credit === null) return { name, ok: true, detail: `the key works · ${planName}` };
  if (used === null) {
    return {
      name,
      ok: true,
      detail: `the key works · ${planName} · ${usd(credit)} monthly credit (usage not read)`,
    };
  }
  const left = Math.max(0, credit - used);
  const detail = `the key works · ${planName} · ${usd(left)} of ${usd(credit)} monthly credit left`;
  if (left >= APIFY_LOW_CREDIT_USD) return { name, ok: true, detail };
  return {
    name,
    ok: true,
    warn: true,
    detail,
    notes: [
      'A trending pick can cost up to $1, so reel links and trending songs may stop working.',
    ],
    fix: `${cycleEnd ? `the credit renews on ${cycleEnd}; or ` : ''}add credit in the Apify console (Billing)`,
  };
}

/**
 * The song checks that need no network, in the order they print: the three programs and the key.
 * Empty while Songs is off; one warning line when it was asked for without music.
 */
export function songChecks(
  home: string,
  env: NodeJS.ProcessEnv,
  config: EngineConfig,
  envFile: string = ENV_FILE,
): Check[] {
  const songs = resolveSongs(env, config);
  if (!songs.on) return songs.asked ? [songsNeedMusicCheck()] : [];
  const tools = resolveSongTools(home, env);
  return [
    checkYtDlp(tools.ytDlp, env, home),
    checkDeno(tools.deno, home),
    checkSongFfmpeg(env, home),
    checkApifyKey(env, envFile),
  ];
}

/**
 * Every check, the network ones included: runChecks, with "ElevenLabs music", "ElevenLabs voice
 * and sound effects" and "Higgsfield connector" right after "ElevenLabs key", while Stock media is on
 * "Openverse sound effects" and "Unsplash photos" right after "Higgsfield connector" and, while Songs is
 * on, "YouTube" and "Apify" right after "Apify key".
 */
export async function runAllChecks(
  home: string,
  env: NodeJS.ProcessEnv,
  nodeVersion: string,
  fetchImpl: FetchLike = fetch,
  envFile: string = ENV_FILE,
): Promise<Check[]> {
  const checks = runChecks(home, env, nodeVersion, envFile);
  const config = readConfig(locations(home).config);
  const [music, voice, higgsfield] = await Promise.all([
    checkElevenLabsMusic(home, env, fetchImpl),
    checkElevenLabsVoice(home, env, config, fetchImpl),
    checkHiggsfieldConnector(env, config, home),
  ]);
  checks.splice(
    checks.findIndex((check) => check.name === 'ElevenLabs key') + 1,
    0,
    music,
    voice,
    higgsfield,
  );
  if (resolveStock(env, config)) {
    const [openverse, unsplash] = await Promise.all([
      checkOpenverse(envFile, fetchImpl),
      checkUnsplash(env, envFile, fetchImpl),
    ]);
    checks.splice(
      checks.findIndex((check) => check.name === HIGGSFIELD_CHECK_NAME) + 1,
      0,
      openverse,
      unsplash,
    );
  }
  if (resolveSongs(env, config).on) {
    const [youtube, apify] = await Promise.all([
      checkYouTube(resolveSongTools(home, env), env),
      checkApify(env, envFile, fetchImpl),
    ]);
    checks.splice(checks.findIndex((check) => check.name === 'Apify key') + 1, 0, youtube, apify);
  }
  return checks;
}

export const OPENVERSE_CHECK_NAME = 'Openverse sound effects';
export const UNSPLASH_CHECK_NAME = 'Unsplash photos';

/**
 * "Openverse sound effects" (checked only while Stock media is on): whether the stock script can
 * search Openverse. With the OAuth client id and secret in .env it asks for a token, which proves
 * the pair; without them it makes one anonymous search, which works with low limits (the check warns
 * and says how to register). A refused pair fails with its fix; no answer only warns. Keys are sent
 * only in the request and never printed.
 */
export async function checkOpenverse(
  envFile: string = ENV_FILE,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<Check> {
  const name = OPENVERSE_CHECK_NAME;
  const id = readStockKey(STOCK_KEYS.openverseId, {}, envFile);
  const secret = readStockKey(STOCK_KEYS.openverseSecret, {}, envFile);
  const registered = id !== null && secret !== null;
  const offline = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm run doctor again when Openverse can be reached',
  });
  const unreachable = (err: unknown): Check => {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return offline(
      timedOut
        ? `Openverse didn't answer within ${waited(timeoutMs)}`
        : "Openverse can't be reached (offline?)",
    );
  };
  const register =
    'register an app at https://api.openverse.org/v1/#section/Register-and-Authenticate, then add OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET to .env';
  try {
    if (registered) {
      const res = await fetchImpl(`${OPENVERSE_API}/v1/auth_tokens/token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: id,
          client_secret: secret,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 200) {
        return { name, ok: true, detail: 'the client id and secret in .env give a token' };
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return {
          name,
          ok: false,
          detail: 'Openverse says the client id and secret in .env are not valid',
          fix: `check OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET in .env (${register})`,
        };
      }
      if (res.status === 429) return offline('Openverse is busy (429); try again in a minute');
      if (res.status >= 500) return offline(`Openverse is down (${res.status})`);
      return offline(`Openverse answered ${res.status}`);
    }
    const res = await fetchImpl(
      `${OPENVERSE_API}/v1/audio/?q=whoosh&source=freesound&page_size=1`,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (res.status === 200) {
      return {
        name,
        ok: true,
        warn: true,
        detail: 'searches work, anonymously: low limits, and a busy hour can refuse them',
        fix: register,
      };
    }
    if (res.status === 429) {
      return {
        name,
        ok: true,
        warn: true,
        detail: 'Openverse refused the anonymous search (429): its limits for no key are low',
        fix: register,
      };
    }
    return offline(
      res.status >= 500 ? `Openverse is down (${res.status})` : `Openverse answered ${res.status}`,
    );
  } catch (err) {
    return unreachable(err);
  }
}

/**
 * "Unsplash photos" (checked only while Stock media is on): whether the access key in .env can
 * search, with one search for one photo (it counts as one of the demo key's 50 requests an hour).
 * No key only warns, since sound effects work without one; a refused key fails with its fix; no
 * answer only warns. The key is sent only in the Authorization header and never printed.
 */
export async function checkUnsplash(
  env: NodeJS.ProcessEnv,
  envFile: string = ENV_FILE,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<Check> {
  const name = UNSPLASH_CHECK_NAME;
  const key = readStockKey(STOCK_KEYS.unsplash, {}, envFile);
  const fix =
    'add UNSPLASH_ACCESS_KEY=<access key> to .env (key: https://unsplash.com/oauth/applications)';
  if (key === null) {
    const inShell = (env[STOCK_KEYS.unsplash] ?? '').trim() !== '';
    return {
      name,
      ok: true,
      warn: true,
      detail: inShell
        ? "only in this shell's environment; the engine reads .env"
        : 'not checked: there is no key, so edits cannot get photos',
      fix,
    };
  }
  const offline = (detail: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail: `not checked: ${detail}`,
    fix: 'run pnpm run doctor again when Unsplash can be reached',
  });
  let status: number;
  try {
    const res = await fetchImpl(`${UNSPLASH_API}/search/photos?query=street&per_page=1`, {
      method: 'GET',
      headers: { authorization: `Client-ID ${key}`, 'accept-version': 'v1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return offline(
      timedOut
        ? `Unsplash didn't answer within ${waited(timeoutMs)}`
        : "Unsplash can't be reached (offline?)",
    );
  }
  if (status === 200) return { name, ok: true, detail: 'the access key can search photos' };
  if (status === 401) {
    return {
      name,
      ok: false,
      detail: 'Unsplash says the access key in .env is not valid',
      fix,
    };
  }
  // 403 is also what Unsplash answers when the hour's requests (50 on a demo key) are used up.
  if (status === 403 || status === 429) {
    return offline('Unsplash refused the search (403): the hour’s requests may be used up');
  }
  if (status >= 500) return offline(`Unsplash is down (${status})`);
  return offline(`Unsplash answered ${status}`);
}

/**
 * The engine's data folder, resolved the way config.ts does it: STUDIO_DATA_DIR, then "dataDir" in
 * config.json, then ~/.studio-engine. An empty or relative value is skipped (the engine refuses
 * it, and the doctor must not stop on it).
 */
export function resolveDataDir(home: string, env: NodeJS.ProcessEnv, config: EngineConfig): string {
  for (const value of [env.STUDIO_DATA_DIR, config.dataDir]) {
    if (typeof value !== 'string' || value === '') continue;
    const expanded = expandHome(value, home);
    if (isAbsolute(expanded)) return expanded;
  }
  return join(home, '.studio-engine');
}

/**
 * A true/false switch, resolved the way config.ts does it: the environment (1, 0, true or false in
 * any case; empty counts as unset), then config.json (a JSON boolean), then `fallback`. A value the
 * engine would refuse is skipped, so the doctor doesn't stop on it (as in resolveDataDir).
 */
function resolveFlag(fromEnv: string | undefined, fromFile: unknown, fallback: boolean): boolean {
  return flagSaid(fromEnv, fromFile) ?? fallback;
}

/** What the environment, then config.json, wrote down for a switch; undefined when neither did. */
function flagSaid(fromEnv: string | undefined, fromFile: unknown): boolean | undefined {
  const word = /^(?:1|0|true|false)$/i.exec(fromEnv ?? '')?.[0];
  if (word !== undefined) return word === '1' || word.toLowerCase() === 'true';
  return typeof fromFile === 'boolean' ? fromFile : undefined;
}

/** The Review switch: STUDIO_REVIEW, then "review" in config.json, then on. */
export function resolveReview(env: NodeJS.ProcessEnv, config: EngineConfig): boolean {
  return resolveFlag(env.STUDIO_REVIEW, config.review, true);
}

/**
 * The Songs switch, resolved the way config.ts does it: STUDIO_SONGS, then "songs" in config.json,
 * then on (U22); `music` is the same for Soundtrack's switch. Songs builds on Soundtrack's record,
 * so it is `on` only when both are. `asked` is true only when songs was written down as on
 * (STUDIO_SONGS=1 or "songs": true): the engine logs, and the doctor says so, when that meets
 * music turned off; with nothing written down, music off just means songs off.
 */
export function resolveSongs(
  env: NodeJS.ProcessEnv,
  config: EngineConfig,
): { asked: boolean; music: boolean; on: boolean } {
  const said = flagSaid(env.STUDIO_SONGS, config.songs);
  const asked = said === true;
  const songs = said ?? true;
  const music = resolveFlag(env.STUDIO_MUSIC, config.music, true);
  return { asked, music, on: songs && music };
}

/** The Generated videos switch, resolved the way config.ts does it: STUDIO_GENERATE, then "generate", then off. */
export function resolveGenerate(env: NodeJS.ProcessEnv, config: EngineConfig): boolean {
  return resolveFlag(env.STUDIO_GENERATE, config.generate, false);
}

/** The Stock media switch, resolved the way config.ts does it: STUDIO_STOCK, then "stock", then off. */
export function resolveStock(env: NodeJS.ProcessEnv, config: EngineConfig): boolean {
  return resolveFlag(env.STUDIO_STOCK, config.stock, false);
}

/** What an ElevenLabs voice id looks like (config.ts checks the same). */
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/**
 * The voice a generated video is made with, resolved the way config.ts does it:
 * STUDIO_GENERATE_VOICE_ID, then "generateVoiceId" in config.json, then the default (Kal Jones). A value
 * the engine would refuse is skipped, so the doctor doesn't stop on it.
 */
export function resolveGenerateVoiceId(env: NodeJS.ProcessEnv, config: EngineConfig): string {
  const fromEnv = (env.STUDIO_GENERATE_VOICE_ID ?? '').trim();
  if (VOICE_ID_PATTERN.test(fromEnv)) return fromEnv;
  const fromFile = typeof config.generateVoiceId === 'string' ? config.generateVoiceId.trim() : '';
  return VOICE_ID_PATTERN.test(fromFile) ? fromFile : DEFAULT_VOICE_ID;
}

/** The programs Songs runs, resolved as config.ts does: STUDIO_YT_DLP / STUDIO_DENO, else Homebrew's. */
export function resolveSongTools(
  home: string,
  env: NodeJS.ProcessEnv,
): { ytDlp: string; deno: string } {
  const pick = (value: string | undefined, fallback: string) => {
    const expanded = value ? expandHome(value, home) : '';
    return isAbsolute(expanded) ? expanded : fallback;
  };
  return {
    ytDlp: pick(env.STUDIO_YT_DLP, DEFAULT_TOOLS.ytDlp),
    deno: pick(env.STUDIO_DENO, DEFAULT_TOOLS.deno),
  };
}

/** The engine's default port, as in config.ts. */
const DEFAULT_PORT = 4310;

/**
 * The engine's port, resolved the way config.ts does it: STUDIO_PORT (digits; empty counts as
 * unset), then "port" in config.json, then 4310. A value the engine would refuse is skipped.
 */
export function resolvePort(env: NodeJS.ProcessEnv, config: EngineConfig): number {
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65_535;
  const fromEnv = /^\d+$/.test(env.STUDIO_PORT ?? '') ? Number(env.STUDIO_PORT) : Number.NaN;
  if (valid(fromEnv)) return fromEnv;
  return typeof config.port === 'number' && valid(config.port) ? config.port : DEFAULT_PORT;
}

/** The parts of `tailscale serve status --json` (ipn.ServeConfig) the check reads. */
interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean } | null>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null> } | null>;
  AllowFunnel?: Record<string, boolean>;
  /** `tailscale serve` without --bg: one config per Terminal it runs in, gone when that closes. */
  Foreground?: Record<string, ServeConfig | null>;
}

const LOOPBACK_TARGETS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether a Serve proxy target (`http://127.0.0.1:4310`, `localhost:4310`, `4310`) is the server on
 * this Mac's loopback at `port`: the engine, or, for {@link DEV_WEB_PORT}, the dev server.
 */
export function proxiesToEngine(proxy: string | undefined, port: number): boolean {
  if (typeof proxy !== 'string' || proxy.trim() === '') return false;
  const target = /^\d+$/.test(proxy) ? `127.0.0.1:${proxy}` : proxy;
  try {
    const url = new URL(target.includes('://') ? target : `http://${target}`);
    return (
      url.protocol === 'http:' &&
      LOOPBACK_TARGETS.has(url.hostname) &&
      url.port === String(port) &&
      (url.pathname === '/' || url.pathname === '')
    );
  } catch {
    return false;
  }
}

/**
 * The Vite dev server (`pnpm dev`). It serves the pages, which the tsx-watch engine does not, and
 * hands `/api` on to the engine, which still checks the tailnet login. Serve may point at it while
 * the app is being developed (docs/reference.md › Open it on your phone).
 */
export const DEV_WEB_PORT = 5173;

/** A `<name>:<port>` entry of a Serve config whose "/" goes to the engine or to the dev server. */
interface ServedEntry {
  hostPort: string;
  /** What "/" goes to: the engine itself, or the dev server in front of it. */
  target: 'engine' | 'dev';
}

function servedEntries(config: ServeConfig, port: number): ServedEntry[] {
  return Object.entries(config.Web ?? {}).flatMap(([hostPort, web]): ServedEntry[] => {
    const proxy = web?.Handlers?.['/']?.Proxy ?? undefined;
    if (proxiesToEngine(proxy, port)) return [{ hostPort, target: 'engine' }];
    if (proxiesToEngine(proxy, DEV_WEB_PORT)) return [{ hostPort, target: 'dev' }];
    return [];
  });
}

/**
 * The verdict on one `tailscale serve status --json` (`null`: no Tailscale CLI found), for the
 * engine on `port`. `bin` is what to type for the CLI in a fix.
 *
 * - Green: https on 443 proxies "/" to the engine (127.0.0.1:<port>), in the background. The same
 *   to the Vite dev server (127.0.0.1:5173) is green too, with a note that it is the dev setup.
 * - Error: Funnel is on for a name that serves the engine or the dev server. Funnel opens it to
 *   the whole internet, where anyone can reach it; Serve keeps it to the owner's own devices.
 * - Warning: Serve is off, serves something else, runs only in a Terminal (no --bg), or Tailscale
 *   is missing or not running. Only the phone needs it, so nothing else stops.
 */
export function tailscaleServeCheck(
  result: { ok: boolean; stdout: string; stderr: string } | null,
  port: number,
  bin = 'tailscale',
): Check {
  const name = 'Tailscale';
  const notes = [
    'Only the phone needs it: https://<mac>.<tailnet>.ts.net through Tailscale Serve.',
  ];
  const serve = serveCommand(port, bin);
  const warn = (detail: string, fix: string): Check => ({
    name,
    ok: true,
    warn: true,
    detail,
    notes,
    fix,
  });
  if (result === null) {
    return warn(
      'not installed',
      `Install Tailscale (https://tailscale.com/download/mac) and sign in, then: ${serve}`,
    );
  }
  if (!result.ok) {
    const why = firstLine(result.stderr) || firstLine(result.stdout) || 'no output';
    return warn(
      `\`tailscale serve status\` failed: ${why}`,
      `Open Tailscale and sign in, then: ${serve}`,
    );
  }
  let config: ServeConfig;
  try {
    const parsed: unknown = JSON.parse(result.stdout || '{}');
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    config = parsed as ServeConfig;
  } catch {
    return warn("couldn't read `tailscale serve status --json`", serve);
  }

  const configs = [config, ...Object.values(config.Foreground ?? {}).filter((c) => c !== null)];
  const funnelled = configs.flatMap((c) =>
    servedEntries(c, port)
      .map((entry) => entry.hostPort)
      .filter((hostPort) => c.AllowFunnel?.[hostPort] === true),
  );
  if (funnelled.length > 0) {
    const [hostPort = ''] = funnelled;
    const publicPort = hostPort.slice(hostPort.lastIndexOf(':') + 1);
    return {
      name,
      ok: false,
      detail: `Funnel is on for ${hostPort}: the engine is open to the whole internet`,
      notes: ['Never use Funnel for Studio Engine. Serve keeps it to your own devices.'],
      fix: `${bin} funnel --https=${publicPort} off && ${serve}`,
    };
  }

  const background = servedEntries(config, port);
  const on443 = background.find((entry) => entry.hostPort.endsWith(':443'));
  if (on443 !== undefined && config.TCP?.['443']?.HTTPS !== false) {
    const host = on443.hostPort.slice(0, -':443'.length);
    if (on443.target === 'engine') {
      return { name, ok: true, detail: `Serve: https://${host} → 127.0.0.1:${port}` };
    }
    return {
      name,
      ok: true,
      detail: `Serve: https://${host} → 127.0.0.1:${DEV_WEB_PORT} (the dev server)`,
      notes: [
        `The dev server (pnpm dev) hands /api on to the engine on ${port}, so this works while you develop.`,
        `For everyday use, run the background agent and point Serve at the engine: ${serve}`,
      ],
    };
  }
  const foreground = configs.slice(1).some((c) => servedEntries(c, port).length > 0);
  if (foreground) {
    return warn('Serve runs only while `tailscale serve` is open in a Terminal', serve);
  }
  if (background.length > 0) {
    const hostPorts = background.map((entry) => entry.hostPort).join(', ');
    return warn(`Serve sends ${hostPorts} to the app, not https on 443`, serve);
  }
  const anything = configs.some(
    (c) => Object.keys(c.Web ?? {}).length > 0 || Object.keys(c.TCP ?? {}).length > 0,
  );
  return anything
    ? warn(`Serve is on, but not for the engine (127.0.0.1:${port})`, serve)
    : warn("Serve is off: the phone can't reach the engine", serve);
}

/** Runs `tailscale serve status --json` with the CLI the engine would find (read only). */
function checkTailscale(env: NodeJS.ProcessEnv, port: number): Check {
  const bin = findTailscale({ pathEnv: env.PATH });
  if (bin === null) return tailscaleServeCheck(null, port);
  const r = spawnSync(bin.path, ['serve', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return tailscaleServeCheck(
    { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' },
    port,
    bin.onPath ? 'tailscale' : bin.path,
  );
}

const countOf = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * money.json is optional: without it every job is the default price and nothing is spent. An
 * invalid one fails the check, because the engine ignores it until it is fixed: it keeps the last
 * good copy it saved (money.last-good.json), and with none Mark delivered is refused. The file is
 * read with the engine's own loader.
 */
export function checkMoney(home: string, env: NodeJS.ProcessEnv): Check {
  const name = 'money.json';
  const dataDir = resolveDataDir(home, env, readConfig(locations(home).config));
  const file = moneyFilePath(dataDir);
  const read = readMoneyFile(file);
  if (read.status === 'missing') {
    return {
      name,
      ok: true,
      detail: `not found (${DEFAULT_PRICE_PER_JOB} per job, no expenses yet)`,
    };
  }
  if (read.status === 'ok') {
    const { subscriptions, charges } = read.money;
    return {
      name,
      ok: true,
      detail: `${countOf(subscriptions.length, 'subscription')}, ${countOf(charges.length, 'charge')}`,
    };
  }
  const [first = 'unreadable', ...rest] = read.issues;
  const hasCopy = readMoneyFile(moneyLastGoodPath(dataDir)).status === 'ok';
  return {
    name,
    ok: false,
    detail: `invalid – ${first}`,
    notes: rest.map((issue) => `also: ${issue}`),
    fix: `Correct ${tilde(file, home)} (see "Money" in docs/reference.md). ${
      hasCopy
        ? 'Until then the engine uses the last good copy it saved (money.last-good.json)'
        : 'There is no good copy saved, so until then the engine uses the defaults and Mark delivered is refused'
    }`,
  };
}

export function runChecks(
  home: string,
  env: NodeJS.ProcessEnv,
  nodeVersion: string,
  envFile: string = ENV_FILE,
): Check[] {
  const config = readConfig(locations(home).config);
  const brew = findExecutable('brew', env.PATH, extraBinDirs(home));
  const ffmpegFix = brew
    ? 'brew install ffmpeg'
    : 'Install Homebrew (https://brew.sh), then: brew install ffmpeg';
  const ffmpegFiltersFix = `${brew ? '' : 'Install Homebrew (https://brew.sh), then: '}${FFMPEG_FULL_FIX}`;
  const filtersCheck = checkFfmpegFilters(home, env.PATH, ffmpegFiltersFix);
  return [
    checkNode(nodeVersion),
    ...checkClaude(
      resolveClaudeBin({ home, pathEnv: env.PATH, configBin: config.claudeBin }),
      home,
    ),
    checkSkill(home),
    checkEditVideoSkill(home),
    checkHyperframesSkills(home),
    checkVideoUseRepo(home),
    checkTool(
      'uv',
      'uv',
      ['--version'],
      'curl -LsSf https://astral.sh/uv/install.sh | sh',
      home,
      env.PATH,
    ),
    checkTool('ffmpeg', 'ffmpeg', ['-version'], ffmpegFix, home, env.PATH),
    ...(filtersCheck ? [filtersCheck] : []),
    checkTool('ffprobe', 'ffprobe', ['-version'], ffmpegFix, home, env.PATH),
    checkChrome(home, env),
    checkHyperframesCli(env, resolveReview(env, config)),
    checkElevenLabsKey(home, env),
    ...songChecks(home, env, config, envFile),
    checkTailscale(env, resolvePort(env, config)),
    checkMoney(home, env),
  ];
}

export function formatReport(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  const lines = ['Studio Engine doctor', ''];
  const indent = `  ${' '.repeat(width)}`;
  for (const c of checks) {
    lines.push(`${c.ok ? (c.warn ? '!' : '✓') : '✗'} ${c.name.padEnd(width)}${c.detail}`);
    for (const note of c.notes ?? []) lines.push(`${indent}${note}`);
    if ((!c.ok || c.warn) && c.fix) lines.push(`${indent}fix: ${c.fix}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  const warnings = checks.filter((c) => c.ok && c.warn).length;
  const withWarning = warnings ? ` (${warnings} with a warning)` : '';
  lines.push('', `${passed} of ${checks.length} checks passed${withWarning}.`);
  return lines.join('\n');
}

if (import.meta.main) {
  const checks = await runAllChecks(homedir(), process.env, process.versions.node);
  const ok = checks.every((c) => c.ok);
  console.log(
    process.argv.includes('--json')
      ? JSON.stringify({ ok, checks }, null, 2)
      : formatReport(checks),
  );
  process.exitCode = ok ? 0 : 1;
}
