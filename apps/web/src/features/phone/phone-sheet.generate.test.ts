import { generateErrorMessage } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGenerateState, makeJob } from '@/data/test-utils';
import { phoneDetail } from './phone-jobs';
import { phoneMeta, phonePill, phoneSteps, segmentClasses } from './phone-sheet';

// A generated job on the phone job sheet (Generated videos, GN9).

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

describe('the phone sheet of a generated job', () => {
  it('has nine segments, Generate the second', () => {
    const steps = phoneSteps(generating());
    expect(steps).toEqual({
      total: 9,
      done: 1,
      mark: 'running',
      text: 'Generate · clips 4/6 · $1.65 · step 2 of 9',
    });
    const classes = segmentClasses(steps ?? { done: 0, mark: null, text: '' }).map(
      (segment) => segment.className,
    );
    expect(classes).toEqual([
      'bg-status-editing',
      'bg-status-editing/45',
      ...Array(7).fill('bg-muted'),
    ]);
  });

  it('counts the steps after Brief one further once Generate is done', () => {
    const steps = phoneSteps(
      makeJob({
        state: 'editing',
        step: 5,
        subProgress: 'graphics 2/5',
        generate: makeGenerateState({ phase: 'done' }),
      }),
    );
    expect(steps).toEqual({
      total: 9,
      done: 5,
      mark: 'running',
      text: 'Cut · graphics 2/5 · step 6 of 9',
    });
  });

  it('shows the stop on the Generate segment in red', () => {
    const steps = phoneSteps(stopped(generateErrorMessage('balance_empty')));
    expect(steps).toEqual({
      total: 9,
      done: 1,
      mark: 'failed',
      text: '1 of 9 done, stopped at Generate',
    });
    const classes = segmentClasses(steps ?? { done: 0, mark: null, text: '' });
    expect(classes[1]?.className).toBe('bg-status-failed');
    expect(classes).toHaveLength(9);
  });

  it('keeps eight segments for a job that is not generated, and a Brief that failed', () => {
    const plain = phoneSteps(makeJob({ state: 'editing', step: 5, subProgress: 'graphics 2/5' }));
    expect(plain).toEqual({
      done: 4,
      mark: 'running',
      text: 'Cut · graphics 2/5 · step 5 of 8',
    });
    expect(plain).not.toHaveProperty('total');
    expect(segmentClasses(plain ?? { done: 0, mark: null, text: '' })).toHaveLength(8);
    const briefFailed = phoneSteps(
      makeJob({ state: 'failed', failedAt: 1, error: 'Disk is full.' }),
    );
    expect(briefFailed?.text).toBe('0 of 8 done, stopped at Brief');
  });

  it('says where a job that stopped in Generate failed, in its pill', () => {
    expect(phonePill(stopped(generateErrorMessage('balance_empty'))).label).toBe(
      'Failed at Generate',
    );
    expect(phonePill(makeJob({ state: 'failed', failedAt: 1, error: 'Disk is full.' })).label).toBe(
      'Failed at Brief',
    );
    expect(
      phonePill(makeJob({ state: 'cancelled', stoppedAt: 1, generate: makeGenerateState() })).label,
    ).toBe('Cancelled at Generate');
  });

  it('shows the money next to the pill while the clips are made', () => {
    expect(phoneMeta(generating(), [], Date.now())).toBe('$1.65 of $3');
    expect(
      phoneMeta(
        generating({
          subProgress: 'Generate · voice 3/7',
          generate: makeGenerateState({ phase: 'voice', spendUsd: 0 }),
        }),
        [],
        Date.now(),
      ),
    ).toBe('');
  });

  it('says the same as the Mac on the phone’s row', () => {
    expect(phoneDetail(generating(), Date.now())).toBe('Generate · clips 4/6 · $1.65');
    expect(phoneDetail(stopped(generateErrorMessage('balance_empty')), Date.now())).toBe(
      'Higgsfield balance is empty',
    );
  });
});
