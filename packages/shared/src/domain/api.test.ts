import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AddNoteRequest,
  type ApiError,
  addNoteRequestSchema,
  apiErrorSchema,
  type DeleteNoteResponse,
  type DeliverResponse,
  deleteNoteResponseSchema,
  deliverResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type JobActionResponse,
  type JobListResponse,
  jobActionResponseSchema,
  jobListResponseSchema,
  type MarkPaidRequest,
  markPaidRequestSchema,
  type NoteListResponse,
  type NoteResponse,
  noteListResponseSchema,
  noteResponseSchema,
  orphanDeliveriesResponseSchema,
  PAYMENT_JOBS_MAX,
  PAYMENT_REFUSAL_REASONS,
  type PatchNoteRequest,
  type PaymentRefusedResponse,
  type PaymentResponse,
  patchNoteRequestSchema,
  paymentRefusalSchema,
  paymentRefusedResponseSchema,
  paymentResponseSchema,
  REVIEW_TIME_MAX_SEC,
  type ReviewTimeRequest,
  type ReviewTimeResponse,
  reviewTimeRequestSchema,
  reviewTimeResponseSchema,
  type SaveNoteRequest,
  type SaveNoteResponse,
  saveNoteRequestSchema,
  saveNoteResponseSchema,
  UNDELIVER_REFUSAL_REASONS,
  type UndeliverRefusedResponse,
  type UndoPaidRequest,
  undeliverRefusedResponseSchema,
  undeliverResponseSchema,
  undoPaidRequestSchema,
} from './api.ts';
import type { Job } from './job.ts';
import type { OrphanDelivery } from './orphan-delivery.ts';
import type { ReviewNote } from './review-note.ts';
import { jobsByState, makeJob, makeOrphanDelivery, makeReviewNote } from './test-fixtures.ts';

const ORPHAN = makeOrphanDelivery();

describe('GET /api/jobs', () => {
  it('parses a list of jobs, including the empty list', () => {
    const jobs = Object.values(jobsByState);
    expect(jobListResponseSchema.parse(jobs)).toEqual(jobs);
    expect(jobListResponseSchema.parse([])).toEqual([]);
  });

  it('rejects a list with one bad job, a non-array and a wrapped object', () => {
    expect(jobListResponseSchema.safeParse([makeJob(), { ...makeJob(), step: 9 }]).success).toBe(
      false,
    );
    expect(jobListResponseSchema.safeParse(makeJob()).success).toBe(false);
    expect(jobListResponseSchema.safeParse({ jobs: [makeJob()] }).success).toBe(false);
    expect(jobListResponseSchema.safeParse(null).success).toBe(false);
  });

  it('infers Job[]', () => {
    expectTypeOf<JobListResponse>().toEqualTypeOf<Job[]>();
  });
});

describe('POST /api/jobs/:id/:action', () => {
  it('parses the updated job', () => {
    const job = jobsByState.held;
    expect(jobActionResponseSchema.parse(job)).toEqual(job);
  });

  it('rejects the error body and a list', () => {
    expect(jobActionResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
    expect(jobActionResponseSchema.safeParse([makeJob()]).success).toBe(false);
  });

  it('infers Job', () => {
    expectTypeOf<JobActionResponse>().toEqualTypeOf<Job>();
  });
});

describe('PUT /api/jobs/:id/note', () => {
  it('parses { note } as it is, without trimming (the server does that)', () => {
    expect(saveNoteRequestSchema.parse({ note: '  Keep it short \n' })).toEqual({
      note: '  Keep it short \n',
    });
    expect(saveNoteRequestSchema.parse({ note: '' })).toEqual({ note: '' });
  });

  it.each([{}, { note: null }, { note: 5 }, { text: 'Keep it short' }, 'Keep it short', null, []])(
    'rejects the body %j',
    (value) => {
      expect(saveNoteRequestSchema.safeParse(value).success).toBe(false);
    },
  );

  it('answers with the job, whose note is shown', () => {
    const job = makeJob({ note: 'Keep it short' });
    expect(saveNoteResponseSchema.parse(job)).toEqual(job);
    expect(saveNoteResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });

  it('infers its shapes', () => {
    expectTypeOf<SaveNoteRequest>().toEqualTypeOf<{ note: string }>();
    expectTypeOf<SaveNoteResponse>().toEqualTypeOf<Job>();
  });
});

describe('POST /api/jobs/:id/review-time', () => {
  it.each([1, 15, 60])('accepts %d seconds', (sec) => {
    expect(reviewTimeRequestSchema.parse({ sec })).toEqual({ sec });
  });

  it.each([
    { sec: 0 },
    { sec: -1 },
    { sec: 61 },
    { sec: 1.5 },
    { sec: '5' },
    { sec: null },
    { sec: Number.NaN },
    {},
    5,
    null,
  ])('rejects the body %j', (value) => {
    expect(reviewTimeRequestSchema.safeParse(value).success).toBe(false);
  });

  it('allows at most REVIEW_TIME_MAX_SEC (60) seconds a time', () => {
    expect(REVIEW_TIME_MAX_SEC).toBe(60);
  });

  it('answers with the job’s total, a whole number of seconds', () => {
    expect(reviewTimeResponseSchema.parse({ reviewSec: 0 })).toEqual({ reviewSec: 0 });
    expect(reviewTimeResponseSchema.parse({ reviewSec: 305 })).toEqual({ reviewSec: 305 });
    expect(reviewTimeResponseSchema.safeParse({ reviewSec: -1 }).success).toBe(false);
    expect(reviewTimeResponseSchema.safeParse({ reviewSec: 1.5 }).success).toBe(false);
    expect(reviewTimeResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });

  it('infers its shapes', () => {
    expectTypeOf<ReviewTimeRequest>().toEqualTypeOf<{ sec: number }>();
    expectTypeOf<ReviewTimeResponse>().toEqualTypeOf<{ reviewSec: number }>();
  });
});

describe('review notes', () => {
  it('addNote accepts { atSec, text } as it is, even empty text (the server judges the text)', () => {
    expect(addNoteRequestSchema.parse({ atSec: 0, text: '' })).toEqual({ atSec: 0, text: '' });
    expect(addNoteRequestSchema.parse({ atSec: 2.4, text: '  The title.  ' })).toEqual({
      atSec: 2.4,
      text: '  The title.  ',
    });
  });

  it.each([
    {},
    { text: 'x' },
    { atSec: 1 },
    { atSec: -1, text: 'x' },
    { atSec: '1', text: 'x' },
    { atSec: 1, text: 5 },
    null,
    'x',
  ])('addNote rejects %j', (value) => {
    expect(addNoteRequestSchema.safeParse(value).success).toBe(false);
  });

  it('patchNote accepts each key alone and together', () => {
    expect(patchNoteRequestSchema.parse({ text: 'New' })).toEqual({ text: 'New' });
    expect(patchNoteRequestSchema.parse({ addToStyle: true })).toEqual({ addToStyle: true });
    expect(patchNoteRequestSchema.parse({ addToStyle: false })).toEqual({ addToStyle: false });
    expect(patchNoteRequestSchema.parse({ addToSeries: true })).toEqual({ addToSeries: true });
    expect(patchNoteRequestSchema.parse({ text: 'New', addToStyle: true })).toEqual({
      text: 'New',
      addToStyle: true,
    });
    expect(patchNoteRequestSchema.parse({ addToStyle: true, addToSeries: false })).toEqual({
      addToStyle: true,
      addToSeries: false,
    });
  });

  it.each([{}, { addToStyle: 'yes' }, { addToSeries: 1 }, { text: 5 }, { other: 1 }, null, 'x'])(
    'patchNote rejects %j',
    (value) => {
      expect(patchNoteRequestSchema.safeParse(value).success).toBe(false);
    },
  );

  it('the note list and a single note answer with notes', () => {
    const notes = [makeReviewNote(), makeReviewNote({ id: 'n2', atSec: 9 })];
    expect(noteListResponseSchema.parse(notes)).toEqual(notes);
    expect(noteListResponseSchema.parse([])).toEqual([]);
    expect(noteResponseSchema.parse(notes[0])).toEqual(notes[0]);
    expect(noteListResponseSchema.safeParse([{ ...makeReviewNote(), round: 0 }]).success).toBe(
      false,
    );
    expect(noteResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });

  it('delete answers exactly { ok: true }', () => {
    expect(deleteNoteResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(deleteNoteResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(deleteNoteResponseSchema.safeParse({}).success).toBe(false);
  });

  it('infers its shapes', () => {
    expectTypeOf<AddNoteRequest>().toEqualTypeOf<{
      atSec: number;
      text: string;
      format?: string | null | undefined;
    }>();
    expectTypeOf<PatchNoteRequest>().toEqualTypeOf<{
      text?: string;
      addToStyle?: boolean;
      addToSeries?: boolean;
    }>();
    expectTypeOf<NoteListResponse>().toEqualTypeOf<ReviewNote[]>();
    expectTypeOf<NoteResponse>().toEqualTypeOf<ReviewNote>();
    expectTypeOf<DeleteNoteResponse>().toEqualTypeOf<{ ok: true }>();
  });
});

describe('GET /api/health', () => {
  it('parses { ok, version, settleMs, series, jobSheet, analytics, phone, graphics, graphicsInEdits, music, luts, lutsInEdits, fonts, fontsInNotes, quickFixes }', () => {
    const health = {
      ok: true,
      version: '0.1.0',
      settleMs: 5000,
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
      quickFixes: false,
    };
    expect(healthResponseSchema.parse(health)).toEqual(health);
  });

  it('accepts a settle delay of 0, and every switch on', () => {
    expect(
      healthResponseSchema.safeParse({
        ok: true,
        version: '0.1.0',
        settleMs: 0,
        series: true,
        jobSheet: true,
        analytics: true,
        phone: true,
        graphics: true,
        graphicsInEdits: true,
        music: true,
        luts: true,
        lutsInEdits: true,
        fonts: true,
        fontsInNotes: true,
        quickFixes: true,
      }).success,
    ).toBe(true);
  });

  it('may say whether Songs are on, and reads an answer from before Songs', () => {
    const before = {
      ok: true,
      version: '0.1.0',
      settleMs: 5000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: true,
      luts: false,
      lutsInEdits: false,
      fonts: false,
      fontsInNotes: false,
      quickFixes: false,
    };
    expect(healthResponseSchema.parse(before)).toEqual(before);
    expect(healthResponseSchema.parse({ ...before, songs: true }).songs).toBe(true);
    expect(healthResponseSchema.parse({ ...before, songs: false }).songs).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, songs: 'on' }).success).toBe(false);
  });

  it('may say whether Generated videos are on, and reads an answer from before them', () => {
    const before = {
      ok: true,
      version: '0.1.0',
      settleMs: 5000,
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
      quickFixes: false,
    };
    expect(healthResponseSchema.parse(before)).toEqual(before);
    expect(healthResponseSchema.parse({ ...before, generate: true }).generate).toBe(true);
    expect(healthResponseSchema.parse({ ...before, generate: false }).generate).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, generate: 'on' }).success).toBe(false);
  });

  it('needs both graphics switches', () => {
    const before = {
      ok: true,
      version: '0.1.0',
      settleMs: 60_000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
    };
    expect(healthResponseSchema.safeParse(before).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, graphics: false }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...before, graphics: 'on', graphicsInEdits: false }).success,
    ).toBe(false);
  });

  it('needs the music switch, as a boolean', () => {
    const before = {
      ok: true,
      version: '0.1.0',
      settleMs: 60_000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
    };
    expect(healthResponseSchema.safeParse(before).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, music: 'on' }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({
        ...before,
        music: false,
        luts: false,
        lutsInEdits: false,
        fonts: false,
        fontsInNotes: false,
        quickFixes: false,
      }).success,
    ).toBe(true);
  });

  it('needs both LUTs switches, as booleans', () => {
    const before = {
      ok: true,
      version: '0.1.0',
      settleMs: 60_000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: false,
    };
    expect(healthResponseSchema.safeParse(before).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, luts: false }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...before, luts: 'on', lutsInEdits: false }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({
        ...before,
        luts: false,
        lutsInEdits: false,
        fonts: false,
        fontsInNotes: false,
        quickFixes: false,
      }).success,
    ).toBe(true);
  });

  it('needs both Fonts switches, as booleans', () => {
    const before = {
      ok: true,
      version: '0.1.0',
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
      quickFixes: false,
    };
    expect(healthResponseSchema.safeParse(before).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, fonts: false }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, fontsInNotes: false }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...before, fonts: 'on', fontsInNotes: false }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...before, fonts: false, fontsInNotes: 1 }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...before, fonts: false, fontsInNotes: false }).success,
    ).toBe(true);
    expect(
      healthResponseSchema.safeParse({ ...before, fonts: true, fontsInNotes: true }).success,
    ).toBe(true);
  });

  it('needs the Quick fixes switch, as a boolean', () => {
    const before = {
      ok: true,
      version: '0.1.0',
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
    };
    expect(healthResponseSchema.safeParse(before).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, quickFixes: 'on' }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...before, quickFixes: false }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ...before, quickFixes: true }).success).toBe(true);
  });

  it.each([
    {},
    { ok: true },
    { version: '0.1.0' },
    { settleMs: 60_000 },
    { ok: true, version: '0.1.0' },
    { ok: 'yes', version: '0.1.0', settleMs: 60_000 },
    { ok: true, version: '', settleMs: 60_000 },
    { ok: true, version: 1, settleMs: 60_000 },
    { ok: true, version: '0.1.0', settleMs: '60000' },
    { ok: true, version: '0.1.0', settleMs: -1 },
    { ok: true, version: '0.1.0', settleMs: 1.5 },
    { ok: true, version: '0.1.0', settleMs: 60_000 },
    { ok: true, version: '0.1.0', settleMs: 60_000, series: 'on' },
    { ok: true, version: '0.1.0', settleMs: 60_000, series: false },
    { ok: true, version: '0.1.0', settleMs: 60_000, jobSheet: false },
    { ok: true, version: '0.1.0', settleMs: 60_000, series: false, jobSheet: 'on' },
    { ok: true, version: '0.1.0', settleMs: 60_000, series: false, jobSheet: false },
    {
      ok: true,
      version: '0.1.0',
      settleMs: 60_000,
      series: false,
      jobSheet: false,
      analytics: 'on',
    },
    { ok: true, version: '0.1.0', settleMs: 60_000, series: false, jobSheet: false, phone: 'on' },
  ])('rejects %j', (value) => {
    expect(healthResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<HealthResponse>().toEqualTypeOf<{
      ok: boolean;
      version: string;
      settleMs: number;
      series: boolean;
      jobSheet: boolean;
      analytics: boolean;
      phone: boolean;
      graphics: boolean;
      graphicsInEdits: boolean;
      music: boolean;
      luts: boolean;
      lutsInEdits: boolean;
      fonts: boolean;
      fontsInNotes: boolean;
      quickFixes: boolean;
      songs?: boolean | undefined;
      generate?: boolean | undefined;
      draftChat?: boolean | undefined;
      instagram?: boolean | undefined;
      dms?: boolean | undefined;
      currencySymbol?: string | undefined;
    }>();
  });
});

describe('error responses', () => {
  it('parses { error }', () => {
    expect(apiErrorSchema.parse({ error: 'Cannot retry a job that is not failed.' })).toEqual({
      error: 'Cannot retry a job that is not failed.',
    });
  });

  it.each([{}, { error: '' }, { error: 409 }, { message: 'nope' }, 'nope', null])(
    'rejects %j',
    (value) => {
      expect(apiErrorSchema.safeParse(value).success).toBe(false);
    },
  );

  it('infers its shape', () => {
    expectTypeOf<ApiError>().toEqualTypeOf<{ error: string }>();
  });
});

describe('POST /api/jobs/:id/deliver and /undeliver', () => {
  it('answers with the job, delivered or not', () => {
    const delivered = makeJob({
      state: 'ready',
      delivery: {
        deliveredAt: '2026-10-21T09:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
      },
    });
    expect(deliverResponseSchema.parse(delivered)).toEqual(delivered);
    expect(deliverResponseSchema.parse(makeJob({ state: 'ready' }))).toEqual(
      makeJob({ state: 'ready' }),
    );
    expect(deliverResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
    expect(deliverResponseSchema.safeParse({ jobs: [delivered] }).success).toBe(false);
  });

  it('infers Job', () => {
    expectTypeOf<DeliverResponse>().toEqualTypeOf<Job>();
  });
});

describe('POST /api/jobs/:id/undeliver', () => {
  it('answers with the job, or with the delivery taken off when the folder is gone', () => {
    const job = makeJob({ state: 'ready' });
    expect(undeliverResponseSchema.parse(job)).toEqual(job);
    expect(undeliverResponseSchema.parse({ removed: ORPHAN })).toEqual({ removed: ORPHAN });
    expect(undeliverResponseSchema.safeParse({ removed: { id: 'x' } }).success).toBe(false);
    expect(undeliverResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });
});

describe('GET /api/deliveries/unpaid-without-job', () => {
  it('answers with the videos whose folder is gone', () => {
    expect(orphanDeliveriesResponseSchema.parse({ orphans: [ORPHAN] })).toEqual({
      orphans: [ORPHAN],
    });
    expect(orphanDeliveriesResponseSchema.parse({ orphans: [] })).toEqual({ orphans: [] });
    expect(orphanDeliveriesResponseSchema.safeParse([ORPHAN]).success).toBe(false);
    expect(orphanDeliveriesResponseSchema.safeParse({ orphans: [makeJob()] }).success).toBe(false);
  });
});

describe('POST /api/payments', () => {
  it('parses { jobIds, paidOn }', () => {
    expect(markPaidRequestSchema.parse({ jobIds: ['a', 'b'], paidOn: '2026-10-23' })).toEqual({
      jobIds: ['a', 'b'],
      paidOn: '2026-10-23',
    });
  });

  it('takes one job, PAYMENT_JOBS_MAX (200) jobs and a leap day', () => {
    expect(PAYMENT_JOBS_MAX).toBe(200);
    const ids = Array.from({ length: PAYMENT_JOBS_MAX }, (_, i) => `job${i}`);
    expect(markPaidRequestSchema.safeParse({ jobIds: ['a'], paidOn: '2026-10-23' }).success).toBe(
      true,
    );
    expect(markPaidRequestSchema.safeParse({ jobIds: ids, paidOn: '2026-10-23' }).success).toBe(
      true,
    );
    expect(markPaidRequestSchema.safeParse({ jobIds: ['a'], paidOn: '2028-02-29' }).success).toBe(
      true,
    );
  });

  it('takes what was paid for some of the videos, 0 included', () => {
    const body = { jobIds: ['a', 'b'], paidOn: '2026-10-23', amounts: { a: 0, b: 37.5 } };
    expect(markPaidRequestSchema.parse(body)).toEqual(body);
    expect(
      markPaidRequestSchema.safeParse({ jobIds: ['a', 'b'], paidOn: '2026-10-23', amounts: {} })
        .success,
    ).toBe(true);
  });

  it.each([
    [{ paidOn: '2026-10-23' }],
    [{ jobIds: ['a'] }],
    [{ jobIds: [], paidOn: '2026-10-23' }],
    [{ jobIds: 'a', paidOn: '2026-10-23' }],
    [{ jobIds: [1], paidOn: '2026-10-23' }],
    [{ jobIds: [''], paidOn: '2026-10-23' }],
    [{ jobIds: ['a', 'a'], paidOn: '2026-10-23' }],
    [{ jobIds: Array.from({ length: 201 }, (_, i) => `job${i}`), paidOn: '2026-10-23' }],
    [{ jobIds: ['a'], paidOn: '2026-02-30' }],
    [{ jobIds: ['a'], paidOn: '2027-02-29' }],
    [{ jobIds: ['a'], paidOn: '23/10/2026' }],
    [{ jobIds: ['a'], paidOn: '2026-10-23T10:00:00Z' }],
    [{ jobIds: ['a'], paidOn: 20261023 }],
    [{ jobIds: ['a'], paidOn: null }],
    [{ jobIds: ['a'], paidOn: '2026-10-23', amounts: { a: -1 } }],
    [{ jobIds: ['a'], paidOn: '2026-10-23', amounts: { a: '40' } }],
    [{ jobIds: ['a'], paidOn: '2026-10-23', amounts: { b: 40 } }],
    [{ jobIds: ['a'], paidOn: '2026-10-23', amounts: [40] }],
    [null],
    [[]],
  ])('rejects the body %j', (value) => {
    expect(markPaidRequestSchema.safeParse(value).success).toBe(false);
  });

  it('answers with the jobs, and with the videos whose folder is gone', () => {
    const jobs = [makeJob(), makeJob({ id: 'second' })];
    expect(paymentResponseSchema.parse({ jobs, orphans: [] })).toEqual({ jobs, orphans: [] });
    expect(paymentResponseSchema.parse({ jobs: [], orphans: [ORPHAN] })).toEqual({
      jobs: [],
      orphans: [ORPHAN],
    });
    expect(paymentResponseSchema.safeParse({ jobs }).success).toBe(false);
    expect(paymentResponseSchema.safeParse(jobs).success).toBe(false);
    expect(paymentResponseSchema.safeParse({ jobs: [{ id: 'x' }], orphans: [] }).success).toBe(
      false,
    );
    expect(paymentResponseSchema.safeParse({ jobs: [], orphans: [{ id: 'x' }] }).success).toBe(
      false,
    );
  });

  it('infers its shapes', () => {
    expectTypeOf<MarkPaidRequest>().toEqualTypeOf<{
      jobIds: string[];
      paidOn: string;
      amounts?: Record<string, number> | undefined;
    }>();
    expectTypeOf<PaymentResponse>().toEqualTypeOf<{ jobs: Job[]; orphans: OrphanDelivery[] }>();
  });
});

describe('POST /api/payments/undo', () => {
  it('parses { jobIds } and nothing else is needed', () => {
    expect(undoPaidRequestSchema.parse({ jobIds: ['a', 'b'] })).toEqual({ jobIds: ['a', 'b'] });
  });

  it.each([
    [{}],
    [{ jobIds: [] }],
    [{ jobIds: 'a' }],
    [{ jobIds: ['a', 'a'] }],
    [{ jobIds: [null] }],
    [{ jobIds: Array.from({ length: 201 }, (_, i) => `job${i}`) }],
    [null],
  ])('rejects the body %j', (value) => {
    expect(undoPaidRequestSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<UndoPaidRequest>().toEqualTypeOf<{ jobIds: string[] }>();
  });
});

describe('the 409 of Not delivered yet for a video on Instagram', () => {
  it('is an error that also names the reason', () => {
    const body = {
      error: 'This video is on Instagram: unlink the reel on the client page first.',
      reason: 'uploaded',
    };
    expect(undeliverRefusedResponseSchema.parse(body)).toEqual(body);
    expect(apiErrorSchema.parse(body)).toEqual({ error: body.error });
    expect(UNDELIVER_REFUSAL_REASONS).toEqual(['uploaded']);
  });

  it.each([
    [{ error: 'x' }],
    [{ reason: 'uploaded' }],
    [{ error: 'x', reason: 'whatever' }],
    [{ error: '', reason: 'uploaded' }],
  ])('rejects %j', (value) => {
    expect(undeliverRefusedResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<UndeliverRefusedResponse>().toEqualTypeOf<{ error: string; reason: 'uploaded' }>();
  });
});

describe('the 409 of the payment routes', () => {
  it('is an error that also names the jobs that stopped it', () => {
    const body = {
      error: 'Nothing was changed: Spring menu is not delivered yet.',
      refused: [{ jobId: 'a', reason: 'not-delivered' }],
    };
    expect(paymentRefusedResponseSchema.parse(body)).toEqual(body);
    expect(apiErrorSchema.parse(body)).toEqual({ error: body.error });
  });

  it('knows the three reasons', () => {
    expect(PAYMENT_REFUSAL_REASONS).toEqual(['not-delivered', 'already-paid', 'not-paid']);
    for (const reason of PAYMENT_REFUSAL_REASONS) {
      expect(paymentRefusalSchema.safeParse({ jobId: 'a', reason }).success).toBe(true);
    }
    expect(paymentRefusalSchema.safeParse({ jobId: 'a', reason: 'whatever' }).success).toBe(false);
  });

  it.each([
    [{ error: 'x' }],
    [{ error: 'x', refused: [] }],
    [{ refused: [{ jobId: 'a', reason: 'not-paid' }] }],
    [{ error: 'x', refused: [{ jobId: '', reason: 'not-paid' }] }],
  ])('rejects %j', (value) => {
    expect(paymentRefusedResponseSchema.safeParse(value).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<PaymentRefusedResponse>().toEqualTypeOf<{
      error: string;
      refused: { jobId: string; reason: 'not-delivered' | 'already-paid' | 'not-paid' }[];
    }>();
  });
});
