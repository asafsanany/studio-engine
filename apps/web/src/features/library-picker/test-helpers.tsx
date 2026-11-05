// Helpers shared by the tests of the @ picker and of the Review parts that use it. Not imported by
// the app.

import { BUILTIN_LUTS, type FontsListResponse, type HealthResponse } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { FONT_LIST_KEY } from '@/data/fonts-query';
import { GRAPHIC_LIST_KEY } from '@/data/graphics-query';
import { HEALTH_KEY } from '@/data/health-query';
import { LUT_LIST_KEY } from '@/data/luts-query';
import {
  createTestQueryClient,
  makeBuiltInLutSummary,
  makeGraphicSummary,
  makeLutSummary,
} from '@/data/test-utils';
import { makeRealFamilies } from '@/features/fonts/list/real-families-fixture';
import { facesOf } from '@/features/fonts/pane/test-fixtures';
import { graphicPickerItems, lutPickerItems, type PickerItem } from './picker-items';

export const HEALTH: HealthResponse = {
  ok: true,
  version: '0.40.0',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: true,
  graphicsInEdits: true,
  music: false,
  luts: true,
  lutsInEdits: true,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

/** Yours: Golden Hour Warm (a look) and Skin warm fix (a fix); Built in: the 19 rows; a camera LUT in Yours too. */
export const LUT_LIST = {
  yours: [
    makeLutSummary(),
    makeLutSummary({ slug: 'skin-warm-fix', name: 'Skin warm fix', kind: 'fix' }),
    makeLutSummary({ slug: 'my-log', name: 'My log', kind: 'camera' }),
  ],
  builtIn: BUILTIN_LUTS.map((row) =>
    makeBuiltInLutSummary({ slug: row.slug, name: row.name, kind: row.kind }),
  ),
  builtInAvailable: true,
};

export const GRAPHICS = [
  makeGraphicSummary({ id: 'a00000000001', name: 'Name on a white pill' }),
  makeGraphicSummary({
    id: 'a00000000002',
    name: 'Hours saved counter',
    kind: 'callout',
    lengthSec: 4,
  }),
  makeGraphicSummary({ id: 'a00000000003', name: 'Follow card', kind: 'end-card', lengthSec: 5 }),
  makeGraphicSummary({ id: 'a00000000004', name: 'Opening title', kind: 'title' }),
  makeGraphicSummary({ id: 'a00000000005', name: 'Fifth one', kind: 'other', lengthSec: null }),
];

/**
 * The font library as `GET /api/fonts` answers it: the 40 families of the owner's `_Fonts` (A to Z, with
 * the handoff's sample use counts: Heebo 14, Assistant 9, Rubik 6, Secular One 3, Montserrat and
 * Poppins 2, ...) and one face, one file, per weight.
 */
export const FONT_LIST: FontsListResponse = (() => {
  const families = makeRealFamilies().sort((a, b) => a.name.localeCompare(b.name));
  return {
    families,
    catalog: families.flatMap((family) => facesOf(family.name, family.weights)),
    requests: [],
  };
})();

/** What the picker offers from {@link LUT_LIST} and {@link GRAPHICS}. */
export function libraryItems(): PickerItem[] {
  return [...lutPickerItems(LUT_LIST), ...graphicPickerItems(GRAPHICS)];
}

/**
 * A client that has heard the health answer and both libraries. `inEdits: false` is the default
 * install: notes cannot name anything (and the libraries are not in the cache, as nothing asks).
 * `fontsInNotes` turns Fonts and the fonts-in-notes switch on and puts the font library in the
 * cache; `fontList` puts it there even with the switch off (to show that nothing reads it).
 */
export function libraryClient({
  inEdits = true,
  fontsInNotes = false,
  fontList = fontsInNotes,
}: {
  inEdits?: boolean;
  fontsInNotes?: boolean;
  fontList?: boolean;
} = {}): QueryClient {
  const client = createTestQueryClient();
  client.setQueryData(HEALTH_KEY, {
    ...HEALTH,
    lutsInEdits: inEdits,
    fonts: fontsInNotes,
    fontsInNotes,
  });
  if (inEdits) {
    client.setQueryData(LUT_LIST_KEY, LUT_LIST);
    client.setQueryData(GRAPHIC_LIST_KEY, GRAPHICS);
  }
  if (fontList) client.setQueryData(FONT_LIST_KEY, FONT_LIST);
  return client;
}
