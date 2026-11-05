import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { PhoneShell } from './PhoneShell';

function render(path: string): Promise<string> {
  return renderAt(
    path,
    <PhoneShell jobs={[makeJob()]}>
      <p>the page</p>
    </PhoneShell>,
  );
}

describe('<PhoneShell>', () => {
  it('frames the page: the safe-area inset on top, the page, and the tab bar in its slot', async () => {
    const html = await render('/jobs');
    expect(html).toContain('data-slot="phone-shell"');
    expect(html).toContain('pt-safe');
    // Pinned to the screen's edges, not a dvh height (short in a Home Screen app: a gap under the bar).
    expect(html).toMatch(/data-slot="phone-shell"[^>]*class="[^"]*fixed inset-0/);
    expect(html).toContain('<p>the page</p>');
    expect(html).toMatch(/data-slot="phone-tab-bar-slot"[^>]*><nav [^>]*data-slot="phone-tab-bar"/);
    expect(html).not.toContain('data-slot="phone-job-sheet"');
  });

  it('shows the tab bar on the top-level pages and leaves its slot empty elsewhere (PH18)', async () => {
    for (const path of ['/', '/jobs', '/clients', '/clients/abc', '/clients/abc/style', '/money']) {
      expect(await render(path), path).toMatch(/data-slot="phone-tab-bar-slot"[^>]*><nav /);
    }
    // Settings and a page under the Back header: the slot is empty, so it is hidden.
    for (const path of ['/settings', '/analytics']) {
      expect(await render(path), path).toMatch(/data-slot="phone-tab-bar-slot"[^>]*><\/div>/);
    }
  });

  it('counts the jobs in Review and needing attention on the Jobs tab', async () => {
    const html = await renderAt(
      '/jobs',
      <PhoneShell jobs={[makeJob({ state: 'review' }), makeJob({ state: 'failed' })]}>
        <p>the page</p>
      </PhoneShell>,
    );
    expect(html).toMatch(/data-slot="phone-tab-badge"[^>]*>2</);
  });

  it('gives a phone page (the jobs list, Settings, Clients, a client and Money) no Back header of the shell', async () => {
    for (const path of [
      '/',
      '/jobs',
      '/settings',
      '/clients',
      '/clients/abc',
      '/clients/abc/style',
      '/money',
    ]) {
      expect(await render(path), path).not.toContain('phone-back-header');
    }
  });

  it('puts a Back header over a page with no phone layout yet, so nothing is out of reach', async () => {
    for (const path of ['/analytics', '/clients/abc/series/s1']) {
      const html = await render(path);
      expect(html, path).toContain('data-slot="phone-back-header"');
      expect(html, path).toContain('Back');
      // The Back button keeps its 8 px sides: the button's own padding for an icon (px-3) would win.
      expect(html, path).toContain('has-[&gt;svg]:px-2');
      expect(html, path).toContain('<p>the page</p>');
    }
  });

  it('has exactly one region for the app’s messages, on every page (PH16)', async () => {
    for (const path of ['/jobs', '/settings', '/money', '/clients/abc']) {
      const html = await render(path);
      expect(html.match(/aria-label="Notifications/g), path).toHaveLength(1);
    }
  });

  it('makes the Back button at least 44 px tall', async () => {
    expect(await render('/analytics')).toContain('h-11');
  });
});
