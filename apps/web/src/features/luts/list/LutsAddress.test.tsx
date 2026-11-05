import type { HealthResponse, LutListResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { LUT_LIST_KEY } from '@/data/luts-query';
import { createTestQueryClient, makeBuiltInLutSummary, makeLutSummary } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The LUTs page in the real app, over a seeded list: the open LUT and the tab come from the address
// (`/luts?lut=…&tab=…`), so a reload keeps them; the switch decides whether Copy @luts/name exists.

const health: HealthResponse = {
  ok: true,
  version: '0.35.12',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: true,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

const LIST: LutListResponse = {
  yours: [
    makeLutSummary(),
    makeLutSummary({ slug: 'sony-s-log3', name: 'Sony S-Log3', kind: 'camera', size: 65 }),
  ],
  builtIn: [
    makeBuiltInLutSummary(),
    makeBuiltInLutSummary({ slug: 'red-skin-fix', name: 'Red skin fix', kind: 'fix' }),
  ],
  builtInAvailable: true,
};

function client(overrides: Partial<HealthResponse> = {}, list: LutListResponse | null = LIST) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, ...overrides });
  if (list !== null) queryClient.setQueryData(LUT_LIST_KEY, list);
  return queryClient;
}

const rowOf = (html: string, slug: string) =>
  html.match(new RegExp(`<li[^>]*data-lut-slug="${slug}"[^>]*>`))?.[0] ?? '';

describe('the LUTs page’s list in the app', () => {
  it('draws the rows of the cached list under the page’s heading', async () => {
    const html = await renderApp('/luts', client());
    expect(html).toContain('data-slot="lut-list"');
    expect(html.match(/data-lut-slug=/g)).toHaveLength(4);
    expect(html).toContain('Golden Hour Warm');
  });

  it('opens the first row when the address names none', async () => {
    const html = await renderApp('/luts', client());
    expect(rowOf(html, 'golden-hour-warm')).toContain('data-selected="true"');
    expect(rowOf(html, 'film-contrast')).toContain('data-selected="false"');
  });

  it('opens the LUT the address names', async () => {
    const html = await renderApp('/luts?lut=film-contrast', client());
    expect(rowOf(html, 'film-contrast')).toContain('data-selected="true"');
    expect(rowOf(html, 'golden-hour-warm')).toContain('data-selected="false"');
  });

  it('shows the tab the address names, with only that kind’s rows', async () => {
    const html = await renderApp('/luts?tab=camera', client());
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"[^>]*>Camera</);
    expect(html.match(/data-lut-slug=/g)).toHaveLength(1);
    expect(rowOf(html, 'sony-s-log3')).toContain('data-selected="true"');
  });

  it('keeps both: the tab and the LUT in it', async () => {
    const html = await renderApp('/luts?lut=red-skin-fix&tab=fix', client());
    expect(html.match(/data-lut-slug=/g)).toHaveLength(1);
    expect(rowOf(html, 'red-skin-fix')).toContain('data-selected="true"');
  });

  it('treats an unknown tab word as All and an unknown slug as "the first row"', async () => {
    const html = await renderApp('/luts?lut=nope&tab=sideways', client());
    expect(html.match(/data-lut-slug=/g)).toHaveLength(4);
    expect(rowOf(html, 'golden-hour-warm')).toContain('data-selected="true"');
  });

  it('enables the Import LUTs button while the engine is reachable', async () => {
    const html = await renderApp('/luts', client());
    expect(html).toMatch(
      /<button[^>]*type="button"(?![^>]*disabled)[^>]*>(?:(?!<\/button>).)*Import LUTs/s,
    );
  });

  it('draws the list shell without rows before the first answer', async () => {
    const html = await renderApp('/luts', client({}, null));
    expect(html).toContain('data-slot="lut-list"');
    expect(html).not.toContain('data-lut-slug=');
    expect(html).toContain('aria-busy="true"');
  });
});
