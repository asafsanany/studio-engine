// What the Fonts pane decides, apart from how it looks (Fonts plan, "The page (web)"; boards
// FOPage and FOStates): the words, the header line, the weight rows and which one is chosen, the
// facts, and the fonts the specimen is set in. Plain functions, so the tests need no browser.

import {
  type FontFaceInfo,
  type FontFamilyDetail,
  faceName,
  fontFilesLabel,
  fontScriptLabel,
  fontUsedLabel,
  fontWeightName,
  HEBREW_FALLBACK_FONT,
  relativeTime,
  weightRangeLabel,
} from '@studio/shared';
import { faceStack, hebrewFallbackStack, mixedStack } from './font-faces';

/** The words of the pane. */
export const FONT_PANE_TEXT = {
  label: 'Font preview',
  empty: 'Pick a font to see it.',
  gone: 'This font could not be opened.',
  show: 'Show',
  tryLabel: 'Try your own text',
  tryPlaceholder: 'Type to try your own text',
  weights: 'Weights',
  fileFailed: 'The font file could not be loaded, so this is shown in a stand-in font.',
  useLead: 'To use it, write',
  useTail: 'in a note on a job.',
} as const;

/** The note under the specimen of a font with no Hebrew letters. */
export function noHebrewNote(fallback: string = HEBREW_FALLBACK_FONT): string {
  return `No Hebrew letters in this font. Hebrew text keeps the font it has now (${fallback} here); only the English words change.`;
}

/** The two views of the pane, in the order of the switch. */
export const FONT_PANE_VIEWS = [
  { id: 'text', label: 'Text' },
  { id: 'frame', label: 'On a frame' },
] as const;
export type FontPaneViewId = (typeof FONT_PANE_VIEWS)[number]['id'];

/** The view on a fresh visit. */
export const DEFAULT_FONT_PANE_VIEW: FontPaneViewId = 'text';

export function isFontPaneView(value: string): value is FontPaneViewId {
  return FONT_PANE_VIEWS.some((view) => view.id === value);
}

/** How much a Hebrew part is dimmed when the font has no Hebrew letters (the board). */
export const DIMMED_HEBREW_OPACITY = 0.55;

// --- faces and the chosen one -------------------------------------------------------------------

/** A face's place in its family: the weight and whether it is italic ("700", "400i"). */
export function faceKey(face: Pick<FontFaceInfo, 'weight' | 'italic'>): string {
  return `${face.weight}${face.italic ? 'i' : ''}`;
}

/**
 * The faces as the weight rows list them: lightest first, an italic after the upright of the
 * same weight. A second face with the same weight and slant (it should not happen) is left out.
 */
export function sortFaces(faces: readonly FontFaceInfo[]): FontFaceInfo[] {
  const seen = new Set<string>();
  return [...faces]
    .sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic))
    .filter((face) => {
      const key = faceKey(face);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The face nearest to `weight` (a tie goes to the lighter one); an upright one when there is one. */
export function nearestFace(faces: readonly FontFaceInfo[], weight: number): FontFaceInfo | null {
  const sorted = sortFaces(faces);
  const upright = sorted.filter((face) => !face.italic);
  const pool = upright.length > 0 ? upright : sorted;
  let best: FontFaceInfo | null = null;
  for (const face of pool) {
    if (best === null || Math.abs(face.weight - weight) < Math.abs(best.weight - weight)) {
      best = face;
    }
  }
  return best;
}

/** The face the pane opens on: Regular, else the one nearest to 400. */
export function defaultFace(faces: readonly FontFaceInfo[]): FontFaceInfo | null {
  return nearestFace(faces, 400);
}

/**
 * The chosen face: the one remembered for this family when it still has it, else
 * {@link defaultFace}. `null` only for a family with no faces.
 */
export function chooseFace(
  faces: readonly FontFaceInfo[],
  remembered: string | undefined,
): FontFaceInfo | null {
  if (remembered !== undefined) {
    const found = faces.find((face) => faceKey(face) === remembered);
    if (found) return found;
  }
  return defaultFace(faces);
}

/** The face chosen for each family this visit, by slug. Kept by the pane, forgotten on a reload. */
export type FaceChoices = Readonly<Record<string, string>>;

/** `choices` with `face` remembered for the family (the same object when nothing changes). */
export function rememberFace(
  choices: FaceChoices,
  slug: string,
  face: Pick<FontFaceInfo, 'weight' | 'italic'>,
): FaceChoices {
  const key = faceKey(face);
  return choices[slug] === key ? choices : { ...choices, [slug]: key };
}

/** The row's word: the weight's name, "Bold", "Light Italic". */
export function weightRowLabel(face: Pick<FontFaceInfo, 'weight' | 'italic'>): string {
  return face.italic ? `${fontWeightName(face.weight)} Italic` : fontWeightName(face.weight);
}

/** What they type in a note for this face: "@Heebo Bold", "@Heebo" for Regular. */
export function faceTag(
  detail: Pick<FontFamilyDetail, 'name'>,
  face: Pick<FontFaceInfo, 'weight' | 'italic'>,
): string {
  return `@${faceName(detail.name, face.weight, face.italic)}`;
}

// --- header and facts ---------------------------------------------------------------------------

/** The line under the name: "Sans · Hebrew + English · 9 weights". */
export function paneSubtitle(
  detail: Pick<FontFamilyDetail, 'style' | 'he' | 'weightsLabel'>,
): string {
  return `${detail.style} · ${fontScriptLabel(detail.he)} · ${detail.weightsLabel}`;
}

/** One line of the facts. */
export interface PaneFact {
  label: string;
  value: string;
}

/**
 * Script, Style, Weights, Files, Used in, Added. "Used in" is left out while notes cannot name a
 * font (its count is `null` then: nothing records the use).
 */
export function paneFacts(detail: FontFamilyDetail, now: number): PaneFact[] {
  const facts: PaneFact[] = [
    { label: 'Script', value: fontScriptLabel(detail.he) },
    { label: 'Style', value: detail.style },
    { label: 'Weights', value: weightRangeLabel(detail.weights) },
    { label: 'Files', value: fontFilesLabel(detail.faces) },
  ];
  if (detail.usedIn !== null) facts.push({ label: 'Used in', value: fontUsedLabel(detail.usedIn) });
  const added = relativeTime(detail.addedAt, now);
  facts.push({ label: 'Added', value: added === '' ? '—' : added });
  return facts;
}

// --- the fonts a view is set in -----------------------------------------------------------------

/**
 * The CSS `font-family` values of the chosen face, for every view of the pane (the On a frame view
 * uses them too). Each starts with the face's own file; only the Hebrew parts of a font with no
 * Hebrew letters are set in Heebo.
 */
export interface PaneFonts {
  /** For English text: the face itself. */
  english: string;
  /** For Hebrew text: the face itself, or Heebo when the font has no Hebrew letters. */
  hebrew: string;
  /** For text of either language (the try box): the face, with Heebo for the letters it lacks. */
  mixed: string;
  /** The opacity of Hebrew text: 1, or {@link DIMMED_HEBREW_OPACITY} when the font has no Hebrew. */
  hebrewOpacity: number;
  /** The font has no Hebrew letters. */
  noHebrew: boolean;
}

/**
 * The fonts for `face`. `heebo` is Heebo's face of the same weight when the library has Heebo (and
 * the page has asked for it); `null` lets the Hebrew fall back to a Heebo the Mac has, else the
 * Hebrew font the app ships.
 */
export function paneFonts(
  detail: Pick<FontFamilyDetail, 'he'>,
  face: Pick<FontFaceInfo, 'fileId'>,
  heebo: Pick<FontFaceInfo, 'fileId'> | null,
): PaneFonts {
  const english = faceStack(face);
  if (detail.he) {
    return { english, hebrew: english, mixed: english, hebrewOpacity: 1, noHebrew: false };
  }
  return {
    english,
    hebrew: hebrewFallbackStack(heebo),
    mixed: mixedStack(face, heebo),
    hebrewOpacity: DIMMED_HEBREW_OPACITY,
    noHebrew: true,
  };
}
