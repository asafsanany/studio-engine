// Fixtures for the quick fix pill's tests. Not imported by the app.

import type { QuickFix } from '@studio/shared';

export const FIX_JOB_ID = 'a1b2c3d4e5f6';

/** A fixed fix of note `n1`, ended at 09:00:28 UTC on 25 Oct 2026, with its Compare stills. */
export function makeFix(overrides: Partial<QuickFix> = {}): QuickFix {
  return {
    id: 'f1',
    jobId: FIX_JOB_ID,
    noteId: 'n1',
    round: 1,
    status: 'fixed',
    step: null,
    stepLabel: null,
    said: 'The captions are Heebo Bold now.',
    why: null,
    model: 'sonnet',
    effort: 'medium',
    startedAt: '2026-10-25T09:00:00.000Z',
    endedAt: '2026-10-25T09:00:28.000Z',
    durationSec: 28,
    hasCompare: true,
    ...overrides,
  };
}

/** `endedAt` for a fix that ended `seconds` after 09:00:00 UTC. */
export function endedAfter(seconds: number): string {
  return new Date(Date.parse('2026-10-25T09:00:00.000Z') + seconds * 1000).toISOString();
}
