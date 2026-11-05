import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FIRST_STEP_BY_RUN_KIND,
  firstStepOf,
  RUN_KINDS,
  type RunKind,
  runKindSchema,
} from './run-kind.ts';
import { STEP_LABELS } from './steps.ts';

describe('RunKind', () => {
  it('lists edit, revise, render in the order the runs happen', () => {
    expect(RUN_KINDS).toEqual(['edit', 'revise', 'render']);
  });

  it('accepts every kind', () => {
    for (const kind of RUN_KINDS) expect(runKindSchema.parse(kind)).toBe(kind);
  });

  it.each(['final', 'Edit', '', null, undefined, 1])('rejects %j', (value) => {
    expect(runKindSchema.safeParse(value).success).toBe(false);
  });

  it('infers the union', () => {
    expectTypeOf<RunKind>().toEqualTypeOf<'edit' | 'revise' | 'render'>();
  });
});

describe('firstStepOf', () => {
  it.each([
    ['edit', 1, 'Brief'],
    ['revise', 4, 'Plan'],
    ['render', 8, 'Render'],
  ] as const)('a %s run starts at step %i (%s)', (kind, step, label) => {
    expect(firstStepOf(kind)).toBe(step);
    expect(STEP_LABELS[firstStepOf(kind)]).toBe(label);
  });

  it('has one first step per kind', () => {
    expect(Object.keys(FIRST_STEP_BY_RUN_KIND)).toEqual([...RUN_KINDS]);
  });
});
