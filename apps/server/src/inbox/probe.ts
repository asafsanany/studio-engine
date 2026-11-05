import { execFile } from 'node:child_process';

/**
 * Reads the length of a media file in seconds. Resolves `null` when the length cannot be read
 * (corrupt or half-copied file, not media at all, ffprobe missing): that is not an error.
 */
export type ProbeDuration = (absPath: string) => Promise<number | null>;

export interface FfprobeOptions {
  /** The ffprobe executable. Defaults to `ffprobe`, looked up on PATH. */
  bin?: string;
  /** A probe that takes longer than this counts as unreadable. Default 30 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ffprobe prints a plain decimal such as `12.345000`, or `N/A` when the container has no duration.
const DURATION_OUTPUT = /^\d+(?:\.\d+)?$/;

/** Turns ffprobe's `format=duration` output into seconds, or `null` when it is not a number. */
export function parseDuration(output: string): number | null {
  const text = output.trim();
  return DURATION_OUTPUT.test(text) ? Number(text) : null;
}

/** Builds a prober that runs `ffprobe -show_entries format=duration` on each file. */
export function createFfprobe({
  bin = 'ffprobe',
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FfprobeOptions = {}): ProbeDuration {
  return (absPath) =>
    new Promise((resolve) => {
      execFile(
        bin,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', absPath],
        { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => resolve(error ? null : parseDuration(stdout)),
      );
    });
}

/** What identifies one version of a file: if either value changes, the file is probed again. */
export interface FileSignature {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface DurationCacheOptions {
  /** How many probes may run at once. Default 4. */
  concurrency?: number;
}

interface CacheEntry {
  readonly signature: FileSignature;
  readonly seconds: Promise<number>;
}

/** Runs at most `max` tasks at a time, in the order they were asked for. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      // The slot is handed over by whoever finishes, so `active` stays at `max` meanwhile.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Footage lengths by file, remembered in memory. An entry is reused while the file's path, mtime
 * and size are unchanged, so rescanning a job probes only the files that are new or different.
 * Concurrent asks for the same file share one probe, and probes run a few at a time.
 *
 * A file that cannot be read counts 0 s, and that answer is remembered too: it is asked again once
 * the file changes (for example when a half-copied clip is finished).
 */
export class DurationCache {
  readonly #probe: ProbeDuration;
  readonly #limit: ReturnType<typeof createLimiter>;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(
    probe: ProbeDuration = createFfprobe(),
    { concurrency = 4 }: DurationCacheOptions = {},
  ) {
    this.#probe = probe;
    this.#limit = createLimiter(Math.max(1, Math.floor(concurrency)));
  }

  /** Length of the file in seconds; 0 when it cannot be read. Never rejects. */
  seconds(absPath: string, signature: FileSignature): Promise<number> {
    const cached = this.#entries.get(absPath);
    if (
      cached &&
      cached.signature.mtimeMs === signature.mtimeMs &&
      cached.signature.size === signature.size
    ) {
      return cached.seconds;
    }

    const seconds = this.#limit(async () => {
      try {
        const value = await this.#probe(absPath);
        return value !== null && Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    });
    // Keep only the newest version of each file, so changed files do not pile up.
    this.#entries.set(absPath, {
      signature: { mtimeMs: signature.mtimeMs, size: signature.size },
      seconds,
    });
    return seconds;
  }

  /** Number of files remembered. */
  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

let sharedCache: DurationCache | undefined;

/**
 * The cache the scanner uses when it is not given one: real ffprobe from PATH, shared by every
 * scan in the process so that repeated scans stay cheap.
 */
export function sharedDurationCache(): DurationCache {
  sharedCache ??= new DurationCache();
  return sharedCache;
}
