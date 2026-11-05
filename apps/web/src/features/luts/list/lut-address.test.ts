import { describe, expect, it } from 'vitest';
import {
  clearForParam,
  forJobOfSearch,
  lutOfSearch,
  setLutParam,
  setTabParam,
  showLutParam,
  tabOfSearch,
  validateLutsSearch,
} from './lut-address';

type Change = (search: Record<string, unknown>) => Record<string, unknown>;

describe('the LUTs page’s address', () => {
  it('keeps a slug and a kind tab, and drops everything else', () => {
    expect(validateLutsSearch({ lut: 'golden-hour-warm', tab: 'look' })).toEqual({
      lut: 'golden-hour-warm',
      tab: 'look',
    });
    expect(validateLutsSearch({ tab: 'camera' })).toEqual({ tab: 'camera' });
    expect(validateLutsSearch({ tab: 'fix' })).toEqual({ tab: 'fix' });
    expect(validateLutsSearch({ lut: '', tab: 'all' })).toEqual({});
    expect(validateLutsSearch({ lut: 12, tab: 'looks' })).toEqual({});
    expect(validateLutsSearch({ lut: ['a'], tab: ['look'] })).toEqual({});
    expect(validateLutsSearch({})).toEqual({});
  });

  it('reads the slug and the tab from any search', () => {
    expect(lutOfSearch({ lut: 'a-b' })).toBe('a-b');
    expect(lutOfSearch({ lut: '' })).toBeNull();
    expect(lutOfSearch({ lut: 4 })).toBeNull();
    expect(lutOfSearch(undefined)).toBeNull();
    expect(tabOfSearch({ tab: 'fix' })).toBe('fix');
    expect(tabOfSearch({ tab: 'nope' })).toBe('all');
    expect(tabOfSearch(null)).toBe('all');
  });

  it('sets the slug and keeps the tab, or takes the slug out', () => {
    const set = setLutParam('film-contrast') as unknown as Change;
    expect(set({ tab: 'look', lut: 'old' })).toEqual({ tab: 'look', lut: 'film-contrast' });
    const clear = setLutParam(null) as unknown as Change;
    expect(clear({ tab: 'look', lut: 'old' })).toEqual({ tab: 'look' });
  });

  it('sets the tab and keeps the slug; All takes the tab out of the address', () => {
    const set = setTabParam('camera') as unknown as Change;
    expect(set({ lut: 'a', tab: 'look' })).toEqual({ lut: 'a', tab: 'camera' });
    const all = setTabParam('all') as unknown as Change;
    expect(all({ lut: 'a', tab: 'look' })).toEqual({ lut: 'a' });
  });

  it('opens a new LUT on the All tab in one change, keeping the rest', () => {
    const show = showLutParam('moody-teal') as unknown as Change;
    expect(show({ lut: 'old', tab: 'look', other: 1 })).toEqual({ other: 1, lut: 'moody-teal' });
    expect(show({})).toEqual({ lut: 'moody-teal' });
  });

  it('keeps the job an Import LUT button came for (?for=), and takes it out once acted on', () => {
    expect(validateLutsSearch({ for: 'a1b2c3', lut: 'x' })).toEqual({ lut: 'x', for: 'a1b2c3' });
    expect(validateLutsSearch({ for: '' })).toEqual({});
    expect(validateLutsSearch({ for: 7 })).toEqual({});
    expect(forJobOfSearch({ for: 'a1b2c3' })).toBe('a1b2c3');
    expect(forJobOfSearch({ for: '' })).toBeNull();
    expect(forJobOfSearch(undefined)).toBeNull();
    const clear = clearForParam() as unknown as Change;
    expect(clear({ for: 'a1b2c3', lut: 'x', tab: 'look' })).toEqual({ lut: 'x', tab: 'look' });
  });
});
