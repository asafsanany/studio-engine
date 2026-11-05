import type { Job } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '@/data/api';
import { markPaidMutationOptions } from '@/data/delivery-mutations';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  deliveryHandlers,
  makeJob,
  makeJobDelivery,
} from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { PAYMENT_CHANGED_TEXT, payOwed, paymentErrorText } = await import('./mark-paid-changes');
const { owedJobs } = await import('./pay-list');

// These run the real routes of the data layer against an MSW server: Mark paid is the real
// mutation, the message's Undo is a call to the opposite route, and what the server answers goes
// into the jobs list.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const CLIENT = { clientId: 'client-tavo', client: 'עו״ד דוד לוי' };

/** A delivered, unpaid ready job of the client. */
const delivered = (id: string, price = 40) =>
  makeJob({
    id,
    name: `Video ${id}`,
    clientId: CLIENT.clientId,
    client: CLIENT.client,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ price }),
  });

let queryClient: QueryClient;
let serverJobs: Job[];
beforeEach(() => {
  queryClient = createTestQueryClient();
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  serverJobs = [delivered('a'), delivered('b'), delivered('c', 200)];
  queryClient.setQueryData<Job[]>(JOBS_KEY, serverJobs.slice());
  server.use(...deliveryHandlers(serverJobs));
});

const cached = (id: string) =>
  queryClient.getQueryData<Job[]>(JOBS_KEY)?.find((job) => job.id === id);

/** The dialog's own dependencies: the real mutation of the data layer, and the real Undo route. */
const deps = () => ({
  markPaid: (variables: { jobIds: readonly string[]; paidOn: string }) =>
    new MutationObserver(queryClient, markPaidMutationOptions({ queryClient, api })).mutate(
      variables,
    ),
  api,
  queryClient,
});

const owed = (...ids: string[]) =>
  owedJobs(serverJobs, CLIENT.clientId).filter((job) => ids.includes(job.id));

/** What the server was asked, as "POST /path body". */
function recordRequests(): string[] {
  const seen: string[] = [];
  server.events.on('request:start', async ({ request }) => {
    const body = await request.clone().text();
    seen.push(`${request.method} ${new URL(request.url).pathname} ${body}`.trim());
  });
  return seen;
}

/** The Undo button of the message the last `toast(...)` call showed. */
function undoOfLastToast(): () => void {
  const [, options] = sonner.toast.mock.calls.at(-1) as [
    unknown,
    { action?: { onClick: () => void } },
  ];
  if (options.action === undefined) throw new Error('the message has no Undo');
  return options.action.onClick;
}

describe('payOwed: Mark N paid', () => {
  it('sends the ticked videos and the day to Mark paid, puts the paid jobs in the list and tells it', async () => {
    const seen = recordRequests();
    const outcome = await payOwed(deps(), CLIENT, owed('a', 'b'), '2026-10-19');

    expect(outcome).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(seen).toEqual(['POST /api/payments {"jobIds":["a","b"],"paidOn":"2026-10-19"}']),
    );
    expect(cached('a')?.delivery?.paidOn).toBe('2026-10-19');
    expect(cached('b')?.delivery?.paidOn).toBe('2026-10-19');
    // The video that was not ticked is left as it was.
    expect(cached('c')?.delivery?.paidOn).toBeNull();
    expect(sonner.toast).toHaveBeenCalledOnce();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('pays one video with one id', async () => {
    const seen = recordRequests();
    await payOwed(deps(), CLIENT, owed('c'), '2026-10-21');
    await vi.waitFor(() =>
      expect(seen).toEqual(['POST /api/payments {"jobIds":["c"],"paidOn":"2026-10-21"}']),
    );
    expect(cached('c')?.delivery?.paidOn).toBe('2026-10-21');
  });

  it('tells how many videos from the client were paid, for how much', async () => {
    await payOwed(deps(), CLIENT, owed('a', 'c'), '2026-10-19');
    const [message] = sonner.toast.mock.calls[0] as [React.ReactNode];
    expect(renderToStaticMarkup(message)).toBe(
      '2 videos from <bdi>עו״ד דוד לוי</bdi> marked paid · ₪240',
    );
  });

  it('has an Undo that sends the same videos to Not paid yet, and the rows go back to Delivered', async () => {
    await payOwed(deps(), CLIENT, owed('a', 'b'), '2026-10-19');
    const seen = recordRequests();

    undoOfLastToast()();
    await vi.waitFor(() => expect(cached('a')?.delivery?.paidOn).toBeNull());

    expect(seen).toEqual(['POST /api/payments/undo {"jobIds":["a","b"]}']);
    expect(cached('b')?.delivery?.paidOn).toBeNull();
    // Undo is its own answer: no second message.
    expect(sonner.toast).toHaveBeenCalledOnce();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('tells why when the server refuses the Undo (409: a video moved on meanwhile)', async () => {
    await payOwed(deps(), CLIENT, owed('a'), '2026-10-19');
    server.use(
      http.post(`${BASE_URL}/api/payments/undo`, () =>
        HttpResponse.json({ error: 'Nothing was changed: Video a is not paid.' }, { status: 409 }),
      ),
    );

    undoOfLastToast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toBe('Nothing was changed: Video a is not paid.');
    // The list keeps the payment.
    expect(cached('a')?.delivery?.paidOn).toBe('2026-10-19');
  });

  describe('when the server refuses (409: a video changed meanwhile)', () => {
    const refuse = () =>
      server.use(
        http.post(`${BASE_URL}/api/payments`, () =>
          HttpResponse.json(
            { error: 'Nothing was changed: Video b is paid already.' },
            { status: 409 },
          ),
        ),
      );

    it('says why, in words for the dialog, and tells nothing else', async () => {
      refuse();
      const outcome = await payOwed(deps(), CLIENT, owed('a', 'b'), '2026-10-19');
      expect(outcome).toEqual({ ok: false, message: PAYMENT_CHANGED_TEXT });
      expect(sonner.toast).not.toHaveBeenCalled();
      expect(sonner.toast.error).not.toHaveBeenCalled();
    });

    it('changes nothing in the list, and loads it again so it shows what changed', async () => {
      refuse();
      await payOwed(deps(), CLIENT, owed('a', 'b'), '2026-10-19');
      expect(cached('a')?.delivery?.paidOn).toBeNull();
      expect(queryClient.getQueryState(JOBS_KEY)?.isInvalidated).toBe(true);
    });
  });

  it('says why when the server cannot be reached, in its own words', async () => {
    server.use(http.post(`${BASE_URL}/api/payments`, () => HttpResponse.error()));
    const outcome = await payOwed(deps(), CLIENT, owed('a'), '2026-10-19');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toMatch(/reach/i);
    expect(sonner.toast).not.toHaveBeenCalled();
  });
});

describe('paymentErrorText', () => {
  it('is the short line about a change for a 409, whatever the server wrote', () => {
    expect(paymentErrorText(new ApiError(409, 'Nothing was changed: x is paid already.'))).toBe(
      PAYMENT_CHANGED_TEXT,
    );
    expect(PAYMENT_CHANGED_TEXT.length).toBeLessThan(70);
  });

  it('is the error’s own message for any other failure', () => {
    expect(paymentErrorText(new ApiError(400, 'The day is not a date.'))).toBe(
      'The day is not a date.',
    );
    expect(paymentErrorText(new Error('boom'))).toBe('boom');
    expect(paymentErrorText('plain')).toBe('plain');
  });
});
