import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  JOB_REVEAL_MESSAGES,
  type JobStepRun,
  type JobStepsResponse,
  jobStepRunSchema,
  jobStepsResponseSchema,
  type RevealJobResponse,
  revealJobResponseSchema,
  type SentNotesResponse,
  sentNotesResponseSchema,
} from './job-steps.ts';
import type { ReviewNote } from './review-note.ts';
import type { RunKind } from './run-kind.ts';
import type { StepId } from './steps.ts';

const run = {
  step: 4,
  runKind: 'revise',
  round: 1,
  startedAt: '2026-10-22T12:11:00.000Z',
  endedAt: '2026-10-22T12:13:00.000Z',
} as const;

describe('jobStepRunSchema', () => {
  it('parses a finished run and a running one', () => {
    expect(jobStepRunSchema.parse(run)).toEqual(run);
    const running = { ...run, endedAt: null };
    expect(jobStepRunSchema.parse(running)).toEqual(running);
  });

  it('takes every step, every kind of run and round 0', () => {
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(jobStepRunSchema.safeParse({ ...run, step }).success, `step ${step}`).toBe(true);
    }
    for (const runKind of ['edit', 'revise', 'render']) {
      expect(jobStepRunSchema.safeParse({ ...run, runKind }).success, runKind).toBe(true);
    }
    expect(jobStepRunSchema.safeParse({ ...run, round: 0 }).success).toBe(true);
  });

  it.each([
    ['a step outside 1 to 8', { ...run, step: 0 }],
    ['a step above 8', { ...run, step: 9 }],
    ['a step as text', { ...run, step: '4' }],
    ['an unknown kind of run', { ...run, runKind: 'final' }],
    ['a negative round', { ...run, round: -1 }],
    ['a fractional round', { ...run, round: 1.5 }],
    ['a start that is not a timestamp', { ...run, startedAt: 'yesterday' }],
    ['a start without a zone', { ...run, startedAt: '2026-10-22T12:11:00' }],
    ['no start', { ...run, startedAt: undefined }],
    ['an end that is not a timestamp', { ...run, endedAt: 'soon' }],
    ['an end left out (null is the open run)', { ...run, endedAt: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(jobStepRunSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<JobStepRun>().toEqualTypeOf<{
      step: StepId;
      runKind: RunKind;
      round: number;
      startedAt: string;
      endedAt: string | null;
    }>();
  });
});

describe('jobStepsResponseSchema (GET /api/jobs/:id/steps)', () => {
  it('parses { jobId, runs }', () => {
    const body = { jobId: 'a1b2c3d4e5f6', runs: [run, { ...run, step: 5, endedAt: null }] };
    expect(jobStepsResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a job that has not started: no runs', () => {
    expect(jobStepsResponseSchema.parse({ jobId: 'a1b2c3d4e5f6', runs: [] })).toEqual({
      jobId: 'a1b2c3d4e5f6',
      runs: [],
    });
  });

  it.each([
    ['no job id', { runs: [] }],
    ['an empty job id', { jobId: '', runs: [] }],
    ['no runs', { jobId: 'a1b2c3d4e5f6' }],
    ['runs that are not a list', { jobId: 'a1b2c3d4e5f6', runs: run }],
    ['a run that does not fit', { jobId: 'a1b2c3d4e5f6', runs: [{ ...run, step: 12 }] }],
    ['the 404 body', { error: 'Job a1b2c3d4e5f6 not found' }],
  ])('rejects %s', (_name, value) => {
    expect(jobStepsResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<JobStepsResponse>().toEqualTypeOf<{ jobId: string; runs: JobStepRun[] }>();
  });
});

describe('revealJobResponseSchema (POST /api/jobs/:id/reveal)', () => {
  it('parses a file and a folder reveal', () => {
    expect(revealJobResponseSchema.parse({ ok: true, revealed: 'file' })).toEqual({
      ok: true,
      revealed: 'file',
    });
    expect(revealJobResponseSchema.parse({ ok: true, revealed: 'folder' })).toEqual({
      ok: true,
      revealed: 'folder',
    });
  });

  it.each([
    ['no revealed', { ok: true }],
    ['a revealed that is neither', { ok: true, revealed: 'disk' }],
    ['ok false', { ok: false, revealed: 'file' }],
    ['no ok', { revealed: 'file' }],
    ['the client reveal body', { ok: true }],
    ['an error body', { error: 'The job folder is missing.' }],
  ])('rejects %s', (_name, value) => {
    expect(revealJobResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<RevealJobResponse>().toEqualTypeOf<{ ok: true; revealed: 'file' | 'folder' }>();
  });
});

describe('JOB_REVEAL_MESSAGES', () => {
  it('has the words the plan gives the two refusals', () => {
    expect(JOB_REVEAL_MESSAGES).toEqual({
      folderMissing: 'The job folder is missing.',
      couldNotOpen: 'Could not open it in Finder.',
    });
  });
});

const sentNote: ReviewNote = {
  id: 'n-1',
  jobId: 'a1b2c3d4e5f6',
  round: 1,
  atSec: 12.4,
  kind: 'text',
  text: 'The title goes too fast.',
  audioFile: null,
  audioSec: null,
  transcriptStatus: null,
  addToStyle: false,
  addToSeries: false,
  createdAt: '2026-10-22T12:20:00.000Z',
  sentAt: '2026-10-22T12:31:00.000Z',
  routeStatus: null,
  route: null,
  fixId: null,
  fixedAt: null,
};

describe('sentNotesResponseSchema (GET /api/jobs/:id/sent-notes)', () => {
  it('parses { jobId, notes } with sent notes of any kind', () => {
    const voice: ReviewNote = {
      ...sentNote,
      id: 'n-2',
      round: 2,
      kind: 'voice',
      text: 'Cut the pause.',
      audioFile: 'n-2.webm',
      audioSec: 6.5,
      transcriptStatus: 'done',
    };
    const body = { jobId: 'a1b2c3d4e5f6', notes: [sentNote, voice] };
    expect(sentNotesResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a job that has sent nothing: no notes', () => {
    const body = { jobId: 'a1b2c3d4e5f6', notes: [] };
    expect(sentNotesResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['no job id', { notes: [] }],
    ['an empty job id', { jobId: '', notes: [] }],
    ['no notes', { jobId: 'a1b2c3d4e5f6' }],
    ['notes that are not a list', { jobId: 'a1b2c3d4e5f6', notes: sentNote }],
    ['a note that does not fit', { jobId: 'a1b2c3d4e5f6', notes: [{ ...sentNote, kind: 'sms' }] }],
    ['the plain notes list', [sentNote]],
    ['the 404 body', { error: 'Job a1b2c3d4e5f6 not found' }],
  ])('rejects %s', (_name, value) => {
    expect(sentNotesResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<SentNotesResponse>().toEqualTypeOf<{ jobId: string; notes: ReviewNote[] }>();
  });
});
