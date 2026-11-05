// The files the engine ships for Generated videos (GN2, GN3): apps/server/assets/generate/, the two
// scripts the Generate run calls. The folder sits next to src/ and dist/ (like prompts/ and
// assets/music/), so the same path works from both and the build has nothing to copy.
//
// make-voice.mjs (ElevenLabs) and make-shots.mjs (Higgsfield) are plain Node with no imports of
// the engine; each has a fake (make-voice-fake.mjs, make-shots-fake.mjs) that runs instead when
// STUDIO_GENERATE_FAKE=1. The run calls them from Bash (the Generate prompt names them), and the
// fake Generate run (fake-generate.ts) calls them itself.

import { fileURLToPath } from 'node:url';

/** `apps/server/assets/generate/`, from `src/generate/` or `dist/generate/` alike. */
export const GENERATE_ASSETS_DIR = fileURLToPath(
  new URL('../../assets/generate/', import.meta.url),
);

export const GENERATE_ASSETS = {
  /** `node make-voice.mjs line|check|assemble|sfx "<edit dir>" …` (ElevenLabs). */
  voice: fileURLToPath(new URL('../../assets/generate/make-voice.mjs', import.meta.url)),
  /** `node make-shots.mjs estimate|upload|still|clip "<edit dir>" …` (Higgsfield). */
  shots: fileURLToPath(new URL('../../assets/generate/make-shots.mjs', import.meta.url)),
} as const;
