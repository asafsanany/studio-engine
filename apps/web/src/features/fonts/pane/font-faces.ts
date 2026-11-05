// Real fonts on the Fonts page (Fonts plan, "Reading the font files"): every specimen is drawn from
// the font file the engine serves (`GET /api/fonts/file/:fileId?v=…`), so what the owner sees is the file
// the edit will use. A file gets ONE `@font-face` (a browser `FontFace` object) the first time a face
// of it is shown, with `font-display: swap` and a family name of its own, `fe-<fileId>`, so a font
// file's name can never collide with the page's own fonts (Inter, Noto Sans Hebrew). A variable
// file (several named instances in one file) is added once, with its weight range.
//
// The registry below is plain code with the browser handed in, so the tests need no browser; the
// hooks that use it are in use-font-face.ts.

import type { FontFaceInfo, FontFormat } from '@studio/shared';
import { HEBREW_FALLBACK_FONT } from '@studio/shared';
import { fontFileUrl } from '@/data/fonts-api';

/** Where a font file is: not asked yet or on its way, in the page, or it could not be had. */
export type FontLoadState = 'loading' | 'loaded' | 'failed';

/** The least of the browser's `FontFace` the registry uses. */
export interface FontFaceLike {
  load(): Promise<unknown>;
}

/** What `new FontFace(family, source, descriptors)` is told. */
export interface FontFaceDescriptorsLike {
  weight: string;
  style: 'normal' | 'italic';
  display: 'swap';
}

/** The browser, handed in: make a face, put it in the page, take it out. */
export interface FontFaceEnv {
  create(family: string, source: string, descriptors: FontFaceDescriptorsLike): FontFaceLike;
  add(face: FontFaceLike): void;
  remove(face: FontFaceLike): void;
}

/** The real browser's, or `null` where there is no `FontFace` (a server render, a test). */
export function browserFontEnv(): FontFaceEnv | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return null;
  }
  return {
    create: (family, source, descriptors) => new FontFace(family, source, descriptors),
    add: (face) => {
      document.fonts.add(face as FontFace);
    },
    remove: (face) => {
      document.fonts.delete(face as FontFace);
    },
  };
}

// --- names and addresses ------------------------------------------------------------------------

/** Quotes and slashes would end the quoted name early; a file id is a hash and has none. */
function safeId(fileId: string): string {
  return fileId.replace(/["'\\\r\n]/g, '');
}

/** The CSS family name of a file: unique to it, so it can never be taken for another font. */
export function fontFamilyOfFile(fileId: string): string {
  return `fe-${safeId(fileId)}`;
}

/** The CSS `format()` hint of each file type. */
const SOURCE_FORMATS: Readonly<Record<FontFormat, string>> = {
  ttf: 'truetype',
  otf: 'opentype',
  woff: 'woff',
  woff2: 'woff2',
};

/** The `src` of a file's `@font-face`: its address with the version, and the format. */
export function fontSourceOf(face: Pick<FontFaceInfo, 'fileId' | 'version' | 'format'>): string {
  return `url("${fontFileUrl(face.fileId, face.version)}") format("${SOURCE_FORMATS[face.format]}")`;
}

/**
 * The `font-weight` descriptor of a file: its one weight, or "100 900" when several named
 * instances of a face share the file (a variable font), so the file is added once for all of them.
 * `siblings` are the faces of the family; only the ones in the same file count.
 */
export function weightDescriptorOf(
  face: Pick<FontFaceInfo, 'fileId' | 'weight'>,
  siblings: readonly Pick<FontFaceInfo, 'fileId' | 'weight'>[] = [face],
): string {
  const weights = [face.weight];
  for (const other of siblings) if (other.fileId === face.fileId) weights.push(other.weight);
  const low = Math.min(...weights);
  const high = Math.max(...weights);
  return low === high ? String(low) : `${low} ${high}`;
}

/** Two quoted families, then a generic one, as a CSS `font-family` value. */
function stack(...names: readonly (string | null)[]): string {
  return names.filter((name): name is string => name !== null).join(', ');
}

/** The face's own file, then a plain sans for any letter it does not have. */
export function faceStack(face: Pick<FontFaceInfo, 'fileId'>): string {
  return stack(`"${fontFamilyOfFile(face.fileId)}"`, 'sans-serif');
}

/**
 * What Hebrew text is set in on this page when the open font has no Hebrew: Heebo, the font the
 * edits keep for Hebrew. `heebo` is Heebo's face of the shown weight when the library has it (drawn
 * from the library's own file); without it the stack falls back to a Heebo the Mac may have, then
 * to the Hebrew font the app already ships.
 */
export function hebrewFallbackStack(heebo: Pick<FontFaceInfo, 'fileId'> | null): string {
  return stack(
    heebo === null ? null : `"${fontFamilyOfFile(heebo.fileId)}"`,
    `"${HEBREW_FALLBACK_FONT}"`,
    '"Noto Sans Hebrew"',
    'sans-serif',
  );
}

/**
 * The face's own file first, then Heebo for the letters it lacks, for text that may hold either
 * language (the "try your own text" box in a font without Hebrew).
 */
export function mixedStack(
  face: Pick<FontFaceInfo, 'fileId'>,
  heebo: Pick<FontFaceInfo, 'fileId'> | null,
): string {
  return stack(
    `"${fontFamilyOfFile(face.fileId)}"`,
    heebo === null ? null : `"${fontFamilyOfFile(heebo.fileId)}"`,
    `"${HEBREW_FALLBACK_FONT}"`,
    '"Noto Sans Hebrew"',
    'sans-serif',
  );
}

// --- the registry -------------------------------------------------------------------------------

/** How long a file that failed is left alone before a new request tries it again. */
export const FONT_RETRY_AFTER_MS = 5000;

interface FileEntry {
  /** The version of the file this entry was made for. */
  version: string;
  face: FontFaceLike;
  state: FontLoadState;
  /** When it was added, so a failure can wait before it is tried again. */
  at: number;
}

export interface FontFaceRegistry {
  /**
   * Makes sure the file of `face` is in the page, and starts loading it. Once per file: asking
   * again changes nothing, unless the file's version changed (the old rule goes, a new one comes)
   * or the last try failed more than {@link FONT_RETRY_AFTER_MS} ago (it tries again, so opening
   * the family again after the engine was away works). `siblings` are the family's faces, which
   * give a variable file its weight range. Answers the file's state now.
   */
  request(face: FontFaceInfo, siblings?: readonly FontFaceInfo[]): FontLoadState;
  /** The file's state, or `undefined` before anything asked for it. */
  stateOf(fileId: string): FontLoadState | undefined;
  /** For `useSyncExternalStore`: told whenever any file's state changes. */
  subscribe(listener: () => void): () => void;
  /** For `useSyncExternalStore`: a number that is new after every change. */
  getVersion(): number;
}

const NO_FACE: FontFaceLike = { load: () => Promise.resolve() };

/**
 * A registry over `env`; with `null` (no `FontFace` in this browser) every file is "failed".
 * `now` is the clock, for the retry wait.
 */
export function createFontFaceRegistry(
  env: FontFaceEnv | null,
  now: () => number = Date.now,
): FontFaceRegistry {
  const entries = new Map<string, FileEntry>();
  const listeners = new Set<() => void>();
  let version = 0;

  function changed() {
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function settle(fileId: string, entry: FileEntry, state: FontLoadState) {
    // A newer entry (the file changed meanwhile) owns the file now.
    if (entries.get(fileId) !== entry || entry.state === state) return;
    entry.state = state;
    entry.at = now();
    changed();
  }

  return {
    request(face, siblings = [face]) {
      const wanted = face.version ?? '';
      const known = entries.get(face.fileId);
      if (known && known.version === wanted) {
        if (known.state !== 'failed') return known.state;
        // Nothing to try again with, or too soon after the last failure.
        if (env === null || now() - known.at < FONT_RETRY_AFTER_MS) return 'failed';
      }
      if (known) env?.remove(known.face);
      entries.delete(face.fileId);

      if (env === null) {
        entries.set(face.fileId, { version: wanted, face: NO_FACE, state: 'failed', at: now() });
        changed();
        return 'failed';
      }

      let made: FontFaceLike;
      try {
        made = env.create(fontFamilyOfFile(face.fileId), fontSourceOf(face), {
          weight: weightDescriptorOf(face, siblings),
          style: face.italic ? 'italic' : 'normal',
          display: 'swap',
        });
        env.add(made);
      } catch {
        entries.set(face.fileId, { version: wanted, face: NO_FACE, state: 'failed', at: now() });
        changed();
        return 'failed';
      }
      const entry: FileEntry = { version: wanted, face: made, state: 'loading', at: now() };
      entries.set(face.fileId, entry);
      // A retry moves the file from "failed" back to "loading": tell the page.
      if (known) changed();
      made.load().then(
        () => settle(face.fileId, entry, 'loaded'),
        () => settle(face.fileId, entry, 'failed'),
      );
      return 'loading';
    },
    stateOf: (fileId) => entries.get(fileId)?.state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}

/** The page's registry: one for the whole visit, over the real browser. */
export const fontFaces: FontFaceRegistry = createFontFaceRegistry(browserFontEnv());
