import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProcesses } from './process-tree.js';

// C18 (CVP-195): the stand-in `claude` (testdata/stub-claude.mjs) that hangs is spawned detached,
// so a test process that dies mid-run (a test timeout, Ctrl-C, a killed worker) used to leave it
// running for hours. A hanging stub now ends itself, and its tool command, once the process that
// started it is gone.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));

let root: string;
let cwd: string;
let bin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-stub-'));
  cwd = join(root, 'job');
  bin = join(root, 'bin', 'claude');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, bin);
  chmodSync(bin, 0o755);
});

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
});

async function running(pids: number[]): Promise<number[]> {
  const table = await listProcesses();
  return table.filter((proc) => pids.includes(proc.pid)).map((proc) => proc.pid);
}

/** Starts the stub from a short-lived parent that exits once the stub is up, like a killed test. */
function startFromParentThatExits(): Promise<void> {
  const parent = `
    const { spawn } = require('node:child_process');
    const { existsSync } = require('node:fs');
    const stub = spawn(${JSON.stringify(bin)}, [], {
      cwd: ${JSON.stringify(cwd)},
      detached: true,
      stdio: 'ignore',
    });
    stub.unref();
    setInterval(() => {
      if (existsSync('stub-claude.call.json')) process.exit(0);
    }, 20);
    setTimeout(() => process.exit(1), 10000).unref();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', parent], { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`the parent exited with ${code}`)),
    );
  });
}

describe('a hanging stub', () => {
  it('ends itself and its tool command when the process that started it is gone', async () => {
    writeFileSync(
      join(cwd, 'stub-claude.json'),
      JSON.stringify({ hang: true, ignoreTerm: true, grandchild: 'stubborn' }),
    );

    await startFromParentThatExits();
    expect(existsSync(join(cwd, 'stub-claude.call.json'))).toBe(true);
    const call = JSON.parse(readFileSync(join(cwd, 'stub-claude.call.json'), 'utf8')) as {
      pid: number;
      grandchild: number;
    };
    leftovers.push(call.pid, call.grandchild);

    let alive = await running([call.pid, call.grandchild]);
    for (let i = 0; i < 60 && alive.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      alive = await running([call.pid, call.grandchild]);
    }
    expect(alive).toEqual([]);
  });
});
