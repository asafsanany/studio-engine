// The live preview of a font note in Review (Fonts plan, "The live preview"; FN18's findings; board
// FOReview, states chip and two): which font the note box gives the captions and which the titles,
// and what the pill says. Plain functions, so the tests need no browser. The player's page is
// restyled by font-preview-dom.ts; the Review dialog's hook is use-font-preview.ts.
//
//   note box: "Captions in @Heebo Bold, titles in @Rubik Black"      video playing or paused
//     ─▶ captions: Heebo Bold, titles: Rubik Black      pill: "Previewing 2 fonts" + Compare
//     ─▶ the player's page gets a font rule for each, scoped to the captions and to the titles
//
// The scope of each mention is shared's `fontScopeOfToken` (the same words the chips and the sent
// note's "Saved. The next edit uses Heebo Bold for the captions." read): a font for the captions,
// for the titles, or for all text (both). A font for a scope beats one for all text; of two for the
// same scope the one written first is shown, as the board does. Nothing here touches a job's files.

import { type FontFaceInfo, fontScopeOfToken, parseNoteTokens } from '@studio/shared';
import { fontSourceOf } from '@/features/fonts/pane/font-faces';
import type { FontPickerCatalog } from '@/features/library-picker/font-picker';
import type {
  GraphicPickerItem,
  LutPickerItem,
  PickerItem,
} from '@/features/library-picker/picker-items';
import { compareKeyAction, PAUSED_LOOK_TEXT } from './paused-look';

/** The text a font is shown on in the player: the other half of "all text". */
export type PreviewScope = 'captions' | 'titles';

/** One font to show: what its `@font-face` in the player's page needs, and what the pill calls it. */
export interface FontPreviewFont {
  /** Tells fonts apart: the file, its version, the weight and the slant. */
  key: string;
  /** `@Heebo Bold`: the pill's name for it. */
  label: string;
  /** The `src` of its `@font-face`: the engine's file with `?v=`, and the format. */
  src: string;
  /**
   * The face's own weight: the `@font-face` descriptor is this one value (a variable file's axis is
   * held at it), and no rule sets the text's `font-weight`, so words the font cannot draw keep theirs.
   */
  weight: number;
  italic: boolean;
}

/** What the note box asks to be shown: a font for the captions, one for the titles, or neither. */
export interface FontPreviewPlan {
  captions: FontPreviewFont | null;
  titles: FontPreviewFont | null;
  /** Each font once, in the order the note writes them. */
  fonts: readonly FontPreviewFont[];
  /** The same for plans that show the same things: the page redoes its rules only when this changes. */
  key: string;
}

/** What the player's page ended up showing (a scope with no captions or titles to find shows nothing). */
export interface FontPreviewStatus {
  shown: readonly Pick<FontPreviewFont, 'key' | 'label'>[];
}

/** No font is on the page. */
export const NOTHING_SHOWN: FontPreviewStatus = { shown: [] };

/**
 * What the pill on the video says, or `null` when there is no pill: the player is the live
 * composition (the phone's MP4 has no page to restyle) and is ready, a plan is asked for, and the
 * page really shows something of it. Whether it is the pill on the video, against a quick fix's and
 * the look on the paused frame's, is `choosePill`'s (pill-choice.ts): this one wins.
 */
export function fontPillOf(state: {
  asVideo: boolean;
  ready: boolean;
  plan: FontPreviewPlan | null;
  status: FontPreviewStatus | null;
}): FontPreviewStatus | null {
  const { asVideo, ready, plan, status } = state;
  if (asVideo || !ready || plan === null) return null;
  return status !== null && status.shown.length > 0 ? status : null;
}

/** The words of the pill and its Compare button (Compare is LU11's, word for word). */
export const FONT_PREVIEW_TEXT = {
  compare: PAUSED_LOOK_TEXT.compare,
  compareTip: PAUSED_LOOK_TEXT.compareTip,
  /** "Previewing @Heebo Bold", or "Previewing 2 fonts". */
  pill: (shown: readonly Pick<FontPreviewFont, 'label'>[]): string => {
    const [only] = shown;
    return shown.length === 1 && only !== undefined
      ? `Previewing ${only.label}`
      : `Previewing ${shown.length} fonts`;
  },
} as const;

/** What a key does to Compare: the same as the look on the paused frame's. */
export { compareKeyAction };

/** The faces of the catalog as `parseNoteTokens` reads them, once per catalog. */
const FACES = new WeakMap<FontPickerCatalog, readonly FontFaceInfo[]>();

function facesOf(catalog: FontPickerCatalog): readonly FontFaceInfo[] {
  const known = FACES.get(catalog);
  if (known !== undefined) return known;
  const faces = catalog.faces.map((entry) => entry.face);
  FACES.set(catalog, faces);
  return faces;
}

function fontOf(face: FontFaceInfo): FontPreviewFont {
  return {
    key: [face.fileId, face.version ?? '', face.weight, face.italic ? 'i' : 'n'].join(':'),
    label: `@${face.name}`,
    src: fontSourceOf(face),
    weight: face.weight,
    italic: face.italic,
  };
}

const isLut = (item: PickerItem): item is LutPickerItem => item.type === 'lut';
const isGraphic = (item: PickerItem): item is GraphicPickerItem => item.type === 'graphic';

/**
 * The fonts `text` asks to see on the captions and on the titles, or `null` when it names none
 * (a name the library does not have names nothing). `items` are the LUTs and graphics a note can
 * name: their tokens are read too, so the words between a font and the next token end where they
 * do for the chips.
 */
export function fontPreviewPlan(
  text: string,
  catalog: FontPickerCatalog,
  items: readonly PickerItem[] = [],
): FontPreviewPlan | null {
  if (!text.includes('@')) return null;
  const faces = facesOf(catalog);
  const { tokens } = parseNoteTokens(text, {
    faces,
    luts: items.filter(isLut),
    graphics: items.filter(isGraphic),
  });
  const fonts = new Map<string, FontPreviewFont>();
  const forCaptions: FontPreviewFont[] = [];
  const forTitles: FontPreviewFont[] = [];
  const forAll: FontPreviewFont[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'font') continue;
    const font = fontOf(token.face);
    const known = fonts.get(font.key) ?? font;
    fonts.set(known.key, known);
    const scope = fontScopeOfToken(text, tokens, index);
    (scope === 'captions' ? forCaptions : scope === 'titles' ? forTitles : forAll).push(known);
  }
  const captions = forCaptions[0] ?? forAll[0] ?? null;
  const titles = forTitles[0] ?? forAll[0] ?? null;
  if (captions === null && titles === null) return null;
  const shown = new Set([captions?.key, titles?.key]);
  return {
    captions,
    titles,
    fonts: [...fonts.values()].filter((font) => shown.has(font.key)),
    key: `${captions?.key ?? '-'}|${titles?.key ?? '-'}`,
  };
}
