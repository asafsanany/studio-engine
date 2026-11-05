import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, StepId } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRunner, type TrackedRun } from './claude-runner.js';
import { FakeRunner } from './fake-runner.js';
import { createProgressTracker, type ProgressRun, startProgressTracker } from './progress.js';
import type { RunContext, RunMode } from './runner.js';
import type { StreamEvent } from './stream-parser.js';

// The tracker: files and stream in, `progress(step, sub)` out, only on change, never backwards,
// quiet once the run is over.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

let root: string;
let jobDir: string;
let editDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-tracker-'));
  jobDir = join(root, 'inbox', 'Acme Studio', 'Launch teaser');
  editDir = join(jobDir, 'edit');
  mkdirSync(jobDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'e4e4e4e4e4e4',
    clientId: '853479772be4',
    client: 'Acme Studio',
    name: 'Launch teaser',
    relPath: 'Acme Studio/Launch teaser',
    state: 'editing',
    step: 1,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 2, audio: 1, image: 3, doc: 0 },
    sizeBytes: 1,
    addedAt: '2026-10-20T10:00:00.000Z',
    lastChangeAt: '2026-10-20T10:00:00.000Z',
    settledAt: '2026-10-20T10:01:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-20T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

function put(path: string, content = 'x', at?: number): void {
  const full = join(editDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (at !== undefined) utimesSync(full, at, at);
}

const bash = (command: string): StreamEvent => ({
  kind: 'tool_use',
  raw: {},
  parentToolUseId: null,
  id: 'toolu_1',
  name: 'Bash',
  input: { command },
});

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A tracker on a run of `job`, with a long poll interval: tests look by stopping it. */
function track(
  mode: RunMode,
  job = makeJob(),
  controller = new AbortController(),
  transcribeTotal?: number,
) {
  const calls: [StepId, string | null][] = [];
  const logger = recordingLogger();
  const run: ProgressRun = {
    job,
    mode,
    editDir,
    signal: controller.signal,
    progress: (step, sub) => calls.push([step, sub ?? null]),
    ...(transcribeTotal === undefined ? {} : { transcribeTotal }),
  };
  const tracker = startProgressTracker(run, { logger, pollIntervalMs: 60_000 });
  return { tracker, calls, logger, controller };
}

describe('a fresh run', () => {
  it('says how many sources there are to transcribe, right away', () => {
    const { calls } = track('start');
    expect(calls).toEqual([[2, '0/3']]);
  });

  it('reports a count that moved, once, when the files are looked at', async () => {
    const { tracker, calls } = track('start');
    await tracker.ready;

    put('transcripts/a.json');
    put('transcripts/b.json');
    await tracker.stop();

    expect(calls).toEqual([
      [2, '0/3'],
      [2, '2/3'],
    ]);
  });

  // CVP-134: B8's job had 5 videos (one of them ignored) and 2 voice notes, and showed Transcribe
  // 4/7 for ever. With a brief the worker hands over the footage count.
  it('counts toward the brief’s footage files, from 0/4 to 4/4, when the worker hands them over', async () => {
    const job = makeJob({ inputs: { video: 5, audio: 2, image: 0, doc: 0 } });
    const { tracker, calls } = track('start', job, new AbortController(), 4);
    expect(calls).toEqual([[2, '0/4']]);
    await tracker.ready;

    put('transcripts/clip-1.json');
    put('transcripts/clip-2.json');
    put('transcripts/clip-3.json');
    put('transcripts/clip-4.json');
    await tracker.stop();

    expect(calls).toEqual([
      [2, '0/4'],
      [2, '4/4'],
    ]);
  });

  it('still shows a sane number when the run transcribes more than the brief counted', async () => {
    const { tracker, calls } = track('start', makeJob(), new AbortController(), 1);
    await tracker.ready;

    put('transcripts/a.json');
    put('transcripts/b.json');
    await tracker.stop();

    expect(calls).toEqual([
      [2, '0/1'],
      [2, '2/2'],
    ]);
  });

  it('counts a brief with no footage as nothing to show, not as the job’s audio and video', () => {
    const { calls } = track('start', makeJob(), new AbortController(), 0);
    expect(calls).toEqual([[2, null]]);
  });

  it('counts the job’s audio and video files when no brief count is handed over, as before', async () => {
    const job = makeJob({ inputs: { video: 5, audio: 2, image: 0, doc: 0 } });
    const { tracker, calls } = track('start', job);
    await tracker.ready;

    put('transcripts/a.json');
    await tracker.stop();

    expect(calls).toEqual([
      [2, '0/7'],
      [2, '1/7'],
    ]);
  });

  it('goes through steps 2 to 8 as a run writes its files and starts its renders', async () => {
    const calls: [StepId, string | null][] = [];
    const tracker = startProgressTracker(
      {
        job: makeJob({ inputs: { video: 2, audio: 0, image: 0, doc: 0 } }),
        mode: 'start',
        editDir,
        signal: new AbortController().signal,
        progress: (step, sub) => calls.push([step, sub ?? null]),
      },
      { pollIntervalMs: 10 },
    );
    const reported = async (step: StepId, sub: string | null): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const last = calls.at(-1);
        if (last?.[0] === step && last[1] === sub) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`never reported ${step} ${sub}; got ${JSON.stringify(calls)}`);
    };
    await tracker.ready;

    put('transcripts/a.json');
    await reported(2, '1/2');
    put('transcripts/b.json');
    put('takes_packed.md');
    await reported(3, null);
    put('project.md');
    await reported(4, null);
    put('animations/slot_1/index.html');
    put('animations/slot_2/index.html');
    await reported(5, 'graphics 0/2');
    put('animations/slot_1/render.mov');
    await reported(5, 'graphics 1/2');
    tracker.onEvent(
      bash('$P ~/Developer/video-use/helpers/render.py edl.json -o preview.mp4 --preview'),
    );
    await reported(6, null);
    put('preview.mp4');
    put('verify/p_1.0.jpg');
    await reported(7, 'pass 1/3');
    tracker.onEvent(bash('$P render.py edl.json -o preview.mp4 --preview'));
    await reported(7, 'pass 2/3');
    tracker.onEvent(bash('$P render.py edl.json -o final.mp4'));
    await reported(8, null);
    put('animations/slot_2/render.mov'); // a fix after the final: stays at Render
    await tracker.stop();

    const steps = calls.map(([step]) => step);
    expect([...new Set(steps)]).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(calls.at(-1)).toEqual([8, null]);
  });

  it('leaves a workspace from an earlier edit out of a fresh run', async () => {
    put('takes_packed.md', 'old', 1_000);
    put('final.mp4', 'old', 1_000);
    const { tracker, calls } = track('start');
    await tracker.stop();
    expect(calls).toEqual([[2, '0/3']]);
  });

  it('logs each new step with what caused it', async () => {
    const { tracker, logger } = track('start');
    await tracker.ready;
    tracker.onEvent(bash('python render.py edl.json -o final.mp4'));
    await tracker.stop();
    expect(logger.info).toHaveBeenCalledWith(
      { jobId: 'e4e4e4e4e4e4', step: 8, sub: null, cause: 'final render started' },
      'edit progress',
    );
  });
});

describe('a resumed or retried run', () => {
  it('carries on from what edit/ already holds, never below the job step', async () => {
    put('transcripts/a.json', '{}', 1_000);
    put('takes_packed.md', 'x', 2_000);
    put('project.md', 'x', 3_000);
    put('animations/slot_1/render.mov', 'x', 4_000);
    put('animations/slot_2/index.html', 'x', 5_000);
    const { tracker, calls } = track('resume', makeJob({ step: 5, subProgress: null }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([[5, 'graphics 1/2']]);
  });

  it('carries on at Transcribe for a job that is at Brief: the edit run never reports step 1', async () => {
    const { tracker, calls } = track('retry', makeJob({ step: 1, subProgress: null }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([[2, '0/3']]);
    expect(tracker.state).toMatchObject({ floor: 2, step: 2 });
  });

  it('replays edit/ for a job that fell back to Brief, and jumps to the step the work reached (CVP-132)', async () => {
    // The edit got to Cut; then a fresh brief failed and the job dropped to step 1.
    put('brief.json', '{}', 500);
    put('transcripts/a.json', '{}', 1_000);
    put('takes_packed.md', 'x', 2_000);
    put('project.md', 'x', 3_000);
    put('edl.json', '{"overlays":[{},{}]}', 4_000);
    put('animations/slot_1/render.mov', 'x', 5_000);
    put('animations/slot_2/index.html', 'x', 6_000);
    for (const mode of ['retry', 'resume'] as const) {
      const { tracker, calls } = track(mode, makeJob({ step: 1, subProgress: null }));
      await tracker.ready;
      await tracker.stop();
      expect(calls).toEqual([[5, 'graphics 1/2']]);
      expect(tracker.state).toMatchObject({ floor: 2, step: 5 });
    }
  });

  it('does not repeat what the job already shows', async () => {
    put('takes_packed.md', 'x', 2_000);
    const { tracker, calls } = track('retry', makeJob({ step: 3, subProgress: null }));
    await tracker.stop();
    expect(calls).toEqual([]);
  });

  it('stays at the failed step even when the files say less', async () => {
    put('transcripts/a.json');
    const { tracker, calls } = track('retry', makeJob({ step: 6, subProgress: null }));
    await tracker.stop();
    expect(calls).toEqual([]);
    expect(tracker.state.step).toBe(6);
  });

  it('carries on the self-check pass of a run stopped at Check', async () => {
    put('preview.mp4', 'x', 1_000);
    put('verify/a.jpg', 'x', 2_000);
    const { tracker, calls } = track('resume', makeJob({ step: 7, subProgress: 'pass 2/3' }));
    await tracker.ready;
    tracker.onEvent(bash('$P render.py edl.json -o preview.mp4 --preview'));
    await tracker.stop();
    expect(calls).toEqual([[7, 'pass 3/3']]);
  });
});

// CVP-138: every START, RESUME and RETRY clears the job's `pass n/3`, and a job that fell back to
// Brief has lost it for good, so a replay that lands at Check works the pass out from the frames
// in verify/ and the time of the last preview render.
describe('the self-check pass of a replay (CVP-138)', () => {
  /** What an edit that got to its second self-check leaves: times are seconds, as `put` takes. */
  function putSecondCheck(): void {
    put('brief.json', '{}', 50);
    put('transcripts/a.json', '{}', 100);
    put('takes_packed.md', 'x', 110);
    put('project.md', 'x', 120);
    put('verify/src_full.png', 'x', 130);
    put('edl.json', '{"overlays":[]}', 140);
    put('preview.mp4', 'first render', 600);
    put('verify/p_0.9.jpg', 'x', 601);
    put('verify/p_3.6.jpg', 'x', 603);
    // The fix, and the preview rendered again; the frames of the second check.
    put('preview.mp4', 'second render', 1_000);
    put('verify/g_0.9.jpg', 'x', 1_001);
  }

  it('a job back at Brief, whose edit was in its second check, shows Check · pass 2/3', async () => {
    putSecondCheck();
    for (const mode of ['retry', 'resume'] as const) {
      const { tracker, calls } = track(mode, makeJob({ step: 1, subProgress: null }));
      await tracker.ready;
      await tracker.stop();
      expect(calls).toEqual([[7, 'pass 2/3']]);
      expect(tracker.state).toMatchObject({ step: 7, pass: 2 });
    }
  });

  it('a job stopped at Check, whose pass was cleared when it was resumed, gets it back', async () => {
    putSecondCheck();
    const { tracker, calls } = track('resume', makeJob({ step: 7, subProgress: null }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([[7, 'pass 2/3']]);
  });

  it('a first check still shows pass 1/3', async () => {
    put('takes_packed.md', 'x', 110);
    put('project.md', 'x', 120);
    put('verify/src_full.png', 'x', 130);
    put('edl.json', '{"overlays":[]}', 140);
    put('preview.mp4', 'first render', 600);
    put('verify/p_0.9.jpg', 'x', 601);
    const { tracker, calls } = track('retry', makeJob({ step: 1, subProgress: null }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([[7, 'pass 1/3']]);
  });

  it('never lowers the pass the job still shows', async () => {
    putSecondCheck();
    const { tracker, calls } = track('resume', makeJob({ step: 7, subProgress: 'pass 3/3' }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([]);
    expect(tracker.state).toMatchObject({ step: 7, pass: 3 });
  });

  it('goes on counting from the estimate: the next preview render is the next pass', async () => {
    putSecondCheck();
    const { tracker, calls } = track('retry', makeJob({ step: 1, subProgress: null }));
    await tracker.ready;
    tracker.onEvent(bash('$P render.py edl.json -o preview.mp4 --preview'));
    await tracker.stop();
    expect(calls).toEqual([
      [7, 'pass 2/3'],
      [7, 'pass 3/3'],
    ]);
  });

  it('adds nothing for a replay that is not at Check', async () => {
    putSecondCheck();
    put('final.mp4', 'x', 1_100);
    const { tracker, calls } = track('retry', makeJob({ step: 1, subProgress: null }));
    await tracker.ready;
    await tracker.stop();
    expect(calls).toEqual([[8, null]]);
  });
});

describe('when the run ends', () => {
  it('takes a last look when the process has exited', async () => {
    const { tracker, calls } = track('resume', makeJob({ step: 7, subProgress: 'pass 1/3' }));
    await tracker.ready;
    put('final.mp4');
    await tracker.stop();
    expect(calls).toEqual([[8, null]]);
  });

  it('reports nothing more once it was stopped', async () => {
    const { tracker, calls } = track('start');
    await tracker.stop();
    tracker.onEvent(bash('python render.py edl.json -o final.mp4'));
    expect(calls).toEqual([[2, '0/3']]);
  });

  it('stops looking when the run is aborted, without a last look', async () => {
    const { tracker, calls, controller } = track('start');
    await tracker.ready;
    controller.abort();
    put('final.mp4');
    await tracker.stop();
    tracker.onEvent(bash('python render.py edl.json -o final.mp4'));
    expect(calls).toEqual([[2, '0/3']]);
  });

  it('works on a run aborted before it started', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tracker } = track('start', makeJob(), controller);
    await expect(tracker.stop()).resolves.toBeUndefined();
  });
});

describe('never breaks the run', () => {
  it('survives a progress callback that throws', async () => {
    const logger = recordingLogger();
    const tracker = startProgressTracker(
      {
        job: makeJob(),
        mode: 'start',
        editDir,
        signal: new AbortController().signal,
        progress: () => {
          throw new Error('worker hiccup');
        },
      },
      { logger, pollIntervalMs: 60_000 },
    );
    expect(() => tracker.onEvent(bash('python render.py e.json -o final.mp4'))).not.toThrow();
    await tracker.stop();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'e4e4e4e4e4e4' }),
      'progress callback threw',
    );
  });

  it('ignores events it does not understand', () => {
    const { tracker } = track('start');
    const odd = { kind: 'tool_use', name: 'Bash', input: null } as unknown as StreamEvent;
    expect(() => tracker.onEvent(odd)).not.toThrow();
    expect(() => tracker.onEvent({ kind: 'unparsed', line: '?', raw: null })).not.toThrow();
  });
});

// W2: a run that ends in Review finishes as a live composition in edit/preview/; its Preview and
// Check read that composition. A run without `finish` reads what it always did.
describe("a run that ends in Review (finish: 'preview')", () => {
  function trackPreview(finish: 'preview' | 'final' | undefined, job = makeJob({ step: 5 })) {
    const calls: [StepId, string | null][] = [];
    const run: ProgressRun = {
      job,
      mode: 'resume',
      editDir,
      signal: new AbortController().signal,
      progress: (step, sub) => calls.push([step, sub ?? null]),
      ...(finish === undefined ? {} : { finish }),
    };
    return { tracker: startProgressTracker(run, { pollIntervalMs: 60_000 }), calls };
  }

  it('reports Preview (6) when index.html is written (cut.mp4 beside it adds nothing)', async () => {
    const { tracker, calls } = trackPreview('preview');
    await tracker.ready;
    expect(calls).toEqual([]);

    put('preview/index.html', '<html></html>');
    put('preview/cut.mp4');
    await tracker.stop();
    expect(calls).toEqual([[6, null]]);
  });

  it('moves to Check (7) on a hyperframes lint from the stream', async () => {
    const { tracker, calls } = trackPreview('preview');
    await tracker.ready;
    put('preview/index.html');
    // The files are looked at when the tracker's next poll or stop comes; the stream is at once.
    tracker.onEvent(bash('cd edit/preview && npx hyperframes snapshot --at 1,2'));
    tracker.onEvent(bash('cd edit/preview && npx hyperframes lint'));
    await tracker.stop();

    expect(calls).toEqual([
      [6, null],
      [7, 'pass 1/3'],
    ]);
  });

  it('reports Preview (6) from a hyperframes snapshot before any file shows', async () => {
    const { tracker, calls } = trackPreview('preview');
    await tracker.ready;
    tracker.onEvent(bash('npx hyperframes snapshot --at 1'));
    expect(calls).toEqual([[6, null]]);
    await tracker.stop();
  });

  it('ignores a final render and final.mp4: it never reaches Render (8)', async () => {
    const { tracker, calls } = trackPreview(
      'preview',
      makeJob({ step: 7, subProgress: 'pass 1/3' }),
    );
    await tracker.ready;
    tracker.onEvent(bash('npx hyperframes render -q delivery -o ../final.mp4'));
    put('final.mp4');
    await tracker.stop();
    expect(calls.every(([step]) => step <= 7)).toBe(true);
  });

  it('reads nothing of this from a run without finish, or with finish: final', async () => {
    for (const finish of [undefined, 'final'] as const) {
      const { tracker, calls } = trackPreview(finish);
      await tracker.ready;
      put('preview/index.html');
      tracker.onEvent(bash('npx hyperframes snapshot --at 1'));
      tracker.onEvent(bash('npx hyperframes lint'));
      await tracker.stop();
      expect(calls, String(finish)).toEqual([]);
      rmSync(editDir, { recursive: true, force: true });
    }
  });

  it('follows a fake runner run with the switch on through steps 2 to 7, as the files show them', async () => {
    writeFileSync(join(jobDir, 'a.mp4'), 'video');
    writeFileSync(join(jobDir, 'b.mov'), 'video');
    const job = makeJob({ inputs: { video: 2, audio: 0, image: 0, doc: 0 } });
    const calls: [StepId, string | null][] = [];
    const controller = new AbortController();
    const context: RunContext = {
      signal: controller.signal,
      progress: (step, sub) => calls.push([step, sub ?? null]),
    };
    const tracker = startProgressTracker(
      {
        job,
        mode: 'start',
        editDir,
        signal: controller.signal,
        progress: context.progress,
        finish: 'preview',
      },
      { pollIntervalMs: 5 },
    );
    await tracker.ready;
    const runner = new FakeRunner({
      inboxPath: join(root, 'inbox'),
      reportProgress: false,
      clipSeconds: 0.5,
      review: true,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 100)),
    });

    const outcome = await runner.start(job, 'start', context);
    await tracker.stop();

    expect(outcome).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
    expect(calls).toEqual([
      [2, '0/2'],
      [2, '1/2'],
      [2, '2/2'],
      [3, null],
      [4, null],
      [5, 'graphics 0/3'],
      [5, 'graphics 1/3'],
      [5, 'graphics 2/3'],
      [5, 'graphics 3/3'],
      [6, null],
      [7, 'pass 1/3'],
    ]);
  });
});

// W3 (CVP-110): a revise run starts at Plan (4) over the previous round's files, a render run at
// Render (8). The floor is the job's step, which START gave it by the kind of run.
describe('revise and render runs', () => {
  /** What the edit and the round before leave in edit/: the composition, frames, a final.mp4. */
  function previousRound(): void {
    put('transcripts/a.json', '{}', 1_000);
    put('takes_packed.md', 'x', 2_000);
    put('project.md', 'x', 3_000);
    put('edl.json', '{"overlays":[]}', 4_000);
    put('preview/index.html', '<html></html>', 5_000);
    put('preview/cut.mp4', 'x', 5_000);
    put('verify/x.jpg', 'x', 6_000);
    put('final.mp4', 'x', 7_000);
  }

  function trackRun(
    job: Job,
    mode: RunMode,
    finish: 'preview' | 'final' | undefined,
    controller = new AbortController(),
  ) {
    const calls: [StepId, string | null][] = [];
    const run: ProgressRun = {
      job,
      mode,
      editDir,
      signal: controller.signal,
      progress: (step, sub) => calls.push([step, sub ?? null]),
      ...(finish === undefined ? {} : { finish }),
    };
    return { tracker: startProgressTracker(run, { pollIntervalMs: 60_000 }), calls };
  }

  const reviseJob = (overrides: Partial<Job> = {}) =>
    makeJob({ runKind: 'revise', round: 1, step: 4, ...overrides });

  describe('a revise run', () => {
    it.each(['start', 'resume', 'retry'] as const)(
      '(%s) counts only what it writes: the earlier round’s files leave it at Plan (4)',
      async (mode) => {
        previousRound();
        const { tracker, calls } = trackRun(reviseJob(), mode, 'preview');
        await tracker.ready;
        expect(calls).toEqual([]);
        expect(tracker.state).toMatchObject({ floor: 4, step: 4 });
        // The look at stop() finds nothing new either.
        await tracker.stop();
        expect(calls).toEqual([]);
      },
    );

    it('reports Preview (6) once it rewrites the composition', async () => {
      previousRound();
      const { tracker, calls } = trackRun(reviseJob(), 'start', 'preview');
      await tracker.ready;

      put('preview/index.html', '<html><body>round 1</body></html>', 9_000);
      await tracker.stop();

      expect(calls).toEqual([[6, null]]);
    });

    it('the same for a resumed run: Preview (6) from its own writes, not from the files already there', async () => {
      previousRound();
      const { tracker, calls } = trackRun(reviseJob({ step: 5 }), 'resume', 'preview');
      await tracker.ready;
      expect(calls).toEqual([]);

      put('preview/index.html', '<html><body>round 1</body></html>', 9_000);
      await tracker.stop();
      expect(calls).toEqual([[6, null]]);
    });

    it('never reports a step above Check (7), not even for a final.mp4 or a render command', async () => {
      previousRound();
      const { tracker, calls } = trackRun(reviseJob({ step: 6 }), 'start', 'preview');
      await tracker.ready;
      tracker.onEvent(bash('npx hyperframes lint'));
      tracker.onEvent(bash('npx hyperframes render -q delivery -o ../final.mp4'));
      put('final.mp4', 'a new video', 9_000);
      await tracker.stop();
      expect(calls.every(([step]) => step <= 7)).toBe(true);
      expect(calls[0]).toEqual([7, 'pass 1/3']);
    });

    it('an edit run resumed over the same files still replays them, as today', async () => {
      previousRound();
      const { tracker, calls } = trackRun(
        makeJob({ runKind: 'edit', step: 4 }),
        'resume',
        'preview',
      );
      await tracker.ready;
      await tracker.stop();
      expect(calls).toEqual([[7, 'pass 1/3']]);
    });
  });

  describe('a render run', () => {
    const renderJob = (overrides: Partial<Job> = {}) =>
      makeJob({ runKind: 'render', round: 1, step: 8, ...overrides });

    it.each(['start', 'resume', 'retry'] as const)(
      '(%s) is at Render (8) and reports nothing below it',
      async (mode) => {
        previousRound();
        const { tracker, calls } = trackRun(renderJob(), mode, undefined);
        await tracker.ready;
        tracker.onEvent(bash('npx hyperframes render -q delivery --strict -o ../final.mp4'));
        put('final.mp4', 'the render', 9_000);
        await tracker.stop();

        expect(calls).toEqual([]);
        expect(tracker.state).toMatchObject({ floor: 8, step: 8 });
      },
    );

    it('is at Render (8) even when the files say less', async () => {
      const { tracker, calls } = trackRun(renderJob(), 'start', undefined);
      await tracker.ready;
      put('transcripts/a.json');
      put('takes_packed.md');
      await tracker.stop();
      expect(calls).toEqual([]);
      expect(tracker.state.step).toBe(8);
    });
  });
});

describe('from the files alone (no stream)', () => {
  it('follows a fake runner run (E7) through steps 2 to 8, as the files show them', async () => {
    writeFileSync(join(jobDir, 'a.mp4'), 'video');
    writeFileSync(join(jobDir, 'b.mov'), 'video');
    const job = makeJob({ inputs: { video: 2, audio: 0, image: 0, doc: 0 } });
    const calls: [StepId, string | null][] = [];
    const controller = new AbortController();
    const context: RunContext = {
      signal: controller.signal,
      progress: (step, sub) => calls.push([step, sub ?? null]),
    };
    const tracker = startProgressTracker(
      { job, mode: 'start', editDir, signal: controller.signal, progress: context.progress },
      { pollIntervalMs: 5 },
    );
    await tracker.ready;
    // Each fake pause is long enough for a few looks, so every state of edit/ is seen.
    const runner = new FakeRunner({
      inboxPath: join(root, 'inbox'),
      reportProgress: false,
      clipSeconds: 0.5,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 100)),
    });

    const outcome = await runner.start(job, 'start', context);
    await tracker.stop();

    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual([
      [2, '0/2'],
      [2, '1/2'],
      [2, '2/2'],
      [3, null],
      [4, null],
      [5, 'graphics 0/3'],
      [5, 'graphics 1/3'],
      [5, 'graphics 2/3'],
      [5, 'graphics 3/3'],
      [6, null],
      // The fake writes three check frames without rendering again in between: one real pass.
      // (It reports "pass n/3" itself, which is why it keeps doing its own reporting.)
      [7, 'pass 1/3'],
      [8, null],
    ]);
  });
});

describe('createProgressTracker, as the Claude runner track hook', () => {
  it('reports the E1 run from its stream and files, ending at Render', async () => {
    const claudeBin = join(root, 'bin', 'claude');
    mkdirSync(dirname(claudeBin), { recursive: true });
    copyFileSync(STUB, claudeBin);
    chmodSync(claudeBin, 0o755);
    writeFileSync(
      join(jobDir, 'stub-claude.json'),
      JSON.stringify({ replay: `${FIXTURES}sample-run.jsonl`, writeFinal: true }),
    );
    const hook = createProgressTracker({ pollIntervalMs: 20 });
    const tracked: TrackedRun[] = [];
    const runner = new ClaudeRunner({
      config: {
        inboxPath: join(root, 'inbox'),
        logsDir: join(root, 'data', 'logs'),
        dataDir: join(root, 'data'),
        claudeBin,
        model: 'opus',
        runTimeoutMin: 90,
      },
      home: join(root, 'home'),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      killGraceMs: 2_000,
      sampleIntervalMs: 50,
      track: (run) => {
        tracked.push(run);
        return hook(run);
      },
    });
    const calls: [StepId, string | null][] = [];
    const ctx: RunContext = {
      signal: new AbortController().signal,
      progress: (step, sub) => calls.push([step, sub ?? null]),
    };

    const outcome = await runner.start(
      makeJob({ inputs: { video: 1, audio: 0, image: 0, doc: 0 } }),
      'start',
      ctx,
    );

    expect(outcome).toEqual({ ok: true });
    expect(tracked).toHaveLength(1);
    // The stub writes final.mp4 as it starts, so whether the files or the stream's preview render
    // come first is a race; either way the step only goes up and ends at Render.
    const steps = calls.map(([step]) => step);
    expect(calls[0]).toEqual([2, '0/1']);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(calls.at(-1)).toEqual([8, null]);
  });
});
