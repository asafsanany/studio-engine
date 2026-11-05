// Helpers shared by the Quick fixes tests of Review. Not imported by the app.

import type { NoteRoute, QuickFix, ReviewNote } from '@studio/shared';
import { makeReviewNote } from '@/data/test-utils';

/** A quick note's route: the caption font. Override what a test cares about. */
export function makeNoteRoute(overrides: Partial<NoteRoute> = {}): NoteRoute {
  return { tier: 'quick', kind: 'Changing the caption font', why: '', ...overrides };
}

/** A fix of {@link makeReviewNote}'s note that is done: 48 s, Sonnet at Medium. Override what a test cares about. */
export function makeQuickFix(overrides: Partial<QuickFix> = {}): QuickFix {
  return {
    id: 'f1',
    jobId: 'a1b2c3d4e5f6',
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
    endedAt: '2026-10-25T09:00:48.000Z',
    durationSec: 48,
    hasCompare: true,
    ...overrides,
  };
}

/** A quick fix that has not landed yet: queued, or running at a step. */
export function makeOpenFix(
  status: 'queued' | 'running',
  overrides: Partial<QuickFix> = {},
): QuickFix {
  return makeQuickFix({
    status,
    step: status === 'running' ? 1 : null,
    stepLabel: status === 'running' ? 'Changing the caption font' : null,
    said: null,
    startedAt: status === 'running' ? '2026-10-25T09:00:00.000Z' : null,
    endedAt: null,
    durationSec: null,
    hasCompare: false,
    ...overrides,
  });
}

/** A note Auto has read and sorted: `tier` and its `why` (a `revise`/`full` note says why it waits for Send). */
export function routedNote(
  tier: 'quick' | 'revise' | 'full',
  overrides: Partial<ReviewNote> = {},
): ReviewNote {
  const why =
    tier === 'revise' ? 'it changes the cut' : tier === 'full' ? 'it changes the whole video' : '';
  return makeReviewNote({
    routeStatus: 'routed',
    route: makeNoteRoute({ tier, why }),
    ...overrides,
  });
}
