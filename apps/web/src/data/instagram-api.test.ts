import { INSTAGRAM_LINK_MESSAGES, INSTAGRAM_MESSAGES, noClientInstagram } from '@studio/shared';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { clientPhotoUrl, createInstagramApi } from './instagram-api';
import { makeClientInstagram, makeInstagramReel } from './instagram-test-utils';
import { BASE_URL } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createInstagramApi({ baseUrl: BASE_URL });
const CLIENT_ID = '1c9823704bf5';
const SHORTCODE = 'C9xYz12AbCd';

/** Records each request's method, path (with the query) and JSON body, and answers `body` with `status`. */
function record(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body: JsonBodyType,
  status = 200,
) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http[method](`${BASE_URL}${path}`, async ({ request }) => {
      const text = await request.text();
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: text === '' ? null : JSON.parse(text),
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

describe('the Instagram API, one call per route', () => {
  it('GET /api/clients/:clientId/instagram answers the client’s Instagram, in since-us by default', async () => {
    const body = makeClientInstagram();
    const seen = record('get', '/api/clients/:clientId/instagram', body);
    await expect(api.getClientInstagram(CLIENT_ID)).resolves.toEqual(body);
    await expect(api.getClientInstagram(CLIENT_ID, '90')).resolves.toEqual(body);
    await expect(api.getClientInstagram(CLIENT_ID, '30')).resolves.toEqual(body);
    expect(seen.map((one) => one.path)).toEqual([
      `/api/clients/${CLIENT_ID}/instagram?range=since`,
      `/api/clients/${CLIENT_ID}/instagram?range=90`,
      `/api/clients/${CLIENT_ID}/instagram?range=30`,
    ]);
  });

  it('parses the empty answer of a client with no account', async () => {
    record('get', '/api/clients/:clientId/instagram', noClientInstagram());
    await expect(api.getClientInstagram(CLIENT_ID)).resolves.toEqual(noClientInstagram());
  });

  it('PUT /api/clients/:clientId/instagram sends the account as typed', async () => {
    const body = makeClientInstagram({ scanning: true });
    const seen = record('put', '/api/clients/:clientId/instagram', body);
    await expect(
      api.setClientInstagram(CLIENT_ID, { handle: '@Falcon.FPV', since: '2026-09-14' }),
    ).resolves.toEqual(body);
    await expect(api.setClientInstagram(CLIENT_ID, { handle: 'falcon.fpv' })).resolves.toEqual(
      body,
    );
    expect(seen.map((one) => one.body)).toEqual([
      { handle: '@Falcon.FPV', since: '2026-09-14' },
      { handle: 'falcon.fpv' },
    ]);
    expect(seen[0]).toMatchObject({ method: 'PUT', path: `/api/clients/${CLIENT_ID}/instagram` });
  });

  it('DELETE /api/clients/:clientId/instagram removes the account', async () => {
    const seen = record('delete', '/api/clients/:clientId/instagram', { ok: true });
    await expect(api.deleteClientInstagram(CLIENT_ID)).resolves.toBeUndefined();
    expect(seen).toEqual([
      { method: 'DELETE', path: `/api/clients/${CLIENT_ID}/instagram`, body: null },
    ]);
  });

  it('POST /api/clients/:clientId/instagram/scan is Scan now, and answers the client’s Instagram', async () => {
    const body = makeClientInstagram({ scanning: true });
    const seen = record('post', '/api/clients/:clientId/instagram/scan', body, 202);
    await expect(api.scanClientInstagram(CLIENT_ID)).resolves.toEqual(body);
    expect(seen).toEqual([
      { method: 'POST', path: `/api/clients/${CLIENT_ID}/instagram/scan`, body: null },
    ]);
  });

  it('POST and DELETE /api/instagram/reels/:shortcode/link link and unlink, answering the reel', async () => {
    const linked = makeInstagramReel();
    const unlinked = makeInstagramReel({ job: null });
    const post = record('post', '/api/instagram/reels/:shortcode/link', linked);
    await expect(api.linkReel(SHORTCODE, 'a1b2c3d4e5f6')).resolves.toEqual(linked);
    expect(post).toEqual([
      {
        method: 'POST',
        path: `/api/instagram/reels/${SHORTCODE}/link`,
        body: { jobId: 'a1b2c3d4e5f6' },
      },
    ]);

    const del = record('delete', '/api/instagram/reels/:shortcode/link', unlinked);
    await expect(api.unlinkReel(SHORTCODE)).resolves.toEqual(unlinked);
    expect(del).toEqual([
      { method: 'DELETE', path: `/api/instagram/reels/${SHORTCODE}/link`, body: null },
    ]);
  });

  it('escapes the ids', async () => {
    const seen = record('get', '/api/clients/:clientId/instagram', noClientInstagram());
    await api.getClientInstagram('a b/c');
    expect(seen[0]?.path).toBe('/api/clients/a%20b%2Fc/instagram?range=since');
  });
});

describe('the Instagram API, refusals', () => {
  it('rejects with the server’s words and status: 404 while Instagram is off', async () => {
    record('get', '/api/clients/:clientId/instagram', { error: INSTAGRAM_MESSAGES.off }, 404);
    const refused = await api.getClientInstagram(CLIENT_ID).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 404, message: 'Clients × Instagram is off.' });
  });

  it('rejects a handle with the words that say what is wrong (400)', async () => {
    record(
      'put',
      '/api/clients/:clientId/instagram',
      { error: 'An Instagram handle has no spaces.' },
      400,
    );
    await expect(api.setClientInstagram(CLIENT_ID, { handle: 'falcon fpv' })).rejects.toMatchObject(
      {
        status: 400,
        message: 'An Instagram handle has no spaces.',
      },
    );
  });

  it('rejects a link the server refuses with its reason in words (409)', async () => {
    record(
      'post',
      '/api/instagram/reels/:shortcode/link',
      { error: INSTAGRAM_LINK_MESSAGES['job-linked'], reason: 'job-linked' },
      409,
    );
    await expect(api.linkReel(SHORTCODE, 'a1b2c3d4e5f6')).rejects.toMatchObject({
      status: 409,
      message: 'That video is linked to a reel already. Unlink it first.',
    });
  });

  it('rejects a route that is not built yet (501)', async () => {
    record(
      'post',
      '/api/clients/:clientId/instagram/scan',
      { error: INSTAGRAM_MESSAGES.notBuilt },
      501,
    );
    await expect(api.scanClientInstagram(CLIENT_ID)).rejects.toMatchObject({
      status: 501,
      message: INSTAGRAM_MESSAGES.notBuilt,
    });
  });

  it('rejects an answer that is not a client’s Instagram', async () => {
    record('get', '/api/clients/:clientId/instagram', { account: { handle: 'Falcon' } });
    await expect(api.getClientInstagram(CLIENT_ID)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });
});

describe('clientPhotoUrl', () => {
  it('is the photo route of the client, escaped', () => {
    expect(clientPhotoUrl(CLIENT_ID)).toBe(`/api/clients/${CLIENT_ID}/photo`);
    expect(clientPhotoUrl('a b/c')).toBe('/api/clients/a%20b%2Fc/photo');
  });

  it('carries when the picture was saved, so a new picture is fetched again', () => {
    expect(clientPhotoUrl(CLIENT_ID, '2026-10-30T10:05:00.000Z')).toBe(
      `/api/clients/${CLIENT_ID}/photo?v=2026-10-30T10%3A05%3A00.000Z`,
    );
    expect(clientPhotoUrl(CLIENT_ID, null)).toBe(`/api/clients/${CLIENT_ID}/photo`);
  });
});
