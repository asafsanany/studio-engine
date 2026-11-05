// Parses `claude -p --output-format stream-json --verbose` output, one line at a time, into typed
// events. The shapes are the ones E1 recorded in fixtures/stream/ (Claude Code 2.1.299); anything
// else comes through as `other`, so a newer CLI never breaks a run.
//
// Two consumers: the runner keeps a `StreamSummary` (session, last result, last error) to decide
// how a run ended, and the progress tracker (E4) gets every event through the runner's `track`
// hook. Every event carries `raw`, the parsed line, for anything not lifted into a field.

type Json = Record<string, unknown>;

interface Base {
  /** The parsed JSON line as the CLI wrote it. */
  readonly raw: Json;
}

/** Fields shared by events that can come from a sub-agent (Task/Agent tool). */
interface Nested {
  /** The `Agent` tool call this belongs to, or `null` for the main agent. */
  readonly parentToolUseId: string | null;
}

export type StreamEvent =
  /** `system/init`: written at the start of each turn loop (again after a background sub-agent). */
  | (Base & {
      kind: 'init';
      sessionId: string | null;
      model: string | null;
      cwd: string | null;
      tools: string[];
      skills: string[];
      permissionMode: string | null;
    })
  /** A tool call. The Task tool appears as `Agent`; the skill loads as `Skill {skill: "video-use"}`. */
  | (Base & Nested & { kind: 'tool_use'; id: string; name: string; input: Json })
  /** The result of a tool call, as the model saw it. */
  | (Base & Nested & { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string })
  /** Text the model wrote (not thinking). */
  | (Base & Nested & { kind: 'text'; text: string })
  /** A sub-agent (`taskType` `local_agent`) or a long Bash command (`local_bash`) started. */
  | (Base & {
      kind: 'task_started';
      taskId: string;
      toolUseId: string | null;
      description: string;
      taskType: string | null;
      subagentType: string | null;
    })
  | (Base & {
      kind: 'task_progress';
      taskId: string;
      toolUseId: string | null;
      description: string;
      lastToolName: string | null;
    })
  /** A task ended (`status` is e.g. `completed`). */
  | (Base & {
      kind: 'task_notification';
      taskId: string;
      toolUseId: string | null;
      status: string;
      summary: string;
    })
  /** One line on what the model is doing, e.g. "Reading edit/verify/src_full.png". */
  | (Base & { kind: 'task_summary'; detail: string })
  /** A tool call was refused (`--permission-mode dontAsk`). The run carries on. */
  | (Base & {
      kind: 'permission_denied';
      toolName: string;
      toolUseId: string | null;
      message: string;
    })
  /**
   * The end of a turn loop. A run can write more than one (background sub-agents), and a blocked
   * run also ends with `subtype: "success"`, so this is never by itself the end or the outcome.
   */
  | (Base & {
      kind: 'result';
      subtype: string;
      isError: boolean;
      text: string;
      numTurns: number | null;
      durationMs: number | null;
      sessionId: string | null;
    })
  /** Any other JSON event (`thinking_tokens`, `rate_limit_event`, `tool_progress`, ...). */
  | (Base & { kind: 'other'; type: string; subtype: string | null })
  /** A stdout line that is not a JSON object. Kept so nothing the CLI says is lost. */
  | { kind: 'unparsed'; line: string; raw: null };

export type StreamEventKind = StreamEvent['kind'];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A tool result's `content`: a string, or blocks of which the text ones are kept. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObject)
    .map((block) => (block.type === 'text' ? (str(block.text) ?? '') : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function messageBlocks(raw: Json): Json[] {
  const message = raw.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

function parseSystem(raw: Json, subtype: string | null): StreamEvent {
  switch (subtype) {
    case 'init':
      return {
        kind: 'init',
        raw,
        sessionId: str(raw.session_id),
        model: str(raw.model),
        cwd: str(raw.cwd),
        tools: strings(raw.tools),
        skills: strings(raw.skills),
        permissionMode: str(raw.permissionMode),
      };
    case 'task_started':
      return {
        kind: 'task_started',
        raw,
        taskId: str(raw.task_id) ?? '',
        toolUseId: str(raw.tool_use_id),
        description: str(raw.description) ?? '',
        taskType: str(raw.task_type),
        subagentType: str(raw.subagent_type),
      };
    case 'task_progress':
      return {
        kind: 'task_progress',
        raw,
        taskId: str(raw.task_id) ?? '',
        toolUseId: str(raw.tool_use_id),
        description: str(raw.description) ?? '',
        lastToolName: str(raw.last_tool_name),
      };
    case 'task_notification':
      return {
        kind: 'task_notification',
        raw,
        taskId: str(raw.task_id) ?? '',
        toolUseId: str(raw.tool_use_id),
        status: str(raw.status) ?? '',
        summary: str(raw.summary) ?? '',
      };
    case 'task_summary':
      return { kind: 'task_summary', raw, detail: str(raw.detail) ?? '' };
    case 'permission_denied':
      return {
        kind: 'permission_denied',
        raw,
        toolName: str(raw.tool_name) ?? '',
        toolUseId: str(raw.tool_use_id),
        message: str(raw.message) ?? '',
      };
    default:
      return { kind: 'other', raw, type: 'system', subtype };
  }
}

/**
 * The events in one stdout line. An `assistant` or `user` message can hold several blocks (text,
 * tool calls, tool results), so one line can give several events; a blank line gives none.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [{ kind: 'unparsed', line, raw: null }];
  }
  if (!isObject(raw)) return [{ kind: 'unparsed', line, raw: null }];

  const type = str(raw.type) ?? '';
  const subtype = str(raw.subtype);
  const parentToolUseId = str(raw.parent_tool_use_id);

  switch (type) {
    case 'system':
      return [parseSystem(raw, subtype)];

    case 'assistant': {
      const events: StreamEvent[] = [];
      for (const block of messageBlocks(raw)) {
        if (block.type === 'tool_use') {
          events.push({
            kind: 'tool_use',
            raw,
            parentToolUseId,
            id: str(block.id) ?? '',
            name: str(block.name) ?? '',
            input: isObject(block.input) ? block.input : {},
          });
        } else if (block.type === 'text') {
          const text = str(block.text) ?? '';
          if (text.trim() !== '') events.push({ kind: 'text', raw, parentToolUseId, text });
        }
      }
      return events.length > 0 ? events : [{ kind: 'other', raw, type, subtype }];
    }

    case 'user': {
      const events: StreamEvent[] = [];
      for (const block of messageBlocks(raw)) {
        if (block.type !== 'tool_result') continue;
        events.push({
          kind: 'tool_result',
          raw,
          parentToolUseId,
          toolUseId: str(block.tool_use_id) ?? '',
          isError: block.is_error === true,
          text: contentText(block.content),
        });
      }
      return events.length > 0 ? events : [{ kind: 'other', raw, type, subtype }];
    }

    case 'result':
      return [
        {
          kind: 'result',
          raw,
          subtype: subtype ?? '',
          isError: raw.is_error === true,
          text: str(raw.result) ?? '',
          numTurns: num(raw.num_turns),
          durationMs: num(raw.duration_ms),
          sessionId: str(raw.session_id),
        },
      ];

    default:
      return [{ kind: 'other', raw, type, subtype }];
  }
}

/** What the runner needs to know about a run's stream to judge how it ended. */
export interface StreamSummary {
  /** The session of the last `init`; open it with `claude --resume <id>` in the job folder. */
  sessionId: string | null;
  model: string | null;
  /** Skills the CLI loaded, from the first `init`. */
  skills: string[];
  /** The last `result`: the run's own account of how it went. */
  lastResult: { subtype: string; isError: boolean; text: string } | null;
  results: number;
  turns: number;
  toolCalls: number;
  permissionDenials: number;
  /** Text of the last tool result that was an error (the run usually recovers from these). */
  lastToolError: string | null;
  /** The last thing the main agent wrote, for runs that end without a `result`. */
  lastText: string | null;
}

export function emptySummary(): StreamSummary {
  return {
    sessionId: null,
    model: null,
    skills: [],
    lastResult: null,
    results: 0,
    turns: 0,
    toolCalls: 0,
    permissionDenials: 0,
    lastToolError: null,
    lastText: null,
  };
}

/** Folds one event into the summary (mutates it, for speed on long streams). */
export function summarize(summary: StreamSummary, event: StreamEvent): StreamSummary {
  switch (event.kind) {
    case 'init':
      summary.sessionId = event.sessionId ?? summary.sessionId;
      summary.model = event.model ?? summary.model;
      if (summary.skills.length === 0) summary.skills = event.skills;
      break;
    case 'tool_use':
      summary.toolCalls += 1;
      break;
    case 'tool_result':
      if (event.isError) summary.lastToolError = event.text;
      break;
    case 'text':
      if (event.parentToolUseId === null) summary.lastText = event.text;
      break;
    case 'permission_denied':
      summary.permissionDenials += 1;
      break;
    case 'result':
      summary.results += 1;
      summary.turns += event.numTurns ?? 0;
      summary.sessionId = event.sessionId ?? summary.sessionId;
      summary.lastResult = { subtype: event.subtype, isError: event.isError, text: event.text };
      break;
    default:
      break;
  }
  return summary;
}
