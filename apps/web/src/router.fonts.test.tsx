import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { FONT_LIST_KEY } from '@/data/fonts-query';
import { HEALTH_KEY } from '@/data/health-query';
import {
  createEditorQueryClient,
  createTestQueryClient,
  makeFontFace,
  makeFontFamilySummary,
  makeFontRequest,
} from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The Fonts page in the real app frame, with the switch off (the default: as if it did not exist)
// and on (the sidebar item, the route, the list of FN6 and the stubs of FN7 and FN9).

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

function clientWith(fonts: boolean | null, overrides: Partial<HealthResponse> = {}) {
  const queryClient = createTestQueryClient();
  if (fonts !== null) queryClient.setQueryData(HEALTH_KEY, { ...health, fonts, ...overrides });
  return queryClient;
}

describe('the Fonts page with the switch off', () => {
  it('is Not found, and the sidebar has no Fonts item', async () => {
    const html = await renderApp('/fonts', clientWith(false));
    expect(html).toContain('No such page.');
    expect(html).not.toContain('data-slot="fonts-page"');
    expect(html).not.toContain('data-slot="font-list"');
    expect(html).not.toContain('data-slot="font-pane"');
    expect(html).not.toContain('data-slot="import-fonts-dialog"');
    expect(html).not.toContain('href="/fonts"');
  });

  it('stays off when only the second switch is on', async () => {
    const html = await renderApp('/fonts', clientWith(false, { fontsInNotes: true }));
    expect(html).toContain('No such page.');
    expect(html).not.toContain('href="/fonts"');
  });

  it('leaves the other pages as they were', async () => {
    const html = await renderApp('/jobs', clientWith(false));
    expect(html).not.toContain('Fonts');
    expect(html).not.toContain('href="/fonts"');
  });

  it('draws nothing until the engine has said whether the page exists', async () => {
    const html = await renderApp('/fonts', clientWith(null));
    expect(html).not.toContain('No such page.');
    expect(html).not.toContain('data-slot="fonts-page"');
  });
});

describe('the Fonts page with the switch on', () => {
  it('shows the frame at /fonts: the heading, Import fonts, the list and the two stubs', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    expect(html).toContain('data-slot="fonts-page"');
    expect(html).toContain('>Fonts</h1>');
    expect(html).toContain('Every edit can use these. Import your own.');
    expect(html).toContain('Import fonts');
    expect(html).toContain('data-slot="font-list"');
    expect(html).toContain('aria-label="Script"');
    expect(html).toContain('data-slot="font-pane"');
    expect(html).toContain('>Font preview</h2>');
    expect(html).toContain('data-slot="import-fonts-dialog"');
    expect(html).not.toContain('No such page.');
  });

  it('puts the 440 px pane beside the main column', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('w-[440px]');
    expect(html.indexOf('data-slot="font-list"')).toBeLessThan(
      html.indexOf('data-slot="font-pane"'),
    );
  });

  // CVP-367 (C49): in a window under 1000 px the fixed 440 px pane left the list under 270 px and
  // the tabs ran behind it. The pane is still 440 px, but it is the one that gives way (down to
  // 320 px), and the list column keeps 360 px (its 296 px list) while the pane can still shrink.
  // The widths themselves are measured in a browser by e2e/fonts.spec.ts.
  it('lets the pane give way in a narrow window: 440 px, down to 320 px, never past the list', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    const pane = html.match(/<aside[^>]*aria-label="Preview"[^>]*>/)?.[0] ?? '';
    expect(pane).toContain('w-[440px]');
    expect(pane).toContain('min-w-80');
    expect(pane).not.toContain('flex-none');
    const column = html.match(
      /<section[^>]*class="[^"]*min-w-\[min\(22\.5rem,calc\(100%-20rem\)\)\][^"]*"/,
    )?.[0];
    expect(column).toBeDefined();
    expect(column).toContain('flex-1');
    expect(column).not.toMatch(/\bmin-w-0\b/);
  });

  it('lets the heading and the Import fonts button wrap, with the title block never under 128 px', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    const title = html.match(/<div[^>]*class="([^"]*)"[^>]*><h1/)?.[1] ?? '';
    expect(title.split(/\s+/)).toEqual(
      expect.arrayContaining(['min-w-32', 'flex-1', 'basis-32', 'max-w-fit']),
    );
    const row = html.match(/<div class="([^"]*)"><div class="[^"]*"><h1/)?.[1] ?? '';
    expect(row.split(/\s+/)).toContain('flex-wrap');
  });

  it('has Fonts in the sidebar after Clients, and in the trail', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    expect(html).toContain('href="/fonts"');
    expect(html.indexOf('href="/clients"')).toBeLessThan(html.indexOf('href="/fonts"'));
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('Page not found');
  });

  it('puts Fonts after LUTs and Graphics when all are on', async () => {
    const html = await renderApp('/fonts', clientWith(true, { graphics: true, luts: true }));
    expect(html.indexOf('href="/graphics"')).toBeLessThan(html.indexOf('href="/luts"'));
    expect(html.indexOf('href="/luts"')).toBeLessThan(html.indexOf('href="/fonts"'));
  });

  it('keeps the other pages as they were, with the sidebar item', async () => {
    const html = await renderApp('/jobs', clientWith(true));
    expect(html).not.toContain('data-slot="font-list"');
    expect(html).toContain('href="/fonts"');
  });

  it('draws the one toaster', async () => {
    const html = await renderApp('/fonts', clientWith(true));
    expect(html.split('aria-label="Notifications').length - 1).toBe(1);
  });

  it('opens on a family named in the address without changing the frame', async () => {
    const html = await renderApp('/fonts?family=heebo', clientWith(true));
    expect(html).toContain('data-slot="fonts-page"');
    expect(html).toContain('data-slot="font-pane"');
  });

  it('is Not found for a path below it', async () => {
    const html = await renderApp('/fonts/heebo', clientWith(true));
    expect(html).toContain('No such page.');
  });

  it('is not the page of an editor: no sidebar item, and nothing of the page', async () => {
    const queryClient = createEditorQueryClient();
    queryClient.setQueryData(HEALTH_KEY, { ...health, fonts: true });
    const html = await renderApp('/fonts', queryClient);
    expect(html).not.toContain('href="/fonts"');
    expect(html).not.toContain('data-slot="fonts-page"');
  });
});

describe('the Fonts page and a note that asked for a font the library does not have (FN16)', () => {
  const requests = [
    makeFontRequest({
      name: 'Gotham Bold',
      jobName: 'Demo · Horizon FPV',
      at: '2026-10-25T09:30:00.000Z',
    }),
    makeFontRequest({
      id: 'b4d20f1c8e55',
      name: 'Avenir Next',
      jobName: 'Kova · Spring',
      at: '2026-10-25T08:00:00.000Z',
    }),
    makeFontRequest({
      id: 'c5e31a2d9f66',
      name: 'Proxima Nova',
      jobName: 'Arc · Launch',
      at: '2026-10-24T22:00:00.000Z',
    }),
  ];

  function withList(overrides: Partial<HealthResponse>, open = requests) {
    const queryClient = clientWith(true, overrides);
    queryClient.setQueryData(FONT_LIST_KEY, {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace()],
      requests: open,
    });
    return queryClient;
  }

  it('shows the banner on top, above the heading, with the newest request and the count', async () => {
    const html = await renderApp('/fonts', withList({ fontsInNotes: true }));
    expect(html).toContain('data-slot="missing-font-banner"');
    expect(html).toContain('Demo · Horizon FPV');
    expect(html).toContain('Gotham Bold');
    expect(html).toContain('(+2 more)');
    expect(html.indexOf('data-slot="missing-font-banner"')).toBeLessThan(
      html.indexOf('>Fonts</h1>'),
    );
    expect(html).not.toContain('Avenir Next');
  });

  it('shows one banner for one request, without a count', async () => {
    const html = await renderApp(
      '/fonts',
      withList({ fontsInNotes: true }, [requests[0] ?? makeFontRequest()]),
    );
    expect(html.split('data-slot="missing-font-banner"')).toHaveLength(2);
    expect(html).not.toContain('more)');
  });

  it('shows none while no request is open', async () => {
    const html = await renderApp('/fonts', withList({ fontsInNotes: true }, []));
    expect(html).not.toContain('data-slot="missing-font-banner"');
  });

  it('shows none while notes cannot name a font (fontsInNotes off), whatever the list holds', async () => {
    const html = await renderApp('/fonts', withList({ fontsInNotes: false }));
    expect(html).toContain('data-slot="fonts-page"');
    expect(html).not.toContain('data-slot="missing-font-banner"');
    expect(html).not.toContain('asked for');
  });
});
