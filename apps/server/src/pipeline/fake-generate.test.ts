import { generatePlanSchema } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { fakePlan, parseInjectedFailure } from './fake-generate.js';

// The fake Generate run's small parts (Generated videos, GN5). The run itself is exercised through
// the step (generate-step.test.ts) and the worker (worker.generate.test.ts).

describe('fakePlan', () => {
  const brief = {
    voiceover: {
      lines: ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.'].map((text, index) => ({
        id: `L${index + 1}`,
        text,
        direction: index === 1 ? 'a stop after BUT' : null,
      })),
    },
  };

  it('is a plan the contract reads: the brief’s lines word for word, a cast of three, six clips', () => {
    const plan = fakePlan(brief);

    expect(generatePlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.voice).toEqual(brief.voiceover.lines);
    expect(plan.cast.map((cast) => cast.id)).toEqual(['homeowner', 'technician', 'hero-skylight']);
    expect(plan.clips.map((clip) => clip.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    // Only the tilt-up lands on an end frame: seven keyframes for six clips, like the board.
    expect(plan.clips.filter((clip) => clip.end !== null).map((clip) => clip.id)).toEqual(['E']);
  });

  it('spreads the clips over the voice with no gap and no overlap', () => {
    const plan = fakePlan(brief);
    const windows = plan.clips.flatMap((clip) => clip.covers);
    expect(windows[0]?.startSec).toBe(0);
    for (const [index, window] of windows.entries()) {
      expect(window.endSec).toBeGreaterThan(window.startSec);
      if (index > 0) expect(window.startSec).toBe(windows[index - 1]?.endSec);
    }
    // 7 lines of a second each are 7 seconds of voice.
    expect(windows.at(-1)?.endSec).toBeCloseTo(7, 2);
  });

  it('makes stand-in lines for a brief with no script', () => {
    const plan = fakePlan({ voiceover: null });
    expect(plan.voice).toHaveLength(3);
    expect(generatePlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe('the .fail-at-generate marker', () => {
  it('is an empty file for an empty Higgsfield balance at once', () => {
    expect(parseInjectedFailure('')).toEqual({ code: 'balance_empty', after: 0, service: 'shots' });
  });

  it('reads the error code, how many requests succeed first, and the voice service', () => {
    expect(parseInjectedFailure('key_rejected')).toEqual({
      code: 'key_rejected',
      after: 0,
      service: 'shots',
    });
    expect(parseInjectedFailure('unavailable after=12\n')).toEqual({
      code: 'unavailable',
      after: 12,
      service: 'shots',
    });
    expect(parseInjectedFailure('balance_empty voice')).toEqual({
      code: 'balance_empty',
      after: 0,
      service: 'voice',
    });
  });

  it('ignores words it does not know', () => {
    expect(parseInjectedFailure('please fail after=x')).toEqual({
      code: 'balance_empty',
      after: 0,
      service: 'shots',
    });
  });
});
