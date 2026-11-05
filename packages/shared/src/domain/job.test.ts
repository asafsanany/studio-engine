import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Effort } from './effort.ts';
import type { GenerateState } from './generate.ts';
import {
  groupOf,
  type InputCounts,
  inputCountsSchema,
  isoTimestampSchema,
  JOB_STAGES,
  type Job,
  type JobDelivery,
  type JobOutput,
  type JobPreview,
  jobDeliverySchema,
  jobOutputSchema,
  jobPreviewSchema,
  jobSchema,
  jobStage,
  REVISE_TIERS,
  type ReviseTier,
  reviseTierSchema,
  withoutJobMoney,
} from './job.ts';
import type { RunKind } from './run-kind.ts';
import { JOB_STATES, STATUS_GROUPS } from './status.ts';
import {
  hebrewJob,
  jobsByState,
  makeGenerateState,
  makeJob,
  SAMPLE_PREVIEW,
} from './test-fixtures.ts';

const valid = {
  inputCounts: { video: 14, audio: 1, image: 0, doc: 1 },
  output: {
    fileName: 'Client/Job.mp4',
    durationSec: 45.2,
    width: 1080,
    height: 1920,
    sizeBytes: 65_011_712,
  },
};

describe('isoTimestampSchema', () => {
  it.each([
    '2026-10-20T13:41:00.000Z',
    '2026-10-20T13:41:00Z',
    new Date('2026-10-20T13:41:00Z').toISOString(),
  ])('accepts %s', (value) => {
    expect(isoTimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-10-20',
    '2026-10-20 13:41:00',
    '2026-13-45T00:00:00Z',
    'Tue 20 Oct 2026, 13:41',
    '',
    1_792_503_660_000,
    null,
  ])('rejects %j', (value) => {
    expect(isoTimestampSchema.safeParse(value).success).toBe(false);
  });
});

describe('InputCounts', () => {
  it('parses all four counts', () => {
    expect(inputCountsSchema.parse(valid.inputCounts)).toEqual(valid.inputCounts);
    expect(inputCountsSchema.parse({ video: 0, audio: 0, image: 0, doc: 0 })).toEqual({
      video: 0,
      audio: 0,
      image: 0,
      doc: 0,
    });
  });

  it.each(['video', 'audio', 'image', 'doc'] as const)('requires %s', (key) => {
    const { [key]: _omitted, ...rest } = valid.inputCounts;
    expect(inputCountsSchema.safeParse(rest).success).toBe(false);
  });

  it.each([-1, 1.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a count of %j',
    (n) => {
      expect(inputCountsSchema.safeParse({ ...valid.inputCounts, video: n }).success).toBe(false);
    },
  );

  it('infers four numbers', () => {
    expectTypeOf<InputCounts>().toEqualTypeOf<{
      video: number;
      audio: number;
      image: number;
      doc: number;
    }>();
  });
});

describe('JobOutput', () => {
  it('parses a complete output', () => {
    expect(jobOutputSchema.parse(valid.output)).toEqual(valid.output);
  });

  it.each(['fileName', 'durationSec', 'width', 'height', 'sizeBytes'] as const)(
    'requires %s',
    (key) => {
      const { [key]: _omitted, ...rest } = valid.output;
      expect(jobOutputSchema.safeParse(rest).success).toBe(false);
    },
  );

  it.each([
    { fileName: '' },
    { durationSec: -1 },
    { width: 0 },
    { width: 1080.5 },
    { height: -1920 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
  ])('rejects %j', (override) => {
    expect(jobOutputSchema.safeParse({ ...valid.output, ...override }).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<JobOutput>().toEqualTypeOf<{
      fileName: string;
      durationSec: number;
      width: number;
      height: number;
      sizeBytes: number;
      outputs?: { format: string; fileName: string; bytes: number }[] | undefined;
    }>();
  });
});

describe('JobPreview', () => {
  const preview = { durationSec: 28.4, width: 1080, height: 1920 };

  it('parses a valid preview', () => {
    expect(jobPreviewSchema.parse(preview)).toEqual(preview);
    expect(jobPreviewSchema.parse(SAMPLE_PREVIEW)).toEqual(SAMPLE_PREVIEW);
  });

  it.each([
    { durationSec: 0 },
    { durationSec: -1 },
    { width: 0 },
    { width: 1080.5 },
    { height: 0 },
    { height: -1920 },
  ])('rejects %j', (override) => {
    expect(jobPreviewSchema.safeParse({ ...preview, ...override }).success).toBe(false);
  });

  it.each(['durationSec', 'width', 'height'] as const)('requires %s', (key) => {
    const { [key]: _omitted, ...rest } = preview;
    expect(jobPreviewSchema.safeParse(rest).success).toBe(false);
  });

  it('infers its shape', () => {
    expectTypeOf<JobPreview>().toEqualTypeOf<{
      durationSec: number;
      width: number;
      height: number;
    }>();
  });
});

describe('Job', () => {
  it.each(JOB_STATES)('parses a valid %s job unchanged', (state) => {
    const job = jobsByState[state];
    expect(jobSchema.parse(job)).toEqual(job);
  });

  it('keeps Hebrew and mixed-direction names exactly', () => {
    const parsed = jobSchema.parse(hebrewJob);
    expect(parsed.clientId).toBe('4d337086919d');
    expect(parsed.client).toBe('מאפיית הצפון');
    expect(parsed.name).toBe('סרטון גיוס – Hiring video');
    expect(parsed.relPath).toBe('מאפיית הצפון/סרטון גיוס – Hiring video');
  });

  it('survives a JSON round trip (what the API and SSE send)', () => {
    for (const job of Object.values(jobsByState)) {
      expect(jobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
    }
  });

  it('accepts sub-progress texts from every step', () => {
    for (const subProgress of ['6/14', 'graphics 2/5', 'pass 2/3']) {
      expect(jobSchema.safeParse(makeJob({ state: 'editing', subProgress })).success).toBe(true);
    }
  });

  it('keeps a note as it is, Hebrew and line breaks included', () => {
    const note = 'Keep it under 30 seconds.\nתשתמש בטייק השני של הפתיחה';
    expect(jobSchema.parse(makeJob({ note })).note).toBe(note);
  });

  it('accepts a fractional ETA and a zero ETA', () => {
    expect(jobSchema.safeParse(makeJob({ etaSec: 12.5 })).success).toBe(true);
    expect(jobSchema.safeParse(makeJob({ etaSec: 0 })).success).toBe(true);
  });

  it('strips unknown fields instead of failing, so the server can add fields later', () => {
    const parsed = jobSchema.parse({ ...makeJob(), footageSeconds: 90 });
    expect(parsed).not.toHaveProperty('footageSeconds');
  });

  it('requires every field, including the nullable ones', () => {
    const job = makeJob();
    for (const key of Object.keys(job)) {
      const { [key as keyof Job]: _omitted, ...rest } = job;
      expect(jobSchema.safeParse(rest).success, `missing ${key}`).toBe(false);
    }
  });

  it.each([
    ['unknown state', { state: 'paused' }],
    ['step 0', { step: 0 }],
    ['step 9', { step: 9 }],
    ['fractional step', { step: 2.5 }],
    ['failedAt 10', { failedAt: 10 }],
    ['stoppedAt "Plan"', { stoppedAt: 'Plan' }],
    ['negative ETA', { etaSec: -1 }],
    ['placeInLine 0 (it is 1-based)', { placeInLine: 0 }],
    ['fractional placeInLine', { placeInLine: 1.5 }],
    ['empty id', { id: '' }],
    ['empty clientId', { clientId: '' }],
    ['empty client', { client: '' }],
    ['empty name', { name: '' }],
    ['empty relPath', { relPath: '' }],
    ['empty subProgress (use null)', { subProgress: '' }],
    ['empty error (use null)', { error: '' }],
    ['empty note (use null)', { note: '' }],
    ['numeric note', { note: 5 }],
    ['non-ISO settlesAt', { settlesAt: '20 Oct 2026' }],
    ['non-ISO addedAt', { addedAt: '2026-10-20' }],
    ['non-ISO lastChangeAt', { lastChangeAt: '2026-10-20' }],
    ['null lastChangeAt (a job always has one)', { lastChangeAt: null }],
    ['non-ISO settledAt', { settledAt: '20 Oct 2026' }],
    ['non-ISO heldSettledAt', { heldSettledAt: '20 Oct 2026' }],
    ['numeric updatedAt', { updatedAt: 1_792_503_660_000 }],
    ['negative sizeBytes', { sizeBytes: -5 }],
    ['fractional sizeBytes', { sizeBytes: 10.5 }],
    ['inputs missing a key', { inputs: { video: 1, audio: 0, image: 0 } }],
    ['negative input count', { inputs: { video: -1, audio: 0, image: 0, doc: 0 } }],
    ['output with a bad size', { output: { ...valid.output, sizeBytes: -1 } }],
    ['undefined instead of null', { output: undefined }],
    ['runKind "final"', { runKind: 'final' }],
    ['a review effort that is not a level', { reviewEffort: 'auto' }],
    ['a review effort of Max', { reviewEffort: 'max' }],
    ['a revise tier of quick (it is fixed in Review, never run on Send)', { reviseTier: 'quick' }],
    ['undefined instead of null for the review effort', { reviewEffort: undefined }],
    ['negative round', { round: -1 }],
    ['fractional round', { round: 1.5 }],
    ['preview with width 0', { preview: { durationSec: 28.4, width: 0, height: 1920 } }],
    ['preview with a missing key', { preview: { durationSec: 28.4, width: 1080 } }],
    ['non-ISO approvedAt', { approvedAt: '20 Oct 2026' }],
    ['undefined preview instead of null', { preview: undefined }],
    ['undefined delivery instead of null', { delivery: undefined }],
    [
      'delivery paid on a day that does not exist',
      { delivery: { ...DELIVERED, paidOn: '2026-02-30' } },
    ],
  ])('rejects %s', (_label, override) => {
    expect(jobSchema.safeParse({ ...makeJob(), ...override }).success).toBe(false);
  });

  it('has Auto (null) as the review effort and no revise tier until a Send with Auto', () => {
    const job = makeJob();
    expect(job.reviewEffort).toBeNull();
    expect(job.reviseTier).toBeNull();
    for (const reviewEffort of ['medium', 'high', 'xhigh'] as const) {
      expect(jobSchema.parse(makeJob({ reviewEffort })).reviewEffort).toBe(reviewEffort);
    }
    for (const reviseTier of REVISE_TIERS) {
      expect(jobSchema.parse(makeJob({ reviseTier })).reviseTier).toBe(reviseTier);
    }
    expect(REVISE_TIERS).toEqual(['revise', 'full']);
    expect(reviseTierSchema.safeParse('quick').success).toBe(false);
  });

  it('carries the Generate stage of a generated job, and has none for any other', () => {
    // Absent, not null: every other job's wire shape is what it always was.
    expect(makeJob()).not.toHaveProperty('generate');
    expect(jobSchema.parse(makeJob())).not.toHaveProperty('generate');
    const generate = makeGenerateState();
    expect(jobSchema.parse(makeJob({ generate })).generate).toEqual(generate);
    expect(jobSchema.parse(makeJob({ generate: null })).generate).toBeNull();
    expect(
      jobSchema.safeParse(makeJob({ generate: { ...generate, phase: 'x' as never } })).success,
    ).toBe(false);
    expectTypeOf<Job['generate']>().toEqualTypeOf<GenerateState | null | undefined>();
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'job', 42, [], [makeJob()]]) {
      expect(jobSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('infers nullable fields as T | null (never optional)', () => {
    expectTypeOf<Job['step']>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | null>();
    expectTypeOf<Job['failedAt']>().toEqualTypeOf<Job['step']>();
    expectTypeOf<Job['stoppedAt']>().toEqualTypeOf<Job['step']>();
    expectTypeOf<Job['subProgress']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['etaSec']>().toEqualTypeOf<number | null>();
    expectTypeOf<Job['placeInLine']>().toEqualTypeOf<number | null>();
    expectTypeOf<Job['settlesAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['error']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['output']>().toEqualTypeOf<JobOutput | null>();
    expectTypeOf<Job['note']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['inputs']>().toEqualTypeOf<InputCounts>();
    expectTypeOf<Job['settledAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['heldSettledAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['lastChangeAt']>().toEqualTypeOf<string>();
    expectTypeOf<Job['updatedAt']>().toEqualTypeOf<string>();
    expectTypeOf<Job['runKind']>().toEqualTypeOf<RunKind>();
    expectTypeOf<Job['round']>().toEqualTypeOf<number>();
    expectTypeOf<Job['preview']>().toEqualTypeOf<JobPreview | null>();
    expectTypeOf<Job['approvedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<Job['delivery']>().toEqualTypeOf<JobDelivery | null>();
    expectTypeOf<Job['reviewEffort']>().toEqualTypeOf<Effort | null>();
    expectTypeOf<Job['reviseTier']>().toEqualTypeOf<ReviseTier | null>();
  });
});

const DELIVERED: JobDelivery = {
  deliveredAt: '2026-10-21T15:00:00.000Z',
  price: 40,
  currency: 'ILS',
  paidOn: null,
};

/** A delivery a reel is linked to: posted on 20 Oct, with the reel's link. */
const UPLOADED: JobDelivery = {
  ...DELIVERED,
  uploadedAt: '2026-10-20T09:30:00.000Z',
  reelUrl: 'https://www.instagram.com/reel/C-rooftop/',
  reelPlays: 27_500,
};

describe('JobDelivery', () => {
  it('parses an unpaid and a paid delivery', () => {
    expect(jobDeliverySchema.parse(DELIVERED)).toEqual(DELIVERED);
    const paid = { ...DELIVERED, paidOn: '2026-10-23' };
    expect(jobDeliverySchema.parse(paid)).toEqual(paid);
  });

  it('parses the delivery an editor gets: the date alone, with no price, currency or pay day', () => {
    expect(jobDeliverySchema.parse({ deliveredAt: DELIVERED.deliveredAt })).toEqual({
      deliveredAt: DELIVERED.deliveredAt,
    });
    expect(jobDeliverySchema.safeParse({ price: 40 }).success).toBe(false);
  });

  it('parses the reel a delivery is linked to: when it was posted and its link, both optional', () => {
    expect(jobDeliverySchema.parse(UPLOADED)).toEqual(UPLOADED);
    expect(jobDeliverySchema.parse(DELIVERED)).toEqual(DELIVERED);
    expect(jobDeliverySchema.parse({ deliveredAt: DELIVERED.deliveredAt, reelUrl: 'x' })).toEqual({
      deliveredAt: DELIVERED.deliveredAt,
      reelUrl: 'x',
    });
  });

  it('parses the reel’s plays too, optional: a reel whose plays are not known has none', () => {
    expect(jobDeliverySchema.parse(UPLOADED).reelPlays).toBe(27_500);
    expect(jobDeliverySchema.parse({ ...UPLOADED, reelPlays: 0 }).reelPlays).toBe(0);
    const { reelPlays: _plays, ...unknown } = UPLOADED;
    expect(jobDeliverySchema.parse(unknown)).not.toHaveProperty('reelPlays');
  });

  it('rides on a job, and a job has none until it is marked delivered', () => {
    expect(makeJob().delivery).toBeNull();
    const job = makeJob({ state: 'ready', delivery: DELIVERED });
    expect(jobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
  });

  it.each([
    { deliveredAt: '2026-10-21' },
    { deliveredAt: 1_792_503_660_000 },
    { price: -1 },
    { price: '40' },
    { currency: '' },
    { paidOn: '2026-10-23T10:00:00.000Z' },
    { paidOn: '23/10/2026' },
    { paidOn: '2026-02-30' },
    { uploadedAt: '2026-10-20' },
    { uploadedAt: null },
    { reelUrl: '' },
    { reelPlays: -1 },
    { reelPlays: 1.5 },
    { reelPlays: '27.5K' },
  ])('rejects %j', (override) => {
    expect(jobDeliverySchema.safeParse({ ...DELIVERED, ...override }).success).toBe(false);
  });
});

describe('withoutJobMoney', () => {
  const paid = { ...DELIVERED, paidOn: '2026-10-23' };

  it('keeps only the delivery date, paid or not, and does not change the job it is given', () => {
    const job = makeJob({ state: 'ready', delivery: paid });
    const seen = withoutJobMoney(job);
    expect(seen.delivery).toEqual({ deliveredAt: DELIVERED.deliveredAt });
    expect(Object.keys(seen.delivery ?? {})).toEqual(['deliveredAt']);
    expect(seen).toEqual({ ...job, delivery: { deliveredAt: DELIVERED.deliveredAt } });
    expect(job.delivery).toEqual(paid);
  });

  it('keeps where the video went on Instagram: it is not money', () => {
    const job = makeJob({ state: 'ready', delivery: { ...UPLOADED, paidOn: '2026-10-23' } });
    const seen = withoutJobMoney(job);
    expect(seen.delivery).toEqual({
      deliveredAt: UPLOADED.deliveredAt,
      uploadedAt: UPLOADED.uploadedAt,
      reelUrl: UPLOADED.reelUrl,
      reelPlays: UPLOADED.reelPlays,
    });
    expect(jobSchema.parse(JSON.parse(JSON.stringify(seen)))).toEqual(seen);
    // No pay day to tell it is paid: an editor sees it Uploaded.
    expect(jobStage(seen)).toBe('uploaded');
  });

  it('leaves a job with no delivery as it is', () => {
    const job = makeJob({ state: 'ready', delivery: null });
    expect(withoutJobMoney(job)).toBe(job);
  });

  it('still parses as a job, and is Delivered (never Paid) however the job was paid', () => {
    const job = makeJob({ state: 'ready', delivery: paid });
    const seen = withoutJobMoney(job);
    expect(jobSchema.parse(JSON.parse(JSON.stringify(seen)))).toEqual(seen);
    expect(jobStage(seen)).toBe('delivered');
    expect(groupOf(seen)).toBe('delivered');
  });
});

describe('jobStage', () => {
  const ready = jobsByState.ready;

  it('is approved for a ready job that was not marked delivered', () => {
    expect(jobStage({ ...ready, delivery: null })).toBe('approved');
  });

  it('is delivered once it was marked delivered, and paid once it has a paid day', () => {
    expect(jobStage({ ...ready, delivery: DELIVERED })).toBe('delivered');
    expect(jobStage({ ...ready, delivery: { ...DELIVERED, paidOn: '2026-10-23' } })).toBe('paid');
  });

  it('is uploaded once a reel is linked to the delivered job (uploadedAt), until it is paid', () => {
    expect(jobStage({ ...ready, delivery: UPLOADED })).toBe('uploaded');
    // The reel's link alone is not the stage: the posted time is.
    expect(jobStage({ ...ready, delivery: { ...DELIVERED, reelUrl: 'https://x.test/' } })).toBe(
      'delivered',
    );
  });

  it('stays paid when a reel is linked to a paid job', () => {
    expect(jobStage({ ...ready, delivery: { ...UPLOADED, paidOn: '2026-10-23' } })).toBe('paid');
  });

  it('goes back to uploaded, not delivered, when an uploaded job is not paid after all', () => {
    const paid = { ...UPLOADED, paidOn: '2026-10-23' };
    expect(jobStage({ ...ready, delivery: { ...paid, paidOn: null, paidAmount: null } })).toBe(
      'uploaded',
    );
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'is null for a %s job, even when it still carries a delivery',
    (state) => {
      expect(jobStage(jobsByState[state])).toBeNull();
      expect(jobStage({ ...jobsByState[state], delivery: DELIVERED })).toBeNull();
      expect(
        jobStage({ ...jobsByState[state], delivery: { ...DELIVERED, paidOn: '2026-10-23' } }),
      ).toBeNull();
    },
  );

  it('gives each ready job exactly one of the four stages, in order', () => {
    expect(JOB_STAGES).toEqual(['approved', 'delivered', 'uploaded', 'paid']);
    expect(jobStage(ready)).toBe(JOB_STAGES[0]);
  });
});

describe('groupOf', () => {
  const PAID = { ...DELIVERED, paidOn: '2026-10-23' };

  it.each([
    ['arriving', 'progress'],
    ['queued', 'progress'],
    ['editing', 'progress'],
    ['review', 'review'],
    ['held', 'attention'],
    ['failed', 'attention'],
    ['cancelled', 'attention'],
  ] as const)('%s -> %s', (state, group) => {
    expect(groupOf(jobsByState[state])).toBe(group);
  });

  it('puts a ready job under its stage: approved, delivered, uploaded or paid', () => {
    const ready = jobsByState.ready;
    expect(groupOf({ ...ready, delivery: null })).toBe('approved');
    expect(groupOf({ ...ready, delivery: DELIVERED })).toBe('delivered');
    expect(groupOf({ ...ready, delivery: UPLOADED })).toBe('uploaded');
    expect(groupOf({ ...ready, delivery: PAID })).toBe('paid');
    expect(groupOf({ ...ready, delivery: { ...UPLOADED, paidOn: '2026-10-23' } })).toBe('paid');
  });

  it('ignores the delivery of a job that left ready (a retry, a new run)', () => {
    expect(groupOf({ ...jobsByState.editing, delivery: PAID })).toBe('progress');
    expect(groupOf({ ...jobsByState.review, delivery: DELIVERED })).toBe('review');
    expect(groupOf({ ...jobsByState.failed, delivery: DELIVERED })).toBe('attention');
  });

  it('puts every job in exactly one group, and every group has a job', () => {
    const jobs = [
      ...JOB_STATES.filter((state) => state !== 'ready').map((state) => jobsByState[state]),
      { ...jobsByState.ready, delivery: null },
      { ...jobsByState.ready, delivery: DELIVERED },
      { ...jobsByState.ready, delivery: UPLOADED },
      { ...jobsByState.ready, delivery: PAID },
    ];
    const groups = jobs.map((job) => groupOf(job));
    expect(new Set(groups)).toEqual(new Set(STATUS_GROUPS.filter((group) => group !== 'all')));
    for (const group of groups) expect(STATUS_GROUPS).toContain(group);
  });

  it('agrees with jobStage for a ready job', () => {
    for (const delivery of [null, DELIVERED, UPLOADED, PAID]) {
      const job = { ...jobsByState.ready, delivery };
      expect(groupOf(job)).toBe(jobStage(job));
    }
  });
});
