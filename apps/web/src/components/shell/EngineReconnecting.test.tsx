import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EngineReconnecting, RECONNECTING_TEXT } from './EngineReconnecting';

/** Text of the rendered markup with tags removed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('<EngineReconnecting>', () => {
  it('says "Reconnecting to the engine…" while reconnecting', () => {
    const html = renderToStaticMarkup(<EngineReconnecting reconnecting />);
    expect(RECONNECTING_TEXT).toBe('Reconnecting to the engine…');
    expect(text(html)).toBe('Reconnecting to the engine…');
  });

  it('keeps an empty status region in the page otherwise, so a screen reader hears the change', () => {
    const html = renderToStaticMarkup(<EngineReconnecting reconnecting={false} />);
    expect(html).toContain('role="status"');
    expect(text(html)).toBe('');
    expect(renderToStaticMarkup(<EngineReconnecting reconnecting />)).toContain('role="status"');
  });

  it('is a calm state, not an error: muted text, no alarm colour, nothing to click or focus', () => {
    const html = renderToStaticMarkup(<EngineReconnecting reconnecting />);
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toMatch(/destructive|red-|status-failed|alert/);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('tabindex');
  });

  it('fades in on an ease-in-out curve, and the spinner is decorative and respects reduced motion', () => {
    const html = renderToStaticMarkup(<EngineReconnecting reconnecting />);
    expect(html).toContain('animate-in');
    expect(html).toContain('fade-in-0');
    expect(html).toContain('ease-in-out');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('motion-reduce:animate-none');
  });
});
