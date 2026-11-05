// Turns how a `claude -p` run ended into the one line the Jobs page shows for a failed job.
//
// The rules, in order (docs/reference.md "Running edits" → "When is a run finished?"):
//   1. It could not start: the binary is missing or not executable.
//   2. It ran too long: "Timed out ...".
//   3. It exited 0 without edit/final.mp4: the run stopped on a blocker it could not fix. The
//      prompt asks it to end with a `Blocked: ...` line; that line (or else the last paragraph of
//      its final message) follows "Finished without a final video".
//  3b. It exited 0 on a run that ends in Review (an edit run with the Review switch on) without a
//      valid edit/preview/index.html: "Finished without a preview: <the Blocked line, or what is
//      wrong with the composition>". It uses the Blocked line and never the last paragraph,
//      because the problem says more.
//  3c. When that Blocked line is "Waiting for a camera LUT: …" (LU10), the sentence alone is the error
//      (no "Finished without …" lead), in 3 and in 3b.
//   4. It exited non-zero or was killed: a known cause (not logged in, usage limit, API down,
//      disk full) gets a plain sentence with what to do; otherwise the agent's last error or
//      result text, then stderr, then the exit code.
// Every message is plain text (no Markdown), one line, at most 300 characters.

import { CAMERA_LUT_WAIT_PREFIX } from '@studio/shared';
import type { StreamSummary } from './stream-parser.js';

export const MAX_ERROR_LENGTH = 300;

export const FINISHED_WITHOUT_VIDEO = 'Finished without a final video';

export const FINISHED_WITHOUT_PREVIEW = 'Finished without a preview';

/** The worker's error for a run that said "ok" for a preview but reported none (a runner bug). */
export const PREVIEW_NOT_REPORTED = `${FINISHED_WITHOUT_PREVIEW}: the runner did not report the composition.`;

/** Removes Markdown emphasis, code ticks, headings and links; keeps line breaks. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/** One line, at most `max` characters, cut at a word boundary with an ellipsis. */
export function trimMessage(text: string, max = MAX_ERROR_LENGTH): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The text after the last `Blocked:` line the prompt asks a stuck run to end with. */
export function blockedReason(text: string): string | null {
  const lines = stripMarkdown(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*(?:[-*>]\s*)?blocked\s*:\s*(.+)$/i.exec(lines[i] ?? '');
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

/**
 * Whether a Blocked: reason is the sentence of a job that waits for a camera LUT (LU10:
 * "Waiting for a camera LUT: the clips are Sony S-Log3."). That sentence is the job's whole error,
 * without the "Finished without …" lead, because the page reads it back to find the waiting jobs
 * and to say what is missing (shared/camera-luts.ts).
 */
export function isCameraLutWait(reason: string): boolean {
  return reason.trimStart().toLowerCase().startsWith(CAMERA_LUT_WAIT_PREFIX.toLowerCase());
}

/**
 * The camera-LUT wait sentence when the run's final message ENDS with it (its last line is
 * `Blocked: Waiting for a camera LUT: …`), else null. A run that did the work that does not depend
 * on the camera LUT leaves a composition in edit/preview/ (without the graded cut.mp4), so a valid
 * preview does not mean the job is done: the last line the prompt asks for decides (LU13).
 */
export function endsWaitingForCameraLut(end: RunEnd): string | null {
  const text = end.stream.lastResult?.text ?? end.stream.lastText ?? '';
  const lines = stripMarkdown(text)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  const match = /^\s*(?:[-*>]\s*)?blocked\s*:\s*(.+)$/i.exec(last);
  const reason = match?.[1]?.trim();
  if (reason === undefined || reason === '' || !isCameraLutWait(reason)) return null;
  return trimMessage(reason);
}

/** The last paragraph of a message: where the agent says what is missing. */
export function lastParagraph(text: string): string | null {
  const paragraphs = stripMarkdown(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return paragraphs.at(-1) ?? null;
}

interface KnownCause {
  test: RegExp;
  message: (evidence: string) => string;
}

// Causes outside the edit itself, where the raw text is not something a user can act on. Checked
// against the run's error text and stderr when the process failed.
const KNOWN_CAUSES: readonly KnownCause[] = [
  {
    test: /no space left on device|\bENOSPC\b|disk (?:is )?full/i,
    message: () => 'The disk is full (no space left on device). Free up some space, then retry.',
  },
  {
    test: /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|\b401\b.*unauthori[sz]ed/i,
    message: () =>
      'Claude Code is not logged in. Run `pnpm run doctor` for the login command, then retry.',
  },
  {
    test: /usage limit|hit your limit|limit reached|rate_limit_error|\b429\b/i,
    message: (evidence) => `Claude usage limit reached. Retry once it resets. (${evidence})`,
  },
  {
    test: /overloaded|\b5\d\d\b.*(?:error|api)|api error|connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i,
    message: (evidence) =>
      `Claude's service could not be reached. Retry in a few minutes. (${evidence})`,
  },
];

export interface RunEnd {
  /** The process could not be started (spawn error code, e.g. ENOENT). */
  spawnError?: { code: string | undefined; message: string; bin: string } | undefined;
  /** Set when the runner stopped the run at its time limit. */
  timedOutAfterMs?: number;
  exitCode: number | null;
  signal: string | null;
  /** The last lines the process wrote to stderr. */
  stderr: string;
  stream: StreamSummary;
}

function firstText(...candidates: (string | null | undefined)[]): string | null {
  for (const text of candidates) {
    if (typeof text === 'string' && text.trim() !== '') return text;
  }
  return null;
}

/** The error to show for a run that did not deliver `edit/final.mp4`. */
export function describeFailure(end: RunEnd): string {
  if (end.spawnError) {
    const { code, message, bin } = end.spawnError;
    if (code === 'ENOENT') {
      return trimMessage(`Claude Code was not found at ${bin}. Run \`pnpm run doctor\`.`);
    }
    if (code === 'EACCES') {
      return trimMessage(
        `Claude Code at ${bin} cannot be run (not executable). Run \`pnpm run doctor\`.`,
      );
    }
    return trimMessage(`Claude Code could not be started: ${message}`);
  }

  if (end.timedOutAfterMs !== undefined) {
    return `Timed out after ${formatLimit(end.timedOutAfterMs)}: the edit took longer than the run limit (runTimeoutMin).`;
  }

  const result = end.stream.lastResult;

  if (end.exitCode === 0) {
    const text = result?.text ?? end.stream.lastText ?? '';
    const reason = blockedReason(text) ?? lastParagraph(text);
    if (reason !== null && isCameraLutWait(reason)) return trimMessage(reason);
    return trimMessage(
      reason ? `${FINISHED_WITHOUT_VIDEO}: ${reason}` : `${FINISHED_WITHOUT_VIDEO}.`,
    );
  }

  const errorText = result?.isError ? result.text : null;
  const stderr = end.stderr.trim();
  const evidence = [errorText, stderr].filter((t): t is string => !!t && t.trim() !== '');
  for (const cause of KNOWN_CAUSES) {
    const hit = evidence.find((text) => cause.test.test(text));
    if (hit !== undefined) return trimMessage(cause.message(trimMessage(stripMarkdown(hit), 160)));
  }

  const how =
    end.signal !== null ? `was stopped by ${end.signal}` : `stopped with exit code ${end.exitCode}`;
  const detail = firstText(
    errorText,
    lastLines(stderr, 3),
    result?.text,
    end.stream.lastToolError,
    end.stream.lastText,
  );
  return trimMessage(
    detail ? `Claude Code ${how}: ${stripMarkdown(detail)}` : `Claude Code ${how}.`,
  );
}

/**
 * The error for a run that exited 0 without a valid edit/preview/index.html: its Blocked: line,
 * or else what is wrong with the composition (`problem`, from readPreview).
 */
export function describeMissingPreview(end: RunEnd, problem: string): string {
  const text = end.stream.lastResult?.text ?? end.stream.lastText ?? '';
  const blocked = blockedReason(text);
  if (blocked !== null && isCameraLutWait(blocked)) return trimMessage(blocked);
  return trimMessage(`${FINISHED_WITHOUT_PREVIEW}: ${blocked ?? problem}`);
}

function formatLimit(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes} min` : `${Math.round(ms / 1000)} s`;
}

function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-count)
    .join(' ');
}
