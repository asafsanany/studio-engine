import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratePlan, GenerateShots } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  briefVoiceLines,
  changedVoiceLines,
  checkHandoff,
  describeExisting,
  lastStopOf,
  materializeShots,
} from './generate-existing.js';
import { GenerateProgressReader } from './generate-progress.js';

// What a Generate stage finds when it starts again (Generated videos, GN5).

let editDir: string;
let dir: string;

beforeEach(() => {
  editDir = mkdtempSync(join(tmpdir(), 'studio-generate-existing-'));
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
    { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
    { id: 'L2', text: 'But it gets worse.', direction: null },
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
  ],
  clips: ['A', 'B'].map((id, index) => ({
    id,
    covers: [{ beat: 'b', startSec: index, endSec: index + 1 }],
    shows: `clip ${id}`,
    tier: 'easy' as const,
    seconds: 5,
    start: { prompt: 'p', file: null },
    end: null,
    references: [],
    prompt: 'p',
  })),
};

const SHOT = (id: string, file: string) => ({
  id,
  file,
  take: 1,
  windows: [{ startSec: 0, endSec: 1 }],
  seconds: 5,
  shows: 'x',
  model: 'm',
  usd: 0.1,
  belowBar: false,
});

const BRIEF = {
  voiceover: {
    lines: [
      { id: 'L1', text: 'Do you know what is in your windows?' },
      { id: 'L2', text: 'But it gets worse.' },
    ],
  },
};

describe('the script against the plan', () => {
  it('lists the brief’s voice lines, none without a voiceover', () => {
    expect(briefVoiceLines(BRIEF)).toEqual(BRIEF.voiceover.lines);
    expect(briefVoiceLines({ voiceover: null })).toEqual([]);
    expect(briefVoiceLines({})).toEqual([]);
  });

  it('ignores the typography a copy may change: curly quotes, dashes, the ellipsis character', () => {
    const plan = {
      voice: [{ id: 'L1', text: "That's not all - get it now...", direction: null }],
    };
    expect(
      changedVoiceLines(plan, {
        voiceover: { lines: [{ id: 'L1', text: 'That\u2019s not all \u2014 get it now\u2026' }] },
      }),
    ).toEqual([]);
    expect(
      changedVoiceLines(plan, {
        voiceover: { lines: [{ id: 'L1', text: 'That\u2019s not all \u2014 get it today\u2026' }] },
      }),
    ).toEqual(['L1']);
  });

  it('finds the lines whose words changed, ignoring spacing, and a line the plan lacks', () => {
    expect(changedVoiceLines(PLAN, BRIEF)).toEqual([]);
    expect(
      changedVoiceLines(PLAN, {
        voiceover: {
          lines: [
            { id: 'L1', text: 'Do you know  what is in your windows?\n' },
            { id: 'L2', text: 'But it gets a lot worse.' },
            { id: 'L3', text: 'A new line.' },
          ],
        },
      }),
    ).toEqual(['L2', 'L3']);
    // A brief with no voiceover changes nothing.
    expect(changedVoiceLines(PLAN, { voiceover: null })).toEqual([]);
  });
});

describe('checkHandoff', () => {
  const shots = (file = 'clips/A/take-1.mp4'): GenerateShots => ({ shots: [SHOT('A', file)] });

  it('accepts clips that are there and the assembled voice', async () => {
    put('clips/A/take-1.mp4');
    put('voice.mp3');
    put('voice-words.json');
    expect(await checkHandoff(editDir, shots())).toEqual({ ok: true });
  });

  it('names the file that is missing', async () => {
    put('voice.mp3');
    put('voice-words.json');
    expect(await checkHandoff(editDir, shots())).toEqual({
      ok: false,
      problem: 'shots.json names clips/A/take-1.mp4 for clip A, but that file is not there.',
    });
    put('clips/A/take-1.mp4');
    rmSync(join(dir, 'voice.mp3'));
    expect(await checkHandoff(editDir, shots())).toEqual({
      ok: false,
      problem: 'edit/generate/voice.mp3 is not there.',
    });
    put('voice.mp3');
    rmSync(join(dir, 'voice-words.json'));
    expect(await checkHandoff(editDir, shots())).toMatchObject({ ok: false });
  });

  it('refuses a clip outside edit/generate/', async () => {
    put('voice.mp3');
    put('voice-words.json');
    writeFileSync(join(editDir, 'brief.json'), '{}');
    expect(await checkHandoff(editDir, shots('../brief.json'))).toEqual({
      ok: false,
      problem: 'shots.json names ../brief.json, which is outside edit/generate/.',
    });
  });
});

describe('materializeShots', () => {
  it('copies the kept take of each shot to shots/<id>.mp4', async () => {
    put('clips/A/take-1.mp4', 'one');
    put('clips/B/take-2.mp4', 'two');

    await materializeShots(editDir, {
      shots: [SHOT('A', 'clips/A/take-1.mp4'), SHOT('B', 'clips/B/take-2.mp4')],
    });

    expect(readFileSync(join(dir, 'shots', 'A.mp4'), 'utf8')).toBe('one');
    expect(readFileSync(join(dir, 'shots', 'B.mp4'), 'utf8')).toBe('two');
  });

  it('leaves an up-to-date copy alone and replaces one the run chose another take for', async () => {
    put('clips/A/take-1.mp4', 'one');
    put('clips/A/take-2.mp4', 'second');
    await materializeShots(editDir, { shots: [SHOT('A', 'clips/A/take-1.mp4')] });
    const before = statSync(join(dir, 'shots', 'A.mp4')).mtimeMs;
    // Same take again: not copied again.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'shots', 'A.mp4'), old, old);
    utimesSync(join(dir, 'clips', 'A', 'take-1.mp4'), old, old);
    await materializeShots(editDir, { shots: [SHOT('A', 'clips/A/take-1.mp4')] });
    expect(statSync(join(dir, 'shots', 'A.mp4')).mtimeMs).toBeLessThanOrEqual(before);

    // Another take is chosen: the copy becomes that file.
    await materializeShots(editDir, { shots: [SHOT('A', 'clips/A/take-2.mp4')] });
    expect(readFileSync(join(dir, 'shots', 'A.mp4'), 'utf8')).toBe('second');
  });
});

describe('describeExisting', () => {
  const describing = async (history: Parameters<typeof describeExisting>[2]['history'] = []) =>
    describeExisting(await new GenerateProgressReader(editDir).read(), BRIEF, {
      budgetUsd: 3,
      history,
    });

  it('is empty for a first try, which takes its line out of the prompt', async () => {
    expect(await describing()).toBe('');
  });

  it('says what exists, what is missing and what is left of the money', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice/L1-take1.mp3');
    put('voice/L1-take2.mp3');
    put('voice/L2-take1.mp3');
    put('voice.mp3');
    put('voice-words.json', JSON.stringify({ ms: 31_100, words: [] }));
    put('looks/homeowner.png');
    put('keyframes/A.png');
    put('clips/A/take-1.mp4');
    put('sfx/alert.mp3');
    put(
      'spend.json',
      JSON.stringify({
        entries: [
          { usd: 1.65, refunded: false },
          { usd: 9, refunded: true },
        ],
      }),
    );

    const text = await describing([
      {
        kind: 'stopped',
        at: '2026-10-25T14:21:00.000Z',
        code: 'balance_empty',
        service: 'higgsfield',
      },
    ]);

    expect(text).toContain('An earlier try of this stage already made part of it.');
    expect(text).toContain('- That try stopped because the Higgsfield balance is empty.');
    expect(text).toContain('plan.json (2 clips, 2 voice lines, 1 in the cast)');
    expect(text).toContain(
      'The voice is made and assembled (voice.mp3 and voice-words.json, 31.1 s): L1 (takes 1, 2), L2 (take 1).',
    );
    expect(text).toContain('- Looks made: homeowner.');
    expect(text).toContain('- Keyframes made: A.');
    expect(text).toContain('- Clips made: A (take 1). No take yet: B.');
    expect(text).toContain('- Sound effects made: alert.mp3.');
    expect(text).toContain('Spent on Higgsfield so far: $1.65 of the $3 budget, $1.35 left.');
    // Nothing in it reads like a command to run.
    expect(text).not.toMatch(/node |--budget|\{\{/);
  });

  it('says which voice lines are not made yet and that the voice is not assembled', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice/L1-take1.mp3');
    const text = await describing();
    expect(text).toContain(
      'Voice lines made: L1 (take 1). Not made yet: L2. The voice is not assembled yet.',
    );
  });

  it('tells the run to make the lines again when the script in the brief changed', async () => {
    put('plan.json', JSON.stringify(PLAN));
    put('voice/L1-take1.mp3');
    const changed = await describeExisting(
      await new GenerateProgressReader(editDir).read(),
      {
        voiceover: {
          lines: [
            { id: 'L1', text: 'Do you know what is in your windows?' },
            { id: 'L2', text: 'But it gets a lot worse.' },
          ],
        },
      },
      { budgetUsd: 3, history: [] },
    );
    expect(changed).toContain(
      'The script in brief.md changed since the plan: L2 is not the words in plan.json.',
    );
    expect(changed).toContain('Make that line again as a new take');
  });

  it('names the last stop, not an earlier one', () => {
    expect(
      lastStopOf([
        {
          kind: 'stopped',
          at: '2026-10-25T14:00:00.000Z',
          code: 'unavailable',
          service: 'higgsfield',
        },
        { kind: 'voice', at: '2026-10-25T14:01:00.000Z', lines: 1, seconds: 1 },
        {
          kind: 'stopped',
          at: '2026-10-25T14:02:00.000Z',
          code: 'over_budget',
          needUsd: 4.1,
          budgetUsd: 3,
        },
      ]),
    ).toBe('this video needs about $4.10, over the budget of $3');
    expect(lastStopOf([])).toBeNull();
  });
});
