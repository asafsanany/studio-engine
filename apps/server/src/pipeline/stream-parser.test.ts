import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emptySummary,
  parseStreamLine,
  type StreamEvent,
  type StreamSummary,
  summarize,
} from './stream-parser.js';

// The real streams E1 recorded (fixtures/stream/README.md), replayed line by line as the runner
// reads them.
const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

function replay(name: string): { events: StreamEvent[]; summary: StreamSummary; lines: number } {
  const lines = readFileSync(`${FIXTURES}${name}`, 'utf8').split('\n');
  const summary = emptySummary();
  const events: StreamEvent[] = [];
  for (const line of lines) {
    for (const event of parseStreamLine(line)) {
      events.push(event);
      summarize(summary, event);
    }
  }
  return { events, summary, lines: lines.filter((l) => l.trim() !== '').length };
}

function ofKind<K extends StreamEvent['kind']>(events: StreamEvent[], kind: K) {
  return events.filter((e): e is Extract<StreamEvent, { kind: K }> => e.kind === kind);
}

describe('parseStreamLine on the full sample edit (sample-run.jsonl)', () => {
  const { events, summary, lines } = replay('sample-run.jsonl');

  it('parses every line, none left unparsed', () => {
    expect(lines).toBe(249);
    expect(ofKind(events, 'unparsed')).toEqual([]);
  });

  it('reads the init event: tools, permission mode, skills with video-use', () => {
    const [init, ...more] = ofKind(events, 'init');
    expect(more).toEqual([]);
    expect(init).toMatchObject({
      sessionId: '143ff80c-b7b1-4765-a77b-2de4e013424b',
      model: 'claude-opus-5-5',
      permissionMode: 'dontAsk',
    });
    expect([...(init?.tools ?? [])].sort()).toEqual([
      'Bash',
      'Edit',
      'Read',
      'Skill',
      'Task',
      'Write',
    ]);
    expect(init?.skills).toContain('video-use');
  });

  it('turns tool calls into tool_use events, the skill load first', () => {
    const uses = ofKind(events, 'tool_use');
    expect(uses[0]).toMatchObject({
      name: 'Skill',
      input: { skill: 'video-use' },
      parentToolUseId: null,
    });
    expect(uses.length).toBe(summary.toolCalls);
    expect(new Set(uses.map((u) => u.name))).toEqual(
      new Set(['Skill', 'Bash', 'Read', 'Write', 'Agent']),
    );
    // The critic sub-agent's own calls point at its Agent call.
    const agent = uses.find((u) => u.name === 'Agent');
    expect(agent?.input).toMatchObject({ description: 'Critic pass on teaser' });
    expect(uses.some((u) => u.parentToolUseId === agent?.id)).toBe(true);
  });

  it('pairs every tool result with a tool call', () => {
    const ids = new Set(ofKind(events, 'tool_use').map((u) => u.id));
    const results = ofKind(events, 'tool_result');
    expect(results.length).toBeGreaterThan(50);
    for (const result of results) expect(ids.has(result.toolUseId)).toBe(true);
    expect(results[0]).toMatchObject({ isError: false, text: 'Launching skill: video-use' });
    expect(results.filter((r) => r.isError).length).toBeGreaterThan(0);
  });

  it('reads tasks: 8 long Bash commands and one critic sub-agent, all completed', () => {
    const started = ofKind(events, 'task_started');
    expect(started.filter((t) => t.taskType === 'local_bash')).toHaveLength(8);
    expect(started.filter((t) => t.taskType === 'local_agent')).toMatchObject([
      { description: 'Critic pass on teaser' },
    ]);
    const done = ofKind(events, 'task_notification');
    expect(done).toHaveLength(9);
    expect(done.every((t) => t.status === 'completed')).toBe(true);
    expect(ofKind(events, 'task_summary')[0]?.detail).toBe('Checking transcribe helper usage');
  });

  it('ends with one successful result', () => {
    expect(summary.results).toBe(1);
    expect(summary.turns).toBe(41);
    expect(summary.permissionDenials).toBe(0);
    expect(summary.lastResult).toMatchObject({ subtype: 'success', isError: false });
    expect(summary.lastResult?.text).toMatch(
      /^The edit is finished and rendered to `edit\/final\.mp4`/,
    );
    expect(summary.sessionId).toBe('143ff80c-b7b1-4765-a77b-2de4e013424b');
  });

  it('keeps unknown event types as `other` with the raw line', () => {
    const other = ofKind(events, 'other');
    expect(other.some((e) => e.type === 'rate_limit_event')).toBe(true);
    expect(other.some((e) => e.type === 'system' && e.subtype === 'thinking_tokens')).toBe(true);
    expect(other.find((e) => e.type === 'tool_progress')?.raw).toMatchObject({
      tool_name: 'Agent',
    });
  });
});

describe('parseStreamLine on the blocked run (blocked-run.jsonl)', () => {
  const { summary } = replay('blocked-run.jsonl');

  it('ends with result "success" although nothing was delivered', () => {
    expect(summary.results).toBe(1);
    expect(summary.lastResult).toMatchObject({ subtype: 'success', isError: false });
    expect(summary.lastResult?.text).toMatch(/I didn't make `edit\/final\.mp4`/);
    expect(summary.lastResult?.text).toMatch(/To unblock it, install ffmpeg/);
  });
});

describe('parseStreamLine on the background sub-agent probe (subagent-probe.jsonl)', () => {
  const { events, summary } = replay('subagent-probe.jsonl');

  it('sees two init events and two results; the last result is the final word', () => {
    expect(ofKind(events, 'init')).toHaveLength(2);
    expect(summary.results).toBe(2);
    expect(summary.lastResult?.text).toMatch(/^Step 4 finished/);
  });
});

describe('parseStreamLine edge cases', () => {
  it('gives nothing for a blank line', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('   ')).toEqual([]);
  });

  it('keeps a line that is not JSON, or not an object, as unparsed', () => {
    expect(parseStreamLine('Warning: something')).toEqual([
      { kind: 'unparsed', line: 'Warning: something', raw: null },
    ]);
    expect(parseStreamLine('[1,2]')[0]?.kind).toBe('unparsed');
  });

  it('reads permission denials and error results', () => {
    const denied = parseStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'WebFetch',
        tool_use_id: 'toolu_1',
        message: 'Permission denied',
      }),
    );
    expect(denied).toMatchObject([{ kind: 'permission_denied', toolName: 'WebFetch' }]);

    const result = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    );
    expect(result).toMatchObject([
      { kind: 'result', isError: true, text: 'Not logged in · Please run /login' },
    ]);
  });

  it('reads text blocks inside tool results and skips empty assistant text', () => {
    const user = parseStreamLine(
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              is_error: true,
              content: [{ type: 'text', text: 'Exit code 1' }, { type: 'image' }],
            },
          ],
        },
      }),
    );
    expect(user).toMatchObject([{ kind: 'tool_result', isError: true, text: 'Exit code 1' }]);

    const assistant = parseStreamLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } }),
    );
    expect(assistant).toMatchObject([{ kind: 'other', type: 'assistant' }]);
  });
});
