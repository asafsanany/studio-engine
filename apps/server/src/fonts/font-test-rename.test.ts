import { describe, expect, it } from 'vitest';
import { checkFontFile, readFont } from './font-reader.js';
import { renameFontFamily } from './font-test-rename.js';
import { fixtureFont } from './font-test-utils.js';

describe('renameFontFamily', () => {
  it('makes a real font another family: same weight, same Hebrew, same size', () => {
    const original = fixtureFont('Bellefair-Regular.ttf');
    const renamed = renameFontFamily(original, 'Bellefair', 'Karantina');
    expect(renamed).toHaveLength(original.length);
    expect(readFont(renamed)).toMatchObject({
      ok: true,
      family: 'Karantina',
      weight: 400,
      he: true,
      italic: false,
    });
    expect(checkFontFile('Karantina-Regular.ttf', renamed)).toMatchObject({ ok: true });
  });

  it('leaves the original alone', () => {
    const original = fixtureFont('Bellefair-Regular.ttf');
    const before = Buffer.from(original);
    renameFontFamily(original, 'Bellefair', 'Karantina');
    expect(original.equals(before)).toBe(true);
    expect(readFont(original)).toMatchObject({ ok: true, family: 'Bellefair' });
  });

  it('refuses a name of another length', () => {
    expect(() => renameFontFamily(fixtureFont('Oswald-Regular.ttf'), 'Oswald', 'Oswaldo')).toThrow(
      /same number of letters/,
    );
  });
});
