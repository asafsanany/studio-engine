// The limits log: <dataDir>/limits.jsonl, one LimitSnapshot (@studio/shared › analytics.ts) per
// line, for the Analytics page's "Busiest week". Every Claude run's stream carries
// `rate_limit_event`s, whose `rate_limit_info` says how much of the five-hour and the weekly limit
// is used and when each resets:
//
//   {"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.4,"resetsAt":1792614000},
//                                          "seven_day":{"utilization":0.17,"resetsAt":1792864800}}}
//
// `appendLimits` (called from claude-process.ts for every run kind) writes a line only when the
// reading differs from the last line, and never throws: a log that cannot be written must never
// disturb a run. `backfillLimits` fills the file once, on the first start, from the events the run
// logs already hold. `readLimits` skips lines it cannot read.

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type LimitSnapshot, type LimitWindow, limitSnapshotSchema } from '@studio/shared';

export const LIMITS_LOG_FILE = 'limits.jsonl';

export function limitsLogPath(dataDir: string): string {
  return join(dataDir, LIMITS_LOG_FILE);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A reset time as an ISO timestamp: the CLI writes epoch seconds (milliseconds are read too). */
function resetIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * One limit window of a `rate_limit_info`: from `unifiedWindows`, else, when the event is about
 * that very limit (`rateLimitType`), from the event's own `utilization` and `resetsAt`. A refusal
 * that says nothing of the use means all of it is used.
 */
function windowOf(info: Json, key: 'five_hour' | 'seven_day', status: string): LimitWindow | null {
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  const inWindows = windows[key];
  const ofThisLimit = info.rateLimitType === key;
  const own = isRecord(inWindows) ? inWindows : ofThisLimit ? info : null;
  if (own === null) return null;
  const resetsAt = resetIso(own.resetsAt);
  const refused = own === info && status === 'rejected';
  const utilization =
    typeof own.utilization === 'number' && own.utilization >= 0
      ? own.utilization
      : refused
        ? 1
        : null;
  return resetsAt === null || utilization === null ? null : { utilization, resetsAt };
}

/**
 * A reading from an event's `rate_limit_info`, taken at `at`. `null` for something that is not a
 * reading (no status).
 */
export function snapshotOf(info: unknown, at: Date): LimitSnapshot | null {
  if (!isRecord(info) || typeof info.status !== 'string' || info.status === '') return null;
  return {
    at: at.toISOString(),
    status: info.status,
    fiveHour: windowOf(info, 'five_hour', info.status),
    sevenDay: windowOf(info, 'seven_day', info.status),
  };
}

function sameWindow(a: LimitWindow | null, b: LimitWindow | null): boolean {
  if (a === null || b === null) return a === b;
  return a.utilization === b.utilization && a.resetsAt === b.resetsAt;
}

/** Whether two readings say the same, whenever they were taken. */
function sameReading(a: LimitSnapshot, b: LimitSnapshot): boolean {
  return (
    a.status === b.status &&
    sameWindow(a.fiveHour, b.fiveHour) &&
    sameWindow(a.sevenDay, b.sevenDay)
  );
}

function parseLine(line: string): LimitSnapshot | null {
  try {
    const parsed = limitSnapshotSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The lines of a limits log that can be read, in file order (which is the order they were written). */
export function parseLimitsLog(text: string): LimitSnapshot[] {
  const snapshots: LimitSnapshot[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const snapshot = parseLine(line);
    if (snapshot !== null) snapshots.push(snapshot);
  }
  return snapshots;
}

export async function readLimits(dataDir: string): Promise<LimitSnapshot[]> {
  try {
    return parseLimitsLog(await readFile(limitsLogPath(dataDir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** A line is about 300 bytes; the end of the file is enough to find the last one. */
const TAIL_BYTES = 8192;

/** The last line written (`null` when there is none or it cannot be read), and whether the file ends on a newline. */
async function tailOf(path: string): Promise<{ last: LimitSnapshot | null; newline: boolean }> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { last: null, newline: true };
    throw err;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    const lastLine = [...lines].reverse().find((line) => line.trim() !== '');
    return {
      last: lastLine === undefined ? null : parseLine(lastLine),
      newline: length === 0 || buffer[length - 1] === 0x0a,
    };
  } finally {
    await file.close();
  }
}

export interface AppendLimitsOptions {
  /**
   * Also write a reading that says what the last line says when that line is older than this many
   * milliseconds, so "last read at" moves on while nothing changes. The plan probe sets it; the
   * runs do not (a run's many identical events are one line).
   */
  refreshAfterMs?: number;
}

async function appendNow(
  dataDir: string,
  info: unknown,
  at: Date,
  { refreshAfterMs }: AppendLimitsOptions,
): Promise<boolean> {
  const snapshot = snapshotOf(info, at);
  if (snapshot === null) return false;
  const path = limitsLogPath(dataDir);
  const { last, newline } = await tailOf(path);
  const lastAt = last === null ? Number.NaN : Date.parse(last.at);
  const stale =
    refreshAfterMs !== undefined && !Number.isNaN(lastAt) && at.getTime() - lastAt > refreshAfterMs;
  if (last !== null && sameReading(last, snapshot) && !stale) return false;
  // A crash in the middle of a line leaves one without its newline: the new line starts afresh.
  await appendFile(path, `${newline ? '' : '\n'}${JSON.stringify(snapshot)}\n`);
  return true;
}

// Runs overlap (an edit, a style pass), so the appends go one after the other: each compares with
// the line the one before it wrote.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Logs the `rate_limit_info` of a `rate_limit_event`, read at `at`, when it differs from the last
 * line of <dataDir>/limits.jsonl (the time does not count). Never throws; resolves to whether a
 * line was written (`options.refreshAfterMs`: also when it says the same but the last line is
 * older than that).
 */
export function appendLimits(
  dataDir: string,
  info: unknown,
  at: Date,
  options: AppendLimitsOptions = {},
): Promise<boolean> {
  const done = queue.then(() => appendNow(dataDir, info, at, options)).catch(() => false);
  queue = done;
  return done;
}

async function logFilesOf(logsDir: string): Promise<{ path: string; at: Date }[]> {
  const files: { path: string; at: Date }[] = [];
  for (const folder of ['jobs', 'clients']) {
    const dir = join(logsDir, folder);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ path, at: info.mtime });
    }
  }
  return files.sort((a, b) => a.at.getTime() - b.at.getTime() || a.path.localeCompare(b.path));
}

/** The `rate_limit_info` of every `rate_limit_event` in a run log, in order. */
async function limitInfosOf(path: string): Promise<unknown[]> {
  const infos: unknown[] = [];
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    // Logs are tens of megabytes: only the lines that name the event are parsed.
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && event.type === 'rate_limit_event') infos.push(event.rate_limit_info);
    } catch {
      // Not a stream line (a marker that mentions the event, say).
    }
  }
  return infos;
}

/**
 * The first start with a limits log: when <dataDir>/limits.jsonl does not exist, writes it from
 * the `rate_limit_event`s in the run logs (<logsDir>/jobs/*.log and <logsDir>/clients/*.log),
 * oldest log first, each log's last-change time as the time of its events, a line only when the
 * reading changes. The file is written even when there is nothing to find, so the logs are read
 * once. Resolves to the number of lines written, or `null` when the log already existed.
 */
export async function backfillLimits(options: {
  dataDir: string;
  logsDir: string;
}): Promise<number | null> {
  const path = limitsLogPath(options.dataDir);
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  )
    return null;
  const lines: string[] = [];
  let previous: LimitSnapshot | null = null;
  for (const file of await logFilesOf(options.logsDir)) {
    for (const info of await limitInfosOf(file.path).catch(() => [])) {
      const snapshot = snapshotOf(info, file.at);
      if (snapshot === null || (previous !== null && sameReading(previous, snapshot))) continue;
      lines.push(JSON.stringify(snapshot));
      previous = snapshot;
    }
  }
  await mkdir(options.dataDir, { recursive: true });
  try {
    // `wx`: a run that logged a reading in the meantime keeps its file.
    await writeFile(path, lines.map((line) => `${line}\n`).join(''), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  return lines.length;
}
