import { describe, expect, it } from 'vitest';
import { libraryClient } from '../library-picker/test-helpers';
import type { FontPreviewPlan } from './font-preview';
import { renderReview } from './test-helpers';
import { useFontPreview } from './use-font-preview';

// The hook the Review dialog asks for the fonts to show: the note box's text, the font list (only
// while fontsInNotes is on) and the LUTs and graphics the notes can name.

function plan(
  text: string,
  options: Parameters<typeof libraryClient>[0] = { fontsInNotes: true },
  active = true,
): FontPreviewPlan | null {
  let found: FontPreviewPlan | null = null;
  function Probe() {
    found = useFontPreview({ text, active });
    return null;
  }
  renderReview(<Probe />, libraryClient(options));
  return found;
}

describe('useFontPreview', () => {
  it('is the fonts the note names, with fontsInNotes on', () => {
    const found = plan('Titles in @Rubik Black and captions in @Heebo Medium');
    expect(found?.captions?.label).toBe('@Heebo Medium');
    expect(found?.titles?.label).toBe('@Rubik Black');
  });

  it('reads a font beside a LUT, with LUTs in notes on or off', () => {
    const text = 'the captions in @Heebo Bold, make it @luts/cinematic';
    expect(plan(text, { fontsInNotes: true, inEdits: true })?.captions?.label).toBe('@Heebo Bold');
    expect(plan(text, { fontsInNotes: true, inEdits: false })?.captions?.label).toBe('@Heebo Bold');
  });

  it('is nothing for a note that names no font', () => {
    expect(plan('make the captions bigger')).toBeNull();
    expect(plan('')).toBeNull();
    expect(plan('the captions in @Gotham Bold')).toBeNull();
  });

  it('is nothing with fontsInNotes off, even when the font list is in the cache and the note names a font', () => {
    const text = 'the captions in @Heebo Bold';
    expect(plan(text, { fontsInNotes: false, fontList: true })).toBeNull();
    expect(plan(text, { fontsInNotes: false, fontList: false, inEdits: false })).toBeNull();
  });

  it('is nothing while the box is not there to be read (a voice note has its place)', () => {
    expect(plan('the captions in @Heebo Bold', { fontsInNotes: true }, false)).toBeNull();
  });
});
