// The beat finder of the song measuring (Songs, SG3; moved out of make-music.mjs for SG10, which
// needs it too): `npx hyperframes audio … --json` on a decoded WAV, answered as the beats, downbeats,
// tempo and sections that song-part.mjs's `parseHyperframes` reads. Plain Node, no dependencies.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseHyperframes } from './song-part.mjs';

/** How long the beat finder gets. */
export const HYPERFRAMES_TIMEOUT_MS = 180_000;

/** Variable names that may hold a key. */
const SECRET_NAME = /token|key|secret|password|credential/i;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The program that runs hyperframes: MUSIC_HYPERFRAMES (tests), else npx next to this node, else
 * the one `findTool` finds (`findTool(name, env)`: the script's own lookup).
 */
function hyperframesCommand(env, findTool) {
  if (env.MUSIC_HYPERFRAMES) return { command: env.MUSIC_HYPERFRAMES, args: [] };
  const beside = join(dirname(process.execPath), 'npx');
  return {
    command: isExecutable(beside) ? beside : (findTool('npx', env) ?? 'npx'),
    args: ['--yes', 'hyperframes'],
  };
}

/** Runs a program in its own process group; resolves its output (never rejects). */
function runTool(command, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ status: null, stdout: '', timedOut: false, error: err.message });
      return;
    }
    let stdout = '';
    let timedOut = false;
    let finished = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const finish = (status, error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup();
      done({ status, stdout, timedOut, error });
    };
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (status) => finish(status));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
  });
}

/**
 * The song's beats, downbeats, tempo and sections from `npx hyperframes audio … --json`, as
 * `{ data, why }`: `data` is null (and `why` says in a few words) when the beat finder did not run.
 * `findTool(name, env)` is the caller's lookup for npx; `timeoutMs` defaults to 180 s.
 */
export async function findBeats(wav, env, cwd, { findTool, timeoutMs = HYPERFRAMES_TIMEOUT_MS }) {
  const { command, args } = hyperframesCommand(env, findTool);
  // No key or token reaches it (its environment is the script's, without anything secret-looking).
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => typeof value === 'string' && !SECRET_NAME.test(name),
    ),
  );
  const ran = await runTool(
    command,
    [...args, 'audio', wav, '--only', 'beats,downbeats,bpm,sections', '--json'],
    { cwd, env: childEnv, timeoutMs },
  );
  if (ran.timedOut) return { data: null, why: 'it took too long' };
  if (ran.error) return { data: null, why: 'it could not be started' };
  if (ran.status !== 0) return { data: null, why: `it stopped with ${ran.status}` };
  const data = parseHyperframes(ran.stdout);
  if (data === null) return { data: null, why: 'its answer could not be read' };
  if (data.beatsMs.length === 0 && data.downbeatsMs.length === 0) {
    return { data: null, why: 'it found no beats' };
  }
  return { data, why: null };
}
