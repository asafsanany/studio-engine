// The fonts a note names (Fonts build 2, FN12). OWNER: FN12.
//
//   "Titles in @Rubik Black and captions in @Heebo Medium, maybe @Gotham Bold"
//     ─▶ parseNoteTokens (shared: the one definition of a token)
//     ─▶ resolveNoteFonts ─▶ { fonts: [Rubik Black, Heebo Medium], unresolved: ['Gotham Bold'] }
//
// Pure: it looks at the faces it is given and answers. It reads no file, writes no prompt text and
// records no use; the run (FN15) does all three with this answer. The faces come from the font
// index (FN3) as a {@link FontCatalog}; until the index exists a test passes a fake one.

import { fontNameKey, type NoteCatalogFace, parseNoteTokens } from '@studio/shared';

/** A face the index knows: the face and the file it lives in. */
export interface FontCatalogFace extends NoteCatalogFace {
  /**
   * The face's file as a path inside `_Fonts` (`Hebrew + English/Heebo/Heebo-Bold.ttf`, '/'
   * between folders). A job's `edit/fonts/` is a copy of `_Fonts` at the same paths, so this is
   * also the path inside the job's `edit/fonts/`.
   */
  file: string;
  /** Whether the file has the Hebrew letters (U+05D0–U+05EA). */
  he: boolean;
}

/** What the resolver needs of the font index. */
export interface FontCatalog {
  faces: readonly FontCatalogFace[];
}

/** A font a note names, found: the face (`Heebo Bold`) and where its file is. */
export interface NoteFont {
  /** The face's name, as the catalog has it (not as it was typed). */
  face: string;
  family: string;
  weight: number;
  italic: boolean;
  /** The path of its file inside `edit/fonts/` (see {@link FontCatalogFace.file}). */
  file: string;
  /** Whether the file has the Hebrew letters; a font without them is never used for Hebrew words. */
  he: boolean;
}

export interface NoteFonts {
  /** The faces the text names, each once, in the order the text first names them. */
  fonts: NoteFont[];
  /**
   * The names that point at no face (`Gotham Bold`), each once (without regard to case), in the
   * order the text first writes them. LUT and graphic tokens are not fonts and never appear here.
   */
  unresolved: string[];
}

/**
 * The fonts `text` names and the font names the library does not have. A face the text names twice
 * (or in another case) is one font.
 */
export function resolveNoteFonts(text: string, index: FontCatalog): NoteFonts {
  const { tokens, unresolved } = parseNoteTokens(text, { faces: index.faces });
  const result: NoteFonts = { fonts: [], unresolved: [] };

  const seenFaces = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'font') continue;
    const key = fontNameKey(token.face.name);
    if (seenFaces.has(key)) continue;
    seenFaces.add(key);
    const { name, family, weight, italic, file, he } = token.face;
    result.fonts.push({ face: name, family, weight, italic, file, he });
  }

  const seenNames = new Set<string>();
  for (const entry of unresolved) {
    if (entry.kind !== 'font') continue;
    const key = fontNameKey(entry.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    result.unresolved.push(entry.name);
  }
  return result;
}
