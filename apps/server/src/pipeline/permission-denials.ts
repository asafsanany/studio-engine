// What the Brief run was refused (P18 · CVP-133). Under `--permission-mode dontAsk` a command
// outside the allow list is not asked about, it is denied, and the run carries on. A model that
// reads "Permission to use Bash has been denied" as "Bash is off" then writes the brief without
// ever transcribing a voice note, and the run still ends `succeeded`. The engine can't make the
// model try again, but it can say that a denial happened: the collector below reads every sign of
// one in the stream, and claude-brief.ts logs each as a warning and puts them in `brief_end`.
//
// Three places in the stream carry a denial, and a CLI version may write only some of them:
//   - a `system/permission_denied` event: the tool and the message, not what was asked;
//   - a `tool_result` with `is_error` whose text starts "Permission to use <tool> has been denied";
//   - the `result` event's `permission_denials` list: tool, id and the full input.
// They describe the same call, so they are folded by the call's `tool_use_id`, and the input comes
// from the `tool_use` event or the result's list.

import type { StreamEvent } from './stream-parser.js';

/** One refused tool call, as the log and the `brief_end` marker show it. */
export interface PermissionDenial {
  /** `Bash`, `Write`, ... */
  tool: string;
  /** What was asked for, cut short: the Bash command, the file path or the search pattern. */
  detail: string | null;
}

/** Longest `detail` kept, so one odd command can't swell the log line. */
export const DENIAL_DETAIL_CHARS = 300;

/** The text of a denied tool call's result: "Permission to use Bash has been denied because …". */
const DENIED_RESULT = /^Permission to use .+ has been denied/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DENIAL_DETAIL_CHARS ? `${flat.slice(0, DENIAL_DETAIL_CHARS)}…` : flat;
}

/** What a tool call asked for, in a few words: `null` when its input says nothing useful. */
export function describeToolInput(input: unknown): string | null {
  if (!isObject(input)) return null;
  for (const key of ['command', 'file_path', 'path', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return cut(value);
  }
  const keys = Object.keys(input);
  return keys.length === 0 ? null : cut(JSON.stringify(input));
}

interface Seen {
  tool: string;
  input: unknown;
}

/** Folds a run's stream into the list of its denied tool calls, in the order they were seen. */
export class DenialCollector {
  private readonly inputs = new Map<string, { name: string; input: unknown }>();
  private readonly byCall = new Map<string, Seen>();
  /** Denials with no call id to fold on (a malformed stream's `permission_denied`): one each. */
  private readonly anonymous: Seen[] = [];

  onEvent(event: StreamEvent): void {
    switch (event.kind) {
      case 'tool_use':
        if (event.id !== '') this.inputs.set(event.id, { name: event.name, input: event.input });
        break;
      case 'permission_denied':
        this.add(event.toolUseId, event.toolName, undefined);
        break;
      case 'tool_result':
        if (event.isError && event.toolUseId !== '' && DENIED_RESULT.test(event.text)) {
          const tool = /^Permission to use (.+?) has been denied/.exec(event.text)?.[1] ?? '';
          this.add(event.toolUseId, tool, undefined);
        }
        break;
      case 'result': {
        const list = event.raw.permission_denials;
        if (!Array.isArray(list)) break;
        for (const entry of list) {
          if (!isObject(entry)) continue;
          const id = typeof entry.tool_use_id === 'string' ? entry.tool_use_id : null;
          const tool = typeof entry.tool_name === 'string' ? entry.tool_name : '';
          this.add(id, tool, entry.tool_input);
        }
        break;
      }
      default:
        break;
    }
  }

  /** The denials so far; the same call seen in two places is one. */
  denials(): PermissionDenial[] {
    const all = [...this.byCall.entries(), ...this.anonymous.map((s): [string, Seen] => ['', s])];
    return all.map(([id, seen]) => {
      const call = this.inputs.get(id);
      const tool = seen.tool || call?.name || 'unknown tool';
      return { tool, detail: describeToolInput(seen.input ?? call?.input) };
    });
  }

  private add(id: string | null, tool: string, input: unknown): void {
    if (id === null || id === '') {
      this.anonymous.push({ tool, input });
      return;
    }
    const known = this.byCall.get(id);
    if (known === undefined) {
      this.byCall.set(id, { tool, input });
      return;
    }
    // A later sign of the same call can fill what the first one lacked.
    if (known.tool === '' && tool !== '') known.tool = tool;
    if (known.input === undefined && input !== undefined) known.input = input;
  }
}
