import type { HealthResponse, SettingsResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { SETTINGS_KEY } from '@/data/settings-query';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The Settings page in the real app frame: the admin's page at /settings on the Mac.

const health: HealthResponse = {
  ok: true,
  version: '0.47.5',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: true,
  graphicsInEdits: true,
  music: false,
  luts: true,
  lutsInEdits: true,
  fonts: true,
  fontsInNotes: true,
  quickFixes: false,
};

const SETTINGS: SettingsResponse = {
  features: [
    { key: 'graphics', running: true, saved: true, lockedByEnv: false },
    { key: 'fonts', running: true, saved: true, lockedByEnv: false },
    { key: 'luts', running: true, saved: true, lockedByEnv: false },
    { key: 'claudePlanOnly', running: true, saved: true, lockedByEnv: false },
  ],
  canRestart: true,
};

function adminClient(settings: SettingsResponse = SETTINGS) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, health);
  queryClient.setQueryData(SETTINGS_KEY, settings);
  return queryClient;
}

const withSwitch = (
  key: SettingsResponse['features'][number]['key'],
  patch: Partial<SettingsResponse['features'][number]>,
): SettingsResponse => ({
  ...SETTINGS,
  features: SETTINGS.features.map((f) => (f.key === key ? { ...f, ...patch } : f)),
});
const withFonts = (patch: Partial<SettingsResponse['features'][number]>) =>
  withSwitch('fonts', patch);

describe('/settings for the admin', () => {
  it('shows the title and a switch for Graphics, Fonts, LUTs and Claude plan only, in that order', async () => {
    const html = await renderApp('/settings', adminClient());
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
    const rows = [...html.matchAll(/data-slot="feature-row" data-feature="(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(rows).toEqual(['graphics', 'fonts', 'luts', 'claudePlanOnly']);
    expect(html.match(/role="switch"/g)).toHaveLength(4);
  });

  it('shows the weekly Instagram scan in Features, with its words and off until it is turned on', async () => {
    const html = await renderApp(
      '/settings',
      adminClient({
        ...SETTINGS,
        features: [
          ...SETTINGS.features,
          { key: 'instagram', running: false, saved: false, lockedByEnv: false },
        ],
      }),
    );
    const row = html.match(/data-feature="instagram".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(row).toContain('Weekly Instagram scan');
    expect(row).toContain('Every Monday at 06:00 · about $0.05 a client a week, shares included');
    expect(row).toContain('aria-checked="false"');
    expect(html.indexOf('data-feature="instagram"')).toBeLessThan(
      html.indexOf('id="settings-claude"'),
    );
  });

  it('puts Claude plan only in a Claude section of its own, under Features', async () => {
    const html = await renderApp('/settings', adminClient());
    const features = html.indexOf('id="settings-features"');
    const claude = html.indexOf('id="settings-claude"');
    expect(features).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(features);
    expect(html.indexOf('data-feature="luts"')).toBeLessThan(claude);
    expect(html.indexOf('data-feature="claudePlanOnly"')).toBeGreaterThan(claude);
    expect(html).toContain('Claude plan only');
    expect(html).toContain('never the API');
  });

  it('shows Claude plan only as saved, and says a change waits for the restart', async () => {
    const off = await renderApp(
      '/settings',
      adminClient(withSwitch('claudePlanOnly', { saved: false })),
    );
    const row = off.match(/data-feature="claudePlanOnly".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(row).toContain('aria-checked="false"');
    expect(off).toContain('Claude plan only turns off after the restart.');
    expect(off).toContain('Restart engine');
    const on = await renderApp('/settings', adminClient());
    const onRow = on.match(/data-feature="claudePlanOnly".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(onRow).toContain('aria-checked="true"');
  });

  it('shows each switch as saved', async () => {
    const html = await renderApp('/settings', adminClient(withFonts({ saved: false })));
    const fonts = html.match(/data-feature="fonts".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(fonts).toContain('aria-checked="false"');
    const graphics = html.match(/data-feature="graphics".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(graphics).toContain('aria-checked="true"');
  });

  it('shows no restart while what runs is what is saved', async () => {
    const html = await renderApp('/settings', adminClient());
    expect(html).not.toContain('Restart engine');
    expect(html).not.toContain('Changes count after the engine restarts');
  });

  it('says a saved change waits for the restart, and offers the restart', async () => {
    const html = await renderApp('/settings', adminClient(withFonts({ saved: false })));
    expect(html).toContain('Fonts turns off after the restart.');
    expect(html).toContain('Restart engine');
  });

  it('tells how to restart when the engine cannot restart itself', async () => {
    const html = await renderApp(
      '/settings',
      adminClient({ ...withFonts({ saved: false }), canRestart: false }),
    );
    expect(html).toContain('can’t restart itself');
    expect(html).not.toContain('Restart engine');
  });

  it('locks a switch an environment variable decides', async () => {
    const html = await renderApp('/settings', adminClient(withFonts({ lockedByEnv: true })));
    const fonts = html.match(/data-feature="fonts".*?role="switch"[^>]*>/s)?.[0] ?? '';
    expect(fonts).toContain('disabled');
    expect(html).toContain('so it can’t be changed here');
  });

  it('has Settings as the current page in the sidebar and as the trail’s last step', async () => {
    const html = await renderApp('/settings', adminClient());
    const link = html.match(/<a [^>]*href="\/settings"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('aria-current="page"');
    expect(html).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Settings<\/span>/);
  });
});

describe('/settings: Settings › Instagram (Which clients)', () => {
  const INSTAGRAM_ON: SettingsResponse['features'][number] = {
    key: 'instagram',
    running: true,
    saved: true,
    lockedByEnv: false,
  };
  const CLIENTS = { running: 'active', saved: 'active', lockedByEnv: false } as const;
  const settings = (
    instagram: Partial<typeof INSTAGRAM_ON> | null = {},
    clients: Partial<NonNullable<SettingsResponse['instagramClients']>> | null = {},
  ): SettingsResponse => ({
    ...SETTINGS,
    features: [
      ...SETTINGS.features,
      ...(instagram === null ? [] : [{ ...INSTAGRAM_ON, ...instagram }]),
    ],
    ...(clients === null ? {} : { instagramClients: { ...CLIENTS, ...clients } }),
  });
  const page = (value: SettingsResponse) => renderApp('/settings', adminClient(value));
  const row = (html: string) =>
    html.match(/<div data-slot="instagram-clients-row".*?(?=<\/section>|$)/s)?.[0] ?? '';

  it('has Which clients right under the weekly scan while it is on, before the Claude section', async () => {
    const html = await page(settings());
    expect(html).toContain('data-slot="instagram-clients-row"');
    expect(html.indexOf('data-feature="instagram"')).toBeLessThan(
      html.indexOf('data-slot="instagram-clients-row"'),
    );
    expect(html.indexOf('data-slot="instagram-clients-row"')).toBeLessThan(
      html.indexOf('id="settings-claude"'),
    );
    expect(row(html)).toContain('Which clients');
  });

  it('is Active | All, with Active (the default) chosen, and says what Active skips', async () => {
    const markup = row(await page(settings()));
    const buttons = [
      ...markup.matchAll(
        /<button type="button" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g,
      ),
    ];
    expect(buttons.map((m) => [m[2], m[1]])).toEqual([
      ['Active', 'true'],
      ['All', 'false'],
    ]);
    expect(markup).toContain(
      'Clients with no job added or delivered in the last 60 days are skipped, unless their account was added in that time.',
    );
  });

  it('shows All as chosen, and says every client with an account is scanned', async () => {
    const markup = row(await page(settings({}, { running: 'all', saved: 'all' })));
    expect(markup).toMatch(/aria-pressed="true"[^>]*>All</);
    expect(markup).toContain('Every client with an Instagram account is scanned.');
  });

  it('is hidden while the weekly scan is off, and for an engine that sends no choice', async () => {
    expect(await page(settings({ saved: false, running: false }))).not.toContain('Which clients');
    expect(await page(settings({}, null))).not.toContain('Which clients');
    expect(await page(settings(null))).not.toContain('Which clients');
  });

  it('keeps the switch itself in Settings while it is off', async () => {
    const html = await page(settings({ saved: false, running: false }));
    expect(html).toContain('data-feature="instagram"');
    expect(html).toContain('Weekly Instagram scan');
  });

  it('says a saved change waits for the restart, and offers the restart', async () => {
    const html = await page(settings({}, { running: 'active', saved: 'all' }));
    expect(row(html)).toContain('Which clients changes to All after the restart.');
    expect(html).toContain('Restart engine');
    expect(html).toContain('Changes count after the engine restarts');
  });

  it('shows no restart while what runs is what is saved', async () => {
    const html = await page(settings());
    expect(html).not.toContain('Restart engine');
  });

  it('locks the choice when an environment variable decides it', async () => {
    const markup = row(await page(settings({}, { lockedByEnv: true })));
    expect(markup).toContain('so it can’t be changed here');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('/settings for an editor', () => {
  it('shows no Settings page and no Settings item in the sidebar', async () => {
    const queryClient = createEditorQueryClient();
    queryClient.setQueryData(HEALTH_KEY, health);
    const html = await renderApp('/settings', queryClient);
    expect(html).not.toContain('data-slot="feature-row"');
    const sidebar = html.slice(0, html.indexOf('data-slot="sidebar-footer"'));
    expect(sidebar).not.toContain('href="/settings"');
  });
});
