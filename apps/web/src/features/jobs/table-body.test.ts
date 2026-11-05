import { describe, expect, it } from 'vitest';
import { showsPagination, tableBodyState } from './table-body';
import { CANVAS_JOBS } from './test-jobs';

describe('tableBodyState', () => {
  it('is loading until the first answer', () => {
    expect(tableBodyState({ jobs: undefined, failed: false, matching: 0 })).toBe('loading');
  });

  it('is unreachable when the first answer failed', () => {
    expect(tableBodyState({ jobs: undefined, failed: true, matching: 0 })).toBe('unreachable');
  });

  it('is empty when the list is empty, however the filters stand', () => {
    expect(tableBodyState({ jobs: [], failed: false, matching: 0 })).toBe('empty');
  });

  it('is no-match when there are jobs but none passes the tab and the search', () => {
    expect(tableBodyState({ jobs: CANVAS_JOBS, failed: false, matching: 0 })).toBe('no-match');
  });

  it('is rows when at least one job passes', () => {
    expect(tableBodyState({ jobs: CANVAS_JOBS, failed: false, matching: 1 })).toBe('rows');
    expect(tableBodyState({ jobs: CANVAS_JOBS, failed: false, matching: 12 })).toBe('rows');
  });

  it('never replaces a list that has arrived with the failure: a failed refetch keeps the table', () => {
    expect(tableBodyState({ jobs: CANVAS_JOBS, failed: true, matching: 12 })).toBe('rows');
    expect(tableBodyState({ jobs: CANVAS_JOBS, failed: true, matching: 0 })).toBe('no-match');
    expect(tableBodyState({ jobs: [], failed: true, matching: 0 })).toBe('empty');
  });
});

describe('showsPagination', () => {
  it('shows the range and page controls with rows and with "No matching jobs."', () => {
    expect(showsPagination('rows')).toBe(true);
    expect(showsPagination('no-match')).toBe(true);
  });

  it('hides them with no jobs at all, while loading and when the engine cannot be reached', () => {
    expect(showsPagination('empty')).toBe(false);
    expect(showsPagination('loading')).toBe(false);
    expect(showsPagination('unreachable')).toBe(false);
  });
});
