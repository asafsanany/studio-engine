import type { ClientRow } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { BASE_URL } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const withJobs: ClientRow = {
  clientId: '4d337086919d',
  client: 'מאפיית הצפון',
  jobs: 3,
  lastJobAt: '2026-10-20T13:30:00.000Z',
  style: { state: 'ready', updatedAt: '2026-10-20T13:35:00.000Z' },
};
const noJobs: ClientRow = {
  clientId: 'bbbbbbbbbbbb',
  client: 'Fresh Co',
  jobs: 0,
  lastJobAt: null,
  style: { state: 'none', updatedAt: null },
};

describe('listClients', () => {
  it('GETs /api/clients and parses the rows, a client with no jobs included', async () => {
    server.use(http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([withJobs, noJobs])));
    await expect(createApi({ baseUrl: BASE_URL }).listClients()).resolves.toEqual([
      withJobs,
      noJobs,
    ]);
  });

  it('is empty for an inbox with no client folder', async () => {
    server.use(http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([])));
    await expect(createApi({ baseUrl: BASE_URL }).listClients()).resolves.toEqual([]);
  });

  it('rejects with an ApiError when the answer is not a client list', async () => {
    server.use(
      http.get(`${BASE_URL}/api/clients`, () =>
        HttpResponse.json([{ clientId: 'x', jobs: 'many' }]),
      ),
    );
    const error = await createApi({ baseUrl: BASE_URL })
      .listClients()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('says the server cannot be reached when it is not there', async () => {
    const api = createApi({
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(api.listClients()).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('createClient', () => {
  it('POSTs { name } as JSON to /api/clients and answers with the new client’s row', async () => {
    const seen: { type: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients`, async ({ request }) => {
        seen.push({ type: request.headers.get('content-type'), body: await request.json() });
        return HttpResponse.json(noJobs, { status: 201 });
      }),
    );
    await expect(createApi({ baseUrl: BASE_URL }).createClient('Fresh Co')).resolves.toEqual(
      noJobs,
    );
    expect(seen).toEqual([{ type: 'application/json', body: { name: 'Fresh Co' } }]);
  });

  it('sends a Hebrew name as it is', async () => {
    const names: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients`, async ({ request }) => {
        names.push(await request.json());
        return HttpResponse.json(withJobs);
      }),
    );
    await createApi({ baseUrl: BASE_URL }).createClient('מאפיית הצפון');
    expect(names).toEqual([{ name: 'מאפיית הצפון' }]);
  });

  it.each([
    [400, 'A client name can’t start with . or _.'],
    [409, 'A client with that name already exists.'],
  ])('keeps the explanation of a %i', async (status, error) => {
    server.use(
      http.post(`${BASE_URL}/api/clients`, () => HttpResponse.json({ error }, { status })),
    );
    const refused = await createApi({ baseUrl: BASE_URL })
      .createClient('x')
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status, message: error });
  });

  it('rejects with an ApiError when the answer is not a client row', async () => {
    server.use(http.post(`${BASE_URL}/api/clients`, () => HttpResponse.json({ ok: true })));
    await expect(createApi({ baseUrl: BASE_URL }).createClient('x')).rejects.toMatchObject({
      message: UNREADABLE_MESSAGE,
    });
  });
});
