// Stopping a `claude -p` run without leaving anything behind.
//
// The runner spawns claude detached, so claude leads its own process group. That group is not the
// whole tree: Claude Code starts every Bash tool command in a process group of its own (seen in
// E3's probe: bash's pgid is bash's pid, not claude's), and Chrome from HyperFrames gets yet
// another one. SIGTERM to claude's group makes claude kill its tool commands itself, but SIGKILL
// (or claude dying) would leave ffmpeg, python or Chrome running, re-parented to launchd.
//
// So a `ProcessTree` finds the run's processes two ways:
//   - by parent pid: the descendants of the root, sampled now and then while the run is alive;
//   - by tag: the runner puts `STUDIO_ENGINE_RUN=<unique id>` in claude's environment, every
//     process of the run inherits it, and `ps -E` still shows it on a process whose parent is
//     long gone. This also finds what a crashed engine's run left behind.
// `terminate()` signals every group in the tree, root group first: SIGTERM, then SIGKILL after
// the grace period, then waits until none of them is left.
//
// macOS (`ps -A -o pid=,ppid=,pgid=,stat=,comm=` and `ps -A -E -o pid=,command=`). Where `ps -E`
// is not available the tag finds nothing and the parent-pid tracking is all there is.

import { execFile } from 'node:child_process';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** The executable (`comm`), e.g. `/opt/homebrew/bin/ffmpeg`. */
  command: string;
}

/** Every live process on the machine. Zombies (exited, not yet reaped) are left out. */
export function listProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid=,stat=,comm='],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const processes: ProcessInfo[] = [];
        for (const line of stdout.split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const [, pid, ppid, pgid, stat, command] = match;
          if (stat?.startsWith('Z')) continue;
          processes.push({
            pid: Number(pid),
            ppid: Number(ppid),
            pgid: Number(pgid),
            command: (command ?? '').trim(),
          });
        }
        resolve(processes);
      },
    );
  });
}

/** The environment variable the runner tags a run's processes with. */
export const RUN_TAG_VAR = 'STUDIO_ENGINE_RUN';

/** Pids of the live processes whose environment has `STUDIO_ENGINE_RUN=<tag>`. */
export function listTagged(tag: string): Promise<Set<number>> {
  const needle = `${RUN_TAG_VAR}=${tag}`;
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-E', '-o', 'pid=,command='],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        const pids = new Set<number>();
        if (err) {
          resolve(pids);
          return;
        }
        for (const line of stdout.split('\n')) {
          const match = /^\s*(\d+)\s(.*)$/.exec(line);
          if (!match?.[2]) continue;
          const at = match[2].indexOf(needle);
          if (at === -1) continue;
          // Whole word only: `...=abc` must not match `...=abcd`.
          const before = match[2][at - 1];
          const after = match[2][at + needle.length];
          if ((before === undefined || before === ' ') && (after === undefined || after === ' ')) {
            pids.add(Number(match[1]));
          }
        }
        resolve(pids);
      },
    );
  });
}

/** `rootPid` and everything below it, by parent pid. */
export function descendantsOf(rootPid: number, table: readonly ProcessInfo[]): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const proc of table) {
    const list = children.get(proc.ppid);
    if (list) list.push(proc);
    else children.set(proc.ppid, [proc]);
  }
  const root = table.find((proc) => proc.pid === rootPid);
  const found: ProcessInfo[] = root ? [root] : [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Whether the process exists (a zombie counts; use `listProcesses` to tell). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameProcess(a: ProcessInfo, b: ProcessInfo): boolean {
  return a.pid === b.pid && a.pgid === b.pgid && a.command === b.command;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TerminateOptions {
  /** How long the tree gets to exit after SIGTERM before SIGKILL. The runner uses 10 s. */
  graceMs: number;
  /** How long to wait for the tree to disappear after SIGKILL before giving up. */
  killWaitMs?: number;
  /** How often to look while waiting. */
  pollMs?: number;
}

export interface TerminateResult {
  /** Processes that got SIGTERM. */
  terminated: number;
  /** Processes still there after the grace period, which got SIGKILL. */
  killed: number;
  /** Processes still there at the end (should be 0). */
  survivors: ProcessInfo[];
}

export interface ProcessTreeOptions {
  /** The process the runner spawned, a group leader. Left out when it is not ours any more. */
  rootPid?: number;
  /** The run's `STUDIO_ENGINE_RUN` value. */
  tag?: string;
}

/**
 * The processes of one run. Call `sample()` now and then while the run is alive, so a process
 * that leaves the tree (its parent exited, so it was re-parented to launchd) is still known when
 * the run is stopped, even if it dropped the tag.
 */
export class ProcessTree {
  readonly rootPid: number | null;
  readonly tag: string | null;
  private readonly known = new Map<number, ProcessInfo>();
  private readonly ownPid = process.pid;
  private ownPgid: number | null = null;

  constructor({ rootPid, tag }: ProcessTreeOptions) {
    this.rootPid = rootPid !== undefined && rootPid > 1 ? rootPid : null;
    this.tag = tag ?? null;
  }

  /**
   * Records the run's current processes, forgets those that are gone, and returns what is left.
   * `byTag` also scans every process's environment for the tag (about 50 ms), which finds
   * processes no parent pid leads to.
   */
  async sample({ byTag = false }: { byTag?: boolean } = {}): Promise<ProcessInfo[]> {
    const [table, tagged] = await Promise.all([
      listProcesses(),
      byTag && this.tag !== null ? listTagged(this.tag) : Promise.resolve(new Set<number>()),
    ]);
    return this.update(table, tagged);
  }

  /** How many processes the tree has, as of the last sample. */
  get size(): number {
    return this.known.size;
  }

  private update(table: readonly ProcessInfo[], tagged: ReadonlySet<number>): ProcessInfo[] {
    const self = table.find((proc) => proc.pid === this.ownPid);
    if (self) this.ownPgid = self.pgid;
    const live = new Map(table.map((proc) => [proc.pid, proc]));

    // Forget what has exited, or whose pid now belongs to another process.
    for (const [pid, info] of this.known) {
      const now = live.get(pid);
      if (!now || !sameProcess(now, info)) this.known.delete(pid);
    }
    // Everything below the root, anything still in the root's own group, everything tagged.
    if (this.rootPid !== null) {
      for (const proc of descendantsOf(this.rootPid, table)) this.known.set(proc.pid, proc);
    }
    for (const proc of table) {
      if (tagged.has(proc.pid) || (this.rootPid !== null && proc.pgid === this.rootPid)) {
        this.known.set(proc.pid, proc);
      }
    }
    this.known.delete(this.ownPid);
    return [...this.known.values()];
  }

  /** Sends `signal` to every group in the tree (the root's first) and to every process in it. */
  private signalAll(procs: readonly ProcessInfo[], signal: NodeJS.Signals): void {
    const groups = new Set<number>(this.rootPid === null ? [] : [this.rootPid]);
    for (const proc of procs) groups.add(proc.pgid);
    for (const pgid of groups) {
      // Never our own group, nor init's: a tree that somehow shares them is signalled per process.
      if (pgid <= 1 || pgid === this.ownPgid) continue;
      try {
        process.kill(-pgid, signal);
      } catch {
        // The group is already gone.
      }
    }
    for (const proc of procs) {
      if (proc.pid <= 1 || proc.pid === this.ownPid) continue;
      try {
        process.kill(proc.pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Stops the whole tree: SIGTERM to every group and process in it, SIGKILL to what is still
   * there after `graceMs`, and resolves once nothing is left (or `killWaitMs` after SIGKILL).
   * Resolves at once when the tree is already empty.
   */
  async terminate(options: TerminateOptions): Promise<TerminateResult> {
    const { graceMs, killWaitMs = 5_000, pollMs = 150 } = options;
    let remaining = await this.sample({ byTag: true });
    const result: TerminateResult = { terminated: remaining.length, killed: 0, survivors: [] };
    if (remaining.length === 0) return result;

    this.signalAll(remaining, 'SIGTERM');
    const termDeadline = Date.now() + graceMs;
    while (remaining.length > 0 && Date.now() < termDeadline) {
      await sleep(pollMs);
      const before = new Set(this.known.keys());
      remaining = await this.sample({ byTag: true });
      // Something the tree started while it was shutting down gets its SIGTERM too.
      const added = remaining.filter((proc) => !before.has(proc.pid));
      if (added.length > 0) {
        result.terminated += added.length;
        this.signalAll(added, 'SIGTERM');
      }
    }
    if (remaining.length === 0) return result;

    result.killed = remaining.length;
    this.signalAll(remaining, 'SIGKILL');
    const killDeadline = Date.now() + killWaitMs;
    while (remaining.length > 0 && Date.now() < killDeadline) {
      await sleep(pollMs);
      remaining = await this.sample({ byTag: true });
      if (remaining.length > 0) this.signalAll(remaining, 'SIGKILL');
    }
    result.survivors = remaining;
    return result;
  }
}
