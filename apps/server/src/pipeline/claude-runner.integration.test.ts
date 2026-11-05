// E3's acceptance on the real thing: headless Claude Code + video-use on a copy of the E1 sample
// job, through E2's queue worker. It spends real tokens and takes ~10 minutes, so it only runs
// with STUDIO_E3_INTEGRATION=1 (never in `pnpm check`):
//
//   STUDIO_E3_INTEGRATION=1 pnpm vitest run apps/server/src/pipeline/claude-runner.integration.test.ts
//
// Needs `pnpm run doctor` all green and the E1 sample at ~/.studio-engine/e1-sample-run. Works in
// ~/.studio-engine/e3-integration/<timestamp>/ (never the real ~/Studio Inbox). Two runs:
//   1. cancel mid-run: once a tool command is running, the worker cancels the job; afterwards no
//      process of the run may be left (found by the run's STUDIO_ENGINE_RUN tag and by pid).
//   2. a full edit that ends `ready`, with a stand-in for E6's export (ffprobe only).

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Job, type JobOutput, SETTLE_MS } from '@studio/shared';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { JobRepository, StepRunRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { extraBinDirs, findExecutable } from './claude-bin.js';
import { ClaudeRunner, type RunnerLogger, type TrackedRun } from './claude-runner.js';
import { jobLogPath } from './job-log.js';
import { listProcesses, listTagged, type ProcessInfo } from './process-tree.js';
import type { StreamEvent } from './stream-parser.js';
import { type Finalize, QueueWorker } from './worker.js';

const ENABLED = process.env.STUDIO_E3_INTEGRATION === '1';
const HOME = homedir();
const SAMPLE_CLIP = join(HOME, '.studio-engine', 'e1-sample-run', 'Launch teaser', 'clip-01.mp4');
const BASE = join(
  HOME,
  '.studio-engine',
  'e3-integration',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const inboxPath = join(BASE, 'inbox');
const dataDir = join(BASE, 'data');
const logsDir = join(dataDir, 'logs');
const CLIENT = 'Acme Studio';

const log = (...args: unknown[]) => console.log('[e3]', ...args);
const logger: RunnerLogger = {
  info: (obj, msg) => log(msg, JSON.stringify(obj)),
  warn: (obj, msg) => log('WARN', msg, JSON.stringify(obj)),
  error: (obj, msg) => log('ERROR', msg, JSON.stringify(obj)),
};

function makeJobFolder(name: string): void {
  const dir = join(inboxPath, CLIENT, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(SAMPLE_CLIP, join(dir, 'clip-01.mp4'));
}

/** The engine around the runner: in-memory DB, E2's worker, a stand-in finalize. */
function engine(track?: (run: TrackedRun) => { onEvent(event: StreamEvent): void }) {
  const clock = fakeClock(new Date(Date.now() - 2 * SETTLE_MS).toISOString());
  const db = memoryDb();
  const jobs = new JobRepository(db, { clock });
  const stepRuns = new StepRunRepository(db, { clock });
  const runner = new ClaudeRunner({
    config: { inboxPath, logsDir, dataDir, claudeBin: 'claude', model: 'opus', runTimeoutMin: 60 },
    logger,
    track,
  });
  const ffprobe =
    findExecutable('ffprobe', process.env.PATH, extraBinDirs(HOME))?.path ?? 'ffprobe';
  // E6 is not built yet: describe edit/final.mp4 the way it will, without copying it anywhere.
  const finalize: Finalize = async (job) => {
    const file = join(inboxPath, job.relPath, 'edit', 'final.mp4');
    const { stdout } = await execa(ffprobe, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    const probe = JSON.parse(stdout) as {
      format: { duration: string; size: string };
      streams: { codec_type: string; width?: number; height?: number }[];
    };
    const video = probe.streams.find((s) => s.codec_type === 'video');
    return {
      fileName: `${job.relPath}.mp4`,
      durationSec: Number(probe.format.duration),
      width: video?.width ?? 1,
      height: video?.height ?? 1,
      sizeBytes: Number(probe.format.size),
    } satisfies JobOutput;
  };
  const changes: Job[] = [];
  const worker = new QueueWorker({
    jobs,
    stepRuns,
    runner,
    finalize,
    logger,
    onJobChanged: (job) => changes.push(job),
  });

  function enqueue(name: string): string {
    const { job } = jobs.upsertFromScan(
      makeScan(CLIENT, name, {
        inputs: { video: 1, audio: 0, image: 0, doc: 0 },
        sizeBytes: 11_496_074,
        footageSec: 15.3,
      }),
    );
    clock.tick(SETTLE_MS);
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    return job.id;
  }

  return { db, jobs, worker, enqueue, changes };
}

function runTagOf(jobId: string): string {
  const start = readFileSync(jobLogPath(logsDir, jobId), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine","event":"start"'))
    .map((line) => JSON.parse(line) as { runTag: string })
    .at(-1);
  if (!start) throw new Error('no start marker yet');
  return start.runTag;
}

async function poll<T>(what: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!ENABLED)('E3 integration: real claude -p with video-use', () => {
  it('prerequisites: the E1 sample clip exists', () => {
    expect(existsSync(SAMPLE_CLIP)).toBe(true);
    log('working in', BASE);
  });

  it('cancel mid-run leaves no process of the run behind', { timeout: 10 * 60_000 }, async () => {
    makeJobFolder('Launch teaser (cancel)');
    let toolRunning: string | null = null;
    const { worker, enqueue, jobs, db } = engine(() => ({
      onEvent(event) {
        if (event.kind === 'tool_use') {
          const command = String(event.input.command ?? event.input.skill ?? '');
          log('tool', event.name, command.slice(0, 120).replace(/\s+/g, ' '));
          if (
            event.name === 'Bash' &&
            /transcribe|ffmpeg|ffprobe|render|hyperframes|uv /.test(command)
          ) {
            toolRunning = command.slice(0, 80);
          }
        }
      },
    }));
    const id = enqueue('Launch teaser (cancel)');
    const t0 = Date.now();
    worker.start();

    // Wait until a real tool command (ffmpeg, the transcribe helper, ...) is running.
    const snapshot = await poll('a running tool command', 5 * 60_000, async () => {
      if (toolRunning === null) return null;
      const tagged = await listTagged(runTagOf(id));
      const table = await listProcesses();
      const procs = table.filter((p) => tagged.has(p.pid));
      return procs.length >= 3 ? procs : null;
    });
    log(
      `cancelling after ${Math.round((Date.now() - t0) / 1000)} s with ${snapshot.length} tagged processes:`,
      snapshot
        .map((p: ProcessInfo) => `${p.pid}/${p.pgid} ${p.command.split('/').pop()}`)
        .join(', '),
    );
    // The tool commands are in process groups other than claude's: the reason for the tag.
    const claudePid = snapshot.find((p) => p.command.endsWith('/claude'))?.pid;
    expect(claudePid).toBeDefined();
    expect(snapshot.some((p) => p.pgid !== claudePid)).toBe(true);

    const c0 = Date.now();
    const job = await worker.cancel(id);
    log(`cancel settled in ${Date.now() - c0} ms; job is ${job?.state} at step ${job?.stoppedAt}`);

    expect(job?.state).toBe('cancelled');
    expect(await listTagged(runTagOf(id))).toEqual(new Set());
    const still = (await listProcesses()).filter((p) => snapshot.some((s) => s.pid === p.pid));
    expect(still).toEqual([]);
    expect(jobs.get(id)?.state).toBe('cancelled');
    await worker.stop();
    db.close();
  });

  it('a full edit of the E1 sample ends ready', { timeout: 60 * 60_000 }, async () => {
    makeJobFolder('Launch teaser');
    let tools = 0;
    const { worker, enqueue, jobs, db } = engine(() => ({
      onEvent(event) {
        if (event.kind === 'tool_use') {
          tools += 1;
          if (tools % 10 === 1) log(`tool #${tools}`, event.name);
        }
        if (event.kind === 'result') log('result', event.subtype, event.text.slice(0, 160));
      },
    }));
    const id = enqueue('Launch teaser');
    const t0 = Date.now();
    worker.start();
    await worker.idle();
    const seconds = Math.round((Date.now() - t0) / 1000);

    const job = jobs.get(id);
    log(
      `run ended after ${seconds} s (${Math.floor(seconds / 60)} min ${seconds % 60} s):`,
      JSON.stringify({
        state: job?.state,
        error: job?.error,
        output: job?.output,
        tools,
      }),
    );
    expect(job?.state).toBe('ready');
    expect(job?.output).toMatchObject({ fileName: `${CLIENT}/Launch teaser.mp4` });
    expect(job?.output?.durationSec).toBeGreaterThan(3);
    expect(await listTagged(runTagOf(id))).toEqual(new Set());
    // Nothing secret in the log.
    const env = readFileSync(join(HOME, 'Developer', 'video-use', '.env'), 'utf8');
    const key = /ELEVENLABS_API_KEY\s*=\s*['"]?([^'"\s]+)/.exec(env)?.[1];
    if (key) expect(readFileSync(jobLogPath(logsDir, id), 'utf8').includes(key)).toBe(false);
    await worker.stop();
    db.close();
  });
});
