import type { MoneyResponse, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { createJobEventsClient } from './job-events';
import {
  MONEY_KEY,
  moneyKey,
  moneyPriceKey,
  moneyPriceQueryOptions,
  moneyQueryOptions,
  reloadMoney,
} from './money-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeMoneyResponse,
  manualTimers,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's answers by month; `asked` lists the `?month=` of every GET /api/money. */
function serverMoney(answers: Record<string, MoneyResponse> = {}) {
  const state = { answers, asked: [] as (string | null)[] };
  server.use(
    http.get(`${BASE_URL}/api/money`, ({ request }) => {
      const month = new URL(request.url).searchParams.get('month');
      state.asked.push(month);
      const answer = state.answers[month ?? ''];
      return answer
        ? HttpResponse.json(answer)
        : HttpResponse.json({ error: 'No such month' }, { status: 400 });
    }),
  );
  return state;
}

describe('api.getMoney', () => {
  it('GETs /api/money?month=YYYY-MM and parses the answer', async () => {
    const october = makeMoneyResponse();
    const state = serverMoney({ '2026-10': october });
    await expect(api.getMoney('2026-10')).resolves.toEqual(october);
    expect(state.asked).toEqual(['2026-10']);
  });

  it('keeps the agorot of the amounts', async () => {
    serverMoney({ '2026-10': makeMoneyResponse() });
    const answer = await api.getMoney('2026-10');
    expect(answer.banners.expenses.value).toBe(960.4);
    expect(answer.banners.profit.history).toHaveLength(8);
  });

  it("rejects with the server's words when it refuses the month", async () => {
    server.use(
      http.get(`${BASE_URL}/api/money`, () =>
        HttpResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 }),
      ),
    );
    const error = await api.getMoney('soon').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, message: 'month must be YYYY-MM' });
  });

  it('rejects with an ApiError when the answer is not a money answer', async () => {
    server.use(http.get(`${BASE_URL}/api/money`, () => HttpResponse.json({ month: '2026-10' })));
    const error = await api.getMoney('2026-10').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('rejects when a banner has not eight months of history', async () => {
    const answer = makeMoneyResponse();
    answer.banners.income.history = [1, 2, 3];
    server.use(http.get(`${BASE_URL}/api/money`, () => HttpResponse.json(answer)));
    await expect(api.getMoney('2026-10')).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('says the server cannot be reached when it is not there', async () => {
    const offline = createApi({
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.getMoney('2026-10')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('moneyKey and moneyQueryOptions', () => {
  it("cache each month under ['money', month], below ['money']", () => {
    expect(MONEY_KEY).toEqual(['money']);
    expect(moneyKey('2026-10')).toEqual(['money', '2026-10']);
    expect(moneyQueryOptions(api, '2026-09').queryKey).toEqual(['money', '2026-09']);
  });

  it('load the month asked for into its own key', async () => {
    const state = serverMoney({
      '2026-10': makeMoneyResponse(),
      '2026-09': makeMoneyResponse({ month: '2026-09' }),
    });
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-10'));
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-09'));
    expect(queryClient.getQueryData<MoneyResponse>(moneyKey('2026-10'))?.month).toBe('2026-10');
    expect(queryClient.getQueryData<MoneyResponse>(moneyKey('2026-09'))?.month).toBe('2026-09');
    expect(state.asked).toEqual(['2026-10', '2026-09']);
  });

  it('are fresh until the server says otherwise: a second look does not ask again', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-10'));
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-10'));
    expect(state.asked).toHaveLength(1);
  });

  it('keep the month that was on screen while the next one loads', async () => {
    serverMoney({
      '2026-10': makeMoneyResponse(),
      '2026-09': makeMoneyResponse({ month: '2026-09' }),
    });
    const october = new QueryObserver(queryClient, moneyQueryOptions(api, '2026-10'));
    const stop = october.subscribe(() => {});
    await vi.waitFor(() => expect(october.getCurrentResult().data?.month).toBe('2026-10'));

    // The page now asks for September: its observer takes over, October is still its data.
    october.setOptions(moneyQueryOptions(api, '2026-09'));
    expect(october.getCurrentResult().data?.month).toBe('2026-10');
    expect(october.getCurrentResult().isPlaceholderData).toBe(true);
    await vi.waitFor(() => expect(october.getCurrentResult().data?.month).toBe('2026-09'));
    expect(october.getCurrentResult().isPlaceholderData).toBe(false);
    stop();
  });
});

describe('the price of a delivery now', () => {
  /** The server's price answers; `asked` lists the `?client=` of every GET /api/money/price. */
  function serverPrice(prices: Record<string, number>) {
    const state = { prices, asked: [] as (string | null)[] };
    server.use(
      http.get(`${BASE_URL}/api/money/price`, ({ request }) => {
        const client = new URL(request.url).searchParams.get('client');
        state.asked.push(client);
        const price = state.prices[client ?? ''];
        return price === undefined
          ? HttpResponse.json({ error: 'Send the client' }, { status: 400 })
          : HttpResponse.json({ client, price, currency: 'ILS', month: '2026-10' });
      }),
    );
    return state;
  }

  it('GETs /api/money/price?client=<name>, the name encoded, and parses the answer', async () => {
    const state = serverPrice({ 'עו״ד דוד לוי': 40 });

    const answer = await api.getMoneyPrice('עו״ד דוד לוי');

    expect(answer).toEqual({
      client: 'עו״ד דוד לוי',
      price: 40,
      currency: 'ILS',
      month: '2026-10',
    });
    expect(state.asked).toEqual(['עו״ד דוד לוי']);
  });

  it('rejects with an ApiError for an answer that is not a price', async () => {
    server.use(
      http.get(`${BASE_URL}/api/money/price`, () => HttpResponse.json({ price: 'forty' })),
    );

    await expect(api.getMoneyPrice('RGM')).rejects.toBeInstanceOf(ApiError);
  });

  it("is cached per client under ['money', 'price', client], so money.changed asks again", async () => {
    const state = serverPrice({ RGM: 40 });
    expect(moneyPriceKey('RGM')).toEqual(['money', 'price', 'RGM']);
    new QueryObserver(queryClient, moneyPriceQueryOptions(api, 'RGM')).subscribe(() => {});
    await vi.waitFor(() => expect(queryClient.getQueryData(moneyPriceKey('RGM'))).toBeDefined());

    state.prices.RGM = 55;
    await reloadMoney(queryClient);

    expect(state.asked).toEqual(['RGM', 'RGM']);
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(moneyPriceKey('RGM'))).toMatchObject({ price: 55 }),
    );
  });
});

describe('reloadMoney', () => {
  it('loads the month on screen again, and marks the others stale', async () => {
    const state = serverMoney({
      '2026-10': makeMoneyResponse(),
      '2026-09': makeMoneyResponse({ month: '2026-09' }),
    });
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-09'));
    new QueryObserver(queryClient, moneyQueryOptions(api, '2026-10')).subscribe(() => {});
    await vi.waitFor(() => expect(state.asked).toEqual(['2026-09', '2026-10']));

    await reloadMoney(queryClient);

    // Only the month that is shown is asked for at once.
    expect(state.asked).toEqual(['2026-09', '2026-10', '2026-10']);
    expect(queryClient.getQueryState(moneyKey('2026-09'))?.isInvalidated).toBe(true);
  });

  it('does nothing while nobody shows the page', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    await queryClient.fetchQuery(moneyQueryOptions(api, '2026-10'));
    await reloadMoney(queryClient);
    expect(state.asked).toHaveLength(1);
  });
});

describe('the events client and the Money page', () => {
  function start() {
    const sources = fakeEventSources();
    const client = createJobEventsClient({
      queryClient,
      eventSourceFactory: sources.factory,
      timers: manualTimers().timers,
    });
    client.start();
    return sources;
  }

  /** A page showing October: an observer on its query, loaded. */
  async function showOctober(state: { asked: unknown[] }) {
    new QueryObserver(queryClient, moneyQueryOptions(api, '2026-10')).subscribe(() => {});
    await vi.waitFor(() => expect(queryClient.getQueryData(moneyKey('2026-10'))).toBeDefined());
    expect(state.asked).toHaveLength(1);
  }

  const changed: ServerEvent = { type: 'money.changed' };

  it('money.changed loads the month on screen again', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    await showOctober(state);
    const sources = start();

    sources.latest.emit(changed);

    await vi.waitFor(() => expect(state.asked).toHaveLength(2));
  });

  it('shows the new numbers once they arrive', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    await showOctober(state);
    const sources = start();

    state.answers['2026-10'] = makeMoneyResponse({
      banners: {
        ...makeMoneyResponse().banners,
        income: {
          ...makeMoneyResponse().banners.income,
          value: 5400,
          previous: 4400,
          history: [1, 2, 3, 4, 5, 6, 4400, 5400],
        },
      },
    });
    sources.latest.emit(changed);

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<MoneyResponse>(moneyKey('2026-10'))?.banners.income.value,
      ).toBe(5400),
    );
  });

  it('every hello loads it again too, the first and each after a reconnect', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    await showOctober(state);
    const sources = start();
    // The client list and the jobs are asked for as well; this test only counts the money requests.
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([])),
      http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([])),
    );

    sources.latest.emit({ type: 'hello' });
    await vi.waitFor(() => expect(state.asked).toHaveLength(2));
    sources.latest.emit({ type: 'hello' });
    await vi.waitFor(() => expect(state.asked).toHaveLength(3));
  });

  it('does nothing when no Money page is open', async () => {
    const state = serverMoney({ '2026-10': makeMoneyResponse() });
    const sources = start();
    sources.latest.emit(changed);
    await Promise.resolve();
    expect(state.asked).toEqual([]);
  });
});
