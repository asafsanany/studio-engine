import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { TEAM_KEY } from '@/data/team-query';
import { createEditorQueryClient, createTestQueryClient, makeTeam } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The Team page in the real app frame (TM5): the admin's page at /settings/team.

const health: HealthResponse = {
  ok: true,
  version: '0.35.14',
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

function adminClient() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, health);
  queryClient.setQueryData(TEAM_KEY, makeTeam());
  return queryClient;
}

describe('/settings/team for the admin', () => {
  it('shows the title, Add person and the table with Yael and Amit', async () => {
    const html = await renderApp('/settings/team', adminClient());
    expect(html).toMatch(/<h1[^>]*>Team<\/h1>/);
    expect(html).toMatch(/>\s*Add person<\/button>/);
    expect(html).toContain('aria-label="Team"');
    expect(html).toContain('data-team-email="yael@example.com"');
    expect(html).toContain('data-team-email="amit@example.com"');
    expect(html).toContain('Arc Fitness');
  });

  it('has Team as the current page in the sidebar and as the trail’s last step', async () => {
    const html = await renderApp('/settings/team', adminClient());
    const link = html.match(/<a [^>]*href="\/settings\/team"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('aria-current="page"');
    expect(html).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Team<\/span>/);
  });

  it('is reachable from the sidebar of any other page', async () => {
    const html = await renderApp('/clients', adminClient());
    expect(html).toContain('href="/settings/team"');
  });
});

describe('/settings/team for an editor', () => {
  it('shows no Team page and no Team item in the sidebar', async () => {
    const queryClient = createEditorQueryClient();
    queryClient.setQueryData(HEALTH_KEY, health);
    const html = await renderApp('/settings/team', queryClient);
    expect(html).not.toContain('aria-label="Team"');
    expect(html).not.toContain('data-team-email');
    const sidebar = html.slice(0, html.indexOf('data-slot="sidebar-footer"'));
    expect(sidebar).not.toContain('href="/settings/team"');
    expect(sidebar).toContain('href="/jobs"');
  });
});
