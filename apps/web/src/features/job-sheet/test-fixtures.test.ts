import { createHash } from 'node:crypto';
import {
  FIRST_STEP_BY_RUN_KIND,
  groupOf,
  jobSchema,
  jobStage,
  jobStepRunSchema,
  jobStepsResponseSchema,
  reviewNoteSchema,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNotes,
  jobSheetNow,
  jobSheetRuns,
  jobSheetStepsResponse,
} from './test-fixtures';

// The fixtures are what wave 1 tests against, so they must be real: valid jobs, runs and notes
// that agree with each other the way the engine's would.

const shortHash = (text: string) =>
  createHash('sha1').update(text.normalize('NFC')).digest('hex').slice(0, 12);

describe('the job sheet fixtures', () => {
  it('has a job, runs, notes and a moment for each of the 13 states of the boards', () => {
    expect(JOB_SHEET_STATES).toHaveLength(13);
    for (const state of JOB_SHEET_STATES) {
      expect(jobSheetJobs[state], state).toBeDefined();
      expect(jobSheetRuns[state], state).toBeInstanceOf(Array);
      expect(jobSheetNotes[state], state).toBeInstanceOf(Array);
      expect(Number.isNaN(Date.parse(jobSheetNow[state])), state).toBe(false);
    }
    expect(jobSheetList.map((job) => job.id)).toEqual(
      JOB_SHEET_STATES.map((state) => jobSheetJobs[state].id),
    );
  });

  it('gives every job its own id: the hash of Client/Job the server would give it', () => {
    const ids = jobSheetList.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const job of jobSheetList) {
      expect(job.id, job.relPath).toBe(shortHash(job.relPath));
      expect(job.clientId, job.client).toBe(shortHash(job.client));
      expect(job.relPath).toBe(`${job.client}/${job.name}`);
    }
  });

  it('keeps the names of the boards, Hebrew and English, as they are', () => {
    expect(jobSheetJobs.arriving).toMatchObject({
      name: 'צילומי לקוחות – אוקטובר',
      client: 'LAKESHORE',
    });
    expect(jobSheetJobs.editing).toMatchObject({ name: 'מיתוס או אמת 6', client: 'עו״ד דוד לוי' });
    expect(jobSheetJobs.reviewRound2).toMatchObject({
      name: 'שאלות נפוצות 5',
      client: 'עו״ד דוד לוי',
    });
    expect(jobSheetJobs.rendering).toMatchObject({ name: 'חנוכה 2026', client: 'RGM' });
    expect(jobSheetJobs.paid).toMatchObject({ name: 'מיתוס או אמת 5', episode: 5 });
    expect(jobSheetJobs.archived).toMatchObject({ name: 'קמפיין קיץ', client: 'RGM' });
  });

  describe.each(JOB_SHEET_STATES)('%s', (state: JobSheetState) => {
    const job = jobSheetJobs[state];
    const runs = jobSheetRuns[state];
    const notes = jobSheetNotes[state];

    it('is a valid job, valid runs and valid sent notes', () => {
      expect(jobSchema.parse(job)).toEqual(job);
      for (const run of runs) expect(jobStepRunSchema.parse(run)).toEqual(run);
      for (const note of notes) expect(reviewNoteSchema.parse(note)).toEqual(note);
      expect(jobStepsResponseSchema.parse(jobSheetStepsResponse(state))).toEqual({
        jobId: job.id,
        runs,
      });
    });

    it('has runs oldest first, each ending after it started and before the next one starts', () => {
      runs.forEach((run, index) => {
        if (run.endedAt !== null) {
          expect(Date.parse(run.endedAt), `run ${index}`).toBeGreaterThanOrEqual(
            Date.parse(run.startedAt),
          );
        }
        const next = runs[index + 1];
        if (next !== undefined) {
          expect(Date.parse(next.startedAt), `run ${index + 1}`).toBeGreaterThanOrEqual(
            Date.parse(run.endedAt ?? run.startedAt),
          );
        }
      });
    });

    it('has notes that were all sent, in rounds the job went through', () => {
      for (const note of notes) {
        expect(note.jobId).toBe(job.id);
        expect(note.round).toBeGreaterThanOrEqual(1);
        expect(note.round).toBeLessThanOrEqual(job.round);
        expect(note.sentAt).not.toBeNull();
        expect(Date.parse(note.createdAt)).toBeLessThanOrEqual(Date.parse(note.sentAt ?? ''));
      }
      if (job.round > 0) expect(new Set(notes.map((note) => note.round)).size).toBe(job.round);
      else expect(notes).toEqual([]);
    });

    it('counts rounds the way the engine does: each revise run starts at Plan and is the next round', () => {
      const lastRun = runs.at(-1);
      if (lastRun === undefined) {
        expect(job.round).toBe(0);
        return;
      }
      // The first edit is round 0; each revise sequence begins at Plan and is the next round.
      const reviseRounds = [
        ...new Set(runs.filter((run) => run.runKind === 'revise').map((run) => run.round)),
      ];
      expect(reviseRounds).toEqual(Array.from({ length: reviseRounds.length }, (_, i) => i + 1));
      for (const round of reviseRounds) {
        const first = runs.find((run) => run.runKind === 'revise' && run.round === round);
        expect(first?.step, `round ${round}`).toBe(FIRST_STEP_BY_RUN_KIND.revise);
      }
      expect(runs.filter((run) => run.runKind === 'edit').every((run) => run.round === 0)).toBe(
        true,
      );
      // The job is on the round of its last run, and was last on the run kind of its last run.
      expect(job.round).toBe(lastRun.round);
      expect(job.runKind).toBe(lastRun.runKind);
      // A render run is the job's current round's.
      for (const run of runs.filter((r) => r.runKind === 'render')) {
        expect(run.round).toBe(job.round);
        expect(run.step).toBe(8);
      }
    });
  });

  it('leaves a step open only where the worker does: the running step, or the one a stop or a failure interrupted', () => {
    for (const state of JOB_SHEET_STATES) {
      const open = jobSheetRuns[state].filter((run) => run.endedAt === null);
      const job = jobSheetJobs[state];
      if (state === 'editing') expect(open.map((run) => run.step)).toEqual([job.step]);
      else if (state === 'rendering') expect(open.map((run) => run.step)).toEqual([8]);
      else if (state === 'failed') expect(open.map((run) => run.step)).toEqual([job.failedAt]);
      else if (state === 'cancelled') expect(open.map((run) => run.step)).toEqual([job.stoppedAt]);
      else expect(open, state).toEqual([]);
    }
  });

  it('puts each job where the boards put it', () => {
    const states = Object.fromEntries(JOB_SHEET_STATES.map((s) => [s, jobSheetJobs[s].state]));
    expect(states).toEqual({
      arriving: 'arriving',
      queued: 'queued',
      held: 'held',
      editing: 'editing',
      failed: 'failed',
      cancelled: 'cancelled',
      review: 'review',
      reviewRound2: 'review',
      rendering: 'editing',
      approved: 'ready',
      delivered: 'ready',
      paid: 'ready',
      archived: 'ready',
    });
    expect(groupOf(jobSheetJobs.rendering)).toBe('progress');
    expect(jobStage(jobSheetJobs.approved)).toBe('approved');
    expect(jobStage(jobSheetJobs.delivered)).toBe('delivered');
    expect(jobStage(jobSheetJobs.paid)).toBe('paid');
    expect(jobStage(jobSheetJobs.archived)).toBe('paid');
    expect(jobSheetJobs.archived.archivedAt).not.toBeNull();
    for (const state of JOB_SHEET_STATES.filter((s) => s !== 'archived')) {
      expect(jobSheetJobs[state].archivedAt, state).toBeNull();
    }
  });

  it('gives a finished job its export, an unfinished one none', () => {
    for (const state of JOB_SHEET_STATES) {
      const job = jobSheetJobs[state];
      expect(job.output !== null, state).toBe(job.state === 'ready');
    }
    expect(jobSheetJobs.approved.output).toMatchObject({
      durationSec: 30,
      width: 1080,
      height: 1920,
    });
  });

  it('draws each board at a moment that makes its sentences come out', () => {
    const minutes = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;
    const lastEnd = (state: JobSheetState) => jobSheetRuns[state].at(-1)?.endedAt ?? '';
    // "starts in 0:42"
    expect(
      Date.parse(jobSheetJobs.arriving.settlesAt ?? '') - Date.parse(jobSheetNow.arriving),
    ).toBe(42_000);
    // "waiting 9 min" and "waiting 26 min"
    expect(minutes(lastEnd('review'), jobSheetNow.review)).toBe(9);
    expect(minutes(lastEnd('reviewRound2'), jobSheetNow.reviewRound2)).toBe(26);
    // "~4 min left" and "~1 min left"
    expect(jobSheetJobs.editing.etaSec).toBe(240);
    expect(jobSheetJobs.rendering.etaSec).toBe(60);
  });

  it('has the sent notes of "Ready to review · round 2" as the board draws them', () => {
    const notes = jobSheetNotes.reviewRound2;
    expect(notes.map((note) => [note.atSec, note.kind, note.addToStyle, note.addToSeries])).toEqual(
      [
        [4, 'text', false, true],
        [19, 'voice', true, false],
        [33, 'text', false, false],
      ],
    );
    expect(notes[1]).toMatchObject({ audioSec: 7, transcriptStatus: 'done' });
    expect(notes.every((note) => note.sentAt === '2026-10-22T12:10:00.000Z')).toBe(true);
  });
});
