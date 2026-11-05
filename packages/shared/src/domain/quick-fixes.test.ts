import { describe, expect, expectTypeOf, it } from 'vitest';
import { type Effort, effortSchema } from './effort.ts';
import { type ReviseTier, reviseMinutesSchema } from './job.ts';
import {
  biggestTier,
  FIX_COMPARE_FILES,
  FIX_LIMITS,
  FIX_MESSAGES,
  FIX_STATUSES,
  FIX_TIERS,
  type FixStatus,
  type FixTier,
  fixCompareFileSchema,
  fixStatusSchema,
  fixTierSchema,
  isFixedNote,
  type JobFixesResponse,
  jobFixesResponseSchema,
  NOTE_ROUTE_STATUSES,
  type NoteRoute,
  noteRouteSchema,
  noteRouteStatusSchema,
  type QuickFix,
  quickFixSchema,
  REVIEW_EFFORT_CHOICES,
  REVISE_GAP_MS,
  REVISE_HISTORY_RUNS,
  type ReviewEffortRequest,
  ROUTER_MODEL,
  reviewEffortRequestSchema,
  reviseMinutesOf,
  revisePassSeconds,
  reviseRunOf,
  TIER_MINUTES,
  TIER_RUNS,
  type TimedStepRun,
  type UndoFixResponse,
  undoFixResponseSchema,
} from './quick-fixes.ts';
import { makeJob, makeNoteRoute, makeQuickFix } from './test-fixtures.ts';

describe('the tiers', () => {
  it('are quick, revise and full, smallest first', () => {
    expect(FIX_TIERS).toEqual(['quick', 'revise', 'full']);
    for (const tier of FIX_TIERS) expect(fixTierSchema.parse(tier)).toBe(tier);
    for (const bad of ['', 'Quick', 'fast', 'slow', 'full revise', 3, null]) {
      expect(fixTierSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('run: quick on Sonnet at Medium, revise on Sonnet at High with a slim check, full on the configured model at Extra high with the whole check', () => {
    expect(TIER_RUNS.quick).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(TIER_RUNS.revise).toEqual({ model: 'sonnet', effort: 'high', checks: 'slim' });
    expect(TIER_RUNS.full).toEqual({ model: null, effort: 'xhigh', checks: 'full' });
    expect(Object.keys(TIER_RUNS)).toEqual([...FIX_TIERS]);
    for (const tier of FIX_TIERS) {
      expect(effortSchema.safeParse(TIER_RUNS[tier].effort).success).toBe(true);
    }
  });

  it('are sorted by Haiku', () => {
    expect(ROUTER_MODEL).toBe('haiku');
  });
});

describe('biggestTier', () => {
  it('is the biggest of the tiers: quick < revise < full', () => {
    expect(biggestTier(['quick'])).toBe('quick');
    expect(biggestTier(['quick', 'revise'])).toBe('revise');
    expect(biggestTier(['revise', 'quick', 'quick'])).toBe('revise');
    expect(biggestTier(['revise', 'full', 'quick'])).toBe('full');
    expect(biggestTier(['full', 'revise'])).toBe('full');
    expect(biggestTier(['revise', 'revise'])).toBe('revise');
  });

  it('is null for no notes', () => {
    expect(biggestTier([])).toBeNull();
    expect(biggestTier([], { goesWithSend: true })).toBeNull();
  });

  it('counts a waiting quick note as revise when it goes with Send', () => {
    expect(biggestTier(['quick'], { goesWithSend: true })).toBe('revise');
    expect(biggestTier(['quick', 'quick'], { goesWithSend: true })).toBe('revise');
    expect(biggestTier(['quick', 'revise'], { goesWithSend: true })).toBe('revise');
    expect(biggestTier(['quick', 'full'], { goesWithSend: true })).toBe('full');
    // Not asked for: a quick note stays quick.
    expect(biggestTier(['quick'], { goesWithSend: false })).toBe('quick');
    expect(biggestTier(['quick'], {})).toBe('quick');
  });

  it('answers a revise tier (what Job.reviseTier holds) when it goes with Send', () => {
    const forSend = biggestTier(['quick', 'full'], { goesWithSend: true });
    expectTypeOf(forSend).toEqualTypeOf<ReviseTier | null>();
    expectTypeOf(biggestTier(['quick'])).toEqualTypeOf<FixTier | null>();
  });

  it('does not change the list it is given', () => {
    const tiers: FixTier[] = ['quick', 'full', 'revise'];
    biggestTier(tiers, { goesWithSend: true });
    expect(tiers).toEqual(['quick', 'full', 'revise']);
  });
});

describe('NoteRoute', () => {
  it('has a tier, what the note asks for, and why it waits', () => {
    const quick = makeNoteRoute();
    expect(noteRouteSchema.parse(quick)).toEqual(quick);
    const revise = makeNoteRoute({
      tier: 'revise',
      kind: 'Swapping a shot',
      why: 'it changes the cut',
    });
    expect(noteRouteSchema.parse(revise)).toEqual(revise);
    const full = makeNoteRoute({
      tier: 'full',
      kind: 'Syncing cuts to beat',
      why: 'it is about the pace',
    });
    expect(noteRouteSchema.parse(full)).toEqual(full);
  });

  it('survives a JSON round trip', () => {
    const route = makeNoteRoute({
      tier: 'revise',
      kind: 'Replacing the music',
      why: 'it changes the sound',
    });
    expect(noteRouteSchema.parse(JSON.parse(JSON.stringify(route)))).toEqual(route);
  });

  it('keeps no why for a quick note: it is fixed, so nothing waits', () => {
    expect(noteRouteSchema.safeParse(makeNoteRoute({ why: 'it is small' })).success).toBe(false);
    expect(noteRouteSchema.safeParse(makeNoteRoute({ tier: 'revise', why: '' })).success).toBe(
      true,
    );
  });

  it.each([
    ['an unknown tier', { tier: 'huge' }],
    ['no tier', { tier: undefined }],
    ['an empty kind', { kind: '' }],
    ['a kind of spaces', { kind: '   ' }],
    ['a kind that is not text', { kind: 3 }],
    ['a why that is not text', { why: null }],
    ['a very long why', { tier: 'revise', why: `it ${'x'.repeat(250)}` }],
  ])('rejects %s', (_label, overrides) => {
    expect(noteRouteSchema.safeParse({ ...makeNoteRoute(), ...overrides }).success).toBe(false);
  });

  it('has two statuses, pending and routed', () => {
    expect(NOTE_ROUTE_STATUSES).toEqual(['pending', 'routed']);
    expect(noteRouteStatusSchema.safeParse('pending').success).toBe(true);
    expect(noteRouteStatusSchema.safeParse('failed').success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<NoteRoute>().toEqualTypeOf<{ tier: FixTier; kind: string; why: string }>();
  });
});

describe('QuickFix', () => {
  it('parses a fix that is done, and survives a JSON round trip', () => {
    const fix = makeQuickFix();
    expect(quickFixSchema.parse(fix)).toEqual(fix);
    expect(quickFixSchema.parse(JSON.parse(JSON.stringify(fix)))).toEqual(fix);
  });

  it('parses a fix in every status', () => {
    expect(FIX_STATUSES).toEqual([
      'queued',
      'running',
      'fixed',
      'escalated',
      'failed',
      'undone',
      'cancelled',
    ]);
    for (const status of FIX_STATUSES) {
      const fix = makeQuickFix({ status });
      expect(quickFixSchema.parse(fix)).toEqual(fix);
      expect(fixStatusSchema.parse(status)).toBe(status);
    }
    expect(fixStatusSchema.safeParse('done').success).toBe(false);
  });

  it('parses one that waits its turn, one that is on a step, and one that could not be done here', () => {
    const queued = makeQuickFix({
      status: 'queued',
      said: null,
      startedAt: null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    const running = makeQuickFix({
      status: 'running',
      step: 1,
      stepLabel: 'Changing the caption font',
      said: null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    const escalated = makeQuickFix({
      status: 'escalated',
      said: null,
      why: 'The font is part of the footage, not the composition.',
      hasCompare: false,
    });
    for (const fix of [queued, running, escalated]) {
      expect(quickFixSchema.parse(fix)).toEqual(fix);
    }
  });

  it('allows steps 0 to 3 and nothing else', () => {
    for (const step of [0, 1, 2, 3]) {
      expect(quickFixSchema.safeParse(makeQuickFix({ step })).success).toBe(true);
    }
    for (const step of [-1, 4, 1.5]) {
      expect(quickFixSchema.safeParse(makeQuickFix({ step })).success, String(step)).toBe(false);
    }
  });

  it.each([
    ['round 0 (a note is stamped with job.round + 1)', { round: 0 }],
    ['a fractional round', { round: 1.5 }],
    ['an unknown status', { status: 'stuck' }],
    ['an empty id', { id: '' }],
    ['an empty jobId', { jobId: '' }],
    ['an empty noteId', { noteId: '' }],
    ['an empty said (use null)', { said: '' }],
    ['an empty why (use null)', { why: '' }],
    ['an empty stepLabel (use null)', { stepLabel: '' }],
    ['an empty model', { model: '' }],
    ['Max as the effort', { effort: 'max' }],
    ['a startedAt that is not ISO', { startedAt: 'yesterday' }],
    ['an endedAt that is not ISO', { endedAt: '2026-10-25' }],
    ['a negative duration', { durationSec: -1 }],
    ['hasCompare as a string', { hasCompare: 'yes' }],
  ])('rejects %s', (_label, overrides) => {
    expect(quickFixSchema.safeParse({ ...makeQuickFix(), ...overrides }).success).toBe(false);
  });

  it('requires every field, including the nullable ones', () => {
    const fix = makeQuickFix();
    for (const key of Object.keys(fix)) {
      const { [key as keyof QuickFix]: _omitted, ...rest } = fix;
      expect(quickFixSchema.safeParse(rest).success, `missing ${key}`).toBe(false);
    }
  });

  it('infers nullable fields as T | null (never optional)', () => {
    expectTypeOf<QuickFix['step']>().toEqualTypeOf<number | null>();
    expectTypeOf<QuickFix['stepLabel']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuickFix['said']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuickFix['why']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuickFix['startedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuickFix['endedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuickFix['durationSec']>().toEqualTypeOf<number | null>();
    expectTypeOf<QuickFix['status']>().toEqualTypeOf<FixStatus>();
    expectTypeOf<QuickFix['effort']>().toEqualTypeOf<Effort>();
    expectTypeOf<QuickFix['hasCompare']>().toEqualTypeOf<boolean>();
  });

  it('compares with two stills of the note’s moment', () => {
    expect(FIX_COMPARE_FILES).toEqual(['before.png', 'after.png']);
    expect(fixCompareFileSchema.safeParse('after.png').success).toBe(true);
    expect(fixCompareFileSchema.safeParse('../after.png').success).toBe(false);
    expect(fixCompareFileSchema.safeParse('reply.json').success).toBe(false);
  });
});

describe('limits and texts', () => {
  it('have the numbers of the plan: 4 minutes a fix, 20 s to sort a note, 2 jobs at once', () => {
    expect(FIX_LIMITS).toEqual({ runSec: 240, routeSec: 20, jobsAtOnce: 2 });
  });

  it('have the words of the 409s and the 404', () => {
    expect(FIX_MESSAGES).toEqual({
      busy: 'A quick fix is running. Wait for it to finish.',
      notNewest: 'Only the newest fix can be undone.',
      editFixed: 'Undo the fix before changing this note.',
      deleteFixed: 'Only the newest fix can be deleted; it is undone first.',
      off: 'Quick fixes are off.',
      onlyFixed: 'Every note is already fixed here. Approve instead.',
      waitForAuto: 'Wait for Auto to read the notes.',
      effortNotInReview: "Review's effort can only be changed while the job is in Review.",
    });
  });
});

describe('wire shapes', () => {
  it('GET /api/jobs/:id/fixes: the fixes, oldest first', () => {
    const body = { fixes: [makeQuickFix(), makeQuickFix({ id: 'f2', noteId: 'n2' })] };
    expect(jobFixesResponseSchema.parse(body)).toEqual(body);
    expect(jobFixesResponseSchema.parse({ fixes: [] })).toEqual({ fixes: [] });
    expect(jobFixesResponseSchema.safeParse({}).success).toBe(false);
    expect(jobFixesResponseSchema.safeParse({ fixes: [{ id: 'f1' }] }).success).toBe(false);
    expectTypeOf<JobFixesResponse>().toEqualTypeOf<{ fixes: QuickFix[] }>();
  });

  it('POST /api/jobs/:id/fixes/:fixId/undo: the fix and the job', () => {
    const body = {
      fix: makeQuickFix({ status: 'undone' }),
      job: makeJob({ state: 'review' }),
    };
    expect(undoFixResponseSchema.parse(body)).toEqual(body);
    expect(undoFixResponseSchema.safeParse({ fix: body.fix }).success).toBe(false);
    expect(undoFixResponseSchema.safeParse({ job: body.job }).success).toBe(false);
    expectTypeOf<UndoFixResponse['fix']>().toEqualTypeOf<QuickFix>();
  });

  it('PUT /api/jobs/:id/review-effort: Auto or one of the three levels', () => {
    expect(REVIEW_EFFORT_CHOICES).toEqual(['auto', 'medium', 'high', 'xhigh']);
    for (const effort of REVIEW_EFFORT_CHOICES) {
      expect(reviewEffortRequestSchema.parse({ effort })).toEqual({ effort });
    }
    for (const bad of [
      {},
      { effort: null },
      { effort: 'max' },
      { effort: 'Auto' },
      { effort: '' },
    ]) {
      expect(reviewEffortRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expectTypeOf<ReviewEffortRequest>().toEqualTypeOf<{
      effort: 'auto' | 'medium' | 'high' | 'xhigh';
    }>();
  });
});

// QF4 (CVP-376): the model, effort and self-check of a revise run, from the job as it stands.
describe('reviseRunOf', () => {
  type Saved = {
    effort: Effort | null;
    reviewEffort: Effort | null;
    reviseTier: ReviseTier | null;
  };
  type Chosen = { model: string | null; effort: Effort; checks: 'slim' | 'full' };
  const cases: [string, Saved, Chosen][] = [
    // Today: nothing saved, the edit's level (Default is Extra high), the configured model.
    [
      'nothing saved: the configured model at Default',
      { effort: null, reviewEffort: null, reviseTier: null },
      { model: null, effort: 'xhigh', checks: 'full' },
    ],
    [
      'nothing saved, the edit at Medium',
      { effort: 'medium', reviewEffort: null, reviseTier: null },
      { model: null, effort: 'medium', checks: 'full' },
    ],
    [
      'nothing saved, the edit at High',
      { effort: 'high', reviewEffort: null, reviseTier: null },
      { model: null, effort: 'high', checks: 'full' },
    ],
    // Auto: the tier Send saved decides, whatever the edit's level was.
    [
      'Auto, revise: Sonnet at High with the slim check',
      { effort: null, reviewEffort: null, reviseTier: 'revise' },
      { model: 'sonnet', effort: 'high', checks: 'slim' },
    ],
    [
      'Auto, revise, the edit at Medium',
      { effort: 'medium', reviewEffort: null, reviseTier: 'revise' },
      { model: 'sonnet', effort: 'high', checks: 'slim' },
    ],
    [
      'Auto, full: the configured model at Extra high with the whole check',
      { effort: null, reviewEffort: null, reviseTier: 'full' },
      { model: null, effort: 'xhigh', checks: 'full' },
    ],
    [
      'Auto, full, the edit at Medium',
      { effort: 'medium', reviewEffort: null, reviseTier: 'full' },
      { model: null, effort: 'xhigh', checks: 'full' },
    ],
    // A level chosen in Review: the configured model at that level, whatever else is saved.
    [
      'a level in Review (Medium)',
      { effort: null, reviewEffort: 'medium', reviseTier: null },
      { model: null, effort: 'medium', checks: 'full' },
    ],
    [
      'a level in Review (High), the edit at Medium',
      { effort: 'medium', reviewEffort: 'high', reviseTier: null },
      { model: null, effort: 'high', checks: 'full' },
    ],
    [
      'a level in Review (Extra high), the edit at High',
      { effort: 'high', reviewEffort: 'xhigh', reviseTier: null },
      { model: null, effort: 'xhigh', checks: 'full' },
    ],
    [
      'a level beats a tier that is still saved (revise)',
      { effort: null, reviewEffort: 'medium', reviseTier: 'revise' },
      { model: null, effort: 'medium', checks: 'full' },
    ],
    [
      'a level beats a tier that is still saved (full)',
      { effort: null, reviewEffort: 'high', reviseTier: 'full' },
      { model: null, effort: 'high', checks: 'full' },
    ],
  ];

  it.each(cases)('%s', (_name, job, expected) => {
    expect(reviseRunOf(job)).toEqual(expected);
  });

  it('takes its tiers from TIER_RUNS, so tuning the map tunes the run', () => {
    for (const tier of ['revise', 'full'] as const) {
      expect(reviseRunOf({ effort: null, reviewEffort: null, reviseTier: tier })).toEqual({
        model: TIER_RUNS[tier].model,
        effort: TIER_RUNS[tier].effort,
        checks: TIER_RUNS[tier].checks,
      });
    }
  });

  it('reads a whole job', () => {
    expect(reviseRunOf(makeJob({ reviewEffort: null, reviseTier: 'revise' })).model).toBe('sonnet');
  });
});

describe('isFixedNote', () => {
  it('is a note a quick fix landed for', () => {
    expect(isFixedNote({ fixId: 'f1' })).toBe(true);
    expect(isFixedNote({ fixId: null })).toBe(false);
  });
});

describe('TIER_MINUTES', () => {
  it('has a range of whole minutes for each tier a Send can run at', () => {
    expect(Object.keys(TIER_MINUTES)).toEqual(['revise', 'full']);
    for (const tier of ['revise', 'full'] as const) {
      expect(reviseMinutesSchema.safeParse(TIER_MINUTES[tier]).success, tier).toBe(true);
    }
  });

  it('puts Full above Revise, and covers the 42 min Full the QF9 run took at its top', () => {
    expect(TIER_MINUTES.full.min).toBeGreaterThan(TIER_MINUTES.revise.min);
    expect(TIER_MINUTES.full.max).toBeGreaterThan(TIER_MINUTES.revise.max);
    expect(TIER_MINUTES.full.max).toBeGreaterThanOrEqual(40);
  });
});

describe('reviseMinutesSchema', () => {
  it('wants whole minutes from 1, and a longest that is not below the shortest', () => {
    expect(reviseMinutesSchema.safeParse({ min: 12, max: 40 }).success).toBe(true);
    expect(reviseMinutesSchema.safeParse({ min: 5, max: 5 }).success).toBe(true);
    for (const bad of [
      { min: 0, max: 3 },
      { min: 2.5, max: 4 },
      { min: 9, max: 4 },
      { min: 3 },
      null,
    ]) {
      expect(reviseMinutesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const MIN = 60_000;

/** A timed step: `atMin` minutes after T0, `lastMin` minutes long (`null`: still open). */
function step(
  runKind: TimedStepRun['runKind'],
  stepId: TimedStepRun['step'],
  atMin: number,
  lastMin: number | null,
): TimedStepRun {
  return {
    step: stepId,
    runKind,
    startedAt: T0 + atMin * MIN,
    endedAt: lastMin === null ? null : T0 + (atMin + lastMin) * MIN,
  };
}

describe('revisePassSeconds', () => {
  it('is the wall time of a revise run, first step start to last step end, so a step nobody timed is inside it', () => {
    // Plan 5 min, then Check from minute 25 to 30: Cut and Preview ran untimed in between.
    expect(revisePassSeconds([step('revise', 4, 0, 5), step('revise', 7, 25, 5)])).toEqual([
      30 * 60,
    ]);
  });

  it('is empty for a job with no revise run, and leaves the edit and the render out', () => {
    expect(revisePassSeconds([])).toEqual([]);
    expect(
      revisePassSeconds([
        step('edit', 1, 0, 30),
        step('edit', 7, 31, 4),
        step('render', 8, 100, 6),
      ]),
    ).toEqual([]);
  });

  it('starts a new run at Plan, and after a Check that ended', () => {
    const runs = [
      // Run 1: Plan, Preview, Check (ended).
      step('revise', 4, 0, 2),
      step('revise', 6, 2, 1),
      step('revise', 7, 3, 2),
      // Run 2 began at Cut, not at Plan: the Check before it ended, so it is another run.
      step('revise', 5, 100, 4),
      step('revise', 6, 104, 1),
      step('revise', 7, 105, 1),
      // Run 3: Plan.
      step('revise', 4, 300, 8),
    ];
    expect(revisePassSeconds(runs)).toEqual([5 * 60, 6 * 60, 8 * 60]);
  });

  it('starts a new run after another kind of run', () => {
    const runs = [
      step('revise', 4, 0, 3),
      step('render', 8, 10, 5),
      // Plan is missing: the run before it was a render, so this is another revise run.
      step('revise', 6, 200, 2),
    ];
    expect(revisePassSeconds(runs)).toEqual([3 * 60, 2 * 60]);
  });

  it('keeps a step that follows a Check which never ended in the same run (a retry from Check)', () => {
    const runs = [step('revise', 4, 0, 3), step('revise', 7, 3, null), step('revise', 7, 10, 2)];
    expect(revisePassSeconds(runs)).toEqual([12 * 60]);
  });

  it('leaves out a run whose last step is still open: it never got back to Review', () => {
    expect(revisePassSeconds([step('revise', 4, 0, 3), step('revise', 5, 3, null)])).toEqual([]);
    expect(revisePassSeconds([step('revise', 4, 0, null)])).toEqual([]);
  });

  it('leaves out the hours a failed run waited for Retry', () => {
    const wait = REVISE_GAP_MS / MIN + 30;
    const runs = [step('revise', 4, 0, 4), step('revise', 5, 4 + wait, 6)];
    expect(revisePassSeconds(runs)).toEqual([(4 + 6) * 60]);
  });

  it('counts a gap a little under the limit as work', () => {
    const runs = [step('revise', 4, 0, 4), step('revise', 7, 4 + 100, 6)];
    expect(revisePassSeconds(runs)).toEqual([110 * 60]);
  });

  it('skips a run that took no time', () => {
    expect(revisePassSeconds([step('revise', 4, 0, 0)])).toEqual([]);
  });
});

describe('reviseMinutesOf', () => {
  it('is null with fewer than two runs', () => {
    expect(REVISE_HISTORY_RUNS).toBe(2);
    expect(reviseMinutesOf([])).toBeNull();
    expect(reviseMinutesOf([12 * 60])).toBeNull();
  });

  it('is the shortest to the longest in whole minutes', () => {
    expect(reviseMinutesOf([12 * 60, 40 * 60, 20 * 60])).toEqual({ min: 12, max: 40 });
    expect(reviseMinutesOf([12.4 * 60, 39.6 * 60])).toEqual({ min: 12, max: 40 });
  });

  it('never says less than a minute, and the longest is never below the shortest', () => {
    expect(reviseMinutesOf([20, 100])).toEqual({ min: 1, max: 2 });
    expect(reviseMinutesOf([30, 40])).toEqual({ min: 1, max: 1 });
    expect(reviseMinutesOf([5 * 60, 5 * 60])).toEqual({ min: 5, max: 5 });
  });

  it('gives what the schema takes', () => {
    expect(reviseMinutesSchema.safeParse(reviseMinutesOf([0, 3 * 3600])).success).toBe(true);
  });
});
