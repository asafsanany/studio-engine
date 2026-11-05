import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CHECK_STEP,
  PREVIEW_STEP,
  RENDER_STEP,
  STEP_IDS,
  STEP_LABELS,
  STEPS,
  type StepId,
  stepIdSchema,
} from './steps.ts';

describe('StepId', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts %i', (id) => {
    expect(stepIdSchema.parse(id)).toBe(id);
  });

  it.each([0, 9, -1, 1.5, '3', null, undefined, Number.NaN])('rejects %j', (value) => {
    expect(stepIdSchema.safeParse(value).success).toBe(false);
  });

  it('infers the 1-8 literal union', () => {
    expectTypeOf<StepId>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>();
  });

  it('STEP_IDS is 1 to 8', () => {
    expect(STEP_IDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('STEPS', () => {
  it('has the approved labels in order', () => {
    expect(STEPS.map((step) => step.label)).toEqual([
      'Brief',
      'Transcribe',
      'Scan',
      'Plan',
      'Cut',
      'Preview',
      'Check',
      'Render',
    ]);
  });

  it('numbers the steps 1 to 8 in order', () => {
    expect(STEPS.map((step) => step.id)).toEqual([...STEP_IDS]);
  });

  it('STEP_LABELS looks a label up by id', () => {
    expect(STEP_LABELS[1]).toBe('Brief');
    expect(STEP_LABELS[2]).toBe('Transcribe');
    expect(STEP_LABELS[5]).toBe('Cut');
    expect(STEP_LABELS[8]).toBe('Render');
    expect(Object.keys(STEP_LABELS)).toHaveLength(8);
    expectTypeOf(STEP_LABELS[1]).toEqualTypeOf<
      'Brief' | 'Transcribe' | 'Scan' | 'Plan' | 'Cut' | 'Preview' | 'Check' | 'Render'
    >();
  });
});

describe('RENDER_STEP', () => {
  it('is the last step, and it is Render', () => {
    expect(RENDER_STEP).toBe(STEP_IDS[STEP_IDS.length - 1]);
    expect(STEP_LABELS[RENDER_STEP]).toBe('Render');
  });
});

describe('PREVIEW_STEP and CHECK_STEP', () => {
  it('Preview is step 6', () => {
    expect(PREVIEW_STEP).toBe(6);
    expect(STEP_LABELS[PREVIEW_STEP]).toBe('Preview');
  });

  it('Check is step 7, the one before Render', () => {
    expect(CHECK_STEP).toBe(7);
    expect(STEP_LABELS[CHECK_STEP]).toBe('Check');
    expect(CHECK_STEP).toBe(RENDER_STEP - 1);
  });
});
