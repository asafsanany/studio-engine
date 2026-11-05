import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LutDropOverlay, LutDropOverlayView } from './LutDropOverlay';

describe('<LutDropOverlayView>', () => {
  const html = renderToStaticMarkup(<LutDropOverlayView />);

  it("covers the page with the board's words", () => {
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('Drop to import');
    expect(html).toContain('.cube or .3dl files, or a folder of them');
  });

  it('has a dashed frame, lets events through and eases in', () => {
    expect(html).toContain('border-dashed');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('ease-in-out');
  });
});

describe('<LutDropOverlay>', () => {
  it('draws nothing until files are dragged over the page', () => {
    expect(renderToStaticMarkup(<LutDropOverlay onFiles={() => {}} />)).toBe('');
  });
});
