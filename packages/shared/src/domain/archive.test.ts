import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_MAX_IDS,
  archiveJobsRequestSchema,
  archiveJobsResponseSchema,
  unarchiveJobsRequestSchema,
  unarchiveJobsResponseSchema,
} from './api.ts';
import { ARCHIVE_BLOCKED_STATES, canArchive, isArchived } from './archive.ts';
import { jobSchema } from './job.ts';
import { JOB_STATES } from './status.ts';
import { makeJob } from './test-fixtures.ts';

describe('the states a job cannot be archived in', () => {
  it('are the ones the engine is working on or about to work on', () => {
    expect(ARCHIVE_BLOCKED_STATES).toEqual(['arriving', 'queued', 'editing']);
  });
});

describe('canArchive', () => {
  const ARCHIVABLE = ['held', 'review', 'ready', 'failed', 'cancelled'];

  it.each(JOB_STATES)('says %s', (state) => {
    expect(canArchive(makeJob({ state }))).toBe(ARCHIVABLE.includes(state));
  });

  it('leaves no state out', () => {
    const blocked = JOB_STATES.filter((state) => !canArchive({ state }));
    expect(blocked).toEqual([...ARCHIVE_BLOCKED_STATES]);
  });

  it('does not look at anything but the state (an archived job is as archivable as before)', () => {
    expect(canArchive(makeJob({ state: 'ready', archivedAt: '2026-10-21T10:00:00.000Z' }))).toBe(
      true,
    );
  });
});

describe('isArchived', () => {
  it('is true once the job has an archive date, and false without', () => {
    expect(isArchived(makeJob())).toBe(false);
    expect(isArchived(makeJob({ archivedAt: '2026-10-21T10:00:00.000Z' }))).toBe(true);
  });
});

describe('Job.archivedAt', () => {
  it('is an ISO time or null, and the job is not valid without it', () => {
    expect(jobSchema.parse(makeJob()).archivedAt).toBeNull();
    const at = '2026-10-21T10:00:00.000Z';
    expect(jobSchema.parse(makeJob({ archivedAt: at })).archivedAt).toBe(at);

    const { archivedAt: _omitted, ...without } = makeJob();
    expect(jobSchema.safeParse(without).success).toBe(false);
    expect(jobSchema.safeParse({ ...makeJob(), archivedAt: 'yesterday' }).success).toBe(false);
    expect(jobSchema.safeParse({ ...makeJob(), archivedAt: 1_792_000_000_000 }).success).toBe(
      false,
    );
  });
});

describe.each([
  ['archive', archiveJobsRequestSchema, archiveJobsResponseSchema],
  ['unarchive', unarchiveJobsRequestSchema, unarchiveJobsResponseSchema],
])('the %s request and response', (_name, request, response) => {
  it('take from 1 to 200 ids', () => {
    expect(ARCHIVE_MAX_IDS).toBe(200);
    expect(request.parse({ ids: ['a'] })).toEqual({ ids: ['a'] });
    const most = Array.from({ length: ARCHIVE_MAX_IDS }, (_, i) => `job${i}`);
    expect(request.parse({ ids: most }).ids).toHaveLength(ARCHIVE_MAX_IDS);
    expect(request.safeParse({ ids: [...most, 'one more'] }).success).toBe(false);
    expect(request.safeParse({ ids: [] }).success).toBe(false);
  });

  it('refuse an id named twice', () => {
    expect(request.safeParse({ ids: ['a', 'b', 'a'] }).success).toBe(false);
  });

  it.each([
    ['no ids', {}],
    ['another name', { jobIds: ['a'] }],
    ['a bare id', { ids: 'a' }],
    ['an empty id', { ids: [''] }],
    ['a number', { ids: [1] }],
    ['null', { ids: null }],
    ['a list', ['a']],
    ['nothing', undefined],
  ])('refuse %s', (_label, body) => {
    expect(request.safeParse(body).success).toBe(false);
  });

  it('are answered with { jobs }', () => {
    const jobs = [
      makeJob({ id: 'a', archivedAt: '2026-10-21T10:00:00.000Z' }),
      makeJob({ id: 'b' }),
    ];
    expect(response.parse({ jobs })).toEqual({ jobs });
    expect(response.parse({ jobs: [] })).toEqual({ jobs: [] });
    expect(response.safeParse({ jobs: [{ id: 'a' }] }).success).toBe(false);
    expect(response.safeParse(jobs).success).toBe(false);
  });
});
