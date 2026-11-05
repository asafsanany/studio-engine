import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createEditorQueryClient, createTestQueryClient, makeJob } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { PhoneTabBar } from './PhoneTabBar';
import { phoneTabsFor } from './phone-tabs';

const needsYou = [
  makeJob({ id: 'r1', state: 'review' }),
  makeJob({ id: 'r2', state: 'review' }),
  makeJob({ id: 'f1', state: 'failed' }),
  makeJob({ id: 'e1', state: 'editing' }),
];

function render(path: string, jobs = needsYou): Promise<string> {
  return renderAt(path, <PhoneTabBar pathname={path} jobs={jobs} />);
}

/** The opening tag of the tab link to `to`. */
const tab = (html: string, id: 'jobs' | 'clients' | 'money') =>
  html.match(new RegExp(`<a [^>]*data-tab="${id}"[^>]*>`))?.[0] ?? '';

describe('<PhoneTabBar>', () => {
  it('has the Jobs, Clients and Money tabs in a "Main" navigation, 61 px with the home-bar inset', async () => {
    const html = await render('/jobs');
    expect(html).toMatch(/<nav[^>]*aria-label="Main"/);
    expect(html).toContain('calc(49px + min(var(--safe-bottom) * 0.4, 12px))');
    expect(tab(html, 'jobs')).toContain('href="/jobs"');
    expect(tab(html, 'clients')).toContain('href="/clients"');
    expect(tab(html, 'money')).toContain('href="/money"');
    // Three equal parts, left to right: Jobs, Clients, Money (board MMoney).
    expect(html.match(/data-tab="([a-z]+)"/g)).toEqual([
      'data-tab="jobs"',
      'data-tab="clients"',
      'data-tab="money"',
    ]);
    expect(html).toMatch(/<nav[^>]*grid-cols-3/);
    expect(html).toContain('lucide-list-video');
    expect(html).toContain('lucide-users');
    expect(html).toContain('lucide-wallet');
    expect(html).toMatch(/<span>Money<\/span>/);
  });

  it('makes each tab 48 px tall, with 11 px labels', async () => {
    const html = await render('/jobs');
    expect(tab(html, 'jobs')).toContain('h-12');
    expect(tab(html, 'jobs')).toContain('text-[11px]');
  });

  it('whitens the tab the page belongs to and mutes the other, saying so with aria-current', async () => {
    const jobs = await render('/jobs');
    expect(tab(jobs, 'jobs')).toContain('aria-current="page"');
    expect(tab(jobs, 'jobs')).toContain('text-foreground');
    expect(tab(jobs, 'clients')).not.toContain('aria-current');
    expect(tab(jobs, 'clients')).toContain('text-muted-foreground');

    const clients = await render('/clients');
    expect(tab(clients, 'clients')).toContain('aria-current="page"');
    expect(tab(clients, 'jobs')).not.toContain('aria-current');
    expect(tab(clients, 'jobs')).toContain('text-muted-foreground');
  });

  it('keeps Clients white on a client’s page and on its Style page', async () => {
    for (const path of ['/clients/abc', '/clients/abc/style']) {
      const html = await render(path);
      expect(tab(html, 'clients'), path).toContain('aria-current="page"');
      expect(tab(html, 'jobs'), path).not.toContain('aria-current');
    }
  });

  it('whitens Money on the Money page and mutes the other two', async () => {
    const html = await render('/money');
    expect(tab(html, 'money')).toContain('aria-current="page"');
    expect(tab(html, 'money')).toContain('text-foreground');
    for (const id of ['jobs', 'clients'] as const) {
      expect(tab(html, id), id).not.toContain('aria-current');
      expect(tab(html, id), id).toContain('text-muted-foreground');
    }
  });

  it('puts "/" on Jobs too', async () => {
    expect(tab(await render('/'), 'jobs')).toContain('aria-current="page"');
  });

  describe('the badge on Jobs', () => {
    it('is a white pill with the number of jobs in Review or needing attention', async () => {
      const html = await render('/clients');
      const badge = html.match(/<span[^>]*data-slot="phone-tab-badge"[^>]*>([^<]*)<\/span>/);
      expect(badge?.[1]).toBe('3');
      expect(badge?.[0]).toContain('bg-foreground');
      expect(badge?.[0]).toContain('text-background');
      // Read as words, not as a stray number.
      expect(html).toContain('<span class="sr-only">, 3 need you</span>');
    });

    it('is on the Jobs tab only, and shows on every page the bar does', async () => {
      for (const path of ['/jobs', '/clients', '/clients/abc', '/money']) {
        const html = await render(path);
        expect(html.match(/data-slot="phone-tab-badge"/g), path).toHaveLength(1);
        const jobsTab = html.slice(
          html.indexOf('data-tab="jobs"'),
          html.indexOf('data-tab="clients"'),
        );
        expect(jobsTab, path).toContain('phone-tab-badge');
      }
    });

    it('is gone when nothing needs the person, and while the list is on its way', async () => {
      expect(await render('/jobs', [makeJob({ state: 'editing' })])).not.toContain(
        'phone-tab-badge',
      );
      const html = await renderAt('/jobs', <PhoneTabBar pathname="/jobs" jobs={undefined} />);
      expect(html).not.toContain('phone-tab-badge');
      expect(html).toContain('data-tab="jobs"');
    });

    it('leaves archived jobs out', async () => {
      const html = await render('/jobs', [
        makeJob({ state: 'review' }),
        makeJob({ state: 'failed', archivedAt: '2026-10-01T00:00:00.000Z' }),
      ]);
      expect(html).toMatch(/data-slot="phone-tab-badge"[^>]*>1</);
    });

    it('says 99+ for a count that would not fit', async () => {
      const many = Array.from({ length: 120 }, (_, i) => makeJob({ id: `j${i}`, state: 'review' }));
      expect(await render('/jobs', many)).toMatch(/data-slot="phone-tab-badge"[^>]*>99\+</);
    });
  });

  describe('where it shows', () => {
    it('is on the top-level pages', async () => {
      for (const path of [
        '/',
        '/jobs',
        '/clients',
        '/clients/abc',
        '/clients/abc/style',
        '/money',
      ]) {
        expect(await render(path), path).toContain('data-slot="phone-tab-bar"');
      }
    });

    it('draws nothing in Settings, or on a Mac page under the Back header', async () => {
      for (const path of ['/settings', '/analytics', '/clients/abc/series/s1']) {
        expect(await render(path), path).not.toContain('phone-tab-bar');
      }
    });
  });
});

describe('<PhoneTabBar> for an editor', () => {
  const renderFor = (path: string, client: QueryClient) =>
    renderAt(path, <PhoneTabBar pathname={path} jobs={needsYou} />, client);

  it('has Jobs and Clients only, in two equal parts, for an editor', async () => {
    const html = await renderFor('/jobs', createEditorQueryClient());
    expect(html.match(/data-tab="([a-z]+)"/g)).toEqual(['data-tab="jobs"', 'data-tab="clients"']);
    expect(html).toMatch(/<nav[^>]*grid-cols-2/);
    expect(html).not.toMatch(/<nav[^>]*grid-cols-3/);
    expect(html).not.toContain('href="/money"');
    expect(html).not.toContain('lucide-wallet');
    expect(html).not.toContain('>Money<');
  });

  it('still marks the page and counts the jobs that need the person', async () => {
    const html = await renderFor('/clients', createEditorQueryClient());
    expect(tab(html, 'clients')).toContain('aria-current="page"');
    expect(html).toMatch(/data-slot="phone-tab-badge"[^>]*>3</);
  });

  it('keeps the three tabs for the admin', async () => {
    const html = await renderFor('/jobs', createTestQueryClient());
    expect(html.match(/data-tab="([a-z]+)"/g)).toHaveLength(3);
    expect(html).toMatch(/<nav[^>]*grid-cols-3/);
  });

  it('has the tabs rule for each viewer in phoneTabsFor', () => {
    expect(phoneTabsFor().map((t) => t.id)).toEqual(['jobs', 'clients', 'money']);
    expect(phoneTabsFor(false).map((t) => t.id)).toEqual(['jobs', 'clients']);
  });
});
