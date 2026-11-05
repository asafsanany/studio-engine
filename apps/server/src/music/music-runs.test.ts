import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeJob } from '../events/test-utils.js';
import type { RunContext, Runner, RunOutcome } from '../pipeline/runner.js';
import { withMusicRuns } from './music-runs.js';

// The runner with the music looked at after every edit or revise run.

const context: RunContext = { signal: new AbortController().signal, progress: () => {} };

function runnerOf(result: () => Promise<RunOutcome>): Runner {
  return { start: vi.fn(async () => result()) };
}

describe('withMusicRuns', () => {
  it.each(['edit', 'revise'] as const)(
    'looks at the music after a %s run ends, whatever the outcome',
    async (runKind) => {
      const job = makeJob({ runKind });
      for (const outcome of [{ ok: true }, { ok: false, error: 'It broke.' }] as RunOutcome[]) {
        const after = vi.fn(async () => {});
        const inner = runnerOf(async () => outcome);
        expect(await withMusicRuns(inner, after).start(job, 'start', context)).toBe(outcome);
        expect(after).toHaveBeenCalledWith(job);
        expect(inner.start).toHaveBeenCalledWith(job, 'start', context);
      }
    },
  );

  it('looks after a run that throws too, and lets the error through', async () => {
    const after = vi.fn(async () => {});
    const runner = withMusicRuns(
      runnerOf(async () => {
        throw new Error('crashed');
      }),
      after,
    );
    await expect(runner.start(makeJob(), 'start', context)).rejects.toThrow('crashed');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('waits for the look before it hands the outcome back', async () => {
    const order: string[] = [];
    const runner = withMusicRuns(
      runnerOf(async () => {
        order.push('run');
        return { ok: true };
      }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('look');
      },
    );
    await runner.start(makeJob(), 'start', context);
    order.push('outcome');
    expect(order).toEqual(['run', 'look', 'outcome']);
  });

  it('leaves a render run alone', async () => {
    const after = vi.fn(async () => {});
    await withMusicRuns(
      runnerOf(async () => ({ ok: true })),
      after,
    ).start(makeJob({ runKind: 'render' } as Partial<Job>), 'start', context);
    expect(after).not.toHaveBeenCalled();
  });

  it('only logs a look that fails: the run’s outcome is its own', async () => {
    const warn = vi.fn();
    const outcome: RunOutcome = { ok: true };
    const runner = withMusicRuns(
      runnerOf(async () => outcome),
      async () => {
        throw new Error('no disk');
      },
      { info: vi.fn(), warn, error: vi.fn() },
    );
    expect(await runner.start(makeJob(), 'start', context)).toBe(outcome);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'a1b2c3d4e5f6' }),
      'could not look at the music the run left',
    );
  });
});
