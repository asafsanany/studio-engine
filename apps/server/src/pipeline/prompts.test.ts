import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_GENERATED_KEYS,
  briefDraftSchema,
  briefPromptSchema,
  MUSIC_NOT_ASKED_REASON,
  musicPlanSchema,
  parseCameraLutWait,
  SONG_ASKED_BY,
  SONG_ASKED_FROM,
  SONG_VERSIONS,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { parseArgs as parseMusicArgs, toComposition } from '../../assets/music/make-music.mjs';
import {
  againText,
  type BriefPromptFile,
  briefFileSize,
  briefSharedText,
  buildBriefPrompt,
  buildPrompt,
  COLOR_GRADE_SCRIPT,
  formatBriefFiles,
  hasLibraryRefs,
  NO_FILES,
  NO_NOTE,
  PROMPTS_DIR,
  type PromptPartial,
  type PromptVars,
  renderTemplate,
} from './prompts.js';
import { RUN_MODES, type RunCameraCurve, type RunCameraLuts, type RunMode } from './runner.js';

const job = { client: 'Acme Studio', job: 'Launch teaser' };

/** The step list resume.md and retry.md give the run, in the order of STEPS. */
const EIGHT_STEPS =
  'steps are: 1 Brief, 2 Transcribe, 3 Scan, 4 Plan, 5 Cut, 6 Preview, 7 Check, 8 Render.';

const README = fileURLToPath(new URL('../../../../README.md', import.meta.url));

// The two checks preview-finish.md carries for the snapshots. A revise run reads them through
// `{{> preview-finish}}` only, so revise.md has no copy of its own.
// P29 (CVP-164): a revise run that held a lower third longer moved its fade-out past the clip's
// end, so it was cut instead of fading. The first edit can make the same mistake.
const EXIT_LINE =
  '- A graphic that fades or slides out must finish doing so inside its clip: a `class="clip"` element is hidden after data-start + data-duration, so that sum has to be at or after the end of the exit tween. Check a snapshot at the exit.';
// P30 (CVP-165): a moved caption landed on the big title in the footage and nobody noticed.
const CLEAR_LINE =
  '- Look at the snapshots for what each caption and graphic sits on: over every shot it appears on, it must not cover text, a face or a key object in the picture. If it would, use the nearest clear position (or a stronger caption background) and say so in project.md.';
// FN19 (CVP-352): Review's live font preview finds the captions and the titles by these marks.
const MARK_LINE =
  '- Mark the text so Studio Engine can show a font note live: the captions\' host (the one with data-track-kind="captions") also carries data-timeline-role="captions"; every title, lower third, callout and end card (the host of its sub-composition, or the element itself when it sits in index.html) carries data-timeline-role="title". If the composition already exists, add the attributes where they are missing. They change nothing in the picture.';

// C24 (CVP-258): in a real series run an edit read another series' kit under _Series/ and cd'd into
// a sibling episode's folder. unattended.md is in every edit-family prompt, so the line lives there.
const READ_ONLY_LINE =
  "- Read only this folder. The client's style, this job's series (if it has one) and the shared fonts are already copied into edit/style/, edit/series/ and edit/fonts/, so don't open the client's other folders (other jobs, _Style, _Series, _Fonts) or anything else in the inbox. The one exception is the client's _Shared folder (../_Shared/) when brief.md lists its files: copy the ones you use into edit/shared/ and use them from there.";

/** The names and numbers behind the golden prompts below (Hebrew, a step, an error with braces). */
const GOLDEN_VARS: PromptVars = {
  client: 'מאפיית הצפון',
  job: 'פרומו לסוף השבוע',
  step: 5,
  error: 'Claude Code stopped with exit code 1:\nrender.py failed {{x}}',
};

const GOLDEN_DIR = fileURLToPath(new URL('./testdata/prompts/', import.meta.url));

/**
 * preview-finish.md as a run reads it: its `{{> composition-rules}}` partial (the exit rule and the
 * clear-of-the-picture check, shared with the quick fix run) and its `{{> self-eval}}` partial (the
 * whole check, self-eval-full.md; QF4) filled in, which is the text the file had before those lines
 * became partials, byte for byte.
 */
function previewFinishText(): string {
  return renderTemplate(
    readFileSync(`${PROMPTS_DIR}preview-finish.md`, 'utf8'),
    {},
    {
      'composition-rules': readFileSync(`${PROMPTS_DIR}composition-rules.md`, 'utf8'),
      'self-eval': readFileSync(`${PROMPTS_DIR}self-eval-full.md`, 'utf8'),
      // GN7: the formats part is there only for a job with two or more formats; empty, its line goes.
      'formats-use': '',
    },
  );
}

// The color-grade integration deliberately replaces the old HLG workaround. Keep the captured
// fixtures frozen and require every other byte to stay the same (including music/review rules).
async function withColorGrade(golden: string, vars: Partial<PromptVars> = {}): Promise<string> {
  const name = !vars.kind || vars.kind === 'edit' ? 'color-grade' : `color-grade-${vars.kind}`;
  const grade = renderTemplate(readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8'), {
    colorGradeScript: `'${COLOR_GRADE_SCRIPT.replaceAll("'", "'\\''")}'`,
    round: String(vars.round ?? 0),
    lutsGradeNote: '', // LU9: only a run whose notes name a LUT has one
  })
    .replace(/[ \t]+$/gm, '') // the empty note leaves a space at the line's end; buildPrompt trims it
    .trimEnd();
  expect(golden).toMatch(/^- iPhone clips:.*$/m);
  return golden.replace(/^- iPhone clips:.*$/m, () => grade);
}

// W2 (CVP-108): the edit prompts as they were before the Review switch existed. The background
// agent reads prompts/ from main on every run, so with the switch off they must not move by a byte.
// The files were captured from the unchanged templates and are read here, never written: never
// update them with -u, since a change to them is a change to the prompts the owner's edits run on.
// (CVP-258 added the read-only line to each of them by hand, as the one deliberate change.)
describe('edit prompts with the Review switch off (golden, captured before W2)', () => {
  it.each(RUN_MODES)('%s', async (mode) => {
    const golden = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
    expect(await buildPrompt(mode, GOLDEN_VARS)).toBe(golden);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, review: false })).toBe(golden);
    // The kind defaults to edit, and says the same when it is given (W3).
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, kind: 'edit' })).toBe(golden);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, kind: 'edit', review: false })).toBe(golden);
  });
});

describe('color-grade looks', () => {
  it('revise tells the run how to ask for a cinematic look', async () => {
    const prompt = await buildPrompt('start', { ...GOLDEN_VARS, kind: 'revise', round: 1 });
    expect(prompt).toContain('--look cinematic');
  });
});

describe('prompt templates', () => {
  it('live in apps/server/prompts, outside src/ (so dist/ finds them too)', () => {
    expect(PROMPTS_DIR).toMatch(/apps\/server\/prompts\/$/);
    for (const name of [
      ...RUN_MODES,
      'unattended',
      'brief',
      'brief-use',
      'final-finish',
      'preview-finish',
      'revise',
      'render',
      'color-grade',
      'color-grade-revise',
      'color-grade-render',
    ]) {
      expect(existsSync(`${PROMPTS_DIR}${name}.md`)).toBe(true);
    }
  });

  it.each(RUN_MODES)('%s renders with every variable filled', async (mode) => {
    const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1' });
    expect(prompt).not.toMatch(/\{\{|\}\}/);
    expect(prompt).toContain('video-use skill');
    expect(prompt).toContain('edit/final.mp4');
    expect(prompt).toContain('client "Acme Studio", job "Launch teaser"');
    expect(prompt).toContain('write everything to ./edit/');
    // The unattended rules from E1's verified prompt, plus the Blocked: contract.
    expect(prompt).toContain('nobody will answer questions, so never ask any');
    expect(prompt).toContain('Skip the ln -sfn line in §1');
    expect(prompt).toContain('skip §4');
    expect(prompt).toContain("sed -i ''");
    expect(prompt).toContain('start with "Blocked:"');
    expect(prompt).toContain('Never print it');
  });

  // V4's orientation regression is now handled by the shared color-grade wrapper rather than a
  // machine-specific hardware tone-mapping command improvised by each run.
  it.each(RUN_MODES)(
    '%s tells the run to keep iPhone rotation through HLG intermediates',
    async (mode) => {
      const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1' });
      expect(prompt).toContain('normalizes iPhone HLG/PQ to SDR before fitting');
      expect(prompt).toContain('preserves display orientation');
    },
  );

  // P1 (CVP-82): in V4 an unquoted `cd $SH` split "מאפיית הצפון/סרטון השקה" at the space and the run
  // wrote <inbox>/מאפיית/package, which the engine then listed as a new job.
  it.each(RUN_MODES)('%s tells the run to quote paths and stay inside ./edit/', async (mode) => {
    const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1' });
    expect(prompt).toContain('The job path contains spaces and may be Hebrew');
    expect(prompt).toContain('always double-quote paths and variables in Bash');
    expect(prompt).toContain('never `cd $SH`');
    expect(prompt).toContain('Never cd or write above ./edit/');
    expect(prompt).toContain('if a cd fails, stop');
  });

  it.each(RUN_MODES)('%s tells the run to read only its own job folder, once', async (mode) => {
    for (const review of [true, false]) {
      const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1', review });
      expect(prompt.split(READ_ONLY_LINE).length - 1).toBe(1);
      // Next to the rule about where the run may cd and write.
      expect(prompt).toMatch(/gets picked up as a new job\.\n- Read only this folder\./);
    }
  });

  it('keeps client and job names with spaces and Hebrew intact in the prompt', async () => {
    const hebrew = { client: 'מאפיית הצפון', job: 'סרטון השקה' };
    for (const mode of RUN_MODES) {
      const prompt = await buildPrompt(mode, { ...hebrew, step: 3, error: 'x' });
      expect(prompt).toContain('client "מאפיית הצפון", job "סרטון השקה"');
    }
  });

  it('start: the E1 prompt, nothing about earlier runs', async () => {
    const prompt = await buildPrompt('start', job);
    expect(prompt.startsWith('Edit the footage in this folder with the video-use skill')).toBe(
      true,
    );
    expect(prompt).not.toMatch(/earlier run|previous attempt|transcribe again/i);
  });

  it('resume: carries on from the step, without transcribing again', async () => {
    const prompt = await buildPrompt('resume', { ...job, step: 5 });
    expect(prompt).toContain('stopped partway, at step 5 of 8 (Cut)');
    expect(prompt).toContain(EIGHT_STEPS);
    expect(prompt).toContain('read edit/project.md');
    expect(prompt).toContain('Do not transcribe again');
  });

  it('retry: names the failed step and the error, asks to fix the cause first', async () => {
    const prompt = await buildPrompt('retry', {
      ...job,
      step: 8,
      error: 'Claude Code stopped with exit code 1:\nrender.py failed {{x}}',
    });
    expect(prompt).toContain('failed at step 8 of 8 (Render) with this error:');
    expect(prompt).toContain(EIGHT_STEPS);
    expect(prompt).toContain('> Claude Code stopped with exit code 1: render.py failed x');
    expect(prompt).toContain('Find the cause of that error first');
    expect(prompt).toContain('Do not transcribe again');
  });

  it('retry without a recorded error says so', async () => {
    const prompt = await buildPrompt('retry', { ...job, step: 3 });
    expect(prompt).toContain('> unknown (it was not recorded)');
  });
});

describe('color-grade integration', () => {
  it('resolves the launcher from the repository for source and built server paths', () => {
    expect(COLOR_GRADE_SCRIPT).toBe(
      fileURLToPath(new URL('../../../../scripts/color-grade/run.sh', import.meta.url)),
    );
    expect(COLOR_GRADE_SCRIPT).toBe(
      fileURLToPath(
        new URL(
          '../../../../scripts/color-grade/run.sh',
          new URL('../../dist/pipeline/prompts.js', import.meta.url),
        ),
      ),
    );
  });

  it.each(RUN_MODES)(
    '%s prepares graded sources before both preview and direct final renders',
    async (mode) => {
      for (const review of [false, true]) {
        const prompt = await buildPrompt(mode, { ...job, review });
        expect(prompt.match(/load the color-grade-ai skill/g)).toHaveLength(1);
        expect(prompt).toContain(
          `bash '${COLOR_GRADE_SCRIPT}' --edl "./edit/edl.json" --output-dir "./edit/color-grade" --prepare-only`,
        );
        expect(prompt).toContain('build captions from the original edit/edl.json and transcripts');
        expect(prompt).toContain('edl.graded.json, whose top-level grade is "none"');
        expect(prompt).toContain(
          'resume/retry reuse the existing outputs only when their sources, ranges and grading settings still match',
        );
        expect(prompt).toContain('never guess one, force log to display');
        expect(prompt).not.toContain('this ffmpeg has no zscale');
        expect(prompt).not.toContain('--grade none');
      }
    },
  );

  it.each(RUN_MODES)(
    '%s preserves the grade during revisions unless the notes or footage require a change',
    async (mode) => {
      const prompt = await buildPrompt(mode, { ...job, kind: 'revise', round: 2 });
      expect(prompt).toContain(
        'Keep the existing graded sources and look unless a review note changes the look or changes the selected footage',
      );
      expect(prompt).toContain('--output-dir "./edit/color-grade-round-2" --prepare-only');
      expect(prompt).toContain('never add another render.py or HyperFrames grade');
      expect(prompt).not.toContain('--output-dir "./edit/color-grade"');
    },
  );

  it.each(RUN_MODES)('%s renders the approved color without running a new grade', async (mode) => {
    const prompt = await buildPrompt(mode, { ...job, kind: 'render' });
    expect(prompt).toContain("keep the approved preview's exact assets and grade");
    expect(prompt).toContain('do not rerun the grading wrapper');
    expect(prompt).toContain(
      'An older approved preview that never used this pipeline needs no new report or grade',
    );
    expect(prompt).toContain('changing the approved look needs a revise run');
    expect(prompt).not.toContain(COLOR_GRADE_SCRIPT);
    expect(prompt).not.toContain('--prepare-only');
  });
});

// B4: every edit run reads the brief first; the partial sits right after the job line.
describe('brief-use in the edit prompts', () => {
  const briefUse = readFileSync(`${PROMPTS_DIR}brief-use.md`, 'utf8').trimEnd();
  const JOB_LINE =
    'Job: client "Acme Studio", job "Launch teaser". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.';

  it.each(RUN_MODES)('%s includes brief-use.md right after the job line', async (mode) => {
    const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1' });
    expect(prompt).toContain(`${JOB_LINE}\n\n${briefUse}\n\n`);
    expect(prompt).toContain('If edit/brief.md exists, read it before anything else');
    expect(prompt).toContain('Start project.md’s Assumptions line with the brief’s assumptions.');
  });

  // Phase 2 (C5) and Series (CVP-179): brief.md has a Series section for an episode and ends with
  // the client's style when the job has one; the series wins over the style.
  it.each(RUN_MODES)(
    '%s tells the run what the Series and Client style sections are',
    async (mode) => {
      const prompt = await buildPrompt(mode, { ...job, step: 5, error: 'ffmpeg exited 1' });
      expect(prompt).toContain(
        '- A Series section, when there is one, is the format this job repeats: follow it exactly. The Client style section at the end is the client’s house style. The brief above them wins where they disagree, and the series wins over the style.\n',
      );
    },
  );

  it('puts the Series and Client style line last, after the Assumptions line', () => {
    expect(briefUse.split('\n').slice(-2)).toEqual([
      '- Start project.md’s Assumptions line with the brief’s assumptions.',
      '- A Series section, when there is one, is the format this job repeats: follow it exactly. The Client style section at the end is the client’s house style. The brief above them wins where they disagree, and the series wins over the style.',
    ]);
  });
});

// W2 (CVP-108): with the Review switch on, an edit run finishes as a live composition.
describe('edit prompts with the Review switch on', () => {
  const previewFinish = previewFinishText();
  const finalFinish = readFileSync(`${PROMPTS_DIR}final-finish.md`, 'utf8');
  const GOAL =
    'finish it as a live preview in edit/preview/ (Studio Engine renders the final video after the owner approves).';
  const FIRST_LINES = {
    start: `Edit the footage in this folder with the video-use skill and ${GOAL}\n`,
    resume: `Continue the edit of the footage in this folder with the video-use skill and ${GOAL}\n`,
    retry: `Retry the edit of the footage in this folder with the video-use skill and ${GOAL}\n`,
  } as const;
  const on = { ...job, step: 5 as const, error: 'ffmpeg exited 1', review: true };
  const REGISTRY_LINE =
    "- Start the root composition's main script with `window.__timelines = window.__timelines || {};` (the player loads its runtime after the page's own scripts).\n";

  it.each(RUN_MODES)('%s: the goal is the live preview', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt.startsWith(FIRST_LINES[mode])).toBe(true);
    expect(prompt).not.toContain('deliver edit/final.mp4');
  });

  it.each(RUN_MODES)('%s: ends with preview-finish.md, with the registry line', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt).toBe(`${prompt.trimEnd()}\n`);
    expect(prompt.endsWith(`${previewFinish.trimEnd()}\n`)).toBe(true);
    const rootLine =
      '- The project is edit/preview/. Its root composition is edit/preview/index.html, with data-composition-id, data-width, data-height and data-duration on the root element.\n';
    expect(prompt).toContain(`${rootLine}${REGISTRY_LINE}- Everything the composition loads`);
    expect(prompt).toContain('(§3.5 Mode B)');
    expect(prompt).toContain('Do not run hyperframes render and do not write edit/final.mp4.');
  });

  it.each(RUN_MODES)('%s: the done line is the preview one, and only once', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt.match(/The job is done when/g)).toHaveLength(1);
    expect(prompt).not.toContain('The job is done when edit/final.mp4');
    expect(prompt).toContain(
      'The job is done when edit/preview/index.html passes lint and you have checked the snapshots.',
    );
  });

  it.each(RUN_MODES)(
    '%s: the unattended notes close up, with no gap before the Blocked line',
    async (mode) => {
      const prompt = await buildPrompt(mode, on);
      expect(prompt).toMatch(/everything this run prints is logged\.\n- If you hit a real blocker/);
      expect(prompt).not.toMatch(/\n\n- If you hit a real blocker/);
      expect(prompt).not.toMatch(/\n\n\n/);
    },
  );

  it.each(RUN_MODES)('%s: brief-use and the unattended rules are all still there', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    const briefUse = readFileSync(`${PROMPTS_DIR}brief-use.md`, 'utf8').trimEnd();
    expect(prompt).toContain(
      `Job: client "Acme Studio", job "Launch teaser". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.\n\n${briefUse}\n\n`,
    );
    expect(prompt).toContain('nobody will answer questions, so never ask any');
    expect(prompt).toContain('Skip the ln -sfn line in §1');
    expect(prompt).toContain('preserves display orientation');
    expect(prompt).toContain('always double-quote paths and variables in Bash');
    expect(prompt).toContain('start with "Blocked:"');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('puts the done line of a final.mp4 run only in the unattended notes, before Blocked', async () => {
    const prompt = await buildPrompt('start', { ...job, review: false });
    expect(prompt.match(/The job is done when/g)).toHaveLength(1);
    expect(prompt).toContain(`${finalFinish.trimEnd()}\n- If you hit a real blocker`);
    expect(prompt).not.toContain('Finish the edit as a live preview');
    expect(prompt).not.toContain('live preview in edit/preview/');
    expect(
      prompt.endsWith("Studio Engine shows that sentence to the user as the job's error.\n"),
    ).toBe(true);
  });

  it('final-finish.md is the done line word for word, as a bullet', () => {
    expect(finalFinish).toBe(
      '- The job is done when edit/final.mp4 exists and you have checked it. Do not leave anything running in the background when you finish.\n',
    );
  });

  it('preview-finish.md is the page text with the registry line after the root composition line', () => {
    const lines = previewFinish.split('\n');
    expect(lines[0]).toBe(
      'Finish the edit as a live preview, not a rendered video. The owner watches it in Studio Engine and leaves notes; the final MP4 is rendered only after they approve.',
    );
    expect(lines[3]).toBe(REGISTRY_LINE.trimEnd());
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(14);
  });

  it('preview-finish.md says an exit animation ends inside its clip, after the self-eval line', () => {
    const lines = previewFinish.split('\n');
    expect(lines).toContain(EXIT_LINE);
    expect(lines[lines.indexOf(EXIT_LINE) - 1]).toMatch(/^- Self-eval on the composition/);
  });

  it.each(RUN_MODES)('%s: the Review-on prompt carries the exit rule once', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt.split(`${EXIT_LINE}\n`)).toHaveLength(2);
  });

  it('preview-finish.md has the clear-of-the-picture check right after the exit line', () => {
    const lines = previewFinish.split('\n');
    expect(lines[lines.indexOf(EXIT_LINE) + 1]).toBe(CLEAR_LINE);
    expect(lines.filter((line) => line === CLEAR_LINE)).toHaveLength(1);
  });

  it.each(RUN_MODES)('%s: the Review-on prompt carries the clear check once', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt.split(`${CLEAR_LINE}\n`)).toHaveLength(2);
  });

  it('preview-finish.md asks for the marks the font preview reads, right after the record line, once', () => {
    const lines = previewFinish.split('\n');
    expect(lines.filter((line) => line === MARK_LINE)).toHaveLength(1);
    expect(lines[lines.indexOf(MARK_LINE) - 1]).toMatch(/^- Record the composition in project\.md/);
    expect(lines[lines.indexOf(MARK_LINE) + 1]).toMatch(/^- The job is done when/);
  });

  it.each(RUN_MODES)('%s: the Review-on prompt carries the marks rule once', async (mode) => {
    const prompt = await buildPrompt(mode, on);
    expect(prompt.split(`${MARK_LINE}\n`)).toHaveLength(2);
  });

  it.each(RUN_MODES)('%s: the Review-off prompt has no word about the marks', async (mode) => {
    const prompt = await buildPrompt(mode, { ...on, review: false });
    expect(prompt).not.toContain('data-timeline-role');
  });
});

// GR8: with the graphicsInEdits switch on (`graphics: true`) the prompts of the edit family gain two
// lines, and only those. Off, every prompt is what it was, byte for byte.
describe('the Graphics library in the prompts', () => {
  const UNATTENDED_LINE =
    "- The Graphics library is already copied into edit/graphics/ (one folder per graphic), so use the graphics from there and don't open _Graphics in the inbox.";
  const BRIEF_USE_LINE =
    '- A Graphics library section, when there is one, lists ready-made graphics in edit/graphics/ and how to mount them. A graphic’s When is the owner’s own rule: use it wherever its When fits this video, even when the brief doesn’t mention a graphic there, and wherever the brief or the owner’s note names it, instead of building a new one for that moment. The series and the Client style come first: where they set a graphic for that moment, theirs wins.';
  const SERIES_LINE =
    '- A Series section, when there is one, is the format this job repeats: follow it exactly. The Client style section at the end is the client’s house style. The brief above them wins where they disagree, and the series wins over the style.';
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };

  it('files are in apps/server/prompts, each a single bullet line', () => {
    expect(readFileSync(`${PROMPTS_DIR}unattended-graphics.md`, 'utf8')).toBe(
      `${UNATTENDED_LINE}\n`,
    );
    expect(readFileSync(`${PROMPTS_DIR}brief-use-graphics.md`, 'utf8')).toBe(`${BRIEF_USE_LINE}\n`);
  });

  describe('off', () => {
    it.each(RUN_MODES)('%s: is the golden prompt, byte for byte', async (mode) => {
      const golden = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
      expect(await buildPrompt(mode, GOLDEN_VARS)).toBe(golden);
      expect(await buildPrompt(mode, { ...GOLDEN_VARS, graphics: false })).toBe(golden);
      expect(await buildPrompt(mode, { ...GOLDEN_VARS, review: false, graphics: false })).toBe(
        golden,
      );
    });

    it.each([
      ['an edit run', { ...vars }],
      ['an edit run in Review', { ...vars, review: true }],
      ['a revise run', { ...vars, kind: 'revise' as const, round: 1, review: true }],
      ['a render run', { ...vars, kind: 'render' as const }],
    ])('%s: says nothing of the library', async (_name, over) => {
      for (const graphics of [undefined, false]) {
        const prompt = await buildPrompt('start', { ...over, graphics });
        expect(prompt).not.toMatch(/edit\/graphics|_Graphics|Graphics library/);
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
      }
    });
  });

  describe('on', () => {
    it.each(RUN_MODES)(
      '%s: adds the unattended line right after the read-only line',
      async (mode) => {
        const prompt = await buildPrompt(mode, { ...vars, graphics: true });
        expect(prompt).toContain(`${READ_ONLY_LINE}\n${UNATTENDED_LINE}\n- macOS tools:`);
        expect(prompt.split(UNATTENDED_LINE).length - 1).toBe(1);
      },
    );

    it.each(RUN_MODES)(
      '%s: adds the brief-use line last in brief-use, after the Series line',
      async (mode) => {
        const prompt = await buildPrompt(mode, { ...vars, graphics: true });
        expect(prompt).toContain(`${SERIES_LINE}\n${BRIEF_USE_LINE}\n\n`);
        expect(prompt.split(BRIEF_USE_LINE).length - 1).toBe(1);
      },
    );

    it.each(RUN_MODES)('%s: changes nothing else', async (mode) => {
      for (const review of [false, true]) {
        const off = await buildPrompt(mode, { ...vars, review });
        const on = await buildPrompt(mode, { ...vars, review, graphics: true });
        expect(on).not.toBe(off);
        expect(on.replace(`${UNATTENDED_LINE}\n`, '').replace(`${BRIEF_USE_LINE}\n`, '')).toBe(off);
      }
    });

    it('a revise run gets both lines, and nothing else changes', async () => {
      const revise = { ...vars, kind: 'revise' as const, round: 2, review: true };
      const off = await buildPrompt('start', revise);
      const on = await buildPrompt('start', { ...revise, graphics: true });
      expect(on).toContain(UNATTENDED_LINE);
      expect(on).toContain(BRIEF_USE_LINE);
      expect(on.replace(`${UNATTENDED_LINE}\n`, '').replace(`${BRIEF_USE_LINE}\n`, '')).toBe(off);
    });

    it('a render run gets the unattended line only: it never reads the brief', async () => {
      const render = { ...vars, kind: 'render' as const };
      const off = await buildPrompt('start', render);
      const on = await buildPrompt('start', { ...render, graphics: true });
      expect(on).toContain(UNATTENDED_LINE);
      expect(on).not.toContain(BRIEF_USE_LINE);
      expect(on.replace(`${UNATTENDED_LINE}\n`, '')).toBe(off);
    });

    it.each(RUN_MODES)(
      '%s: keeps the unattended notes closed up and every placeholder filled',
      async (mode) => {
        const prompt = await buildPrompt(mode, { ...vars, graphics: true, review: true });
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
        expect(prompt).toMatch(
          /everything this run prints is logged\.\n- If you hit a real blocker/,
        );
      },
    );
  });
});

// LU9 (CVP-310): a LUT named in a note. With no references (the lutsInEdits switch off, or notes
// that name nothing) every prompt is what it was, byte for byte. With some, an edit run gets the
// "Library references" bullet after the colour grade, a revise run in its list after "Do what each
// note asks", each with only the parts for the kinds named; a render run never does.
describe('LUTs named in notes (LU9)', () => {
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const golden = (name: string, over: object = {}) => ({
    slug: name,
    name: name === 'golden-hour-warm' ? 'Golden Hour Warm' : name,
    kind: 'look' as const,
    owner: 'yours' as const,
    path: `edit/luts/${name}.cube`,
    look: null,
    ...over,
  });
  const GOLDEN_HOUR = golden('golden-hour-warm');
  const LED_FIX = golden('led-green-fix', { name: 'LED green fix', kind: 'fix', owner: 'builtIn' });
  const S_LOG = golden('s-gamut3-to-cine', { name: 'S-Gamut3 to Cine', kind: 'camera' });
  const CINEMATIC = {
    slug: 'cinematic',
    name: 'Cinematic',
    kind: 'look' as const,
    owner: 'builtIn' as const,
    path: null,
    look: 'cinematic' as const,
  };
  const INTRO = {
    slug: 'intro',
    id: 'a1b2c3d4e5f6',
    name: 'Intro',
    path: 'edit/graphics/a1b2c3d4e5f6',
  };
  const none = { luts: [], graphics: [], missing: [] };
  const PARTS = [
    'luts-use',
    'luts-use-look',
    'luts-use-cinematic',
    'luts-use-camera',
    'luts-use-graphic',
  ];
  const REFS_START = '- Library references:';
  const KINDS: [string, PromptVars][] = [
    ['an edit run', { ...vars }],
    ['an edit run in Review', { ...vars, review: true }],
    ['an edit run with graphics', { ...vars, graphics: true }],
    ['a revise run', { ...vars, kind: 'revise', round: 1, review: true }],
    ['a render run', { ...vars, kind: 'render' }],
  ];

  it('has its five parts in apps/server/prompts', () => {
    for (const name of PARTS) expect(existsSync(`${PROMPTS_DIR}${name}.md`), name).toBe(true);
  });

  describe('without references', () => {
    it.each(RUN_MODES)('%s: is the golden prompt, byte for byte', async (mode) => {
      const expected = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
      for (const libraryRefs of [undefined, null, none]) {
        expect(await buildPrompt(mode, { ...GOLDEN_VARS, libraryRefs })).toBe(expected);
      }
    });

    it.each(KINDS)('%s: is the prompt without them, in every mode', async (_name, over) => {
      for (const mode of RUN_MODES) {
        const before = await buildPrompt(mode, over);
        for (const libraryRefs of [null, none]) {
          expect(await buildPrompt(mode, { ...over, libraryRefs })).toBe(before);
        }
        expect(before).not.toMatch(/Library references|--look-lut|\{\{|\}\}/);
      }
    });
  });

  describe('with a Look and a Fix LUT', () => {
    const refs = { luts: [GOLDEN_HOUR, LED_FIX], graphics: [], missing: [] };

    it('an edit run lists them, with the command, after the colour grade', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toContain(
          '  - @luts/golden-hour-warm: “Golden Hour Warm”, a Look LUT, file ./edit/luts/golden-hour-warm.cube\n' +
            '  - @luts/led-green-fix: “LED green fix”, a Fix LUT, file ./edit/luts/led-green-fix.cube\n',
        );
        expect(prompt).toContain(
          'Add `--look-lut ./edit/luts/golden-hour-warm.cube --look-lut ./edit/luts/led-green-fix.cube` to its command (once per LUT, in the order the notes name them) in a fresh output directory.',
        );
        // After the colour grade's three bullets, before the ElevenLabs line.
        expect(prompt).toMatch(
          /- Bake from edit\/color-grade\/edl\.graded\.json[^\n]*\n- Library references:[^\n]*\n {2}- @luts\/golden-hour-warm[^\n]*\n {2}- @luts\/led-green-fix[^\n]*\n {2}- Look and Fix LUTs:[^\n]*\n- The ElevenLabs key/,
        );
        // Only the Look/Fix part: nothing about the other kinds.
        expect(prompt).not.toMatch(
          /Cinematic is not a file|Camera LUTs convert|Graphics are placed/,
        );
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
        expect(prompt).not.toMatch(/[ \t]$/m);
      }
    });

    it('says what a LUT in a note means and what never to do', async () => {
      const prompt = await buildPrompt('start', { ...vars, libraryRefs: refs });
      expect(prompt).toContain(
        'A LUT named in a note applies to the whole video, at full strength: do what the note says about where, if it says.',
      );
      expect(prompt).toContain('never add another grade in render.py or HyperFrames.');
      expect(prompt).toContain("`--look-lut` replaces the EDL's list");
      expect(prompt).toContain('color_grade.look_luts in edit/edl.json');
    });

    it('tells the colour-grade part about --look-lut, once, and only then', async () => {
      const note =
        'Besides `--look`, the wrapper has `--look-lut FILE.cube` for a LUT the notes name: see Library references.';
      for (const over of [{ ...vars }, { ...vars, kind: 'revise' as const, round: 1 }]) {
        const on = await buildPrompt('start', { ...over, libraryRefs: refs });
        expect(on.split(note)).toHaveLength(2);
        const off = await buildPrompt('start', over);
        expect(off).not.toContain('--look-lut');
        // The note ends the colour-grade bullet it is in.
        expect(on).toMatch(
          new RegExp(`(grading settings still match\\.|range times\\.) ${literal(note)}\\n`),
        );
      }
    });

    it('a revise run has the block in its list, right after “Do what each note asks”, and once', async () => {
      const revise = { ...vars, kind: 'revise' as const, round: 2, review: true };
      const prompt = await buildPrompt('start', { ...revise, libraryRefs: refs });
      expect(prompt.split(REFS_START)).toHaveLength(2);
      expect(prompt).toMatch(
        /- Do what each note asks and nothing else\.[^\n]*\n- Library references:[^\n]*\n {2}- @luts\/golden-hour-warm[^\n]*\n {2}- @luts\/led-green-fix[^\n]*\n {2}- Look and Fix LUTs:[^\n]*\n- A note that is unclear/,
      );
      // The unattended notes (further down) do not repeat it.
      expect(prompt.indexOf(REFS_START)).toBeLessThan(prompt.indexOf('This run is unattended'));
    });

    it('a revise run with the music part keeps it after the references', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        kind: 'revise',
        round: 1,
        review: true,
        music: true,
        musicScript: '/engine/make-music.mjs',
        libraryRefs: refs,
      });
      expect(prompt.indexOf(REFS_START)).toBeGreaterThan(prompt.indexOf('Do what each note asks'));
      expect(prompt.indexOf(REFS_START)).toBeLessThan(prompt.indexOf('make-music.mjs'));
      expect(prompt).not.toMatch(/\n\n\n/);
    });

    it('changes nothing else: taking the block out gives the prompt without it', async () => {
      for (const [, over] of KINDS.filter(([name]) => !name.includes('render'))) {
        for (const mode of RUN_MODES) {
          const off = await buildPrompt(mode, over);
          const on = await buildPrompt(mode, { ...over, libraryRefs: refs });
          const note =
            ' Besides `--look`, the wrapper has `--look-lut FILE.cube` for a LUT the notes name: see Library references.';
          const stripped = on
            .replace(note, '')
            .replace(/^- Library references:.*\n(?: {2}- .*\n)+/m, '');
          expect(stripped).toBe(off);
        }
      }
    });

    it('a render run is never told: it renders what was approved', async () => {
      const render = { ...vars, kind: 'render' as const };
      expect(await buildPrompt('start', { ...render, libraryRefs: refs })).toBe(
        await buildPrompt('start', render),
      );
    });

    it('the --look-lut arguments in the prompt parse in the real wrapper, in order', async () => {
      const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
      if (python.status !== 0) return; // no python3 here: the Python tests are skipped too
      const prompt = await buildPrompt('start', { ...vars, libraryRefs: refs });
      const args = /Add `(--look-lut [^`]+)` to its command/.exec(prompt)?.[1];
      expect(args).toBeDefined();
      const script = fileURLToPath(
        new URL('../../../../scripts/color-grade/grade_batch.py', import.meta.url),
      );
      const code = [
        'import importlib.util, json, shlex, sys',
        'spec = importlib.util.spec_from_file_location("grade_batch", sys.argv[1])',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules["grade_batch"] = module',
        'spec.loader.exec_module(module)',
        'args = module.parser().parse_args(shlex.split(sys.argv[2]))',
        'print(json.dumps([str(p) for p in args.look_lut]))',
      ].join('\n');
      const run = spawnSync('python3', ['-I', '-c', code, script, args as string], {
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout)).toEqual([
        'edit/luts/golden-hour-warm.cube',
        'edit/luts/led-green-fix.cube',
      ]);
    });
  });

  describe('with the other kinds', () => {
    it('Cinematic: the wrapper’s own look, no file, no --look-lut', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: { luts: [CINEMATIC], graphics: [], missing: [] },
      });
      expect(prompt).toContain(
        '  - @luts/cinematic: “Cinematic”, the built-in Cinematic look (no file).',
      );
      expect(prompt).toContain('use its existing `--look cinematic`');
      expect(prompt).not.toMatch(/Look and Fix LUTs:|Camera LUTs convert|Graphics are placed/);
      expect(prompt).not.toContain('`--look-lut ');
      expect(prompt).not.toContain('edit/luts/cinematic');
    });

    it('a Camera LUT: set it in the EDL for the log source, then rerun the wrapper', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: { luts: [S_LOG], graphics: [], missing: [] },
      });
      expect(prompt).toContain(
        '  - @luts/s-gamut3-to-cine: “S-Gamut3 to Cine”, a Camera LUT, file ./edit/luts/s-gamut3-to-cine.cube',
      );
      expect(prompt).toContain(
        'set color_grade.sources.<source id>.camera_lut in edit/edl.json to the file',
      );
      expect(prompt).not.toMatch(/Look and Fix LUTs:|Cinematic is not a file|Graphics are placed/);
      expect(prompt).not.toContain('--look-lut ./');
    });

    it('a graphic: name it and its copy, place it at the note’s time', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        graphics: true,
        libraryRefs: { luts: [], graphics: [INTRO], missing: [] },
      });
      expect(prompt).toContain(
        '  - @graphics/intro: the library graphic “Intro”, its copy is in ./edit/graphics/a1b2c3d4e5f6/',
      );
      expect(prompt).toContain('Graphics are placed at a time, unlike a LUT');
      expect(prompt).not.toMatch(/Look and Fix LUTs:|Cinematic is not a file|Camera LUTs convert/);
      // No LUT is named, so the colour-grade parts say nothing about --look-lut.
      expect(prompt).not.toContain('`--look-lut');
    });

    it('all kinds at once, in one block, each part once and the list in the order given', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: {
          luts: [GOLDEN_HOUR, CINEMATIC, S_LOG, LED_FIX],
          graphics: [INTRO],
          missing: [],
        },
      });
      for (const part of [
        'Look and Fix LUTs:',
        'Cinematic is not a file',
        'Camera LUTs convert',
        'Graphics are placed',
      ]) {
        expect(prompt.split(part), part).toHaveLength(2);
      }
      expect(prompt).toContain(
        '`--look-lut ./edit/luts/golden-hour-warm.cube --look-lut ./edit/luts/led-green-fix.cube`',
      );
      const order = [
        '@luts/golden-hour-warm:',
        '@luts/cinematic:',
        '@luts/s-gamut3-to-cine:',
        '@luts/led-green-fix:',
        '@graphics/intro:',
      ].map((t) => prompt.indexOf(t));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((index) => index > 0)).toBe(true);
    });
  });

  describe('a token that points at nothing', () => {
    const missing = (over: object) => ({
      luts: [],
      graphics: [],
      missing: [
        { library: 'luts' as const, slug: 'xyz', reason: 'notInLibrary' as const, ...over },
      ],
    });

    it('says so and asks for the closest thing, without failing', async () => {
      const prompt = await buildPrompt('start', { ...vars, libraryRefs: missing({}) });
      expect(prompt).toContain(
        '  - The note names @luts/xyz, which is not in the library. Do the closest thing and say so in project.md.',
      );
      expect(prompt).not.toMatch(/Look and Fix LUTs:|--look-lut/);
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('a file that could not be copied, and a graphic the job has no copy of', async () => {
      const noFile = await buildPrompt('start', {
        ...vars,
        libraryRefs: missing({ reason: 'noFile' }),
      });
      expect(noFile).toContain(
        '  - The note names @luts/xyz, but its file could not be copied into this job. Do the closest thing and say so in project.md.',
      );
      const notInJob = await buildPrompt('start', {
        ...vars,
        libraryRefs: missing({ library: 'graphics', reason: 'notInJob' }),
      });
      expect(notInJob).toContain(
        '  - The note names @graphics/xyz, which is in the library but not in this job’s edit/graphics/. Do the closest thing and say so in project.md.',
      );
    });

    it('sits with the ones that were found', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: { luts: [GOLDEN_HOUR], graphics: [], missing: missing({}).missing },
      });
      expect(prompt).toMatch(
        /file \.\/edit\/luts\/golden-hour-warm\.cube\n {2}- The note names @luts\/xyz, which is not in the library\./,
      );
    });
  });

  it('never reads a name as a template: braces and line breaks in it stay on one line', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: {
        luts: [golden('odd', { name: 'A {{round}}\nB }}' })],
        graphics: [],
        missing: [],
      },
    });
    expect(prompt).toContain('  - @luts/odd: “A round B”, a Look LUT, file ./edit/luts/odd.cube\n');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });
});

// FN15 (CVP-348): the fonts a note names join the same "Library references" block as the LUTs and
// graphics, with one more part, fonts-use.md. With no font named every prompt is what it was; the
// three snapshots (fonts-revise-one/-two, fonts-edit-one) hold the whole prompt with fonts named.
// The edit snapshot is the edit run that follows a Brief whose note names a font: the run reads
// brief.md (which holds the note word for word) and is told the file by this block.
describe('fonts named in notes (FN15)', () => {
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const HEEBO_BLACK = {
    face: 'Heebo Black',
    family: 'Heebo',
    weight: 900,
    italic: false,
    path: 'edit/fonts/Hebrew + English/Heebo/Heebo-Black.ttf',
    he: true,
  };
  const POPPINS_BOLD = {
    face: 'Poppins Bold',
    family: 'Poppins',
    weight: 700,
    italic: false,
    path: 'edit/fonts/English only/Poppins/Poppins-Bold.ttf',
    he: false,
  };
  const MERRIWEATHER_ITALIC = {
    face: 'Merriweather Italic',
    family: 'Merriweather',
    weight: 400,
    italic: true,
    path: 'edit/fonts/English only/Merriweather/Merriweather-Italic.ttf',
    he: false,
  };
  const withFonts = (fonts: (typeof HEEBO_BLACK)[]) => ({
    luts: [],
    graphics: [],
    missing: [],
    fonts,
  });
  const golden = (name: string, over: object = {}) => ({
    slug: name,
    name: 'Golden Hour Warm',
    kind: 'look' as const,
    owner: 'yours' as const,
    path: `edit/luts/${name}.cube`,
    look: null,
    ...over,
  });
  const INTRO_FONTS =
    "the notes name fonts of the owner's library with an @ and the font's full name";
  const RULE =
    "  - Fonts: Use each of these fonts for the text the note names with it (for example the captions, the titles, a lower third). If the note names no text, use it for all the text you add. Load it with @font-face from the file above and check it has the letters of the video's language. A font whose script says English only is never used for Hebrew words: keep the font the Hebrew words have now and change only the English ones.";
  const LINE_BLACK =
    '  - @Heebo Black: “Heebo Black”, script Hebrew + English, family Heebo, weight 900, file ./edit/fonts/Hebrew + English/Heebo/Heebo-Black.ttf';
  const LINE_POPPINS =
    '  - @Poppins Bold: “Poppins Bold”, script English only, family Poppins, weight 700, file ./edit/fonts/English only/Poppins/Poppins-Bold.ttf';
  const REFS_START = '- Library references:';
  const KINDS: [string, PromptVars][] = [
    ['an edit run', { ...vars }],
    ['an edit run in Review', { ...vars, review: true }],
    ['an edit run with graphics', { ...vars, graphics: true }],
    ['a revise run', { ...vars, kind: 'revise', round: 1, review: true }],
    ['a render run', { ...vars, kind: 'render' }],
  ];

  it('has its partial in apps/server/prompts, with the rule in plain words', () => {
    const part = readFileSync(`${PROMPTS_DIR}fonts-use.md`, 'utf8').trimEnd();
    expect(part).toBe(RULE);
    // The rule is the last part of the block LUTs and graphics already use.
    expect(readFileSync(`${PROMPTS_DIR}luts-use.md`, 'utf8')).toMatch(
      /\{\{> luts-use-graphic\}\}\n\{\{> fonts-use\}\}\n$/,
    );
  });

  describe('without fonts', () => {
    it.each(RUN_MODES)('%s: is the golden prompt, byte for byte', async (mode) => {
      const expected = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
      const none = [undefined, null, withFonts([])];
      for (const libraryRefs of [...none, { ...withFonts([]), unresolvedFonts: [] }]) {
        expect(await buildPrompt(mode, { ...GOLDEN_VARS, libraryRefs })).toBe(expected);
      }
    });

    it.each(KINDS)('%s: has no block and no font word, in every mode', async (_name, over) => {
      for (const mode of RUN_MODES) {
        const before = await buildPrompt(mode, over);
        const empty = { ...withFonts([]), unresolvedFonts: [] };
        for (const libraryRefs of [null, withFonts([]), empty]) {
          expect(await buildPrompt(mode, { ...over, libraryRefs })).toBe(before);
        }
        expect(before).not.toMatch(/Library references|Gotham|@font-face from the file above/);
      }
    });
  });

  describe('with one font', () => {
    const refs = withFonts([HEEBO_BLACK]);

    it('an edit run lists it after the colour grade, with the rule, and says nothing about LUTs', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toContain(
          `- Library references: ${INTRO_FONTS} (like @Heebo Bold), and Studio`,
        );
        expect(prompt).toMatch(
          new RegExp(
            `- Bake from edit/color-grade/edl\\.graded\\.json[^\\n]*\\n- Library references:[^\\n]*\\n${literal(LINE_BLACK)}\\n${literal(RULE)}\\n- The ElevenLabs key`,
          ),
        );
        expect(prompt.split(RULE)).toHaveLength(2);
        expect(prompt).not.toMatch(
          /A LUT named in a note|--look-lut|Cinematic is not a file|Camera LUTs convert|Graphics are placed/,
        );
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
        expect(prompt).not.toMatch(/[ \t]$/m);
      }
    });

    it('a revise run has the block in its list, right after “Do what each note asks”, and once', async () => {
      const revise = { ...vars, kind: 'revise' as const, round: 2, review: true };
      const prompt = await buildPrompt('start', { ...revise, libraryRefs: refs });
      expect(prompt.split(REFS_START)).toHaveLength(2);
      expect(prompt).toMatch(
        new RegExp(
          `- Do what each note asks and nothing else\\.[^\\n]*\\n- Library references:[^\\n]*\\n${literal(LINE_BLACK)}\\n${literal(RULE)}\\n- A note that is unclear`,
        ),
      );
      expect(prompt.indexOf(REFS_START)).toBeLessThan(prompt.indexOf('This run is unattended'));
    });

    it('a revise run with the music part keeps it after the references', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        kind: 'revise',
        round: 1,
        review: true,
        music: true,
        musicScript: '/engine/make-music.mjs',
        libraryRefs: refs,
      });
      expect(prompt.indexOf(REFS_START)).toBeGreaterThan(prompt.indexOf('Do what each note asks'));
      expect(prompt.indexOf(REFS_START)).toBeLessThan(prompt.indexOf('make-music.mjs'));
      expect(prompt).not.toMatch(/\n\n\n/);
    });

    it('changes nothing else: taking the block out gives the prompt without it', async () => {
      for (const [, over] of KINDS.filter(([name]) => !name.includes('render'))) {
        for (const mode of RUN_MODES) {
          const off = await buildPrompt(mode, over);
          const on = await buildPrompt(mode, { ...over, libraryRefs: refs });
          const stripped = on.replace(/^- Library references:.*\n(?: {2}- .*\n)+/m, '');
          expect(stripped).toBe(off);
        }
      }
    });

    it('a render run is never told: it renders what was approved', async () => {
      const render = { ...vars, kind: 'render' as const };
      expect(await buildPrompt('start', { ...render, libraryRefs: refs })).toBe(
        await buildPrompt('start', render),
      );
    });

    it('the camera-log bullet (LU10) of an edit run comes after the fonts rule, and only there', async () => {
      const camera = { curves: [], byNote: false };
      const edit = await buildPrompt('start', { ...vars, libraryRefs: { ...refs, camera } });
      expect(edit).toContain(`${RULE}\n- Camera log:`);
      expect(edit.split(REFS_START)).toHaveLength(2);
      const revise = { ...vars, kind: 'revise' as const, round: 1 };
      expect(await buildPrompt('start', { ...revise, libraryRefs: { ...refs, camera } })).toBe(
        await buildPrompt('start', { ...revise, libraryRefs: refs }),
      );
    });

    it('names a font that has no Hebrew by its script, and an italic by its style', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: withFonts([POPPINS_BOLD, MERRIWEATHER_ITALIC]),
      });
      expect(prompt).toContain(`${LINE_POPPINS}\n`);
      expect(prompt).toContain(
        '  - @Merriweather Italic: “Merriweather Italic”, script English only, family Merriweather, weight 400, italic, file ./edit/fonts/English only/Merriweather/Merriweather-Italic.ttf\n',
      );
    });
  });

  describe('with two fonts', () => {
    const refs = withFonts([HEEBO_BLACK, POPPINS_BOLD]);

    it('lists each once, in the order the notes name them, with one rule after them', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toContain(`${LINE_BLACK}\n${LINE_POPPINS}\n${RULE}\n`);
        expect(prompt.split(RULE)).toHaveLength(2);
      }
    });
  });

  describe('with a font and a LUT or a graphic', () => {
    const intro = {
      slug: 'intro',
      id: 'a1b2c3d4e5f6',
      name: 'Intro',
      path: 'edit/graphics/a1b2c3d4e5f6',
    };
    const refs = {
      luts: [golden('golden-hour-warm')],
      graphics: [intro],
      missing: [],
      fonts: [HEEBO_BLACK],
    };
    const MIXED =
      "@luts/…, @graphics/… and font tokens (an @ and the font's full name, like @Heebo Bold)";

    it('is one block: the LUT and graphic lines, then the font line, then each part, the fonts rule last', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toMatch(
          new RegExp(
            `- Library references: the notes name items of the owner's library with ${literal(MIXED)}, and Studio Engine has already found them for you\\. A LUT named in a note applies to the whole video[^\\n]*\\n` +
              ` {2}- @luts/golden-hour-warm: [^\\n]*\\n` +
              ` {2}- @graphics/intro: [^\\n]*\\n${literal(LINE_BLACK)}\\n` +
              ` {2}- Look and Fix LUTs: [^\\n]*\\n` +
              ` {2}- Graphics are placed at a time[^\\n]*\\n${literal(RULE)}\\n- The ElevenLabs key`,
          ),
        );
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
      }
    });

    it('leaves each kind to its own part: taking out the font gives the LUT block as it was', async () => {
      const lutsOnly = { luts: refs.luts, graphics: refs.graphics, missing: [] };
      for (const over of [{ ...vars }, { ...vars, kind: 'revise' as const, round: 1 }]) {
        const before = await buildPrompt('start', { ...over, libraryRefs: lutsOnly });
        const on = await buildPrompt('start', { ...over, libraryRefs: refs });
        const stripped = on
          .replace(`${LINE_BLACK}\n`, '')
          .replace(`${RULE}\n`, '')
          .replace(MIXED, '@luts/… and @graphics/… tokens');
        expect(stripped).toBe(before);
      }
    });

    it('a LUT that points at nothing and a font are still one block', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: {
          luts: [],
          graphics: [],
          missing: [{ library: 'luts', slug: 'zzz', reason: 'notInLibrary' }],
          fonts: [HEEBO_BLACK],
        },
      });
      expect(prompt.split(REFS_START)).toHaveLength(2);
      expect(prompt).toMatch(
        new RegExp(
          `\\n {2}- The note names @luts/zzz, which is not in the library\\.[^\\n]*\\n${literal(LINE_BLACK)}\\n${literal(RULE)}\\n`,
        ),
      );
    });
  });

  it('never reads a name as a template: braces and line breaks in it stay on one line', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: withFonts([
        { ...HEEBO_BLACK, face: 'Odd {{round}}\nName }}', family: 'Odd {{job}}' },
      ]),
    });
    expect(prompt).toContain(
      '  - @Odd round Name: “Odd round Name”, script Hebrew + English, family Odd job, weight 900, file ./edit/fonts/Hebrew + English/Heebo/Heebo-Black.ttf\n',
    );
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  describe('the whole prompt (snapshot)', () => {
    it.each([
      [
        'fonts-revise-one',
        {
          ...GOLDEN_VARS,
          kind: 'revise',
          round: 1,
          review: true,
          libraryRefs: withFonts([HEEBO_BLACK]),
        },
      ],
      [
        'fonts-revise-two',
        {
          ...GOLDEN_VARS,
          kind: 'revise',
          round: 2,
          review: true,
          libraryRefs: withFonts([HEEBO_BLACK, POPPINS_BOLD]),
        },
      ],
      ['fonts-edit-one', { ...GOLDEN_VARS, review: true, libraryRefs: withFonts([HEEBO_BLACK]) }],
    ] as [string, PromptVars][])('%s', async (name, over) => {
      const captured = readFileSync(`${GOLDEN_DIR}${name}.txt`, 'utf8');
      expect(await buildPrompt('start', over)).toBe(await withColorGrade(captured, over));
    });
  });
});

// FN16 (CVP-349): a font name the library does not have. The note still names it, so the run is told
// (one list line per name, in the same "Library references" block) to use the closest font that is
// there and say which; the job does not wait. The wording is one line per name, so there is no rule
// part of its own. Three snapshots (fonts-missing-one/-two/-mixed) hold the whole revise prompt.
describe('a font name the library does not have (FN16)', () => {
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const HEEBO_BLACK = {
    face: 'Heebo Black',
    family: 'Heebo',
    weight: 900,
    italic: false,
    path: 'edit/fonts/Hebrew + English/Heebo/Heebo-Black.ttf',
    he: true,
  };
  const asked = (unresolvedFonts: string[], fonts: (typeof HEEBO_BLACK)[] = []) => ({
    luts: [],
    graphics: [],
    missing: [],
    fonts,
    unresolvedFonts,
  });
  const MISSING = (name: string) =>
    `  - The owner asked for ${name}; it is not in edit/fonts/. Use the closest font that is there and say which one you used in your answer.`;
  const NONE_INTRO =
    "the notes name a font with an @ and the font's full name (like @Heebo Bold) that the owner's library does not have.";
  const SOME_INTRO =
    "the notes name fonts of the owner's library with an @ and the font's full name (like @Heebo Bold), and Studio Engine has already found the ones the library has.";
  const LINE_BLACK =
    '  - @Heebo Black: “Heebo Black”, script Hebrew + English, family Heebo, weight 900, file ./edit/fonts/Hebrew + English/Heebo/Heebo-Black.ttf';
  const RULE_START = '  - Fonts: Use each of these fonts';
  const REFS_START = '- Library references:';

  it('counts as something to say', () => {
    expect(hasLibraryRefs(asked(['Gotham Bold']))).toBe(true);
    expect(hasLibraryRefs(asked([]))).toBe(false);
    expect(hasLibraryRefs({ luts: [], graphics: [], missing: [] })).toBe(false);
  });

  describe('one name', () => {
    const refs = asked(['Gotham Bold']);

    it('an edit run lists it after the colour grade and says nothing about LUTs or a fonts rule', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toMatch(
          new RegExp(
            `- Bake from edit/color-grade/edl\\.graded\\.json[^\\n]*\\n- Library references: ${literal(NONE_INTRO)}\\n${literal(MISSING('Gotham Bold'))}\\n- The ElevenLabs key`,
          ),
        );
        // No font was found, so the rule for the files that were found is not there.
        expect(prompt).not.toContain(RULE_START);
        expect(prompt).not.toMatch(
          /A LUT named in a note|--look-lut|Cinematic is not a file|Camera LUTs convert|Graphics are placed|already found them/,
        );
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
        expect(prompt).not.toMatch(/[ \t]$/m);
      }
    });

    it('a revise run has it in its list, right after “Do what each note asks”, and once', async () => {
      const revise = { ...vars, kind: 'revise' as const, round: 2, review: true };
      const prompt = await buildPrompt('start', { ...revise, libraryRefs: refs });
      expect(prompt.split(REFS_START)).toHaveLength(2);
      expect(prompt).toMatch(
        new RegExp(
          `- Do what each note asks and nothing else\\.[^\\n]*\\n- Library references: ${literal(NONE_INTRO)}\\n${literal(MISSING('Gotham Bold'))}\\n- A note that is unclear`,
        ),
      );
    });

    it('changes nothing else: taking the block out gives the prompt without it', async () => {
      for (const [, over] of [
        ['an edit run', { ...vars }],
        ['an edit run in Review', { ...vars, review: true }],
        ['a revise run', { ...vars, kind: 'revise' as const, round: 1, review: true }],
      ] as [string, PromptVars][]) {
        for (const mode of RUN_MODES) {
          const off = await buildPrompt(mode, over);
          const on = await buildPrompt(mode, { ...over, libraryRefs: refs });
          const stripped = on.replace(/^- Library references:.*\n(?: {2}- .*\n)+/m, '');
          expect(stripped).toBe(off);
        }
      }
    });

    it('a render run is never told: it renders what was approved', async () => {
      const render = { ...vars, kind: 'render' as const };
      expect(await buildPrompt('start', { ...render, libraryRefs: refs })).toBe(
        await buildPrompt('start', render),
      );
    });

    it('keeps the camera-log bullet (LU10) of an edit run after the block', async () => {
      const camera = { curves: [], byNote: false };
      const edit = await buildPrompt('start', { ...vars, libraryRefs: { ...refs, camera } });
      expect(edit).toContain(`${MISSING('Gotham Bold')}\n- Camera log:`);
      expect(edit.split(REFS_START)).toHaveLength(2);
    });

    it('never reads a name as a template: braces and line breaks in it stay on one line', async () => {
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: asked(['Odd {{round}}\nName }}']),
      });
      expect(prompt).toContain(`${MISSING('Odd round Name')}\n`);
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });
  });

  describe('two names', () => {
    const refs = asked(['Gotham Bold', 'Proxima Nova Bold']);

    it('lists each once, in the order the notes name them, in one block', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toContain(
          `- Library references: ${NONE_INTRO}\n${MISSING('Gotham Bold')}\n${MISSING('Proxima Nova Bold')}\n`,
        );
        expect(prompt.split(MISSING('Gotham Bold'))).toHaveLength(2);
        expect(prompt).not.toContain(RULE_START);
      }
    });
  });

  describe('a note that names a font that is there and one that is not', () => {
    const refs = asked(['Gotham Bold'], [HEEBO_BLACK]);

    it('is one block: the missing name, then the font line, then the fonts rule last', async () => {
      for (const mode of RUN_MODES) {
        const prompt = await buildPrompt(mode, { ...vars, libraryRefs: refs });
        expect(prompt.split(REFS_START)).toHaveLength(2);
        expect(prompt).toMatch(
          new RegExp(
            `- Library references: ${literal(SOME_INTRO)}\\n${literal(MISSING('Gotham Bold'))}\\n${literal(LINE_BLACK)}\\n${literal(RULE_START)}[^\\n]*\\n- The ElevenLabs key`,
          ),
        );
        expect(prompt).not.toMatch(/\{\{|\}\}/);
        expect(prompt).not.toMatch(/\n\n\n/);
      }
    });

    it('leaves the found font to its own part: taking out the missing name gives the font-only block', async () => {
      for (const over of [{ ...vars }, { ...vars, kind: 'revise' as const, round: 1 }]) {
        const fontOnly = await buildPrompt('start', {
          ...over,
          libraryRefs: asked([], [HEEBO_BLACK]),
        });
        const on = await buildPrompt('start', { ...over, libraryRefs: refs });
        const stripped = on
          .replace(`${MISSING('Gotham Bold')}\n`, '')
          .replace(
            SOME_INTRO,
            "the notes name fonts of the owner's library with an @ and the font's full name (like @Heebo Bold), and Studio Engine has already found them for you.",
          );
        expect(stripped).toBe(fontOnly);
      }
    });
  });

  describe('with a LUT in the same note', () => {
    const lut = {
      slug: 'golden-hour-warm',
      name: 'Golden Hour Warm',
      kind: 'look' as const,
      owner: 'yours' as const,
      path: 'edit/luts/golden-hour-warm.cube',
      look: null,
    };

    it('is one block with the mixed intro: the LUT line, the missing name, each part', async () => {
      const MIXED =
        "@luts/…, @graphics/… and font tokens (an @ and the font's full name, like @Heebo Bold)";
      const prompt = await buildPrompt('start', {
        ...vars,
        libraryRefs: { ...asked(['Gotham Bold']), luts: [lut] },
      });
      expect(prompt.split(REFS_START)).toHaveLength(2);
      expect(prompt).toMatch(
        new RegExp(
          `- Library references: the notes name items of the owner's library with ${literal(MIXED)}, and Studio Engine has already found them for you\\. A LUT named in a note[^\\n]*\\n` +
            ` {2}- @luts/golden-hour-warm: [^\\n]*\\n${literal(MISSING('Gotham Bold'))}\\n` +
            ` {2}- Look and Fix LUTs: [^\\n]*\\n- The ElevenLabs key`,
        ),
      );
      expect(prompt).not.toContain(RULE_START);
    });
  });

  describe('the whole prompt (snapshot)', () => {
    const revise = (round: number): PromptVars => ({
      ...GOLDEN_VARS,
      kind: 'revise',
      round,
      review: true,
    });
    it.each([
      ['fonts-missing-one', { ...revise(1), libraryRefs: asked(['Gotham Bold']) }],
      [
        'fonts-missing-two',
        { ...revise(2), libraryRefs: asked(['Gotham Bold', 'Proxima Nova Bold']) },
      ],
      ['fonts-missing-mixed', { ...revise(1), libraryRefs: asked(['Gotham Bold'], [HEEBO_BLACK]) }],
    ] as [string, PromptVars][])('%s', async (name, over) => {
      const captured = readFileSync(`${GOLDEN_DIR}${name}.txt`, 'utf8');
      expect(await buildPrompt('start', over)).toBe(await withColorGrade(captured, over));
    });
  });
});

// LU10 (CVP-311): camera log. With lutsInEdits on, an edit run is told what its footage says about a
// log curve and which Camera LUT matches; the line it must end with when the grade finds log and has
// no LUT is the sentence the page reads. Without the camera answer every prompt is what it was.
describe('camera log in the edit prompts (LU10)', () => {
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const camera = (over: Partial<RunCameraLuts> = {}): RunCameraLuts => ({
    curves: [],
    byNote: false,
    ...over,
  });
  const refs = (cam: RunCameraLuts) => ({ luts: [], graphics: [], missing: [], camera: cam });
  const MATCHED: RunCameraCurve = {
    curve: 'slog3',
    label: 'Sony S-Log3',
    files: ['FPV 3 S-Log3.mp4'],
    match: {
      kind: 'one',
      lut: {
        slug: 'sony-s-log3-to-rec709',
        name: 'Sony S-Log3 to Rec709',
        kind: 'camera',
        owner: 'yours',
        path: 'edit/luts/sony-s-log3-to-rec709.cube',
        look: null,
      },
    },
  };
  const UNMATCHED: RunCameraCurve = {
    curve: 'vlog',
    label: 'Panasonic V-Log',
    files: ['a.mov', 'b.mov'],
    match: { kind: 'none' },
  };
  const SEVERAL: RunCameraCurve = {
    curve: 'clog3',
    label: 'Canon C-Log3',
    files: ['c.mov'],
    match: { kind: 'several', names: ['Canon A', 'Canon B'] },
  };
  const HEAD =
    '- Camera log: the colour grade never guesses a camera LUT, and log footage has to have one.';
  const GENERIC =
    '  - If the report calls a source log and no line above covers its files, the files do not say which camera it is: finish what does not depend on it and make your last line exactly: Blocked: Waiting for a camera LUT: the clips are log footage.';

  it('has its part in apps/server/prompts', () => {
    expect(existsSync(`${PROMPTS_DIR}luts-camera.md`)).toBe(true);
  });

  it.each(RUN_MODES)('%s: the golden prompt is untouched without a camera answer', async (mode) => {
    const expected = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
    expect(await buildPrompt(mode, GOLDEN_VARS)).toBe(expected);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, libraryRefs: null })).toBe(expected);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, libraryRefs: refs(camera()) })).not.toBe(
      expected,
    );
  });

  it('an edit run with no curve named still says what to end with if the grade finds log', async () => {
    const prompt = await buildPrompt('start', { ...vars, libraryRefs: refs(camera()) });
    expect(prompt.split(HEAD)).toHaveLength(2);
    expect(prompt).toContain(GENERIC);
    expect(prompt).not.toContain('Library references');
    // After the colour grade's last bullet, right before the ElevenLabs line, with nothing between.
    expect(prompt).toMatch(
      /- Bake from edit\/color-grade\/edl\.graded\.json[^\n]*\n- Camera log:[^\n]*\n {2}- If the report calls a source log[^\n]*\n- The ElevenLabs key/,
    );
    expect(prompt).not.toMatch(/\{\{|\}\}|\n\n\n|[ \t]$/m);
  });

  it('tells the editor what weak_log means: graded as display, not blocked, unless the files name a curve (C75)', async () => {
    const prompt = await buildPrompt('start', { ...vars, libraryRefs: refs(camera()) });
    expect(prompt).toContain(
      'The one exception is a source the report lists under weak_log: it measured log or ambiguous on only three of the four log signs (real log shows all four; a calm sky can show three), so the wrapper graded it as display and did not block. Keep it display and say so in project.md, unless its files name a log curve in the lines below: then handle it as log.',
    );
    // The sentence that blocks a log source is unchanged: weak_log is a display verdict.
    expect(prompt).toContain(GENERIC);
  });

  it('in every mode and with Review on or off', async () => {
    for (const mode of RUN_MODES) {
      for (const review of [false, true]) {
        const prompt = await buildPrompt(mode, {
          ...vars,
          review,
          libraryRefs: refs(camera({ curves: [MATCHED] })),
        });
        expect(prompt.split(HEAD)).toHaveLength(2);
        expect(prompt).not.toMatch(/\{\{|\}\}/);
      }
    }
  });

  it('a matched curve names the file and the LUT, and where to set it', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [MATCHED] })),
    });
    expect(prompt).toContain(
      '  - “FPV 3 S-Log3.mp4” says it was shot in Sony S-Log3. The library has one Camera LUT for that, “Sony S-Log3 to Rec709”, file ./edit/luts/sony-s-log3-to-rec709.cube. If the report calls their source log or ambiguous, or lists it under weak_log, set color_grade.sources.<source id>.camera_lut to "luts/sony-s-log3-to-rec709.cube" in edit/edl.json and run the wrapper again in a fresh output directory; if it calls them display and does not list it under weak_log, leave them alone.\n',
    );
    expect(prompt).not.toContain('Blocked: Waiting for a camera LUT: the clips are Sony');
  });

  it('an unmatched curve gives the exact line to end with, with the first file', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [UNMATCHED] })),
    });
    expect(prompt).toContain(
      '  - “a.mov”, “b.mov” say they were shot in Panasonic V-Log, and no Camera LUT in the library names that curve. If the report calls their source log or ambiguous, or lists it under weak_log, finish what does not depend on it and make your last line exactly: Blocked: Waiting for a camera LUT: the clips are Panasonic V-Log (a.mov).\n',
    );
  });

  it('two matching LUTs: none is chosen, and the line says so', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [SEVERAL] })),
    });
    expect(prompt).toContain(
      'and more than one Camera LUT names that curve (“Canon A”, “Canon B”), so none was chosen.',
    );
    expect(prompt).toContain(
      'Blocked: Waiting for a camera LUT: the clips are Canon C-Log3 (c.mov), and more than one of your camera LUTs match, so name one in the job’s note.\n',
    );
  });

  it('lists each curve on its own line, in order', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [MATCHED, UNMATCHED] })),
    });
    expect(prompt).toMatch(
      /shot in Sony S-Log3\.[^\n]*\n {2}- “a\.mov”[^\n]*Panasonic V-Log[^\n]*\n {2}- If the report/,
    );
  });

  it('a Camera LUT a note names wins: no curve lines, and the part says so', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [MATCHED], byNote: true })),
    });
    expect(prompt).toContain(
      '  - A note already names a Camera LUT (see Library references): it wins, so do not look for another one.',
    );
    expect(prompt).not.toContain('FPV 3 S-Log3.mp4');
  });

  it('comes after the Library references of the same run, in one block of the unattended notes', async () => {
    const lut = {
      slug: 'golden-hour-warm',
      name: 'Golden Hour Warm',
      kind: 'look' as const,
      owner: 'yours' as const,
      path: 'edit/luts/golden-hour-warm.cube',
      look: null,
    };
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: {
        luts: [lut],
        graphics: [],
        missing: [],
        camera: camera({ curves: [UNMATCHED] }),
      },
    });
    expect(prompt.indexOf('- Library references:')).toBeLessThan(prompt.indexOf(HEAD));
    expect(prompt).toMatch(/- Look and Fix LUTs:[^\n]*\n- Camera log:/);
    expect(prompt).not.toMatch(/\n\n\n/);
  });

  it('a revise or render run never gets it', async () => {
    const withCamera = refs(camera({ curves: [MATCHED] }));
    for (const over of [
      { kind: 'revise' as const, round: 1, review: true },
      { kind: 'render' as const },
    ]) {
      const prompt = await buildPrompt('start', { ...vars, ...over, libraryRefs: withCamera });
      expect(prompt).not.toContain('Camera log:');
      expect(prompt).toBe(await buildPrompt('start', { ...vars, ...over }));
    }
  });

  it('never reads a file name as a template', async () => {
    const odd: RunCameraCurve = { ...UNMATCHED, files: ['A {{round}}\nB }}.mov'] };
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [odd] })),
    });
    expect(prompt).toContain('“A round B .mov” says it was shot in Panasonic V-Log');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('the sentence in the prompt is the one the page reads back', async () => {
    const prompt = await buildPrompt('start', {
      ...vars,
      libraryRefs: refs(camera({ curves: [UNMATCHED, SEVERAL] })),
    });
    const lines = [...prompt.matchAll(/make your last line exactly: Blocked: (.+)$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(lines.map((line) => parseCameraLutWait(line))).toEqual([
      { curve: 'vlog', source: 'a.mov', several: false },
      { curve: 'clog3', source: 'c.mov', several: true },
      { curve: null, source: null, several: false },
    ]);
  });
});

// SD0 (CVP-281): the Soundtrack switch. Off, every prompt is what it was, byte for byte. On, each
// kind gets its music part and nothing else changes: the edit family music.md as a paragraph after
// brief-use, a revise run music-revise.md in its list, a render run music-render.md in its list.
// One snapshot per kind holds the whole prompt with the switch on; SD3 wrote the parts and updated
// the snapshots (-u) with them, on purpose.
/** The three partials the music parts have for Songs (SG4): their files, or empty with the switch off. */
const SONG_PART_NAMES = ['music-songs-sources', 'music-songs', 'music-revise-songs'] as const;
function songPartials(songs: boolean): Record<string, PromptPartial> {
  return Object.fromEntries(
    SONG_PART_NAMES.map((name) => [
      name,
      songs ? readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8') : { raw: '' },
    ]),
  );
}

describe('music in the prompts (Soundtrack)', () => {
  const SCRIPT = '/engine/apps/server/assets/music/make-music.mjs';
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  // The parts as a run reads them with the songs switch off: the song lines are empty (SG4).
  const part = (name: string) =>
    renderTemplate(
      readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8'),
      { musicScript: SCRIPT },
      songPartials(false),
    ).trimEnd();
  const KINDS: [string, PromptVars][] = [
    ['an edit run', { ...vars }],
    ['an edit run in Review', { ...vars, review: true }],
    ['a revise run', { ...vars, kind: 'revise', round: 1, review: true }],
    ['a render run', { ...vars, kind: 'render' }],
  ];

  it('has its three parts in apps/server/prompts', () => {
    for (const name of ['music', 'music-revise', 'music-render']) {
      expect(existsSync(`${PROMPTS_DIR}${name}.md`), name).toBe(true);
      expect(part(name)).not.toBe('');
    }
  });

  // SD3 (CVP-284): what the parts tell the run. The edit's part replaces video-use's §0 Music
  // default ("never generate music") while the switch is on; every music file goes through the
  // script, whose CLI is apps/server/assets/music/make-music.mjs.
  describe('the parts', () => {
    const PARTS = ['music', 'music-revise', 'music-render'] as const;
    const SUB_COMMANDS = ['make', 'pick', 'supplied', 'series', 'none'];

    it('music.md says it replaces the §0 Music default, and keeps upstream’s sound rules', () => {
      const music = part('music');
      expect(music).toMatch(
        /^Music: on this machine Studio Engine makes music with its music script, node "[^"]+", only when the job asks for it explicitly;/,
      );
      expect(music).toContain("This replaces the Music row of the skill's §0 defaults table");
      expect(music).toContain('Never download or generate music unasked');
      expect(music).toContain('"Music and sound effects" rules still hold');
    });

    it('music.md’s example plan fits the contract, and so do its rules', () => {
      const example = part('music')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{"lengthMs"'));
      expect(example).toHaveLength(1);
      const plan = musicPlanSchema.parse(JSON.parse(example[0] as string));
      expect(plan.lengthMs).toBe(39_000);
      // The drop's section starts at 18.0 s, where the cut puts it.
      expect(plan.sections.slice(0, 2).reduce((sum, section) => sum + section.ms, 0)).toBe(18_000);
      expect(plan.styles).toContain('instrumental');
      expect(plan.avoid).toEqual(['vocals', 'singing', 'lyrics']);
      expect(part('music')).toContain('3000 to 120000 ms');
      expect(part('music')).toContain('at most 160 characters');
    });

    // SD9 (CVP-292): the plan rules SD1's spike found. The script sends each section's name as the
    // chunk's text, "[Name]", and anything else there can be sung, so names are plain words and
    // styles/avoid are short tags. A drop lands as a change only when the section before it avoids
    // the drop's weight and the drop asks for it.
    it('music.md’s example plan follows the plan rules: plain names, short tags, a drop that lands', () => {
      const music = part('music');
      const example = music
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('{"lengthMs"'));
      const plan = musicPlanSchema.parse(JSON.parse(example as string));
      for (const section of plan.sections) expect(section.name).toMatch(/^[A-Z][a-z]+( [a-z]+)?$/);
      const tags = [
        ...plan.styles,
        ...plan.avoid,
        ...plan.sections.flatMap((section) => [...section.styles, ...section.avoid]),
      ];
      for (const tag of tags) {
        expect(tag).toMatch(/^[A-Za-z0-9 ]+$/);
        expect(tag.split(' ').length, tag).toBeLessThanOrEqual(3);
      }
      const drop = plan.sections.findIndex((section) => section.name === 'Drop');
      expect(drop).toBe(2);
      for (const weight of ['kick drum', 'sub bass', 'full drums']) {
        expect(plan.sections[drop - 1]?.avoid).toContain(weight);
        expect(plan.sections[drop]?.styles).toContain(weight);
      }
      // As the script sends it: each chunk's text is only its "[Name]", and the Rise avoids the
      // drop's weight on top of vocals, singing and lyrics.
      const { chunks } = toComposition(plan);
      expect(chunks.map((chunk) => chunk.text)).toEqual(
        plan.sections.map((section) => `[${section.name}]`),
      );
      expect(chunks[drop - 1]?.negative_styles).toEqual(
        expect.arrayContaining(['vocals', 'singing', 'lyrics', 'kick drum', 'sub bass']),
      );
      expect(music).toContain(
        'Each section\'s name is one or two plain words, like "Build", "Rise", "Drop", "Golden" or "Logo": the script sends it to ElevenLabs as "[Name]", and any other words there can be sung.',
      );
      expect(music).toContain('styles and avoid hold only short style tags');
      expect(music).toContain(
        'the section right before it has the drop\'s weight in its avoid ("kick drum", "sub bass", "full drums")',
      );
    });

    it('music.md checks where the drop landed, and makes it once more when it is a beat off', () => {
      const music = part('music');
      expect(music).toContain(
        '`npx hyperframes audio "<edit dir>/preview/music.mp3" --only beats,downbeats,bpm,sections --json`',
      );
      expect(music).toContain("the measured section change nearest the plan's drop");
      expect(music).toContain('more than one beat from it (60 / BPM seconds: 0.5 s at 120 BPM)');
      expect(music).toContain(`\`node "${SCRIPT}" make "<edit dir>" --again\` once`);
      expect(music).toContain('It counts toward the two makes in this run: never a third');
      // make --again picks its new version; going back is a pick.
      expect(music).toContain(`\`node "${SCRIPT}" pick "<edit dir>" <its id>\``);
      expect(music).toContain('Write in project.md what you measured');
      expect(music).toContain('never make another for taste');
    });

    it('music.md sets the level with the lane: −20 LUFS in, up to +12 dB where the music plays alone', () => {
      const music = part('music');
      expect(music).toContain('Music the script made comes at −20 LUFS integrated');
      expect(music).toContain(
        'Where the music is the only sound (no speech), the lane may lift it by up to +12 dB',
      );
      expect(music).toContain('duck it to 12 to 15 dB below its music-only level');
      expect(music).toContain(
        'Set its level only with the lane (a lane replaces data-volume), never by changing music.mp3',
      );
    });

    it.each(PARTS)(
      '%s: every call is the script, quoted, with a sub-command it has and the edit dir',
      (name) => {
        const text = part(name);
        const calls = [...text.matchAll(/`node "([^"]+)" (\w+) "<edit dir>"[^`]*`/g)];
        for (const [, script, sub] of calls) {
          expect(script).toBe(SCRIPT);
          expect(SUB_COMMANDS).toContain(sub);
        }
        // The script is always run with node, from its quoted path.
        expect(text.split(`node "${SCRIPT}"`).length).toBe(text.split(`"${SCRIPT}"`).length);
        // The run makes music as the edit or a revise; "you" is the owner's Make another.
        expect(text).not.toMatch(/--by (you|edit)\b/);
        if (name === 'music-render') expect(calls).toHaveLength(0);
        else expect(calls.length).toBeGreaterThan(0);
      },
    );

    it('music.md settles where the music comes from with the four sources', () => {
      const music = part('music');
      for (const sub of ['supplied', 'series', 'none', 'make']) {
        expect(music).toContain(`\`node "${SCRIPT}" ${sub} "<edit dir>"`);
      }
      expect(music).toContain('Never run make more than twice in this run');
      // After a failed make the script leaves silence at music.mp3: the composition keeps playing
      // it, so a version made later in Review drops straight in.
      expect(music).toContain(
        'keep the music element and its volume lane in the composition exactly as if the make had worked',
      );
      expect(music).toContain('never read or print the key');
    });

    it('music-revise.md keeps the pick, remakes for a new cut and answers notes about the music', () => {
      const revise = part('music-revise');
      expect(revise).toMatch(/^- Music: keep the pick and edit\/preview\/music\.mp3 as they are/);
      expect(revise).toContain(`\`node "${SCRIPT}" make "<edit dir>" --by revise\``);
      expect(revise).toContain(`\`node "${SCRIPT}" pick "<edit dir>" off\``);
      expect(revise).toContain('--again --ask "');
      expect(revise).toContain('At most two makes in this round, counting the drop check');
    });

    it('music-revise.md keeps the plan rules and checks the drop after a make for a new cut', () => {
      const revise = part('music-revise');
      expect(revise).toContain(
        'each section\'s name is one or two plain words ("Build", "Drop", "Logo"), since the script sends it as "[Name]"',
      );
      expect(revise).toContain('styles and avoid hold only short style tags');
      expect(revise).toContain(
        'the section right before a drop has the drop\'s weight in its avoid ("kick drum", "sub bass", "full drums")',
      );
      expect(revise).toContain('more than one beat from it (60 / BPM seconds)');
      expect(revise).toContain(`\`node "${SCRIPT}" make "<edit dir>" --again --by revise\` once`);
      expect(revise).toContain(`\`node "${SCRIPT}" pick "<edit dir>" <its id>\``);
      expect(revise).toContain('the lane can lift it by up to +12 dB');
    });

    it('music-render.md never touches the music', () => {
      expect(part('music-render')).toContain(
        'Never run the music script, and never change, move or re-encode anything in edit/music/ or edit/preview/music.mp3.',
      );
    });
  });

  describe('off', () => {
    it.each(RUN_MODES)('%s: is the golden prompt, byte for byte', async (mode) => {
      const golden = await withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'));
      expect(await buildPrompt(mode, { ...GOLDEN_VARS, music: false })).toBe(golden);
      expect(await buildPrompt(mode, { ...GOLDEN_VARS, music: false, musicScript: SCRIPT })).toBe(
        golden,
      );
    });

    it.each(KINDS)('%s: is the prompt without the switch, in every mode', async (_name, over) => {
      for (const mode of RUN_MODES) {
        const before = await buildPrompt(mode, over);
        for (const off of [{ music: false }, { music: false, musicScript: SCRIPT }]) {
          const prompt = await buildPrompt(mode, { ...over, ...off });
          expect(prompt).toBe(before);
          expect(prompt).not.toContain('make-music');
          expect(prompt).not.toMatch(/\{\{|\}\}/);
        }
      }
    });
  });

  describe('on', () => {
    it.each(RUN_MODES)(
      '%s: adds music.md as its own paragraph right after brief-use',
      async (mode) => {
        for (const review of [false, true]) {
          for (const graphics of [false, true]) {
            const off = await buildPrompt(mode, { ...vars, review, graphics });
            const on = await buildPrompt(mode, {
              ...vars,
              review,
              graphics,
              music: true,
              musicScript: SCRIPT,
            });
            const music = part('music');
            expect(on.split(music)).toHaveLength(2);
            // brief-use ends with its Series line, or with the library's line while graphics are on.
            expect(on).toMatch(
              new RegExp(
                `(Series section[^\n]*|Graphics library section[^\n]*)\n\n${literal(music)}\n\n`,
              ),
            );
            expect(on.replace(`\n\n${music}`, '')).toBe(off);
            expect(on).not.toMatch(/\{\{|\}\}/);
            expect(on).not.toMatch(/\n\n\n/);
          }
        }
      },
    );

    it('a revise run gets music-revise.md in its list, right after “Do what each note asks”', async () => {
      const revise: PromptVars = { ...vars, kind: 'revise', round: 2, review: true };
      for (const mode of RUN_MODES) {
        const off = await buildPrompt(mode, revise);
        const on = await buildPrompt(mode, { ...revise, music: true, musicScript: SCRIPT });
        const music = part('music-revise');
        expect(on).toContain(`stays as it is.\n${music}\n- A note that is unclear`);
        expect(on.replace(`${music}\n`, '')).toBe(off);
        expect(on).not.toContain(part('music'));
        expect(on).not.toContain(part('music-render'));
      }
    });

    it('a render run gets music-render.md in its list, right after the render line', async () => {
      const render: PromptVars = { ...vars, kind: 'render' };
      for (const mode of RUN_MODES) {
        const off = await buildPrompt(mode, render);
        const on = await buildPrompt(mode, { ...render, music: true, musicScript: SCRIPT });
        const music = part('music-render');
        expect(on).toContain(`-o ../final.mp4\n${music}\n- Check the render`);
        expect(on.replace(`${music}\n`, '')).toBe(off);
        expect(on).not.toContain(part('music'));
        expect(on).not.toContain(part('music-revise'));
      }
    });

    it('needs the music script’s path', async () => {
      await expect(buildPrompt('start', { ...vars, music: true })).rejects.toThrow(/musicScript/);
    });

    it.each([
      ['edit-start', 'start', { ...GOLDEN_VARS, review: true }],
      ['revise', 'start', { ...GOLDEN_VARS, kind: 'revise', round: 1, review: true }],
      ['render', 'start', { ...GOLDEN_VARS, kind: 'render' }],
    ] as [string, RunMode, PromptVars][])(
      '%s: the whole prompt (snapshot)',
      async (name, mode, over) => {
        const prompt = await buildPrompt(mode, { ...over, music: true, musicScript: SCRIPT });
        const captured = readFileSync(`${GOLDEN_DIR}music-${name}.txt`, 'utf8');
        expect(prompt).toBe(await withColorGrade(captured, over));
      },
    );
  });
});

// Songs (SG4, CVP-388): with the songs switch on too, the music parts get their song lines and the
// Brief prompt reads the song. Each is a partial of its own that is empty with the switch off, so the
// golden and snapshot tests above (switch off) are the proof that nothing else moved.
describe('songs in the prompts (Songs)', () => {
  const SCRIPT = '/engine/apps/server/assets/music/make-music.mjs';
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const read = (name: string) => readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8');
  /** A song part as the run reads it: its file with the script's path filled in. */
  const songPart = (name: (typeof SONG_PART_NAMES)[number]) =>
    renderTemplate(read(name), { musicScript: SCRIPT }).trimEnd();
  const MUSIC_ON = { music: true, musicScript: SCRIPT };
  const SONGS_ON = { ...MUSIC_ON, songs: true };
  const KINDS: [string, PromptVars][] = [
    ['an edit run', { ...vars }],
    ['an edit run in Review', { ...vars, review: true }],
    ['a revise run', { ...vars, kind: 'revise', round: 1, review: true }],
    ['a render run', { ...vars, kind: 'render' }],
  ];

  it('has its four parts in apps/server/prompts, each in plain words', () => {
    for (const name of ['brief-songs', ...SONG_PART_NAMES]) {
      expect(existsSync(`${PROMPTS_DIR}${name}.md`), name).toBe(true);
      expect(read(name).trim(), name).not.toBe('');
      // Rendered, it has no placeholder left (an unknown one would throw).
      const text = renderTemplate(read(name), { musicScript: SCRIPT });
      expect(text, name).not.toMatch(/\{\{|\}\}/);
    }
  });

  describe('off', () => {
    it.each(KINDS)(
      '%s: songs without the music is the prompt without them',
      async (_name, over) => {
        for (const mode of RUN_MODES) {
          const before = await buildPrompt(mode, over);
          const prompt = await buildPrompt(mode, { ...over, songs: true, musicScript: SCRIPT });
          expect(prompt).toBe(before);
          expect(prompt).not.toMatch(/ song(?:-note)? "<edit dir>"|\{\{|\}\}/);
        }
      },
    );

    it.each(KINDS)(
      '%s: the music without the songs is the music prompt, in every mode',
      async (_name, over) => {
        for (const mode of RUN_MODES) {
          const music = await buildPrompt(mode, { ...over, ...MUSIC_ON });
          for (const off of [{ songs: false }, {}]) {
            const prompt = await buildPrompt(mode, { ...over, ...MUSIC_ON, ...off });
            expect(prompt).toBe(music);
            expect(prompt).not.toMatch(/ song(?:-note)? "<edit dir>"|Getting the song|\{\{|\}\}/);
          }
        }
      },
    );
  });

  describe('an edit run with songs on', () => {
    it.each(RUN_MODES)(
      '%s: adds the song lines to the music part, and taking them out gives the music prompt',
      async (mode) => {
        for (const review of [false, true]) {
          const music = await buildPrompt(mode, { ...vars, review, ...MUSIC_ON });
          const on = await buildPrompt(mode, { ...vars, review, ...SONGS_ON });
          const sources = songPart('music-songs-sources');
          const getting = songPart('music-songs');
          expect(on.split(sources)).toHaveLength(2);
          expect(on.split(getting)).toHaveLength(2);
          expect(on.replace(`${sources}\n`, '').replace(`${getting}\n`, '')).toBe(music);
          expect(on).not.toMatch(/\{\{|\}\}|\n\n\n/);
          // The revise run's lines are not in an edit run's prompt.
          expect(on).not.toContain(songPart('music-revise-songs'));
        }
      },
    );

    it('orders the sources: music file, series, a no-music rule, a song, a trending one, then make', async () => {
      const on = await buildPrompt('start', { ...vars, review: true, ...SONGS_ON });
      const at = (text: string) => {
        expect(on.split(text), text).toHaveLength(2);
        return on.indexOf(text);
      };
      const order = [
        '  - A music file the brief lists as music:',
        '  - A series episode:',
        '  - A rule that says no music',
        '  - A song the brief asks for',
        '  - A trending song the brief asks for with no song named',
        '  - The brief says the screenshot\'s audio was "Original audio"',
        '  - The job asks for music to be made or added: make the music',
        '  - Nothing above asks for music',
        '- Getting the song, when the brief asks for one',
        '- No music asked for. Make nothing',
        "- Making it. Once the cut's shape is fixed",
        '- Fitting the cut to it.',
        '- Playing it.',
      ].map(at);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('gets a named song with the song command, from the brief, once the cut is fixed', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain("Once the cut's shape is fixed");
      // The plan comes first: the part's length is the plan's lengthMs, and make uses it on a failure.
      expect(getting).toContain(
        'write edit/music/plan.json from that shape exactly as "Making it" below says',
      );
      expect(getting).toContain("its lengthMs is the composition's exact duration");
      expect(getting).toContain('Bash timeout of 600000 ms');
      expect(getting).toContain(
        `\`node "${SCRIPT}" song "<edit dir>" --title "<title>" --artist "<artist>" [--version "<version>"] [--link "<link>"] --from <screenshot|link|name> [--file "<the screenshot>"] --by brief\``,
      );
      expect(getting).toContain('link when a link is all there is (then give --link alone');
      expect(getting).toContain('never read or print a key');
    });

    it('gets a trending song with --trending, naming a niche only when the style has none', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain(
        `\`node "${SCRIPT}" song "<edit dir>" --trending --from trending --by editor\``,
      );
      expect(getting).toContain('"Reels niche:" line');
      expect(getting).toContain(
        'add `--niche "#a #b #c"`: 2 to 4 hashtags for what the video shows, for example #fpv #fpvdrone',
      );
    });

    it('fits the cut to the returned beats and part, and ducks a song with words under speech', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain('The line gives `part` ({startMs, endMs, how}');
      expect(getting).toContain('`beats`');
      expect(getting).toContain('move the cuts onto the nearest beats');
      expect(getting).toContain("the drop's cut onto the part's drop");
      expect(getting).toContain('keeping the total length');
      expect(getting).toContain('duck the song 12 to 15 dB below its music-only level');
      expect(getting).toContain(
        'where it sings over someone talking duck it harder, or put the speech over an instrumental stretch of the part, and say which in project.md',
      );
      // A song is never re-made to move its drop, and a part shorter than the cut is looped or ramped out.
      expect(getting).toContain("never make music to move a song's drop");
      expect(getting).toContain('If part.how is "whole"');
    });

    it('falls back to make on an error line, saying why in the Assumptions, and never loops on the song', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain('On {"ok":false,"code":…,"message":…} with a non-zero exit');
      expect(getting).toContain("Say why in project.md's Assumptions line");
      expect(getting).toContain(
        'then make the music as in "Making it" below: a song was asked for, so a made track is still the stated wish (still at most two makes)',
      );
      expect(getting).toContain("don't run the song command again for that song in this run");
    });

    it('says Original audio is no song: make as today, with the sentence in the Assumptions', () => {
      expect(songPart('music-songs-sources')).toContain(
        'put this sentence in project.md\'s Assumptions line: "Yael\'s screenshot said Original audio, so there was no song to get."',
      );
    });

    // RGM1: the run notes it in the record, so Review and the sheet ask for the reel's link. No song,
    // no guess: nothing is looked up from the label.
    it('notes Original audio with song-note after the make, once, and looks nothing up', () => {
      const sources = songPart('music-songs-sources');
      expect(sources).toContain('Never look a song up from the label, the footage or the account.');
      expect(sources).toContain(
        `After the make (or after it failed for good), run \`node "${SCRIPT}" song-note "<edit dir>" --original "<the account>"\``,
      );
      expect(sources).toContain(
        'the account is music.original.by as the brief has it (`""` when it has none)',
      );
      expect(sources).toContain('Run it once, whatever the make did.');
      // The sentence comes first, then the note: both belong to the Original audio source.
      expect(sources.indexOf('so there was no song to get.')).toBeLessThan(
        sources.indexOf('song-note'),
      );
    });

    it('keeps a song from an earlier run of the job when the cut has not changed', () => {
      expect(songPart('music-songs')).toContain(
        '("source": "song") and the cut\'s shape has not changed, keep it',
      );
    });

    it('puts the words at the brief’s moment with --lyrics-at, and never holds the music back for it', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain('add `--lyrics-at <ms>` to the song call above');
      expect(getting).toContain(
        '"starts without lyrics; the lyrics start on the beat when the image opens"',
      );
      expect(getting).toContain("so the song's own intro is the lead-in");
      expect(getting).toContain(
        "from the cut's first frame (data-start 0), and never delay or silence its start",
      );
      expect(getting).toContain("the line's `dropMs` is null");
    });

    it('starts the part at the brief’s moment of the song with --start-ms', () => {
      const getting = songPart('music-songs');
      expect(getting).toContain('add `--start-ms <ms>` to the song call above');
      expect(getting).toContain('"start the song at 0:37"');
      expect(getting).toContain('(0:37 is 37000)');
      expect(getting).toContain('Never give it with `--lyrics-at`');
      expect(getting).toContain("the line's `dropMs` and `lyricsMs` are null");
    });

    it('snapshot: the whole edit prompt', async () => {
      const over: PromptVars = { ...GOLDEN_VARS, review: true };
      const prompt = await buildPrompt('start', { ...over, ...SONGS_ON });
      const captured = readFileSync(`${GOLDEN_DIR}songs-edit-start.txt`, 'utf8');
      expect(prompt).toBe(await withColorGrade(captured, over));
    });
  });

  describe('a revise run with songs on', () => {
    const revise: PromptVars = { ...vars, kind: 'revise', round: 2, review: true };

    it.each(RUN_MODES)(
      '%s: puts the song lines right after the note about the music itself',
      async (mode) => {
        const music = await buildPrompt(mode, { ...revise, ...MUSIC_ON });
        const on = await buildPrompt(mode, { ...revise, ...SONGS_ON });
        const lines = songPart('music-revise-songs');
        expect(on.split(lines)).toHaveLength(2);
        expect(on).toMatch(
          new RegExp(
            `\n- A note about the music itself:[^\n]*\n${literal(lines)}\n- Checking the drop`,
          ),
        );
        expect(on.replace(`${lines}\n`, '')).toBe(music);
        expect(on).not.toContain(songPart('music-songs'));
        expect(on).not.toMatch(/\{\{|\}\}/);
      },
    );

    it('answers the notes Review writes for another song, a link or a trending one', () => {
      const lines = songPart('music-revise-songs');
      // The words of SG7's notes, word for word.
      expect(lines).toContain('"Use [title] by [artist] instead."');
      expect(lines).toContain('"Use the song from [link] instead."');
      expect(lines).toContain('"Use a trending song that fits the cut."');
      expect(lines).toContain('Bash timeout of 600000 ms');
      expect(lines).toContain(
        `\`node "${SCRIPT}" song "<edit dir>" --title "<title>" --artist "<artist>" --from note --by you\``,
      );
      expect(lines).toContain(
        `\`node "${SCRIPT}" song "<edit dir>" --link "<link>" --from note --by you\``,
      );
      expect(lines).toContain(
        `\`node "${SCRIPT}" song "<edit dir>" --trending --from trending --by you\``,
      );
      expect(lines).toContain('only when the client\'s style has no "Reels niche:" line');
      // A failure keeps the music, and the note's line says why.
      expect(lines).toContain(
        'On {"ok":false,…} the music stays as it was: say so, and why, in that note\'s line of the round.',
      );
    });

    it('moves the cuts within the same song for a note about its timing, and says so', () => {
      const lines = songPart('music-revise-songs');
      expect(lines).toContain('A note about the song\'s timing ("start the song at the chorus"');
      expect(lines).toContain("don't get the song again");
      expect(lines).toContain('the part itself stays as it is');
    });

    it('answers a note about where the words come in with the song again and --lyrics-at, not moved cuts', () => {
      const lines = songPart('music-revise-songs');
      expect(lines).toContain("A note about where the song's words come in against the picture");
      expect(lines).toContain('"music only at first, then the lyrics when the images start"');
      expect(lines).toContain(
        "moving the cuts or the music's start inside the part you have does not answer it",
      );
      expect(lines).toContain('`--lyrics-at <ms>`');
      expect(lines).toContain('the song is kept, nothing is downloaded again');
      expect(lines).toContain('Bash timeout of 600000 ms');
      // It comes before the note about timing within the same part, which keeps its answer.
      expect(lines.indexOf('words come in against the picture')).toBeLessThan(
        lines.indexOf("A note about the song's timing"),
      );
    });

    it('answers a note that gives a time in the song with the song again and --start-ms, not moved cuts', () => {
      const lines = songPart('music-revise-songs');
      expect(lines).toContain(
        'A note that gives a moment of the song to start from ("start the song at 0:37"',
      );
      expect(lines).toContain('`--start-ms <ms>`');
      expect(lines).toContain('(0:37 is 37000)');
      expect(lines).toContain('the song is kept, nothing is downloaded again');
      // It comes before the note about timing within the same part, which points back to it for a time.
      expect(lines.indexOf('A note that gives a moment of the song')).toBeLessThan(
        lines.indexOf("A note about the song's timing"),
      );
      expect(lines).toContain(
        'A note that gives the time in the song (m:ss) is the one above instead.',
      );
    });

    it('snapshot: the whole revise prompt', async () => {
      const over: PromptVars = { ...GOLDEN_VARS, kind: 'revise', round: 1, review: true };
      const prompt = await buildPrompt('start', { ...over, ...SONGS_ON });
      const captured = readFileSync(`${GOLDEN_DIR}songs-revise.txt`, 'utf8');
      expect(prompt).toBe(await withColorGrade(captured, over));
    });
  });

  it('a render run is the music-only render prompt: the engine makes the second file', async () => {
    const render: PromptVars = { ...GOLDEN_VARS, kind: 'render' };
    const music = await buildPrompt('start', { ...render, ...MUSIC_ON });
    expect(await buildPrompt('start', { ...render, ...SONGS_ON })).toBe(music);
    const captured = readFileSync(`${GOLDEN_DIR}music-render.txt`, 'utf8');
    expect(music).toBe(await withColorGrade(captured, render));
  });

  // The calls the run is told to make must be ones the script's `song` command takes (SG0's header
  // in make-music.mjs, SG3 builds it): known options, a `--from` and a `--by` from the contract.
  describe('every song call in the parts', () => {
    const VALUE_OPTIONS = [
      '--title',
      '--artist',
      '--version',
      '--link',
      '--from',
      '--file',
      '--by',
      '--niche',
      '--length-ms',
    ];
    const FLAGS = ['--trending'];
    const calls = SONG_PART_NAMES.flatMap((name) =>
      [...songPart(name).matchAll(/`node "([^"]+)" song "<edit dir>"([^`]*)`/g)].map((m) => ({
        name,
        script: m[1] as string,
        args: (m[2] as string).replace(/[[\]]/g, ''),
      })),
    );

    it('are there: two named-song calls, three trending ones (edit and revise) and a link', () => {
      expect(calls.map((call) => call.name)).toEqual([
        'music-songs',
        'music-songs',
        'music-revise-songs',
        'music-revise-songs',
        'music-revise-songs',
      ]);
    });

    it.each(calls.map((call) => [call.name, call.args, call] as const))(
      '%s: song "<edit dir>"%s uses the script’s options and the contract’s values',
      (_name, _args, call) => {
        expect(call.script).toBe(SCRIPT);
        const words = [...call.args.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0]);
        const given = new Map<string, string | true>();
        for (let i = 0; i < words.length; i++) {
          const word = words[i] as string;
          if (FLAGS.includes(word)) given.set(word, true);
          else if (VALUE_OPTIONS.includes(word)) {
            given.set(word, (words[i + 1] ?? '').replace(/^"|"$/g, ''));
            i += 1;
          } else throw new Error(`unknown option or word "${word}" in song${call.args}`);
        }
        // Who asked and how: values the record knows (SONG_ASKED_BY, SONG_ASKED_FROM).
        const by = given.get('--by');
        expect(SONG_ASKED_BY, `--by ${by}`).toContain(by);
        for (const from of String(given.get('--from')).replace(/^<|>$/g, '').split('|')) {
          expect(SONG_ASKED_FROM, `--from ${from}`).toContain(from);
        }
        // Either a song (by words or by link) or the trending one, never both.
        const trending = given.has('--trending');
        expect(given.has('--title') || given.has('--link') || trending).toBe(true);
        if (trending)
          expect(given.has('--title') || given.has('--artist') || given.has('--link')).toBe(false);
      },
    );
  });

  // RGM1: the song-note call (Original audio) is one the script takes: its option is `--original`,
  // and the script's own parser reads the call as the prompt writes it.
  describe('every song-note call in the parts', () => {
    const VALUE_OPTIONS = ['--original'];
    const calls = SONG_PART_NAMES.flatMap((name) =>
      [...songPart(name).matchAll(/`node "([^"]+)" song-note "<edit dir>"([^`]*)`/g)].map((m) => ({
        name,
        script: m[1] as string,
        args: m[2] as string,
      })),
    );

    it('is there once, with the Original audio source', () => {
      expect(calls.map((call) => call.name)).toEqual(['music-songs-sources']);
    });

    it.each(calls.map((call) => [call.name, call.args, call] as const))(
      '%s: song-note "<edit dir>"%s uses the script’s option and the script reads the call',
      (_name, _args, call) => {
        expect(call.script).toBe(SCRIPT);
        const words = [...call.args.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0]);
        const named = words.filter((word) => word.startsWith('--'));
        expect(named).toEqual(VALUE_OPTIONS);
        const argv = words.map((word) => word.replace(/^"|"$/g, ''));
        const parsed = parseMusicArgs(['song-note', '/edit', ...argv.map(fillIn)]);
        expect(parsed, call.args).not.toHaveProperty('error');
        expect(parsed).toMatchObject({ command: 'song-note', original: '@reels.creator' });
      },
    );

    /** The prompt's placeholder for the account, as the brief would give it. */
    function fillIn(word: string): string {
      return word === '<the account>' ? '@reels.creator' : word;
    }
  });
});

/** `text` as a RegExp that matches it literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// W3 (CVP-110): the revise run applies one round of the owner's notes, the render run renders the
// approved preview. The names are Hebrew on purpose; the texts are the page's (Phase 3 §3, §4).
describe('revise and render prompts', () => {
  const hebrew = { client: 'מאפיית הצפון', job: 'פרומו לסוף השבוע', review: true };
  const JOB_LINE =
    'Job: client "מאפיית הצפון", job "פרומו לסוף השבוע". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.';
  const previewFinish = previewFinishText().trimEnd();
  const finalFinish = readFileSync(`${PROMPTS_DIR}final-finish.md`, 'utf8').trimEnd();
  const briefUse = readFileSync(`${PROMPTS_DIR}brief-use.md`, 'utf8').trimEnd();
  const ROUND_PARAGRAPH_END =
    'its audio file is listed next to it in case the transcript is missing or the tone matters.';
  const REGISTRY_LINE =
    "- Start the root composition's main script with `window.__timelines = window.__timelines || {};` (the player loads its runtime after the page's own scripts).";

  describe('revise.md', () => {
    const revise = (over: Partial<PromptVars> = {}) =>
      buildPrompt('start', { ...hebrew, kind: 'revise', round: 1, step: 4, ...over });

    it('tells the run to read only its own job folder, once', async () => {
      const prompt = await revise();
      expect(prompt.split(READ_ONLY_LINE).length - 1).toBe(1);
    });

    it('starts with the goal and names the job', async () => {
      const prompt = await revise();
      expect(
        prompt.startsWith(
          "Apply the owner's review notes to the edit in this folder with the video-use skill, and finish it again as a live preview in edit/preview/.\n\n" +
            `${JOB_LINE}\n`,
        ),
      ).toBe(true);
    });

    it('is the round: the number, the round file twice, and the section to add', async () => {
      const prompt = await revise();
      expect(prompt).toContain('This is review round 1.');
      expect(prompt.match(/edit\/review\/round-1\.md/g)).toHaveLength(2);
      expect(prompt).toContain('Add a section "## Round 1" at the end of project.md');
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('ends the paragraph with no trailing space, and the list follows on the next line', async () => {
      const prompt = await revise();
      expect(prompt).toContain(
        `${ROUND_PARAGRAPH_END}\n- Load the skill, then read edit/review/round-1.md, edit/project.md and the composition in edit/preview/ before anything else.\n`,
      );
      expect(prompt).not.toMatch(/[ \t]+$/m);
    });

    it('puts brief-use right after the job line, and preview-finish before the unattended notes', async () => {
      const prompt = await revise();
      expect(prompt).toContain(`${JOB_LINE}\n\n${briefUse}\n\nThis is review round 1.`);
      const finishAt = prompt.indexOf(previewFinish);
      const unattendedAt = prompt.indexOf('This run is unattended');
      expect(finishAt).toBeGreaterThan(0);
      expect(finishAt).toBeLessThan(unattendedAt);
      expect(prompt).toContain(REGISTRY_LINE);
      expect(prompt).toContain('Do not run hyperframes render and do not write edit/final.mp4.');
    });

    it('has the preview done line once, and none of a rendered video', async () => {
      const prompt = await revise();
      expect(prompt.match(/The job is done when/g)).toHaveLength(1);
      expect(prompt).toContain(
        'The job is done when edit/preview/index.html passes lint and you have checked the snapshots.',
      );
      expect(prompt).not.toContain('edit/final.mp4 exists');
      expect(prompt).toMatch(/everything this run prints is logged\.\n- If you hit a real blocker/);
      expect(prompt).not.toMatch(/\n\n\n/);
      expect(prompt.endsWith("shows that sentence to the user as the job's error.\n")).toBe(true);
    });

    it('does not depend on the Review switch: a revise run always ends in a preview', async () => {
      const off = await revise({ review: false });
      expect(off).toBe(await revise({ review: true }));
      expect(off).toContain(previewFinish);
    });

    it("quotes the page's instructions word for word", async () => {
      const prompt = await revise();
      for (const line of [
        '- Do not transcribe the footage again and do not start over: change the existing edit.',
        '- Do what each note asks and nothing else. Every other decision (cuts, look, graphics, captions, music) stays as it is.',
        '- A note that is unclear: take the most likely reading. A note that is impossible or goes against the brief: do the closest thing that works.',
        '- A voice note without a transcript: transcribe it with ~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py "<file>" --edit-dir "./edit/review/voice".',
      ]) {
        expect(prompt).toContain(`${line}\n`);
      }
    });

    // P29 (CVP-164) and P30 (CVP-165): the exit rule and the clear-of-the-picture check live in
    // preview-finish.md only, so a revise run reads each of them once, through the partial.
    it('reads the exit rule and the clear-of-the-picture check once each, through preview-finish', async () => {
      const prompt = await revise();
      for (const line of [EXIT_LINE, CLEAR_LINE]) {
        expect(prompt.split(`${line}\n`), line).toHaveLength(2);
        expect(previewFinish).toContain(line);
      }
      expect(prompt).toContain(
        `${EXIT_LINE}\n${CLEAR_LINE}\n- Record the composition in project.md`,
      );
    });

    // FN19 (CVP-352): a revise round marks an old job's captions and titles too.
    it('asks for the font preview marks once, through preview-finish', async () => {
      const prompt = await revise();
      expect(prompt.split(`${MARK_LINE}\n`)).toHaveLength(2);
    });

    it('resume at 6, round 2: says an earlier run of this round was stopped', async () => {
      const prompt = await buildPrompt('resume', { ...hebrew, kind: 'revise', round: 2, step: 6 });
      expect(prompt).toContain('This is review round 2.');
      expect(prompt).toContain('edit/review/round-2.md');
      expect(prompt).toContain(
        `${ROUND_PARAGRAPH_END} An earlier run of this round was stopped at step 6 of 8 (Preview). Carry on from what is in ./edit/.\n- Load the skill`,
      );
    });

    it('retry at 6: quotes the error on one line with the braces gone and one period', async () => {
      const prompt = await buildPrompt('retry', {
        ...hebrew,
        kind: 'revise',
        round: 1,
        step: 6,
        error: 'Claude Code stopped with exit code 1:\nlint failed {{x}}.',
      });
      expect(prompt).toContain(
        `${ROUND_PARAGRAPH_END} The previous attempt at this round failed at step 6 of 8 (Preview) with: Claude Code stopped with exit code 1: lint failed x. Find the cause first and fix it.\n- Load the skill`,
      );
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('needs the round it applies', async () => {
      for (const round of [undefined, 0, -1, 1.5, Number.NaN]) {
        const vars: PromptVars = { ...hebrew, kind: 'revise' };
        if (round !== undefined) vars.round = round;
        await expect(buildPrompt('start', vars), String(round)).rejects.toThrow(
          'A revise prompt needs the round',
        );
      }
    });

    it('starts at Plan when the step is left out', async () => {
      const prompt = await buildPrompt('resume', { ...hebrew, kind: 'revise', round: 3 });
      expect(prompt).toContain('stopped at step 4 of 8 (Plan)');
    });
  });

  describe('render.md', () => {
    const render = (mode: RunMode = 'start', over: Partial<PromptVars> = {}) =>
      buildPrompt(mode, { ...hebrew, kind: 'render', step: 8, ...over });

    it('tells the run to read only its own job folder, once', async () => {
      const prompt = await render();
      expect(prompt.split(READ_ONLY_LINE).length - 1).toBe(1);
    });

    it('starts with the goal, and the job line ends the paragraph', async () => {
      const prompt = await render();
      expect(
        prompt.startsWith(
          'Render the approved edit in this folder to edit/final.mp4 with the video-use skill. The owner approved the live preview in edit/preview/, so do not change the edit.\n\n' +
            `${JOB_LINE}\n- Load the skill, then read edit/project.md.\n`,
        ),
      ).toBe(true);
      expect(prompt).not.toMatch(/[ \t]+$/m);
    });

    it('gives the render command and the loudness target', async () => {
      const prompt = await render();
      expect(prompt).toContain(
        '- Render from edit/preview/: npx hyperframes render -q delivery --strict --no-best-effort -o ../final.mp4\n',
      );
      expect(prompt).toContain('H.264, yuv420p, AAC, −14 LUFS and −1 dBTP');
      expect(prompt).toContain('never dynamic loudnorm.');
      expect(prompt).toContain(
        '- When captions are burned in, copy their SRT to edit/final.srt.\n',
      );
      expect(prompt).toContain(
        '- Fix only what the render itself broke. If the render shows a problem in the edit, do not re-edit: end with the Blocked: line, naming the problem.\n',
      );
    });

    it('has the final done line once, before the unattended notes, and no brief-use or preview-finish', async () => {
      const prompt = await render();
      expect(prompt.match(/The job is done when/g)).toHaveLength(1);
      expect(prompt).toContain(`${finalFinish}\n\nThis run is unattended`);
      expect(prompt).not.toContain('If edit/brief.md exists, read it');
      expect(prompt).not.toContain('Finish the edit as a live preview');
      expect(prompt).not.toContain('Do not run hyperframes render');
      expect(prompt).toMatch(/everything this run prints is logged\.\n- If you hit a real blocker/);
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('does not depend on the Review switch', async () => {
      expect(await render('start', { review: false })).toBe(
        await render('start', { review: true }),
      );
    });

    it('resume at 8: says an earlier render was stopped', async () => {
      const prompt = await render('resume');
      expect(prompt).toContain(
        'to ./edit/. An earlier render was stopped at step 8 of 8 (Render). Carry on from what is in ./edit/.\n- Load the skill',
      );
    });

    it('retry at 8: quotes the error', async () => {
      const prompt = await render('retry', { error: 'render.py failed {{x}}' });
      expect(prompt).toContain(
        'to ./edit/. The previous attempt at the render failed at step 8 of 8 (Render) with: render.py failed x. Find the cause first and fix it.\n- Load the skill',
      );
    });

    it('starts at Render when the step is left out', async () => {
      const prompt = await buildPrompt('resume', { ...hebrew, kind: 'render' });
      expect(prompt).toContain('stopped at step 8 of 8 (Render)');
    });
  });

  describe('againText', () => {
    it('is empty on a first try', () => {
      expect(againText('revise', 'start', 4, 'x')).toBe('');
      expect(againText('render', 'start', 8, 'x')).toBe('');
    });

    it('says what became of the last run on a resume', () => {
      expect(againText('revise', 'resume', 6, 'x')).toBe(
        'An earlier run of this round was stopped at step 6 of 8 (Preview). Carry on from what is in ./edit/.',
      );
      expect(againText('render', 'resume', 8, 'x')).toBe(
        'An earlier render was stopped at step 8 of 8 (Render). Carry on from what is in ./edit/.',
      );
    });

    it('quotes the error on a retry, without its closing periods', () => {
      expect(againText('revise', 'retry', 5, 'lint failed...')).toBe(
        'The previous attempt at this round failed at step 5 of 8 (Cut) with: lint failed. Find the cause first and fix it.',
      );
      expect(againText('render', 'retry', 8, 'no space left . ')).toBe(
        'The previous attempt at the render failed at step 8 of 8 (Render) with: no space left. Find the cause first and fix it.',
      );
    });
  });
});

describe('the Brief prompt (brief.md)', () => {
  const vars = {
    client: 'מאפיית הצפון',
    job: 'פרומו לסוף השבוע',
    note: null,
    files: [] as BriefPromptFile[],
  };

  it('names the job, says what to read and write, and fills every placeholder', async () => {
    const prompt = await buildBriefPrompt(vars);
    expect(prompt.startsWith('Write the brief for this edit.')).toBe(true);
    expect(prompt).toContain('Job: client "מאפיית הצפון", job "פרומו לסוף השבוע".');
    expect(prompt).toContain(
      'Write only edit/brief.json, plus voice-note transcripts under edit/brief/.',
    );
    expect(prompt).toContain('--edit-dir "./edit/brief"');
    expect(prompt).toContain('Never write to edit/transcripts/');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('puts the note in word for word, lines and Hebrew kept', async () => {
    const note = '  הטייק השני של יוסי עדיף.\nKeep it under 30 seconds.  ';
    const prompt = await buildBriefPrompt({ ...vars, note });
    expect(prompt).toContain(
      '<note>\nהטייק השני של יוסי עדיף.\nKeep it under 30 seconds.\n</note>',
    );
  });

  it('says "(none)" without a note, or with a blank one', async () => {
    for (const note of [null, '', '  \n ']) {
      const prompt = await buildBriefPrompt({ ...vars, note });
      expect(prompt).toContain(`<note>\n${NO_NOTE}\n</note>`);
    }
  });

  it('never reads a note as a template: braces in it stay as they are', async () => {
    const prompt = await buildBriefPrompt({
      ...vars,
      note: 'Use {{client}} and {{> brief-schema}}',
    });
    expect(prompt).toContain('<note>\nUse {{client}} and {{> brief-schema}}\n</note>');
  });

  // P21 (CVP-136): The owner's note said 1080x1920 and the brief still said "Canvas: 1080x1920
  // (assumed)", which the edit run reads as a guess it may overrule. A value somebody said is not
  // assumed; `files` is not a field path; a brief.json fix is a whole new Write (Edit is off).
  it('says a value the note or the client states is not assumed', async () => {
    const prompt = await buildBriefPrompt(vars);
    expect(prompt).toContain(
      'A value that the owner’s note or the client states is not assumed, even when you could also have inferred it: if the note says 1080x1920, canvas is not in assumed.',
    );
    expect(prompt).toContain(
      'assumed lists only values nobody said, and only fields of the schema.',
    );
    expect(prompt).toContain('File roles are always your own call, so files is never in assumed.');
    expect(prompt).toContain(
      'To change edit/brief.json after you wrote it, write the whole file again with Write: Edit is not available.',
    );
    // The inference rule it qualifies is still there, word for word.
    expect(prompt).toContain(
      'Write each inference in assumptions, and its field path in assumed (for example look.colors).',
    );
  });

  // P18 (CVP-133): on a chat plus two voice notes the run's first command was a compound `find |
  // xargs`, got one denial, took it for "Bash is off" and never transcribed the voice notes. The
  // prompt now says which forms work, and hands over the file list so step 1 needs no Bash.
  it('names the Bash forms that work, one per call, and says a denial is not the end', async () => {
    const prompt = await buildBriefPrompt(vars);
    expect(prompt).toContain('Bash here runs only these commands, one per call');
    expect(prompt).toContain('with no pipes, `;`, `&&`, redirects, `find` or `xargs`');
    expect(prompt).toContain('`ls -la`');
    expect(prompt).toContain(
      '`ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"`',
    );
    expect(prompt).toContain('`textutil -convert txt -stdout "<file>"`');
    expect(prompt).toContain('the transcribe command in step 2');
    expect(prompt).toContain('Anything else is denied.');
    expect(prompt).toContain(
      'A denial means the form was wrong, not that Bash is off: run it again in one of these forms.',
    );
  });

  it('puts the file list in step 1, so the run does not list the folder itself', async () => {
    const files: BriefPromptFile[] = [
      {
        relPath: '_chat.txt',
        kind: 'doc',
        size: 1_234,
        mtimeMs: Date.UTC(2026, 9, 19, 8, 3),
        durationSec: null,
      },
      {
        relPath: '00000019-AUDIO-2026-10-19-08-03-11.m4a',
        kind: 'audio',
        size: 45_678,
        mtimeMs: Date.UTC(2026, 9, 19, 8, 3, 11),
        durationSec: 21.4,
      },
      {
        relPath: 'IMG_2201.mp4',
        kind: 'video',
        size: 12_345_678,
        mtimeMs: Date.UTC(2026, 9, 18, 21, 8),
        durationSec: 8.2,
      },
    ];
    const prompt = await buildBriefPrompt({ ...vars, files });
    expect(prompt).toContain('\n1. The files are listed below');
    expect(prompt).toContain('You don’t need to list the folder or ffprobe anything yourself.');
    expect(prompt).toContain(
      [
        '- _chat.txt (text, 1.2 KB, modified 2026-10-19 08:03 UTC)',
        '- 00000019-AUDIO-2026-10-19-08-03-11.m4a (audio, 46 KB, 0:21, modified 2026-10-19 08:03 UTC)',
        '- IMG_2201.mp4 (video, 12 MB, 0:08, modified 2026-10-18 21:08 UTC)',
      ].join('\n'),
    );
    // The list comes before the Bash paragraph, and that before step 2.
    expect(prompt.indexOf('- IMG_2201.mp4')).toBeLessThan(prompt.indexOf('Bash here runs only'));
    expect(prompt.indexOf('Bash here runs only')).toBeLessThan(
      prompt.indexOf('2. Read every file'),
    );
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('says so when the folder has no files', async () => {
    expect(await buildBriefPrompt(vars)).toContain(`\n${NO_FILES}\n`);
  });

  it('never reads a file name as a template either', async () => {
    const files: BriefPromptFile[] = [
      {
        relPath: '{{note}} {{> brief-schema}}.txt',
        kind: 'doc',
        size: 1,
        mtimeMs: 0,
        durationSec: null,
      },
    ];
    const prompt = await buildBriefPrompt({ ...vars, files });
    expect(prompt).toContain('- {{note}} {{> brief-schema}}.txt (text, 1 bytes, modified');
  });

  // CVP-255: the Brief run did not know the job was an episode, and wrote "everything else follows
  // video-use defaults" above the Series section the engine adds, which says the opposite.
  describe('for an episode of a series', () => {
    const EPISODE =
      'This job is episode 6 of the series “מיתוס או אמת”. The engine adds the series’ format to the brief after yours, and the editor rebuilds the episode from it. So a field you leave null is decided by the series, not by video-use’s defaults, and summary says the episode is rebuilt from the series: never that anything follows video-use’s defaults.';
    const series = { name: 'מיתוס או אמת', episode: 6 };

    it('tells the run so on the line after the job line', async () => {
      const prompt = await buildBriefPrompt({ ...vars, series });
      expect(prompt).toContain(
        `Write only edit/brief.json, plus voice-note transcripts under edit/brief/.\n${EPISODE}\n\nThe owner runs the studio.`,
      );
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('says "an episode" when the job’s name has no number', async () => {
      const prompt = await buildBriefPrompt({ ...vars, series: { ...series, episode: null } });
      expect(prompt).toContain(EPISODE.replace('episode 6 of', 'an episode of'));
    });

    it('puts the series’ name on one line, like the client and the job', async () => {
      const prompt = await buildBriefPrompt({
        ...vars,
        series: { name: 'A {{client}}\n{{> brief-schema}}', episode: 1 },
      });
      expect(prompt).toContain('episode 1 of the series “A client > brief-schema”.');
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    });

    it('is the same prompt otherwise', async () => {
      const plain = await buildBriefPrompt(vars);
      const prompt = await buildBriefPrompt({ ...vars, series });
      expect(prompt.replace(`${EPISODE}\n`, '')).toBe(plain);
    });
  });

  // The prompt of a job outside a series is exactly what it was before CVP-255 (captured from the
  // template then, and read here, never written: don't update it with -u).
  it('is byte for byte the golden one for a job outside a series', async () => {
    const golden = readFileSync(`${GOLDEN_DIR}brief.txt`, 'utf8');
    const goldenVars = {
      client: 'מאפיית הצפון',
      job: 'פרומו לסוף השבוע',
      note: 'הטייק השני עדיף.\nKeep it under 30 seconds. {{client}}',
      files: [
        {
          relPath: '_chat.txt',
          kind: 'doc',
          size: 1_234,
          mtimeMs: Date.UTC(2026, 9, 19, 8, 3),
          durationSec: null,
        },
        {
          relPath: 'IMG_2201.mp4',
          kind: 'video',
          size: 12_345_678,
          mtimeMs: Date.UTC(2026, 9, 18, 21, 8),
          durationSec: 8.2,
        },
      ] as BriefPromptFile[],
    } as const;
    expect(await buildBriefPrompt(goldenVars)).toBe(golden);
    expect(await buildBriefPrompt({ ...goldenVars, series: null })).toBe(golden);
    expect(golden).not.toContain('This job is');
  });

  it("ends with the draft schema's JSON Schema, the one the engine validates with", async () => {
    const prompt = await buildBriefPrompt(vars);
    const schema = prompt.slice(prompt.indexOf('Schema:\n') + 'Schema:\n'.length).trimEnd();
    expect(schema).toBe(briefPromptSchema());
    const parsed = JSON.parse(schema) as { required: string[] };
    // With the Generate switch off the four keys of Generated videos are not asked for: the prompt
    // is what it was (the prompt with the switch on is tested below, "with Generate on").
    expect(parsed.required).toEqual(
      Object.keys(briefDraftSchema.shape).filter(
        (key) => !(BRIEF_GENERATED_KEYS as readonly string[]).includes(key),
      ),
    );
    expect(schema).not.toMatch(/production|voiceover|budgetUsd/);
  });
});

// Generated videos (GN4, CVP-413): the Brief run fills production, voiceover, formats and budgetUsd,
// and knows a zip in the list is unpacked. The partial is empty with the switch off (the golden
// brief.txt above is the proof), and the schema leaves the four keys out then.
describe('the Brief prompt with Generate on (brief-generate.md)', () => {
  const vars = {
    client: 'Pinewood',
    job: '97 Window Ad',
    note: null,
    files: [] as BriefPromptFile[],
  };
  // The client's shared files are listed only for a folder with no footage; without any, the line goes.
  const generate = readFileSync(`${PROMPTS_DIR}brief-generate.md`, 'utf8')
    .trimEnd()
    .replace('{{> brief-shared}}\n', '');
  const LAST_RULE =
    '- No instructions and no note: summary "No instructions in the folder.", every other field null, files and assumptions filled.';

  it('is the prompt it was when the switch is off or left out', async () => {
    const before = await buildBriefPrompt(vars);
    expect(await buildBriefPrompt({ ...vars, generate: false })).toBe(before);
    expect(before).not.toMatch(/Generated videos|production|voiceover|formats|budgetUsd/);
    expect(before).not.toMatch(/\{\{|\}\}/);
  });

  it('adds the part once, as the last rule of step 4, and the four keys to the schema', async () => {
    const off = await buildBriefPrompt(vars);
    const on = await buildBriefPrompt({ ...vars, generate: true });
    expect(on.split(generate)).toHaveLength(2);
    expect(on).toContain(`${LAST_RULE}\n${generate}\n\nThis run is unattended`);
    // Nothing else moved but the schema at the end.
    expect(on.replace(`${generate}\n`, '')).toBe(
      off.replace(briefPromptSchema(), briefPromptSchema({ generate: true })),
    );
    expect(on.trimEnd().endsWith(briefPromptSchema({ generate: true }))).toBe(true);
    for (const key of BRIEF_GENERATED_KEYS) expect(on).toContain(`"${key}"`);
    expect(on).not.toMatch(/\{\{|\}\}/);
  });

  it('works with the Songs switch on too: both parts, both schemas', async () => {
    const on = await buildBriefPrompt({ ...vars, songs: true, generate: true });
    expect(on).toContain(generate);
    expect(on).toContain('- Songs. The client or the owner may ask for a song');
    expect(on.trimEnd().endsWith(briefPromptSchema({ songs: true, generate: true }))).toBe(true);
  });

  it('tells the run a zip is already unpacked, listed with its source, and has the role ignore', () => {
    expect(generate).toContain(
      'A .zip in the file list is already unpacked for you: its files follow it in the list under edit/brief/unzipped/, each marked with the zip it came from.',
    );
    expect(generate).toContain('Give the zip itself the role ignore.');
  });

  it('says production is "generate" only with no footage and a video to make, and a reference is not footage', () => {
    expect(generate).toContain(
      'production: "generate" only when there is no footage for the video and the instructions describe a video to make (a script to be spoken, scene directions, a shot list).',
    );
    expect(generate).toContain(
      'A video in a reference/ folder, inside a zip, or that the instructions call a reference or an example is a reference: style to match, never in the video.',
    );
    expect(generate).toContain('It is not footage, so it doesn’t stop "generate"');
    expect(generate).toContain('give it the role reference');
    expect(generate).toContain(
      'Footage in the folder, clips the instructions name that are in the client’s shared files, or instructions that only ask for an edit: production is null.',
    );
  });

  // 31 Oct: a winery brief named clips C7909 … C8046 that were all in the client's _Shared. The
  // Brief run saw only the job folder, called the video generated, and Generate stopped: no script.
  describe('the client’s shared files, for a folder with no footage', () => {
    const shared = ['C7909.MP4', 'C7953.MP4', 'broll/vineyard.mp4', 'logo.png'];

    it('lists them under the production rule, one line per folder, and says named clips are footage', async () => {
      const on = await buildBriefPrompt({ ...vars, generate: true, shared });
      expect(on).toContain(
        'Footage in the folder, clips the instructions name that are in the client’s shared files, or instructions that only ask for an edit: production is null.\n  - The folder has no footage, but the client keeps files for all of its videos in its _Shared folder (../_Shared/ from the job folder).',
      );
      expect(on).toContain('    - At the top: C7909.MP4, C7953.MP4, logo.png\n');
      expect(on).toContain('    - broll/: vineyard.mp4\n');
      expect(on).toContain(
        'When the instructions name clips that are in this list (C7909 for C7909.MP4), they are this video’s footage and the video is an edit of them: production is null, and summary says the clips are in the client’s shared files, never that they are missing.',
      );
      expect(on).not.toMatch(/\{\{|\}\}/);
    });

    it('lists nothing without shared files, and nothing with the Generate switch off', async () => {
      const on = await buildBriefPrompt({ ...vars, generate: true });
      expect(await buildBriefPrompt({ ...vars, generate: true, shared: [] })).toBe(on);
      expect(on).not.toContain('_Shared');
      expect(await buildBriefPrompt({ ...vars, shared })).toBe(await buildBriefPrompt(vars));
    });

    it('folds a folder’s names the way brief.md does, and says what the braces mean', () => {
      const text = briefSharedText(['broll/IMG-0012.MOV', 'broll/IMG-0013.MOV']);
      expect(text).toContain('(a{1,2}.mp4 means a1.mp4 and a2.mp4)');
      expect(text).toContain('    - broll/: IMG-{0012,0013}.MOV');
      expect(briefSharedText([])).toBe('');
      expect(briefSharedText(undefined)).toBe('');
    });
  });

  it('says the voiceover is the script word for word, a line per paragraph or quoted beat, L1, L2, …', () => {
    expect(generate).toContain(
      'copy it word for word as the client wrote it, split into lines in the order it is said, with the ids "L1", "L2", …',
    );
    // The first real run (PINEWOOD) split "Get it now and save. Tap below to request your appointment."
    // at its full stop: 8 lines where the client wrote 7 paragraphs.
    expect(generate).toContain(
      'Follow the client’s layout: a paragraph or a quoted beat is one line, even when it holds two short sentences (never split a paragraph at its full stops); a script written as one block of text is split at its sentences.',
    );
    expect(generate).toContain(
      'Keep the client’s words, spelling, punctuation and numbers exactly',
    );
    expect(generate).toContain('the voice step spells numbers out, you don’t');
    expect(generate).toContain('never reword, shorten, translate, merge or add a line');
    expect(generate).toContain('No script for a narrator: voiceover is null.');
  });

  it('gives a line a direction only when the instructions say how it is said', () => {
    expect(generate).toContain(
      'A line’s direction is only what the instructions say about how that line is said',
    );
    expect(generate).toContain('"stress BUT, with a short pause after it"');
    expect(generate).toContain('"slightly quieter, thought-provoking"');
    expect(generate).toContain('Otherwise null.');
    expect(generate).toContain('it goes in tone');
  });

  it('fills formats only when more than one format is explicitly asked for, the main one first, as the canvas', () => {
    expect(generate).toContain(
      'formats: only when the instructions or the owner’s note explicitly ask for more than one format',
    );
    expect(generate).toContain('the main one first, and canvas is that first one');
    expect(generate).toContain('One format asked, or none: null.');
  });

  it('fills budgetUsd only from a note like "budget $5", never from the client', () => {
    expect(generate).toContain(
      'budgetUsd: only from the owner’s note, in a phrase like "budget $5" (a number of dollars).',
    );
    expect(generate).toContain('The client’s text never sets it. Otherwise null.');
  });

  it('asks for a summary that says there is no footage', () => {
    expect(generate).toContain(
      'summary says so: there is no footage, and the video is made from the script and the references.',
    );
  });
});

describe('the Brief prompt’s file list, with files unpacked from a zip', () => {
  it('says which zip a file came from, before its modified time', () => {
    const at = Date.UTC(2026, 9, 25, 12, 52);
    expect(
      formatBriefFiles([
        {
          relPath: 'pinewood-references.zip',
          kind: 'other',
          size: 2_590_839,
          mtimeMs: at,
          durationSec: null,
        },
        {
          relPath:
            'edit/brief/unzipped/pinewood-references/WhatsApp Image 2026-10-15 at 15.12.21.jpeg',
          kind: 'image',
          size: 62_424,
          mtimeMs: at,
          durationSec: null,
          fromZip: 'pinewood-references.zip',
        },
        {
          relPath:
            'edit/brief/unzipped/pinewood-references/WhatsApp Video 2026-10-15 at 15.13.02.mp4',
          kind: 'video',
          size: 1_597_859,
          mtimeMs: at,
          durationSec: 7.5,
          fromZip: 'pinewood-references.zip',
        },
      ]),
    ).toBe(
      [
        '- pinewood-references.zip (unknown type, 2.6 MB, modified 2026-10-25 12:52 UTC)',
        '- edit/brief/unzipped/pinewood-references/WhatsApp Image 2026-10-15 at 15.12.21.jpeg (image, 62 KB, from pinewood-references.zip, modified 2026-10-25 12:52 UTC)',
        '- edit/brief/unzipped/pinewood-references/WhatsApp Video 2026-10-15 at 15.13.02.mp4 (video, 1.6 MB, 0:08, from pinewood-references.zip, modified 2026-10-25 12:52 UTC)',
      ].join('\n'),
    );
  });
});

// Songs (SG4): the Brief run reads the song off a screenshot, a link or the words. The partial is empty
// with the switch off (the golden brief.txt above is the proof), and the schema keeps its song keys then.
describe('the Brief prompt with Songs on (brief-songs.md)', () => {
  const vars = {
    client: 'מאפיית הצפון',
    job: 'פרומו לסוף השבוע',
    note: 'Yael sent a reel: use its song.',
    files: [] as BriefPromptFile[],
  };
  const songs = readFileSync(`${PROMPTS_DIR}brief-songs.md`, 'utf8').trimEnd();
  const briefMusic = readFileSync(`${PROMPTS_DIR}brief-music.md`, 'utf8').trimEnd();
  const VIDEO_BULLET =
    '- Video: don’t transcribe it; the edit run does. Tell footage from a reference clip by its name, its duration and the chat. Look at one frame only when that doesn’t settle it.';

  it('is the prompt it was when the switch is off or left out', async () => {
    const before = await buildBriefPrompt(vars);
    expect(await buildBriefPrompt({ ...vars, songs: false })).toBe(before);
    expect(before).not.toMatch(/Songs\.|music\.original|wantsTrending/);
    expect(before).not.toMatch(/\{\{|\}\}/);
  });

  it('adds the part once, right after the Video bullet, and the song keys to the schema', async () => {
    const off = await buildBriefPrompt(vars);
    const on = await buildBriefPrompt({ ...vars, songs: true });
    expect(on.split(songs)).toHaveLength(2);
    expect(on).toContain(`${VIDEO_BULLET}\n${songs}\n${briefMusic}\n\n3. Give each file a role`);
    // Nothing else moved but the schema at the end.
    // (Songs only run with the music, so the music part follows the songs part: see its own tests.)
    expect(on.replace(`${songs}\n${briefMusic}\n`, '')).toBe(
      off.replace(briefPromptSchema(), briefPromptSchema({ songs: true })),
    );
    expect(on.trimEnd().endsWith(briefPromptSchema({ songs: true }))).toBe(true);
    expect(on).not.toMatch(/\{\{|\}\}/);
  });

  it('reads a screenshot’s label as instructions, word for word, Hebrew as written', () => {
    expect(songs).toContain(
      'A screenshot of a reel or a TikTok whose audio label names a song is instructions, not a reference',
    );
    expect(songs).toContain('Read the label word for word.');
    expect(songs).toContain(
      'On Instagram it is the line with a music note under the account name, “Artist · Title”.',
    );
    expect(songs).toContain('On TikTok it is the scrolling line next to the spinning record');
    expect(songs).toContain('Hebrew included: never translate, shorten, correct or look up a name');
    for (const version of SONG_VERSIONS) expect(songs).toContain(`“${version}”`);
    expect(songs).toContain(
      '“sped up”, “slowed” or “remix” in the label or in the chat is song.version',
    );
  });

  it('never guesses a song from Original audio, and never completes a cut-off label', () => {
    expect(songs).toContain(
      'Set music.original to { "by": "[account]" } with the account as written on the label, and song to null.',
    );
    expect(songs).toContain('Never guess a song from it, from the footage or from the account.');
    expect(songs).toContain(
      'A label that is cut off (it ends in “…”): write what is visible and say in assumptions that the label was cut off. Never complete it from memory.',
    );
  });

  it('puts a link in song.link without inventing a name, and a trending ask in wantsTrending', () => {
    expect(songs).toContain(
      '(YouTube, music.youtube.com, an Instagram reel, TikTok, Spotify, Apple Music) goes word for word in song.link',
    );
    expect(songs).toContain('song.title and song.artist stay null: never invent a name for it');
    expect(songs).toContain(
      'A song named in words goes in song.title and song.artist, with song.link null.',
    );
    expect(songs).toContain(
      '“A trending song”, “שיר טרנדי”, “something viral”, “a song that’s trending” with no song named: music.wantsTrending is true and song is null.',
    );
  });

  it('keeps the conflict rules: The owner’s note and their attachments, then the newest; a music file beats a song', () => {
    expect(songs).toContain('Conflicts between two songs follow step 4: The owner’s note first');
    expect(songs).toContain('edit/brief/from-you/');
    expect(songs).toContain(
      'A music file in the folder (role music) still wins over any song: then song stays null',
    );
    expect(songs).toContain('the conflict goes in assumptions');
  });

  it('names only keys the schema has', async () => {
    const schema = JSON.parse(briefPromptSchema({ songs: true })) as JsonSchemaNode;
    const objectOf = (node: JsonSchemaNode | undefined): Record<string, JsonSchemaNode> =>
      node?.properties ?? node?.anyOf?.find((option) => option.properties)?.properties ?? {};
    const music = objectOf(objectOf(schema).music);
    expect(Object.keys(music)).toEqual([
      'file',
      'note',
      'wanted',
      'song',
      'original',
      'wantsTrending',
    ]);
    const song = objectOf(music.song);
    const original = objectOf(music.original);
    expect(Object.keys(song)).toEqual(['title', 'artist', 'version', 'link', 'fromFile']);
    expect(Object.keys(original)).toEqual(['by']);
    const named = (prefix: string) =>
      [...songs.matchAll(new RegExp(`\\b${prefix}\\.(\\w+)\\b(?!\\.\\w)`, 'g'))].map((m) => m[1]);
    for (const key of named('music')) expect(Object.keys(music), `music.${key}`).toContain(key);
    for (const key of named('song')) expect(Object.keys(song), `song.${key}`).toContain(key);
    // The song sits inside music, not beside it.
    expect(Object.keys(objectOf(schema))).not.toContain('song');
  });

  it('snapshot: the whole Brief prompt, with the attached screenshot in the file list', async () => {
    const goldenVars = {
      client: 'מאפיית הצפון',
      job: 'פרומו לסוף השבוע',
      note: 'הטייק השני עדיף.\nKeep it under 30 seconds. {{client}}',
      files: [
        {
          relPath: '_chat.txt',
          kind: 'doc',
          size: 1_234,
          mtimeMs: Date.UTC(2026, 9, 19, 8, 3),
          durationSec: null,
        },
        {
          relPath: 'IMG_2201.mp4',
          kind: 'video',
          size: 12_345_678,
          mtimeMs: Date.UTC(2026, 9, 18, 21, 8),
          durationSec: 8.2,
        },
        {
          relPath: 'edit/brief/from-you/IMG_4412.PNG',
          kind: 'image',
          size: 215_000,
          mtimeMs: Date.UTC(2026, 9, 19, 8, 5),
          durationSec: null,
        },
      ] as BriefPromptFile[],
      songs: true,
    };
    expect(await buildBriefPrompt(goldenVars)).toBe(
      readFileSync(`${GOLDEN_DIR}songs-brief.txt`, 'utf8'),
    );
  });
});

/** The bit of a JSON Schema these tests walk. */
interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  anyOf?: JsonSchemaNode[];
}

describe('the Brief prompt’s file list', () => {
  const at = Date.UTC(2026, 9, 21, 7, 5);
  const file = (over: Partial<BriefPromptFile>): BriefPromptFile => ({
    relPath: 'a.txt',
    kind: 'doc',
    size: 10,
    mtimeMs: at,
    durationSec: null,
    ...over,
  });

  it('gives path, kind, size and modified time, and the length of video and audio', () => {
    expect(
      formatBriefFiles([
        file({ relPath: 'Reel/clip.mov', kind: 'video', size: 2_500_000_000, durationSec: 75 }),
        file({ relPath: 'note.opus', kind: 'audio', size: 800, durationSec: 4.6 }),
        file({ relPath: 'logo.png', kind: 'image', size: 27_000 }),
        file({ relPath: 'x.fcpxml', kind: 'other', size: 999_700 }),
      ]),
    ).toBe(
      [
        '- Reel/clip.mov (video, 2.5 GB, 1:15, modified 2026-10-21 07:05 UTC)',
        '- note.opus (audio, 800 bytes, 0:05, modified 2026-10-21 07:05 UTC)',
        '- logo.png (image, 27 KB, modified 2026-10-21 07:05 UTC)',
        '- x.fcpxml (unknown type, 1 MB, modified 2026-10-21 07:05 UTC)',
      ].join('\n'),
    );
  });

  it('says when ffprobe could not read a length, and keeps one file on one line', () => {
    expect(
      formatBriefFiles([file({ relPath: 'bad\nname.mp4', kind: 'video', durationSec: null })]),
    ).toBe('- bad name.mp4 (video, 10 bytes, duration unreadable, modified 2026-10-21 07:05 UTC)');
  });

  it('writes sizes in decimal units', () => {
    const sizes = [0, 999, 1_000, 1_234, 45_678, 999_600, 12_345_678, 1_500_000_000];
    expect(sizes.map(briefFileSize)).toEqual([
      '0 bytes',
      '999 bytes',
      '1 KB',
      '1.2 KB',
      '46 KB',
      '1 MB',
      '12 MB',
      '1.5 GB',
    ]);
  });
});

describe('README', () => {
  // P9 (CVP-90): the README showed a start prompt that was several rules behind the one the engine
  // sends. Its "The command" section keeps the first ```text block as a copy of the start prompt,
  // with <Client> and <Job> for the names; editing prompts/*.md means updating that block too.
  // Since W15 Review is on by default, so the block is the start prompt with the switch on.
  it('shows the start prompt the engine sends with Review on, word for word', async () => {
    const readme = readFileSync(README, 'utf8');
    const section = readme.indexOf('### The command');
    expect(section, 'README.md has no "### The command" section').toBeGreaterThan(-1);
    const block = /```text\n([\s\S]*?)\n```/.exec(readme.slice(section));
    expect(block, 'README.md "The command" has no ```text block').not.toBeNull();
    const sent = await buildPrompt('start', { client: '<Client>', job: '<Job>', review: true });
    expect(block?.[1]).toBe(
      sent.trimEnd().replaceAll(COLOR_GRADE_SCRIPT, '<Studio Engine>/scripts/color-grade/run.sh'),
    );
  });
});

describe('renderTemplate', () => {
  it('fills variables and partials', () => {
    expect(
      renderTemplate('Hi {{name}}. {{> tail}}', { name: 'A' }, { tail: 'Bye {{name}}.\n' }),
    ).toBe('Hi A. Bye A.');
  });

  it('puts a computed partial in as it is, and never re-reads what a value brings in', () => {
    expect(
      renderTemplate(
        '{{a}} | {{> raw}} | {{> file}}',
        { a: '{{b}}', b: 'B' },
        { raw: { raw: '{"x": "{{a}}"}\n' }, file: '{{a}}!' },
      ),
    ).toBe('{{b}} | {"x": "{{a}}"} | {{b}}!');
  });

  describe('an include that comes out empty', () => {
    it('takes its own line with it', () => {
      expect(renderTemplate('a\n{{> x}}\nb', {}, { x: { raw: '' } })).toBe('a\nb');
      expect(renderTemplate('a\n{{> x}}\nb', {}, { x: '' })).toBe('a\nb');
      expect(renderTemplate('a\n{{> x}}\nb', {}, { x: { raw: '\n\n' } })).toBe('a\nb');
    });

    it('stays in place when it has text', () => {
      expect(renderTemplate('a\n{{> x}}\nb', {}, { x: { raw: 'X\n' } })).toBe('a\nX\nb');
    });

    it('leaves the text around it when it is not alone on its line', () => {
      expect(renderTemplate('a {{> x}} b\n', {}, { x: { raw: '' } })).toBe('a  b\n');
      expect(renderTemplate('- {{> x}}\n', {}, { x: { raw: '' } })).toBe('- \n');
    });

    it('still refuses an unknown partial on its own line', () => {
      expect(() => renderTemplate('a\n{{> nope}}\nb', {})).toThrow(/Unknown prompt partial/);
    });

    it('never removes a line that only looks like an include because a value brought it in', () => {
      expect(renderTemplate('{{a}}\nz\n', { a: '\n{{> x}}\n' }, { x: { raw: '' } })).toBe(
        '\n{{> x}}\n\nz\n',
      );
    });
  });

  it('refuses a missing variable or partial instead of sending a broken prompt', () => {
    expect(() => renderTemplate('{{nope}}', {})).toThrow(/"nope" has no value/);
    expect(() => renderTemplate('{{> nope}}', {})).toThrow(/Unknown prompt partial "nope"/);
  });
});

// QF4 (CVP-376): the self-eval line of preview-finish.md is a partial. A revise run whose Send with
// Auto asked for the Revise tier gets the slim one (only around what the round changed); every other
// run gets the whole check, so the prompts that were sent before are unchanged byte for byte (the
// golden files above, which are never rewritten).
describe('the slim self-check of a Revise-tier round (QF4)', () => {
  const FULL_LINE =
    "- Self-eval on the composition instead of a render: npx hyperframes lint with 0 errors, snapshots at every cut and at each graphic's payoff (npx hyperframes snapshot), the caption gate (§3.4 step 5) on those snapshots, and the loudness of cut.mp4 with the music under it.";
  const SLIM_LINE =
    '- Self-eval only around what this round changed: npx hyperframes lint with 0 errors, snapshots at the cuts and graphics you changed (and a second either side), the caption gate (§3.4 step 5) on those snapshots, and the loudness of cut.mp4 with the music under it only if the audio changed.';
  const revise = (over: Partial<PromptVars> = {}) =>
    buildPrompt('start', { ...GOLDEN_VARS, kind: 'revise', round: 1, review: true, ...over });

  it('has two partials: the whole check word for word as preview-finish.md had it, and the slim one', () => {
    expect(readFileSync(`${PROMPTS_DIR}self-eval-full.md`, 'utf8')).toBe(`${FULL_LINE}\n`);
    expect(readFileSync(`${PROMPTS_DIR}self-eval-slim.md`, 'utf8')).toBe(`${SLIM_LINE}\n`);
    const finish = readFileSync(`${PROMPTS_DIR}preview-finish.md`, 'utf8');
    expect(finish).toContain('\n{{> self-eval}}\n');
    expect(finish).not.toContain('Self-eval');
  });

  it('is in the revise prompt once, in the place of the whole check, and nothing else changes', async () => {
    const full = await revise();
    const slim = await revise({ checks: 'slim' });
    expect(slim).not.toBe(full);
    expect(slim.split(`${SLIM_LINE}\n`)).toHaveLength(2);
    expect(slim).not.toContain(FULL_LINE);
    expect(full.split(`${FULL_LINE}\n`)).toHaveLength(2);
    expect(full).not.toContain(SLIM_LINE);
    // Same prompt with the one line put back.
    expect(slim.replace(SLIM_LINE, FULL_LINE)).toBe(full);
    // It stays where the self-eval line was: before the exit rule.
    expect(slim).toContain(`${SLIM_LINE}\n${EXIT_LINE}\n${CLEAR_LINE}\n`);
  });

  it('asks for the whole check unless the slim one is asked for', async () => {
    const full = await revise();
    expect(await revise({ checks: 'full' })).toBe(full);
    expect(full).toContain(FULL_LINE);
  });

  it('is only for a revise run: the edit and render prompts ignore it', async () => {
    for (const mode of RUN_MODES) {
      const edit = { ...GOLDEN_VARS, review: true };
      expect(await buildPrompt(mode, { ...edit, checks: 'slim' })).toBe(
        await buildPrompt(mode, edit),
      );
    }
    const render = { ...GOLDEN_VARS, kind: 'render' as const };
    expect(await buildPrompt('start', { ...render, checks: 'slim' })).toBe(
      await buildPrompt('start', render),
    );
  });

  // A resume or a retry of the round (the run is stopped or fails) asks for the same check.
  it.each(RUN_MODES)(
    '%s: the slim revise prompt is complete and keeps the rest of the finish',
    async (mode) => {
      const prompt = await buildPrompt(mode, {
        ...GOLDEN_VARS,
        kind: 'revise',
        round: 2,
        review: true,
        checks: 'slim',
      });
      expect(prompt).not.toMatch(/\{\{|\}\}/);
      expect(prompt.split(`${SLIM_LINE}\n`)).toHaveLength(2);
      expect(prompt).not.toContain(FULL_LINE);
      expect(prompt.match(/The job is done when/g)).toHaveLength(1);
      expect(prompt.split(`${MARK_LINE}\n`)).toHaveLength(2);
      expect(prompt.split(`${EXIT_LINE}\n`)).toHaveLength(2);
    },
  );

  it('with graphics, music and a font named, still only changes that line', async () => {
    const over: Partial<PromptVars> = {
      graphics: true,
      music: true,
      musicScript: '/m/make-music.mjs',
    };
    const full = await revise(over);
    const slim = await revise({ ...over, checks: 'slim' });
    expect(slim.replace(SLIM_LINE, FULL_LINE)).toBe(full);
  });

  it('the whole prompt (snapshot)', async () => {
    const over = {
      ...GOLDEN_VARS,
      kind: 'revise',
      round: 1,
      review: true,
      checks: 'slim',
    } as const;
    const captured = readFileSync(`${GOLDEN_DIR}revise-slim.txt`, 'utf8');
    expect(await buildPrompt('start', over)).toBe(await withColorGrade(captured, over));
  });
});

// U21 (CVP-444): music is made or fetched only when the job asks for it explicitly. The edit run's
// ladder ends in "no music" (the script's `none --plan`), the Brief run fills `music.wanted`, and a
// revise run makes no music for a job whose music was not asked for unless a note asks.
describe('music only when asked (U21)', () => {
  const SCRIPT = '/engine/apps/server/assets/music/make-music.mjs';
  const vars = { ...job, step: 5 as const, error: 'ffmpeg exited 1' };
  const read = (name: string) => readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8');
  const render = (name: string, songs = false) =>
    renderTemplate(read(name), { musicScript: SCRIPT }, songPartials(songs)).trimEnd();
  const MUSIC_ON = { music: true, musicScript: SCRIPT };

  describe('the edit run’s ladder (music.md)', () => {
    const music = render('music');

    it('makes music only when the job asks for it, and says so in its first line', () => {
      expect(music).not.toContain('Nothing settles it');
      expect(music).not.toContain('makes music for a video that has none');
      expect(music).toContain('only when the job asks for it explicitly');
      expect(music).toContain('nothing is made or fetched for it');
      expect(music).toContain(
        '  - The job asks for music to be made or added: make the music, as in "Making it" below.',
      );
    });

    it('lists what asks: the brief (its line, its note, an older brief’s text), a rule in the series or the style, the owner in Review', () => {
      expect(music).toContain(
        '"Music: asked for, made by the editor" (edit/brief.json: music.wanted is true)',
      );
      expect(music).toContain('ask for music in so many words');
      expect(music).toContain(
        'A brief written before this rule has no music.wanted, and its line "Music: not asked for" cannot know: read the owner\'s note and the summary yourself, whatever the line says.',
      );
      expect(music).toContain('has a rule that tells to have music in the videos');
      expect(music).toContain('The owner asked for it in Review');
    });

    it('never counts taste as an ask, and lets the brief’s ask beat a no-music rule of the style', () => {
      expect(music).toContain(
        'A line that only describes the taste of music, or what the reference videos had',
      );
      expect(music).toContain('Neither is the wish for a good video');
      expect(music).toContain(
        "it beats a no-music rule of the series or the client's style, since the brief is asked first",
      );
    });

    it('keeps the music file, the series and the no-music rule exactly where they were', () => {
      const at = (text: string) => {
        expect(music.split(text), text).toHaveLength(2);
        return music.indexOf(text);
      };
      const order = [
        '  - A music file the brief lists as music:',
        '  - A series episode:',
        '  - A rule that says no music',
        '  - The job asks for music to be made or added',
        '  - Nothing above asks for music',
        '- No music asked for.',
        "- Making it. Once the cut's shape is fixed",
      ].map(at);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('with nothing asking, runs none --plan with the plan from the cut, makes nothing and keeps the element', () => {
      const none = music.split('\n').find((line) => line.startsWith('- No music asked for.')) ?? '';
      expect(none).toContain('Make nothing: no make, no song, no download, no ElevenLabs credit.');
      expect(none).toContain(
        `\`node "${SCRIPT}" none "<edit dir>" "Music was not asked for." --plan\``,
      );
      expect(none).toContain(
        'write edit/music/plan.json from that shape exactly as "Making it" says',
      );
      expect(none).toContain("puts silence of the plan's length at edit/preview/music.mp3");
      expect(none).toContain(
        'with its music element and its volume lane exactly as if the make had worked',
      );
      expect(none).toContain('"Music was not asked for, so none was made."');
      // A plan that does not fit is fixed; the last resort is the plain call.
      expect(none).toContain(
        'fix plan.json and run it again; if it still fails, run it once without --plan',
      );
      // Music an earlier run or the owner made is kept.
      expect(none).toContain('already has music picked');
      expect(none).not.toMatch(/ make "<edit dir>"| song "<edit dir>"/);
    });

    it('the reason it records is the one the app tells apart (Review and the sheet read it)', () => {
      expect(music).toContain(`"${MUSIC_NOT_ASKED_REASON}"`);
    });

    it('still makes the music when it is asked for, the way it did', () => {
      expect(music).toContain(
        `Then run \`node "${SCRIPT}" make "<edit dir>"\` with a Bash timeout of 600000 ms`,
      );
      expect(music).toContain('Never run make more than twice in this run');
    });
  });

  describe('a song or a screenshot is an ask too (Songs)', () => {
    it('Original audio and a song that cannot be got still end in a made track, and say why', () => {
      expect(render('music-songs-sources', true)).toContain(
        'The screenshot was asked for, so music is asked for: make the music as in "Making it" below',
      );
      expect(render('music-songs', true)).toContain(
        'a song was asked for, so a made track is still the stated wish',
      );
    });
  });

  describe('the revise run (music-revise.md)', () => {
    const revise = render('music-revise');

    it('makes no music for a job whose music was not asked for, unless a note asks', () => {
      const line =
        revise.split('\n').find((text) => text.startsWith('- Music that was not asked for')) ?? '';
      expect(line).toContain('"source": "none" with the reason "Music was not asked for."');
      expect(line).toContain('a revise makes no music, unless a note asks for some');
      expect(line).toContain(
        'is "a note that asks for music when there is none yet" in the next line',
      );
    });

    it('keeps the plan and the silence in step with a new cut', () => {
      expect(revise).toContain(
        `\`node "${SCRIPT}" none "<edit dir>" "Music was not asked for." --plan\` again`,
      );
      expect(revise).toContain('so Make music in Review fits the new cut');
    });

    it('still answers a note that asks for music where there is none, with a make', () => {
      expect(revise).toContain(
        'A note that asks for music when there is none yet: write plan.json',
      );
      expect(revise).toContain('run make with --by revise');
    });

    it('sits before the note about the music itself, so the song lines still follow that note', async () => {
      const on = await buildPrompt('start', {
        ...vars,
        kind: 'revise',
        round: 1,
        review: true,
        ...MUSIC_ON,
      });
      const at = (text: string) => on.indexOf(text);
      expect(at('\n- Music that was not asked for')).toBeGreaterThan(
        at('\n- When the notes change the cut'),
      );
      expect(at('\n- Music that was not asked for')).toBeLessThan(
        at('\n- A note about the music itself'),
      );
    });
  });

  describe('the Brief run (brief-music.md)', () => {
    const briefVars = {
      client: 'מאפיית הצפון',
      job: 'פרומו לסוף השבוע',
      note: 'Add music with drops.',
      files: [] as BriefPromptFile[],
    };
    const part = readFileSync(`${PROMPTS_DIR}brief-music.md`, 'utf8').trimEnd();
    const VIDEO_BULLET =
      '- Video: don’t transcribe it; the edit run does. Tell footage from a reference clip by its name, its duration and the chat. Look at one frame only when that doesn’t settle it.';

    it('is the prompt it was with the music switch off or left out', async () => {
      const before = await buildBriefPrompt(briefVars);
      expect(await buildBriefPrompt({ ...briefVars, music: false })).toBe(before);
      expect(before).not.toContain('music.wanted');
      expect(before).not.toContain('"wanted"');
      expect(before).not.toMatch(/\{\{|\}\}/);
    });

    it('adds the part once, right after the Video bullet, and wanted to the schema', async () => {
      const off = await buildBriefPrompt(briefVars);
      const on = await buildBriefPrompt({ ...briefVars, music: true });
      expect(on.split(part)).toHaveLength(2);
      expect(on).toContain(`${VIDEO_BULLET}\n${part}\n\n3. Give each file a role`);
      // Nothing else moved but the schema at the end.
      expect(on.replace(`${part}\n`, '')).toBe(
        off.replace(briefPromptSchema(), briefPromptSchema({ music: true })),
      );
      expect(on.trimEnd().endsWith(briefPromptSchema({ music: true }))).toBe(true);
      expect(on).not.toMatch(/\{\{|\}\}/);
    });

    it('works with Songs and Generate on too: songs part, then music part, one schema', async () => {
      const songs = readFileSync(`${PROMPTS_DIR}brief-songs.md`, 'utf8').trimEnd();
      const on = await buildBriefPrompt({ ...briefVars, music: true, songs: true, generate: true });
      expect(on).toContain(`${VIDEO_BULLET}\n${songs}\n${part}\n\n3. Give each file a role`);
      expect(
        on.trimEnd().endsWith(briefPromptSchema({ music: true, songs: true, generate: true })),
      ).toBe(true);
      // Songs without `music` counts the music as on (Songs only run with it).
      expect(await buildBriefPrompt({ ...briefVars, songs: true })).toBe(
        await buildBriefPrompt({ ...briefVars, songs: true, music: true }),
      );
    });

    it('is plain: true only for an ask in so many words, never from taste or the footage', () => {
      expect(part).toContain('music.wanted says whether the instructions ask for music');
      expect(part).toContain('“add music”');
      expect(part).toContain('“תוסיפו מוזיקה”');
      expect(part).toContain('Never true because music would fit this video');
      expect(part).toContain(
        'A reference video that has music in it is a style to match, not an ask for music.',
      );
      expect(part).toContain('A line that only says what music the client likes');
      expect(part).toContain('a music file');
      expect(part).toContain('and when they say no music');
    });

    it('names only keys the schema has', () => {
      const schema = JSON.parse(briefPromptSchema({ music: true })) as JsonSchemaNode;
      const music = schema.properties?.music?.anyOf?.find(
        (option) => option.properties,
      )?.properties;
      expect(Object.keys(music ?? {})).toEqual(['file', 'note', 'wanted']);
      const named = [...part.matchAll(/\bmusic\.(\w+)\b(?!\.\w)/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      for (const key of named) expect(Object.keys(music ?? {}), `music.${key}`).toContain(key);
    });
  });

  describe('with the music switch off', () => {
    it.each(RUN_MODES)('%s: every run’s prompt is what it was, byte for byte', async (mode) => {
      for (const over of [
        {},
        { review: true },
        { kind: 'revise', round: 1, review: true },
        { kind: 'render' },
      ] as const) {
        const before = await buildPrompt(mode, { ...vars, ...over });
        const prompt = await buildPrompt(mode, { ...vars, ...over, music: false });
        expect(prompt).toBe(before);
        expect(prompt).not.toMatch(/Music was not asked for|--plan|make-music|\{\{|\}\}/);
      }
    });
  });
});
