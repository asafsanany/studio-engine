import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Slider } from './slider';

// Radix renders the slider on the server without a measured size: the thumb is display:none and
// has no aria-valuenow, so the value shows in the Range's `right:` (100 - the position).

describe('<Slider>', () => {
  it('renders a role="slider" thumb named by the aria-label, which is not on the root', () => {
    const html = renderToStaticMarkup(<Slider aria-label="Volume" value={[0.5]} max={1} />);
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Volume"');
    expect(html.match(/aria-label=/g)).toHaveLength(1);
    expect(html).toMatch(/<span role="slider" aria-label="Volume"/);
    expect(html).toContain('aria-valuemax="1"');
    expect(html).toContain('right:50%');
  });

  it('renders one thumb per value, each with the label', () => {
    const html = renderToStaticMarkup(<Slider aria-label="Range" value={[10, 90]} />);
    expect(html.match(/role="slider"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Range"/g)).toHaveLength(2);
  });

  it('merges the track, range and thumb class props over the stock classes', () => {
    const html = renderToStaticMarkup(
      <Slider
        aria-label="Position"
        value={[1]}
        max={6}
        trackClassName="data-[orientation=horizontal]:h-1"
        rangeClassName="bg-foreground"
        thumbClassName="size-3 border-0 bg-foreground"
      />,
    );
    const range = /<span [^>]*data-slot="slider-range"[^>]*>/.exec(html)?.[0] ?? '';
    expect(range).toContain('bg-foreground');
    expect(range).not.toContain('bg-primary');

    const track = /<span [^>]*data-slot="slider-track"[^>]*>/.exec(html)?.[0] ?? '';
    expect(track).toContain('data-[orientation=horizontal]:h-1');
    expect(track).not.toContain('data-[orientation=horizontal]:h-1.5');

    const thumb = /<span [^>]*data-slot="slider-thumb"[^>]*>/.exec(html)?.[0] ?? '';
    expect(thumb).toMatch(/\bsize-3\b/);
    expect(thumb).not.toMatch(/\bsize-4\b/);
    expect(thumb).toMatch(/\bborder-0\b/);
    expect(thumb).not.toMatch(/\bborder\b(?!-)/);
    expect(thumb).not.toMatch(/\bbg-white\b/);
    // The rest of the stock thumb stays: a grey keyboard-only ring.
    expect(thumb).toContain('focus-visible:ring-4');
    expect(thumb).toContain('ring-ring/50');
  });

  it('puts children between the track and the thumb, so the thumb paints on top of them', () => {
    const html = renderToStaticMarkup(
      <Slider aria-label="Position" value={[1]} max={6}>
        <div data-testid="dots" />
      </Slider>,
    );
    const track = html.indexOf('data-slot="slider-track"');
    const dots = html.indexOf('data-testid="dots"');
    const thumb = html.indexOf('data-slot="slider-thumb"');
    expect(track).toBeGreaterThan(-1);
    expect(dots).toBeGreaterThan(track);
    expect(thumb).toBeGreaterThan(dots);
  });

  it('has the pointer cursor, and the arrow when disabled', () => {
    const html = renderToStaticMarkup(<Slider aria-label="Position" value={[0]} />);
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('data-[disabled]:cursor-default');

    const disabled = renderToStaticMarkup(<Slider aria-label="Position" value={[0]} disabled />);
    expect(disabled).toContain('data-disabled=""');
  });
});
