import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphicsApi } from './graphics-api';
import {
  GRAPHIC_LIST_KEY,
  graphicKey,
  graphicQueryOptions,
  graphicsQueryOptions,
  useGraphicName,
  useGraphicsEnabled,
} from './graphics-query';
import { analyticsEnabled, graphicsEnabled, HEALTH_KEY } from './health-query';
import {
  BASE_URL,
  createTestQueryClient,
  GRAPHIC_ID,
  makeGraphicDetail,
  makeGraphicSummary,
} from './test-utils';

// The Graphics switch as the page reads it: off until the health answer says on, and nothing of
// Graphics is asked while it is off.

const health: HealthResponse = {
  ok: true,
  version: '0.17.1',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

function Enabled() {
  return <p>{String(useGraphicsEnabled())}</p>;
}

function Name({ id }: { id: string | undefined }) {
  return <p>{useGraphicName(id) ?? 'none'}</p>;
}

describe('graphicsEnabled', () => {
  it('is off until the health answer is in, and for an answer that says off', () => {
    expect(graphicsEnabled(undefined)).toBe(false);
    expect(graphicsEnabled(health)).toBe(false);
  });

  it('is on when the health answer says so, and does not follow the other switches', () => {
    expect(graphicsEnabled({ ...health, graphics: true })).toBe(true);
    expect(graphicsEnabled({ ...health, graphicsInEdits: true, analytics: true })).toBe(false);
    expect(analyticsEnabled({ ...health, graphics: true })).toBe(false);
  });
});

describe('useGraphicsEnabled', () => {
  it('is false before the health answer is in, and follows it after', () => {
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, graphics: true });
    expect(render(<Enabled />)).toBe('<p>true</p>');
  });
});

describe('the graphics queries', () => {
  const api = createGraphicsApi({ baseUrl: BASE_URL });

  it('ask nothing while they are not enabled', async () => {
    const asked = vi.fn(() => HttpResponse.json([]));
    server.use(http.get(`${BASE_URL}/api/graphics`, asked));
    const stop = new QueryObserver(queryClient, graphicsQueryOptions(api, false)).subscribe(
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(asked).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(GRAPHIC_LIST_KEY)).toBeUndefined();
  });

  it('load the list and one graphic when they are', async () => {
    server.use(
      http.get(`${BASE_URL}/api/graphics`, () => HttpResponse.json([makeGraphicSummary()])),
      http.get(`${BASE_URL}/api/graphics/:id`, () => HttpResponse.json(makeGraphicDetail())),
    );
    expect(await queryClient.fetchQuery(graphicsQueryOptions(api))).toEqual([makeGraphicSummary()]);
    expect(await queryClient.fetchQuery(graphicQueryOptions(api, GRAPHIC_ID))).toEqual(
      makeGraphicDetail(),
    );
    expect(graphicKey(GRAPHIC_ID)).toEqual(['graphics', 'one', GRAPHIC_ID]);
    expect(GRAPHIC_LIST_KEY).toEqual(['graphics', 'list']);
  });

  it('do not ask again after a 404', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/graphics/:id`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'There is no such graphic.' }, { status: 404 });
      }),
    );
    const options = graphicQueryOptions(api, 'ffffffffffff');
    await expect(queryClient.fetchQuery(options)).rejects.toThrow('There is no such graphic.');
    expect(calls).toBe(1);
  });
});

describe('useGraphicName', () => {
  it('names nothing while Graphics are off, or for no id', () => {
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Name id={GRAPHIC_ID} />)).toBe('<p>none</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, graphics: true });
    expect(render(<Name id={undefined} />)).toBe('<p>none</p>');
  });

  it('reads the name from the graphic’s page, else from the list, without asking', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, graphics: true });
    expect(render(<Name id={GRAPHIC_ID} />)).toBe('<p>none</p>');
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary({ name: 'From the list' })]);
    expect(render(<Name id={GRAPHIC_ID} />)).toBe('<p>From the list</p>');
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail({ name: 'From its page' }));
    expect(render(<Name id={GRAPHIC_ID} />)).toBe('<p>From its page</p>');
  });
});
