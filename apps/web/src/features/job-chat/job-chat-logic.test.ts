import type { JobFeedItem } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJobVersion } from '@/data/test-utils';
import {
  clock,
  currentWork,
  cutRows,
  cutSegments,
  feedSections,
  foldedLine,
  isFoldedRun,
  rowOpensChat,
  runDivider,
  runningCut,
  runTook,
  stageWaiting,
  textPieces,
  tookText,
  transcriptOf,
} from './job-chat-logic';
import { run } from './test-fixtures';

describe('feedSections', () => {
  it('cuts the feed at each run, and keeps what came before any run in a section of its own', () => {
    const items: JobFeedItem[] = [
      { id: 'a', at: null, kind: 'text', text: 'before' },
      run({ id: 'r1' }),
      { id: 'b', at: null, kind: 'text', text: 'in the draft' },
      run({ id: 'r2', run: 'round', round: 1 }),
    ];
    expect(feedSections(items).map((s) => [s.run?.id ?? null, s.items.map((i) => i.id)])).toEqual([
      [null, ['a']],
      ['r1', ['b']],
      ['r2', []],
    ]);
  });

  it('folds the runs that made the footage first', () => {
    expect(isFoldedRun(run({ run: 'brief' }))).toBe(true);
    expect(isFoldedRun(run({ run: 'generate' }))).toBe(true);
    expect(isFoldedRun(run({ run: 'draft' }))).toBe(false);
    expect(isFoldedRun(null)).toBe(false);
    expect(
      foldedLine([
        { run: run({ run: 'brief', durationMs: 54_000 }), items: [] },
        { run: run({ run: 'generate', durationMs: 2_401_000 }), items: [] },
      ]),
    ).toBe('Made the footage first · 41 min');
  });
});

describe('the words of a run', () => {
  it('names each divider', () => {
    expect(runDivider(run())).toBe('Draft started');
    expect(runDivider(run({ mode: 'resume' }))).toBe('Draft started, resumed');
    expect(runDivider(run({ run: 'round', round: 2 }))).toBe('Round 2');
    expect(runDivider(run({ run: 'render' }))).toBe('You approved it');
  });

  it('says how long a run that went well took, and nothing for one that did not', () => {
    expect(runTook(run({ outcome: 'succeeded', durationMs: 3_006_153 }))).toBe('Draft took 50 min');
    expect(
      runTook(run({ run: 'round', round: 1, outcome: 'succeeded', durationMs: 253_000 })),
    ).toBe('Round 1 took 4 min');
    expect(runTook(run({ outcome: 'failed', durationMs: 1000 }))).toBeNull();
  });

  it('puts a duration in plain words', () => {
    expect(tookText(38_000)).toBe('38 s');
    expect(tookText(4_400_000)).toBe('1 h 13 min');
    expect(tookText(7_200_000)).toBe('2 h');
  });
});

describe('the cards’ parts', () => {
  it('reads the packed transcript', () => {
    const text = [
      '# Packed transcripts',
      '',
      '## voice  (duration: 31.7s, 3 phrases)',
      '  [003.12-010.57] You always think about the food you eat',
      '  [011.21-021.77] Dust, pollen, and rain spots',
    ].join('\n');
    expect(transcriptOf(text)).toEqual({
      sources: ['voice'],
      phrases: [
        {
          source: 'voice',
          startSec: 3.12,
          endSec: 10.57,
          text: 'You always think about the food you eat',
        },
        {
          source: 'voice',
          startSec: 11.21,
          endSec: 21.77,
          text: 'Dust, pollen, and rain spots',
        },
      ],
    });
  });

  it('places the shots one after the other and tones each source alike', () => {
    const cuts = [
      { source: 'A', startSec: 0, endSec: 3, beat: 'HOOK', quote: null, reason: null },
      { source: 'B', startSec: 0, endSec: 1, beat: null, quote: null, reason: null },
      { source: 'A', startSec: 3, endSec: 7, beat: null, quote: null, reason: null },
    ];
    expect(cutRows(cuts).map((row) => [row.atSec, row.lenSec])).toEqual([
      [0, 3],
      [3, 1],
      [4, 4],
    ]);
    const segments = cutSegments(cuts);
    expect(segments.map((s) => s.width)).toEqual(['37.500%', '12.500%', '50.000%']);
    expect(segments[0]?.tone).toBe(segments[2]?.tone);
    expect(segments[0]?.tone).not.toBe(segments[1]?.tone);
  });

  it('writes a time on the video', () => {
    expect(clock(4.2)).toBe('0:04.2');
    expect(clock(75)).toBe('1:15.0');
  });

  it('marks Claude’s bold and code', () => {
    expect(textPieces('Voice is **done** at `34.87 s`.')).toEqual([
      { kind: 'plain', text: 'Voice is ' },
      { kind: 'bold', text: 'done' },
      { kind: 'plain', text: ' at ' },
      { kind: 'code', text: '34.87 s' },
      { kind: 'plain', text: '.' },
    ]);
  });
});

describe('what the run is on', () => {
  it('plays the cut the run changes: the current version, or else the newest; none before cut 1', () => {
    const v1 = makeJobVersion(1, { current: true });
    const v2 = makeJobVersion(2, { current: false });
    expect(runningCut([v2, v1])).toBe(v1);
    expect(runningCut([makeJobVersion(3, { current: false }), v2])?.n).toBe(3);
    expect(runningCut([])).toBeNull();
  });

  it('says what goes on where the player goes until there is a cut', () => {
    expect(stageWaiting({ state: 'queued' }, true)).toBe('Waiting in line');
    expect(stageWaiting({ state: 'editing' }, true)).toBeNull();
    expect(stageWaiting({ state: 'editing' }, false)).toBe('Cut 1 shows here when it’s ready.');
  });

  it('finds the command still running, within the run that goes on', () => {
    const tools = (state: 'running' | 'done') => ({
      id: 't',
      at: null,
      kind: 'tools' as const,
      tools: [
        { id: '1', tool: 'Bash', label: 'Probe', detail: null, state: 'done' as const },
        { id: '2', tool: 'Bash', label: 'Transcribe', detail: null, state },
      ],
    });
    expect(currentWork([run(), tools('running')])).toBe('Transcribe');
    expect(currentWork([tools('done'), run()])).toBeNull();
  });
});

describe('rowOpensChat', () => {
  it('opens the chat from the row of a job in Review, waiting in line or running', () => {
    for (const state of ['review', 'queued', 'editing'] as const) {
      expect(rowOpensChat({ state }, true)).toBe(true);
      expect(rowOpensChat({ state }, false)).toBe(false);
    }
    for (const state of ['held', 'ready', 'failed'] as const) {
      expect(rowOpensChat({ state }, true)).toBe(false);
    }
  });
});
