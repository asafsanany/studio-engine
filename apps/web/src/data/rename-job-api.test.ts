import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { BASE_URL, makeJob } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

describe('api.renameJob', () => {
  it('PUTs { name } as JSON to /api/jobs/:id/name and returns the job under its new id', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    const answer = makeJob({ id: 'new-id', name: 'Summer menu', relPath: 'Kova/Summer menu' });
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/name`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json(answer);
      }),
    );

    await expect(api.renameJob('old id', 'Summer menu')).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'PUT',
        path: '/api/jobs/old%20id/name',
        type: 'application/json',
        body: { name: 'Summer menu' },
      },
    ]);
  });

  it('rejects with the server’s explanation when it refuses', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/name`, () =>
        HttpResponse.json(
          { error: 'There is already a video called “Summer menu” for this client.' },
          { status: 409 },
        ),
      ),
    );

    const error = await api.renameJob('j1', 'Summer menu').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe(
      'There is already a video called “Summer menu” for this client.',
    );
  });
});

describe('api.renameClient', () => {
  it('PUTs { name } as JSON to /api/clients/:clientId/name and returns the new row', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const answer = {
      clientId: 'new-id',
      client: 'Kova Roasters',
      jobs: 2,
      lastJobAt: null,
      style: { state: 'none', updatedAt: null },
    };
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/name`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        return HttpResponse.json(answer);
      }),
    );

    await expect(api.renameClient('old id', 'Kova Roasters')).resolves.toEqual(answer);

    expect(seen).toEqual([
      { method: 'PUT', path: '/api/clients/old%20id/name', body: { name: 'Kova Roasters' } },
    ]);
  });

  it('rejects with the server’s explanation when it refuses', async () => {
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/name`, () =>
        HttpResponse.json(
          { error: 'There is already a client called “LAKESHORE”.' },
          { status: 409 },
        ),
      ),
    );

    await expect(api.renameClient('c1', 'LAKESHORE')).rejects.toMatchObject({
      status: 409,
      message: 'There is already a client called “LAKESHORE”.',
    });
  });
});
