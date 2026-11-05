import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsEnabled,
  graphicsEnabled,
  HEALTH_KEY,
  lutsEnabled,
  lutsInEditsEnabled,
} from './health-query';
import { createLutsApi } from './luts-api';
import {
  LUT_LIST_KEY,
  LUTS_KEY,
  lutKey,
  lutQueryOptions,
  lutsQueryOptions,
  useLutsEnabled,
  useLutsInEditsEnabled,
} from './luts-query';
import { BASE_URL, createTestQueryClient, makeLutDetail, makeLutSummary } from './test-utils';

// The LUTs switches as the page reads them: off until the health answer says on, and nothing of
// LUTs is asked while they are off.

const health: HealthResponse = {
  ok: true,
  version: '0.35.7',
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
  return (
    <p>
      {String(useLutsEnabled())} {String(useLutsInEditsEnabled())}
    </p>
  );
}

describe('lutsEnabled and lutsInEditsEnabled', () => {
  it('are off until the health answer is in, and for an answer that says off', () => {
    expect(lutsEnabled(undefined)).toBe(false);
    expect(lutsInEditsEnabled(undefined)).toBe(false);
    expect(lutsEnabled(health)).toBe(false);
    expect(lutsInEditsEnabled(health)).toBe(false);
  });

  it('are on when the health answer says so, and do not follow the other switches', () => {
    expect(lutsEnabled({ ...health, luts: true })).toBe(true);
    expect(lutsEnabled({ ...health, graphics: true, music: true, lutsInEdits: true })).toBe(false);
    expect(graphicsEnabled({ ...health, luts: true })).toBe(false);
    expect(analyticsEnabled({ ...health, luts: true, lutsInEdits: true })).toBe(false);
  });

  it('let notes name a LUT only while both switches are on', () => {
    expect(lutsInEditsEnabled({ ...health, luts: true })).toBe(false);
    expect(lutsInEditsEnabled({ ...health, lutsInEdits: true })).toBe(false);
    expect(lutsInEditsEnabled({ ...health, luts: true, lutsInEdits: true })).toBe(true);
  });
});

describe('useLutsEnabled and useLutsInEditsEnabled', () => {
  it('are false before the health answer is in, and follow it after', () => {
    expect(render(<Enabled />)).toBe('<p>false false</p>');
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Enabled />)).toBe('<p>false false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, luts: true });
    expect(render(<Enabled />)).toBe('<p>true false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, luts: true, lutsInEdits: true });
    expect(render(<Enabled />)).toBe('<p>true true</p>');
  });
});

describe('the LUTs queries', () => {
  const api = createLutsApi({ baseUrl: BASE_URL });
  const list = { yours: [makeLutSummary()], builtIn: [], builtInAvailable: false };

  it('have keys that all start with ["luts"]', () => {
    expect(LUTS_KEY).toEqual(['luts']);
    expect(LUT_LIST_KEY).toEqual(['luts', 'list']);
    expect(lutKey('golden-hour-warm')).toEqual(['luts', 'one', 'golden-hour-warm']);
  });

  it('ask nothing while they are not enabled', async () => {
    const asked = vi.fn(() => HttpResponse.json(list));
    server.use(http.get(`${BASE_URL}/api/luts`, asked));
    const stop = new QueryObserver(queryClient, lutsQueryOptions(api, false)).subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(asked).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(LUT_LIST_KEY)).toBeUndefined();
  });

  it('load the list and one LUT when they are', async () => {
    server.use(
      http.get(`${BASE_URL}/api/luts`, () => HttpResponse.json(list)),
      http.get(`${BASE_URL}/api/luts/:slug`, () => HttpResponse.json(makeLutDetail())),
    );
    expect(await queryClient.fetchQuery(lutsQueryOptions(api))).toEqual(list);
    expect(await queryClient.fetchQuery(lutQueryOptions(api, 'golden-hour-warm'))).toEqual(
      makeLutDetail(),
    );
  });

  it('do not ask again after a 404', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/luts/:slug`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'There is no such LUT.' }, { status: 404 });
      }),
    );
    const options = lutQueryOptions(api, 'nope');
    await expect(queryClient.fetchQuery(options)).rejects.toThrow('There is no such LUT.');
    expect(calls).toBe(1);
  });
});
