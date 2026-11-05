import { describe, expect, it } from 'vitest';
import { lastPromptAt, sumUsage } from './transcript-usage.js';

function call(
  id: string,
  at: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  model = 'claude-opus-5-5',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
      },
    },
  });
}

function user(at: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: at,
    message: { role: 'user', content },
    ...extra,
  });
}

const ALL = { after: null, until: '2026-10-22T23:00:00.000Z' };

describe('sumUsage', () => {
  it('counts a call written once per content block only once, with its last line', () => {
    const lines = [
      call('m1', '2026-10-22T10:00:00.000Z', { input: 3, output: 10, cacheRead: 100 }),
      call('m1', '2026-10-22T10:00:01.000Z', { input: 3, output: 40, cacheRead: 100 }),
      call('m2', '2026-10-22T10:01:00.000Z', { input: 1, output: 5, cacheWrite: 50 }),
    ];
    expect(sumUsage(lines, ALL)).toEqual({
      'claude-opus-5-5': { requests: 2, input: 4, output: 45, cacheRead: 100, cacheWrite: 50 },
    });
  });

  it('splits by model and keeps only the calls inside the window', () => {
    const lines = [
      call('m1', '2026-10-22T09:00:00.000Z', { output: 1 }),
      call('m2', '2026-10-22T10:00:00.000Z', { output: 2 }),
      call('m3', '2026-10-22T10:30:00.000Z', { output: 3 }, 'claude-haiku-5-5'),
      call('m4', '2026-10-22T11:00:00.000Z', { output: 4 }),
    ];
    const window = { after: '2026-10-22T09:00:00.000Z', until: '2026-10-22T10:30:00.000Z' };
    expect(sumUsage(lines, window)).toEqual({
      'claude-opus-5-5': { requests: 1, input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
      'claude-haiku-5-5': { requests: 1, input: 0, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('skips the CLI’s own messages, user lines, torn lines and lines without usage', () => {
    const lines = [
      call('m1', '2026-10-22T10:00:00.000Z', { output: 9 }, '<synthetic>'),
      user('2026-10-22T10:00:00.000Z', 'hello'),
      '{"type":"assistant",',
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-22T10:00:00.000Z', message: {} }),
      '',
    ];
    expect(sumUsage(lines, ALL)).toEqual({});
  });
});

describe('lastPromptAt', () => {
  it('is the last thing the person typed, not a tool result, a meta line or a subagent', () => {
    const lines = [
      user('2026-10-22T10:00:00.000Z', 'first'),
      user('2026-10-22T10:05:00.000Z', [{ type: 'text', text: 'second' }]),
      call('m1', '2026-10-22T10:06:00.000Z', { output: 1 }),
      user('2026-10-22T10:07:00.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      user('2026-10-22T10:08:00.000Z', 'reminder', { isMeta: true }),
      user('2026-10-22T10:09:00.000Z', 'subagent brief', { isSidechain: true }),
    ];
    expect(lastPromptAt(lines)).toBe('2026-10-22T10:05:00.000Z');
  });

  it('is null for a transcript with no prompt', () => {
    expect(lastPromptAt([call('m1', '2026-10-22T10:06:00.000Z', { output: 1 })])).toBeNull();
  });
});
