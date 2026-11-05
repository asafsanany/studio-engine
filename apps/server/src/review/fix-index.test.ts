import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIX_TIERS } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { PROMPTS_DIR } from '../pipeline/prompts.js';

// QF0: apps/server/prompts/fix-index.md is the difficulty index the router (QF1) reads and the
// quick-fix prompt follows. It was written once by Opus from the owner's 49 real notes and is not
// reworded by hand; these checks only keep its shape, which the router's prompt relies on.

const text = readFileSync(join(PROMPTS_DIR, 'fix-index.md'), 'utf8');

describe('prompts/fix-index.md', () => {
  it('has a title and one section for each tier, in the order of the tiers', () => {
    expect(text.startsWith('# Difficulty index for review notes\n')).toBe(true);
    const sections = [...text.matchAll(/^## (quick|revise|full)\b/gm)].map((match) => match[1]);
    expect(sections).toEqual([...FIX_TIERS]);
  });

  it('names the three kinds the router answers with', () => {
    expect(text).toContain('## quick: the layer on top of the cut');
    expect(text).toContain('## revise: one part of the cut, or one baked step');
    expect(text).toContain('## full: the whole video, or taste across all of it');
  });

  it('lists the notes it was written from, with the counts of the 49', () => {
    expect(text).toContain('change font (8), replace subtitle text (4), remove subtitle text (3)');
    expect(text).toContain('replace shot (7)');
    expect(text).toContain(
      'improve shot selection (2), sync cuts to beat (2), google search style (2)',
    );
  });

  it('ends with its seven rules, the first being to take the bigger kind when unsure', () => {
    const rules = text.split('## Rules\n')[1] ?? '';
    expect(rules.trim().split('\n')).toHaveLength(7);
    expect(rules).toMatch(/^1\. When unsure between two kinds, take the bigger one\./);
    expect(rules).toContain('6. The composition notes from project.md');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('has rule 7 (C61): a note to cut on the beat is revise when "About the cut" says the cut already is, else full', () => {
    const rule = (text.split('## Rules\n')[1] ?? '').trim().split('\n')[6] ?? '';
    expect(rule).toMatch(
      /^7\. A note that asks to cut on the beat or to sync the cuts to the music/,
    );
    expect(rule).toContain(
      'is revise, not full, when "About the cut" below says the cut is already on the beat',
    );
    expect(rule).toContain('the note stays full');
    // The rest of the index is as it was: pacing and cuts on the beat are still the Full kind.
    expect(text).toContain('- Pacing, rhythm, cuts on the beat, the length of the video.');
  });

  it('stays for the agent: no template placeholders, since the router’s prompt wraps it', () => {
    expect(text).not.toMatch(/\{\{|\}\}|\$\{/);
  });
});
