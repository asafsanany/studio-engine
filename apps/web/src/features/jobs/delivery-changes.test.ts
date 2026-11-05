import { type Job, orphanAsJob } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@/data/api';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  deliveryHandlers,
  makeJob,
  makeJobDelivery,
  makeOrphanDelivery,
} from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { afterDelivered, afterUndelivered, afterUnpaid } = await import('./delivery-changes');

// These run the real routes of the data layer against an MSW server: the message's Undo is a call
// to the opposite route, and what the server answers goes into the jobs list.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const UNPAID = makeJobDelivery();
const PAID = makeJobDelivery({ paidOn: '2026-10-23' });
const approved = makeJob({ id: 'job-a', state: 'ready', placeInLine: null, client: 'RGM' });

let queryClient: QueryClient;
let serverJobs: Job[];
beforeEach(() => {
  queryClient = createTestQueryClient();
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

const deps = () => ({ api, queryClient });

/** The Undo button of the message the last `toast(...)` call showed. */
function undoOfLastToast(): () => void {
  const [, options] = sonner.toast.mock.calls.at(-1) as [
    unknown,
    { action?: { onClick: () => void } },
  ];
  if (options.action === undefined) throw new Error('the message has no Undo');
  return options.action.onClick;
}

const cached = (id: string) =>
  queryClient.getQueryData<Job[]>(JOBS_KEY)?.find((job) => job.id === id);

/** The server holds `jobs`; the list the page has cached holds `listed`. */
function start(jobs: Job[], listed: Job[] = jobs) {
  serverJobs = jobs;
  queryClient.setQueryData<Job[]>(JOBS_KEY, listed);
  server.use(...deliveryHandlers(serverJobs));
}

describe('afterDelivered: "Delivered to RGM · ₪40 counts in October"', () => {
  it('tells it with Undo, and Undo calls Not delivered yet, which takes the delivery off the job', async () => {
    const delivered = { ...approved, delivery: UNPAID };
    start([delivered]);
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
    });

    afterDelivered(deps(), delivered);
    expect(sonner.toast).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);

    undoOfLastToast()();
    await vi.waitFor(() => expect(cached('job-a')?.delivery).toBeNull());

    expect(seen).toEqual(['POST /api/jobs/job-a/undeliver']);
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('says nothing more when Undo works: the row going back to Approved is the answer', async () => {
    const delivered = { ...approved, delivery: UNPAID };
    start([delivered]);
    afterDelivered(deps(), delivered);
    undoOfLastToast()();
    await vi.waitFor(() => expect(cached('job-a')?.delivery).toBeNull());
    expect(sonner.toast).toHaveBeenCalledOnce();
  });

  it('tells why when the server refuses the Undo (409: the job was paid meanwhile)', async () => {
    const delivered = { ...approved, delivery: UNPAID };
    start([delivered]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () =>
        HttpResponse.json(
          { error: 'A paid job cannot be taken back to approved.' },
          { status: 409 },
        ),
      ),
    );

    afterDelivered(deps(), delivered);
    undoOfLastToast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toBe('A paid job cannot be taken back to approved.');
    // The list is as it was.
    expect(cached('job-a')?.delivery).toEqual(UNPAID);
  });

  it('tells it when the server cannot be reached', async () => {
    const delivered = { ...approved, delivery: UNPAID };
    start([delivered]);
    server.use(http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () => HttpResponse.error()));

    afterDelivered(deps(), delivered);
    undoOfLastToast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toMatch(/reach/i);
  });
});

describe('afterUndelivered: "Back to Approved · ₪40 taken off October"', () => {
  it('tells it with Undo, and Undo calls Mark delivered again, which gives the job a delivery', async () => {
    const before = { ...approved, delivery: UNPAID };
    // Not delivered yet went through: the server and the page both have the job approved again.
    start([approved]);
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
    });

    afterUndelivered(deps(), before);
    expect(sonner.toast.mock.calls[0]?.[0]).toBe('Back to Approved · ₪40 taken off October');

    undoOfLastToast()();
    await vi.waitFor(() => expect(cached('job-a')?.delivery).toEqual(UNPAID));

    expect(seen).toEqual(['POST /api/jobs/job-a/deliver']);
  });

  it('tells why when the server refuses the Undo (409: the job is no longer ready)', async () => {
    const before = { ...approved, delivery: UNPAID };
    start([approved]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, () =>
        HttpResponse.json({ error: 'Only a ready job can be marked delivered.' }, { status: 409 }),
      ),
    );

    afterUndelivered(deps(), before);
    undoOfLastToast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toBe('Only a ready job can be marked delivered.');
    expect(cached('job-a')?.delivery).toBeNull();
  });
});

describe('afterUnpaid: "Back to Delivered · not paid yet"', () => {
  it('tells it with Undo, and Undo makes the payment again on the day it had', async () => {
    const before = { ...approved, delivery: PAID };
    // The server has cleared the payment; the page still lists the paid job.
    start([{ ...approved, delivery: UNPAID }], [before]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/payments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ jobs: [before] });
      }),
    );

    afterUnpaid(deps(), before);
    expect(sonner.toast.mock.calls[0]?.[0]).toBe('Back to Delivered · not paid yet');

    undoOfLastToast()();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies).toEqual([{ jobIds: ['job-a'], paidOn: '2026-10-23' }]);
    await vi.waitFor(() => expect(cached('job-a')?.delivery?.paidOn).toBe('2026-10-23'));
  });

  it('says "Back to Uploaded" for a video a reel is linked to', () => {
    const before = {
      ...approved,
      delivery: { ...PAID, uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: 'https://x.test/r/' },
    };
    start([{ ...approved, delivery: { ...before.delivery, paidOn: null } }], [before]);

    afterUnpaid(deps(), before);

    expect(sonner.toast.mock.calls[0]?.[0]).toBe('Back to Uploaded · not paid yet');
  });

  it('pays it again what had been paid for it, ₪0 included', async () => {
    const before = { ...approved, delivery: { ...PAID, paidAmount: 0 } };
    start([{ ...approved, delivery: UNPAID }], [before]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/payments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ jobs: [before], orphans: [] });
      }),
    );

    afterUnpaid(deps(), before);
    undoOfLastToast()();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies).toEqual([{ jobIds: ['job-a'], paidOn: '2026-10-23', amounts: { 'job-a': 0 } }]);
  });

  it('tells why when the server refuses the Undo (409: the job is not delivered any more)', async () => {
    const before = { ...approved, delivery: PAID };
    start([approved], [before]);

    afterUnpaid(deps(), before);
    undoOfLastToast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [title, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(title).toBeTruthy();
    expect(options.description).toContain('not delivered yet');
  });

  it('has no Undo when the job had no payment day to put back', () => {
    afterUnpaid(deps(), { ...approved, delivery: UNPAID });
    const [, options] = sonner.toast.mock.calls[0] as [unknown, { action?: unknown }];
    expect(options.action).toBeUndefined();
  });
});

describe('afterUndelivered for a video whose folder was deleted', () => {
  const gone = orphanAsJob(makeOrphanDelivery({ id: 'job-gone' }));

  it('tells that the delivery was removed, with no Undo, and asks the server for nothing', () => {
    start([]);
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
    });

    afterUndelivered(deps(), gone);

    expect(sonner.toast).toHaveBeenCalledOnce();
    const [, options] = sonner.toast.mock.calls[0] as [unknown, { action?: unknown }];
    expect(options.action).toBeUndefined();
    expect(sonner.toast.mock.calls[0]?.[0]).toBe('Delivery removed · ₪40 taken off October');
    expect(seen).toEqual([]);
  });
});
