import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { FONT_LIST_KEY } from '@/data/fonts-query';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeFontFamilySummary } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';
import { makeRealFamilies } from './real-families-fixture';

// The Fonts page in the real app, over a seeded list: the open family comes from the address
// (`/fonts?family=…`), so a reload keeps it; with none named the first row is open.

const health: HealthResponse = {
  ok: true,
  version: '0.39.2',
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
  fonts: true,
  fontsInNotes: false,
  quickFixes: false,
};

function client(families = makeRealFamilies(), overrides: Partial<HealthResponse> = {}) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, ...overrides });
  if (families !== null) {
    queryClient.setQueryData(FONT_LIST_KEY, { families, catalog: [], requests: [] });
  }
  return queryClient;
}

const rowOf = (html: string, slug: string) =>
  html.match(new RegExp(`<li[^>]*data-font-slug="${slug}"[^>]*>`))?.[0] ?? '';

describe('the Fonts page’s list in the app', () => {
  it('draws the 40 rows of the cached list under the page’s heading and Import fonts', async () => {
    const html = await renderApp('/fonts', client());
    expect(html).toContain('data-slot="font-list"');
    expect(html.match(/data-font-slug=/g)).toHaveLength(40);
    expect(html).toContain('>Fonts</h1>');
    expect(html).toContain('Every edit can use these. Import your own.');
    expect(html).toContain('Heebo');
  });

  it('opens the first row when the address names none', async () => {
    const html = await renderApp('/fonts', client());
    expect(rowOf(html, 'alef')).toContain('data-selected="true"');
    expect(rowOf(html, 'heebo')).toContain('data-selected="false"');
  });

  it('opens the family the address names', async () => {
    const html = await renderApp('/fonts?family=heebo', client());
    expect(rowOf(html, 'heebo')).toContain('data-selected="true"');
    expect(rowOf(html, 'alef')).toContain('data-selected="false"');
  });

  it('treats an unknown slug as "the first row"', async () => {
    const html = await renderApp('/fonts?family=nope', client());
    expect(rowOf(html, 'alef')).toContain('data-selected="true"');
  });

  it('shows the used label as the engine gave it once notes can name a font', async () => {
    const families = [
      makeFontFamilySummary(),
      makeFontFamilySummary({
        slug: 'rubik',
        name: 'Rubik',
        used: 0,
        usedLabel: 'Not used yet',
      }),
    ];
    const html = await renderApp('/fonts', client(families, { fontsInNotes: true }));
    expect(html).toContain('14 jobs');
    expect(html).toContain('Not used yet');
  });

  it('shows no used column while notes cannot name a font (the default)', async () => {
    const families = [
      makeFontFamilySummary(),
      makeFontFamilySummary({ slug: 'rubik', name: 'Rubik' }),
    ];
    const html = await renderApp('/fonts', client(families));
    expect(html).toContain('data-font-slug="heebo"');
    expect(html).not.toContain('data-slot="font-used"');
    expect(html).not.toContain('14 jobs');
  });

  it('shows the empty library’s hint', async () => {
    const html = await renderApp('/fonts', client([]));
    expect(html).toContain('No fonts yet. Drop .ttf or .otf files anywhere on this page, or use');
    expect(html).not.toContain('data-font-slug=');
  });

  it('draws the list shell without rows before the first answer', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, health);
    const html = await renderApp('/fonts', queryClient);
    expect(html).toContain('data-slot="font-list"');
    expect(html).not.toContain('data-font-slug=');
    expect(html).toContain('aria-busy="true"');
  });

  it('enables the page’s Import fonts button while the engine is reachable', async () => {
    const html = await renderApp('/fonts', client());
    expect(html).toMatch(
      /<button[^>]*type="button"(?![^>]*disabled)[^>]*>(?:(?!<\/button>).)*Import fonts/s,
    );
  });
});
