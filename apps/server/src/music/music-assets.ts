// The file the engine ships for Soundtrack (SD0): apps/server/assets/music/make-music.mjs, the
// music script. The folder sits next to src/ and dist/ (like prompts/ and assets/graphics/), so
// the same path works from both and the build has nothing to copy.
//
// The script is the only writer of a job's edit/music/ and edit/preview/music.mp3. Two callers run
// it: the edit run from Bash (the prompts say `node "{{musicScript}}" make "<edit dir>"`), and the
// engine for Make another and Pick (MusicService, SD2).

import { fileURLToPath } from 'node:url';

/** `apps/server/assets/music/`, from `src/music/` or `dist/music/` alike. */
export const MUSIC_ASSETS_DIR = fileURLToPath(new URL('../../assets/music/', import.meta.url));

/** The music script: `node <MUSIC_SCRIPT> make|pick|supplied|series|none "<edit dir>" …`. */
export const MUSIC_SCRIPT = fileURLToPath(
  new URL('../../assets/music/make-music.mjs', import.meta.url),
);
