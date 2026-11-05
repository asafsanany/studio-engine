import { describe, expect, it } from 'vitest';
import { pageOfJob } from './job-sheet-order';

describe('pageOfJob', () => {
  const ids = Array.from({ length: 23 }, (_, i) => `j${i}`);

  it('is the zero-based page the job is on', () => {
    expect(pageOfJob(ids, 'j0', 10)).toBe(0);
    expect(pageOfJob(ids, 'j9', 10)).toBe(0);
    expect(pageOfJob(ids, 'j10', 10)).toBe(1);
    expect(pageOfJob(ids, 'j22', 10)).toBe(2);
  });

  it('is null for a job the list does not show', () => {
    expect(pageOfJob(ids, 'nope', 10)).toBeNull();
  });
});
