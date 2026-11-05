// The engine's own lint of a job's live composition, for the checks after a quick fix run
// (verify-quick-fix.ts): `npx hyperframes lint --json edit/preview` from the job folder, the same
// command the run was told to use (hyperframes 0.8.197: exit 0 when there are no errors, 1 when
// there are; warnings do not fail it). The run's own "0 errors" is not taken on its word.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { childEnv } from '../pipeline/claude-command.js';
import { FIX_PREVIEW_PATH } from './quick-fix-files.js';
import type { LintPreview, LintResult } from './verify-quick-fix.js';

/** The longest the lint may take; it takes about a second, so this is for a hung `npx`. */
export const LINT_TIMEOUT_MS = 60_000;

/** The first error in the JSON `hyperframes lint --json` prints (followed by notices that are not JSON), as a few words; null when it is not readable. */
export function firstLintError(stdout: string): string | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const report = JSON.parse(stdout.slice(start, end + 1)) as {
      findings?: { severity?: string; message?: string; code?: string }[];
    };
    const error = report.findings?.find((finding) => finding.severity === 'error');
    if (error === undefined) return null;
    const message = (error.message ?? '').replace(/\s+/g, ' ').trim();
    return message === '' ? (error.code ?? null) : message;
  } catch {
    return null;
  }
}

/**
 * What a finished `hyperframes lint --json` means: exit 0 passes, exit 1 is "the lint found errors"
 * (the first one is the reason), anything else (a signal, a timeout, `npx` not found) is the lint
 * itself not running.
 */
export function lintResultOf(exit: unknown, stdout: string): LintResult {
  if (exit === 0) return { ok: true };
  if (exit !== 1) return { ok: false, why: 'the check of the composition could not run' };
  const first = firstLintError(stdout);
  return {
    ok: false,
    why: first === null ? 'the composition does not pass the lint' : `lint: ${first}`,
  };
}

export interface LintPreviewOptions {
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  timeoutMs?: number;
}

/** The default `LintPreview`: `npx hyperframes lint --json edit/preview` in the job folder. */
export function createLintPreview(options: LintPreviewOptions = {}): LintPreview {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const timeout = options.timeoutMs ?? LINT_TIMEOUT_MS;
  return (jobDir, signal) =>
    new Promise<LintResult>((resolve) => {
      execFile(
        'npx',
        ['hyperframes', 'lint', '--json', FIX_PREVIEW_PATH],
        {
          cwd: jobDir,
          env: childEnv({ home, env }),
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          ...(signal === undefined ? {} : { signal }),
        },
        // `error.code` is the exit status for a command that ran and failed.
        (error, stdout) =>
          resolve(
            lintResultOf(error === null ? 0 : (error as { code?: unknown }).code, String(stdout)),
          ),
      );
    });
}
