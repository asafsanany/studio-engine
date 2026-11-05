// Boots the built Studio Engine server for the e2e run, fully isolated from the real one:
//
//   <tmp>/studio-e2e-XXXX/
//     home/      HOME of the server process, so ~/.studio-engine/config.json and engine.db of the
//                real user are never read or written
//     data/      STUDIO_DATA_DIR (SQLite file, logs)
//     inbox/     STUDIO_INBOX, watched; exports go to inbox/_Exports
//     fixtures/  the small media files the jobs are made of
//     server.log everything the server printed
//
// The server runs `NODE_ENV=production node apps/server/dist/index.js`, so it serves the built
// web app from the same port, with `STUDIO_RUNNER=fake`, a 2 s settle time, and `STUDIO_REVIEW` when
// the caller sets `review` (left out, the engine's own default applies: Review on),
// `STUDIO_SERIES` when it sets `series` (left out, the default applies: Series on),
// `STUDIO_JOB_SHEET` when it sets `jobSheet` (left out, the default applies: the Job sheet is on),
// `STUDIO_PHONE` when it sets `phone` (left out, the default applies: the phone layout is on),
// `STUDIO_ANALYTICS` when it sets `analytics` (left out, the default applies: Analytics on),
// `STUDIO_GRAPHICS` when it sets `graphics` (left out, the default applies: Graphics on) and
// `STUDIO_LUTS` when it sets `luts` (left out, the default applies: LUTs on),
// `STUDIO_FONTS` when it sets `fonts` (left out, the default applies: Fonts on) and
// `STUDIO_MUSIC` for `music` and `STUDIO_SONGS` for `songs`: both are on in the app (U22), and
// left out they are sent as 0, so the specs that are not about music run with them off as they
// always did (`music: 'default'` / `songs: 'default'` sends nothing and lets the engine's own
// default apply; music-default.spec.ts proves it, and the music, songs, versions and phone specs
// say `true`) and
// `STUDIO_QUICK_FIXES` when it sets `quickFixes` (left out, the default applies: Quick fixes on;
// `E2E_QUICK_FIXES=0` in the caller's environment turns it off for every engine that does not say,
// to run the other specs with the switch off) and
// `STUDIO_INSTAGRAM` for `instagram`: on in the app (IG15), and left out it is sent as 0, so the
// specs that are not about Instagram run with it off as they always did (with it on, the scans are
// the fake scanner's, the runner being fake: the sample accounts of
// apps/server/src/instagram/sample-accounts.ts, each run of a scan taking 6 s ÷ the fake speed, so
// no Apify key is read and nothing is spent, IG13) and
// `STUDIO_GENERATE` when it sets `generate` (left out, the default applies: Generated videos off;
// with it on, the fake Brief reads a folder with a script and no footage as a generated job and the
// fake Generate run makes its voice, stills and clips with the scripts' own fake path, so nothing
// reaches Higgsfield or ElevenLabs and nothing is spent, GN10).
// `STUDIO_MANUAL_START` and `STUDIO_KNOWN_CLIENTS_ONLY` are 0 unless `manualStart` / `knownClientsOnly`
// say otherwise: the specs drop a client's folder into the inbox and expect its jobs to queue by
// themselves, as before R0 (v0.26.0) made both default on in the engine.
// The phone Review plays a small MP4 the engine makes of the preview (v0.29.0). Under the fake
// runner its render step is a 6 s test-pattern clip (`renderFakePreviewVideo`), made as soon as a job
// reaches Review and shrunk by the real ffmpeg step, so the phone specs find it ready in about a second.
// `STUDIO_GRAPHICS_IN_EDITS`, `STUDIO_FONTS_IN_NOTES` and `STUDIO_LUTS_IN_EDITS` are never set by an
// option here, so the defaults apply: edits use the Graphics library (on, as long as Graphics is on),
// a note can name a font (on, as long as Fonts is on, since FN23) and a note can name a LUT (on, as
// long as LUTs is on, since LU14); a spec that wants any of them off passes it in `env`.
// With `songs` on, the music script's `song` command gets its song from stand-ins instead of YouTube and
// Apify: MUSIC_GET_SONG and MUSIC_TRENDING_PICK name apps/server/src/music/testdata/fake-e2e-songs.mjs (a
// 40 s tone track with a drop at 0:20, a fixed trending pick) and MUSIC_HYPERFRAMES the beat finder's
// stand-in beside it, so nothing touches the network or Apify (SG12). The fake Brief reads a song off a
// picture attached to the note: IMG_4412.PNG is the boards' song, a name with "trend" asks for a
// trending one, "fail" for a song the getter cannot get, "original" for no song (fake-brief.ts).
// The graphic runs are the fake runner's too: a graphic takes about 3 s ÷ `fakeSpeed` to make, and a
// message with the word "fail" in it fails. HOME is the run's temp folder, so a deleted graphic's
// folder (or a deleted font family: Node's `os.homedir()` follows HOME) lands in
// <tmp>/home/.Trash, never in the real Trash.
//
// The run's folder is removed afterwards; `E2E_KEEP=1` keeps it (and prints where) for a look.
// Stopping also checks that no process mentioning the folder (the server, an ffmpeg) is left.

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createJobFolder, type JobFolderOptions, makeMediaFixtures } from './media.ts';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_ENTRY = join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');
const WEB_INDEX = join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html');

/** The stand-ins the song command is pointed at with `songs`: the script's own test hooks (MUSIC_*). */
const SONG_STANDINS = join(REPO_ROOT, 'apps', 'server', 'src', 'music', 'testdata');
const SONG_ENV = {
  MUSIC_GET_SONG: join(SONG_STANDINS, 'fake-e2e-songs.mjs'),
  MUSIC_TRENDING_PICK: join(SONG_STANDINS, 'fake-e2e-songs.mjs'),
  MUSIC_HYPERFRAMES: join(SONG_STANDINS, 'fake-e2e-hyperframes.mjs'),
};

const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;

export interface EngineOptions {
  /** How long a job folder must be quiet before it is queued (`STUDIO_SETTLE_MS`). */
  settleMs: number;
  /** How much faster than the one-minute fake edit to go (`STUDIO_FAKE_SPEED`). */
  fakeSpeed: number;
  /**
   * The Review switch, `STUDIO_REVIEW`: `true` sends 1, `false` sends 0, and leaving it out sends
   * nothing, so the engine's own default applies (on: an edit ends in Review).
   */
  review?: boolean;
  /**
   * The Series switch, `STUDIO_SERIES`: `true` sends 1, `false` sends 0, and leaving it out sends
   * nothing, so the engine's own default applies (on: series work).
   */
  series?: boolean;
  /**
   * The Job sheet switch, `STUDIO_JOB_SHEET`: `true` sends 1, `false` sends 0, and leaving it out
   * sends nothing, so the engine's own default applies (on).
   */
  jobSheet?: boolean;
  /**
   * The Phone switch, `STUDIO_PHONE`: `true` sends 1, `false` sends 0, and leaving it out sends
   * nothing, so the engine's own default applies (on).
   */
  phone?: boolean;
  /**
   * The Analytics switch, `STUDIO_ANALYTICS`: `true` sends 1, `false` sends 0, and leaving it out
   * sends nothing, so the engine's own default applies (on).
   */
  analytics?: boolean;
  /**
   * The Graphics switch, `STUDIO_GRAPHICS`: `true` sends 1, `false` sends 0, and leaving it out
   * sends nothing, so the engine's own default applies (on: the Graphics page and `_Graphics`).
   */
  graphics?: boolean;
  /**
   * The LUTs switch, `STUDIO_LUTS`: `true` sends 1, `false` sends 0, and leaving it out sends
   * nothing, so the engine's own default applies (on: the LUTs page and `_LUTs`).
   */
  luts?: boolean;
  /**
   * The Fonts switch, `STUDIO_FONTS`: `true` sends 1, `false` sends 0, and leaving it out sends
   * nothing, so the engine's own default applies (on: the Fonts page and `/api/fonts`).
   */
  fonts?: boolean;
  /**
   * The Soundtrack switch, `STUDIO_MUSIC`: `true` sends 1, `false` sends 0, and `'default'` sends
   * nothing, so the engine's own default applies (on since U22: music is made only when the job
   * asks for it). Leaving it out sends 0, so a spec that is not about music runs without it (with
   * it on, Review's footer says "without music" and the player's address carries the music's
   * `&m=`, which the other specs' exact texts do not expect).
   */
  music?: boolean | 'default';
  /**
   * The Songs switch, `STUDIO_SONGS`: `true` sends 1 (it takes effect with `music`) and the stand-ins
   * for the song getter, the trending pick and the beat finder (see above), `false` sends 0, and
   * `'default'` sends nothing, so the engine's own default applies (on since U22, with music).
   * Leaving it out sends 0, as for `music`.
   */
  songs?: boolean | 'default';
  /**
   * The Quick fixes switch, `STUDIO_QUICK_FIXES`: `true` sends 1, `false` sends 0, and leaving it
   * out sends nothing, so the engine's own default applies (on since QF9) unless the caller's
   * environment has `E2E_QUICK_FIXES=0`, which turns it off for the specs that do not say.
   */
  quickFixes?: boolean;
  /**
   * The Clients × Instagram switch, `STUDIO_INSTAGRAM`: `true` sends 1, and `false` or leaving it out
   * sends 0 (the app's default is on since IG15; the specs that are not about Instagram keep it off).
   * With it on, the run is the fake one: the scans answer from the sample accounts
   * (`sampleInstagramFixtures`), with no Apify key and no spending (IG13).
   */
  instagram?: boolean;
  /**
   * The Generated videos switch, `STUDIO_GENERATE`: `true` sends 1, `false` sends 0, and leaving it
   * out sends nothing, so the engine's own default applies (off). With it on, the run is the fake
   * one: no key is read and no service is called (GN10).
   */
  generate?: boolean;
  /**
   * Manual start, `STUDIO_MANUAL_START`: off by default here (unlike the engine), so a job queues
   * by itself once its folder is quiet. `true` holds every new job until it is started.
   */
  manualStart?: boolean;
  /**
   * Known clients only, `STUDIO_KNOWN_CLIENTS_ONLY`: off by default here (unlike the engine), so
   * any folder a spec drops at the top of the inbox is a client. `true` detects only added ones.
   */
  knownClientsOnly?: boolean;
  /**
   * More environment for the server process, set after the caller's STUDIO_* settings are stripped
   * (for example `NODE_EXTRA_CA_CERTS`, so the engine trusts the push mock's certificate).
   */
  env?: Record<string, string>;
  /**
   * What to write to `<home>/.studio-engine/config.json` before the server boots (the team specs
   * set `remoteHosts` and `remoteLogins` so the engine answers a Tailscale Serve request). The
   * HOME is the run's own temp folder, so the real config.json is never touched.
   */
  config?: Record<string, unknown>;
}

export interface Engine {
  /** `http://127.0.0.1:<port>`: the API and the web app. */
  baseURL: string;
  /** The watched inbox. */
  inbox: string;
  /** Where finished edits are exported: `<exportsDir>/<Client>/<Job>.mp4`. */
  exportsDir: string;
  /**
   * HOME of the server process: `<home>/.Trash` is where a deleted graphic's folder, a deleted LUT
   * or a deleted font family goes.
   */
  home: string;
  /** Writes a job folder into the inbox. Resolves to the absolute folder. */
  createJob(options: JobFolderOptions): Promise<string>;
  /** The server's output so far. */
  readLog(): Promise<string>;
  /** Stops the server and removes the temp folder; throws when something was left running. */
  stop(): Promise<void>;
}

/** Asks the OS for a free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The environment of the server: the caller's, minus every STUDIO_* setting, plus ours. */
function serverEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The two service keys are left out too: the server needs neither (the Generate run is the fake
    // one), so no real call can be made from here (GN10).
    if (
      !key.startsWith('STUDIO_') &&
      key !== 'HIGGSFIELD_API_KEY' &&
      key !== 'ELEVENLABS_API_KEY'
    ) {
      env[key] = value;
    }
  }
  return { ...env, NODE_ENV: 'production', ...settings };
}

/** Processes whose command line mentions `needle` (ffmpeg, ffprobe or the server itself). */
async function processesMentioning(needle: string): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.includes(needle) && !line.startsWith(`${process.pid} `));
}

export async function startEngine({
  settleMs,
  fakeSpeed,
  review,
  series,
  jobSheet,
  phone,
  analytics,
  graphics,
  luts,
  fonts,
  music = false,
  songs = false,
  quickFixes = process.env.E2E_QUICK_FIXES === '0' ? false : undefined,
  instagram = false,
  generate,
  manualStart = false,
  knownClientsOnly = false,
  env: extraEnv,
  config,
}: EngineOptions): Promise<Engine> {
  for (const [file, what] of [
    [SERVER_ENTRY, 'the server'],
    [WEB_INDEX, 'the web app'],
  ] as const) {
    if (!existsSync(file)) {
      throw new Error(
        `The e2e test needs ${what} built (${file} is missing). Run \`pnpm e2e\`, which builds first, or \`pnpm build\`.`,
      );
    }
  }

  // realpath: on macOS the temp folder sits behind the /var -> /private/var link, and the server
  // and the file watcher must agree on one spelling.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-e2e-')));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const inbox = join(root, 'inbox');
  const exportsDir = join(inbox, '_Exports');
  const fixturesDir = join(root, 'fixtures');
  const logFile = join(root, 'server.log');
  await Promise.all(
    [home, dataDir, inbox, fixturesDir].map((dir) => mkdir(dir, { recursive: true })),
  );

  if (config !== undefined) {
    await mkdir(join(home, '.studio-engine'), { recursive: true });
    await writeFile(join(home, '.studio-engine', 'config.json'), JSON.stringify(config));
  }

  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const env = serverEnv({
    HOME: home,
    STUDIO_DATA_DIR: dataDir,
    STUDIO_INBOX: inbox,
    STUDIO_PORT: String(port),
    STUDIO_HOST: '127.0.0.1',
    STUDIO_SETTLE_MS: String(settleMs),
    STUDIO_RUNNER: 'fake',
    STUDIO_FAKE_SPEED: String(fakeSpeed),
    ...(review === undefined ? {} : { STUDIO_REVIEW: review ? '1' : '0' }),
    ...(series === undefined ? {} : { STUDIO_SERIES: series ? '1' : '0' }),
    ...(jobSheet === undefined ? {} : { STUDIO_JOB_SHEET: jobSheet ? '1' : '0' }),
    ...(phone === undefined ? {} : { STUDIO_PHONE: phone ? '1' : '0' }),
    ...(analytics === undefined ? {} : { STUDIO_ANALYTICS: analytics ? '1' : '0' }),
    ...(graphics === undefined ? {} : { STUDIO_GRAPHICS: graphics ? '1' : '0' }),
    ...(luts === undefined ? {} : { STUDIO_LUTS: luts ? '1' : '0' }),
    ...(fonts === undefined ? {} : { STUDIO_FONTS: fonts ? '1' : '0' }),
    ...(music === 'default' ? {} : { STUDIO_MUSIC: music ? '1' : '0' }),
    ...(songs === 'default' ? {} : { STUDIO_SONGS: songs ? '1' : '0' }),
    ...(songs === true || songs === 'default' ? SONG_ENV : {}),
    ...(quickFixes === undefined ? {} : { STUDIO_QUICK_FIXES: quickFixes ? '1' : '0' }),
    STUDIO_INSTAGRAM: instagram ? '1' : '0',
    // The specs' money reads in shekels; config.json's defaults are for a new install.
    STUDIO_CURRENCY_SYMBOL: '₪',
    STUDIO_USD_TO_HOME: '3.7',
    ...(generate === undefined ? {} : { STUDIO_GENERATE: generate ? '1' : '0' }),
    STUDIO_MANUAL_START: manualStart ? '1' : '0',
    STUDIO_KNOWN_CLIENTS_ONLY: knownClientsOnly ? '1' : '0',
    ...extraEnv,
  });

  const log = openSync(logFile, 'a');
  // A process group of its own, so one signal reaches the server and anything it spawned (ffmpeg).
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', log, log],
    detached: true,
  });
  closeSync(log);

  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  const readLog = (): Promise<string> => readFile(logFile, 'utf8').catch(() => '');

  async function stopServer(): Promise<void> {
    if (exited || child.pid === undefined) return;
    const group = -child.pid;
    try {
      process.kill(group, 'SIGTERM');
    } catch {
      // Already gone.
    }
    const stopped = await Promise.race([
      exit.then(() => true),
      sleep(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!stopped) {
      try {
        process.kill(group, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await exit;
    }
  }

  async function stop(): Promise<void> {
    await stopServer();
    // Nothing of this run may be left behind: not the server, not an ffmpeg it started.
    let leftovers = await processesMentioning(root);
    if (leftovers.length > 0) {
      await sleep(500);
      leftovers = await processesMentioning(root);
    }
    if (process.env.E2E_KEEP) {
      console.log(`E2E_KEEP is set: the run's folder stays at ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
    if (leftovers.length > 0) {
      throw new Error(`Processes of the e2e run are still running:\n${leftovers.join('\n')}`);
    }
  }

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (exited) throw new Error('The server exited while starting.');
      try {
        if ((await fetch(`${baseURL}/api/jobs`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new Error(`The server did not answer within ${BOOT_TIMEOUT_MS} ms.`);
      await sleep(100);
    }

    // Isolation: the server must have read our folders, not the real ~/Studio Inbox or
    // ~/.studio-engine (a real config.json or an environment variable could have moved them).
    const booted = await readLog();
    for (const expected of [inbox, dataDir]) {
      if (!booted.includes(JSON.stringify(expected))) {
        throw new Error(`The server is not using the temp folder ${expected}.\n${booted}`);
      }
    }

    await makeMediaFixtures(fixturesDir);
  } catch (error) {
    const output = await readLog();
    await stop().catch(() => {});
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nServer output:\n${output}`,
    );
  }

  return {
    baseURL,
    inbox,
    exportsDir,
    home,
    createJob: (options) => createJobFolder(inbox, fixturesDir, options),
    readLog,
    stop,
  };
}
