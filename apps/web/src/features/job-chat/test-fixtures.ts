// Helpers shared by the job chat's tests. Not imported by the app.

import type { FeedRunItem } from '@studio/shared';

/** A run's divider: the Draft, just started; tests override what they care about. */
export function run(over: Partial<FeedRunItem> = {}): FeedRunItem {
  return {
    id: 'L1',
    at: null,
    kind: 'run',
    run: 'draft',
    round: null,
    mode: 'start',
    endedAt: null,
    outcome: null,
    error: null,
    durationMs: null,
    notes: [],
    ...over,
  };
}
