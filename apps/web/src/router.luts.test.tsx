import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The LUTs page in the real app frame, with the switch off (the default: as if it did not exist)
// and on (the sidebar item, the route and the page).

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

function clientWith(luts: boolean | null, overrides: Partial<HealthResponse> = {}) {
  const queryClient = createTestQueryClient();
  if (luts !== null) queryClient.setQueryData(HEALTH_KEY, { ...health, luts, ...overrides });
  return queryClient;
}

describe('the LUTs page with the switch off', () => {
  it('is Not found, and the sidebar has no LUTs item', async () => {
    const html = await renderApp('/luts', clientWith(false));
    expect(html).toContain('No such page.');
    expect(html).not.toContain('data-slot="luts-page"');
    expect(html).not.toContain('data-slot="lut-list"');
    expect(html).not.toContain('href="/luts"');
  });

  it('stays off when only the second switch is on', async () => {
    const html = await renderApp('/luts', clientWith(false, { lutsInEdits: true }));
    expect(html).toContain('No such page.');
    expect(html).not.toContain('href="/luts"');
  });

  it('leaves the other pages as they were', async () => {
    const html = await renderApp('/jobs', clientWith(false));
    expect(html).not.toContain('LUTs');
    expect(html).not.toContain('href="/luts"');
  });

  it('draws nothing until the engine has said whether the page exists', async () => {
    const html = await renderApp('/luts', clientWith(null));
    expect(html).not.toContain('No such page.');
    expect(html).not.toContain('data-slot="luts-page"');
  });
});

describe('the LUTs page with the switch on', () => {
  it('shows the page at /luts: the heading, Import LUTs, the list and the pane', async () => {
    const html = await renderApp('/luts', clientWith(true));
    expect(html).toContain('data-slot="luts-page"');
    expect(html).toContain('>LUTs</h1>');
    expect(html).toContain('Colour looks the grade can use. Import your own .cube files.');
    expect(html).toContain('Import LUTs');
    expect(html).toContain('data-slot="lut-list"');
    expect(html).toContain('aria-label="Kind"');
    expect(html).toContain('data-slot="lut-pane"');
    expect(html).toContain('aria-label="LUT preview"');
    // the import dialog is closed, and no engine has been lost
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-slot="luts-offline-banner"');
    expect(html).not.toContain('No such page.');
  });

  it('puts the 440 px pane beside the main column', async () => {
    const html = await renderApp('/luts', clientWith(true));
    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('w-[440px]');
    expect(html.indexOf('data-slot="lut-list"')).toBeLessThan(html.indexOf('data-slot="lut-pane"'));
  });

  it('has LUTs in the sidebar after Clients, and in the trail', async () => {
    const html = await renderApp('/luts', clientWith(true));
    expect(html).toContain('href="/luts"');
    expect(html.indexOf('href="/clients"')).toBeLessThan(html.indexOf('href="/luts"'));
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('Page not found');
  });

  it('puts LUTs after Graphics when both are on', async () => {
    const html = await renderApp('/luts', clientWith(true, { graphics: true }));
    expect(html.indexOf('href="/graphics"')).toBeLessThan(html.indexOf('href="/luts"'));
  });

  it('keeps the other pages as they were, with the sidebar item', async () => {
    const html = await renderApp('/jobs', clientWith(true));
    expect(html).not.toContain('data-slot="lut-list"');
    expect(html).toContain('href="/luts"');
  });

  it('draws the one toaster', async () => {
    const html = await renderApp('/luts', clientWith(true));
    expect(html.split('aria-label="Notifications').length - 1).toBe(1);
  });

  it('is Not found for a path below it', async () => {
    const html = await renderApp('/luts/golden-hour-warm', clientWith(true));
    expect(html).toContain('No such page.');
  });
});
