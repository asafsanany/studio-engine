import { can, generateErrorMessage, JOB_ACTIONS, JOB_STATES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { CANVAS_JOBS } from '../test-jobs';
import {
  approveAction,
  menuActions,
  nextStepAction,
  REVIEW_DIALOG_ACTIONS,
  REVIEW_LABELS,
  stageUndoAction,
} from './row-actions';

/** A ready job at each stage. */
const approved = makeJob({ id: 'a1', state: 'ready', placeInLine: null });
/** A video that went through Review and Approve: ready, with the approval and the composition it kept. */
const approvedInReview = makeJob({
  id: 'a2',
  state: 'ready',
  placeInLine: null,
  runKind: 'render',
  round: 1,
  approvedAt: '2026-10-21T09:30:00.000Z',
  preview: { durationSec: 28.4, width: 1080, height: 1920 },
});
const delivered = makeJob({
  id: 'd1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery(),
});
const paid = makeJob({
  id: 'p1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
});

const REEL = {
  uploadedAt: '2026-10-20T09:30:00.000Z',
  reelUrl: 'https://www.instagram.com/reel/C-rooftop/',
};
/** A delivered video with a reel linked to it: Uploaded. */
const uploaded = makeJob({
  id: 'u1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery(REEL),
});
/** A paid video with a reel linked to it: it stays Paid. */
const paidAndLinked = makeJob({
  id: 'u2',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery({ ...REEL, paidOn: '2026-10-23' }),
});

const canvasJob = (id: string) => {
  const job = CANVAS_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no canvas job ${id}`);
  return job;
};

describe('nextStepAction: the one button of the right column', () => {
  it.each([
    ['j1', 'arriving', 'start', 'Start now'],
    ['j3', 'held', 'release', 'Release'],
    ['j6', 'ready', 'deliver', 'Mark delivered'],
    ['j7', 'failed', 'retry', 'Retry from Render'],
    ['j8', 'cancelled', 'resume', 'Resume'],
  ] as const)('%s (%s): %s, "%s"', (id, state, kind, label) => {
    expect(canvasJob(id).state).toBe(state);
    expect(nextStepAction(canvasJob(id))).toMatchObject({ kind, label });
  });

  it.each([
    ['j2', 'queued'],
    ['j5', 'editing'],
  ] as const)('%s (%s): nothing, the job moves by itself', (id, state) => {
    expect(canvasJob(id).state).toBe(state);
    expect(nextStepAction(canvasJob(id))).toBeNull();
  });

  it('is never Hold, Cancel or Copy error: those are in the menu', () => {
    for (const state of JOB_STATES) {
      const kind = nextStepAction(makeJob({ state, failedAt: 8, error: 'boom' }))?.kind;
      expect(['hold', 'cancel', 'copy'], state).not.toContain(kind);
    }
  });

  it('only ever offers a server action the state machine allows (can)', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, failedAt: 8, error: 'boom' });
      const action = nextStepAction(job);
      if (
        action !== null &&
        action.kind !== 'review' &&
        action.kind !== 'deliver' &&
        action.kind !== 'pay'
      )
        expect(can(job, action.kind), state).toBe(true);
    }
  });

  it('has a button in every state but queued and editing', () => {
    for (const state of JOB_STATES) {
      const hasButton = nextStepAction(makeJob({ state })) !== null;
      expect(hasButton, state).toBe(!['queued', 'editing'].includes(state));
    }
  });

  it('offers Start now only to an arriving job', () => {
    for (const state of JOB_STATES) {
      const offered = nextStepAction(makeJob({ state }))?.kind === 'start';
      expect(offered, state).toBe(state === 'arriving');
    }
  });

  it('is Mark delivered for an approved job, Mark paid… for a delivered one and nothing once paid', () => {
    expect(nextStepAction(approved)).toEqual({ kind: 'deliver', label: 'Mark delivered' });
    expect(nextStepAction(delivered)).toEqual({ kind: 'pay', label: 'Mark paid…' });
    expect(nextStepAction(paid)).toBeNull();
  });

  it('is Mark paid… for an uploaded job too: a linked reel does not change what is owed', () => {
    expect(nextStepAction(uploaded)).toEqual({ kind: 'pay', label: 'Mark paid…' });
    expect(nextStepAction(paidAndLinked)).toBeNull();
  });

  it('is nothing for an uploaded job an editor sees: Mark paid… is the admin’s', () => {
    expect(nextStepAction(uploaded, false)).toBeNull();
  });

  it('offers no Mark paid… for an archived uploaded video either', () => {
    const archived = { ...uploaded, archivedAt: '2026-10-21T10:00:00.000Z' };
    expect(nextStepAction(archived)).toBeNull();
    expect(menuActions(archived).map((a) => a.kind)).toEqual(['reel', 'download']);
  });

  it('offers no Mark paid… for an archived delivered video: archived means paid or not needed', () => {
    const archived = { ...delivered, archivedAt: '2026-10-21T10:00:00.000Z' };
    expect(nextStepAction(archived)).toBeNull();
    expect(menuActions(archived).map((a) => a.kind)).toEqual(['download']);
    expect(stageUndoAction(archived)).toEqual({ kind: 'undeliver', label: 'Not delivered yet' });
  });

  it('no longer offers Download MP4: the file is in the menu, at every stage', () => {
    for (const job of [approved, delivered, paid]) {
      expect(nextStepAction(job)?.kind).not.toBe('download');
    }
  });

  it('offers a stage only to a ready job: a job that left ready (a retry) keeps its delivery unseen', () => {
    for (const state of JOB_STATES.filter((state) => state !== 'ready')) {
      const job = makeJob({ state, failedAt: 8, error: 'boom', delivery: makeJobDelivery() });
      expect(['deliver', 'pay', 'undeliver', 'unpay'], state).not.toContain(
        nextStepAction(job)?.kind,
      );
      expect(
        menuActions(job).map((action) => action.kind),
        state,
      ).not.toEqual(expect.arrayContaining(['deliver']));
      expect(stageUndoAction(job), state).toBeNull();
    }
  });

  it('names the step to retry from, or says only "Retry" when it is unknown', () => {
    for (const [step, name] of [
      [1, 'Brief'],
      [2, 'Transcribe'],
      [4, 'Plan'],
      [8, 'Render'],
    ] as const) {
      const job = makeJob({ state: 'failed', failedAt: step, error: 'x' });
      expect(nextStepAction(job)).toEqual({ kind: 'retry', label: `Retry from ${name}` });
    }
    const unknown = makeJob({ state: 'failed', failedAt: null, error: 'x' });
    expect(nextStepAction(unknown)).toEqual({ kind: 'retry', label: 'Retry' });
  });

  it('a generated job that stopped in Generate retries from Generate', () => {
    for (const error of [
      generateErrorMessage('balance_empty'),
      generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }),
      'Generate stopped: it was stopped.',
    ]) {
      const job = makeJob({ state: 'failed', failedAt: 1, error });
      expect(nextStepAction(job)).toEqual({ kind: 'retry', label: 'Retry from Generate' });
      expect(menuActions(job).map((action) => action.label)).toContain('Retry from Generate');
    }
    // A failure of the Brief itself, and any later failure, keep their step.
    const brief = makeJob({ state: 'failed', failedAt: 1, error: 'Disk is full.' });
    expect(nextStepAction(brief)).toEqual({ kind: 'retry', label: 'Retry from Brief' });
  });

  it('offers Retry even when the failed job has no error text to copy', () => {
    for (const error of [null, '']) {
      const job = makeJob({ state: 'failed', failedAt: 8, error });
      expect(nextStepAction(job)?.kind).toBe('retry');
    }
  });
});

describe('menuActions: the actions of the right-click menu', () => {
  const labels = (id: string) => menuActions(canvasJob(id)).map((action) => action.label);
  const kinds = (id: string) => menuActions(canvasJob(id)).map((action) => action.kind);

  it.each([
    ['j1', 'arriving', ['Start now', 'Hold']],
    ['j2', 'queued', ['Hold']],
    ['j3', 'held', ['Release']],
    ['j5', 'editing', ['Cancel…']],
    ['j6', 'ready', ['Mark delivered', 'Download MP4']],
    ['j7', 'failed', ['Retry from Render', 'Copy error']],
    ['j8', 'cancelled', ['Resume']],
  ] as const)('%s (%s): %j', (id, state, expected) => {
    expect(canvasJob(id).state).toBe(state);
    expect(labels(id)).toEqual(expected);
  });

  it('maps each item to its action', () => {
    expect(kinds('j1')).toEqual(['start', 'hold']);
    expect(kinds('j2')).toEqual(['hold']);
    expect(kinds('j3')).toEqual(['release']);
    expect(kinds('j5')).toEqual(['cancel']);
    expect(kinds('j6')).toEqual(['deliver', 'download']);
    expect(kinds('j7')).toEqual(['retry', 'copy']);
    expect(kinds('j8')).toEqual(['resume']);
  });

  it('only ever offers a server action the state machine allows (can)', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, failedAt: 8, error: 'boom' });
      const offered = menuActions(job).flatMap((action) =>
        action.kind === 'download' ||
        action.kind === 'copy' ||
        action.kind === 'deliver' ||
        action.kind === 'pay'
          ? []
          : [action.kind],
      );
      // Approve is not among the state's actions: the right-click menu adds it after Review…
      // (`approveAction`), and the sheet's ⋯ menu leaves it out.
      expect(offered.sort(), state).toEqual(
        JOB_ACTIONS.filter(
          (action) =>
            !(REVIEW_DIALOG_ACTIONS as readonly string[]).includes(action) &&
            action !== 'approve' &&
            can(job, action),
        ).sort(),
      );
    }
  });

  it('holds everything the right column offers, except Download, which it repeats, and Review, which the menu leads with itself', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, failedAt: 8, error: 'boom' });
      const button = nextStepAction(job);
      if (button === null || button.kind === 'review') continue;
      expect(
        menuActions(job).map((a) => a.kind),
        state,
      ).toContain(button.kind);
    }
  });

  it('offers Start now only to an arriving job', () => {
    for (const state of JOB_STATES) {
      const offered = menuActions(makeJob({ state })).some((action) => action.kind === 'start');
      expect(offered, state).toBe(state === 'arriving');
    }
  });

  it('copies the full error text, not a shortened one', () => {
    const error =
      'Render stopped: not enough disk space. Needs about 4 GB free on Macintosh HD.\nSee the job log.';
    const actions = menuActions(makeJob({ state: 'failed', failedAt: 8, error }));
    expect(actions.at(-1)).toEqual({ kind: 'copy', label: 'Copy error', text: error });
  });

  it('has no Copy error when there is no error text to copy, and only on failed jobs', () => {
    for (const error of [null, '']) {
      const actions = menuActions(makeJob({ state: 'failed', failedAt: 8, error }));
      expect(actions.map((a) => a.kind)).toEqual(['retry']);
    }
    for (const state of JOB_STATES.filter((s) => s !== 'failed')) {
      const kindsOf = menuActions(makeJob({ state, error: 'old error' })).map((a) => a.kind);
      expect(kindsOf, state).not.toContain('copy');
    }
  });

  it('holds the next step and Download MP4 for each stage of a ready job', () => {
    expect(menuActions(approved).map((a) => [a.kind, a.label])).toEqual([
      ['deliver', 'Mark delivered'],
      ['download', 'Download MP4'],
    ]);
    expect(menuActions(delivered).map((a) => [a.kind, a.label])).toEqual([
      ['pay', 'Mark paid…'],
      ['download', 'Download MP4'],
    ]);
    expect(menuActions(paid).map((a) => [a.kind, a.label])).toEqual([['download', 'Download MP4']]);
  });

  it('holds Mark paid…, Open reel and Download MP4 for an uploaded job, in that order', () => {
    expect(menuActions(uploaded)).toEqual([
      { kind: 'pay', label: 'Mark paid…' },
      { kind: 'reel', label: 'Open reel', href: REEL.reelUrl },
      { kind: 'download', label: 'Download MP4', href: '/api/jobs/u1/download' },
    ]);
  });

  it('opens the reel of a paid job a reel is linked to as well', () => {
    expect(menuActions(paidAndLinked).map((a) => a.kind)).toEqual(['reel', 'download']);
  });

  it('has no Open reel without an address for it, and an editor keeps it (it is not money)', () => {
    const noLink = makeJob({
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery({ uploadedAt: REEL.uploadedAt }),
    });
    expect(menuActions(noLink).map((a) => a.kind)).toEqual(['pay', 'download']);
    expect(menuActions(uploaded, false).map((a) => a.kind)).toEqual(['reel', 'download']);
  });

  it('encodes a download id that is not URL-safe', () => {
    const odd = makeJob({ id: 'a b/c', state: 'ready' });
    expect(menuActions(odd).at(-1)).toMatchObject({ href: '/api/jobs/a%20b%2Fc/download' });
  });

  it('offers Download MP4 only for ready jobs, as a link to the job', () => {
    expect(menuActions(canvasJob('j6')).at(-1)).toEqual({
      kind: 'download',
      label: 'Download MP4',
      href: '/api/jobs/j6/download',
    });
    for (const state of JOB_STATES.filter((s) => s !== 'ready')) {
      expect(
        menuActions(makeJob({ state })).map((a) => a.kind),
        state,
      ).not.toContain('download');
    }
  });
});

describe('stageUndoAction: the way back from a stage, at the bottom of the menu', () => {
  it('is Not delivered yet for a delivered job and Not paid yet for a paid one', () => {
    expect(stageUndoAction(delivered)).toEqual({ kind: 'undeliver', label: 'Not delivered yet' });
    expect(stageUndoAction(paid)).toEqual({ kind: 'unpay', label: 'Not paid yet' });
  });

  it('is nothing for an uploaded job: Not delivered yet is not offered while a reel is linked', () => {
    expect(stageUndoAction(uploaded)).toBeNull();
    expect(stageUndoAction({ ...approvedInReview, delivery: makeJobDelivery(REEL) })).toBeNull();
  });

  it('is still Not paid yet for a paid job a reel is linked to: it goes back to Uploaded', () => {
    expect(stageUndoAction(paidAndLinked)).toEqual({ kind: 'unpay', label: 'Not paid yet' });
  });

  it('is nothing for a ready job that was never approved: there is no approval to take back', () => {
    expect(stageUndoAction(approved)).toBeNull();
  });

  it('is Unapprove for a video that was approved and not delivered', () => {
    expect(stageUndoAction(approvedInReview)).toEqual({ kind: 'unapprove', label: 'Unapprove' });
  });

  it('is Not delivered yet or Not paid yet, never Unapprove, once the video was delivered', () => {
    const delivery = makeJobDelivery();
    expect(stageUndoAction({ ...approvedInReview, delivery })?.kind).toBe('undeliver');
    expect(
      stageUndoAction({ ...approvedInReview, delivery: makeJobDelivery({ paidOn: '2026-10-23' }) })
        ?.kind,
    ).toBe('unpay');
  });

  it('is never a button or a menu action of the state: Unapprove is the menu’s last item only', () => {
    expect(nextStepAction(approvedInReview)?.kind).toBe('deliver');
    expect(menuActions(approvedInReview).map((action) => action.kind)).toEqual([
      'deliver',
      'download',
    ]);
  });
});

describe('Send notes belongs to the review dialog, Approve to the right-click menu (the owner, 31 Oct)', () => {
  it('Send notes is the one action of the review dialog', () => {
    expect(REVIEW_DIALOG_ACTIONS).toEqual(['send_notes']);
  });

  it('Approve is offered for a job in Review only, and never as the right column’s button', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, preview: { durationSec: 28.4, width: 1080, height: 1920 } });
      expect(approveAction(job), state).toEqual(
        state === 'review' ? { kind: 'approve', label: 'Approve' } : null,
      );
      expect(nextStepAction(job)?.kind, state).not.toBe('approve');
      expect(
        menuActions(job).map((action) => action.kind),
        state,
      ).not.toContain('approve');
    }
  });

  it('Send notes is never offered by the right column or the menu, in any state', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({
        state,
        failedAt: 8,
        error: 'boom',
        preview: { durationSec: 28.4, width: 1080, height: 1920 },
      });
      const kinds = [nextStepAction(job), ...menuActions(job)].flatMap((action) =>
        action === null ? [] : [action.kind],
      );
      for (const kind of kinds) {
        expect(REVIEW_DIALOG_ACTIONS as readonly string[], state).not.toContain(kind);
      }
    }
  });

  it('give a review job the Review button, which opens a dialog, and an empty list of server actions', () => {
    const job = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });
    expect(nextStepAction(job)).toEqual({ kind: 'review', label: 'Review' });
    expect(menuActions(job)).toEqual([]);
  });
});

describe('Review: the right column of a job in review', () => {
  it('has the labels of the button and of the menu item', () => {
    expect(REVIEW_LABELS).toEqual({ button: 'Review', menu: 'Review…' });
  });

  it('is offered only to a review job', () => {
    for (const state of JOB_STATES) {
      const offered = nextStepAction(makeJob({ state }))?.kind === 'review';
      expect(offered, state).toBe(state === 'review');
    }
  });

  it('is not a server action: it has no entry in the state machine', () => {
    expect(JOB_ACTIONS as readonly string[]).not.toContain('review');
  });
});
