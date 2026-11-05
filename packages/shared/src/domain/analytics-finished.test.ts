import { describe, expect, it } from 'vitest';
import { type AnalyticsJob, computeAnalytics } from './analytics-compute.ts';
import { finishedAtOf } from './analytics-finished.ts';
import type { JobOutput } from './job.ts';
import { makeJob } from './test-fixtures.ts';
import type { UsageEntry } from './usage.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');
const FINISHED = '2026-10-21T12:00:00.000Z';
const OUTPUT: JobOutput = {
  fileName: 'A/job.mp4',
  durationSec: 120,
  width: 1080,
  height: 1920,
  sizeBytes: 1,
};

function job(id: string, overrides: Partial<AnalyticsJob> = {}): AnalyticsJob {
  return {
    ...makeJob({ id, clientId: 'client-a', client: 'A', addedAt: '2026-10-21T10:00:00.000Z' }),
    startedAt: '2026-10-21T10:01:00.000Z',
    finishedAt: FINISHED,
    footageSec: 600,
    ...overrides,
  };
}

describe('finishedAtOf', () => {
  it('is the finish time of a ready job with its export', () => {
    expect(finishedAtOf(job('a', { state: 'ready', output: OUTPUT }))).toBe(Date.parse(FINISHED));
  });

  it('is null for a job that is not ready, even when it still has an export and a finish time', () => {
    for (const state of [
      'arriving',
      'queued',
      'held',
      'editing',
      'review',
      'failed',
      'cancelled',
    ]) {
      expect(
        finishedAtOf(job('a', { state: state as AnalyticsJob['state'], output: OUTPUT })),
        state,
      ).toBeNull();
    }
  });

  it('is null for a ready job with no export, or with no finish time', () => {
    expect(finishedAtOf(job('a', { state: 'ready', output: null }))).toBeNull();
    expect(finishedAtOf(job('a', { state: 'ready', output: OUTPUT, finishedAt: null }))).toBeNull();
  });

  it('counts an archived job like any other', () => {
    const archived = job('a', {
      state: 'ready',
      output: OUTPUT,
      archivedAt: '2026-10-21T13:00:00.000Z',
    });
    expect(finishedAtOf(archived)).toBe(Date.parse(FINISHED));
  });
});

// The three sections that count finished jobs all use this one rule. A job that was started again
// keeps its old export (and finish time) while it runs: no section counts it.
describe('every section agrees on which jobs are finished', () => {
  const clientUsage: UsageEntry = {
    at: '2026-10-21T15:00:00.000Z',
    from: null,
    source: 'app',
    tag: 'edit',
    did: 'Edited a job',
    session: 's1',
    usage: {
      'claude-sonnet-5-5': {
        requests: 1,
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  };

  function answerFor(jobs: AnalyticsJob[]) {
    return computeAnalytics({
      now: NOW,
      timeZone: ZONE,
      jobs,
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: [clientUsage],
      limits: [],
      noteTopics: {},
    });
  }

  const finished = [
    job('f1', { state: 'ready', output: OUTPUT }),
    job('f2', { state: 'ready', output: OUTPUT }),
  ];
  // Started again: an export and a finish time from the first run, but not ready now.
  const again = job('again', { state: 'editing', output: OUTPUT });
  const withoutExport = job('plain', { state: 'ready', output: null });

  it('counts a re-run job nowhere', () => {
    const answer = answerFor([...finished, again, withoutExport]);
    expect(answer.jobs.tiles[0]?.value).toBe(2);
    expect(answer.typicalJob.jobsCounted).toBe(2);
    // Two finished jobs of two minutes each: $2 of Client work over 4 minutes.
    const week = answer.claudeUse.apiValuePerFinishedMinute.at(-1);
    expect(week?.usdPerMinute).toBeCloseTo(0.5, 6);
  });

  it('counts the same jobs in all three once the re-run job is ready again', () => {
    const answer = answerFor([...finished, { ...again, state: 'ready' }]);
    expect(answer.jobs.tiles[0]?.value).toBe(3);
    expect(answer.typicalJob.jobsCounted).toBe(3);
    const week = answer.claudeUse.apiValuePerFinishedMinute.at(-1);
    expect(week?.usdPerMinute).toBeCloseTo(2 / 6, 6);
  });
});
