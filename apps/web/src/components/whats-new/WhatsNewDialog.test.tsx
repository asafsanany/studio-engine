import type { Release } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import { describeReleases, WhatsNewDialog, WhatsNewPanel } from './WhatsNewDialog';

const release = (version: string, date = '2026-10-22', items?: string[]): Release => ({
  version,
  date,
  items: items ?? [`Change in ${version}.`],
});

// Newest first, the order the dialog is given them in.
const several = [
  release('0.2.1', '2026-10-24'),
  release('0.2.0', '2026-10-23'),
  release('0.1.2', '2026-10-22', ['First of two.', 'Second of two.']),
  release('0.1.1', '2026-10-21'),
];

/**
 * The dialog's inside as markup. It sits in an open `<Dialog>` like the real thing (its title and
 * description need that context); the dialog's own content box is portalled, which renders nothing
 * on the server, so the box is left out here.
 */
function render(releases: readonly Release[]): string {
  return renderToStaticMarkup(
    <Dialog open>
      <WhatsNewPanel releases={releases} onClose={vi.fn()} />
    </Dialog>,
  );
}

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
/** Visible text: tags removed, the one entity React emits for an apostrophe decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replace(/\s+/g, ' ')
    .trim();

describe('<WhatsNewPanel> with several releases', () => {
  const html = render(several);

  it('has one "What\'s new" title, and it is the dialog title', () => {
    expect(count(html, /<h2\b/g)).toBe(1);
    expect(html).toMatch(/<h2[^>]*data-slot="dialog-title"[^>]*>What&#x27;s new<\/h2>/);
  });

  it('lists every release in one dialog, in the order given (newest first)', () => {
    const at = several.map((r) => html.indexOf(`>v${r.version}<`));
    for (const index of at) expect(index).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(count(html, /data-slot="whats-new-release"/g)).toBe(4);
  });

  it('gives each release its version badge, its date and its bullets', () => {
    expect(html).toContain('24 Oct 2026');
    expect(html).toContain('dateTime="2026-10-24"');
    expect(html).toContain('21 Oct 2026');
    expect(html).toContain('<li>Change in 0.2.1.</li>');
    expect(html).toContain('<li>Change in 0.1.1.</li>');
    const bullets = ['<li>First of two.</li>', '<li>Second of two.</li>'].map((li) =>
      html.indexOf(li),
    );
    expect(bullets[0]).toBeGreaterThan(-1);
    expect(bullets[0]).toBeLessThan(bullets[1] as number);
  });

  it("keeps each release's bullets under its own badge", () => {
    const order = [
      '>v0.2.1<',
      '<li>Change in 0.2.1.</li>',
      '>v0.2.0<',
      '<li>Change in 0.2.0.</li>',
    ].map((needle) => html.indexOf(needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it('puts a separator between releases, not before the first or after the last', () => {
    const separators = html.match(/<div[^>]*data-slot="separator"[^>]*>/g) ?? [];
    expect(separators).toHaveLength(3);
    for (const tag of separators) expect(tag).toContain('role="none"');
    expect(html.indexOf('data-slot="separator"')).toBeGreaterThan(
      html.indexOf('data-slot="whats-new-release"'),
    );
    expect(html.lastIndexOf('data-slot="separator"')).toBeLessThan(
      html.lastIndexOf('data-slot="whats-new-release"'),
    );
  });

  it('has exactly one button, "Got it", styled as the primary action', () => {
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('data-variant="default"');
    expect(buttons[0]).toContain('type="button"');
    expect(html).toContain('>Got it</button>');
  });

  it('has no "Close all", no cards stacked behind and no counter', () => {
    expect(html).not.toContain('Close all');
    expect(html).not.toContain('whats-new-behind');
    expect(html).not.toContain('whats-new-card');
    expect(html).not.toContain('data-depth');
    expect(text(html)).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/i);
  });

  it('scrolls the list, not the header or the footer', () => {
    const scroller = html.match(/<section[^>]*data-slot="whats-new-scroll"[^>]*>/)?.[0] ?? '';
    expect(scroller).toContain('max-h-[70vh]');
    expect(scroller).toContain('overflow-y-auto');
    // The title is above the scroll area and the button is below it.
    expect(html.indexOf('dialog-title')).toBeLessThan(html.indexOf('whats-new-scroll'));
    expect(html.indexOf('whats-new-scroll')).toBeLessThan(html.indexOf('>Got it<'));
    const afterTitle = html.slice(html.indexOf('whats-new-scroll'));
    expect(afterTitle.indexOf('</h2>')).toBe(-1);
  });

  it('lets the keyboard scroll it, with a neutral ring that only keyboard focus shows', () => {
    const scroller = html.match(/<section[^>]*data-slot="whats-new-scroll"[^>]*>/)?.[0] ?? '';
    expect(scroller).toContain('tabindex="0"');
    expect(scroller).toContain('aria-label="Release notes"');
    expect(scroller).toContain('outline-none');
    expect(scroller).toContain('focus-visible:ring-[3px]');
    expect(scroller).toContain('focus-visible:ring-ring/35');
    expect(scroller).not.toMatch(/blue|3b82f6|\bfocus:ring/);
  });

  it('puts the version badge in a blue tint', () => {
    const badge = html.match(/<span[^>]*data-slot="badge"[^>]*>/)?.[0] ?? '';
    expect(badge).toContain('bg-primary/15');
    expect(badge).toContain('text-[#93c5fd]');
    // Proportional figures: tabular ones leave a gap after the "1" and the pill leans left.
    expect(badge).not.toContain('tabular-nums');
  });

  it('lets a screen reader hear the versions: a heading per release and a description', () => {
    expect(count(html, /<h3\b/g)).toBe(4);
    for (const { version } of several) {
      expect(html).toContain(`id="whats-new-${version}"`);
      expect(html).toContain(`aria-labelledby="whats-new-${version}"`);
    }
    expect(html).toContain('Release notes for 4 versions, newest first: 0.2.1 down to 0.1.1.');
    // The description is read aloud only: nothing is shown twice.
    const description = html.match(/<p[^>]*data-slot="dialog-description"[^>]*>/)?.[0] ?? '';
    expect(description).toContain('sr-only');
    expect(description).toMatch(/id="radix-[^"]*"/);
  });
});

describe('<WhatsNewPanel> with a single release', () => {
  const html = render([release('0.1.0', '2026-10-20', ['One.', 'Two.'])]);

  it('has no separator and one "Got it"', () => {
    expect(html).not.toContain('data-slot="separator"');
    expect(count(html, /<button\b/g)).toBe(1);
    expect(html).toContain('Got it');
    expect(html).not.toContain('Close all');
  });

  it('lists every bullet in order', () => {
    expect(html.indexOf('<li>One.</li>')).toBeGreaterThan(-1);
    expect(html.indexOf('<li>One.</li>')).toBeLessThan(html.indexOf('<li>Two.</li>'));
    expect(html).toContain('20 Oct 2026');
    expect(html).toContain('>v0.1.0<');
  });

  it('describes the one version', () => {
    expect(html).toContain('Release notes for version 0.1.0.');
  });
});

describe('describeReleases', () => {
  it('names the single version, or the range newest to oldest', () => {
    expect(describeReleases([release('0.3.0')])).toBe('Release notes for version 0.3.0.');
    expect(describeReleases([release('0.3.0'), release('0.2.0'), release('0.1.0')])).toBe(
      'Release notes for 3 versions, newest first: 0.3.0 down to 0.1.0.',
    );
  });

  it('is empty when there is nothing to describe', () => {
    expect(describeReleases([])).toBe('');
  });
});

describe('<WhatsNewDialog> on the server', () => {
  const markup = (open: boolean, releases: readonly Release[]) =>
    renderToStaticMarkup(<WhatsNewDialog open={open} releases={releases} onClose={vi.fn()} />);

  it('renders nothing while closed, and nothing without releases', () => {
    expect(markup(false, several)).toBe('');
    expect(markup(true, [])).toBe('');
  });
});

describe('<WhatsNewPanel> screenshots', () => {
  it('shows a release screenshot that exists, as a button that enlarges it', () => {
    const html = render([{ ...release('0.13.0'), screenshot: '0.13.0-whats-new.jpg' }]);
    expect(html).toMatch(/<button[^>]*aria-label="What changed in version 0\.13\.0: enlarge"/);
    expect(html).toMatch(/<img[^>]*alt="What changed in version 0\.13\.0"/);
  });

  it('shows no image for a release without one, or whose file is missing', () => {
    expect(render([release('0.1.1')])).not.toContain('<img');
    expect(render([{ ...release('0.1.1'), screenshot: 'nope.png' }])).not.toContain('<img');
  });
});
