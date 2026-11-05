import { describe, expect, it } from 'vitest';
import { StepProgress, segmentStates } from './StepProgress';
import { render } from './test-helpers';

const text = (html: string) => html.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|');
const segments = (html: string) =>
  [...html.matchAll(/data-segment="(\w+)"/g)].map((match) => match[1]);

describe('segmentStates', () => {
  it('has eight segments: steps before the current one done, the current one, the rest pending', () => {
    expect(segmentStates(1)).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(segmentStates(5)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'pending',
      'pending',
      'pending',
    ]);
    expect(segmentStates(8)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'current',
    ]);
  });

  it('shows a job at Transcribe with the first segment (Brief) done', () => {
    expect(segmentStates(2)).toEqual([
      'done',
      'current',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('is all pending without a step', () => {
    expect(segmentStates(null)).toEqual(Array(8).fill('pending'));
  });
});

describe('<StepProgress>', () => {
  it('draws the segments in editing blue, blue at 40% and pending grey', () => {
    const html = render(
      <StepProgress
        job={{ step: 5, subProgress: 'graphics 2/5', etaSec: 240, runKind: 'edit', round: 0 }}
      />,
    );
    expect(segments(html)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'pending',
      'pending',
      'pending',
    ]);
    expect(html.match(/bg-status-editing"/g)).toHaveLength(4);
    expect(html.match(/bg-status-editing\/40/g)).toHaveLength(1);
    expect(html.match(/bg-step-pending/g)).toHaveLength(3);
    // 6 px tall, 3 px gap, radius 3.
    expect(html).toContain('h-1.5 flex-1 rounded-[3px]');
    expect(html).toContain('gap-[3px]');
  });

  it('shows the step and sub-count on the left and the time left on the right', () => {
    const html = render(
      <StepProgress
        job={{ step: 5, subProgress: 'graphics 2/5', etaSec: 240, runKind: 'edit', round: 0 }}
      />,
    );
    expect(text(html)).toBe('|Cut · graphics 2/5|~4 min left|');
    expect(html).toContain('font-medium">Cut · graphics 2/5');
  });

  it('shows the three sample rows from the board', () => {
    const row = (step: 2 | 7, subProgress: string, etaSec: number) =>
      text(render(<StepProgress job={{ step, subProgress, etaSec, runKind: 'edit', round: 0 }} />));
    expect(row(2, '6/14', 540)).toBe('|Transcribe · 6/14|~9 min left|');
    expect(row(7, 'pass 2/3', 120)).toBe('|Check · pass 2/3|~2 min left|');
  });

  it('keeps the right-hand slot, empty, when there is no estimate', () => {
    const html = render(
      <StepProgress
        job={{ step: 8, subProgress: null, etaSec: null, runKind: 'edit', round: 0 }}
      />,
    );
    expect(text(html)).toBe('|Render|');
    expect(html).toContain('<span class="shrink-0 text-muted-foreground"></span>');
    expect(segments(html)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'current',
    ]);
  });

  it('says "< 1 min left" for under a minute', () => {
    const html = render(
      <StepProgress job={{ step: 8, subProgress: null, etaSec: 20, runKind: 'edit', round: 0 }} />,
    );
    expect(text(html)).toBe('|Render|&lt; 1 min left|');
  });

  it('hides the bar from assistive technology; the text row carries the meaning', () => {
    const html = render(
      <StepProgress
        job={{ step: 3, subProgress: null, etaSec: null, runKind: 'edit', round: 0 }}
      />,
    );
    expect(html).toContain('<div aria-hidden="true" class="flex gap-[3px]">');
  });

  it('shows the round and the time left on a revise row, with the bar at Cut', () => {
    const html = render(
      <StepProgress
        job={{ step: 5, subProgress: 'graphics 2/5', etaSec: 240, runKind: 'revise', round: 1 }}
      />,
    );
    expect(text(html)).toBe('|Cut · graphics 2/5|round 2 · ~4 min left|');
    expect(segments(html)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('says approved with the time left on the render row, at step 8', () => {
    const html = render(
      <StepProgress
        job={{ step: 8, subProgress: null, etaSec: 180, runKind: 'render', round: 1 }}
      />,
    );
    expect(text(html)).toBe('|Render|approved · ~3 min left|');
    expect(segments(html).at(-1)).toBe('current');
    expect(segments(html).filter((state) => state === 'done')).toHaveLength(7);
  });

  it('keeps the run alone when a revise or render row has no estimate', () => {
    const revise = render(
      <StepProgress
        job={{ step: 4, subProgress: null, etaSec: null, runKind: 'revise', round: 1 }}
      />,
    );
    const renderRun = render(
      <StepProgress
        job={{ step: 8, subProgress: null, etaSec: null, runKind: 'render', round: 1 }}
      />,
    );
    expect(text(revise)).toBe('|Plan|round 2|');
    expect(text(renderRun)).toBe('|Render|approved|');
  });
});
