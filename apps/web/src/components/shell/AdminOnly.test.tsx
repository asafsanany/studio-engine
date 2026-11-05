import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { ME_KEY } from '@/data/me-query';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';
import { adminGate } from './AdminOnly';

// The admin-only pages (Money, Analytics, Graphics, later Team) for the admin and for an editor.

describe('adminGate', () => {
  const admin = { role: 'admin' } as const;
  const editor = { role: 'editor' } as const;

  it('shows the page to the admin and sends an editor to Jobs, whatever this browser remembers', () => {
    expect(adminGate({ me: admin, remembered: 'editor', pending: false })).toBe('show');
    expect(adminGate({ me: editor, remembered: 'admin', pending: false })).toBe('redirect');
  });

  it('waits for the engine when nothing is known, so a reload does not flash Jobs', () => {
    expect(adminGate({ me: undefined, remembered: null, pending: true })).toBe('wait');
    expect(adminGate({ me: undefined, remembered: 'editor', pending: true })).toBe('wait');
  });

  it('shows the page at once where this browser remembers the admin', () => {
    expect(adminGate({ me: undefined, remembered: 'admin', pending: true })).toBe('show');
  });

  it('sends anyone the engine cannot name to Jobs once it has given up', () => {
    expect(adminGate({ me: undefined, remembered: null, pending: false })).toBe('redirect');
  });
});

describe('the admin-only pages in the real app', () => {
  it('open for the admin: Money shows its page', async () => {
    const html = await renderApp('/money', createTestQueryClient());
    expect(html).toContain('href="/money"');
    expect(html).toMatch(/<h1[^>]*>Money<\/h1>/);
  });

  it('draw nothing of the page for an editor (the redirect to Jobs happens as the page mounts)', async () => {
    for (const path of ['/money']) {
      const html = await renderApp(path, createEditorQueryClient());
      expect(html, path).not.toMatch(/<h1[^>]*>Money<\/h1>/);
      expect(html, path).not.toContain('href="/money"');
    }
  });

  it('draw nothing before the engine has said who is asking', async () => {
    const client = createTestQueryClient();
    client.removeQueries({ queryKey: ME_KEY });
    const html = await renderApp('/money', client);
    expect(html).not.toMatch(/<h1[^>]*>Money<\/h1>/);
  });
});

describe('Analytics and Graphics (switched on) for an editor', () => {
  const health: HealthResponse = {
    ok: true,
    version: '0.35.11',
    settleMs: 60_000,
    series: false,
    jobSheet: false,
    analytics: true,
    phone: false,
    graphics: true,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
  };

  it('show the admin their pages', async () => {
    const client = createTestQueryClient();
    client.setQueryData(HEALTH_KEY, health);
    expect(await renderApp('/graphics', client)).toContain('data-slot="graphics-list"');
  });

  it('draw nothing of them for an editor, and no sidebar items to them', async () => {
    for (const path of ['/graphics', '/graphics/new', '/analytics']) {
      const client = createEditorQueryClient();
      client.setQueryData(HEALTH_KEY, health);
      const html = await renderApp(path, client);
      expect(html, path).not.toContain('data-slot="graphics-list"');
      expect(html, path).not.toContain('data-slot="graphic-studio"');
      // The sidebar's links (the trail above the page is gone a moment later, with the redirect).
      const sidebar = html.slice(0, html.indexOf('data-slot="sidebar-footer"'));
      expect(sidebar, path).not.toContain('href="/graphics"');
      expect(sidebar, path).not.toContain('href="/analytics"');
      expect(sidebar, path).toContain('href="/jobs"');
    }
  });
});
