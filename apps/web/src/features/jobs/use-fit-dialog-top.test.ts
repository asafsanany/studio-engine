import { describe, expect, it } from 'vitest';
import { fittedTop } from './use-fit-dialog-top';

describe('fittedTop', () => {
  it('keeps the top where it is while the dialog fits below it', () => {
    expect(fittedTop(288, 520, 900)).toBe(288);
    expect(fittedTop(288, 596, 900)).toBe(288);
  });

  it('moves the top up by what is missing, keeping 16 px under the dialog', () => {
    expect(fittedTop(288, 687, 900)).toBe(197);
    expect(fittedTop(288, 865, 900)).toBe(19);
  });

  it('never goes above 16 px, however tall the dialog', () => {
    expect(fittedTop(288, 900, 900)).toBe(16);
    expect(fittedTop(288, 1400, 900)).toBe(16);
  });

  it('goes back down when the dialog gets smaller or the window taller', () => {
    expect(fittedTop(288, 687, 900)).toBe(197);
    expect(fittedTop(288, 520, 900)).toBe(288);
    expect(fittedTop(288, 687, 1200)).toBe(288);
  });
});
