import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateHistoryEvent } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GenerateHistory,
  historyKey,
  historyPath,
  readGenerateHistory,
} from './generate-history.js';

// The Generate stage's History file (Generated videos, GN5).

let editDir: string;

beforeEach(() => {
  editDir = mkdtempSync(join(tmpdir(), 'studio-generate-history-'));
});

afterEach(() => {
  rmSync(editDir, { recursive: true, force: true });
});

const AT = '2026-10-25T14:03:00.000Z';
const voice: GenerateHistoryEvent = { kind: 'voice', at: AT, lines: 7, seconds: 31 };
const clipA: GenerateHistoryEvent = {
  kind: 'clip',
  at: AT,
  id: 'A',
  shows: 'the hero skylight',
  take: 1,
};

describe('GenerateHistory', () => {
  it('appends events to edit/generate/history.jsonl, one per line, oldest first', async () => {
    const history = new GenerateHistory(editDir);

    expect(await history.add(voice)).toBe(true);
    expect(await history.add(clipA)).toBe(true);

    expect(historyPath(editDir)).toBe(join(editDir, 'generate', 'history.jsonl'));
    const lines = readFileSync(historyPath(editDir), 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['voice', 'clip']);
    expect(await readGenerateHistory(editDir)).toEqual([voice, clipA]);
  });

  it('writes a thing that happened once, even when a later try sees it again', async () => {
    const first = new GenerateHistory(editDir);
    await first.add(voice);
    await first.add(clipA);
    expect(await first.add({ ...voice, at: '2026-10-25T15:00:00.000Z' })).toBe(false);

    // A Retry reads what is there before it adds.
    const second = new GenerateHistory(editDir);
    await second.load();
    expect(second.has(voice)).toBe(true);
    expect(await second.add({ ...clipA, at: '2026-10-25T15:00:00.000Z' })).toBe(false);
    // Another take of the same clip is a new line; so is every stop.
    expect(await second.add({ ...clipA, take: 2 })).toBe(true);
    const stop = (at: string): GenerateHistoryEvent => ({
      kind: 'stopped',
      at,
      code: 'balance_empty',
    });
    expect(await second.add(stop(AT))).toBe(true);
    expect(await second.add(stop('2026-10-25T16:00:00.000Z'))).toBe(true);
    expect((await readGenerateHistory(editDir)).map((event) => event.kind)).toEqual([
      'voice',
      'clip',
      'clip',
      'stopped',
      'stopped',
    ]);
  });

  it('adds without an explicit load', async () => {
    mkdirSync(join(editDir, 'generate'), { recursive: true });
    writeFileSync(historyPath(editDir), `${JSON.stringify(voice)}\n`);
    const history = new GenerateHistory(editDir);
    expect(await history.add(voice)).toBe(false);
  });
});

describe('readGenerateHistory', () => {
  it('is empty when there is no file', async () => {
    expect(await readGenerateHistory(editDir)).toEqual([]);
  });

  it('skips a line that is not an event: half written, hand edited, or from a newer engine', async () => {
    mkdirSync(join(editDir, 'generate'), { recursive: true });
    writeFileSync(historyPath(editDir), `${JSON.stringify(voice)}\n{"kind":"voi\n\nnot json\n`);
    appendFileSync(historyPath(editDir), `${JSON.stringify({ kind: 'dance', at: AT })}\n`);
    appendFileSync(historyPath(editDir), `${JSON.stringify(clipA)}\n`);
    expect(await readGenerateHistory(editDir)).toEqual([voice, clipA]);
  });
});

describe('historyKey', () => {
  it('tells a clip by its id and take, a stop by its moment, and the rest by their kind', () => {
    expect(historyKey(clipA)).toBe('clip:A:1');
    expect(historyKey({ kind: 'budget', at: AT, id: 'B' })).toBe('budget:B');
    expect(historyKey({ kind: 'stopped', at: AT, code: 'balance_empty' })).toBe(
      `stopped:${AT}:balance_empty`,
    );
    expect(historyKey(voice)).toBe('voice');
  });
});
