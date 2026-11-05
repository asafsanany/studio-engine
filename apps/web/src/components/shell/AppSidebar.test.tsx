import type { HealthResponse } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { HEALTH_KEY } from '@/data/health-query';
import { ME_KEY } from '@/data/me-query';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { APP_VERSION_LABEL } from '@/lib/version';
import { AppSidebar } from './AppSidebar';

function render(defaultOpen: boolean, path = '/jobs'): Promise<string> {
  return renderAt(
    path,
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
    </SidebarProvider>,
  );
}

const HEALTH: HealthResponse = {
  ok: true,
  version: '0.13.19',
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

/** The sidebar as the engine's health answer (the switches) leaves it. */
function renderWith(analytics: boolean, path = '/jobs'): Promise<string> {
  const client = createTestQueryClient();
  client.setQueryData(HEALTH_KEY, { ...HEALTH, analytics });
  return renderAt(
    path,
    <SidebarProvider defaultOpen>
      <AppSidebar />
    </SidebarProvider>,
    client,
  );
}

/** The opening tag of every element matching `selector`-ish regex, e.g. all <button ...>. */
function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? [];
}

describe('<AppSidebar> and the Analytics switch', () => {
  it('keeps Analytics the disabled "coming in a later phase" item while the switch is off', async () => {
    const markup = await renderWith(false);
    expect(tags(markup, 'a')).toHaveLength(5);
    expect(markup).not.toContain('href="/analytics"');
    expect(markup).toContain('aria-label="Analytics (coming in a later phase)"');
  });

  it('keeps it disabled before the health answer is in', async () => {
    const markup = await render(true);
    expect(markup).not.toContain('href="/analytics"');
    expect(markup).toContain('aria-label="Analytics (coming in a later phase)"');
  });

  it('links Analytics, with the chart icon, once the switch is on', async () => {
    const markup = await renderWith(true);
    const links = tags(markup, 'a');
    expect(links).toHaveLength(6);
    expect(links[3]).toContain('href="/analytics"');
    expect(links[4]).toContain('href="/settings/team"');
    expect(links[5]).toContain('href="/settings"');
    expect(markup).not.toContain('aria-label="Analytics (coming in a later phase)"');
    const analytics = markup.match(/<a [^>]*href="\/analytics"[^>]*>.*?<\/a>/s)?.[0] ?? '';
    expect(analytics).toContain('lucide-chart-column');
    expect(analytics).toContain('Analytics');
  });

  it('keeps Analytics between Money and Team, and Deliveries disabled', async () => {
    const markup = await renderWith(true);
    const labels = [...markup.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels.slice(0, 5)).toEqual(['Jobs', 'Clients', 'Deliveries', 'Money', 'Analytics']);
    const disabled = tags(markup, 'button').filter((tag) => tag.includes('aria-disabled="true"'));
    expect(disabled).toHaveLength(1);
  });

  it('marks Analytics as the current page at /analytics, and nothing else', async () => {
    const links = tags(await renderWith(true, '/analytics'), 'a');
    links.forEach((tag, i) => {
      expect(tag.includes('aria-current="page"'), `link ${i}`).toBe(i === 3);
    });
  });

  it('marks nothing as current at /analytics while the switch is off', async () => {
    for (const tag of tags(await renderWith(false, '/analytics'), 'a')) {
      expect(tag).not.toContain('aria-current');
    }
  });
});

describe('<AppSidebar> and the LUTs switch', () => {
  function renderLuts(luts: boolean | null, path = '/jobs'): Promise<string> {
    const client = createTestQueryClient();
    if (luts !== null) client.setQueryData(HEALTH_KEY, { ...HEALTH, luts });
    return renderAt(
      path,
      <SidebarProvider defaultOpen>
        <AppSidebar />
      </SidebarProvider>,
      client,
    );
  }

  it('has no LUTs item while the switch is off, or before the health answer is in', async () => {
    for (const luts of [false, null]) {
      const markup = await renderLuts(luts);
      expect(markup).not.toContain('href="/luts"');
      expect(markup).not.toContain('>LUTs<');
    }
  });

  it('links LUTs, with the palette icon, right after Clients once the switch is on', async () => {
    const markup = await renderLuts(true);
    expect(markup.indexOf('href="/clients"')).toBeLessThan(markup.indexOf('href="/luts"'));
    expect(markup.indexOf('href="/luts"')).toBeLessThan(markup.indexOf('href="/money"'));
    const luts = markup.match(/<a [^>]*href="\/luts"[^>]*>.*?<\/a>/s)?.[0] ?? '';
    expect(luts).toContain('lucide-palette');
    expect(luts).toContain('LUTs');
  });

  it('marks LUTs as the current page at /luts, and nothing else', async () => {
    const links = tags(await renderLuts(true, '/luts'), 'a');
    const current = links.filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/luts"');
  });
});

describe('<AppSidebar> and the Fonts switch', () => {
  function renderFonts(
    fonts: boolean | null,
    path = '/jobs',
    overrides: Partial<HealthResponse> = {},
  ): Promise<string> {
    const client = createTestQueryClient();
    if (fonts !== null) client.setQueryData(HEALTH_KEY, { ...HEALTH, fonts, ...overrides });
    return renderAt(
      path,
      <SidebarProvider defaultOpen>
        <AppSidebar />
      </SidebarProvider>,
      client,
    );
  }

  it('has no Fonts item while the switch is off, or before the health answer is in', async () => {
    for (const fonts of [false, null]) {
      const markup = await renderFonts(fonts);
      expect(markup).not.toContain('href="/fonts"');
      expect(markup).not.toContain('>Fonts<');
    }
  });

  it('has no Fonts item when only the second switch is on', async () => {
    const markup = await renderFonts(false, '/jobs', { fontsInNotes: true });
    expect(markup).not.toContain('href="/fonts"');
  });

  it('links Fonts, with the case-sensitive icon, right after Clients once the switch is on', async () => {
    const markup = await renderFonts(true);
    expect(markup.indexOf('href="/clients"')).toBeLessThan(markup.indexOf('href="/fonts"'));
    expect(markup.indexOf('href="/fonts"')).toBeLessThan(markup.indexOf('href="/money"'));
    const fonts = markup.match(/<a [^>]*href="\/fonts"[^>]*>.*?<\/a>/s)?.[0] ?? '';
    expect(fonts).toContain('lucide-case-sensitive');
    expect(fonts).toContain('Fonts');
  });

  it('puts Fonts after LUTs', async () => {
    const markup = await renderFonts(true, '/jobs', { luts: true, graphics: true });
    expect(markup.indexOf('href="/graphics"')).toBeLessThan(markup.indexOf('href="/luts"'));
    expect(markup.indexOf('href="/luts"')).toBeLessThan(markup.indexOf('href="/fonts"'));
  });

  it('marks Fonts as the current page at /fonts, and nothing else', async () => {
    const links = tags(await renderFonts(true, '/fonts'), 'a');
    const current = links.filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/fonts"');
  });
});

describe('<AppSidebar>', () => {
  let expanded = '';
  let collapsed = '';
  beforeAll(async () => {
    expanded = await render(true);
    collapsed = await render(false);
  });

  it('is an icon-collapsible sidebar that reflects its state', () => {
    expect(expanded).toContain('data-state="expanded"');
    expect(collapsed).toContain('data-state="collapsed"');
    expect(collapsed).toContain('data-collapsible="icon"');
  });

  it('has the brand name and the main navigation landmark', () => {
    expect(expanded).toContain('Studio Engine');
    expect(expanded).toContain('<nav aria-label="Main"');
  });

  it('links Jobs, Clients, Money, Team and Settings, and marks the one the open page belongs to as current', () => {
    const links = tags(expanded, 'a');
    expect(links).toHaveLength(5);
    expect(links[3]).toContain('href="/settings/team"');
    expect(links[4]).toContain('href="/settings"');
    expect(links[0]).toContain('href="/jobs"');
    expect(links[0]).toContain('aria-current="page"');
    expect(links[0]).toContain('data-active="true"');
    expect(links[1]).toContain('href="/clients"');
    expect(links[1]).not.toContain('aria-current');
    expect(links[1]).toContain('data-active="false"');
    expect(links[2]).toContain('href="/money"');
    expect(links[2]).not.toContain('aria-current');
  });

  it('puts Money between Clients and the future pages, with the Wallet icon', () => {
    const labels = [...expanded.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels.slice(0, 4)).toEqual(['Jobs', 'Clients', 'Deliveries', 'Money']);
    const money = expanded.match(/<a [^>]*href="\/money"[^>]*>.*?<\/a>/s)?.[0] ?? '';
    expect(money).toContain('lucide-wallet');
  });

  it.each([
    ['/', 0],
    ['/jobs', 0],
    ['/clients', 1],
    ['/clients/4d337086919d', 1],
    ['/money', 2],
    ['/settings/team', 3],
    ['/settings', 4],
  ])('follows the route: at %s the current page is link %i', async (path, current) => {
    const links = tags(await render(true, path), 'a');
    links.forEach((tag, i) => {
      expect(tag.includes('aria-current="page"'), `${path}: link ${i}`).toBe(i === current);
    });
  });

  it('marks neither as current on a page that does not exist', async () => {
    const links = tags(await render(true, '/nowhere'), 'a');
    expect(links).toHaveLength(5);
    for (const tag of links) expect(tag).not.toContain('aria-current');
  });

  it('renders the two future pages as aria-disabled buttons, never links', () => {
    const disabled = tags(expanded, 'button').filter((tag) => tag.includes('aria-disabled="true"'));
    expect(disabled).toHaveLength(2);
    for (const tag of disabled) {
      expect(tag).toContain('type="button"');
      expect(tag).not.toContain('href=');
      expect(tag).not.toContain(' disabled=');
    }
    for (const label of ['Deliveries', 'Analytics']) {
      expect(expanded).toContain(`aria-label="${label} (coming in a later phase)"`);
    }
    expect(expanded).not.toContain('aria-label="Money (coming in a later phase)"');
    expect(expanded).not.toContain('aria-label="Settings (coming in a later phase)"');
  });

  it('shows no badge on future pages', () => {
    expect(expanded).not.toContain('sidebar-menu-badge');
    expect(expanded).not.toMatch(/soon/i);
  });

  it('pins Settings to the bottom of the nav', () => {
    const settingsItem = expanded.match(/<li[^>]*mt-auto[^>]*>.*?<\/li>/s)?.[0] ?? '';
    expect(settingsItem).toContain('Settings');
    expect(expanded.match(/mt-auto/g)).toHaveLength(1);
  });

  it('shows the version on the left of the footer when expanded', () => {
    expect(expanded).toContain(`>${APP_VERSION_LABEL}<`);
  });

  it('labels the toggle for what it will do', () => {
    expect(expanded).toContain('aria-label="Collapse sidebar"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(collapsed).toContain('aria-label="Expand sidebar"');
    expect(collapsed).toContain('aria-expanded="false"');
  });

  it('hides the name and version on the icon rail by class (group-data collapsible=icon)', () => {
    expect(collapsed).toMatch(/group-data-\[collapsible=icon\]:hidden/);
  });
});

// The admin and an editor (Team plan, TM4): the sidebar of an editor has no Money, Analytics or
// Graphics, and its footer says who is signed in.
describe('<AppSidebar> for an editor', () => {
  const switchesOn = { ...HEALTH, analytics: true, graphics: true };

  function renderFor(client: QueryClient, path = '/jobs'): Promise<string> {
    client.setQueryData(HEALTH_KEY, switchesOn);
    return renderAt(
      path,
      <SidebarProvider defaultOpen>
        <AppSidebar />
      </SidebarProvider>,
      client,
    );
  }

  it('shows the admin every page, and no name in the footer', async () => {
    const markup = await renderFor(createTestQueryClient());
    for (const href of ['/jobs', '/clients', '/graphics', '/money', '/analytics']) {
      expect(markup, href).toContain(`href="${href}"`);
    }
    expect(markup).not.toContain('data-slot="sidebar-viewer"');
    expect(markup).not.toContain('Signed in as');
  });

  it('leaves Money, Analytics and Graphics out for an editor, with Jobs and Clients left', async () => {
    const markup = await renderFor(createEditorQueryClient());
    expect(markup).toContain('href="/jobs"');
    expect(markup).toContain('href="/clients"');
    for (const href of ['/graphics', '/money', '/analytics']) {
      expect(markup, href).not.toContain(`href="${href}"`);
    }
    expect(markup).not.toContain('>Money<');
    expect(markup).not.toContain('>Analytics<');
    expect(markup).not.toContain('>Graphics<');
  });

  it('says "Yael · Editor" in the footer beside the version, and hides it on the icon rail', async () => {
    const markup = await renderFor(createEditorQueryClient());
    const footer = markup.slice(markup.indexOf('data-slot="sidebar-footer"'));
    expect(footer).toContain(`>${APP_VERSION_LABEL}<`);
    expect(footer).toMatch(/<span[^>]*data-slot="sidebar-viewer"[^>]*>Yael · Editor<\/span>/);
    expect(footer.indexOf(APP_VERSION_LABEL)).toBeLessThan(footer.indexOf('Yael · Editor'));
    expect(footer).toMatch(/data-slot="sidebar-viewer"[^>]*group-data-\[collapsible=icon\]:hidden/);
  });

  it('says nothing about who is signed in until the engine has said', async () => {
    const client = createTestQueryClient();
    client.removeQueries({ queryKey: ME_KEY });
    const markup = await renderFor(client);
    expect(markup).not.toContain('data-slot="sidebar-viewer"');
    // Nothing is admin-only while it is unknown (nothing remembered in this browser either).
    expect(markup).not.toContain('href="/money"');
    expect(markup).toContain('href="/jobs"');
  });
});
