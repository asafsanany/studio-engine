import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EmptyGraphics,
  LoadingGraphicRows,
  MakingSummary,
  NoMatchingGraphics,
  OfflineGraphicsBanner,
  UnreachableGraphics,
} from './GraphicsListStates';

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('<OfflineGraphicsBanner> (board GRStates 9)', () => {
  it('says the engine can’t be reached, when the list was last right, and that New graphic waits', () => {
    const heard = new Date(2026, 9, 22, 10, 42).getTime();
    const html = renderToStaticMarkup(<OfflineGraphicsBanner heardAt={heard} />);
    expect(textOf(html)).toBe(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. New graphic waits until it’s back.',
    );
  });

  it('is a status, with the amber no-wifi mark, flush under the header', () => {
    const html = renderToStaticMarkup(<OfflineGraphicsBanner heardAt={null} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('lucide-wifi-off');
    expect(html).toContain('text-status-held');
    expect(html).toContain('-mx-6 -mt-6');
    expect(textOf(html)).toBe(
      'Can’t reach the engine on your Mac. New graphic waits until it’s back.',
    );
  });
});

describe('<MakingSummary>', () => {
  it('is a blue dot and "N being made"', () => {
    const html = renderToStaticMarkup(<MakingSummary count={3} />);
    expect(html).toContain('bg-status-editing');
    expect(html).toContain('aria-hidden="true"');
    expect(textOf(html)).toBe('3 being made');
  });
});

describe('<EmptyGraphics> (board GRStates 1)', () => {
  it('has the circle with the shapes, the title, the line and a New graphic button', () => {
    const html = renderToStaticMarkup(<EmptyGraphics onNew={() => {}} />);
    expect(html).toContain('rounded-full');
    expect(html).toContain('lucide-shapes');
    expect(html).toMatch(/<h2[^>]*>No graphics yet<\/h2>/);
    expect(textOf(html)).toContain('Every edit can use what you make.');
    expect(html).toContain('lucide-plus');
    expect(textOf(html)).toMatch(/New graphic$/);
  });
});

describe('<NoMatchingGraphics>', () => {
  it('says what was searched for, trimmed, in its own direction', () => {
    const html = renderToStaticMarkup(<NoMatchingGraphics query="  אמת  " />);
    expect(html).toContain('No graphic matches “<bdi>אמת</bdi>”.');
  });
});

describe('<UnreachableGraphics>', () => {
  it('says "Can’t reach the engine." as an alert, with a Try again link-button', () => {
    const html = renderToStaticMarkup(<UnreachableGraphics onRetry={() => {}} />);
    expect(html).toMatch(/<span role="alert">Can’t reach the engine\.<\/span>/);
    expect(html).toMatch(/data-variant="link"[^>]*type="button"[^>]*>Try again</);
  });
});

describe('<LoadingGraphicRows>', () => {
  it('draws 8 placeholder rows of the list’s own height, with one text for screen readers', () => {
    const html = renderToStaticMarkup(<LoadingGraphicRows />);
    expect(html.match(/<li /g)).toHaveLength(8);
    expect(html.match(/h-11/g)).toHaveLength(8);
    expect(html.match(/Loading graphics…/g)).toHaveLength(1);
    expect(html).toContain('motion-reduce:animate-none');
  });
});
