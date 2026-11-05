// The file the engine ships for Stock media: apps/server/assets/stock/stock.mjs, the stock script.
// The folder sits next to src/ and dist/ (like assets/music/ and assets/generate/), so the same
// path works from both and the build has nothing to copy.
//
// The edit run calls it from Bash (stock.md names it: `node "{{stockScript}}" sfx|photo|get|list
// "<edit dir>" …`). It is the only writer of a job's edit/stock/, and the only thing that holds the
// Openverse and Unsplash keys: the run is given the PATH of the .env, never a key.

import { fileURLToPath } from 'node:url';

/** `apps/server/assets/stock/`, from `src/stock/` or `dist/stock/` alike. */
export const STOCK_ASSETS_DIR = fileURLToPath(new URL('../../assets/stock/', import.meta.url));

/** The stock script: `node <STOCK_SCRIPT> sfx|photo|get|list "<edit dir>" …`. */
export const STOCK_SCRIPT = fileURLToPath(new URL('../../assets/stock/stock.mjs', import.meta.url));
