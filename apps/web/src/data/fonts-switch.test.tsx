import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFontsApi } from './fonts-api';
import {
  FONT_LIST_KEY,
  FONTS_KEY,
  fontKey,
  fontQueryOptions,
  fontsQueryOptions,
  useFontsEnabled,
  useFontsInNotesEnabled,
} from './fonts-query';
import {
  analyticsEnabled,
  fontsEnabled,
  fontsInNotesEnabled,
  graphicsEnabled,
  HEALTH_KEY,
  lutsEnabled,
} from './health-query';
import {
  BASE_URL,
  createTestQueryClient,
  makeFontFamilyDetail,
  makeFontFamilySummary,
} from './test-utils';

// The Fonts switches as the page reads them: off until the health answer says on, and nothing of
// Fonts is asked while they are off.

const health: HealthResponse = {
  ok: true,
  version: '0.37.1',
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
      {String(useFontsEnabled())} {String(useFontsInNotesEnabled())}
    </p>
  );
}

describe('fontsEnabled and fontsInNotesEnabled', () => {
  it('are off until the health answer is in, and for an answer that says off', () => {
    expect(fontsEnabled(undefined)).toBe(false);
    expect(fontsInNotesEnabled(undefined)).toBe(false);
    expect(fontsEnabled(health)).toBe(false);
    expect(fontsInNotesEnabled(health)).toBe(false);
  });

  it('are on when the health answer says so, and do not follow the other switches', () => {
    expect(fontsEnabled({ ...health, fonts: true })).toBe(true);
    expect(
      fontsEnabled({ ...health, graphics: true, music: true, luts: true, fontsInNotes: true }),
    ).toBe(false);
    expect(graphicsEnabled({ ...health, fonts: true })).toBe(false);
    expect(lutsEnabled({ ...health, fonts: true, fontsInNotes: true })).toBe(false);
    expect(analyticsEnabled({ ...health, fonts: true, fontsInNotes: true })).toBe(false);
  });

  it('let notes name a font only while both switches are on', () => {
    expect(fontsInNotesEnabled({ ...health, fonts: true })).toBe(false);
    expect(fontsInNotesEnabled({ ...health, fontsInNotes: true })).toBe(false);
    expect(fontsInNotesEnabled({ ...health, fonts: true, fontsInNotes: true })).toBe(true);
  });
});

describe('useFontsEnabled and useFontsInNotesEnabled', () => {
  it('are false before the health answer is in, and follow it after', () => {
    expect(render(<Enabled />)).toBe('<p>false false</p>');
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Enabled />)).toBe('<p>false false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, fonts: true });
    expect(render(<Enabled />)).toBe('<p>true false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, fonts: true, fontsInNotes: true });
    expect(render(<Enabled />)).toBe('<p>true true</p>');
  });
});

describe('the Fonts queries', () => {
  const api = createFontsApi({ baseUrl: BASE_URL });
  const list = { families: [makeFontFamilySummary()], catalog: [], requests: [] };

  it('have keys that all start with ["fonts"]', () => {
    expect(FONTS_KEY).toEqual(['fonts']);
    expect(FONT_LIST_KEY).toEqual(['fonts', 'list']);
    expect(fontKey('heebo')).toEqual(['fonts', 'one', 'heebo']);
  });

  it('ask nothing while they are not enabled', async () => {
    const asked = vi.fn(() => HttpResponse.json(list));
    server.use(http.get(`${BASE_URL}/api/fonts`, asked));
    const stop = new QueryObserver(queryClient, fontsQueryOptions(api, false)).subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(asked).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(FONT_LIST_KEY)).toBeUndefined();
  });

  it('load the list and one family when they are', async () => {
    server.use(
      http.get(`${BASE_URL}/api/fonts`, () => HttpResponse.json(list)),
      http.get(`${BASE_URL}/api/fonts/:slug`, () => HttpResponse.json(makeFontFamilyDetail())),
    );
    expect(await queryClient.fetchQuery(fontsQueryOptions(api))).toEqual(list);
    expect(await queryClient.fetchQuery(fontQueryOptions(api, 'heebo'))).toEqual(
      makeFontFamilyDetail(),
    );
  });

  it('do not ask again after a 404', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/fonts/:slug`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'There is no such font.' }, { status: 404 });
      }),
    );
    const options = fontQueryOptions(api, 'nope');
    await expect(queryClient.fetchQuery(options)).rejects.toThrow('There is no such font.');
    expect(calls).toBe(1);
  });
});
