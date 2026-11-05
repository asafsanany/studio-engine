import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type FileChange,
  initialProgress,
  type ProgressSignal,
  progressReport,
  reduceProgress,
} from './progress-reducer.js';
import { signalsFromStreamEvent } from './progress-signals.js';
import { parseStreamLine, type StreamEvent } from './stream-parser.js';

// Acceptance for E4: replaying E1's real runs (fixtures/stream/) through the signal extractors and
// the reducer. The stream's assistant/user lines carry timestamps; the tree file says when each
// file appeared in edit/ (polled every 500 ms during the run). Merged by time, they are what the
// tracker sees live, minus the poll delay.

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

interface Input {
  at: number;
  what: string;
  signals: ProgressSignal[];
}

/** Stream events, timed by the last timestamp seen (system events have none). */
function streamInputs(name: string): Input[] {
  const inputs: Input[] = [];
  let at = Number.NEGATIVE_INFINITY;
  readFileSync(`${FIXTURES}${name}`, 'utf8')
    .split('\n')
    .forEach((text, line) => {
      for (const event of parseStreamLine(text)) {
        const stamp = event.raw?.timestamp;
        if (typeof stamp === 'string') at = Date.parse(stamp);
        const signals = signalsFromStreamEvent(event);
        if (signals.length > 0) inputs.push({ at, what: `stream line ${line}`, signals });
      }
    });
  return inputs;
}

const CHANGES: Record<string, FileChange> = { '+': 'add', '~': 'change', '-': 'unlink' };

/**
 * File events from section 1 of a tree file. There `~` means "size settled": the first `~` after
 * a `+` is that same write noticed a tick later (the tracker's poll sees no change then), every
 * later `~` is a rewrite. edl.json's content is not in the fixture; how many overlays it places
 * comes from the commands that wrote it (stream line 61's heredoc places slot_1, line 87 appends
 * slot_captions, line 202 only moves timings), keyed by its size.
 */
function treeInputs(name: string, edlOverlaysBySize: Record<number, number> = {}): Input[] {
  const inputs: Input[] = [];
  const settling = new Set<string>();
  for (const line of readFileSync(`${FIXTURES}${name}`, 'utf8').split('\n')) {
    const match = /^(\S+Z)\s+([+~-])\s+edit\/(\S+)(?:\s+(\d+))?/.exec(line);
    if (match === null) continue;
    const [, stamp, mark, path, size] = match as unknown as [
      string,
      string,
      string,
      string,
      string?,
    ];
    if (mark === '+') settling.add(path);
    if (mark === '~' && settling.delete(path)) continue;
    const change = CHANGES[mark] as FileChange;
    const signals: ProgressSignal[] = [{ type: 'file', path, change }];
    const overlays = edlOverlaysBySize[Number(size)];
    if (path === 'edl.json' && overlays !== undefined) signals.push({ type: 'edl', overlays });
    inputs.push({ at: Date.parse(stamp), what: `${mark} ${path}`, signals });
  }
  return inputs;
}

interface Transition {
  at: string;
  step: number;
  sub: string | null;
  by: string;
}

/** Feeds the inputs in time order and lists every change of what the worker would be told. */
function replay(inputs: Input[], sources: number): Transition[] {
  const ordered = inputs
    .map((input, index) => ({ input, index }))
    .sort((a, b) => a.input.at - b.input.at || a.index - b.index)
    .map(({ input }) => input);

  // A fresh job is at Brief (1) when its edit run starts; the reducer starts that run at Transcribe.
  let state = initialProgress({ floor: 1, sources });
  let last = progressReport(state);
  const transitions: Transition[] = [{ at: 'start', ...last, by: 'start' }];
  for (const input of ordered) {
    for (const signal of input.signals) state = reduceProgress(state, signal);
    const now = progressReport(state);
    if (now.step === last.step && now.sub === last.sub) continue;
    const at = Number.isFinite(input.at) ? new Date(input.at).toISOString().slice(11, 23) : 'start';
    transitions.push({ at, ...now, by: input.what });
    last = now;
  }
  return transitions;
}

describe('replaying the E1 sample run (Acme Studio/Launch teaser, 470 s)', () => {
  const transitions = replay(
    [
      ...streamInputs('sample-run.jsonl'),
      ...treeInputs('sample-run-tree.txt', { 1346: 1, 1550: 2, 1553: 2 }),
    ],
    1,
  );

  it('goes through steps 2 to 8 in order, never back, and never reports Brief', () => {
    const steps = transitions.map((t) => t.step);
    expect([...new Set(steps)]).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('with these sub-counts, at these moments', () => {
    expect(transitions).toEqual([
      { at: 'start', step: 2, sub: '0/1', by: 'start' },
      // Transcript and takes_packed.md land in the same tick (one command does both).
      { at: '14:57:16.025', step: 3, sub: null, by: '+ takes_packed.md' },
      { at: '14:57:59.667', step: 4, sub: null, by: '+ project.md' },
      // The graphic is built before the EDL exists.
      { at: '14:58:07.697', step: 5, sub: null, by: '+ animations/_shared/vendor/gsap.min.js' },
      {
        at: '14:58:08.199',
        step: 5,
        sub: 'graphics 0/1',
        by: '+ animations/slot_1/vendor/gsap.min.js',
      },
      { at: '14:58:46.984', step: 5, sub: 'graphics 1/1', by: '+ animations/slot_1/render.mov' },
      // "Write EDL and render preview". That preview fails (no libass), and the captions slot is
      // built while the step stays at Preview: it never moves back.
      { at: '14:58:54.163', step: 6, sub: null, by: 'stream line 61' },
      // The frames grabbed from the preview the same command rendered.
      { at: '14:59:54.504', step: 7, sub: 'pass 1/3', by: '+ verify/p_0.9.jpg' },
      // "Re-render captions, final render, measure". The critic pass, the graphics re-render and
      // the rebuilt final.mp4 that follow all stay at Render.
      { at: '15:00:19.504', step: 8, sub: null, by: 'stream line 107' },
    ]);
  });
});

describe('replaying the E1 blocked run (ffmpeg and the ElevenLabs key missing)', () => {
  it('stays at Transcribe: the only file, project.md, is written before any transcript', () => {
    const tree = readFileSync(`${FIXTURES}blocked-run-tree.txt`, 'utf8');
    const created = /^(\S+Z)\s+\S+\s+\d+\s+edit\/project\.md$/m.exec(tree);
    expect(created).not.toBeNull();
    const inputs: Input[] = [
      ...streamInputs('blocked-run.jsonl'),
      {
        at: Date.parse((created as RegExpExecArray)[1] as string),
        what: '+ project.md',
        signals: [{ type: 'file', path: 'project.md', change: 'add' }],
      },
    ];
    expect(replay(inputs, 1)).toEqual([{ at: 'start', step: 2, sub: '0/1', by: 'start' }]);
  });
});

describe('replaying a job whose edit makes the base cut with render.py before the graphics (B8)', () => {
  // From B8's acceptance run: render.py makes cut.mp4 two seconds after edl.json, HyperFrames
  // graphics are laid over it, and ffmpeg writes final.mp4 minutes later. The job used to jump to
  // Render at the cut and stay there.
  const bash = (command: string): StreamEvent => ({
    kind: 'tool_use',
    raw: {},
    parentToolUseId: null,
    id: 'toolu_1',
    name: 'Bash',
    input: { command },
  });
  const file = (at: number, path: string): Input => ({
    at,
    what: `+ ${path}`,
    signals: [{ type: 'file', path, change: 'add' }],
  });
  const command = (at: number, text: string): Input => ({
    at,
    what: `command at ${at}`,
    signals: signalsFromStreamEvent(bash(text)),
  });

  it('stays at Cut until final.mp4 shows, and goes straight to Render then', () => {
    const transitions = replay(
      [
        file(1, 'takes_packed.md'),
        file(2, 'project.md'),
        file(3, 'edl.json'),
        command(
          4,
          '~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/render.py edl.json -o cut.mp4 --no-subtitles --no-loudnorm 2>&1 | tail -5',
        ),
        file(5, 'cut.mp4'),
        command(
          6,
          'cd animations/slot_gfx && npx --yes hyperframes render --format mov -o render.mov',
        ),
        file(7, 'animations/slot_gfx/render.mov'),
        command(
          8,
          'ffmpeg -v error -y -i cut.mp4 -i vertical.mov -filter_complex overlay final.mp4',
        ),
        file(9, 'final.mp4'),
      ],
      1,
    );
    expect(transitions.map((t) => [t.step, t.sub, t.by])).toEqual([
      [2, '0/1', 'start'],
      [3, null, '+ takes_packed.md'],
      [4, null, '+ project.md'],
      [5, null, '+ edl.json'],
      // The cut (command at 4, cut.mp4 at 5) changed nothing: still Cut, now counting the graphics.
      [5, 'graphics 1/1', '+ animations/slot_gfx/render.mov'],
      [8, null, '+ final.mp4'],
    ]);
  });
});
