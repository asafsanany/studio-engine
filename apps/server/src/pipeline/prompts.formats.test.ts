import { type JobFormat, jobFormatsOf } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { buildPrompt, formatsValues, type PromptVars } from './prompts.js';
import { RUN_MODES } from './runner.js';

// Formats (GN7): a job with two or more formats gets formats-use.md in the edit run that ends in
// Review and in a revise run, and formats-render.md in a render run. A job with one format, or none,
// gets exactly the prompt it always did.

const BASE: PromptVars = { client: 'Acme', job: 'Teaser', step: 5, error: 'it broke' };
const TWO: JobFormat[] = jobFormatsOf(['1080x1920', '1080x1080']);
const THREE: JobFormat[] = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']);

const USE_MARKER = 'Formats: the brief asks for';
const RENDER_MARKER = 'This job has more than one format, so render each one';

describe('a job with one format or none', () => {
  it.each(RUN_MODES)(
    '%s: the Review-on edit prompt is the same with no formats key at all',
    async (mode) => {
      const plain = await buildPrompt(mode, { ...BASE, review: true });
      expect(await buildPrompt(mode, { ...BASE, review: true, formats: [] })).toBe(plain);
      expect(await buildPrompt(mode, { ...BASE, review: true, formats: TWO.slice(0, 1) })).toBe(
        plain,
      );
      expect(plain).not.toContain(USE_MARKER);
      expect(plain).not.toContain('preview-1x1');
    },
  );

  it.each(['revise', 'render'] as const)(
    '%s: the prompt is the same with no formats',
    async (kind) => {
      const vars: PromptVars = { ...BASE, kind, round: 2, review: true };
      const plain = await buildPrompt('start', vars);
      expect(await buildPrompt('start', { ...vars, formats: [] })).toBe(plain);
      expect(plain).not.toContain(USE_MARKER);
      expect(plain).not.toContain(RENDER_MARKER);
    },
  );

  it('keeps the done line of the composition where it was, right after the marks line', async () => {
    const plain = await buildPrompt('start', { ...BASE, review: true });
    expect(plain).toMatch(
      /They change nothing in the picture\.\n- The job is done when edit\/preview\/index\.html passes lint/,
    );
  });
});

describe('formatsValues', () => {
  it('is all empty for no second format', () => {
    for (const formats of [undefined, [], TWO.slice(0, 1)]) {
      expect(Object.values(formatsValues(formats)).every((value) => value === '')).toBe(true);
    }
  });

  it('names the formats, the folders, the render commands and the videos', () => {
    expect(formatsValues(TWO)).toEqual({
      formatsCount: '2',
      formatsMain: '9:16 (1080x1920)',
      formatsExtraList: 'edit/preview-1x1/ for 1:1 (1080x1080)',
      formatsRenderList:
        '  - 1:1: from edit/preview-1x1/, npx hyperframes render -q delivery --strict --no-best-effort -o ../final-1x1.mp4',
      formatsFinals: 'edit/final-1x1.mp4',
    });
    const three = formatsValues(THREE);
    expect(three.formatsCount).toBe('3');
    expect(three.formatsExtraList).toBe(
      'edit/preview-1x1/ for 1:1 (1080x1080), edit/preview-4x5/ for 4:5 (1080x1350)',
    );
    expect(three.formatsFinals).toBe('edit/final-1x1.mp4, edit/final-4x5.mp4');
    expect(three.formatsRenderList?.split('\n')).toHaveLength(2);
  });
});

describe('a job with two formats', () => {
  it.each(RUN_MODES)(
    '%s: the edit run that ends in Review builds a composition per format',
    async (mode) => {
      const prompt = await buildPrompt(mode, { ...BASE, review: true, formats: TWO });
      expect(prompt.split(USE_MARKER)).toHaveLength(2);
      expect(prompt).toContain(
        'the brief asks for 2 formats, so this job is delivered as 2 videos of one cut',
      );
      expect(prompt).toContain('The main format is 9:16 (1080x1920) and is built in edit/preview/');
      expect(prompt).toContain('(edit/preview-1x1/ for 1:1 (1080x1080))');
      // The part sits inside the finish, before its done line, and says every composition counts.
      expect(prompt.indexOf(USE_MARKER)).toBeLessThan(
        prompt.indexOf('- The job is done when edit/preview/index.html passes lint'),
      );
      expect(prompt).toContain('every composition above passes lint');
      expect(prompt).not.toContain(RENDER_MARKER);
    },
  );

  it('tells the run to lay the graphics out again, never to spend, and to say what a crop cuts off', async () => {
    const prompt = await buildPrompt('start', { ...BASE, review: true, formats: TWO });
    expect(prompt).toContain('out again for each format');
    expect(prompt).toContain('never scaled down from the main layout');
    expect(prompt).toContain('say so in project.md (shot, time, what is cut off)');
    expect(prompt).toContain(
      'no generation or reframe model, no download, nothing that costs money',
    );
  });

  it('the edit run without Review (it delivers final.mp4) is not told about formats', async () => {
    const prompt = await buildPrompt('start', { ...BASE, review: false, formats: TWO });
    expect(prompt).not.toContain(USE_MARKER);
    expect(prompt).toBe(await buildPrompt('start', { ...BASE, review: false }));
  });

  it('a revise run keeps every format in step, through preview-finish, once', async () => {
    const prompt = await buildPrompt('start', { ...BASE, kind: 'revise', round: 1, formats: TWO });
    expect(prompt.split(USE_MARKER)).toHaveLength(2);
    // GN8: each note in the round file carries the format of the preview it was written on.
    expect(prompt).toContain('(on 1:1) — …');
    expect(prompt).toContain('changes every format');
    expect(prompt).toContain('changes only the format it names');
    expect(prompt).not.toContain(RENDER_MARKER);
  });

  it('a render run renders each format from its own folder, and is done only when all videos exist', async () => {
    const prompt = await buildPrompt('start', { ...BASE, kind: 'render', formats: TWO });
    expect(prompt.split(RENDER_MARKER)).toHaveLength(2);
    expect(prompt).toContain(
      '  - 1:1: from edit/preview-1x1/, npx hyperframes render -q delivery --strict --no-best-effort -o ../final-1x1.mp4',
    );
    expect(prompt).toContain("copy edit/preview/music.mp3 into each other format's folder");
    expect(prompt).toContain(
      'The job is done only when edit/final.mp4 and edit/final-1x1.mp4 all exist',
    );
    // The main render line is still first, and the formats part is not in a render run twice.
    expect(prompt.indexOf('-o ../final.mp4')).toBeLessThan(prompt.indexOf(RENDER_MARKER));
    expect(prompt).not.toContain(USE_MARKER);
  });

  it('lists every extra format when there are three', async () => {
    const prompt = await buildPrompt('start', { ...BASE, kind: 'render', formats: THREE });
    expect(prompt).toContain('-o ../final-1x1.mp4');
    expect(prompt).toContain('-o ../final-4x5.mp4');
    expect(prompt).toContain('edit/final.mp4 and edit/final-1x1.mp4, edit/final-4x5.mp4 all exist');
  });
});
