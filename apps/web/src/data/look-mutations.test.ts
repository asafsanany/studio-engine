import { type ClientStyle, type ClientStyleResponse, noClientStyle } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from './api';
import { clientStyleKey } from './client-style';
import { applyLookMutationOptions, undoClientStyleMutationOptions } from './look-mutations';
import { BASE_URL, createTestQueryClient } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const CLIENT_ID = '27ad66831f94';
const OTHER_ID = '4d337086919d';
const JOB_ID = '0c5072f499ad';

const style = (overrides: Partial<ClientStyle> = {}): ClientStyle => ({
  ...noClientStyle(CLIENT_ID, 'Arc Fitness'),
  state: 'ready',
  version: 2,
  updatedAt: '2026-10-21T13:54:37.904Z',
  sourceJobId: '8cc31fc9036d',
  ...overrides,
});

const cachedStyle = (clientId: string): ClientStyleResponse => ({
  ...style(),
  clientId,
  markdown: '# Style: Arc Fitness\n',
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(clientStyleKey(CLIENT_ID), cachedStyle(CLIENT_ID));
  queryClient.setQueryData(clientStyleKey(OTHER_ID), cachedStyle(OTHER_ID));
});

const cached = (clientId: string) =>
  queryClient.getQueryData<ClientStyleResponse>(clientStyleKey(clientId));
const stale = (clientId: string) =>
  queryClient.getQueryState(clientStyleKey(clientId))?.isInvalidated;

describe('applyLookMutationOptions', () => {
  it('puts the client’s new style (analysing) over the cached one, keeping its markdown, and reloads it', async () => {
    const analysing = style({
      state: 'analysing',
      pass: { kind: 'learn', mode: 'replace', fileCount: 0, jobId: JOB_ID, job: 'Studio tour' },
    });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () => HttpResponse.json(analysing)),
    );
    const result = await new MutationObserver(
      queryClient,
      applyLookMutationOptions({ queryClient, api }),
    ).mutate(JOB_ID);

    expect(result).toEqual(analysing);
    expect(cached(CLIENT_ID)).toMatchObject({
      state: 'analysing',
      markdown: '# Style: Arc Fitness\n',
      pass: analysing.pass,
    });
    expect(stale(CLIENT_ID)).toBe(true);
    // Another client's style is not touched.
    expect(cached(OTHER_ID)?.state).toBe('ready');
    expect(stale(OTHER_ID)).toBe(false);
  });

  it('leaves the cache alone when it is refused', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () =>
        HttpResponse.json(
          { error: 'The style is being analysed. Try again once it is done.' },
          { status: 409 },
        ),
      ),
    );
    await expect(
      new MutationObserver(queryClient, applyLookMutationOptions({ queryClient, api })).mutate(
        JOB_ID,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: 'The style is being analysed. Try again once it is done.',
    });
    expect(cached(CLIENT_ID)).toEqual(cachedStyle(CLIENT_ID));
    expect(stale(CLIENT_ID)).toBe(false);
  });

  it('is fine for a client whose style nobody has loaded: nothing to write over', async () => {
    queryClient.removeQueries({ queryKey: clientStyleKey(CLIENT_ID) });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () =>
        HttpResponse.json(style({ state: 'analysing' })),
      ),
    );
    await new MutationObserver(queryClient, applyLookMutationOptions({ queryClient, api })).mutate(
      JOB_ID,
    );
    expect(cached(CLIENT_ID)).toBeUndefined();
  });
});

describe('undoClientStyleMutationOptions', () => {
  it('puts the restored style over the cached one and reloads it', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/${CLIENT_ID}/style/undo`, () =>
        HttpResponse.json(style({ version: 3, sourceJobId: null })),
      ),
    );
    const result = await new MutationObserver(
      queryClient,
      undoClientStyleMutationOptions({ queryClient, api }),
    ).mutate(CLIENT_ID);

    expect(result).toMatchObject({ version: 3, sourceJobId: null });
    expect(cached(CLIENT_ID)).toMatchObject({
      version: 3,
      sourceJobId: null,
      markdown: '# Style: Arc Fitness\n',
    });
    expect(stale(CLIENT_ID)).toBe(true);
    expect(stale(OTHER_ID)).toBe(false);
  });

  it('leaves the cache alone when it is refused', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/${CLIENT_ID}/style/undo`, () =>
        HttpResponse.json({ error: 'There is no earlier style to go back to.' }, { status: 409 }),
      ),
    );
    await expect(
      new MutationObserver(
        queryClient,
        undoClientStyleMutationOptions({ queryClient, api }),
      ).mutate(CLIENT_ID),
    ).rejects.toMatchObject({ status: 409, message: 'There is no earlier style to go back to.' });
    expect(cached(CLIENT_ID)).toEqual(cachedStyle(CLIENT_ID));
    expect(stale(CLIENT_ID)).toBe(false);
  });
});
