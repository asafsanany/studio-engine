// What a note's `@` tokens point at (LUTs build 2, LU7). OWNER: LU7.
//
//   "Make it @luts/cinematic and @graphics/intro, plus @luts/gone"
//     ─▶ parseLibraryTokens (shared: the one definition of a token)
//     ─▶ resolveLibraryRefs ─▶ { luts: [cinematic], graphics: [intro], missing: [@luts/gone] }
//
// Pure: it looks at the rows it is given and answers. It copies no file and writes no prompt text;
// the run (LU9) does both with this answer. Names of files stay names: a Yours LUT's `file` is its
// name inside `<inbox>/_LUTs`, a built-in one's is its name inside the colour-grade skill's
// `correction_luts/` (`null` for the Cinematic look, which is `look: 'cinematic'` and no file).

import {
  type BuiltInLut,
  graphicSlug,
  type LibraryName,
  type LutKind,
  parseLibraryTokens,
} from '@studio/shared';
import type { StoredGraphic, StoredLut } from '../db/index.js';

/** The rows the tokens are looked up in. */
export interface LibrarySources {
  /** Yours: the LUT rows. A deleted one (`deletedAt` set) never resolves. */
  luts: readonly StoredLut[];
  /** The graphics. A deleted one, or one with no version made yet, never resolves. */
  graphics: readonly StoredGraphic[];
  /**
   * The built-in LUTs a note may name: `BUILTIN_LUTS`, or `[]` while the colour grade is not
   * installed (every built-in token is then missing).
   */
  builtIn: readonly BuiltInLut[];
}

/** A LUT a note names, found. */
export interface ResolvedLut {
  slug: string;
  kind: LutKind;
  owner: 'yours' | 'builtIn';
  /** The file's name (see the header); `null` for the Cinematic look. */
  file: string | null;
  /** `'cinematic'` for the built-in look the wrapper makes itself, else `null`. */
  look: 'cinematic' | null;
  /** The row it came from. */
  row: StoredLut | BuiltInLut;
}

/** A graphic a note names, found: `version` is the one edits use. */
export interface ResolvedGraphic {
  slug: string;
  id: string;
  name: string;
  version: number;
}

/** A token that points at nothing (never made, renamed, deleted, or not made yet). */
export interface MissingRef {
  library: LibraryName;
  slug: string;
}

export interface LibraryRefs {
  luts: ResolvedLut[];
  graphics: ResolvedGraphic[];
  missing: MissingRef[];
}

function findLut(slug: string, { luts, builtIn }: LibrarySources): ResolvedLut | null {
  const yours = luts.find((lut) => lut.deletedAt === null && lut.slug === slug);
  if (yours !== undefined) {
    return { slug, kind: yours.kind, owner: 'yours', file: yours.file, look: null, row: yours };
  }
  const built = builtIn.find((lut) => lut.slug === slug);
  if (built !== undefined) {
    return {
      slug,
      kind: built.kind,
      owner: 'builtIn',
      file: built.files[0] ?? null,
      look: built.look,
      row: built,
    };
  }
  return null;
}

/**
 * The graphic named `slug`: among the live graphics that have a version, the one whose name makes
 * that slug. Names are unique without regard to case but two can make the same slug ("A B" and
 * "a-b"); the one whose name is exactly the slug wins, else the oldest.
 */
function findGraphic(slug: string, { graphics }: LibrarySources): ResolvedGraphic | null {
  const candidates = graphics.filter(
    (graphic) =>
      graphic.deletedAt === null &&
      graphic.version !== null &&
      graphicSlug(graphic.name, graphic.id) === slug,
  );
  const [first, ...rest] = candidates;
  if (first === undefined) return null;
  const chosen =
    rest.length === 0
      ? first
      : (candidates.find((graphic) => graphic.name === slug) ??
        [...candidates].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )[0] ??
        first);
  return { slug, id: chosen.id, name: chosen.name, version: chosen.version as number };
}

/**
 * The library rows `text` names, each once, in the order the text first names them; and the
 * tokens that point at nothing. A LUT is looked up in Yours first, then in the built-in ones.
 */
export function resolveLibraryRefs(text: string, sources: LibrarySources): LibraryRefs {
  const refs: LibraryRefs = { luts: [], graphics: [], missing: [] };
  for (const { library, slug } of parseLibraryTokens(text, { unique: true })) {
    if (library === 'luts') {
      const lut = findLut(slug, sources);
      if (lut === null) refs.missing.push({ library, slug });
      else refs.luts.push(lut);
    } else {
      const graphic = findGraphic(slug, sources);
      if (graphic === null) refs.missing.push({ library, slug });
      else refs.graphics.push(graphic);
    }
  }
  return refs;
}
