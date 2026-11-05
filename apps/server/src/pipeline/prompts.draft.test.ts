import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  buildStudioNotes,
  draftAgainText,
  draftBriefLine,
  draftNoteBlock,
  type PromptVars,
  STUDIO_BRIEF_SCHEMA_PATH,
  STUDIO_NOTES_PATH,
} from './prompts.js';

// Draft & chat (DR4): an edit run with the switch on is the Draft, `/video-use` with the note and the
// finish; the rules start.md says inline go to edit/studio/notes.md.

const BASE: PromptVars = {
  client: 'Pinewood',
  job: '97 Window Ad',
  kind: 'edit',
  review: true,
  music: true,
  musicScript: '/repo/scripts/music/make-music.mjs',
};
const DRAFT: PromptVars = { ...BASE, draft: true, note: 'Make it 30 s.\nLogo at the end.' };

describe('the Draft prompt', () => {
  it('starts with /video-use, then the owner’s note word for word, the job and the live preview finish', async () => {
    const prompt = await buildPrompt('start', DRAFT);
    expect(prompt.startsWith('/video-use\n\nThe owner’s note'.replace('’', "'"))).toBe(true);
    expect(prompt).toContain('> Make it 30 s.\n> Logo at the end.');
    expect(prompt).toContain('Job: client "Pinewood", job "97 Window Ad".');
    expect(prompt).toContain('finish it as a live preview in edit/preview/');
    expect(prompt).toContain('Finish the edit as a live preview, not a rendered video.');
    expect(prompt).toContain(`./${STUDIO_NOTES_PATH}`);
    expect(prompt).toContain('./edit/brief.md');
    expect(prompt).toContain('Blocked:');
    // The rules are in the notes, not in the prompt.
    expect(prompt).not.toContain('Footage quality.');
    expect(prompt).not.toContain('Notes for this machine');
    expect(prompt).not.toMatch(/\n{3,}/);
    expect(prompt).not.toMatch(/[ \t]$/m);
  });

  it('asks the Draft to read the instructions and write the brief while it is the placeholder', async () => {
    const prompt = await buildPrompt('start', { ...DRAFT, briefPending: true });
    expect(prompt).toContain('Nobody has read the client');
    expect(prompt).toContain(`./${STUDIO_BRIEF_SCHEMA_PATH}`);
    expect(prompt).not.toContain('./edit/brief.md');
  });

  it('is the same template on a resume and a retry, with what became of the last Draft', async () => {
    const resume = await buildPrompt('resume', { ...DRAFT, step: 5 });
    expect(resume.startsWith('/video-use')).toBe(true);
    expect(resume).toContain('An earlier Draft of this job was stopped at step 5 of 8 (Cut).');
    const retry = await buildPrompt('retry', { ...DRAFT, step: 6, error: 'ffmpeg exited 1.' });
    expect(retry).toContain(
      'The previous Draft failed at step 6 of 8 (Preview) with: ffmpeg exited 1.',
    );
  });

  it('leaves revise and render runs and the switch-off edit prompt as they were', async () => {
    expect(await buildPrompt('start', { ...BASE, draft: false })).toBe(
      await buildPrompt('start', BASE),
    );
    expect(await buildPrompt('start', { ...BASE, kind: 'revise', round: 1, draft: true })).toBe(
      await buildPrompt('start', { ...BASE, kind: 'revise', round: 1 }),
    );
    expect(await buildPrompt('start', { ...BASE, kind: 'render', draft: true })).toBe(
      await buildPrompt('start', { ...BASE, kind: 'render' }),
    );
  });
});

describe('the Draft’s notes', () => {
  it('carry the rules the start prompt says inline: the brief, the music and the unattended notes', async () => {
    const notes = await buildStudioNotes('start', DRAFT);
    const start = await buildPrompt('start', BASE);
    expect(notes.startsWith("# Studio Engine's notes for this edit")).toBe(true);
    for (const rule of ['Footage quality.', 'Notes for this machine', 'Blocked:']) {
      expect(notes).toContain(rule);
      expect(start).toContain(rule);
    }
    expect(notes).toContain('/repo/scripts/music/make-music.mjs');
    // The finish stays in the prompt.
    expect(notes).not.toContain('Finish the edit as a live preview');
    expect(notes).not.toMatch(/\n{3,}/);
  });
});

describe('the Draft’s lines', () => {
  it('says when there is no note', () => {
    expect(draftNoteBlock(null)).toBe('The owner left no note on this job.');
    expect(draftNoteBlock('  ')).toBe('The owner left no note on this job.');
    expect(draftNoteBlock('Use {{the}} logo')).toBe(
      "The owner's note on this job, word for word:\n> Use the logo",
    );
  });

  it('says nothing on a first Draft', () => {
    expect(draftAgainText('start', 1, 'x')).toBe('');
    expect(draftBriefLine(false)).toContain('./edit/brief.md');
  });
});
