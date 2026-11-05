import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratePlan } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GenerateProgressReader,
  readPlan,
  readShots,
  sameProgress,
  shotsProblem,
  spendOf,
  voiceSecondsOf,
} from './generate-progress.js';

// Reading where a Generate stage stands from the files it leaves (Generated videos, GN5).

let editDir: string;
let dir: string;

beforeEach(() => {
  editDir = mkdtempSync(join(tmpdir(), 'studio-generate-progress-'));
  dir = join(editDir, 'generate');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(editDir, { recursive: true, force: true });
});

const put = (path: string, content = 'x'): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const PLAN: GeneratePlan = {
  voice: [
    { id: 'L1', text: 'One.', direction: null },
    { id: 'L2', text: 'Two.', direction: null },
    { id: 'L3', text: 'Three.', direction: null },
  ],
  cast: [
    {
      id: 'homeowner',
      kind: 'person',
      name: 'the homeowner',
      look: 'l',
      prompt: 'p',
      references: [],
    },
    {
      id: 'hero-skylight',
      kind: 'prop',
      name: 'the hero skylight',
      look: 'l',
      prompt: 'p',
      references: [],
    },
  ],
  clips: ['A', 'B'].map((id, index) => ({
    id,
    covers: [{ beat: 'b', startSec: index, endSec: index + 1 }],
    shows: `clip ${id}`,
    tier: 'easy' as const,
    seconds: 5,
    start: { prompt: 'p', file: null },
    end: id === 'B' ? { prompt: 'p', file: null } : null,
    references: [],
    prompt: 'p',
  })),
};

const SHOT = {
  file: 'clips/A/take-1.mp4',
  take: 1,
  windows: [{ startSec: 0, endSec: 1 }],
  seconds: 5,
  shows: 'x',
  model: 'm',
  usd: 0.1,
  belowBar: false,
};

describe('GenerateProgressReader', () => {
  it('shows planning, with nothing counted, before there is a plan', async () => {
    const snapshot = await new GenerateProgressReader(editDir).read();
    expect(snapshot.phase).toBe('plan');
    expect(snapshot.counts).toEqual({
      voice: { done: 0, total: 0 },
      looks: { done: 0, total: 0 },
      keyframes: { done: 0, total: 0 },
      clips: { done: 0, total: 0 },
      belowBar: 0,
    });
    expect(snapshot.spendUsd).toBe(0);
  });

  it('treats a folder that is not there as empty', async () => {
    rmSync(dir, { recursive: true, force: true });
    expect((await new GenerateProgressReader(editDir).read()).phase).toBe('plan');
  });

  it('counts the voice lines that have a take, then all of them once voice.mp3 is assembled', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice/L1-take1.mp3');
    put('voice/L1-take2.mp3');
    put('voice/L2-take1.mp3');
    const reader = new GenerateProgressReader(editDir);

    const during = await reader.read();
    expect(during.phase).toBe('voice');
    expect(during.counts.voice).toEqual({ done: 2, total: 3 });
    expect(during.voiceTakes.get('L1')).toEqual([1, 2]);

    put('voice/L3-take1.mp3');
    put('voice.mp3');
    put(
      'voice-words.json',
      JSON.stringify({ words: [{ line: 'L1', text: 'One.', startSec: 0, endSec: 3.2 }] }),
    );
    const after = await reader.read();
    expect(after.counts.voice).toEqual({ done: 3, total: 3 });
    expect(after.voiceAssembled).toBe(true);
    expect(after.voiceSec).toBe(3.2);
    expect(after.phase).toBe('looks');
  });

  it('waits for no look and no keyframe in a text-to-video plan (U31): after the voice it is clips', async () => {
    const textOnly: GeneratePlan = {
      ...PLAN,
      cast: [],
      clips: PLAN.clips.map((clip) => ({ ...clip, start: null, end: null })),
    };
    put('plan.json', JSON.stringify(textOnly));
    put('voice.mp3');
    put('voice-words.json', '{"words":[]}');
    const reader = new GenerateProgressReader(editDir);

    let snapshot = await reader.read();
    expect(snapshot.counts.looks).toEqual({ done: 0, total: 0 });
    expect(snapshot.counts.keyframes).toEqual({ done: 0, total: 0 });
    expect(snapshot.phase).toBe('clips');

    put('clips/A/take-1.mp4');
    put('clips/B/take-1.mp4');
    snapshot = await reader.read();
    expect(snapshot.counts.clips).toEqual({ done: 2, total: 2 });
    expect(snapshot.phase).toBe('sound');
  });

  it('goes through looks, keyframes and clips as their files appear', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice.mp3');
    put('voice-words.json', '{"words":[]}');
    const reader = new GenerateProgressReader(editDir);

    put('looks/homeowner.png');
    let snapshot = await reader.read();
    expect(snapshot).toMatchObject({ phase: 'looks' });
    expect(snapshot.counts.looks).toEqual({ done: 1, total: 2 });

    put('looks/hero-skylight.png');
    snapshot = await reader.read();
    expect(snapshot.phase).toBe('keyframes');
    // One start frame per clip and the end frame of B: three.
    expect(snapshot.counts.keyframes).toEqual({ done: 0, total: 3 });

    put('keyframes/A.png');
    put('keyframes/B.png');
    put('keyframes/B-end.png');
    snapshot = await reader.read();
    expect(snapshot.phase).toBe('clips');
    expect(snapshot.counts.keyframes).toEqual({ done: 3, total: 3 });

    put('clips/A/take-1.mp4');
    put('clips/A/take-1-1x1.mp4');
    snapshot = await reader.read();
    expect(snapshot.counts.clips).toEqual({ done: 1, total: 2 });
    expect(snapshot.clipTakes.get('A')).toBe(1);

    put('clips/B/take-1.mp4');
    put('clips/B/take-2.mp4');
    snapshot = await reader.read();
    expect(snapshot.phase).toBe('sound');
    expect(snapshot.counts.clips).toEqual({ done: 2, total: 2 });
    expect(snapshot.clipTakes.get('B')).toBe(2);
  });

  it('never counts a still of something that is not in the cast, and caps keyframes at what the plan asks for', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('looks/a-stray-file.png');
    for (const name of ['A', 'B', 'B-end', 'A-2', 'A-3']) put(`keyframes/${name}.png`);
    const snapshot = await new GenerateProgressReader(editDir).read();
    expect(snapshot.counts.looks.done).toBe(0);
    expect(snapshot.counts.keyframes).toEqual({ done: 3, total: 3 });
  });

  it('reads the money from the entries that were not refunded, never from the total field', async () => {
    put(
      'spend.json',
      JSON.stringify({
        entries: [
          {
            at: '2026-10-25T10:00:00.000Z',
            kind: 'clip',
            slug: 's',
            usd: 0.5,
            requestId: 'a',
            refunded: false,
          },
          {
            at: '2026-10-25T10:01:00.000Z',
            kind: 'clip',
            slug: 's',
            usd: 0.25,
            requestId: 'b',
            refunded: true,
          },
          {
            at: '2026-10-25T10:02:00.000Z',
            kind: 'still',
            slug: 's',
            usd: 0.004,
            requestId: 'c',
            refunded: false,
          },
        ],
        total: 99,
      }),
    );
    expect((await new GenerateProgressReader(editDir).read()).spendUsd).toBe(0.504);
  });

  it('keeps the last good reading of a file that is half written', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('spend.json', JSON.stringify({ entries: [{ usd: 0.2, refunded: false }], total: 0.2 }));
    const reader = new GenerateProgressReader(editDir);
    expect((await reader.read()).counts.voice.total).toBe(3);

    put('plan.json', '{"voice": [{"id": "L1", "te');
    put('spend.json', '{"entries": [{"us');
    const snapshot = await reader.read();

    expect(snapshot.counts.voice.total).toBe(3);
    expect(snapshot.spendUsd).toBe(0.2);
  });

  it('counts every clip as done and the clips below the bar once shots.json is a valid hand-off', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice.mp3');
    put('voice-words.json', '{"words":[]}');
    put(
      'shots.json',
      JSON.stringify({
        shots: [
          { id: 'A', ...SHOT },
          { id: 'B', ...SHOT, file: 'clips/B/take-1.mp4', belowBar: true },
        ],
      }),
    );

    const snapshot = await new GenerateProgressReader(editDir).read();

    expect(snapshot.counts.clips).toEqual({ done: 2, total: 2 });
    expect(snapshot.counts.belowBar).toBe(1);
    expect(snapshot.shots?.shots).toHaveLength(2);
    // The files alone never say `done`: the step does, once the hand-off is checked.
    expect(snapshot.phase).toBe('sound');
  });
});

describe('the small readers', () => {
  it('reads the spend of a list, leniently, and nothing from what is not one', () => {
    expect(spendOf({ entries: [{ usd: 1, refunded: false }, { usd: 'x' }, null] })).toBe(1);
    expect(spendOf({ entries: [] })).toBe(0);
    expect(spendOf({})).toBeNull();
    expect(spendOf(null)).toBeNull();
  });

  it('reads the length of the voice from ms or from the last word', () => {
    expect(voiceSecondsOf({ ms: 31_100, words: [] })).toBe(31.1);
    expect(voiceSecondsOf({ words: [{ endSec: 2 }, { endSec: 7.5 }] })).toBe(7.5);
    expect(voiceSecondsOf({ words: [] })).toBeNull();
    expect(voiceSecondsOf(undefined)).toBeNull();
  });

  it('reads shots.json only when it holds a shot, and plan.json only when it is a plan', async () => {
    expect(await readShots(editDir)).toBeNull();
    put('shots.json', '{"shots":[]}');
    expect(await readShots(editDir)).toBeNull();
    put('shots.json', JSON.stringify({ shots: [{ id: 'A', ...SHOT }] }));
    expect((await readShots(editDir))?.shots).toHaveLength(1);
    put('plan.json', '{"voice":[]}');
    expect(await readPlan(editDir)).toBeNull();
  });

  it('says in words why shots.json is not a hand-off', async () => {
    expect(await shotsProblem(editDir)).toBe('edit/generate/shots.json was not written.');
    put('shots.json', 'not json');
    expect(await shotsProblem(editDir)).toBe('edit/generate/shots.json is not valid JSON.');
    put('shots.json', '{"shots":[{"id":"A"}]}');
    expect(await shotsProblem(editDir)).toMatch(
      /^edit\/generate\/shots\.json doesn’t match its shape \(shots\.0\./,
    );
    put('shots.json', '{"shots":[]}');
    expect(await shotsProblem(editDir)).toBe('edit/generate/shots.json lists no shots.');
  });

  it('says whether two looks show the same numbers', async () => {
    const reader = new GenerateProgressReader(editDir);
    const first = await reader.read();
    expect(sameProgress(null, first)).toBe(false);
    expect(sameProgress(first, await reader.read())).toBe(true);
    put('plan.json', JSON.stringify(PLAN));
    expect(sameProgress(first, await reader.read())).toBe(false);
  });
});
