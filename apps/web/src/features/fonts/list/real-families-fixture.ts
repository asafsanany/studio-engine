import {
  type FontFamilySummary,
  type FontStyle,
  type FontWeight,
  familySlug,
  fontUsedLabel,
  weightsLabel,
} from '@studio/shared';

// The 40 families of the owner's _Fonts folder on 24 Oct 2026 (the Fonts handoff's fonts.json): 20 with
// Hebrew and 20 without. The Fonts list tests draw them as the engine would answer. Test data only:
// the app never imports this. `used` is the handoff's sample number, not real usage.

/** [name, has Hebrew, style, weights, jobs that used it]. */
type Row = readonly [string, boolean, FontStyle, readonly FontWeight[], number];

const ALL: readonly FontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

const ROWS: readonly Row[] = [
  ['Alef', true, 'Sans', [400, 700], 0],
  ['Amatic SC', true, 'Handwriting', [400, 700], 0],
  ['Arimo', true, 'Sans', [400, 500, 600, 700], 0],
  ['Assistant', true, 'Sans', [200, 300, 400, 500, 600, 700, 800], 9],
  ['Bellefair', true, 'Serif', [400], 0],
  ['David Libre', true, 'Serif', [400, 500, 700], 0],
  ['Frank Ruhl Libre', true, 'Serif', [300, 400, 500, 600, 700, 800, 900], 1],
  ['Fredoka', true, 'Rounded', [300, 400, 500, 600, 700], 0],
  ['Google Sans', true, 'Sans', [400, 500, 600, 700], 0],
  ['Heebo', true, 'Sans', ALL, 14],
  ['IBM Plex Sans Hebrew', true, 'Sans', [100, 200, 300, 400, 500, 600, 700], 0],
  ['Noto Sans Hebrew', true, 'Sans', ALL, 1],
  ['Open Sans', true, 'Sans', [300, 400, 500, 600, 700, 800], 1],
  ['Rubik', true, 'Sans', [300, 400, 500, 600, 700, 800, 900], 6],
  ['Rubik Glitch', true, 'Display', [400], 0],
  ['Rubik Spray Paint', true, 'Display', [400], 0],
  ['Secular One', true, 'Display', [400], 3],
  ['Suez One', true, 'Display', [400], 1],
  ['Tinos', true, 'Serif', [400, 700], 0],
  ['Varela Round', true, 'Rounded', [400], 0],
  ['DM Sans', false, 'Sans', ALL, 0],
  ['Inter', false, 'Sans', ALL, 1],
  ['Lato', false, 'Sans', [100, 300, 400, 700, 900], 0],
  ['Manrope', false, 'Sans', [200, 300, 400, 500, 600, 700, 800], 0],
  ['Merriweather', false, 'Serif', [300, 400, 500, 600, 700, 800, 900], 0],
  ['Montserrat', false, 'Sans', ALL, 2],
  ['Noto Sans', false, 'Sans', ALL, 0],
  ['Nunito', false, 'Rounded', [200, 300, 400, 500, 600, 700, 800, 900], 0],
  ['Nunito Sans', false, 'Sans', [200, 300, 400, 500, 600, 700, 800, 900], 0],
  ['Oswald', false, 'Condensed', [200, 300, 400, 500, 600, 700], 0],
  ['Outfit', false, 'Sans', ALL, 0],
  ['Playfair Display', false, 'Serif', [400, 500, 600, 700, 800, 900], 0],
  ['Plus Jakarta Sans', false, 'Sans', [200, 300, 400, 500, 600, 700, 800], 0],
  ['Poppins', false, 'Sans', ALL, 2],
  ['Raleway', false, 'Sans', ALL, 0],
  ['Roboto', false, 'Sans', ALL, 0],
  ['Roboto Condensed', false, 'Condensed', ALL, 0],
  ['Roboto Slab', false, 'Slab', ALL, 0],
  ['Ubuntu', false, 'Sans', [300, 400, 500, 700], 0],
  ['Work Sans', false, 'Sans', ALL, 0],
];

/**
 * The 40 families as summaries, in the handoff's order (the 20 with Hebrew first, not A to Z: the
 * list sorts them itself). `addedAt` is when every family was added; none is new.
 */
export function makeRealFamilies(addedAt = '2026-10-22T10:07:00.000Z'): FontFamilySummary[] {
  return ROWS.map(([name, he, style, weights, used]) => ({
    slug: familySlug(name),
    name,
    he,
    style,
    weights: [...weights],
    weightsLabel: weightsLabel(weights),
    used,
    usedLabel: fontUsedLabel(used),
    addedAt,
    isNew: false,
  }));
}
