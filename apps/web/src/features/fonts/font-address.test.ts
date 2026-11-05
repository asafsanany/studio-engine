import { describe, expect, it } from 'vitest';
import { familyOfSearch, setFamilyParam, validateFontsSearch } from './font-address';

type Change = (search: Record<string, unknown>) => Record<string, unknown>;

describe('the Fonts page’s address', () => {
  it('keeps a family slug, and drops everything else', () => {
    expect(validateFontsSearch({ family: 'heebo' })).toEqual({ family: 'heebo' });
    expect(validateFontsSearch({ family: 'noto-sans-hebrew', tab: 'hebrew' })).toEqual({
      family: 'noto-sans-hebrew',
    });
    expect(validateFontsSearch({ family: '' })).toEqual({});
    expect(validateFontsSearch({ family: 12 })).toEqual({});
    expect(validateFontsSearch({ family: ['a'] })).toEqual({});
    expect(validateFontsSearch({ lut: 'golden-hour-warm' })).toEqual({});
    expect(validateFontsSearch({})).toEqual({});
  });

  it('reads the slug from any search', () => {
    expect(familyOfSearch({ family: 'a-b' })).toBe('a-b');
    expect(familyOfSearch({ family: '' })).toBeNull();
    expect(familyOfSearch({ family: 4 })).toBeNull();
    expect(familyOfSearch({})).toBeNull();
    expect(familyOfSearch(undefined)).toBeNull();
    expect(familyOfSearch(null)).toBeNull();
    expect(familyOfSearch('heebo')).toBeNull();
  });

  it('sets the slug and keeps every other parameter, or takes the slug out', () => {
    const set = setFamilyParam('rubik') as unknown as Change;
    expect(set({ other: 'x', family: 'old' })).toEqual({ other: 'x', family: 'rubik' });
    expect(set({})).toEqual({ family: 'rubik' });
    const clear = setFamilyParam(null) as unknown as Change;
    expect(clear({ other: 'x', family: 'old' })).toEqual({ other: 'x' });
    expect(clear({})).toEqual({});
  });
});
