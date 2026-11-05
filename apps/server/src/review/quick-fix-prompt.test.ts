import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPrompt, PROMPTS_DIR } from '../pipeline/prompts.js';
import { buildQuickFixPrompt, type QuickFixPromptVars } from './quick-fix-prompt.js';

// The prompt of a quick fix run (prompts/quick-fix.md), and the two composition rules it shares with
// preview-finish.md through the partial composition-rules.md.

const GOLDEN_DIR = fileURLToPath(new URL('../pipeline/testdata/prompts/', import.meta.url));

// The two lines moved out of preview-finish.md (P29, P30): word for word what the edit and revise
// prompts had before they became a partial.
const EXIT_LINE =
  '- A graphic that fades or slides out must finish doing so inside its clip: a `class="clip"` element is hidden after data-start + data-duration, so that sum has to be at or after the end of the exit tween. Check a snapshot at the exit.';
const CLEAR_LINE =
  '- Look at the snapshots for what each caption and graphic sits on: over every shot it appears on, it must not cover text, a face or a key object in the picture. If it would, use the nearest clear position (or a stronger caption background) and say so in project.md.';
const SELF_EVAL_START = '- Self-eval on the composition instead of a render:';
const RECORD_LINE =
  '- Record the composition in project.md: where it is, its graphics and their timing.';

const FIX_ID = 'f0a1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a4b';

// Hebrew names, a font note in Hebrew and English, a whole second.
const HEBREW: QuickFixPromptVars = {
  client: 'מאפיית הצפון',
  job: 'פרומו לסוף השבוע',
  atSec: 12,
  note: 'change the caption font to Heebo Bold, ובמיוחד בכותרת',
  round: 2,
  fixId: FIX_ID,
};

// A moment between the seconds, a note with quotes, braces and line breaks, and a later round.
const AWKWARD: QuickFixPromptVars = {
  client: 'Acme {{x}} Studio',
  job: 'Launch teaser',
  atSec: 83.456,
  note: "the caption should say 'That's where it began'\n  and {{> unattended}} {{note}}",
  round: 3,
  fixId: '0123abcd-0000-4000-8000-000000000001',
};

describe('the quick fix prompt (golden)', () => {
  // Read here, never written: a change to these files is a change to what a quick fix run is told.
  // Written once from the template, then read; update with -u only on purpose.
  it.each([
    ['quick-fix-hebrew.txt', HEBREW],
    ['quick-fix-awkward.txt', AWKWARD],
  ])('%s', async (file, vars) => {
    const golden = readFileSync(`${GOLDEN_DIR}${file}`, 'utf8');
    expect(await buildQuickFixPrompt(vars)).toBe(golden);
  });
});

describe('the quick fix prompt', () => {
  it('names the moment twice, as asked for and as `--at` takes it', async () => {
    const prompt = await buildQuickFixPrompt(AWKWARD);
    expect(prompt).toContain('at 1:23.5 on its timeline');
    expect(prompt).toContain(
      '--at=83.46 --no-end --keep -o edit/review/fixes/0123abcd-0000-4000-8000-000000000001/stills/after',
    );
    expect((await buildQuickFixPrompt({ ...HEBREW, atSec: 0 })).includes('--at=0 ')).toBe(true);
  });

  it('gives the exact commands, the fix folder and the answer file', async () => {
    const prompt = await buildQuickFixPrompt(HEBREW);
    const fixDir = `edit/review/fixes/${FIX_ID}`;
    expect(prompt).toContain(
      `npx hyperframes snapshot edit/preview --at=12 --no-end --keep -o ${fixDir}/stills/before`,
    );
    expect(prompt).toContain(
      `npx hyperframes snapshot edit/preview --at=12 --no-end --keep -o ${fixDir}/stills/after`,
    );
    expect(prompt).toContain(`--keep -o ${fixDir}/stills/frames`);
    expect(prompt).toContain('npx hyperframes lint edit/preview');
    expect(prompt).toContain(`Finish with ${fixDir}/reply.json: {"done": true, "said": "`);
    expect(prompt).toContain('{"done": false, "why": "');
    expect(prompt).toContain('## Round 2 · fixed in Review');
    expect(prompt).toContain(
      'Never touch cut.mp4, the music, the clips or any other media, and do not render.',
    );
    expect(prompt).toContain('every other caption, title, graphic and timing stays as it is.');
  });

  it('puts the note word for word in a block, on one line, and reads nothing in it as a template', async () => {
    const prompt = await buildQuickFixPrompt(AWKWARD);
    expect(prompt).toContain(
      "<note>\nthe caption should say 'That's where it began' and > unattended note\n</note>",
    );
    expect(prompt).toContain('client "Acme x Studio"');
    expect(prompt).not.toContain('{{');
  });

  it('carries the two composition rules, word for word, and no skill or video-use text', async () => {
    const prompt = await buildQuickFixPrompt(HEBREW);
    expect(prompt).toContain(`\n${EXIT_LINE}\n${CLEAR_LINE}\n`);
    expect(prompt).not.toMatch(/video-use|ElevenLabs|§0|\bSkill\b/);
    expect(prompt.endsWith('\n')).toBe(true);
    expect(prompt.endsWith('\n\n')).toBe(false);
    expect(prompt).not.toMatch(/[ \t]$/m);
  });

  it('needs a round of 1 or more and a fix id that is safe in a path', async () => {
    await expect(buildQuickFixPrompt({ ...HEBREW, round: 0 })).rejects.toThrow(/round/);
    await expect(buildQuickFixPrompt({ ...HEBREW, round: 1.5 })).rejects.toThrow(/round/);
    await expect(buildQuickFixPrompt({ ...HEBREW, fixId: '../x {{y}}' })).rejects.toThrow(/fix id/);
  });
});

describe('the shared composition rules', () => {
  it('is a partial file of exactly the two lines, and preview-finish includes it', () => {
    expect(existsSync(`${PROMPTS_DIR}composition-rules.md`)).toBe(true);
    expect(readFileSync(`${PROMPTS_DIR}composition-rules.md`, 'utf8')).toBe(
      `${EXIT_LINE}\n${CLEAR_LINE}\n`,
    );
    const finish = readFileSync(`${PROMPTS_DIR}preview-finish.md`, 'utf8');
    expect(finish).toContain('\n{{> composition-rules}}\n');
    expect(finish).not.toContain(EXIT_LINE);
    expect(finish).not.toContain(CLEAR_LINE);
  });

  const BASE = { client: 'Acme', job: 'Teaser', step: 5, error: 'boom' } as const;

  it.each([
    ['an edit run that ends in Review', () => buildPrompt('start', { ...BASE, review: true })],
    ['a revise run', () => buildPrompt('start', { ...BASE, kind: 'revise', round: 2 })],
    [
      'a revise run with graphics and music',
      () =>
        buildPrompt('start', {
          ...BASE,
          kind: 'revise',
          round: 2,
          graphics: true,
          music: true,
          musicScript: '/m.mjs',
        }),
    ],
  ])('%s still has the two rules where preview-finish had them', async (_name, build) => {
    const prompt = await build();
    expect(prompt).toContain(`\n${EXIT_LINE}\n${CLEAR_LINE}\n${RECORD_LINE}\n`);
    expect(prompt.indexOf(SELF_EVAL_START)).toBeLessThan(prompt.indexOf(EXIT_LINE));
    // Once: the partial adds nothing next to the lines.
    expect(prompt.split(EXIT_LINE)).toHaveLength(2);
    expect(prompt.split(CLEAR_LINE)).toHaveLength(2);
  });

  it('is not in a render run, which has no preview-finish', async () => {
    expect(await buildPrompt('start', { ...BASE, kind: 'render' })).not.toContain(EXIT_LINE);
  });
});
