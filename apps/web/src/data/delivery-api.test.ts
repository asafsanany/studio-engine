import { isFolderDeleted, type Job } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import {
  BASE_URL,
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

const approved = makeJob({ id: 'approved1', state: 'ready', placeInLine: null });
const delivered = makeJob({
  id: 'delivered1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery(),
});
const paid = makeJob({
  id: 'paid1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
});

/** What a request looked like when it reached the server. */
interface Seen {
  method: string;
  path: string;
  contentType: string | null;
  body: unknown;
}

async function seenOf(request: Request): Promise<Seen> {
  const text = await request.text();
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    contentType: request.headers.get('content-type'),
    body: text === '' ? undefined : JSON.parse(text),
  };
}

describe('deliverJob', () => {
  it('POSTs to /api/jobs/:id/deliver without a body and returns the job, now delivered', async () => {
    const seen: Seen[] = [];
    const answer = { ...approved, delivery: makeJobDelivery() };
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, async ({ request }) => {
        seen.push(await seenOf(request));
        return HttpResponse.json(answer);
      }),
    );

    await expect(api.deliverJob(approved.id)).resolves.toEqual(answer);

    expect(seen).toEqual([
      { method: 'POST', path: '/api/jobs/approved1/deliver', contentType: null, body: undefined },
    ]);
  });

  it('escapes the id', async () => {
    const paths: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json(delivered);
      }),
    );

    await api.deliverJob('a b/c');

    expect(paths).toEqual(['/api/jobs/a%20b%2Fc/deliver']);
  });

  it('keeps the explanation of a 409 and of a 404', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, ({ params }) =>
        params.id === 'gone'
          ? HttpResponse.json({ error: 'Job gone not found' }, { status: 404 })
          : HttpResponse.json(
              {
                error: 'Cannot mark a job delivered that is review: only an approved video can be.',
              },
              { status: 409 },
            ),
      ),
    );

    await expect(api.deliverJob('gone')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Job gone not found',
    });
    await expect(api.deliverJob('x')).rejects.toMatchObject({
      status: 409,
      message: 'Cannot mark a job delivered that is review: only an approved video can be.',
    });
  });

  it('rejects with an ApiError when the answer is not a job', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, () => HttpResponse.json({ jobs: [] })),
    );

    const error = await api.deliverJob('x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
  });

  it('rejects with an ApiError when the answer carries a delivery that does not fit', async () => {
    const bad = { ...approved, delivery: { ...makeJobDelivery(), paidOn: '2026-02-30' } };
    server.use(http.post(`${BASE_URL}/api/jobs/:id/deliver`, () => HttpResponse.json(bad)));

    await expect(api.deliverJob('x')).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/:id/deliver`, () => HttpResponse.error()));

    await expect(api.deliverJob('x')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });

  it('lets an abort through as an abort, not as an ApiError', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/deliver`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json(delivered);
      }),
    );
    const controller = new AbortController();

    const pending = api.deliverJob('x', controller.signal);
    controller.abort();

    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('undeliverJob', () => {
  it('POSTs to /api/jobs/:id/undeliver without a body and returns the job, delivery gone', async () => {
    const seen: Seen[] = [];
    const answer = { ...delivered, delivery: null };
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, async ({ request }) => {
        seen.push(await seenOf(request));
        return HttpResponse.json(answer);
      }),
    );

    await expect(api.undeliverJob(delivered.id)).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/api/jobs/delivered1/undeliver',
        contentType: null,
        body: undefined,
      },
    ]);
  });

  it('escapes the id', async () => {
    const paths: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json(approved);
      }),
    );

    await api.undeliverJob('a b/c');

    expect(paths).toEqual(['/api/jobs/a%20b%2Fc/undeliver']);
  });

  it('keeps the explanation of a 409', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () =>
        HttpResponse.json(
          { error: 'This video is marked paid: mark it not paid first.' },
          { status: 409 },
        ),
      ),
    );

    await expect(api.undeliverJob('x')).rejects.toMatchObject({
      status: 409,
      message: 'This video is marked paid: mark it not paid first.',
    });
  });

  it('rejects with an ApiError when the answer is not a job', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () => HttpResponse.json({ ok: true })),
    );

    await expect(api.undeliverJob('x')).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () => HttpResponse.error()));

    await expect(api.undeliverJob('x')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('markPaid', () => {
  it('POSTs { jobIds, paidOn } as JSON to /api/payments and returns the jobs, in the order asked', async () => {
    const seen: Seen[] = [];
    const answer = [
      { ...delivered, delivery: makeJobDelivery({ paidOn: '2026-10-23' }) },
      { ...approved, id: 'second', delivery: makeJobDelivery({ paidOn: '2026-10-23' }) },
    ];
    server.use(
      http.post(`${BASE_URL}/api/payments`, async ({ request }) => {
        seen.push(await seenOf(request));
        return HttpResponse.json({ jobs: answer, orphans: [] });
      }),
    );

    await expect(api.markPaid(['delivered1', 'second'], '2026-10-23')).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/api/payments',
        contentType: 'application/json',
        body: { jobIds: ['delivered1', 'second'], paidOn: '2026-10-23' },
      },
    ]);
  });

  it('takes a read-only list of ids and does not change it', async () => {
    const ids: readonly string[] = Object.freeze(['a', 'b']);
    server.use(
      http.post(`${BASE_URL}/api/payments`, () => HttpResponse.json({ jobs: [], orphans: [] })),
    );

    await expect(api.markPaid(ids, '2026-10-23')).resolves.toEqual([]);

    expect(ids).toEqual(['a', 'b']);
  });

  it('keeps the explanation of a 409, whatever else the body names', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments`, () =>
        HttpResponse.json(
          {
            error: 'Nothing was changed: Spring menu is not delivered yet.',
            refused: [{ jobId: 'a', reason: 'not-delivered' }],
          },
          { status: 409 },
        ),
      ),
    );

    const error = await api.markPaid(['a'], '2026-10-23').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Nothing was changed: Spring menu is not delivered yet.',
    });
  });

  it('keeps the explanation of a 400 and of a 404', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments`, async ({ request }) => {
        const { jobIds } = (await request.json()) as { jobIds: string[] };
        return jobIds[0] === 'gone'
          ? HttpResponse.json({ error: 'Job gone not found' }, { status: 404 })
          : HttpResponse.json({ error: 'Send the payment as JSON' }, { status: 400 });
      }),
    );

    await expect(api.markPaid(['gone'], '2026-10-23')).rejects.toMatchObject({
      status: 404,
      message: 'Job gone not found',
    });
    await expect(api.markPaid(['x'], 'tomorrow')).rejects.toMatchObject({
      status: 400,
      message: 'Send the payment as JSON',
    });
  });

  it('rejects with an ApiError when the answer is not { jobs }', async () => {
    server.use(http.post(`${BASE_URL}/api/payments`, () => HttpResponse.json([delivered])));

    const error = await api.markPaid(['a'], '2026-10-23').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
  });

  it('rejects with an ApiError when one of the jobs is not valid', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments`, () => HttpResponse.json({ jobs: [{ id: 'x' }] })),
    );

    await expect(api.markPaid(['x'], '2026-10-23')).rejects.toMatchObject({
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/payments`, () => HttpResponse.error()));

    await expect(api.markPaid(['a'], '2026-10-23')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });

  it('lets an abort through as an abort, not as an ApiError', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ jobs: [], orphans: [] });
      }),
    );
    const controller = new AbortController();

    const pending = api.markPaid(['a'], '2026-10-23', undefined, controller.signal);
    controller.abort();

    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('undoPaid', () => {
  it('POSTs { jobIds } as JSON to /api/payments/undo and returns the jobs', async () => {
    const seen: Seen[] = [];
    const answer = [{ ...paid, delivery: makeJobDelivery() }];
    server.use(
      http.post(`${BASE_URL}/api/payments/undo`, async ({ request }) => {
        seen.push(await seenOf(request));
        return HttpResponse.json({ jobs: answer, orphans: [] });
      }),
    );

    await expect(api.undoPaid(['paid1'])).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/api/payments/undo',
        contentType: 'application/json',
        body: { jobIds: ['paid1'] },
      },
    ]);
  });

  it('keeps the explanation of a 409', async () => {
    server.use(
      http.post(`${BASE_URL}/api/payments/undo`, () =>
        HttpResponse.json(
          {
            error: 'Nothing was changed: Spring menu is not paid.',
            refused: [{ jobId: 'a', reason: 'not-paid' }],
          },
          { status: 409 },
        ),
      ),
    );

    await expect(api.undoPaid(['a'])).rejects.toMatchObject({
      status: 409,
      message: 'Nothing was changed: Spring menu is not paid.',
    });
  });

  it('rejects with an ApiError when the answer is not { jobs }', async () => {
    server.use(http.post(`${BASE_URL}/api/payments/undo`, () => HttpResponse.json(paid)));

    await expect(api.undoPaid(['paid1'])).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/payments/undo`, () => HttpResponse.error()));

    await expect(api.undoPaid(['a'])).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('deliveryHandlers (the test helper)', () => {
  it('walks a job from approved to paid and back through the four calls', async () => {
    const jobs: Job[] = [approved, { ...approved, id: 'second' }];
    server.use(...deliveryHandlers(jobs));

    const afterDeliver = await api.deliverJob('approved1');
    expect(afterDeliver.delivery).toEqual(makeJobDelivery());
    await api.deliverJob('second');

    const afterPay = await api.markPaid(['second', 'approved1'], '2026-10-23');
    expect(afterPay.map((job) => [job.id, job.delivery?.paidOn])).toEqual([
      ['second', '2026-10-23'],
      ['approved1', '2026-10-23'],
    ]);

    const afterUndo = await api.undoPaid(['approved1']);
    expect(afterUndo[0]?.delivery).toEqual({ ...makeJobDelivery(), paidAmount: null });
    expect(jobs.find((job) => job.id === 'second')?.delivery?.paidOn).toBe('2026-10-23');

    const afterUndeliver = await api.undeliverJob('approved1');
    expect(afterUndeliver.delivery).toBeNull();
  });

  it('answers 404 for an unknown job and 409 for a payment on a video that is not delivered', async () => {
    server.use(...deliveryHandlers([approved]));

    await expect(api.deliverJob('nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.markPaid(['nope'], '2026-10-23')).rejects.toMatchObject({ status: 404 });
    await expect(api.markPaid(['approved1'], '2026-10-23')).rejects.toMatchObject({ status: 409 });
  });
});

describe('a video whose folder was deleted (CVP-204)', () => {
  const orphan = makeOrphanDelivery();
  const paidOrphan = { ...orphan, delivery: makeJobDelivery({ paidOn: '2026-10-23' }) };

  describe('markPaid', () => {
    it('returns it among the jobs, as a folder-deleted job with its paid delivery, in the order asked', async () => {
      const here = { ...delivered, delivery: makeJobDelivery({ paidOn: '2026-10-23' }) };
      server.use(
        http.post(`${BASE_URL}/api/payments`, () =>
          // The server answers each list in the order asked; the page puts them back together.
          HttpResponse.json({ jobs: [here], orphans: [paidOrphan] }),
        ),
      );

      const answer = await api.markPaid([orphan.id, here.id], '2026-10-23');

      expect(answer.map((job) => job.id)).toEqual([orphan.id, here.id]);
      expect(answer.map(isFolderDeleted)).toEqual([true, false]);
      expect(answer[0]).toMatchObject({
        name: 'History check',
        client: 'Northwind Bakery',
        state: 'ready',
        delivery: paidOrphan.delivery,
      });
      expect(answer[1]).toEqual(here);
    });

    it('works with only such videos', async () => {
      server.use(
        http.post(`${BASE_URL}/api/payments`, () =>
          HttpResponse.json({ jobs: [], orphans: [paidOrphan] }),
        ),
      );

      const answer = await api.markPaid([orphan.id], '2026-10-23');

      expect(answer.map((job) => job.id)).toEqual([orphan.id]);
    });

    it('rejects with an ApiError when an orphan is not valid', async () => {
      server.use(
        http.post(`${BASE_URL}/api/payments`, () =>
          HttpResponse.json({ jobs: [], orphans: [{ id: 'x' }] }),
        ),
      );

      await expect(api.markPaid(['x'], '2026-10-23')).rejects.toMatchObject({
        message: UNREADABLE_MESSAGE,
      });
    });

    it('rejects with an ApiError when the answer has no orphans list', async () => {
      server.use(http.post(`${BASE_URL}/api/payments`, () => HttpResponse.json({ jobs: [] })));

      await expect(api.markPaid(['x'], '2026-10-23')).rejects.toMatchObject({
        message: UNREADABLE_MESSAGE,
      });
    });
  });

  describe('undoPaid', () => {
    it('returns it as a folder-deleted job, not paid any more', async () => {
      server.use(
        http.post(`${BASE_URL}/api/payments/undo`, () =>
          HttpResponse.json({ jobs: [], orphans: [orphan] }),
        ),
      );

      const [answer] = await api.undoPaid([orphan.id]);

      expect(answer && isFolderDeleted(answer)).toBe(true);
      expect(answer?.delivery).toEqual(orphan.delivery);
    });
  });

  describe('undeliverJob', () => {
    it('returns it as a folder-deleted job without a delivery: there is no job to give back', async () => {
      server.use(
        http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () =>
          HttpResponse.json({ removed: orphan }),
        ),
      );

      const answer = await api.undeliverJob(orphan.id);

      expect(isFolderDeleted(answer)).toBe(true);
      expect(answer).toMatchObject({ id: orphan.id, name: 'History check', delivery: null });
    });

    it('rejects with an ApiError when the answer is neither a job nor a removed delivery', async () => {
      server.use(
        http.post(`${BASE_URL}/api/jobs/:id/undeliver`, () =>
          HttpResponse.json({ removed: { id: 'x' } }),
        ),
      );

      await expect(api.undeliverJob('x')).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
    });
  });

  it('the shared delivery handlers answer it the way the server does', async () => {
    const orphans = [makeOrphanDelivery()];
    server.use(...deliveryHandlers([], { baseUrl: BASE_URL, orphans }));

    const [paid] = await api.markPaid([orphan.id], '2026-10-23');
    expect(paid?.delivery?.paidOn).toBe('2026-10-23');
    expect(await api.listOrphanDeliveries()).toEqual([]);

    const [unpaid] = await api.undoPaid([orphan.id]);
    expect(unpaid?.delivery?.paidOn).toBeNull();
    expect((await api.listOrphanDeliveries()).map((o) => o.id)).toEqual([orphan.id]);

    const removed = await api.undeliverJob(orphan.id);
    expect(removed.delivery).toBeNull();
    expect(await api.listOrphanDeliveries()).toEqual([]);
  });
});
