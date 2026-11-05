import type { ClientRow } from '@studio/shared';
import { MutationObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import {
  CLIENTS_KEY,
  changesClientRow,
  clientsQueryOptions,
  createClientMutationOptions,
  upsertClientRow,
} from './clients-query';
import { BASE_URL, createTestQueryClient, makeJob } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const acme: ClientRow = {
  clientId: 'aaaaaaaaaaaa',
  client: 'Acme',
  jobs: 2,
  lastJobAt: '2026-10-20T11:00:00.000Z',
  style: { state: 'ready', updatedAt: '2026-10-20T11:30:00.000Z' },
};
const fresh: ClientRow = {
  clientId: 'bbbbbbbbbbbb',
  client: 'Fresh Co',
  jobs: 0,
  lastJobAt: null,
  style: { state: 'none', updatedAt: null },
};

describe('clientsQueryOptions', () => {
  it("caches the list under ['clients'] and never considers it stale on its own", () => {
    const options = clientsQueryOptions(api);
    expect(options.queryKey).toEqual(['clients']);
    expect(options.queryKey).toEqual(CLIENTS_KEY);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
  });

  it('fetches the list, a client with no jobs included', async () => {
    server.use(http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([acme, fresh])));
    const queryClient = createTestQueryClient();
    await expect(queryClient.fetchQuery(clientsQueryOptions(api))).resolves.toEqual([acme, fresh]);
    expect(queryClient.getQueryData(CLIENTS_KEY)).toEqual([acme, fresh]);
  });
});

describe('upsertClientRow', () => {
  it('adds a row the list does not have', () => {
    expect(upsertClientRow([acme], fresh)).toEqual([acme, fresh]);
    expect(upsertClientRow([], fresh)).toEqual([fresh]);
  });

  it('replaces the row with the same clientId, where it stands', () => {
    const updated = { ...acme, jobs: 3 };
    expect(upsertClientRow([acme, fresh], updated)).toEqual([updated, fresh]);
  });

  it('does not change the list it was given', () => {
    const list = [acme];
    upsertClientRow(list, fresh);
    expect(list).toEqual([acme]);
  });
});

describe('changesClientRow', () => {
  const known = makeJob({ id: 'a', clientId: 'aaaaaaaaaaaa', addedAt: '2026-10-20T11:00:00.000Z' });

  it('is true for a job the list of jobs did not hold', () => {
    expect(changesClientRow(undefined, known)).toBe(true);
  });

  it('is false for a known job that only progressed', () => {
    expect(
      changesClientRow(known, {
        ...known,
        state: 'editing',
        step: 3,
        updatedAt: '2026-10-20T12:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('is true for a job that moved to another client, or arrived at another time', () => {
    expect(changesClientRow(known, { ...known, clientId: 'bbbbbbbbbbbb' })).toBe(true);
    expect(changesClientRow(known, { ...known, addedAt: '2026-10-20T12:00:00.000Z' })).toBe(true);
  });
});

describe('createClientMutationOptions', () => {
  function mutation(queryClient = createTestQueryClient()) {
    return {
      queryClient,
      observer: new MutationObserver(
        queryClient,
        createClientMutationOptions({ queryClient, api }),
      ),
    };
  }

  it('POSTs the name and resolves with the new row, which joins the cached list', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(fresh, { status: 201 });
      }),
      // The reload that follows asks the server again.
      http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([acme, fresh])),
    );
    const { queryClient, observer } = mutation();
    queryClient.setQueryData(CLIENTS_KEY, [acme]);

    await expect(observer.mutate('Fresh Co')).resolves.toEqual(fresh);
    expect(bodies).toEqual([{ name: 'Fresh Co' }]);
    expect(queryClient.getQueryData(CLIENTS_KEY)).toEqual([acme, fresh]);
  });

  it('leaves an uncached list alone: whoever shows it loads it', async () => {
    server.use(http.post(`${BASE_URL}/api/clients`, () => HttpResponse.json(fresh)));
    const { queryClient, observer } = mutation();

    await observer.mutate('Fresh Co');
    expect(queryClient.getQueryData(CLIENTS_KEY)).toBeUndefined();
  });

  it.each([
    [400, 'A client name can’t contain / or :.'],
    [409, 'A client with that name already exists.'],
  ])('rejects with the server’s explanation for a %i', async (status, error) => {
    server.use(
      http.post(`${BASE_URL}/api/clients`, () => HttpResponse.json({ error }, { status })),
    );
    const { queryClient, observer } = mutation();
    queryClient.setQueryData(CLIENTS_KEY, [acme]);

    const refused = await observer.mutate('a/b').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status, message: error });
    expect(queryClient.getQueryData(CLIENTS_KEY)).toEqual([acme]);
  });
});
