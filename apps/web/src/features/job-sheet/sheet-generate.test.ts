import {
  type GenerateHistoryEvent,
  type GenerateNotePlan,
  generateErrorMessage,
  type Job,
  type JobStepRun,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGenerateState, makeJob, makeReviewNote } from '@/data/test-utils';
import { belowBarNote, GENERATED_TEXT, sheetGenerated } from './sheet-generated';
import { historyRows } from './sheet-history';
import { sentRounds } from './sheet-notes';
import { sheetError, sheetFiles, sheetNow } from './sheet-now';
import { buildSteps } from './sheet-steps';

// A generated job on the job sheet (Generated videos, GN9; board GNSheet). The times are the board's
// own: Generate began at 14:01, the Brief ended there.

const UTC = 'UTC';
const at = (hhmm: string): string => `2026-10-21T${hhmm}:00.000Z`;
const ms = (hhmm: string): number => Date.parse(at(hhmm));

const run = (
  step: JobStepRun['step'],
  start: string,
  end: string | null,
  round = 0,
): JobStepRun => ({
  step,
  runKind: 'edit',
  round,
  startedAt: at(start),
  endedAt: end === null ? null : at(end),
});

const BRIEF = run(1, '14:00', '14:01');

const generating = (overrides: Partial<Job> = {}): Job =>
  makeJob({
    state: 'editing',
    step: 1,
    subProgress: 'Generate · clips 4/6 · $1.65',
    generate: makeGenerateState(),
    updatedAt: at('14:21'),
    ...overrides,
  });

const stopped = (message: string, overrides: Partial<Job> = {}): Job =>
  makeJob({
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: message,
    generate: makeGenerateState(),
    updatedAt: at('14:21'),
    ...overrides,
  });

const rows = (job: Job, runs: readonly JobStepRun[], now: string) =>
  buildSteps(job, runs, { now: ms(now), timeZone: UTC }).rows;
const generateRowOf = (job: Job, runs: readonly JobStepRun[], now = '14:19') =>
  rows(job, runs, now).find((row) => row.key === 'generate');

describe('the Generate row of Steps', () => {
  it('sits between Brief and Transcribe, for a generated job only', () => {
    const names = rows(generating(), [BRIEF], '14:19').map((row) => row.name);
    expect(names.slice(0, 3)).toEqual(['Brief', 'Generate', 'Transcribe']);
    const plain = makeJob({ state: 'editing', step: 1, subProgress: 'reading 9 files' });
    expect(rows(plain, [BRIEF], '14:19').map((row) => row.name)).not.toContain('Generate');
  });

  it('runs: "now · 18 min so far" with the Brief behind it, "now · voice 3/7" in the voice', () => {
    expect(generateRowOf(generating(), [BRIEF])).toMatchObject({
      kind: 'running',
      step: null,
      text: 'now · 18 min so far',
    });
    const voice = generating({
      subProgress: 'Generate · voice 3/7',
      generate: makeGenerateState({
        phase: 'voice',
        counts: { ...makeGenerateState().counts, voice: { done: 3, total: 7 } },
      }),
    });
    expect(generateRowOf(voice, [BRIEF])?.text).toBe('now · voice 3/7');
  });

  it('says only "now" when it has just begun', () => {
    expect(generateRowOf(generating(), [BRIEF], '14:01')?.text).toBe('now');
  });

  it('is done with its start and length once the edit has begun', () => {
    const done = generating({
      step: 5,
      subProgress: 'graphics 2/5',
      generate: makeGenerateState({ phase: 'done' }),
    });
    const runs = [BRIEF, run(2, '14:32', '14:33'), run(3, '14:33', '14:35')];
    expect(generateRowOf(done, runs, '14:40')).toMatchObject({
      kind: 'done',
      text: '14:01 · 31 min',
    });
  });

  it('is done with just its start when nothing has run after it', () => {
    const review = makeJob({
      state: 'review',
      step: 7,
      generate: makeGenerateState({ phase: 'done' }),
    });
    expect(generateRowOf(review, [BRIEF])?.text).toBe('14:01');
    expect(generateRowOf(review, [])).toMatchObject({ kind: 'done', text: '' });
  });

  it('fails with when and where: "stopped 14:21 · clips 4/6"', () => {
    const row = generateRowOf(stopped(generateErrorMessage('balance_empty')), [BRIEF], '14:22');
    expect(row).toMatchObject({ kind: 'failed', text: 'stopped 14:21 · clips 4/6' });
  });

  it('fails "before any clip" for an over-budget stop', () => {
    const over = stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }), {
      updatedAt: at('14:04'),
      generate: makeGenerateState({
        phase: 'looks',
        counts: { ...makeGenerateState().counts, clips: { done: 0, total: 6 } },
      }),
    });
    expect(generateRowOf(over, [BRIEF], '14:05')?.text).toBe('stopped 14:04 · before any clip');
  });

  it('leaves the Brief and every other step as they were while Generate fails', () => {
    const list = rows(stopped(generateErrorMessage('balance_empty')), [BRIEF], '14:22');
    expect(list.filter((row) => row.key !== 'generate').map((row) => [row.name, row.kind])).toEqual(
      [
        ['Brief', 'done'],
        ['Transcribe', 'pending'],
        ['Scan', 'pending'],
        ['Plan', 'pending'],
        ['Cut', 'pending'],
        ['Preview', 'pending'],
        ['Check', 'pending'],
        ['Render', 'pending'],
      ],
    );
  });

  it('counts the stage among the steps of a finished job: "All 9 steps done"', () => {
    const ready = makeJob({
      state: 'ready',
      step: 8,
      runKind: 'render',
      generate: makeGenerateState({ phase: 'done' }),
    });
    expect(buildSteps(ready, [BRIEF], { now: ms('15:30'), timeZone: UTC }).summary).toMatch(
      /^All 9 steps done/,
    );
    const footage = makeJob({ state: 'ready', step: 8, runKind: 'render' });
    expect(buildSteps(footage, [BRIEF], { now: ms('15:30'), timeZone: UTC }).summary).toMatch(
      /^All 8 steps done/,
    );
  });

  it('is only in the first cut of a job in a later round', () => {
    const revising = makeJob({
      state: 'editing',
      step: 5,
      round: 1,
      runKind: 'revise',
      generate: makeGenerateState({ phase: 'done' }),
    });
    expect(
      rows(revising, [run(4, '15:00', '15:05', 1)], '15:06').map((row) => row.name),
    ).not.toContain('Generate');
  });
});

describe('what the sheet says while a job is generated', () => {
  const NOW = ms('14:19');
  const sentence = (job: Job, history?: readonly GenerateHistoryEvent[]) =>
    sheetNow(job, [], NOW, {
      timeZone: UTC,
      ...(history === undefined ? {} : { generateHistory: history }),
    });

  it('names what is made, with the stage’s own bar and the money on its right', () => {
    const now = sentence(generating());
    expect(now.sentence).toBe(
      'Generating the clips in Higgsfield: 4 of 6 done. One take each, checked frame by frame; a retake only when the check fails.',
    );
    expect(now.progress).toEqual({
      pct: 78,
      label: 'Generate · clips 4/6',
      right: '$1.65 of $3',
      tone: 'blue',
    });
  });

  it('says when the stage began before any money is spent', () => {
    const voice = generating({
      subProgress: 'Generate · voice 3/7',
      generate: makeGenerateState({
        phase: 'voice',
        spendUsd: 0,
        counts: { ...makeGenerateState().counts, voice: { done: 3, total: 7 } },
      }),
    });
    const history: GenerateHistoryEvent[] = [{ kind: 'decided', at: at('14:01'), formats: null }];
    expect(sentence(voice, history).progress).toMatchObject({
      label: 'Generate · voice 3/7',
      right: 'started 14:01',
    });
    expect(sentence(voice).progress?.right).toBe('');
  });

  it('is the ordinary Brief sentence while the Brief is still read', () => {
    const brief = generating({ subProgress: 'reading 9 files' });
    expect(sentence(brief).sentence).toBe('Writing the brief.');
  });

  it('says why it stopped, when, and what Retry keeps', () => {
    expect(sentence(stopped(generateErrorMessage('balance_empty'))).sentence).toBe(
      'Stopped at 14:21: the Higgsfield balance is empty. The 4 clips already made are kept, so Retry only makes the other 2.',
    );
    expect(
      sentence(stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 })))
        .sentence,
    ).toBe(
      'Stopped before any clip: one take of every clip needs about $4.10, over the budget of $3, even with the cheaper models.',
    );
    expect(sentence(stopped('Generate stopped: it was stopped.')).sentence).toBe(
      'Generate stopped at 14:21. The Brief is kept, so Retry starts at Generate.',
    );
  });

  it('keeps the ordinary sentence for a failure of any other step', () => {
    const failed = makeJob({ state: 'failed', failedAt: 5, error: 'x', updatedAt: at('14:21') });
    expect(sentence(failed).sentence).toBe(
      'Cut stopped at 14:21. Steps 1 to 4 are kept, so Retry starts at Cut.',
    );
  });
});

describe('the review and approved sentences of a generated job', () => {
  const preview = { durationSec: 35, width: 1080, height: 1920 };
  const FORMATS = [
    { id: '9x16', label: '9:16', width: 1080, height: 1920, previewPath: 'preview/index.html' },
    { id: '1x1', label: '1:1', width: 1080, height: 1080, previewPath: 'preview/1x1/index.html' },
  ];
  const sentence = (job: Job) => sheetNow(job, [], ms('15:00'), { timeZone: UTC }).sentence;

  it('names the formats, and the budget that ran out with a clip below the bar', () => {
    const job = makeJob({
      state: 'review',
      preview,
      formats: FORMATS,
      generate: makeGenerateState({
        phase: 'done',
        spendUsd: 3,
        counts: { ...makeGenerateState().counts, clips: { done: 6, total: 6 }, belowBar: 1 },
      }),
    });
    expect(sentence(job)).toBe(
      'The first cut is ready, 0:35, in 9:16 and 1:1. Both files are made after you approve it. The $3 budget ran out with 1 clip below the bar; it kept its best take. Say in a note if it needs another.',
    );
  });

  it('is the ordinary sentence for a job with one format and nothing below the bar', () => {
    const plain = makeJob({ state: 'review', preview });
    expect(sentence(plain)).toBe(
      'The first cut is ready, 0:35. The MP4 is made after you approve it.',
    );
    const generated = makeJob({
      state: 'review',
      preview,
      generate: makeGenerateState({ phase: 'done' }),
    });
    expect(sentence(generated)).toBe(sentence(plain));
  });

  it('says two files were rendered, one for each format', () => {
    const job = makeJob({
      state: 'ready',
      client: 'Pinewood',
      formats: FORMATS,
      output: {
        fileName: 'Pinewood/97 Window Ad.mp4',
        durationSec: 35,
        width: 1080,
        height: 1920,
        sizeBytes: 27_000_000,
        outputs: [
          { format: '9x16', fileName: 'Pinewood/97 Window Ad.mp4', bytes: 27_000_000 },
          { format: '1x1', fileName: 'Pinewood/97 Window Ad (1x1).mp4', bytes: 21_000_000 },
        ],
      },
    });
    expect(sentence(job)).toBe(
      'Approved and rendered. Two files, one for each format the brief asked for. They haven’t been sent to Pinewood yet.',
    );
    expect(sheetFiles({ ...job, id: 'gn1', name: '97 Window Ad' })).toEqual([
      {
        format: '9x16',
        name: '97 Window Ad.mp4',
        sub: '9:16 · 1080 × 1920 · 0:35 · 27 MB',
        href: '/api/jobs/gn1/download?format=9x16',
        label: 'Download 9:16',
      },
      {
        format: '1x1',
        name: '97 Window Ad (1x1).mp4',
        sub: '1:1 · 1080 × 1080 · 0:35 · 21 MB',
        href: '/api/jobs/gn1/download?format=1x1',
        label: 'Download 1:1',
      },
    ]);
  });

  it('has no files list for a job with one file, or one that is not ready', () => {
    const one = makeJob({
      state: 'ready',
      output: { fileName: 'a.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 },
    });
    expect(sheetFiles(one)).toEqual([]);
    expect(sheetFiles(makeJob({ state: 'review' }))).toEqual([]);
  });
});

describe('the error box of a job that stopped in Generate', () => {
  it('has the board’s title, code line and help for the balance', () => {
    expect(sheetError(stopped(generateErrorMessage('balance_empty')), UTC)).toEqual({
      title: 'Higgsfield balance is empty',
      text: generateErrorMessage('balance_empty'),
      line: 'HTTP 403 · Insufficient balance',
      help: 'Add funds in the Higgsfield console (console.higgsfield.ai), then press Retry. The request that stopped wasn’t charged.',
    });
  });

  it('has the dollars of an over-budget stop', () => {
    const error = sheetError(
      stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 })),
      UTC,
    );
    expect(error).toMatchObject({
      title: 'Over the budget',
      line: 'Needs about $4.10 · budget $3',
      help: 'Add a note like “budget $5” in Note for the editor, then press Retry. The voice is kept.',
    });
  });

  it('is the ordinary box for a stop with no code, and for any other failure', () => {
    expect(sheetError(stopped('Generate stopped: it was stopped.'), UTC)).toEqual({
      title: 'Generate stopped · 14:21',
      text: 'Generate stopped: it was stopped.',
    });
    expect(
      sheetError(
        makeJob({ state: 'failed', failedAt: 8, error: 'Disk is full.', updatedAt: at('12:52') }),
        UTC,
      ),
    ).toEqual({ title: 'Failed at Render · 12:52', text: 'Disk is full.' });
  });
});

describe('the Generated part', () => {
  it('is for a generated job only', () => {
    expect(sheetGenerated(makeJob())).toBeNull();
    expect(sheetGenerated(generating())).not.toBeNull();
    expect(GENERATED_TEXT.services).toBe('Higgsfield · ElevenLabs');
  });

  it('reads like the board while the clips are made', () => {
    const view = sheetGenerated(generating(), {
      history: [{ kind: 'voice', at: at('14:03'), lines: 7, seconds: 31 }],
    });
    expect(view?.rows.map((row) => [row.key, row.value])).toEqual([
      ['Voice', '7 lines · 0:31'],
      ['Looks', '3 stills'],
      ['Keyframes', '7 for 6 clips'],
      ['Clips', '4 of 6'],
      ['Spend', '$1.65 of $3'],
    ]);
    expect(view?.rows[3]).toMatchObject({ barPercent: 67 });
    expect(view?.rows[4]).toMatchObject({ barPercent: 55 });
  });

  it('keeps what a stopped run made and greys its bars', () => {
    const view = sheetGenerated(stopped(generateErrorMessage('balance_empty')));
    expect(view?.rows[3]).toMatchObject({ value: '4 of 6 · kept', barTone: 'muted' });
    expect(view?.rows[4]).toMatchObject({ value: '$1.65 of $3', barTone: 'muted' });
  });

  it('turns Spend red with the estimate when the stop was the budget', () => {
    const view = sheetGenerated(
      stopped(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }), {
        generate: makeGenerateState({
          phase: 'voice',
          spendUsd: 0,
          counts: {
            voice: { done: 7, total: 7 },
            looks: { done: 0, total: 0 },
            keyframes: { done: 0, total: 0 },
            clips: { done: 0, total: 6 },
            belowBar: 0,
          },
        }),
      }),
    );
    expect(view?.rows.at(-1)).toMatchObject({
      key: 'Spend',
      value: '$0 of $3',
      tone: 'error',
      sub: 'The estimate for one take of every clip is $4.10.',
    });
  });

  it('names the clip below the bar and when it is on screen', () => {
    const plan: GenerateNotePlan = {
      clips: [
        { id: 'A', usd: 0.36, belowBar: false, windows: [{ startSec: 0, endSec: 3 }] },
        {
          id: 'B',
          usd: 0.51,
          shows: 'The pour and the tilt up',
          belowBar: true,
          windows: [{ startSec: 3, endSec: 8 }],
        },
      ],
      lines: [],
    };
    expect(belowBarNote(plan)).toBe('Clip B: the pour and the tilt up, 0:03 to 0:08.');
    expect(belowBarNote({ clips: [{ id: 'B', usd: 1, windows: [] }], lines: [] })).toBeNull();
    expect(belowBarNote(null)).toBeNull();
    const done = makeJob({
      state: 'review',
      generate: makeGenerateState({
        phase: 'done',
        spendUsd: 3,
        counts: { ...makeGenerateState().counts, clips: { done: 6, total: 6 }, belowBar: 1 },
      }),
    });
    const rows = sheetGenerated(done, { plan })?.rows;
    expect(rows?.[3]).toMatchObject({
      value: '6 of 6 · 1 below the bar',
      tone: 'warn',
      sub: 'Clip B: the pour and the tilt up, 0:03 to 0:08.',
    });
    expect(rows?.[4]).toMatchObject({
      value: '$3.00 of $3',
      barTone: 'warn',
      sub: 'Nothing is left for retakes. A note like “budget $5” makes another take possible.',
    });
  });

  it('leaves a shown sentence as it is when it starts with a capital word', () => {
    expect(
      belowBarNote({
        clips: [{ id: 'C', usd: 1, shows: 'PINEWOOD logo', belowBar: true, windows: [] }],
        lines: [],
      }),
    ).toBe('Clip C: PINEWOOD logo.');
  });
});

describe('History of a generated job', () => {
  const EVENTS: GenerateHistoryEvent[] = [
    { kind: 'decided', at: at('14:00'), formats: ['9:16', '1:1'] },
    { kind: 'voice', at: at('14:03'), lines: 7, seconds: 31 },
    { kind: 'stopped', at: at('14:21'), code: 'balance_empty' },
    { kind: 'budget', at: at('14:30'), id: 'B' },
  ];
  const history = (job: Job, generate?: readonly GenerateHistoryEvent[]) =>
    historyRows(
      { job, runs: [BRIEF], notes: undefined, ...(generate ? { generate } : {}) },
      ms('15:00'),
      UTC,
    );
  const ofStage = (rows: ReturnType<typeof history>) =>
    rows.filter((row) => row.id.startsWith('generate-'));

  it('puts the stage’s lines among the others by their time, in the board’s words', () => {
    const rows = history(stopped(generateErrorMessage('balance_empty')), EVENTS);
    expect(ofStage(rows).map((row) => [row.time, row.text, row.tone])).toEqual([
      [
        '14:00',
        'The brief found no footage and a script, so the video is generated. 9:16 and 1:1 asked for.',
        undefined,
      ],
      [
        '14:03',
        'Voice made: 7 lines, 0:31 of speech. Every word checked against the script',
        undefined,
      ],
      ['14:21', 'Stopped: the Higgsfield balance is empty', 'failure'],
      ['14:30', 'Budget reached: clip B kept its best take, below the bar', 'warn'],
    ]);
    // Among the other rows, in time order: the stage's lines come after "Started" (14:00).
    expect(rows.map((row) => row.id)).toEqual([
      'appeared',
      'settled',
      'started',
      'generate-0',
      'generate-1',
      'generate-2',
      'generate-3',
    ]);
  });

  it('leaves out “Brief failed” when the stage’s own stop is a line', () => {
    const rows = history(stopped(generateErrorMessage('balance_empty')), EVENTS);
    expect(rows.some((row) => row.id === 'failed')).toBe(false);
  });

  it('says “Generate failed” for a stop the stage has no line for yet', () => {
    const rows = history(stopped(generateErrorMessage('balance_empty')));
    expect(rows.find((row) => row.id === 'failed')).toMatchObject({
      text: 'Generate failed',
      tone: 'failure',
    });
  });

  it('keeps “<Step> failed” for any other failure, and is unchanged without events', () => {
    const other = makeJob({ state: 'failed', failedAt: 5, error: 'x', updatedAt: at('14:21') });
    expect(history(other).find((row) => row.id === 'failed')?.text).toBe('Cut failed');
    expect(ofStage(history(makeJob()))).toEqual([]);
  });
});

describe('the sent notes of a job with two formats', () => {
  const FORMATS = [
    { id: '9x16', label: '9:16', width: 1080, height: 1920, previewPath: 'preview/index.html' },
    { id: '1x1', label: '1:1', width: 1080, height: 1080, previewPath: 'preview/1x1/index.html' },
  ];
  const sent = (id: string, atSec: number, format: string | null) =>
    makeReviewNote({ id, atSec, round: 1, sentAt: at('14:55'), text: id, format });

  it('prints the format a note was written on after its time, like Review: "0:32 1:1"', () => {
    const rounds = sentRounds(
      [sent('a', 2.4, null), sent('b', 32, '1x1')],
      ms('15:00'),
      UTC,
      FORMATS,
    );
    expect(rounds[0]?.notes.map((note) => [note.time, note.formatLabel])).toEqual([
      ['0:02', undefined],
      ['0:32', '1:1'],
    ]);
  });

  it('prints nothing on a job with one format', () => {
    const rounds = sentRounds([sent('b', 32, '1x1')], ms('15:00'), UTC);
    expect(rounds[0]?.notes[0]).not.toHaveProperty('formatLabel');
  });
});
