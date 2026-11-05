import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { BASE_URL, makeTeam } from './test-utils';

// The team routes of the Api (TM5): paths, bodies, parsed answers and the server's own words.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

describe('api.getTeam', () => {
  it('reads the people and the assignments', async () => {
    server.use(http.get(`${BASE_URL}/api/team`, () => HttpResponse.json(makeTeam())));
    await expect(api.getTeam()).resolves.toEqual(makeTeam());
  });

  it('says what the server said when an editor is refused (403)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/team`, () =>
        HttpResponse.json({ error: 'Not allowed.' }, { status: 403 }),
      ),
    );
    const refused = await api.getTeam().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 403, message: 'Not allowed.' });
  });
});

describe('api.addTeamUser', () => {
  it('posts the person and answers them', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/api/team`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { email: 'yael@example.com', name: 'Yael', role: 'editor' },
          { status: 201 },
        );
      }),
    );
    await expect(
      api.addTeamUser({ name: 'Yael', email: 'Yael@Example.com', role: 'editor' }),
    ).resolves.toEqual({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    expect(body).toEqual({ name: 'Yael', email: 'Yael@Example.com', role: 'editor' });
  });

  it('carries the server’s refusal of a login that is on the team already (409)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/team`, () =>
        HttpResponse.json({ error: 'yael@example.com is on the team already.' }, { status: 409 }),
      ),
    );
    const refused = await api
      .addTeamUser({ name: 'Yael', email: 'yael@example.com', role: 'editor' })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      status: 409,
      message: 'yael@example.com is on the team already.',
    });
  });
});

describe('api.updateTeamUser and api.removeTeamUser', () => {
  it('puts the change at the person’s login, encoded', async () => {
    let url = '';
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/api/team/:email`, async ({ request }) => {
        url = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ email: 'a+b@example.com', name: 'A', role: 'admin' });
      }),
    );
    await api.updateTeamUser('a+b@example.com', { role: 'admin' });
    expect(url).toBe('/api/team/a%2Bb%40example.com');
    expect(body).toEqual({ role: 'admin' });
  });

  it('deletes the person', async () => {
    let method = '';
    server.use(
      http.delete(`${BASE_URL}/api/team/:email`, ({ request }) => {
        method = request.method;
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(api.removeTeamUser('yael@example.com')).resolves.toBeUndefined();
    expect(method).toBe('DELETE');
  });
});

describe('api.setClientAssignees', () => {
  it('puts the editors at the client and answers the client’s editors', async () => {
    let url = '';
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/assignees`, async ({ request }) => {
        url = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({
          clientId: 'aaaaaaaaaaaa',
          client: 'Arc Fitness',
          editors: ['yael@example.com', 'amit@example.com'],
        });
      }),
    );
    const answer = await api.setClientAssignees('aaaaaaaaaaaa', [
      'yael@example.com',
      'amit@example.com',
    ]);
    expect(url).toBe('/api/clients/aaaaaaaaaaaa/assignees');
    expect(body).toEqual({ editors: ['yael@example.com', 'amit@example.com'] });
    expect(answer.editors).toEqual(['yael@example.com', 'amit@example.com']);
  });

  it('carries the server’s refusal of an admin (400)', async () => {
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/assignees`, () =>
        HttpResponse.json(
          { error: 'owner@example.com is an admin: they see every client already.' },
          { status: 400 },
        ),
      ),
    );
    const refused = await api
      .setClientAssignees('aaaaaaaaaaaa', ['owner@example.com'])
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400 });
  });
});
