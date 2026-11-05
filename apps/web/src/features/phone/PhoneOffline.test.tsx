import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/lib/test-router';
import { PhoneOffline, PhoneOfflineView } from './PhoneOffline';

function view(props: Partial<Parameters<typeof PhoneOfflineView>[0]> = {}): string {
  return renderToStaticMarkup(
    <PhoneOfflineView
      offline={false}
      title="Jobs"
      lastConnected="Last connected today at 14:02"
      trying={false}
      onRetry={vi.fn()}
      {...props}
    >
      <p>the page</p>
    </PhoneOfflineView>,
  );
}

describe('<PhoneOfflineView> while the Mac can be reached', () => {
  const html = view();

  it('shows the page and nothing of the message', () => {
    expect(html).toContain('<p>the page</p>');
    expect(html).not.toContain('data-slot="phone-offline"');
    expect(html).not.toContain('Can’t reach your Mac');
  });

  it('adds no box of its own to the layout, so the page’s header and main stay the shell’s children', () => {
    expect(html).toMatch(/<div[^>]*data-slot="phone-page"[^>]*class="contents"/);
  });
});

describe('<PhoneOfflineView> once the Mac cannot be reached', () => {
  const html = view({ offline: true });

  it('says so plainly, with the board’s title and words', () => {
    expect(html).toMatch(/<h2[^>]*>Can’t reach your Mac<\/h2>/);
    expect(html).toContain(
      'Studio Engine runs on your Mac. Check that the Mac is awake and that Tailscale is on, on the Mac and on this phone.',
    );
  });

  it('keeps the page mounted but hidden, so its state is there when the Mac is back', () => {
    expect(html).toMatch(
      /<div[^>]*data-slot="phone-page"[^>]*class="hidden"[^>]*><p>the page<\/p>/,
    );
  });

  it('shows the page’s name above the message, as the board shows "Jobs"', () => {
    expect(html).toMatch(/<h1[^>]*>Jobs<\/h1>/);
    expect(view({ offline: true, title: 'Settings' })).toMatch(/<h1[^>]*>Settings<\/h1>/);
  });

  it('has a "Try again" button at least 44 px tall, and when the Mac last answered', () => {
    const button = html.match(/<button\b[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('h-11');
    expect(button).toContain('aria-disabled="false"');
    expect(html).toContain('Try again');
    expect(html).toContain('Last connected today at 14:02');
  });

  it('says "Trying…" with a spinner while a try is on its way', () => {
    const trying = view({ offline: true, trying: true });
    expect(trying).toContain('Trying…');
    expect(trying).not.toContain('Try again');
    expect(trying).toContain('animate-spin');
    expect(trying).toContain('aria-disabled="true"');
  });

  it('leaves the "Last connected" line out when the Mac never answered', () => {
    const never = view({ offline: true, lastConnected: null });
    expect(never).not.toContain('Last connected');
    expect(never).toContain('Try again');
  });

  it('announces itself politely to a screen reader and is labelled by its title', () => {
    const section = html.match(/<section[^>]*data-slot="phone-offline"[^>]*>/)?.[0] ?? '';
    expect(section).toContain('aria-live="polite"');
    expect(section).toContain('aria-labelledby="phone-offline-title"');
    expect(html).toContain('id="phone-offline-title"');
  });
});

describe('<PhoneOffline> before the engine has been out of reach', () => {
  it('shows the page, as the shell had it before this screen existed', async () => {
    const html = await renderAt('/jobs', <PhoneOffline>the page</PhoneOffline>);
    expect(html).toContain('the page');
    expect(html).not.toContain('data-slot="phone-offline"');
  });
});
