import { describe, expect, it } from 'vitest';
import { DENIAL_DETAIL_CHARS, DenialCollector, describeToolInput } from './permission-denials.js';
import { parseStreamLine } from './stream-parser.js';

function collect(lines: object[]): DenialCollector {
  const collector = new DenialCollector();
  for (const line of lines) {
    for (const event of parseStreamLine(JSON.stringify(line))) collector.onEvent(event);
  }
  return collector;
}

const use = (id: string, name: string, input: object) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

describe('describeToolInput', () => {
  it('says what a call asked for: the command, the path or the pattern', () => {
    expect(describeToolInput({ command: 'ls -la' })).toBe('ls -la');
    expect(describeToolInput({ file_path: '/a/b.json', content: 'x' })).toBe('/a/b.json');
    expect(describeToolInput({ pattern: '**/*' })).toBe('**/*');
    expect(describeToolInput({ other: 1 })).toBe('{"other":1}');
  });

  it('is null for an input that says nothing, and cuts a long command short', () => {
    expect(describeToolInput(undefined)).toBeNull();
    expect(describeToolInput({})).toBeNull();
    const long = describeToolInput({ command: `echo ${'x'.repeat(1000)}` });
    expect(long?.length).toBe(DENIAL_DETAIL_CHARS + 1);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('puts a multi-line command on one line', () => {
    expect(describeToolInput({ command: 'a \\\n  | b' })).toBe('a \\ | b');
  });
});

describe('DenialCollector', () => {
  it('has nothing for a run without denials', () => {
    expect(collect([use('t1', 'Bash', { command: 'ls' })]).denials()).toEqual([]);
  });

  it('folds the three signs of one call into one denial', () => {
    const collector = collect([
      use('t1', 'Bash', { command: 'find . | xargs ls' }),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1' },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: 'Permission to use Bash has been denied because …',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'find . | xargs ls' } },
        ],
      },
    ]);
    expect(collector.denials()).toEqual([{ tool: 'Bash', detail: 'find . | xargs ls' }]);
  });

  it('keeps separate calls separate, in the order they were seen', () => {
    const collector = collect([
      use('t1', 'Bash', { command: 'rm -rf x' }),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1' },
      use('t2', 'Write', { file_path: '/etc/x' }),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 't2' },
    ]);
    expect(collector.denials()).toEqual([
      { tool: 'Bash', detail: 'rm -rf x' },
      { tool: 'Write', detail: '/etc/x' },
    ]);
  });

  it('reads the tool name from the message of an error result, and ignores other errors', () => {
    const collector = collect([
      use('t1', 'Read', { file_path: '/x' }),
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'File not found' },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              is_error: true,
              content: 'Permission to use Read has been denied',
            },
          ],
        },
      },
    ]);
    expect(collector.denials()).toEqual([{ tool: 'Read', detail: null }]);
  });

  it('counts a result-list entry that nothing else showed', () => {
    const collector = collect([
      {
        type: 'result',
        subtype: 'success',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'curl x' } },
          'not an entry',
        ],
      },
    ]);
    expect(collector.denials()).toEqual([{ tool: 'Bash', detail: 'curl x' }]);
  });
});
