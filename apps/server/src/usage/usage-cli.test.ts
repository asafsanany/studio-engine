import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_USAGE_TAGS } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STOP_REASON, stopHookReason, tagList } from './usage-cli.js';
import { logUsage } from './usage-log.js';

let root: string;
let dataDir: string;
let transcript: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-usage-cli-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir);
  transcript = join(root, 's1.jsonl');
  writeFileSync(
    transcript,
    `${[
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-22T10:00:00.000Z',
        message: { content: 'go' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-22T11:00:00.000Z',
        message: { content: 'next' },
      }),
    ].join('\n')}\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hook(extra: Record<string, unknown> = {}) {
  return { session_id: 's1', transcript_path: transcript, stop_hook_active: false, ...extra };
}

async function logAt(at: string, session = 's1') {
  await logUsage({
    dataDir,
    projectsDir: join(root, 'projects'),
    source: 'session',
    tag: 'development',
    did: 'Worked',
    session,
    now: new Date(at),
  });
}

describe('stopHookReason', () => {
  it('sends a turn back when the session logged nothing', async () => {
    expect(await stopHookReason(hook(), dataDir)).toBe(STOP_REASON);
  });

  it('sends it back when the last line came before this turn’s prompt, or from another session', async () => {
    await logAt('2026-10-22T10:30:00.000Z');
    await logAt('2026-10-22T11:30:00.000Z', 's2');
    expect(await stopHookReason(hook(), dataDir)).toBe(STOP_REASON);
  });

  it('lets the turn end once it logged a line', async () => {
    await logAt('2026-10-22T11:30:00.000Z');
    expect(await stopHookReason(hook(), dataDir)).toBeNull();
  });

  it('asks only once per turn', async () => {
    expect(await stopHookReason(hook({ stop_hook_active: true }), dataDir)).toBeNull();
  });

  it('lets anything it cannot read stop', async () => {
    expect(await stopHookReason(null, dataDir)).toBeNull();
    expect(await stopHookReason({ session_id: 's1' }, dataDir)).toBeNull();
    expect(
      await stopHookReason(hook({ transcript_path: join(root, 'gone.jsonl') }), dataDir),
    ).toBeNull();
    writeFileSync(transcript, '');
    expect(await stopHookReason(hook(), dataDir)).toBeNull();
  });

  it('names the command and every session tag', () => {
    expect(STOP_REASON).toContain('pnpm usage <tag>');
    for (const tag of SESSION_USAGE_TAGS) expect(STOP_REASON).toContain(tag);
  });
});

describe('tagList', () => {
  it('lists the session tags with what each covers, and no app tag', () => {
    const lines = tagList().split('\n');
    expect(lines).toHaveLength(SESSION_USAGE_TAGS.length);
    expect(lines[0]).toMatch(/^ {2}development +Building or fixing Studio Engine, bugs included$/);
    expect(tagList()).not.toMatch(/\bedit\b/);
  });
});
