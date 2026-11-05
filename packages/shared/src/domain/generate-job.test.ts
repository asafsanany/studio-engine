import { describe, expect, it } from 'vitest';
import { listDetail } from '../format.ts';
import { generateErrorMessage } from './generate.ts';
import {
  belowBarText,
  formatLabelsOf,
  generateBarRight,
  generateFailureOf,
  generateListDetail,
  generatePing,
  generateProgressPct,
  generateStageMark,
  generateStopPlace,
  isGeneratedJob,
  isGeneratingNow,
  jobListDetail,
} from './generate-job.ts';
import { makeGenerateState, makeJob } from './test-fixtures.ts';

const NOW = '2026-10-25T14:00:00.000Z';

const generating = (overrides = {}) =>
  makeJob({
    state: 'editing',
    step: 1,
    subProgress: 'Generate · clips 4/6 · $1.65',
    generate: makeGenerateState(),
    ...overrides,
  });

const stopped = (message: string, overrides = {}) =>
  makeJob({
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: message,
    generate: makeGenerateState(),
    ...overrides,
  });

const FORMATS = [
  { id: '9x16', label: '9:16', width: 1080, height: 1920, previewPath: 'preview/index.html' },
  { id: '1x1', label: '1:1', width: 1080, height: 1080, previewPath: 'preview/1x1/index.html' },
];

describe('isGeneratingNow', () => {
  it('is true while the engine has written the stage text at step 1', () => {
    expect(isGeneratingNow(generating())).toBe(true);
  });

  it('is false while the Brief is still read (no stage text yet) and on a footage job', () => {
    expect(isGeneratingNow(generating({ subProgress: 'reading 9 files' }))).toBe(false);
    expect(isGeneratingNow(generating({ subProgress: null }))).toBe(false);
    expect(
      isGeneratingNow(makeJob({ state: 'editing', step: 1, subProgress: 'reading 9 files' })),
    ).toBe(false);
  });

  it('is false once the edit has moved on or the stage is done', () => {
    expect(isGeneratingNow(generating({ step: 2 }))).toBe(false);
    expect(isGeneratingNow(generating({ generate: makeGenerateState({ phase: 'done' }) }))).toBe(
      false,
    );
  });
});

describe('generateFailureOf', () => {
  it('reads a coded stop back from the stored sentence', () => {
    const failure = generateFailureOf(stopped(generateErrorMessage('balance_empty')));
    expect(failure?.error).toEqual({ code: 'balance_empty', service: 'higgsfield' });
  });

  it('reads the dollars of an over-budget stop', () => {
    const failure = generateFailureOf(
      stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 })),
    );
    expect(failure?.error).toEqual({
      code: 'over_budget',
      service: 'higgsfield',
      needUsd: 4.1,
      budgetUsd: 3,
    });
  });

  it('knows a stop with no code of its own', () => {
    expect(
      generateFailureOf(stopped('Generate stopped: the run took longer than 4 hours.')),
    ).toEqual({ error: null });
  });

  it('is null for any other failure', () => {
    expect(generateFailureOf(stopped('Disk is full.'))).toBeNull();
    expect(
      generateFailureOf(stopped(generateErrorMessage('balance_empty'), { failedAt: 5 })),
    ).toBeNull();
    expect(generateFailureOf(makeJob({ state: 'editing' }))).toBeNull();
  });
});

describe('the row detail of a generated job', () => {
  it('says what Generate is making, with the money in the clips phase', () => {
    expect(generateListDetail(generating())).toBe('Generate · clips 4/6 · $1.65');
    expect(
      generateListDetail(
        generating({
          generate: makeGenerateState({
            phase: 'voice',
            counts: { ...makeGenerateState().counts, voice: { done: 3, total: 7 } },
          }),
        }),
      ),
    ).toBe('Generate · voice 3/7');
  });

  it('falls back to the ordinary row while the Brief is read', () => {
    const job = generating({ subProgress: 'reading 9 files' });
    expect(generateListDetail(job)).toBeNull();
    expect(jobListDetail(job, NOW)).toBe('Brief · reading 9 files');
  });

  it('names the three stops of the board', () => {
    expect(generateListDetail(stopped(generateErrorMessage('balance_empty')))).toBe(
      'Higgsfield balance is empty',
    );
    expect(generateListDetail(stopped(generateErrorMessage('key_rejected')))).toBe(
      'Higgsfield key not accepted',
    );
    expect(
      generateListDetail(
        stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 })),
      ),
    ).toBe('Needs about $4.10, the budget is $3');
  });

  it('says "Failed at Generate" for a stop with no code', () => {
    expect(generateListDetail(stopped('Generate stopped: it was stopped.'))).toBe(
      'Failed at Generate',
    );
  });

  it('adds what is worth knowing to a review row', () => {
    const preview = { durationSec: 35, width: 1080, height: 1920 };
    const below = makeJob({
      state: 'review',
      preview,
      generate: makeGenerateState({
        phase: 'done',
        counts: { ...makeGenerateState().counts, belowBar: 1 },
      }),
    });
    expect(generateListDetail(below)).toBe('Ready to review · 0:35 · 1 clip below the bar');
    const two = makeJob({
      state: 'review',
      preview,
      formats: FORMATS,
      generate: makeGenerateState({ phase: 'done' }),
    });
    expect(generateListDetail(two)).toBe('Ready to review · 0:35 · 9:16 and 1:1');
    expect(generateListDetail({ ...two, round: 1 })).toBe(
      'Ready to review · 0:35 · 9:16 and 1:1 · round 2',
    );
  });

  it('leaves Quick fixes lines and a plain review row to the ordinary text', () => {
    const preview = { durationSec: 35, width: 1080, height: 1920 };
    const plain = makeJob({ state: 'review', preview });
    expect(generateListDetail(plain)).toBeNull();
    expect(jobListDetail(plain, NOW)).toBe(listDetail(plain, NOW));
    const fixing = makeJob({
      state: 'review',
      preview,
      formats: FORMATS,
      fixing: { atSec: 12 },
    });
    expect(generateListDetail(fixing)).toBeNull();
  });

  it('counts the files of an approved job with one for each format', () => {
    const job = makeJob({
      state: 'ready',
      formats: FORMATS,
      output: {
        fileName: 'Pinewood/97 Window Ad.mp4',
        durationSec: 35,
        width: 1080,
        height: 1920,
        sizeBytes: 27_000_000,
        outputs: [
          { format: '9x16', fileName: 'Pinewood/97 Window Ad.mp4', bytes: 27_000_000 },
          { format: '1x1', fileName: 'Pinewood/97 Window Ad (1x1).mp4', bytes: 20_000_000 },
        ],
      },
    });
    expect(generateListDetail(job)).toBe('2 files · 9:16 and 1:1 · 0:35');
  });

  it('reads the formats from the files when the job does not list them', () => {
    expect(
      formatLabelsOf({
        formats: undefined,
        output: {
          fileName: 'a.mp4',
          durationSec: 1,
          width: 1,
          height: 1,
          sizeBytes: 1,
          outputs: [
            { format: '9x16', fileName: 'a.mp4', bytes: 1 },
            { format: '4x5', fileName: 'a (4x5).mp4', bytes: 1 },
          ],
        },
      }),
    ).toEqual(['9:16', '4:5']);
  });

  it('does not touch the row of a footage job', () => {
    const job = makeJob({
      state: 'ready',
      output: {
        fileName: 'a.mp4',
        durationSec: 30,
        width: 1080,
        height: 1920,
        sizeBytes: 27_000_000,
      },
    });
    expect(generateListDetail(job)).toBeNull();
    expect(jobListDetail(job, NOW)).toBe(listDetail(job, NOW));
    expect(generateListDetail(makeJob({ state: 'failed', failedAt: 5, error: 'x' }))).toBeNull();
  });

  it('says "1 clip" and "2 clips below the bar"', () => {
    expect(belowBarText(1)).toBe('1 clip below the bar');
    expect(belowBarText(2)).toBe('2 clips below the bar');
  });
});

describe('generateStageMark', () => {
  it('is null for a job that is not generated', () => {
    expect(generateStageMark(makeJob({ state: 'editing', step: 3 }))).toBeNull();
    expect(isGeneratedJob(makeJob())).toBe(false);
  });

  it('follows the job through the stage', () => {
    expect(generateStageMark(generating())).toBe('running');
    expect(generateStageMark(generating({ step: 4, subProgress: null }))).toBe('done');
    expect(generateStageMark(generating({ subProgress: 'reading 9 files' }))).toBe('pending');
    expect(generateStageMark(stopped(generateErrorMessage('balance_empty')))).toBe('failed');
    expect(
      generateStageMark(
        makeJob({ state: 'review', generate: makeGenerateState({ phase: 'done' }) }),
      ),
    ).toBe('done');
    expect(generateStageMark(makeJob({ state: 'queued', generate: makeGenerateState() }))).toBe(
      'pending',
    );
  });

  it('is stopped for a job cancelled during the stage, done for one cancelled later', () => {
    const cancelled = makeJob({ state: 'cancelled', stoppedAt: 1, generate: makeGenerateState() });
    expect(generateStageMark(cancelled)).toBe('stopped');
    expect(generateStageMark({ ...cancelled, stoppedAt: 5 })).toBe('done');
  });

  it('is done for a job that failed after the stage', () => {
    expect(
      generateStageMark(
        makeJob({ state: 'failed', failedAt: 5, error: 'x', generate: makeGenerateState() }),
      ),
    ).toBe('done');
  });
});

describe('generateProgressPct', () => {
  it('grows through the phases and ends at 100', () => {
    const base = makeGenerateState().counts;
    const pct = (phase: Parameters<typeof makeGenerateState>[0] = {}) =>
      generateProgressPct(makeGenerateState(phase));
    const values = [
      pct({ phase: 'plan' }),
      pct({ phase: 'voice', counts: { ...base, voice: { done: 0, total: 7 } } }),
      pct({ phase: 'voice', counts: { ...base, voice: { done: 7, total: 7 } } }),
      pct({ phase: 'looks', counts: { ...base, looks: { done: 1, total: 3 } } }),
      pct({ phase: 'keyframes', counts: { ...base, keyframes: { done: 5, total: 7 } } }),
      pct({ phase: 'clips' }),
      pct({ phase: 'sound' }),
      pct({ phase: 'done' }),
    ];
    expect(values).toEqual([3, 5, 20, 23, 41, 78, 96, 100]);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('does not divide by zero before the plan is made', () => {
    const state = makeGenerateState({
      phase: 'voice',
      counts: { ...makeGenerateState().counts, voice: { done: 0, total: 0 } },
    });
    expect(generateProgressPct(state)).toBe(5);
  });
});

describe('generateStopPlace and the bar text', () => {
  it('says where the stage stopped', () => {
    expect(generateStopPlace(makeGenerateState())).toBe('clips 4/6');
    expect(generateStopPlace(makeGenerateState(), 'over_budget')).toBe('before any clip');
    expect(
      generateStopPlace(
        makeGenerateState({
          counts: { ...makeGenerateState().counts, clips: { done: 0, total: 6 } },
        }),
      ),
    ).toBe('before any clip');
    expect(
      generateStopPlace(
        makeGenerateState({
          phase: 'voice',
          counts: { ...makeGenerateState().counts, voice: { done: 3, total: 7 } },
        }),
      ),
    ).toBe('voice 3/7');
  });

  it('puts the money on the right of the bar from the clips on', () => {
    expect(generateBarRight(makeGenerateState())).toBe('$1.65 of $3');
    expect(generateBarRight(makeGenerateState({ phase: 'voice', spendUsd: 0 }))).toBe('');
  });
});

describe('generatePing', () => {
  const name = '97 Window Ad';

  it('is null for any other failure', () => {
    expect(
      generatePing(makeJob({ name, state: 'failed', failedAt: 8, error: 'Disk is full.' })),
    ).toBeNull();
  });

  it('says the balance is empty and how many clips are kept', () => {
    expect(generatePing(stopped(generateErrorMessage('balance_empty'), { name }))).toEqual({
      title: '97 Window Ad stopped',
      body: 'The Higgsfield balance is empty. Add funds in the Higgsfield console, then press Retry. The 4 clips made are kept.',
    });
  });

  it('leaves the kept clips out when none was made, and says 1 clip for one', () => {
    const none = stopped(generateErrorMessage('balance_empty'), {
      name,
      generate: makeGenerateState({
        counts: { ...makeGenerateState().counts, clips: { done: 0, total: 6 } },
      }),
    });
    expect(generatePing(none)?.body).toBe(
      'The Higgsfield balance is empty. Add funds in the Higgsfield console, then press Retry.',
    );
    const one = stopped(generateErrorMessage('balance_empty'), {
      name,
      generate: makeGenerateState({
        counts: { ...makeGenerateState().counts, clips: { done: 1, total: 6 } },
      }),
    });
    expect(generatePing(one)?.body).toMatch(/The 1 clip made is kept\.$/);
  });

  it('says the key was not accepted, naming only the variable', () => {
    const ping = generatePing(stopped(generateErrorMessage('key_rejected'), { name }));
    expect(ping?.body).toBe(
      'Higgsfield did not accept the key. Check HIGGSFIELD_API_KEY in .env, then press Retry.',
    );
  });

  it('says what an over-budget video needs', () => {
    const ping = generatePing(
      stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }), { name }),
    );
    expect(ping?.body).toBe(
      'This video needs about $4.10, over the budget of $3. Add a note like “budget $5”, then press Retry.',
    );
  });

  it('has words for ElevenLabs and for the other codes', () => {
    expect(
      generatePing(
        stopped(generateErrorMessage('balance_empty', { service: 'elevenlabs' }), { name }),
      )?.body,
    ).toContain('ElevenLabs credits are used up');
    expect(generatePing(stopped(generateErrorMessage('unavailable'), { name }))?.body).toContain(
      'Higgsfield is not answering',
    );
    expect(generatePing(stopped(generateErrorMessage('bad_request'), { name }))?.body).toBe(
      'Higgsfield did not accept a request. Press Retry once.',
    );
    expect(
      generatePing(stopped(generateErrorMessage('generation_failed'), { name }))?.body,
    ).toContain('could not make a shot');
    expect(generatePing(stopped('Generate stopped: it was stopped.', { name }))?.body).toBe(
      'Generate stopped. Open the job to see why.',
    );
  });

  it('never carries a key, a path or a client', () => {
    const ping = generatePing(
      stopped(generateErrorMessage('key_rejected', { service: 'elevenlabs' }), {
        name,
        client: 'Pinewood',
      }),
    );
    expect(JSON.stringify(ping)).not.toContain('Pinewood');
    expect(JSON.stringify(ping)).not.toContain('/Users');
  });
});
