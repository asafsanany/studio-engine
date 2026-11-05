import bakeryMarkdown from './fixtures/bakery-brief.md?raw';
import bakeryWithStyleMarkdown from './fixtures/bakery-brief-with-style.md?raw';
import bakeryJson from './fixtures/bakery-fixture.json' with { type: 'json' };
import bakeryStyleMarkdown from './fixtures/bakery-style.md?raw';
import { noInstructionsBrief } from './no-instructions.ts';
import { type BriefDraft, briefDraftSchema } from './schema.ts';

/**
 * The bakery job: the draft the Brief run is expected to write, the client, job and note it was
 * written for, and the exact brief.md that must come out of them (made by the reference renderer
 * in ~/.studio-engine/handoff/phase1/ref_render.py).
 */
export const bakery = {
  client: bakeryJson.client,
  job: bakeryJson.job,
  note: bakeryJson.note,
  rawDraft: bakeryJson.draft,
  draft: briefDraftSchema.parse(bakeryJson.draft),
  markdown: bakeryMarkdown,
};

/**
 * The bakery's style as the frozen copy in edit/style/ holds it (Phase 2 plan §6): its style.md,
 * the names at the top of that folder, and the exact brief.md that the bakery job plus this style
 * must give. The names come in no particular order and include a folder the section leaves out.
 */
export const bakeryStyle = {
  markdown: bakeryStyleMarkdown,
  files: [
    'style.md',
    'reference-reel.mp4',
    'kit/',
    'logo-north-bakery.png',
    'notes/',
    'brand-guide.pdf',
  ] as readonly string[],
  briefMarkdown: bakeryWithStyleMarkdown,
};

/** A valid draft with nothing set but a summary. Tests override the one thing they care about. */
export function makeDraft(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return { ...noInstructionsBrief([]), summary: 'A short reel.', ...overrides };
}

/**
 * A draft's `music` with every key, nothing set: no file, no note, no song. Tests override the one
 * thing they care about.
 */
export function makeMusic(
  overrides: Partial<NonNullable<BriefDraft['music']>> = {},
): NonNullable<BriefDraft['music']> {
  return {
    file: null,
    note: null,
    wanted: false,
    song: null,
    original: null,
    wantsTrending: false,
    ...overrides,
  };
}

/** The context every render test uses; override the note when the test is about it. */
export const context = { client: 'Client', job: 'Job' } as const;
