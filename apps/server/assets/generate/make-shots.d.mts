// Types of make-shots.mjs, the shots script (Generated videos, GN3), for its tests and the doctor.
// The lines it prints match the shared contract (packages/shared/src/domain/generate.ts:
// makeShotsLineSchema); these are only the script's own exports.

export const EXIT: { ok: 0; failed: 1; refused: 2; down: 3 };

export const MESSAGES: {
  balance_empty: string;
  key_rejected: string;
  over_budget: (need: number, budget: number) => string;
  bad_request: string;
  unavailable: string;
  generation_failed: string;
};

export const PENDING_MESSAGE: string;

export const EXIT_FOR: {
  balance_empty: 2;
  key_rejected: 2;
  over_budget: 2;
  unavailable: 3;
  pending: 3;
  bad_request: 1;
  generation_failed: 1;
};

/** What one Higgsfield plan credit is worth in dollars when the engine does not say. */
export const DEFAULT_USD_PER_CREDIT: number;

export const LIMITS: {
  transferTimeoutMs: number;
  maxWaitMs: number;
  pollMs: number;
  pollMaxMs: number;
  uploadMaxAgeMs: number;
  pollFailures: number;
  lockWaitMs: number;
  lockStaleMs: number;
};

export const FILES: { dir: string; spend: string; uploads: string };

export function spendTotal(entries: readonly { usd: number; refunded: boolean }[]): number;

export class ShotsError extends Error {
  code: string;
  detail: string | undefined;
  extra: Record<string, unknown>;
  constructor(code: string, detail?: string, extra?: Record<string, unknown>);
}

export class Pending extends Error {
  requestId: string;
  extra: Record<string, unknown>;
  constructor(requestId: string, extra?: Record<string, unknown>);
}

export function parseArgs(argv: readonly string[]): {
  flag: (name: string) => string | undefined;
  all: (name: string) => string[];
  words: string[];
};

export function settingsOf(env: Record<string, string | undefined>): {
  usdPerCredit: number;
  maxWaitMs: number;
  pollMs: number;
  pollMaxMs: number;
  retryMs: number | undefined;
  httpTimeoutMs: number | undefined;
};

export function idempotencyKey(parts: {
  jobFolder: string;
  kind: string;
  id: string;
  take: number;
  slug: string;
  logical: unknown;
}): string;

export function imageType(bytes: Buffer): { contentType: string; ext: string } | null;

export function findFfprobe(env: Record<string, string | undefined>): string | null;

export function findFfmpeg(env: Record<string, string | undefined>): string | null;

export function probeVideo(
  file: string,
  env: Record<string, string | undefined>,
): { fps: number | null; durationSec: number | null; width: number | null; height: number | null };

export interface ShotsIo {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (text: string) => void;
}

/** Runs one command: the JSON line to print (a key taken out of it) and the exit code. */
export function runShots(
  argv: readonly string[],
  io?: ShotsIo,
): Promise<{ line: Record<string, unknown>; exit: number }>;
