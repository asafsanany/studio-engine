import { faceName } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { type FontCatalog, type FontCatalogFace, resolveNoteFonts } from './font-tokens.js';

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** A fake font index: the faces of a family, each with a file the way `_Fonts` files them. */
function family(
  name: string,
  weights: number[],
  { he, folder, italics = [] }: { he: boolean; folder: string; italics?: number[] },
): FontCatalogFace[] {
  const face = (weight: number, italic: boolean): FontCatalogFace => ({
    name: faceName(name, weight, italic),
    family: name,
    weight,
    italic,
    file: `${folder}/${name}/${faceName(name, weight, italic).replaceAll(' ', '')}.ttf`,
    he,
  });
  return [...weights.map((w) => face(w, false)), ...italics.map((w) => face(w, true))];
}

const index: FontCatalog = {
  faces: [
    ...family('Heebo', WEIGHTS, { he: true, folder: 'Hebrew + English' }),
    ...family('Rubik', [300, 400, 500, 700, 900], { he: true, folder: 'Hebrew + English' }),
    ...family('Rubik Glitch', [400], { he: true, folder: 'Hebrew + English' }),
    ...family('Poppins', WEIGHTS, { he: false, folder: 'English only' }),
    ...family('Merriweather', [400, 700], { he: false, folder: 'English only', italics: [400] }),
  ],
};

describe('resolveNoteFonts', () => {
  it('finds the face, its family, weight, file and script', () => {
    expect(resolveNoteFonts('Make the captions @Heebo Bold', index)).toEqual({
      fonts: [
        {
          face: 'Heebo Bold',
          family: 'Heebo',
          weight: 700,
          italic: false,
          file: 'Hebrew + English/Heebo/HeeboBold.ttf',
          he: true,
        },
      ],
      unresolved: [],
    });
  });

  it('says a font without Hebrew letters has none', () => {
    const { fonts } = resolveNoteFonts('@Poppins Bold for the captions', index);
    expect(fonts).toEqual([
      {
        face: 'Poppins Bold',
        family: 'Poppins',
        weight: 700,
        italic: false,
        file: 'English only/Poppins/PoppinsBold.ttf',
        he: false,
      },
    ]);
  });

  it('gives the Regular face for a family name alone, and an italic', () => {
    const { fonts } = resolveNoteFonts('@Heebo and @Merriweather Italic', index);
    expect(fonts.map((f) => [f.face, f.weight, f.italic])).toEqual([
      ['Heebo', 400, false],
      ['Merriweather Italic', 400, true],
    ]);
  });

  it('names the face as the index has it, not as it was typed', () => {
    const { fonts } = resolveNoteFonts('use @HEEBO  BOLD', index);
    expect(fonts.map((f) => f.face)).toEqual(['Heebo Bold']);
  });

  it('lists two fonts in the order the note writes them', () => {
    const { fonts, unresolved } = resolveNoteFonts(
      'Titles in @Rubik Black and captions in @Heebo Medium',
      index,
    );
    expect(fonts.map((f) => f.face)).toEqual(['Rubik Black', 'Heebo Medium']);
    expect(unresolved).toEqual([]);
  });

  it('lists a font once however often, and in whatever case, the note writes it', () => {
    const { fonts } = resolveNoteFonts(
      '@Heebo Bold, then @heebo bold, then @Rubik, @Heebo Bold',
      index,
    );
    expect(fonts.map((f) => f.face)).toEqual(['Heebo Bold', 'Rubik']);
  });

  it('picks the longer name: Rubik Glitch, not Rubik', () => {
    expect(resolveNoteFonts('@Rubik Glitch', index).fonts.map((f) => f.face)).toEqual([
      'Rubik Glitch',
    ]);
    expect(resolveNoteFonts('@Rubik', index).fonts.map((f) => f.face)).toEqual(['Rubik']);
  });

  it('puts a font the library does not have in unresolved', () => {
    expect(resolveNoteFonts('Captions in @Gotham Bold and bigger', index)).toEqual({
      fonts: [],
      unresolved: ['Gotham Bold'],
    });
  });

  it('separates the fonts it has from the ones it has not, each once', () => {
    const { fonts, unresolved } = resolveNoteFonts(
      'Titles in @Gotham Bold, captions in @Heebo Black, again @gotham... and @Gotham  Bold, @Futura',
      index,
    );
    expect(fonts.map((f) => f.face)).toEqual(['Heebo Black']);
    expect(unresolved).toEqual(['Gotham Bold', 'Futura']);
  });

  it('leaves LUT and graphic tokens alone: they are not fonts', () => {
    expect(
      resolveNoteFonts('Grade @luts/cinematic, add @graphics/intro, font @Heebo', index),
    ).toEqual({
      fonts: [
        {
          face: 'Heebo',
          family: 'Heebo',
          weight: 400,
          italic: false,
          file: 'Hebrew + English/Heebo/Heebo.ttf',
          he: true,
        },
      ],
      unresolved: [],
    });
  });

  it('finds nothing in a note with no @, an email address or an empty index', () => {
    expect(resolveNoteFonts('Heebo Bold please', index)).toEqual({ fonts: [], unresolved: [] });
    expect(resolveNoteFonts('mail owner@heebo.com', index)).toEqual({ fonts: [], unresolved: [] });
    expect(resolveNoteFonts('', index)).toEqual({ fonts: [], unresolved: [] });
    expect(resolveNoteFonts('@Heebo Bold', { faces: [] })).toEqual({
      fonts: [],
      unresolved: ['Heebo Bold'],
    });
  });

  it('reads a Hebrew note', () => {
    const text = 'תשנה את הכתוביות ל-@Heebo Black ואת הכותרות ל-@Rubik Medium, לא ב-@Gotham';
    const { fonts, unresolved } = resolveNoteFonts(text, index);
    expect(fonts.map((f) => f.face)).toEqual(['Heebo Black', 'Rubik Medium']);
    expect(unresolved).toEqual(['Gotham']);
  });
});
