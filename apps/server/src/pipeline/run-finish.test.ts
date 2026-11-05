import { describe, expect, it } from 'vitest';
import { runFinishOf } from './run-finish.js';

describe('runFinishOf', () => {
  it.each([
    ['edit', false, 'final'],
    ['edit', true, 'preview'],
    ['revise', false, 'preview'],
    ['revise', true, 'preview'],
    ['render', false, 'final'],
    ['render', true, 'final'],
  ] as const)('%s run, Review switch %s: %s', (kind, review, finish) => {
    expect(runFinishOf(kind, review)).toBe(finish);
  });
});
