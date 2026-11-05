import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusJobRow, rowToFocus } from './row-focus';

const IDS = ['a', 'b', 'c', 'd'];

describe('rowToFocus', () => {
  it('moves down and up one row', () => {
    expect(rowToFocus(IDS, 'b', 'ArrowDown')).toBe('c');
    expect(rowToFocus(IDS, 'b', 'ArrowUp')).toBe('a');
  });

  it('stays on the first and the last row at the ends', () => {
    expect(rowToFocus(IDS, 'd', 'ArrowDown')).toBe('d');
    expect(rowToFocus(IDS, 'a', 'ArrowUp')).toBe('a');
  });

  it('goes to the first row on Home and the last on End', () => {
    expect(rowToFocus(IDS, 'c', 'Home')).toBe('a');
    expect(rowToFocus(IDS, 'b', 'End')).toBe('d');
  });

  it('starts at the top when no row has the focus', () => {
    expect(rowToFocus(IDS, null, 'ArrowDown')).toBe('a');
    expect(rowToFocus(IDS, 'gone', 'ArrowDown')).toBe('a');
  });

  it('has nowhere to go for another key or an empty list', () => {
    expect(rowToFocus(IDS, 'b', 'Enter')).toBeNull();
    expect(rowToFocus(IDS, 'b', 'a')).toBeNull();
    expect(rowToFocus([], null, 'ArrowDown')).toBeNull();
  });
});

describe('focusJobRow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A page with these rows (id → whether it was focused), found the way the browser finds them. */
  function page(ids: string[]) {
    const focused: string[] = [];
    const asked: string[] = [];
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('document', {
      querySelector(selector: string) {
        asked.push(selector);
        const id = selector.match(/^\[data-job-id="(.*)"\]$/)?.[1];
        return id !== undefined && ids.includes(id) ? { focus: () => focused.push(id) } : null;
      },
    });
    return { focused, asked };
  }

  it('gives the focus to the job’s row, not to a control in it', () => {
    const { focused, asked } = page(['a', 'b']);
    expect(focusJobRow('b')).toBe(true);
    expect(focused).toEqual(['b']);
    expect(asked).toEqual(['[data-job-id="b"]']);
  });

  it('does nothing when the row is not on the page (another page of the list, filtered out)', () => {
    const { focused } = page(['a']);
    expect(focusJobRow('zzz')).toBe(false);
    expect(focused).toEqual([]);
  });
});
