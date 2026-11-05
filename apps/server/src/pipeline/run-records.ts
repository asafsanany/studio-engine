// Which `claude` runs this engine has started and not yet seen end: `<dataDir>/runs/<jobId>.json`.
//
// A run is spawned detached (its own process group), so it outlives an engine that crashes or is
// killed before it could stop it (launchd restarts, `kill -9`). The next boot resumes the same job,
// and two Claude processes would then edit one edit/ folder. So the runner writes a record when it
// spawns and deletes it once the run's tree is gone, and before every run it stops whatever a
// leftover record still points at: the claude process, named by pid *and* start time so a pid the
// system has since given to another program is never touched, and every process carrying the
// run's `STUDIO_ENGINE_RUN` tag, which finds its ffmpeg or Chrome even after claude itself died.
//
// Two jobs can edit at once (Two jobs at once, v0.60.0), so a record in the folder is not always a
// leftover: it can be the other job's run, which this engine started and is still running. The
// records this engine writes are remembered until it deletes them, and a caller that names the
// job about to run (`forJob`) leaves those of other jobs alone.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProcessTree } from './process-tree.js';

export interface RunRecord {
  jobId: string;
  pid: number;
  /** `ps -o lstart=,comm=` of the process when it was spawned. */
  identity: string;
  /** The run's `STUDIO_ENGINE_RUN` value. */
  tag?: string;
  startedAt: string;
}

export function runsDir(dataDir: string): string {
  return join(dataDir, 'runs');
}

/** The records this engine has written and not yet deleted: its own runs that are still going. */
const ownRecords = new Set<string>();

/** Start time and executable of a live process, or `null` if there is none. */
export function processIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], (err, stdout) => {
      const line = stdout?.trim() ?? '';
      resolve(err || line === '' ? null : line);
    });
  });
}

export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${record.jobId}.json`);
  await writeFile(path, `${JSON.stringify(record)}\n`);
  ownRecords.add(path);
}

export async function removeRunRecord(dir: string, jobId: string): Promise<void> {
  const path = join(dir, `${jobId}.json`);
  ownRecords.delete(path);
  await rm(path, { force: true });
}

export interface ReapedRun {
  jobId: string;
  pid: number;
  /** Processes stopped (0 when the record was stale and nothing was running). */
  processes: number;
}

export interface ReapOptions {
  graceMs: number;
  /**
   * The job about to run. Given, the runs this engine started for other jobs and is still running
   * are left alone (two jobs edit at once): only what an earlier engine left, and any run of this
   * job, is stopped. Left out, every record is stopped.
   */
  forJob?: string;
}

/**
 * Stops every run a record still points at and deletes the records, except this engine's own
 * runs of other jobs when `forJob` is given. Returns what was found running. Never throws: a
 * broken record is deleted, a failure to stop is reported by the caller seeing `processes` > 0
 * again next time.
 */
export async function reapStaleRuns(
  dir: string,
  { graceMs, forJob }: ReapOptions,
): Promise<ReapedRun[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const reaped: ReapedRun[] = [];
  for (const name of files) {
    const path = join(dir, name);
    if (forJob !== undefined && name !== `${forJob}.json` && ownRecords.has(path)) continue;
    ownRecords.delete(path);
    try {
      const record = JSON.parse(await readFile(path, 'utf8')) as Partial<RunRecord>;
      const pid = typeof record.pid === 'number' ? record.pid : 0;
      const ours =
        pid > 1 &&
        pid !== process.pid &&
        typeof record.identity === 'string' &&
        (await processIdentity(pid)) === record.identity;
      const tag = typeof record.tag === 'string' && record.tag !== '' ? record.tag : undefined;
      if (ours || tag !== undefined) {
        const tree = new ProcessTree({ rootPid: ours ? pid : undefined, tag });
        const result = await tree.terminate({ graceMs });
        if (result.terminated > 0) {
          reaped.push({ jobId: record.jobId ?? name, pid, processes: result.terminated });
        }
      }
    } catch {
      // Unreadable record: nothing to stop that we could identify safely.
    }
    await rm(path, { force: true });
  }
  return reaped;
}
