import type { BriefFile, BriefFileRole, StepId } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  CHECK_ROUND_GAP_MS,
  estimateCheckPass,
  type FileChange,
  type InitialProgress,
  initialProgress,
  MAKING_MUSIC,
  type ProgressSignal,
  type ProgressState,
  passFromSub,
  progressReport,
  reduceProgress,
  transcribeTotal,
} from './progress-reducer.js';

// The reducer on its own: every signal, and the rules that hold across them (never backwards,
// never below the run's floor, pure).

const file = (path: string, change: FileChange = 'add'): ProgressSignal => ({
  type: 'file',
  path,
  change,
});

function run(signals: readonly ProgressSignal[], init: InitialProgress = {}): ProgressState {
  return signals.reduce(reduceProgress, initialProgress({ sources: 1, ...init }));
}

const report = (signals: readonly ProgressSignal[], init: InitialProgress = {}) =>
  progressReport(run(signals, init));

/** A state at `step` reached the way a run gets there. Brief (1) is never reached from files. */
const UP_TO: Record<Exclude<StepId, 1>, ProgressSignal[]> = {
  2: [],
  3: [file('transcripts/clip-01.json'), file('takes_packed.md')],
  4: [file('transcripts/clip-01.json'), file('takes_packed.md'), file('project.md', 'change')],
  5: [file('takes_packed.md'), file('project.md'), file('edl.json')],
  6: [file('takes_packed.md'), file('project.md'), file('edl.json'), file('preview.mp4')],
  7: [
    file('takes_packed.md'),
    file('project.md'),
    file('edl.json'),
    file('preview.mp4'),
    file('verify/p_1.jpg'),
  ],
  8: [file('takes_packed.md'), file('project.md'), file('edl.json'), file('final.mp4')],
};

describe('initialProgress', () => {
  it('starts a fresh run at Transcribe', () => {
    expect(initialProgress()).toMatchObject({ floor: 2, step: 2, pass: 0 });
    expect(initialProgress({ floor: null })).toMatchObject({ floor: 2, step: 2 });
  });

  it('starts a run whose job is at Brief at Transcribe: the reducer has no step 1', () => {
    expect(initialProgress({ floor: 1 })).toMatchObject({ floor: 2, step: 2 });
  });

  it('starts a resumed or retried run at the job step', () => {
    expect(initialProgress({ floor: 5 })).toMatchObject({ floor: 5, step: 5 });
  });

  // W3: a fresh revise run starts at Plan (4) and a render run at Render (8), whatever the files say.
  it('keeps any floor from Transcribe on: a revise run’s Plan (4), a render run’s Render (8)', () => {
    expect(initialProgress({ floor: 4, finish: 'preview' })).toMatchObject({ floor: 4, step: 4 });
    expect(initialProgress({ floor: 8 })).toMatchObject({ floor: 8, step: 8 });
    for (const floor of [2, 3, 4, 5, 6, 7, 8] as const) {
      expect(initialProgress({ floor })).toMatchObject({ floor, step: floor });
    }
  });

  it('carries on the pass of a run resumed at Check, and only there', () => {
    expect(initialProgress({ floor: 7, pass: 2 }).pass).toBe(2);
    expect(initialProgress({ floor: 7 }).pass).toBe(1);
    expect(initialProgress({ floor: 6, pass: 2 }).pass).toBe(0);
  });
});

describe('2 Transcribe: transcripts/*.json against the audio and video sources', () => {
  it('counts transcripts as they land, from 0', () => {
    const sources = { sources: 3 };
    expect(report([], sources)).toEqual({ step: 2, sub: '0/3' });
    expect(report([file('transcripts/a.json')], sources)).toEqual({ step: 2, sub: '1/3' });
    expect(report([file('transcripts/a.json'), file('transcripts/b.json')], sources)).toEqual({
      step: 2,
      sub: '2/3',
    });
  });

  it('counts each transcript once, and drops one that is removed', () => {
    const state = run(
      [
        file('transcripts/a.json'),
        file('transcripts/a.json', 'change'),
        file('transcripts/b.json'),
        file('transcripts/b.json', 'unlink'),
      ],
      { sources: 2 },
    );
    expect(state.transcripts).toEqual(['a']);
    expect(progressReport(state).sub).toBe('1/2');
  });

  it('ignores anything in transcripts/ that is not a transcript', () => {
    const state = run([
      file('transcripts/notes.txt'),
      file('transcripts/.a.json.tmp'),
      file('transcripts/old/'),
      file('transcripts/old/a.json'),
    ]);
    expect(state.transcripts).toEqual([]);
  });

  it('never shows more done than there are (a source the scan does not count)', () => {
    expect(report([file('transcripts/a.json'), file('transcripts/b.json')])).toEqual({
      step: 2,
      sub: '2/2',
    });
  });

  it('shows no count for a job without audio or video', () => {
    expect(report([], { sources: 0 })).toEqual({ step: 2, sub: null });
  });
});

// CVP-134: with a brief, Transcribe's N is the footage files, not every audio and video file.
describe('2 Transcribe: N from the brief (transcribeTotal)', () => {
  const entry = (path: string, role: BriefFileRole): BriefFile => ({ path, role, note: null });

  it('counts the footage videos only: not ignored clips, not voice notes', () => {
    const files = [
      entry('clip-1.mp4', 'footage'),
      entry('clip-2.mov', 'footage'),
      entry('Takes/clip-3.MP4', 'footage'),
      entry('clip-4.mp4', 'footage'),
      entry('clip-5.mp4', 'ignore'),
      entry('voice-1.opus', 'instructions'),
      entry('voice-2.m4a', 'instructions'),
    ];
    expect(transcribeTotal({ files })).toBe(4);
  });

  it('counts an audio file the brief calls footage (a testimonial recorded as audio)', () => {
    expect(
      transcribeTotal({
        files: [entry('clip.mp4', 'footage'), entry('testimonial.m4a', 'footage')],
      }),
    ).toBe(2);
  });

  it('leaves out music (video-use does not transcribe it), logos, references and screenshots', () => {
    expect(
      transcribeTotal({
        files: [
          entry('clip.mp4', 'footage'),
          entry('bed.mp3', 'music'),
          entry('logo.png', 'logo'),
          entry('ref.mp4', 'reference'),
          entry('chat.png', 'instructions'),
          entry('notes.pdf', 'instructions'),
        ],
      }),
    ).toBe(1);
  });

  it('leaves out footage that is not audio or video: a photo has no speech to transcribe', () => {
    expect(
      transcribeTotal({
        files: [
          entry('clip.mp4', 'footage'),
          entry('photo.jpg', 'footage'),
          entry('x.bin', 'footage'),
        ],
      }),
    ).toBe(1);
  });

  it('is 0 for a brief with no footage', () => {
    expect(transcribeTotal({ files: [] })).toBe(0);
    expect(transcribeTotal({ files: [entry('voice.opus', 'instructions')] })).toBe(0);
  });

  it('is the N of the count: 0/4 to 4/4, never past it', () => {
    const files = [
      ...['a', 'b', 'c', 'd'].map((name) => entry(`${name}.mp4`, 'footage')),
      entry('e.mp4', 'ignore'),
      entry('v1.opus', 'instructions'),
      entry('v2.opus', 'instructions'),
    ];
    const sources = { sources: transcribeTotal({ files }) };
    const names = ['a', 'b', 'c', 'd'].map((name) => file(`transcripts/${name}.json`));
    expect(report([], sources)).toEqual({ step: 2, sub: '0/4' });
    expect(report(names.slice(0, 2), sources)).toEqual({ step: 2, sub: '2/4' });
    expect(report(names, sources)).toEqual({ step: 2, sub: '4/4' });
    // A run that transcribes more than the brief said still shows a sane number.
    expect(report([...names, file('transcripts/e.json')], sources)).toEqual({
      step: 2,
      sub: '5/5',
    });
  });
});

describe('3 Scan: takes_packed.md is written', () => {
  it('moves to Scan, with no count', () => {
    const state = run([file('transcripts/clip-01.json'), file('takes_packed.md')]);
    expect(state.packed).toBe(true);
    expect(progressReport(state)).toEqual({ step: 3, sub: null });
  });

  it('also when it is rewritten in place', () => {
    expect(report([file('takes_packed.md', 'change')]).step).toBe(3);
  });

  it('not when it is removed', () => {
    expect(report([file('takes_packed.md', 'unlink')]).step).toBe(2);
  });
});

describe('4 Plan: project.md written after the transcripts were packed', () => {
  it('moves to Plan', () => {
    expect(report([file('takes_packed.md'), file('project.md')])).toEqual({ step: 4, sub: null });
  });

  it('does not count a project.md written before any transcript (the blocked run)', () => {
    expect(report([file('project.md')]).step).toBe(2);
  });

  it('counts it once it is written again after packing', () => {
    const signals = [
      file('project.md'),
      file('transcripts/a.json'),
      file('takes_packed.md'),
      file('project.md', 'change'),
    ];
    expect(report(signals.slice(0, 3)).step).toBe(3);
    expect(report(signals).step).toBe(4);
  });
});

describe('5 Cut: edl.json or graphics, sub "graphics r/p"', () => {
  it('moves to Cut on edl.json, with no count while no graphics are planned', () => {
    expect(report([...UP_TO[4], file('edl.json')])).toEqual({ step: 5, sub: null });
  });

  it('moves to Cut on anything under animations/, before any EDL (E1 built its graphic first)', () => {
    expect(report([...UP_TO[4], file('animations/_shared/')])).toEqual({ step: 5, sub: null });
    expect(report([...UP_TO[4], file('animations/words_out.json')]).step).toBe(5);
  });

  it('counts planned slots and the ones rendered', () => {
    const signals = [
      ...UP_TO[4],
      file('animations/slot_1/'),
      file('animations/slot_1/index.html'),
      file('animations/slot_2/vendor/gsap.min.js'),
    ];
    expect(report(signals)).toEqual({ step: 5, sub: 'graphics 0/2' });
    expect(report([...signals, file('animations/slot_1/render.mov')])).toEqual({
      step: 5,
      sub: 'graphics 1/2',
    });
    expect(
      report([
        ...signals,
        file('animations/slot_1/render.mov'),
        file('animations/slot_2/render.mp4'),
      ]),
    ).toEqual({ step: 5, sub: 'graphics 2/2' });
  });

  it('takes the planned count from edl.json when it places more overlays than there are slots', () => {
    const signals = [
      ...UP_TO[4],
      file('animations/slot_1/render.mov'),
      { type: 'edl', overlays: 5 } as const,
    ];
    expect(report(signals)).toEqual({ step: 5, sub: 'graphics 1/5' });
  });

  it('an edl signal alone reaches Cut and keeps the latest count', () => {
    const state = run([
      { type: 'edl', overlays: 1 },
      { type: 'edl', overlays: 2 },
    ]);
    expect(state.edlOverlays).toBe(2);
    expect(progressReport(state)).toEqual({ step: 5, sub: 'graphics 0/2' });
  });

  it('ignores HyperFrames temp folders and dotfiles, and renders that are not a slot', () => {
    const state = run([
      ...UP_TO[4],
      file('animations/slot_1/'),
      file('animations/slot_1/.render.hf-transaction-nVHRZC/'),
      file('animations/slot_1/.hyperframes/video-state.json'),
      file('animations/slot_1/work-af46/frame_0001.png'),
      file('animations/_shared/render.mov'),
    ]);
    expect(state.slots).toEqual(['slot_1']);
    expect(state.rendered).toEqual([]);
  });

  it('a render that is deleted no longer counts, and a removed slot no longer is planned', () => {
    const base = [
      ...UP_TO[4],
      file('animations/slot_1/render.mov'),
      file('animations/slot_2/render.mov'),
    ];
    expect(report([...base, file('animations/slot_2/render.mov', 'unlink')]).sub).toBe(
      'graphics 1/2',
    );
    expect(report([...base, file('animations/slot_2/', 'unlink')]).sub).toBe('graphics 1/1');
  });

  it('keeps counting graphics after Cut, but only shows the count at Cut', () => {
    const state = run([...UP_TO[6], file('animations/slot_9/render.mov')]);
    expect(state.rendered).toContain('slot_9');
    expect(progressReport(state)).toEqual({ step: 6, sub: null });
  });
});

describe('6 Preview: a preview render starts, or preview*.mp4 shows', () => {
  it('moves to Preview when the stream says a preview render started', () => {
    expect(report([...UP_TO[5], { type: 'render', target: 'preview' }])).toEqual({
      step: 6,
      sub: null,
    });
  });

  it('moves to Preview on preview.mp4, and on render.py intermediate preview.prenorm.mp4', () => {
    expect(report([...UP_TO[5], file('preview.mp4')]).step).toBe(6);
    expect(report([...UP_TO[5], file('preview.prenorm.mp4')]).step).toBe(6);
    expect(report([...UP_TO[5], file('preview_v2.mp4')]).step).toBe(6);
  });

  it('does not take render.py internals or a preview in a sub-folder for one', () => {
    expect(report([...UP_TO[5], file('base_preview.mp4')]).step).toBe(5);
    expect(report([...UP_TO[5], file('clips_preview/seg_00_clip-01.mp4')]).step).toBe(5);
  });
});

describe('7 Check: verify/ frames of a render, or a critic; sub "pass n/3"', () => {
  it('moves to Check on a verify/ frame once a preview exists, at pass 1', () => {
    expect(report([...UP_TO[6], file('verify/p_0.9.jpg')])).toEqual({ step: 7, sub: 'pass 1/3' });
  });

  it('does not take a filmstrip of the sources for a check', () => {
    expect(report([...UP_TO[3], file('verify/src_full.png')]).step).toBe(3);
    // A preview render was started but no preview exists yet (it failed): still no check.
    const started = [...UP_TO[5], { type: 'render', target: 'preview' } as const];
    expect(report([...started, file('verify/src_full.png')]).step).toBe(6);
  });

  it('moves to Check when a critic sub-agent starts after the preview, not before', () => {
    expect(report([...UP_TO[6], { type: 'review' }])).toEqual({ step: 7, sub: 'pass 1/3' });
    expect(report([...UP_TO[5], { type: 'review' }]).step).toBe(5);
  });

  it('starts the next pass on a preview render that follows a check, up to 3/3', () => {
    const preview = { type: 'render', target: 'preview' } as const;
    const check = file('verify/frame.jpg', 'change');
    const pass1 = [...UP_TO[7]];
    const pass2 = [...pass1, preview, check];
    const pass3 = [...pass2, preview, check];
    expect(report(pass1).sub).toBe('pass 1/3');
    expect(report(pass2).sub).toBe('pass 2/3');
    expect(report(pass3).sub).toBe('pass 3/3');
    expect(report([...pass3, preview, check]).sub).toBe('pass 3/3');
  });

  it('counts two renders with nothing checked in between as one pass', () => {
    const preview = { type: 'render', target: 'preview' } as const;
    expect(report([...UP_TO[7], preview, preview]).sub).toBe('pass 2/3');
    expect(report([...UP_TO[7], preview, file('preview.mp4', 'change')]).sub).toBe('pass 2/3');
  });

  it('counts a re-render seen only in the files (preview.mp4 changed after a check)', () => {
    expect(report([...UP_TO[7], file('preview.mp4', 'change')]).sub).toBe('pass 2/3');
    // A new preview.mp4 (`add`) is the first sight of a render, never a new pass.
    expect(report([...UP_TO[7], file('preview.mp4', 'unlink'), file('preview.mp4')]).sub).toBe(
      'pass 1/3',
    );
  });

  it('resumed at Check, carries on from the pass it was at', () => {
    expect(report([], { floor: 7, pass: 2 })).toEqual({ step: 7, sub: 'pass 2/3' });
    expect(report([file('preview.mp4'), file('verify/a.jpg')], { floor: 7, pass: 2 }).sub).toBe(
      'pass 2/3',
    );
  });
});

describe('8 Render: a final render starts, or final*.mp4 shows', () => {
  it('moves to Render when the stream says a final render started', () => {
    expect(report([...UP_TO[7], { type: 'render', target: 'final' }])).toEqual({
      step: 8,
      sub: null,
    });
  });

  it('moves to Render on final.mp4 and its intermediates', () => {
    expect(report([...UP_TO[7], file('final.mp4')]).step).toBe(8);
    expect(report([...UP_TO[7], file('final.prenorm.mp4')]).step).toBe(8);
    expect(report([...UP_TO[7], file('final_v2.mp4', 'change')]).step).toBe(8);
  });

  it('not when final.mp4 is deleted', () => {
    expect(report([...UP_TO[7], file('final.mp4', 'unlink')]).step).toBe(7);
  });
});

describe('across signals', () => {
  it('never moves backwards: fixing graphics or checking again after the final stays at Render', () => {
    const state = run([
      ...UP_TO[8],
      file('animations/slot_1/render.mov', 'change'),
      file('edl.json', 'change'),
      { type: 'render', target: 'preview' },
      { type: 'review' },
      file('verify/g_2.2.jpg'),
      file('final.mp4', 'unlink'),
    ]);
    expect(progressReport(state)).toEqual({ step: 8, sub: null });
  });

  it('never goes below the floor of a resumed run', () => {
    expect(report([file('transcripts/a.json'), file('takes_packed.md')], { floor: 6 }).step).toBe(
      6,
    );
  });

  it('never reports Brief: nothing in edit/ points at step 1, whatever the floor or the signals', () => {
    const everything = [
      ...UP_TO[8],
      file('transcripts/a.json', 'unlink'),
      file('takes_packed.md', 'unlink'),
      file('project.md', 'unlink'),
      file('edl.json', 'unlink'),
      file('brief.json'),
      file('brief.md'),
      file('brief/transcripts/voice.json'),
    ];
    for (const floor of [null, 1, 2] as const) {
      expect(report([], { floor }).step).toBeGreaterThanOrEqual(2);
      expect(report(everything.slice(0, 1), { floor }).step).toBeGreaterThanOrEqual(2);
    }
    // Files from the Brief step (edit/brief.json and friends) are not progress of the edit run.
    expect(report([file('brief.json'), file('brief/transcripts/voice.json')])).toEqual({
      step: 2,
      sub: '0/1',
    });
    for (const signal of everything) {
      expect(reduceProgress(initialProgress(), signal).step).toBeGreaterThanOrEqual(2);
    }
  });

  it('jumps over steps one command did at once (plan, EDL and preview in one go)', () => {
    expect(report([...UP_TO[3], { type: 'render', target: 'preview' }]).step).toBe(6);
    expect(report([file('final.mp4')]).step).toBe(8);
  });

  it('ignores files it does not know and dot-named ones anywhere', () => {
    const before = run(UP_TO[4]);
    const after = [
      file('clips_graded/seg_00.mp4'),
      file('master.srt'),
      file('.final.mp4.partial'),
      file('./notes.md'),
      file(''),
    ].reduce(reduceProgress, before);
    expect(after).toBe(before);
  });

  it('is pure: it never changes the state it is given', () => {
    const before = run(UP_TO[4]);
    const copy = structuredClone(before);
    reduceProgress(before, file('animations/slot_1/render.mov'));
    reduceProgress(before, { type: 'render', target: 'final' });
    expect(before).toEqual(copy);
  });
});

// W2: a run that ends in Review finishes as a live composition in edit/preview/. Its Preview and
// Check read that composition, and it has no Render. A run that delivers final.mp4 reads what it
// always did.
describe("the composition flow (finish: 'preview')", () => {
  const composition = (tool: 'lint' | 'check' | 'snapshot' | 'preview'): ProgressSignal => ({
    type: 'composition',
    tool,
  });
  const runPreview = (signals: readonly ProgressSignal[], init: InitialProgress = {}) =>
    run(signals, { finish: 'preview', ...init });
  const stepOf = (signals: readonly ProgressSignal[], init: InitialProgress = {}) =>
    runPreview(signals, init).step;
  const PLANNED = [file('takes_packed.md'), file('project.md'), file('edl.json')];

  it('starts with the finish it is given, and the default is final', () => {
    expect(initialProgress({ finish: 'preview' }).finish).toBe('preview');
    expect(initialProgress().finish).toBe('final');
  });

  it('reaches Preview (6) when preview/index.html is written, and Check (7) with a verify/ frame', () => {
    const written = runPreview([...PLANNED, file('preview/index.html')]);
    expect(written.step).toBe(6);
    expect(written.preview).toBe(true);
    expect(progressReport(written)).toEqual({ step: 6, sub: null });

    const checked = runPreview([...PLANNED, file('preview/index.html'), file('verify/f_1.jpg')]);
    expect(progressReport(checked)).toEqual({ step: 7, sub: 'pass 1/3' });
  });

  it('does not take a verify/ frame for a check before the composition exists', () => {
    expect(stepOf([...PLANNED, file('verify/src_full.png')])).toBe(5);
  });

  it('starts the next pass when index.html changes after a check', () => {
    const base = [...PLANNED, file('preview/index.html'), file('verify/f_1.jpg')];
    expect(runPreview(base).pass).toBe(1);
    const again = runPreview([...base, file('preview/index.html', 'change')]);
    expect(again.pass).toBe(2);
    expect(again.checkedSinceRender).toBe(false);
    // Two edits in a row with nothing checked between them are one pass.
    expect(
      runPreview([
        ...base,
        file('preview/index.html', 'change'),
        file('preview/index.html', 'change'),
      ]).pass,
    ).toBe(2);
    // A second check, then another change: pass 3, and never more than that is reported.
    const third = runPreview([
      ...base,
      file('preview/index.html', 'change'),
      composition('lint'),
      file('preview/index.html', 'change'),
      composition('lint'),
      file('preview/index.html', 'change'),
    ]);
    expect(third.pass).toBe(4);
    expect(progressReport(third)).toEqual({ step: 7, sub: 'pass 3/3' });
  });

  it('a change to index.html before anything was checked is not a new pass', () => {
    const state = runPreview([
      ...PLANNED,
      file('preview/index.html'),
      file('preview/index.html', 'change'),
    ]);
    expect(state.step).toBe(6);
    expect(state.pass).toBe(0);
  });

  it('lint and check reach Check (7) from Preview, and do nothing below it', () => {
    for (const tool of ['lint', 'check'] as const) {
      expect(stepOf([...PLANNED, file('preview/index.html'), composition(tool)])).toBe(7);
      expect(stepOf([composition(tool)])).toBe(2);
      expect(stepOf(PLANNED)).toBe(5);
      expect(stepOf([...PLANNED, composition(tool)])).toBe(5);
    }
  });

  it('lint after the composition was checked once marks the next change as a new pass', () => {
    const state = runPreview([
      ...PLANNED,
      file('preview/index.html'),
      composition('lint'),
      file('preview/index.html', 'change'),
    ]);
    expect(state.pass).toBe(2);
  });

  it('snapshot and preview reach Preview (6) from before it, and never change the pass at Check', () => {
    for (const tool of ['snapshot', 'preview'] as const) {
      const reached = runPreview([...PLANNED, composition(tool)]);
      expect(reached.step).toBe(6);
      expect(reached.preview).toBe(true);
    }
    const atCheck = runPreview([...PLANNED, file('preview/index.html'), composition('lint')]);
    expect(atCheck.step).toBe(7);
    for (const tool of ['snapshot', 'preview'] as const) {
      const after = reduceProgress(atCheck, composition(tool));
      expect(after.step).toBe(7);
      expect(after.pass).toBe(atCheck.pass);
      expect(after.checkedSinceRender).toBe(atCheck.checkedSinceRender);
    }
  });

  it('snapshots after lint do not start a pass either', () => {
    const state = runPreview([
      ...PLANNED,
      file('preview/index.html'),
      composition('lint'),
      composition('snapshot'),
      composition('snapshot'),
    ]);
    expect(state.pass).toBe(1);
  });

  it('a critic sub-agent is check activity here as well', () => {
    expect(stepOf([...PLANNED, file('preview/index.html'), { type: 'review' }])).toBe(7);
  });

  it('final.mp4 and a final render are ignored: the run never reaches Render (8)', () => {
    const at7 = [...PLANNED, file('preview/index.html'), composition('lint')];
    expect(stepOf([...at7, file('final.mp4')])).toBe(7);
    expect(stepOf([...at7, file('final.mp4', 'change')])).toBe(7);
    expect(stepOf([...at7, { type: 'render', target: 'final' }])).toBe(7);
    expect(stepOf([...PLANNED, { type: 'render', target: 'final' }])).toBe(5);
    expect(stepOf([...PLANNED, file('final.mp4')])).toBe(5);
    expect(stepOf([...at7, file('final_v2.mp4')])).toBe(7);
  });

  it('a preview render (preview.mp4) still reaches Preview', () => {
    expect(stepOf([...PLANNED, { type: 'render', target: 'preview' }])).toBe(6);
    expect(stepOf([...PLANNED, file('preview.mp4')])).toBe(6);
  });

  it('index.html in a sub-folder, or one that is removed, does nothing', () => {
    expect(stepOf([...PLANNED, file('preview/compositions/index.html')])).toBe(5);
    expect(stepOf([...PLANNED, file('preview/a/b/index.html')])).toBe(5);
    expect(stepOf([...PLANNED, file('other/index.html')])).toBe(5);
    expect(stepOf([...PLANNED, file('preview/index.html', 'unlink')])).toBe(5);
    expect(stepOf([...PLANNED, file('preview/cut.mp4')])).toBe(5);
    expect(stepOf([...PLANNED, file('preview/index.html/', 'add')])).toBe(5);
    expect(stepOf([...PLANNED, file('preview/.hyperframes/index.html')])).toBe(5);
  });

  it('removing index.html afterwards does not take the step back', () => {
    expect(
      stepOf([...PLANNED, file('preview/index.html'), file('preview/index.html', 'unlink')]),
    ).toBe(6);
  });

  it('a run resumed at Check starts there, and index.html does not move it back', () => {
    const state = runPreview([file('preview/index.html')], { floor: 7, pass: 2 });
    expect(state.step).toBe(7);
    expect(state.pass).toBe(2);
  });

  describe('with the default finish, every one of these signals is ignored, as before', () => {
    const final = (signals: readonly ProgressSignal[]) => run(signals);

    it('preview/index.html', () => {
      expect(final([...PLANNED, file('preview/index.html')]).step).toBe(5);
      expect(final([...PLANNED, file('preview/index.html')]).preview).toBe(false);
      expect(final([...PLANNED, file('preview/index.html', 'change')]).step).toBe(5);
    });

    it('hyperframes lint, check, snapshot and preview', () => {
      for (const tool of ['lint', 'check', 'snapshot', 'preview'] as const) {
        expect(final([...PLANNED, composition(tool)]).step).toBe(5);
        expect(final([...UP_TO[6], composition(tool)])).toEqual(final(UP_TO[6]));
      }
    });

    it('final.mp4 and a final render still reach Render (8)', () => {
      expect(final([...PLANNED, file('final.mp4')]).step).toBe(8);
      expect(final([...PLANNED, { type: 'render', target: 'final' }]).step).toBe(8);
    });
  });
});

describe('passFromSub', () => {
  it('reads the pass of a "pass n/3" text', () => {
    expect(passFromSub('pass 2/3')).toBe(2);
    expect(passFromSub('graphics 2/5')).toBe(0);
    expect(passFromSub(null)).toBe(0);
  });
});

describe('the pass of a replay (CVP-138)', () => {
  // A resume or a retry has no `pass n/3` left (START, RESUME and RETRY clear it), so the watcher
  // adds an estimate to the replay of edit/.
  const pass = (n: number): ProgressSignal => ({ type: 'pass', n });

  it('raises the pass of a run that is at Check', () => {
    expect(report([...UP_TO[7], pass(2)])).toEqual({ step: 7, sub: 'pass 2/3' });
    expect(report([...UP_TO[7], pass(3)]).sub).toBe('pass 3/3');
    expect(report([...UP_TO[7], pass(9)]).sub).toBe('pass 3/3');
  });

  it('never lowers a pass that is known', () => {
    expect(report([...UP_TO[7], pass(1)], { floor: 7, pass: 3 }).sub).toBe('pass 3/3');
    expect(report([pass(2)], { floor: 7, pass: 3 }).sub).toBe('pass 3/3');
  });

  it('says nothing below Check or at Render', () => {
    expect(run([...UP_TO[6], pass(2)])).toEqual(run(UP_TO[6]));
    expect(run([...UP_TO[8], pass(2)])).toEqual(run(UP_TO[8]));
  });

  it('is counted on from: a new preview render after a check is the next pass', () => {
    const next = [...UP_TO[7], pass(2), { type: 'render', target: 'preview' } as const];
    expect(report(next).sub).toBe('pass 3/3');
  });
});

describe('estimateCheckPass', () => {
  const second = 1_000;
  const minute = 60 * second;

  it('is 1 without a preview, and for a first check', () => {
    expect(estimateCheckPass(null, [0, 5 * second])).toBe(1);
    expect(estimateCheckPass(100 * second, [])).toBe(1);
    // The first look at the sources, then the preview, then the frames of its first check.
    expect(estimateCheckPass(10 * minute, [minute, 10 * minute + second])).toBe(1);
    // No filmstrip of the sources at all.
    expect(estimateCheckPass(10 * minute, [10 * minute + second, 10 * minute + 3 * second])).toBe(
      1,
    );
  });

  it('counts a round that was followed by another preview render as an earlier pass', () => {
    // sources at 0, preview at 10 min and its frames, preview again at 20 min and its frames.
    const frames = [0, 10 * minute + second, 10 * minute + 2 * second, 20 * minute + second];
    expect(estimateCheckPass(20 * minute, frames)).toBe(2);
    expect(estimateCheckPass(30 * minute, [...frames, 30 * minute + second])).toBe(3);
  });

  it('takes the frames of one check, written seconds apart, for one round', () => {
    // A check of five frames over 20 s at the 5 minute mark, then the next preview at 10 minutes
    // and the frames of its check: the first look, one earlier pass, the current one.
    const earlier = [0, 4, 8, 12, 20].map((s) => 5 * minute + s * second);
    const current = [10 * minute + second, 10 * minute + 3 * second];
    expect(estimateCheckPass(10 * minute, [0, ...earlier, ...current])).toBe(2);
  });

  it('does not count a round that ended just before the preview was written', () => {
    // The frames of the current check, grabbed in the same command that wrote the preview, or
    // seconds before the file's last write.
    expect(estimateCheckPass(10 * minute, [0, 10 * minute - 2 * second])).toBe(1);
    expect(estimateCheckPass(10 * minute, [0, 10 * minute - CHECK_ROUND_GAP_MS])).toBe(1);
    expect(estimateCheckPass(10 * minute, [0, 10 * minute - CHECK_ROUND_GAP_MS - 1])).toBe(2);
    expect(estimateCheckPass(10 * minute, [0, 5 * minute, 10 * minute - 2 * second])).toBe(2);
  });

  it('does not depend on the order the times come in', () => {
    const times = [20 * minute + second, 0, 10 * minute + second];
    expect(estimateCheckPass(20 * minute, times)).toBe(2);
    expect(estimateCheckPass(20 * minute, [...times].reverse())).toBe(2);
  });
});

// SD3 (Soundtrack): while the run waits on the music script's `make`, the current step says
// "making the music" in place of its count, until the next signal shows the run has moved on.
describe('the music signal', () => {
  const music: ProgressSignal = { type: 'music' };

  it('gives the current step the text "making the music", in place of its count', () => {
    expect(MAKING_MUSIC).toBe('making the music');
    expect(report([file('transcripts/a.json'), music], { sources: 3 })).toEqual({
      step: 2,
      sub: 'making the music',
    });
    expect(report([...UP_TO[5], { type: 'edl', overlays: 2 }, music])).toEqual({
      step: 5,
      sub: 'making the music',
    });
    expect(report([...UP_TO[7], music])).toEqual({ step: 7, sub: 'making the music' });
  });

  it('never moves the step', () => {
    for (const floor of [2, 4, 5, 6, 7] as const) {
      const before = initialProgress({ sources: 1, floor });
      const after = reduceProgress(before, music);
      expect(after).toEqual({ ...before, music: true });
      expect(progressReport(after)).toEqual({ step: before.step, sub: MAKING_MUSIC });
    }
  });

  it('is cleared when the new music shows in edit/preview/, and the count comes back', () => {
    const cut = [...UP_TO[5], { type: 'edl', overlays: 2 } as const];
    for (const change of ['add', 'change'] as const) {
      expect(report([...cut, music, file('preview/music.mp3', change)])).toEqual(report(cut));
    }
    expect(report([...cut, music, file('preview/music.mp3')])).toEqual({
      step: 5,
      sub: 'graphics 0/2',
    });
  });

  it.each([
    ['a file the run writes', file('project.md', 'change')],
    ['a new folder of edit/preview/', file('preview/')],
    ['the EDL', { type: 'edl', overlays: 1 }],
    ['a render', { type: 'render', target: 'preview' }],
    ['a HyperFrames command', { type: 'composition', tool: 'lint' }],
    ['a critic', { type: 'review' }],
    ['a pass estimate', { type: 'pass', n: 2 }],
  ] as [string, ProgressSignal][])('is cleared by %s', (_name, signal) => {
    const making = run([...UP_TO[5], music]);
    expect(making.music).toBe(true);
    const after = reduceProgress(making, signal);
    expect(after.music).toBe(false);
    expect(after).toEqual({ ...reduceProgress(run(UP_TO[5]), signal), music: false });
  });

  it('is not cleared by the music script’s own folder, which it may make as it starts', () => {
    const making = run([...UP_TO[5], music]);
    for (const signal of [file('music/'), file('music/plan.json'), file('music/v1.mp3')]) {
      expect(reduceProgress(making, signal)).toBe(making);
    }
    expect(report([...UP_TO[5], music, file('music/')])).toEqual({ step: 5, sub: MAKING_MUSIC });
    // A file whose name only starts like the folder is the run's own.
    expect(reduceProgress(making, file('music-notes.md')).music).toBe(false);
  });

  it('says it again for a second make, and a repeat changes nothing', () => {
    const making = run([...UP_TO[5], music]);
    expect(reduceProgress(making, music)).toBe(making);
    expect(report([...UP_TO[5], music, file('project.md', 'change'), music])).toEqual({
      step: 5,
      sub: MAKING_MUSIC,
    });
  });

  it('leaves every other signal as it was while no music is being made', () => {
    const before = run(UP_TO[5]);
    expect(before.music).toBe(false);
    expect(reduceProgress(before, file('music/'))).toBe(before);
    expect(reduceProgress(before, file('preview/music.mp3'))).toBe(before);
  });

  it('works the same in a run that ends in Review', () => {
    const preview = { finish: 'preview' as const };
    expect(report([...UP_TO[5], music], preview)).toEqual({ step: 5, sub: MAKING_MUSIC });
    expect(report([...UP_TO[5], music, file('preview/index.html')], preview)).toEqual({
      step: 6,
      sub: null,
    });
  });
});
