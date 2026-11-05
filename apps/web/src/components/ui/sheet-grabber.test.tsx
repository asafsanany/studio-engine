import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SheetGrabber } from './sheet-grabber';

describe('<SheetGrabber>', () => {
  const html = renderToStaticMarkup(<SheetGrabber onClose={vi.fn()} className="pt-2" />);

  it('is the 36 × 5 px pill, a picture for a screen reader', () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-slot="sheet-grabber"');
    expect(html).toMatch(/<span class="[^"]*h-\[5px\][^"]*w-9[^"]*rounded-full/);
  });

  it('takes the touch for itself, so a drag on it moves the sheet and does not scroll the page', () => {
    expect(html).toContain('touch-none');
  });

  it('reaches above the pill and well below it, a touch area bigger than the picture', () => {
    expect(html).toContain('before:-top-2');
    expect(html).toContain('before:-bottom-4');
  });

  it('takes the caller’s spacing', () => {
    expect(html).toContain('pt-2');
  });
});
