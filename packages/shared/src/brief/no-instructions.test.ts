import { describe, expect, it } from 'vitest';
import { NO_INSTRUCTIONS_SUMMARY, noInstructionsBrief } from './no-instructions.ts';
import { briefDraftSchema } from './schema.ts';

describe('noInstructionsBrief', () => {
  it('has the fixed summary, every other field null or empty, and each path as footage', () => {
    expect(noInstructionsBrief(['IMG_1.MOV', 'IMG_2.MOV'])).toEqual({
      summary: 'No instructions in the folder.',
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
      files: [
        { path: 'IMG_1.MOV', role: 'footage', note: null },
        { path: 'IMG_2.MOV', role: 'footage', note: null },
      ],
      assumptions: [],
      assumed: [],
    });
  });

  it('exports the summary text', () => {
    expect(NO_INSTRUCTIONS_SUMMARY).toBe('No instructions in the folder.');
    expect(noInstructionsBrief([]).summary).toBe(NO_INSTRUCTIONS_SUMMARY);
  });

  it('keeps the paths in the order given and does not sort or dedupe them', () => {
    const brief = noInstructionsBrief(['b.mov', 'a.mov', 'b.mov']);
    expect(brief.files.map((f) => f.path)).toEqual(['b.mov', 'a.mov', 'b.mov']);
  });

  it('has no files for no paths', () => {
    expect(noInstructionsBrief([]).files).toEqual([]);
  });

  it('passes the draft schema untouched', () => {
    const brief = noInstructionsBrief(['IMG_1.MOV']);
    expect(briefDraftSchema.parse(brief)).toEqual(brief);
  });

  it('lists the paths named as ignored with the role ignore, in the order given', () => {
    const brief = noInstructionsBrief(['a.mov', 'project.fcpxml', 'b.mov'], ['project.fcpxml']);
    expect(brief.files).toEqual([
      { path: 'a.mov', role: 'footage', note: null },
      { path: 'project.fcpxml', role: 'ignore', note: null },
      { path: 'b.mov', role: 'footage', note: null },
    ]);
    expect(briefDraftSchema.parse(brief)).toEqual(brief);
  });

  it('does not add an ignored path that is not in the paths', () => {
    expect(noInstructionsBrief(['a.mov'], ['other.prproj']).files).toEqual([
      { path: 'a.mov', role: 'footage', note: null },
    ]);
  });

  it('gives a fresh object every time, so one caller cannot change the next one’s', () => {
    const first = noInstructionsBrief(['a.mov']);
    first.platform.push('TikTok');
    first.onScreenText.lowerThirds.push({ name: 'x', role: null });
    first.look.colors.push('#000000');
    first.files.length = 0;
    expect(noInstructionsBrief(['a.mov'])).toEqual(noInstructionsBrief(['a.mov']));
    expect(noInstructionsBrief(['a.mov']).platform).toEqual([]);
    expect(noInstructionsBrief(['a.mov']).files).toHaveLength(1);
  });

  it('does not change the list it is given', () => {
    const paths = ['a.mov'];
    noInstructionsBrief(paths).files.push({ path: 'x', role: 'footage', note: null });
    expect(paths).toEqual(['a.mov']);
  });
});
