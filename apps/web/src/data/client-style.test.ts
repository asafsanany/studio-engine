import { type ClientStyleResponse, noClientStyle, type ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import {
  applyClientStyle,
  CLIENT_STYLES_KEY,
  clientStyleKey,
  clientStyleQueryOptions,
  reloadClientStyle,
} from './client-style';
import { createJobEventsClient } from './job-events';
import { BASE_URL, createTestQueryClient, fakeEventSources, manualTimers } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const KOVA = 'cafe00000001';
const ARC = 'cafe00000002';

const ready = (clientId: string, markdown: string | null = '# Style: Kova Coffee\n') =>
  ({
    ...noClientStyle(clientId, 'Kova Coffee'),
    state: 'ready',
    version: 2,
    updatedAt: '2026-10-21T10:00:00.000Z',
    markdown,
  }) satisfies ClientStyleResponse;

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's style of each client, which a test changes between requests; `calls` counts GETs. */
function serverStyles(styles: Record<string, ClientStyleResponse>) {
  const state = { styles, calls: [] as string[] };
  server.use(
    http.get(`${BASE_URL}/api/clients/:clientId/style`, ({ params }) => {
      const id = String(params.clientId);
      state.calls.push(id);
      const style = state.styles[id];
      return style
        ? HttpResponse.json(style)
        : HttpResponse.json({ error: `Client ${id} not found` }, { status: 404 });
    }),
  );
  return state;
}

/** What `useClientStyle(clientId)` does in a component: keeps an observer on the query. */
function watchStyle(clientId: string) {
  return new QueryObserver(queryClient, clientStyleQueryOptions(api, clientId));
}

describe('clientStyleKey', () => {
  it('is [client-style, clientId], under the key every client-style query starts with', () => {
    expect(clientStyleKey(KOVA)).toEqual(['client-style', KOVA]);
    expect(clientStyleKey(KOVA).slice(0, 1)).toEqual([...CLIENT_STYLES_KEY]);
  });
});

describe('clientStyleQueryOptions', () => {
  it("loads the client's style from the server and keeps it fresh", async () => {
    serverStyles({ [KOVA]: ready(KOVA) });
    const observer = watchStyle(KOVA);
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(ready(KOVA)));
    expect(observer.getCurrentQuery().isStale()).toBe(false);
    unsubscribe();
  });

  it('does not ask again for an unknown client (a 404 will not change)', async () => {
    const styles = serverStyles({});
    const observer = new QueryObserver(queryClient, {
      ...clientStyleQueryOptions(api, 'gone'),
      retryDelay: 1,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    const error = observer.getCurrentResult().error;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404 });
    expect(styles.calls).toEqual(['gone']);
    unsubscribe();
  });

  it('retries an engine that cannot be reached', () => {
    const retry = clientStyleQueryOptions(api, KOVA).retry as (n: number, e: Error) => boolean;
    expect(retry(0, new ApiError(0, 'Cannot reach the Studio Engine server.'))).toBe(true);
    expect(retry(0, new ApiError(500, 'Internal server error'))).toBe(true);
    expect(retry(0, new ApiError(404, 'Client gone not found'))).toBe(false);
  });
});

describe('applyClientStyle', () => {
  const { markdown: _markdown, ...analysing } = {
    ...ready(KOVA),
    state: 'analysing' as const,
    pass: { kind: 'read' as const, mode: 'add' as const, fileCount: 2, jobId: null, job: null },
  };

  it('puts the answer over the cached style and keeps its markdown', () => {
    serverStyles({ [KOVA]: ready(KOVA) });
    queryClient.setQueryData(clientStyleKey(KOVA), ready(KOVA));

    applyClientStyle(queryClient, analysing);

    expect(queryClient.getQueryData(clientStyleKey(KOVA))).toEqual({
      ...analysing,
      markdown: '# Style: Kova Coffee\n',
    });
  });

  it('drops the pass of the style it replaces when the answer has none', () => {
    serverStyles({ [KOVA]: ready(KOVA) });
    queryClient.setQueryData(clientStyleKey(KOVA), { ...ready(KOVA), pass: analysing.pass });

    const { pass: _pass, ...withoutPass } = analysing;
    applyClientStyle(queryClient, withoutPass);

    expect(queryClient.getQueryData<ClientStyleResponse>(clientStyleKey(KOVA))?.pass).toBeNull();
  });

  it('loads the style again, so that the next answer is the server’s own', async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA, '# Style: Kova Coffee\nNew.\n') });
    const observer = watchStyle(KOVA);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(styles.calls).toHaveLength(1));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.markdown).toContain('New.'));

    applyClientStyle(queryClient, analysing);

    await vi.waitFor(() => expect(styles.calls).toHaveLength(2));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.state).toBe('ready'));
    unsubscribe();
  });

  it('writes nothing for a style nobody has loaded (and loads nothing)', () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA) });
    applyClientStyle(queryClient, analysing);
    expect(queryClient.getQueryData(clientStyleKey(KOVA))).toBeUndefined();
    expect(styles.calls).toEqual([]);
  });
});

describe('the client.upsert event', () => {
  function startClient() {
    const sources = fakeEventSources();
    const client = createJobEventsClient({
      queryClient,
      eventSourceFactory: sources.factory,
      timers: manualTimers().timers,
    });
    client.start();
    return { sources, client };
  }
  const upsert = (clientId: string): ServerEvent => ({
    type: 'client.upsert',
    style: { ...noClientStyle(clientId, 'Kova Coffee'), state: 'analysing', version: 1 },
  });

  it("loads that client's style again, and only that one's", async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA), [ARC]: ready(ARC) });
    const kova = watchStyle(KOVA);
    const arc = watchStyle(ARC);
    const stops = [kova.subscribe(() => {}), arc.subscribe(() => {})];
    await vi.waitFor(() => expect(styles.calls).toHaveLength(2));
    const { sources, client } = startClient();

    styles.styles[KOVA] = { ...ready(KOVA), version: 3, markdown: '# Style: Kova Coffee\nNew.\n' };
    sources.latest.emit(upsert(KOVA));

    await vi.waitFor(() => expect(kova.getCurrentResult().data?.version).toBe(3));
    expect(styles.calls.filter((id) => id === ARC)).toHaveLength(1);
    expect(kova.getCurrentResult().data?.markdown).toContain('New.');
    client.stop();
    for (const stop of stops) stop();
  });

  it('waits for the answer before it shows a change: the event has no markdown', async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA) });
    const observer = watchStyle(KOVA);
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(styles.calls).toHaveLength(1));
    const { sources, client } = startClient();

    sources.latest.emit(upsert(KOVA));

    // The cached style is still the one with its markdown until the server has answered again.
    expect(queryClient.getQueryData<ClientStyleResponse>(clientStyleKey(KOVA))?.state).toBe(
      'ready',
    );
    await vi.waitFor(() => expect(styles.calls).toHaveLength(2));
    client.stop();
    stop();
  });

  it('does nothing for a style nobody has loaded', async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA) });
    const { sources, client } = startClient();
    sources.latest.emit(upsert(KOVA));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(styles.calls).toEqual([]);
    client.stop();
  });

  it('loads every style on screen again after a (re)connect: events were missed meanwhile', async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA) });
    const observer = watchStyle(KOVA);
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(styles.calls).toHaveLength(1));
    // The jobs list is loaded by the hello too; this test has no server for it.
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([])));
    const { sources, client } = startClient();

    sources.latest.emit({ type: 'hello' });

    await vi.waitFor(() => expect(styles.calls).toHaveLength(2));
    client.stop();
    stop();
  });
});

describe('reloadClientStyle', () => {
  it('loads a cached style again', async () => {
    const styles = serverStyles({ [KOVA]: ready(KOVA) });
    const stop = watchStyle(KOVA).subscribe(() => {});
    await vi.waitFor(() => expect(styles.calls).toHaveLength(1));

    await reloadClientStyle(queryClient, KOVA);
    expect(styles.calls).toHaveLength(2);
    stop();
  });
});
