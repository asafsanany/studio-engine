import { type Job, type OrphanDelivery, orphanAsJob } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from './api';
import {
  applyStageChange,
  deliverJobMutationOptions,
  MARK_PAID_MUTATION_KEY,
  markPaidMutationOptions,
  undeliverJobMutationOptions,
  undoPaidMutationOptions,
} from './delivery-mutations';
import { JOB_ACTION_MUTATION_KEY } from './job-action';
import { JOBS_KEY } from './jobs-cache';
import { ORPHANS_KEY } from './orphan-deliveries';
import {
  BASE_URL,
  createTestQueryClient,
  deliveryHandlers,
  makeJob,
  makeJobDelivery,
  makeOrphanDelivery,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const ready = (id: string, delivery: Job['delivery'] = null) =>
  makeJob({ id, state: 'ready', placeInLine: null, delivery });

let queryClient: QueryClient;
let jobs: Job[];
beforeEach(() => {
  queryClient = createTestQueryClient();
  jobs = [
    ready('a'),
    ready('b', makeJobDelivery()),
    ready('c', makeJobDelivery({ paidOn: '2026-10-23' })),
  ];
  queryClient.setQueryData<Job[]>(JOBS_KEY, jobs);
  server.use(...deliveryHandlers(jobs));
});

const cached = (id: string) =>
  queryClient.getQueryData<Job[]>(JOBS_KEY)?.find((job) => job.id === id);
const stale = () => queryClient.getQueryState(JOBS_KEY)?.isInvalidated;

describe('deliverJobMutationOptions', () => {
  const run = (id: string) =>
    new MutationObserver(queryClient, deliverJobMutationOptions({ queryClient, api })).mutate(id);

  it('puts the job the server answers with, delivered, over the cached one, and reloads the list', async () => {
    const result = await run('a');
    expect(result.delivery).toEqual(makeJobDelivery());
    expect(cached('a')?.delivery).toEqual(makeJobDelivery());
    expect(stale()).toBe(true);
  });

  it('leaves the other jobs alone', async () => {
    await run('a');
    expect(cached('b')).toEqual(jobs[1]);
  });

  it('is a job action by key, with the job id as its variable: a stale event cannot flip it back', () => {
    const options = deliverJobMutationOptions({ queryClient, api });
    expect(options.mutationKey).toEqual([JOB_ACTION_MUTATION_KEY, 'deliver']);
  });

  it('keeps the cache and reloads it when the server refuses (409)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, () =>
        HttpResponse.json({ error: 'This job was delivered already.' }, { status: 409 }),
      ),
    );
    await expect(run('b')).rejects.toMatchObject({
      status: 409,
      message: 'This job was delivered already.',
    });
    expect(cached('b')).toEqual(jobs[1]);
    expect(stale()).toBe(true);
  });
});

describe('undeliverJobMutationOptions', () => {
  const run = (id: string) =>
    new MutationObserver(queryClient, undeliverJobMutationOptions({ queryClient, api })).mutate(id);

  it('puts the job back to approved in the cached list', async () => {
    await run('b');
    expect(cached('b')?.delivery).toBeNull();
    expect(stale()).toBe(true);
  });

  it('is refused for a paid job, and the list is reloaded', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () =>
        HttpResponse.json({ error: 'A paid job cannot be undelivered.' }, { status: 409 }),
      ),
    );
    await expect(run('c')).rejects.toMatchObject({ status: 409 });
    expect(cached('c')?.delivery?.paidOn).toBe('2026-10-23');
    expect(stale()).toBe(true);
  });

  it('has its own key, so it is a different refusal from Mark delivered', () => {
    expect(undeliverJobMutationOptions({ queryClient, api }).mutationKey).toEqual([
      JOB_ACTION_MUTATION_KEY,
      'undeliver',
    ]);
  });
});

describe('undoPaidMutationOptions', () => {
  const run = (id: string) =>
    new MutationObserver(queryClient, undoPaidMutationOptions({ queryClient, api })).mutate(id);

  it('sends the one job’s id to Not paid yet and clears its paid day in the cached list', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/payments/undo`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          jobs: [{ ...jobs[2], delivery: makeJobDelivery() }],
          orphans: [],
        });
      }),
    );
    await run('c');
    expect(bodies).toEqual([{ jobIds: ['c'] }]);
    expect(cached('c')?.delivery?.paidOn).toBeNull();
    expect(stale()).toBe(true);
  });

  it('is refused for a job that is not paid (409)', async () => {
    await expect(run('a')).rejects.toMatchObject({ status: 409 });
    expect(cached('a')?.delivery).toBeNull();
  });

  it('has its own key', () => {
    expect(undoPaidMutationOptions({ queryClient, api }).mutationKey).toEqual([
      JOB_ACTION_MUTATION_KEY,
      'unpay',
    ]);
  });
});

describe('markPaidMutationOptions', () => {
  const run = (jobIds: string[], paidOn = '2026-10-23') =>
    new MutationObserver(queryClient, markPaidMutationOptions({ queryClient, api })).mutate({
      jobIds,
      paidOn,
    });

  it('sends the ids and the day to Mark paid and puts every paid job in the cached list', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/payments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          jobs: ['a', 'b'].map((id) => ({
            ...cached(id),
            delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
          })),
          orphans: [],
        });
      }),
    );
    const paid = await run(['a', 'b']);
    expect(bodies).toEqual([{ jobIds: ['a', 'b'], paidOn: '2026-10-23' }]);
    expect(paid.map((job) => job.delivery?.paidOn)).toEqual(['2026-10-23', '2026-10-23']);
    expect(cached('a')?.delivery?.paidOn).toBe('2026-10-23');
    expect(cached('b')?.delivery?.paidOn).toBe('2026-10-23');
    expect(cached('c')).toEqual(jobs[2]);
    expect(stale()).toBe(true);
  });

  it('keeps the cache and reloads it when the server refuses (409), with its words in the error', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments`, () =>
        HttpResponse.json({ error: 'Nothing was changed: c is paid already.' }, { status: 409 }),
      ),
    );
    await expect(run(['b', 'c'])).rejects.toMatchObject({
      status: 409,
      message: 'Nothing was changed: c is paid already.',
    });
    expect(cached('b')).toEqual(jobs[1]);
    expect(stale()).toBe(true);
  });

  it('has a key of its own: its variable is several jobs, not the id a job action has', () => {
    expect(markPaidMutationOptions({ queryClient, api }).mutationKey).toEqual([
      MARK_PAID_MUTATION_KEY,
    ]);
    expect(MARK_PAID_MUTATION_KEY).not.toBe(JOB_ACTION_MUTATION_KEY);
  });
});

describe('applyStageChange', () => {
  it('replaces every job it is given and reloads the list', () => {
    const changed = [
      { ...jobs[0], delivery: makeJobDelivery() },
      { ...jobs[1], delivery: null },
    ];
    applyStageChange(queryClient, changed as Job[]);
    expect(cached('a')?.delivery).toEqual(makeJobDelivery());
    expect(cached('b')?.delivery).toBeNull();
    expect(cached('c')).toEqual(jobs[2]);
    expect(stale()).toBe(true);
  });

  it('does not invent a list: with none cached, there is nothing to replace', () => {
    const empty = createTestQueryClient();
    applyStageChange(empty, [jobs[0] as Job]);
    expect(empty.getQueryData(JOBS_KEY)).toBeUndefined();
  });
});

describe('a video whose folder was deleted (CVP-204)', () => {
  let orphans: OrphanDelivery[];
  beforeEach(() => {
    orphans = [makeOrphanDelivery({ id: 'x' }), makeOrphanDelivery({ id: 'y', name: 'Other' })];
    queryClient.setQueryData<OrphanDelivery[]>(ORPHANS_KEY, orphans);
    server.use(...deliveryHandlers(jobs, { orphans }));
  });

  const listed = () => queryClient.getQueryData<OrphanDelivery[]>(ORPHANS_KEY)?.map((o) => o.id);

  describe('applyStageChange', () => {
    it('keeps it out of the job list, and puts it in the list of such videos', () => {
      const paid = orphanAsJob({
        ...makeOrphanDelivery({ id: 'x' }),
        delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
      });

      applyStageChange(queryClient, [paid]);

      expect(queryClient.getQueryData<Job[]>(JOBS_KEY)?.map((job) => job.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
      // Paid: it leaves the Jobs page.
      expect(listed()).toEqual(['y']);
      expect(queryClient.getQueryState(ORPHANS_KEY)?.isInvalidated).toBe(true);
    });

    it('does not touch the list of such videos for jobs that have a folder', () => {
      applyStageChange(queryClient, [{ ...jobs[0], delivery: makeJobDelivery() } as Job]);

      expect(listed()).toEqual(['x', 'y']);
      expect(queryClient.getQueryState(ORPHANS_KEY)?.isInvalidated).toBe(false);
    });
  });

  describe('markPaidMutationOptions', () => {
    it('marks it paid and takes it off the page', async () => {
      const paid = await new MutationObserver(
        queryClient,
        markPaidMutationOptions({ queryClient, api }),
      ).mutate({ jobIds: ['x', 'b'], paidOn: '2026-10-23' });

      expect(paid.map((job) => job.id)).toEqual(['x', 'b']);
      expect(listed()).toEqual(['y']);
      expect(cached('b')?.delivery?.paidOn).toBe('2026-10-23');
    });
  });

  describe('undoPaidMutationOptions', () => {
    it('takes a paid one back into the list of such videos (the page’s Undo of a payment)', async () => {
      orphans[0] = {
        ...orphans[0],
        delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
      } as OrphanDelivery;
      queryClient.setQueryData<OrphanDelivery[]>(ORPHANS_KEY, [orphans[1] as OrphanDelivery]);

      await new MutationObserver(queryClient, undoPaidMutationOptions({ queryClient, api })).mutate(
        'x',
      );

      expect(listed()).toEqual(['x', 'y']);
    });
  });

  describe('undeliverJobMutationOptions', () => {
    it('deletes the delivery and takes the video off the page', async () => {
      const after = await new MutationObserver(
        queryClient,
        undeliverJobMutationOptions({ queryClient, api }),
      ).mutate('x');

      expect(after.delivery).toBeNull();
      expect(listed()).toEqual(['y']);
      expect(orphans.map((o) => o.id)).toEqual(['y']);
      // It never entered the job list.
      expect(cached('x')).toBeUndefined();
    });
  });
});
