import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FontDropOverlay, FontDropOverlayView } from './FontDropOverlay';

describe('<FontDropOverlayView>', () => {
  const html = renderToStaticMarkup(<FontDropOverlayView />);

  it("covers the page with the board's words", () => {
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('Drop to import');
    expect(html).toContain('.ttf, .otf, .woff or .woff2 files, or a folder of them');
  });

  it('has a dashed frame, lets events through and eases in', () => {
    expect(html).toContain('border-dashed');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('ease-in-out');
  });
});

describe('<FontDropOverlay>', () => {
  it('draws nothing until files are dragged over the page', () => {
    expect(renderToStaticMarkup(<FontDropOverlay onFiles={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<FontDropOverlay onFiles={() => {}} disabled />)).toBe('');
  });
});
