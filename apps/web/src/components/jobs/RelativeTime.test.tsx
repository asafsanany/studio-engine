import { describe, expect, it } from 'vitest';
import { RelativeTime } from './RelativeTime';
import { render } from './test-helpers';

const NOW = '2026-10-20T13:42:00.000Z';
const at = (iso: string) =>
  render(<RelativeTime iso={iso} now={NOW} timeZone="UTC" />).replace(/<[^>]*>/g, '');

describe('<RelativeTime>', () => {
  it('shows the relative text from the D3 formatter', () => {
    expect(at('2026-10-20T13:41:40.000Z')).toBe('Just now');
    expect(at('2026-10-20T13:41:00.000Z')).toBe('1 min ago');
    expect(at('2026-10-20T13:31:00.000Z')).toBe('11 min ago');
    expect(at('2026-10-20T09:02:00.000Z')).toBe('4 h ago');
    expect(at('2026-10-19T13:20:00.000Z')).toBe('Yesterday');
    expect(at('2026-10-18T15:32:00.000Z')).toBe('2 days ago');
    expect(at('2026-10-17T08:32:00.000Z')).toBe('3 days ago');
  });

  it('is a muted, focusable <time> element carrying the ISO timestamp', () => {
    const html = render(<RelativeTime iso="2026-10-20T13:41:00.000Z" now={NOW} />);
    expect(html).toMatch(
      /^<time dateTime="2026-10-20T13:41:00.000Z" tabindex="0" class="[^"]*text-muted-foreground/,
    );
  });

  it('merges a className', () => {
    const html = render(
      <RelativeTime iso="2026-10-20T13:41:00.000Z" now={NOW} className="text-xs" />,
    );
    expect(html).toContain('text-xs');
  });

  it('renders nothing for an unparsable timestamp', () => {
    expect(render(<RelativeTime iso="not a date" now={NOW} />)).toBe('');
  });

  it('follows the shared clock when no `now` is pinned', () => {
    // Rendered a moment ago, so the clock-driven text is "Just now".
    const html = render(<RelativeTime iso={new Date(Date.now() - 5000).toISOString()} />);
    expect(html).toContain('>Just now</time>');
  });
});
