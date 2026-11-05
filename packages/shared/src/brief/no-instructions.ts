import type { BriefDraft } from './schema.ts';

/** The summary of a brief for a folder that holds nothing but video. */
export const NO_INSTRUCTIONS_SUMMARY = 'No instructions in the folder.';

/**
 * The summary of the placeholder brief (Draft & chat, DR4): with the switch on, a job with footage
 * has no Brief run; the engine writes this placeholder and the Draft reads the instructions itself
 * and writes the brief over it.
 */
export const DRAFT_PENDING_BRIEF_SUMMARY =
  'Not read yet: the Draft reads the instructions in this folder and writes this brief.';

/**
 * The placeholder brief (Draft & chat, DR4): what the engine knows before anyone read the folder.
 * Every field is null or empty, the summary says it is not read yet, and each file has a first
 * guess at its role from its kind: a video or a sound is footage, anything else instructions. The
 * Draft writes the real brief over it.
 */
export function draftPendingBrief(
  files: readonly { readonly path: string; readonly kind: string }[],
): BriefDraft {
  return {
    ...noInstructionsBrief([]),
    summary: DRAFT_PENDING_BRIEF_SUMMARY,
    files: files.map((file) => ({
      path: file.path,
      role: file.kind === 'video' || file.kind === 'audio' ? 'footage' : 'instructions',
      note: null,
    })),
  };
}

/**
 * The brief the engine writes itself, without a Claude run, when every file in the job folder is
 * a video (or of a type the engine does not know) and there is no note: nothing says how to edit,
 * so every field is null or empty (the editor then uses video-use's defaults), each video is
 * footage and there are no assumptions.
 *
 * `ignored` lists the paths that are not footage, such as a Final Cut or Premiere project file:
 * they are in the brief with the role `ignore`, so the editor knows they were seen and left alone.
 * Paths in `ignored` that are not in `paths` are not added.
 */
export function noInstructionsBrief(
  paths: readonly string[],
  ignored: readonly string[] = [],
): BriefDraft {
  const ignoredPaths = new Set(ignored);
  return {
    summary: NO_INSTRUCTIONS_SUMMARY,
    goal: null,
    audience: null,
    platform: [],
    canvas: null,
    length: null,
    language: null,
    captions: null,
    tone: null,
    pacing: null,
    hook: null,
    mustInclude: [],
    mustAvoid: [],
    onScreenText: { title: null, lowerThirds: [], cta: null, endCard: null },
    look: { logo: null, colors: [], fonts: [] },
    music: null,
    production: null,
    voiceover: null,
    formats: null,
    budgetUsd: null,
    references: [],
    files: paths.map((path) => ({
      path,
      role: ignoredPaths.has(path) ? 'ignore' : 'footage',
      note: null,
    })),
    assumptions: [],
    assumed: [],
  };
}
