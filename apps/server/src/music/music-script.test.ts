import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMusicScriptRunner, musicScriptEnv, redactKeys } from './music-script.js';

// The runner that starts the music script: the real process machinery against small stand-in
// scripts in a temp folder (the real script is exercised in music-service.test.ts).

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-music-script-'));
  temps.push(dir);
  return dir;
}

/** A stand-in script: its source is the body of an ES module. */
function stand(body: string): string {
  const path = join(tempDir(), 'stand-in.mjs');
  writeFileSync(path, body);
  return path;
}

const OK_LINE = `process.stdout.write(JSON.stringify({ ok: true, id: 'v2', lengthMs: 39000 }) + '\\n');`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('redactKeys', () => {
  it('takes an ElevenLabs key out of any text', () => {
    expect(redactKeys('bad key sk_1234567890abcdef, retry')).toBe('bad key sk_…, retry');
    expect(redactKeys('nothing to hide')).toBe('nothing to hide');
  });
});

describe('musicScriptEnv', () => {
  it('is the minimal environment of every child plus the server’s own MUSIC_* settings', () => {
    const env = musicScriptEnv(
      '/Users/owner',
      {
        PATH: '/usr/bin',
        USER: 'owner',
        ANTHROPIC_API_KEY: 'secret',
        ELEVENLABS_API_KEY: 'secret',
        STUDIO_MUSIC: '1',
        MUSIC_API_BASE: 'http://127.0.0.1:9',
        MUSIC_FFMPEG: '/opt/ffmpeg',
        MUSIC_EMPTY: '',
      },
      'music-tag',
    );
    expect(env.HOME).toBe('/Users/owner');
    expect(env.USER).toBe('owner');
    expect(env.STUDIO_ENGINE_RUN).toBe('music-tag');
    expect(env.MUSIC_API_BASE).toBe('http://127.0.0.1:9');
    expect(env.MUSIC_FFMPEG).toBe('/opt/ffmpeg');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(env)).not.toContain('ELEVENLABS_API_KEY');
    expect(Object.keys(env)).not.toContain('STUDIO_MUSIC');
    expect(Object.keys(env)).not.toContain('MUSIC_EMPTY');
  });
});

describe('createMusicScriptRunner', () => {
  it('runs the script with the server’s node, the arguments, and a cwd of its own, and reads its line', async () => {
    const out = tempDir();
    const script = stand(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2] + '/seen.json', JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), node: process.execPath, env: process.env,
      }));
      console.log('chatter before the answer');
      ${OK_LINE}
    `);
    const cwd = tempDir();
    const run = createMusicScriptRunner({
      script,
      cwd,
      home: '/Users/owner',
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'secret',
        ELEVENLABS_API_KEY: 'secret',
        MUSIC_API_BASE: 'http://127.0.0.1:9',
      },
    });

    const outcome = await run({ argv: [out, 'make', '--again'], timeoutMs: 10_000 });

    expect(outcome).toEqual({
      kind: 'ran',
      exitCode: 0,
      signal: null,
      line: { ok: true, id: 'v2', lengthMs: 39_000 },
      stderr: '',
    });
    const seen = JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8'));
    expect(seen.argv).toEqual([out, 'make', '--again']);
    expect(seen.node).toBe(process.execPath);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(cwd));
    expect(seen.env.HOME).toBe('/Users/owner');
    expect(seen.env.MUSIC_API_BASE).toBe('http://127.0.0.1:9');
    expect(seen.env.STUDIO_ENGINE_RUN).toMatch(/^music-/);
    expect(Object.keys(seen.env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(seen.env)).not.toContain('ELEVENLABS_API_KEY');
  });

  it('runs in the OS temp folder, never a job folder, unless told otherwise', async () => {
    const out = tempDir();
    const script = stand(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2] + '/cwd.txt', process.cwd());
      ${OK_LINE}
    `);
    await createMusicScriptRunner({ script })({ argv: [out], timeoutMs: 10_000 });
    expect(realpathSync(readFileSync(join(out, 'cwd.txt'), 'utf8'))).toBe(realpathSync(tmpdir()));
  });

  it('reads a failure line and the exit code', async () => {
    const script = stand(`
      console.log(JSON.stringify({ ok: false, code: 'no_credits', message: 'Credits are used up.' }));
      process.exitCode = 2;
    `);
    const outcome = await createMusicScriptRunner({ script })({ argv: [], timeoutMs: 10_000 });
    expect(outcome).toMatchObject({
      kind: 'ran',
      exitCode: 2,
      line: { ok: false, code: 'no_credits', message: 'Credits are used up.' },
    });
  });

  it('answers a null line, with the end of stderr and no key in it, when the script printed none', async () => {
    const script = stand(`
      console.error('first complaint');
      console.error('boom with sk_abcdef123456');
      process.exitCode = 1;
    `);
    const outcome = await createMusicScriptRunner({ script })({ argv: [], timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ kind: 'ran', exitCode: 1, line: null });
    expect(outcome.kind === 'ran' && outcome.stderr).toBe('first complaint\nboom with sk_…');
  });

  it('says not_started for a node that is not there, and for an argument that cannot be passed', async () => {
    const script = stand(OK_LINE);
    const noNode = await createMusicScriptRunner({ script, node: '/no/such/node' })({
      argv: [],
      timeoutMs: 10_000,
    });
    expect(noNode.kind).toBe('not_started');
    const nul = await createMusicScriptRunner({ script })({ argv: ['a\0b'], timeoutMs: 10_000 });
    expect(nul.kind).toBe('not_started');
  });

  it('stops a script that takes too long, and everything it started', async () => {
    const out = tempDir();
    const script = stand(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      writeFileSync(process.argv[2] + '/pid.txt', String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();
    const outcome = await createMusicScriptRunner({ script, killGraceMs: 200 })({
      argv: [out],
      timeoutMs: 600,
    });
    expect(outcome).toEqual({ kind: 'timed_out' });
    expect(Date.now() - started).toBeLessThan(8_000);
    const pid = Number(readFileSync(join(out, 'pid.txt'), 'utf8'));
    expect(isAlive(pid)).toBe(false);
  });

  it.each([
    ['cancel', 'cancel'],
    ['shutdown', 'shutdown'],
  ] as const)('stops the tree when the signal aborts with %s', async (reason, expected) => {
    const out = tempDir();
    const script = stand(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      writeFileSync(process.argv[2] + '/pid.txt', String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const running = createMusicScriptRunner({ script, killGraceMs: 200 })({
      argv: [out],
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    // Let the script start its child before stopping it.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        try {
          readFileSync(join(out, 'pid.txt'));
          clearInterval(poll);
          resolve();
        } catch {
          // Not yet.
        }
      }, 25);
    });
    controller.abort(reason);

    expect(await running).toEqual({ kind: 'stopped', reason: expected });
    expect(isAlive(Number(readFileSync(join(out, 'pid.txt'), 'utf8')))).toBe(false);
  });

  it('does not start a script for a signal that is already aborted', async () => {
    const out = tempDir();
    const script = stand(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2] + '/ran.txt', 'yes');
    `);
    const controller = new AbortController();
    controller.abort('shutdown');
    const outcome = await createMusicScriptRunner({ script })({
      argv: [out],
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ kind: 'stopped', reason: 'shutdown' });
    expect(() => readFileSync(join(out, 'ran.txt'))).toThrow();
  });

  it('leaves a run that finished before the signal aborted as it was', async () => {
    const script = stand(OK_LINE);
    const controller = new AbortController();
    const outcome = await createMusicScriptRunner({ script })({
      argv: [],
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort('cancel');
    expect(outcome.kind).toBe('ran');
  });
});
