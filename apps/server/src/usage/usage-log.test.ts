import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeProjectsDir,
  logAppUsage,
  logUsage,
  readUsageLog,
  sessionTranscripts,
  usageLogPath,
} from './usage-log.js';

let root: string;
let dataDir: string;
let projectsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-usage-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'home', '.claude', 'projects');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function call(id: string, at: string, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0 },
    },
  });
}

/** A session transcript in a project folder, plus one subagent transcript. */
function writeSession(session: string, main: string[], subagent: string[] = []): void {
  const dir = join(projectsDir, '-Users-example-workspace-engine');
  mkdirSync(join(dir, session, 'subagents'), { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), `${main.join('\n')}\n`);
  writeFileSync(join(dir, session, 'subagents', 'agent-a1.jsonl'), `${subagent.join('\n')}\n`);
  writeFileSync(join(dir, session, 'subagents', 'agent-a1.meta.json'), '{}');
}

describe('claudeProjectsDir', () => {
  it('is ~/.claude/projects, or under CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeProjectsDir('/h', {})).toBe('/h/.claude/projects');
    expect(claudeProjectsDir('/h', { CLAUDE_CONFIG_DIR: '' })).toBe('/h/.claude/projects');
    expect(claudeProjectsDir('/h', { CLAUDE_CONFIG_DIR: '/c' })).toBe('/c/projects');
  });
});

describe('sessionTranscripts', () => {
  it('finds the session and its subagents in any project folder, and nothing for another', async () => {
    writeSession('s1', [], []);
    mkdirSync(join(projectsDir, 'other'), { recursive: true });
    const files = await sessionTranscripts(projectsDir, 's1');
    expect(files.map((file) => file.slice(projectsDir.length))).toEqual([
      '/-Users-example-workspace-engine/s1.jsonl',
      '/-Users-example-workspace-engine/s1/subagents/agent-a1.jsonl',
    ]);
    expect(await sessionTranscripts(projectsDir, 's2')).toEqual([]);
    expect(await sessionTranscripts(join(root, 'missing'), 's1')).toEqual([]);
  });
});

describe('logUsage', () => {
  it('logs the session’s tokens, subagents included, then only what came after its last line', async () => {
    writeSession(
      's1',
      [call('m1', '2026-10-22T10:00:00.000Z', 10), call('m3', '2026-10-22T11:00:00.000Z', 30)],
      [call('m2', '2026-10-22T10:10:00.000Z', 20)],
    );
    const first = await logUsage({
      dataDir,
      projectsDir,
      source: 'session',
      tag: 'design',
      did: '  Drew the\nboards  ',
      session: 's1',
      now: new Date('2026-10-22T10:30:00.000Z'),
    });
    expect(first).toEqual({
      at: '2026-10-22T10:30:00.000Z',
      from: null,
      source: 'session',
      tag: 'design',
      did: 'Drew the boards',
      session: 's1',
      usage: {
        'claude-opus-5-5': { requests: 2, input: 2, output: 30, cacheRead: 0, cacheWrite: 0 },
      },
    });

    const second = await logUsage({
      dataDir,
      projectsDir,
      source: 'session',
      tag: 'development',
      did: 'Built them',
      session: 's1',
      now: new Date('2026-10-22T11:30:00.000Z'),
    });
    expect(second.from).toBe('2026-10-22T10:30:00.000Z');
    expect(second.usage).toEqual({
      'claude-opus-5-5': { requests: 1, input: 1, output: 30, cacheRead: 0, cacheWrite: 0 },
    });

    expect(await readUsageLog(dataDir)).toEqual([first, second]);
    expect(readFileSync(usageLogPath(dataDir), 'utf8').split('\n')).toHaveLength(3);
  });

  it('logs a run with no Claude session with no tokens', async () => {
    const entry = await logUsage({
      dataDir,
      projectsDir,
      source: 'app',
      tag: 'transcribe',
      did: 'Transcribed a voice note for RGM / Ep 3',
      session: null,
      client: 'RGM',
      job: { id: 'j1', name: 'Ep 3' },
    });
    expect(entry).toMatchObject({ session: null, from: null, usage: {}, client: 'RGM' });
  });

  it('refuses a tag that is not one', async () => {
    await expect(
      logUsage({
        dataDir,
        projectsDir,
        source: 'session',
        tag: 'bugfix' as never,
        did: 'x',
        session: 's1',
      }),
    ).rejects.toThrow();
    expect(await readUsageLog(dataDir)).toEqual([]);
  });
});

describe('logAppUsage', () => {
  it('only warns when the log cannot be written', async () => {
    writeFileSync(join(root, 'file'), '');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await logAppUsage(
      { dataDir: join(root, 'file', 'data'), home: root, env: {}, logger },
      { tag: 'edit', did: 'Edited RGM / Ep 3' },
      's1',
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
