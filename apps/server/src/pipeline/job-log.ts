// The per-job log, `<logsDir>/jobs/<jobId>.log` (architecture §3). Every run appends to it:
//
//   {"type":"studio_engine","event":"start",...}    the runner: mode, binary, flags, prompt
//   ...every stdout line of claude, verbatim...      the stream-json events
//   {"type":"studio_engine","event":"stderr",...}    each stderr line of claude
//   {"type":"studio_engine","event":"end",...}       the runner: exit code, outcome, error
//
// so the whole file stays one JSON object per line (unless claude prints a non-JSON line). The
// `end` marker is how a retry finds the previous attempt's error, which the job row no longer
// has (RETRY clears it). Nothing secret goes in: the child's environment is never written.
//
// The Brief run before each edit (B4, claude-brief.ts) writes to the same log between
// `brief_start` and `brief_end` markers, every marker of it with `"run":"brief"`. They are not
// `start`/`end`, so `readLastEnd` only ever finds an edit run.
//
// A run that ends in Review (an edit run with the Review switch on) records `succeeded` with the
// `preview` it left; "Finished without a preview" records `failed`. So `RunEndOutcome` keeps its
// five values, and `readLastEnd` and the retry prompt work as they did.

import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { JobPreview } from '@studio/shared';

export const MARKER_TYPE = 'studio_engine';

/**
 * How a run ended, as the `end` marker records it. `cancelled` is the user's Cancel; `stopped` is
 * the engine shutting down mid-edit (the job stays `editing` and resumes at the next start).
 * Neither is a failure: a retry after either carries on like a resume.
 */
export type RunEndOutcome = 'succeeded' | 'failed' | 'cancelled' | 'stopped' | 'timed_out';

export interface EndMarker {
  type: typeof MARKER_TYPE;
  event: 'end';
  at: string;
  outcome: RunEndOutcome;
  /** The error shown to the user (failed and timed_out). */
  error?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  sessionId: string | null;
  /** The Claude process, when one was started. */
  pid?: number;
  /** The composition a run left, for a run that ended in Review (W2). */
  preview?: JobPreview;
}

export function jobLogPath(logsDir: string, jobId: string): string {
  return join(logsDir, 'jobs', `${jobId}.log`);
}

/** Appends to one job's log. Writes are buffered; `close()` flushes them. */
export class JobLog {
  readonly path: string;
  private readonly stream: WriteStream;
  private failed: Error | null = null;

  private constructor(path: string, stream: WriteStream) {
    this.path = path;
    this.stream = stream;
    // A full disk or a removed folder must not crash the server; the run itself goes on.
    stream.on('error', (err) => {
      this.failed = err;
    });
  }

  static async open(path: string): Promise<JobLog> {
    await mkdir(dirname(path), { recursive: true });
    return new JobLog(path, createWriteStream(path, { flags: 'a', encoding: 'utf8' }));
  }

  /** The error that stopped writing, if any. */
  get error(): Error | null {
    return this.failed;
  }

  /** One stdout line of claude, exactly as it was written. */
  line(text: string): void {
    if (this.failed || this.stream.destroyed) return;
    this.stream.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** A runner marker line: `{"type":"studio_engine","event":<event>,"at":<now>,...fields}`. */
  marker(event: string, fields: Record<string, unknown> = {}): void {
    this.line(
      JSON.stringify({ type: MARKER_TYPE, event, at: new Date().toISOString(), ...fields }),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.destroyed || this.stream.writableFinished) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
      this.stream.once('error', () => resolve());
    });
  }
}

const END_PREFIX = `{"type":"${MARKER_TYPE}","event":"end"`;

/**
 * The `end` marker of the last run in the log, or `null` when there is none (no log yet, or the
 * engine died mid-run before writing it). Reads the file as a stream: logs can be large.
 */
export async function readLastEnd(path: string): Promise<EndMarker | null> {
  let last: EndMarker | null = null;
  try {
    const lines = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.startsWith(END_PREFIX)) continue;
      try {
        const parsed = JSON.parse(line) as EndMarker;
        if (typeof parsed.outcome === 'string') last = parsed;
      } catch {
        // A line cut short by a crash: skip it.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return last;
}
