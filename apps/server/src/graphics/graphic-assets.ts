// The files the engine ships for the Graphics library (GR0): apps/server/assets/graphics/. The
// folder sits next to src/ and dist/ (like prompts/ and drizzle/), so the same path works from
// both and the build has nothing to copy.
//
//   vendor/gsap.min.js   put into every graphic's work/vendor/ before a run (the same file as
//                        pipeline/testdata/preview/vendor/gsap.min.js)
//   *.svg                the preview's sample frames, served at /api/graphics/assets/:file (GR3)

import { fileURLToPath } from 'node:url';

/** `apps/server/assets/graphics/`, from `src/graphics/` or `dist/graphics/` alike. */
export const GRAPHICS_ASSETS_DIR = fileURLToPath(
  new URL('../../assets/graphics/', import.meta.url),
);

/** The GSAP build every graphic loads from `vendor/gsap.min.js`. */
export const GSAP_ASSET_PATH = fileURLToPath(
  new URL('../../assets/graphics/vendor/gsap.min.js', import.meta.url),
);
