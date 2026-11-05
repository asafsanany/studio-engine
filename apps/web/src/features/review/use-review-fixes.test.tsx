// `useReviewFixes`: what a Review needs of Quick fixes. There is no DOM, so the hook is rendered
// once to take what it returns; the fixes and the switch are put in the cache first.

import type { HealthResponse, Job, QuickFix, ReviewNote } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { jobFixesKey } from '@/data/job-fixes';
import { createTestQueryClient, makeJob, makeReviewNote } from '@/data/test-utils';
import { makeOpenFix, makeQuickFix, routedNote } from './fix-test-helpers';
import { reviewFooter } from './notes-logic';
import { FOOTER_TEXT } from './review-text';
import { type ReviewFixes, useReviewFixes } from './use-review-fixes';

const health = (quickFixes: boolean): HealthResponse => ({
  ok: true,
  version: '0.42.13',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes,
});

const JOB = 'a1b2c3d4e5f6';
const autoJob = makeJob({
  id: JOB,
  state: 'review',
  placeInLine: null,
  round: 0,
  reviewEffort: null,
});
const levelJob = { ...autoJob, reviewEffort: 'high' } as Job;
const base = { writing: false, submitting: null, sendDisabledReason: null } as const;

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function run(
  job: Job,
  notes: readonly ReviewNote[] | undefined,
  {
    quickFixes,
    fixes,
    frozen = false,
  }: { quickFixes?: boolean; fixes?: QuickFix[]; frozen?: boolean },
): ReviewFixes {
  if (quickFixes !== undefined) queryClient.setQueryData(HEALTH_KEY, health(quickFixes));
  if (fixes !== undefined) queryClient.setQueryData(jobFixesKey(job.id), fixes);
  let seen: ReviewFixes | undefined;
  function Probe() {
    seen = useReviewFixes(job, notes, frozen);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (seen === undefined) throw new Error('the hook did not run');
  return seen;
}

describe('useReviewFixes with Quick fixes off', () => {
  const notes = [routedNote('revise'), makeReviewNote({ id: 'n2' })];

  it('is today’s Review: no lines, every note waits, the footer is the old one', () => {
    const quick = run(autoJob, notes, { quickFixes: false, fixes: [makeQuickFix()] });
    expect(quick.enabled).toBe(false);
    expect(quick.lines).toBeUndefined();
    expect(quick.waiting).toBe(notes);
    expect(quick.footer({ ...base, notes })).toEqual(reviewFooter({ ...base, notes }));
    expect(quick.footer({ ...base, notes }).text).toBe(FOOTER_TEXT.withNotes);
  });

  it('is the same until the health answer is in', () => {
    const quick = run(autoJob, notes, {});
    expect(quick.enabled).toBe(false);
    expect(quick.lines).toBeUndefined();
  });
});

describe('useReviewFixes with Quick fixes on', () => {
  it('gives each note its line, the notes that wait, and the footer’s words', () => {
    const notes = [
      routedNote('quick', { id: 'a', fixId: 'fa' }),
      routedNote('revise', { id: 'b' }),
    ];
    const quick = run(autoJob, notes, {
      quickFixes: true,
      fixes: [makeQuickFix({ id: 'fa', noteId: 'a' })],
    });
    expect(quick.enabled).toBe(true);
    expect(quick.lines?.get('a')?.kind).toBe('fixed');
    expect(quick.lines?.get('a')?.undoFixId).toBe('fa');
    expect(quick.lines?.get('b')?.text).toBe('Goes with Send · it changes the cut');
    expect(quick.waiting?.map((note) => note.id)).toEqual(['b']);
    const footer = quick.footer({ ...base, notes });
    expect(footer.label).toBe('Send 1 note');
    expect(footer.text).toBe('Auto sends 1 note to Sonnet at High, 2 to 10 min.');
  });

  it('says the range of the job’s own earlier revise runs in the footer when it has one (C61)', () => {
    const notes = [routedNote('revise', { id: 'b' })];
    const job = { ...autoJob, reviseMinutes: { min: 12, max: 40 } } as Job;
    const quick = run(job, notes, { quickFixes: true, fixes: [] });
    expect(quick.footer({ ...base, notes }).text).toBe(
      'Auto sends 1 note to Sonnet at High, 12 to 40 min.',
    );
  });

  it('waits for the fixes before it calls a quick note done, and says it is being read', () => {
    const notes = [routedNote('quick', { id: 'a' })];
    const quick = run(autoJob, notes, { quickFixes: true });
    expect(quick.lines?.size).toBe(0);
    expect(quick.footer({ ...base, notes }).text).toBe('Reading the note. Approve waits for it.');
  });

  it('holds the footer and Undo while a fix runs', () => {
    const notes = [routedNote('quick', { id: 'a' })];
    const quick = run(autoJob, notes, {
      quickFixes: true,
      fixes: [makeOpenFix('running', { id: 'fa', noteId: 'a' })],
    });
    expect(quick.lines?.get('a')?.kind).toBe('running');
    const footer = quick.footer({ ...base, notes });
    expect(footer.disabled).toBe(true);
    expect(footer.effortDisabled).toBe(true);
  });

  it('treats a level instead of Auto as no reading and no plan: the notes just wait', () => {
    const notes = [makeReviewNote({ id: 'a' }), makeReviewNote({ id: 'b' })];
    const quick = run(levelJob, notes, { quickFixes: true, fixes: [] });
    expect(quick.lines?.size).toBe(0);
    expect(quick.waiting).toHaveLength(2);
    expect(quick.footer({ ...base, notes }).text).toBe(
      'Your notes go to the editor together, at High.',
    );
  });

  it('has no lines while the notes load', () => {
    const quick = run(autoJob, undefined, { quickFixes: true, fixes: [] });
    expect(quick.waiting).toBeUndefined();
    expect(quick.lines?.size).toBe(0);
  });
});
