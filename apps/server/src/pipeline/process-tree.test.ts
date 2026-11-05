import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  descendantsOf,
  listProcesses,
  listTagged,
  type ProcessInfo,
  ProcessTree,
  RUN_TAG_VAR,
} from './process-tree.js';
import { processIdentity, reapStaleRuns, writeRunRecord } from './run-records.js';

// Real processes: a node "parent" in its own process group (as the runner spawns claude) that
// starts a `sleep` in yet another group (as Claude Code's Bash tool does).

const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});

const PARENT = `
const { spawn } = require('node:child_process');
const stubborn = process.argv[1] === 'stubborn';
if (stubborn) process.on('SIGTERM', () => {});
const cmd = stubborn ? 'trap "" TERM; exec sleep 300' : 'exec sleep 300';
const child = spawn('/bin/bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
console.log(child.pid);
setInterval(() => {}, 1000);
`;

async function spawnTree(
  mode: 'plain' | 'stubborn',
  tag?: string,
): Promise<{ parent: ChildProcess; grandchild: number }> {
  const parent = spawn(process.execPath, ['-e', PARENT, mode], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: tag === undefined ? process.env : { ...process.env, [RUN_TAG_VAR]: tag },
  });
  const grandchild = await new Promise<number>((resolve, reject) => {
    parent.stdout?.once('data', (data) => resolve(Number(String(data).trim())));
    parent.once('error', reject);
  });
  started.push(parent.pid as number, grandchild);
  // Let bash exec into sleep, so the tree looks like a running tool command.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { parent, grandchild };
}

async function alive(pids: number[]): Promise<ProcessInfo[]> {
  const table = await listProcesses();
  return table.filter((proc) => pids.includes(proc.pid));
}

describe('descendantsOf', () => {
  it('walks the tree by parent pid', () => {
    const table: ProcessInfo[] = [
      { pid: 10, ppid: 1, pgid: 10, command: 'claude' },
      { pid: 11, ppid: 10, pgid: 11, command: 'bash' },
      { pid: 12, ppid: 11, pgid: 11, command: 'ffmpeg' },
      { pid: 20, ppid: 1, pgid: 20, command: 'other' },
    ];
    expect(descendantsOf(10, table).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(descendantsOf(99, table)).toEqual([]);
  });
});

describe('listProcesses', () => {
  it('sees this process with its group', async () => {
    const self = (await listProcesses()).find((proc) => proc.pid === process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.pgid).toBeGreaterThan(0);
  });
});

describe('ProcessTree.terminate', () => {
  it('stops the root and a grandchild in another process group with SIGTERM', async () => {
    const { parent, grandchild } = await spawnTree('plain');
    const tree = new ProcessTree({ rootPid: parent.pid as number });
    const sampled = await tree.sample();
    expect(sampled.map((p) => p.pid).sort()).toEqual([parent.pid, grandchild].sort());
    expect(sampled.find((p) => p.pid === grandchild)?.pgid).toBe(grandchild);

    const result = await tree.terminate({ graceMs: 5_000 });
    expect(result).toMatchObject({ terminated: 2, killed: 0, survivors: [] });
    expect(await alive([parent.pid as number, grandchild])).toEqual([]);
  });

  it('SIGKILLs what ignores SIGTERM once the grace period is over', async () => {
    const { parent, grandchild } = await spawnTree('stubborn');
    const tree = new ProcessTree({ rootPid: parent.pid as number });
    const t0 = Date.now();
    const result = await tree.terminate({ graceMs: 400 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(result).toMatchObject({ terminated: 2, killed: 2, survivors: [] });
    expect(await alive([parent.pid as number, grandchild])).toEqual([]);
  });

  it('still stops a grandchild whose parent died first (re-parented to launchd)', async () => {
    const { parent, grandchild } = await spawnTree('plain');
    const tree = new ProcessTree({ rootPid: parent.pid as number });
    await tree.sample();
    process.kill(parent.pid as number, 'SIGKILL');
    await new Promise((resolve) => parent.once('exit', resolve));
    expect((await alive([grandchild]))[0]?.ppid).toBe(1);

    const result = await tree.terminate({ graceMs: 2_000 });
    expect(result.terminated).toBe(1);
    expect(await alive([grandchild])).toEqual([]);
  });

  it('finds an orphan no sample ever saw by the run tag in its environment', async () => {
    const tag = randomUUID();
    // A process that starts a detached sleep and exits at once: the sleep is re-parented to
    // launchd before anyone could see whose child it was.
    const starter = spawn(
      '/bin/bash',
      [
        '-c',
        `${process.execPath} -e "require('child_process').spawn('sleep',['300'],{detached:true,stdio:'ignore'}).unref()"`,
      ],
      { env: { ...process.env, [RUN_TAG_VAR]: tag }, stdio: 'ignore' },
    );
    await new Promise((resolve) => starter.once('exit', resolve));
    const tagged = [...(await listTagged(tag))];
    expect(tagged).toHaveLength(1);
    started.push(...tagged);
    expect((await alive(tagged))[0]).toMatchObject({
      ppid: 1,
      command: expect.stringMatching(/sleep$/),
    });

    const tree = new ProcessTree({ rootPid: starter.pid as number, tag });
    const result = await tree.terminate({ graceMs: 2_000 });
    expect(result.terminated).toBe(1);
    expect(await alive(tagged)).toEqual([]);
    expect(await listTagged(tag)).toEqual(new Set());
  });

  it('matches the whole tag only', async () => {
    const tag = randomUUID();
    const { parent, grandchild } = await spawnTree('plain', `${tag}x`);
    expect(await listTagged(tag)).toEqual(new Set());
    expect(await listTagged(`${tag}x`)).toEqual(new Set([parent.pid, grandchild]));
  });

  it('is a no-op for a tree that is already gone', async () => {
    const result = await new ProcessTree({ rootPid: 999_999, tag: 'nothing-has-this' }).terminate({
      graceMs: 100,
    });
    expect(result).toEqual({ terminated: 0, killed: 0, survivors: [] });
  });
});

describe('reapStaleRuns', () => {
  it('stops a run a record still points at, by pid and start time, and deletes the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-runs-'));
    try {
      const { parent, grandchild } = await spawnTree('plain');
      const pid = parent.pid as number;
      const identity = await processIdentity(pid);
      expect(identity).not.toBeNull();
      await writeRunRecord(dir, {
        jobId: 'live',
        pid,
        identity: identity as string,
        startedAt: '',
      });
      // A record whose pid now belongs to someone else (here: this test process) is not touched.
      await writeRunRecord(dir, {
        jobId: 'reused',
        pid: process.pid,
        identity: 'Mon Jan 1 node',
        startedAt: '',
      });

      const reaped = await reapStaleRuns(dir, { graceMs: 2_000 });
      expect(reaped).toEqual([{ jobId: 'live', pid, processes: 2 }]);
      expect(await alive([pid, grandchild])).toEqual([]);
      expect(await reapStaleRuns(dir, { graceMs: 100 })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves alone this engine’s own run of another job when it is told the job about to run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-runs-'));
    try {
      // Two jobs edit at once: A's run is going, B's run is about to start.
      const { parent, grandchild } = await spawnTree('plain');
      const pid = parent.pid as number;
      const identity = (await processIdentity(pid)) as string;
      await writeRunRecord(dir, { jobId: 'A', pid, identity, startedAt: '' });

      expect(await reapStaleRuns(dir, { graceMs: 2_000, forJob: 'B' })).toEqual([]);
      expect((await alive([pid, grandchild])).length).toBe(2);

      // Another run of A itself is never right: that one is stopped.
      const reaped = await reapStaleRuns(dir, { graceMs: 2_000, forJob: 'A' });
      expect(reaped).toEqual([{ jobId: 'A', pid, processes: 2 }]);
      expect(await alive([pid, grandchild])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops this engine’s own runs too when it is not told the job about to run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-runs-'));
    try {
      const { parent, grandchild } = await spawnTree('plain');
      const pid = parent.pid as number;
      const identity = (await processIdentity(pid)) as string;
      await writeRunRecord(dir, { jobId: 'A', pid, identity, startedAt: '' });

      expect(await reapStaleRuns(dir, { graceMs: 2_000 })).toEqual([
        { jobId: 'A', pid, processes: 2 },
      ]);
      expect(await alive([pid, grandchild])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops what a crashed run left even when its claude is already gone, by tag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-runs-'));
    try {
      const tag = randomUUID();
      const { parent, grandchild } = await spawnTree('plain', tag);
      const pid = parent.pid as number;
      const identity = (await processIdentity(pid)) as string;
      await writeRunRecord(dir, { jobId: 'crashed', pid, identity, tag, startedAt: '' });
      process.kill(pid, 'SIGKILL');
      await new Promise((resolve) => parent.once('exit', resolve));

      const reaped = await reapStaleRuns(dir, { graceMs: 2_000 });
      expect(reaped).toEqual([{ jobId: 'crashed', pid, processes: 1 }]);
      expect(await alive([grandchild])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
