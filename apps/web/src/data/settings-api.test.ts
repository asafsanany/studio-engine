import type { SettingsResponse } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { BASE_URL } from './test-utils';

// The settings routes of the Api: paths, bodies, parsed answers and the server's own words.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const SETTINGS: SettingsResponse = {
  features: [
    { key: 'graphics', running: true, saved: true, lockedByEnv: false },
    { key: 'fonts', running: true, saved: false, lockedByEnv: false },
    { key: 'luts', running: true, saved: true, lockedByEnv: true },
  ],
  canRestart: true,
};

describe('api.getSettings', () => {
  it('reads the switches', async () => {
    server.use(http.get(`${BASE_URL}/api/settings`, () => HttpResponse.json(SETTINGS)));
    await expect(api.getSettings()).resolves.toEqual(SETTINGS);
  });

  it('says what the server said when an editor is refused (403)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/settings`, () =>
        HttpResponse.json({ error: 'Not allowed.' }, { status: 403 }),
      ),
    );
    const refused = await api.getSettings().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 403, message: 'Not allowed.' });
  });
});

describe('api.saveSettings', () => {
  it('puts the switches and answers the settings', async () => {
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/api/settings`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(SETTINGS);
      }),
    );
    await expect(api.saveSettings({ fonts: false })).resolves.toEqual(SETTINGS);
    expect(body).toEqual({ fonts: false });
  });

  it('says what the server said when an environment variable decides (409)', async () => {
    server.use(
      http.put(`${BASE_URL}/api/settings`, () =>
        HttpResponse.json({ error: 'STUDIO_LUTS is set.' }, { status: 409 }),
      ),
    );
    const refused = await api.saveSettings({ luts: false }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, message: 'STUDIO_LUTS is set.' });
  });
});

describe('api.restartEngine', () => {
  it('posts to the restart route', async () => {
    let asked = false;
    server.use(
      http.post(`${BASE_URL}/api/settings/restart`, () => {
        asked = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    await api.restartEngine();
    expect(asked).toBe(true);
  });

  it('says what the server said when it cannot restart (409)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/settings/restart`, () =>
        HttpResponse.json({ error: 'No agent.' }, { status: 409 }),
      ),
    );
    await expect(api.restartEngine()).rejects.toMatchObject({ status: 409, message: 'No agent.' });
  });
});
