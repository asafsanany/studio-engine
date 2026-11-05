import { describe, expect, it } from 'vitest';
import { OPEN_IMPORTED_TRIES, openImportedStep } from './font-import-open';

const base = { wanted: 'karantina', selected: null, slugs: ['bebas-neue', 'karantina'], tries: 0 };

describe('openImportedStep', () => {
  it('is idle when nothing was imported', () => {
    expect(openImportedStep({ ...base, wanted: null })).toBe('idle');
  });

  it('waits until the list has the new family', () => {
    expect(openImportedStep({ ...base, slugs: undefined })).toBe('wait');
    expect(openImportedStep({ ...base, slugs: ['bebas-neue'] })).toBe('wait');
  });

  it('opens it once the list has it and the address names something else', () => {
    expect(openImportedStep(base)).toBe('open');
    // The list opened its own first row meanwhile: ask again.
    expect(openImportedStep({ ...base, selected: 'bebas-neue', tries: 1 })).toBe('open');
  });

  it('is done when the address names it', () => {
    expect(openImportedStep({ ...base, selected: 'karantina', tries: 1 })).toBe('done');
  });

  it('gives up after a few tries, so a tab that hides the family does not fight the list', () => {
    expect(
      openImportedStep({ ...base, selected: 'bebas-neue', tries: OPEN_IMPORTED_TRIES - 1 }),
    ).toBe('open');
    expect(openImportedStep({ ...base, selected: 'bebas-neue', tries: OPEN_IMPORTED_TRIES })).toBe(
      'done',
    );
  });
});
