import type { FontFaceInfo } from '@studio/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type FontFaceRegistry, type FontLoadState, fontFaces } from './font-faces';

const NO_FACES: readonly FontFaceInfo[] = [];

/** Puts the files of `faces` in the page (each once) and starts loading them. */
export function requestFaces(
  registry: FontFaceRegistry,
  faces: readonly FontFaceInfo[],
  siblings: readonly FontFaceInfo[] = faces,
): void {
  for (const face of faces) registry.request(face, siblings);
}

/**
 * The faces' files, added to the page as `@font-face` rules the first time they are shown (one per
 * file, however many times and from however many places they are asked for), and where each one
 * is: `loading` until the browser has the file, then `loaded`, or `failed`. The answer is in the
 * order of `faces`. Text set in `faceStack(face)` shows in the font the moment it is loaded
 * (`font-display: swap`).
 *
 * `siblings` are the faces of the whole family when `faces` is only some of them: a variable file's
 * weight range comes from them. Hand in arrays that stay the same between renders.
 */
export function useFontFaces(
  faces: readonly FontFaceInfo[],
  siblings: readonly FontFaceInfo[] = faces,
  registry: FontFaceRegistry = fontFaces,
): FontLoadState[] {
  // Any file's change renders again; what to show is read from the registry below.
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  useEffect(() => {
    requestFaces(registry, faces, siblings);
  }, [registry, faces, siblings]);
  return faces.map((face) => registry.stateOf(face.fileId) ?? 'loading');
}

/**
 * One face's file: see {@link useFontFaces}. `null` asks for nothing and answers `loading`.
 * `siblings` are the family's faces (a variable file's weight range).
 */
export function useFontFace(
  face: FontFaceInfo | null,
  siblings?: readonly FontFaceInfo[],
  registry: FontFaceRegistry = fontFaces,
): FontLoadState {
  const faces = useMemo(() => (face === null ? NO_FACES : [face]), [face]);
  const [state] = useFontFaces(faces, siblings ?? faces, registry);
  return state ?? 'loading';
}
