import { describe, expect, it } from 'vitest';
import { FontPreviewPill } from './FontPreviewPill';
import { renderReview, tagWith } from './test-helpers';

// The pill on the video while the note box names a font (board FOReview, chip and two). What it does
// when held is in e2e/fonts-preview.spec.ts; the keys that hold it are compareKeyAction's
// (paused-look.test.ts).

const HEEBO = { key: 'a', label: '@Heebo Bold' };
const RUBIK = { key: 'b', label: '@Rubik Black' };

function pill(shown = [HEEBO], comparing = false): string {
  return renderReview(<FontPreviewPill shown={shown} comparing={comparing} />);
}

describe('<FontPreviewPill>', () => {
  it('names the font: "Previewing @Heebo Bold", with a Compare button', () => {
    const html = pill();
    expect(html).toContain('>Previewing @Heebo Bold<');
    expect(html).toContain('>Compare<');
    expect(tagWith(html, 'aria-pressed')).toContain('aria-pressed="false"');
  });

  it('counts two fonts: "Previewing 2 fonts"', () => {
    const html = pill([HEEBO, RUBIK]);
    expect(html).toContain('>Previewing 2 fonts<');
    expect(html).not.toContain('@Heebo Bold');
  });

  it('shows Compare pressed while it is held', () => {
    expect(tagWith(pill([HEEBO], true), 'aria-pressed')).toContain('aria-pressed="true"');
  });

  it('is the look-on-the-paused-frame pill: bottom left, 34 px high, the same colours', () => {
    const wrapper = tagWith(pill(), 'data-slot="font-preview-pill"');
    expect(wrapper).toContain('absolute bottom-2.5 left-2.5');
    expect(wrapper).toContain('h-[34px]');
    expect(wrapper).toContain('rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)]');
    expect(wrapper).toContain('pr-1 pl-3 text-xs text-[#FAFAFA]');
    // Space and Enter belong to Compare there, not to play/pause.
    expect(wrapper).toContain('data-own-keys=""');
  });

  it('cuts a long name at the pill’s end in a narrow video, and keeps Compare whole', () => {
    const html = pill([{ key: 'c', label: '@Playfair Display ExtraBold Italic' }]);
    expect(tagWith(html, 'data-slot="font-preview-pill"')).toContain('max-w-[calc(100%-20px)]');
    expect(tagWith(html, 'title="Previewing @Playfair')).toContain('min-w-0 truncate');
  });

  it('writes the name left to right, whatever the page’s direction', () => {
    expect(tagWith(pill(), 'title="Previewing @Heebo Bold"')).toContain('dir="ltr"');
  });

  it('has the Compare button of the paused frame’s pill, ghost and 26 px high', () => {
    const button = tagWith(pill(), 'aria-pressed');
    expect(button).toContain('type="button"');
    expect(button).toContain('h-[26px]');
    expect(button).toContain('cursor-pointer');
  });
});
