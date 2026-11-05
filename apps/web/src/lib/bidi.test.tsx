import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Bidi, bidiProps } from './bidi';

describe('<Bidi>', () => {
  it('renders a span with dir="auto" and the bidi class by default', () => {
    expect(renderToStaticMarkup(<Bidi>מאפיית הצפון</Bidi>)).toBe(
      '<span dir="auto" class="bidi">מאפיית הצפון</span>',
    );
  });

  it('renders as another element and merges extra classes and props', () => {
    const html = renderToStaticMarkup(
      <Bidi as="p" className="font-medium" title="Acme · מבצע חורף 2026">
        Acme · מבצע חורף 2026
      </Bidi>,
    );
    expect(html).toBe(
      '<p dir="auto" class="bidi font-medium" title="Acme · מבצע חורף 2026">Acme · מבצע חורף 2026</p>',
    );
  });

  it('exposes the same attributes for non-text elements such as inputs', () => {
    expect(bidiProps).toEqual({ dir: 'auto', className: 'bidi' });
  });
});
