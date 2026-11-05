// Reads usage out of Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl and
// the session's subagents/*.jsonl). Each assistant line carries its API call's `message.usage`;
// a call with several content blocks is written once per block with the same `message.id`, so
// calls are counted once, by id. Pure: the caller reads the files.

import type { ModelUsage } from '@studio/shared';

/** The usage between `after` (exclusive; null = from the start) and `until` (inclusive). */
export interface UsageWindow {
  after: string | null;
  until: string;
}

interface Call {
  model: string;
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parse(line: string): Record<string, unknown> | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function callOf(raw: Record<string, unknown>): { id: string; call: Call } | null {
  if (raw.type !== 'assistant') return null;
  const message = raw.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  const model = message?.model;
  // `<synthetic>` lines are the CLI's own messages (errors, interruptions), not API calls.
  if (usage === undefined || typeof model !== 'string' || model === '<synthetic>') return null;
  if (Number.isNaN(at)) return null;
  const id = typeof message?.id === 'string' ? message.id : `${raw.uuid ?? at}`;
  return {
    id,
    call: {
      model,
      at,
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    },
  };
}

/** Tokens by model for the API calls inside `window`, from every line of a session's transcripts. */
export function sumUsage(lines: Iterable<string>, window: UsageWindow): Record<string, ModelUsage> {
  const after = window.after === null ? Number.NEGATIVE_INFINITY : Date.parse(window.after);
  const until = Date.parse(window.until);
  // Last line wins: the final block of a call has its final output count.
  const calls = new Map<string, Call>();
  for (const line of lines) {
    const raw = parse(line);
    const found = raw === null ? null : callOf(raw);
    if (found !== null) calls.set(found.id, found.call);
  }

  const byModel: Record<string, ModelUsage> = {};
  for (const call of calls.values()) {
    if (!(call.at > after && call.at <= until)) continue;
    const sum = byModel[call.model] ?? {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    sum.requests += 1;
    sum.input += call.input;
    sum.output += call.output;
    sum.cacheRead += call.cacheRead;
    sum.cacheWrite += call.cacheWrite;
    byModel[call.model] = sum;
  }
  return byModel;
}

/** True for a line the person typed (or the app sent as a turn), not a tool result or meta line. */
function isPrompt(raw: Record<string, unknown>): boolean {
  if (raw.type !== 'user' || raw.isMeta === true || raw.isSidechain === true) return false;
  const content = (raw.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
  );
}

/** When the last turn of the main transcript began, or null if it has none. */
export function lastPromptAt(lines: Iterable<string>): string | null {
  let last: string | null = null;
  for (const line of lines) {
    const raw = parse(line);
    if (raw !== null && isPrompt(raw) && typeof raw.timestamp === 'string') last = raw.timestamp;
  }
  return last;
}
