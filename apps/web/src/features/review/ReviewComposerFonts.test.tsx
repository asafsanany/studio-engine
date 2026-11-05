import { describe, expect, it } from 'vitest';
import { libraryClient } from '../library-picker/test-helpers';
import { ReviewComposer } from './ReviewComposer';
import { renderReview, tagWith } from './test-helpers';

// Review's note box with fonts in the notes (FN13; board FOReview). The sequences the board types:
// the picker for "@", "@he", "@heebo", "@heebo b", closed for "@Heebo Bold and bigger", "Make it
// @Heebo Bold " and "@xyz abc", and open for a Hebrew note. And the proof that with the switch
// off the box is what it was: the same markup whether or not the font list is anywhere.

type Options = { inEdits?: boolean; fontsInNotes?: boolean; fontList?: boolean };

function composer(draft: string, options: Options = {}): string {
  return renderReview(
    <ReviewComposer
      timeLabel="0:12"
      draft={draft}
      onDraftChange={() => {}}
      onAdd={() => {}}
      onFocus={() => {}}
      adding={false}
      error={null}
      composerRef={null}
    />,
    libraryClient(options),
  );
}

const ON = { inEdits: true, fontsInNotes: true } as const;

describe('<ReviewComposer> with fonts in the notes (fontsInNotes)', () => {
  it('says "@" points at a font, a LUT or a graphic', () => {
    expect(tagWith(composer('', ON), '<textarea')).toContain(
      'placeholder="Write a note… type @ to point at a font, a LUT or a graphic"',
    );
  });

  it('says a font alone when LUTs and graphics are off, and still has the picker', () => {
    const html = composer('@', { inEdits: false, fontsInNotes: true });
    expect(tagWith(html, '<textarea')).toContain(
      'placeholder="Write a note… type @ to point at a font"',
    );
    expect(html).toContain('data-slot="library-picker"');
    expect(html).toContain('>Fonts · recent<');
    expect(html).not.toContain('>LUTs<');
    expect(html).toContain('5 results. Heebo Bold selected.');
  });

  it('keeps the box in its own direction', () => {
    expect(tagWith(composer('@', ON), '<textarea')).toContain('dir="auto"');
  });

  it('"@": the recent fonts, then 3 LUTs and 3 graphics, the first font highlighted', () => {
    const html = composer('@', ON);
    expect(html).toContain('>Fonts · recent<');
    expect(html.match(/role="option"/g)).toHaveLength(11);
    const box = tagWith(html, '<textarea');
    expect(box).toContain('data-picker="open"');
    expect(box).toMatch(/aria-activedescendant="[^"]+-opt-0"/);
    expect(html).toContain('11 results. Heebo Bold selected.');
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf('data-slot="library-picker"'));
  });

  it('"@he": three families, one row each', () => {
    const html = composer('Make the captions @he', ON);
    expect(html).toContain('>Heebo</span>');
    expect(html).toContain('>Noto Sans Hebrew</span>');
    expect(html).toContain('>IBM Plex Sans Hebrew</span>');
    expect(html).toContain('3 results. Heebo selected.');
  });

  it('"@heebo": nine faces, Regular first, Bold second', () => {
    const html = composer('@heebo', ON);
    expect(html.match(/role="option"/g)).toHaveLength(9);
    expect(html.indexOf('>Heebo</span>')).toBeLessThan(html.indexOf('>Heebo Bold</span>'));
    expect(html.indexOf('>Heebo Bold</span>')).toBeLessThan(html.indexOf('>Heebo Thin</span>'));
    expect(html).toContain('9 results. Heebo selected.');
  });

  it('"@heebo b": Bold and Black', () => {
    const html = composer('@heebo b', ON);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('2 results. Heebo Bold selected.');
  });

  it('is closed for "@Heebo Bold and bigger", "Make it @Heebo Bold " and "@xyz abc"', () => {
    for (const draft of ['@Heebo Bold and bigger', 'Make it @Heebo Bold ', '@xyz abc']) {
      const html = composer(draft, ON);
      expect(html, draft).not.toContain('data-slot="library-picker');
      expect(tagWith(html, '<textarea'), draft).not.toContain('data-picker');
      expect(tagWith(html, '<textarea'), draft).not.toContain('aria-activedescendant');
    }
  });

  it('opens the small panel for "@xyz" and "Make the captions @Gotham"', () => {
    const html = composer('Make the captions @Gotham', ON);
    expect(html).toContain('Nothing in Fonts, LUTs or Graphics is called “Gotham”.');
    expect(tagWith(html, 'data-slot="library-picker-none"')).toContain('w-[320px]');
    expect(html).toContain('Open Fonts to import one');
    expect(html).not.toContain('role="listbox"');
    expect(tagWith(html, '<textarea')).toContain('data-picker="open"');
    expect(html).toContain('Nothing in Fonts, LUTs or Graphics is called “Gotham”.</div>');
  });

  it('opens in a Hebrew note after the hyphen: "ל-@he"', () => {
    const html = composer('תשנה את הכתוביות ל-@he', ON);
    expect(html).toContain('>Heebo</span>');
    expect(html).toContain('3 results. Heebo selected.');
  });

  it('still opens for "@luts/ci" with only the LUTs', () => {
    const html = composer('Make it @luts/ci', ON);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).not.toContain('>Fonts');
    expect(html).not.toContain('>Graphics<');
  });
});

describe('<ReviewComposer> with fonts in the notes: the "Uses" row (boards FOReview chip, two, hebrew)', () => {
  const FONT_LINE =
    'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.';

  it('has no row for a box that names no font (start "empty", "at", "none")', () => {
    for (const draft of ['', '@', 'Make the captions @Gotham', 'Make the captions @Heebo']) {
      const html = composer(draft, ON);
      expect(html.includes('data-slot="library-uses"'), draft).toBe(
        draft === 'Make the captions @Heebo',
      );
    }
  });

  it('shows one chip under the box for "Make the captions @Heebo Bold " (start "chip")', () => {
    const html = composer('Make the captions @Heebo Bold ', ON);
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf('data-slot="library-uses"'));
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    expect(html).toContain('@Heebo Bold<button');
    expect(html).toContain('aria-label="Remove @Heebo Bold from the note"');
    expect(html).toContain(FONT_LINE);
    expect(html).not.toContain('A LUT applies');
  });

  it('shows two chips and one font line for two fonts (start "two")', () => {
    const html = composer('Titles in @Rubik Black and captions in @Heebo Medium ', ON);
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(2);
    expect(html.split(FONT_LINE)).toHaveLength(2);
  });

  it('shows the chip of a font in a Hebrew note, left to right, in a box that follows the text (start "hebrew")', () => {
    const html = composer('תשנה את הכתוביות ל-@Heebo Bold ', ON);
    expect(tagWith(html, '<textarea')).toContain('dir="auto"');
    expect(tagWith(html, 'data-slot="library-chip"')).toContain('dir="ltr"');
    expect(html).toContain('@Heebo Bold<button');
  });

  it('shows a LUT after a hyphen too: "ל-@luts/cinematic"', () => {
    const html = composer('תשים ל-@luts/cinematic ', ON);
    expect(html).toContain('@luts/cinematic<button');
    expect(html).toContain('A LUT applies to the whole video.');
  });

  it('shows fonts alone when LUTs and graphics are off', () => {
    const html = composer('Make the captions @Heebo Bold @luts/cinematic ', {
      inEdits: false,
      fontsInNotes: true,
    });
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    expect(html).not.toContain('A LUT applies');
  });

  it('shows the small panel and no chip while a name is still being typed: "@Gotham"', () => {
    const html = composer('Make the captions @Gotham', ON);
    expect(html).toContain('data-slot="library-picker-none"');
    expect(html).not.toContain('data-slot="library-uses"');
  });
});

describe('<ReviewComposer> with the fonts switch off', () => {
  const DRAFTS = ['', '@', '@he', 'Make it @luts/ci', 'Make it @Heebo Bold ', '@qqq', 'ל-@he'];

  it('is the same box whether or not the font list is anywhere (it is never read)', () => {
    for (const draft of DRAFTS) {
      expect(composer(draft, { inEdits: true, fontsInNotes: false, fontList: true }), draft).toBe(
        composer(draft, { inEdits: true, fontsInNotes: false, fontList: false }),
      );
    }
  });

  it('has no chip for a font token, and a LUT chip is written as LU8 wrote it', () => {
    for (const fontList of [true, false]) {
      const options = { inEdits: true, fontsInNotes: false, fontList };
      const html = composer('Make the captions @Heebo Bold ', options);
      expect(html).not.toContain('data-slot="library-uses"');
      expect(html).not.toContain('A font is used');
      const lut = composer('Make it @luts/cinematic ', options);
      expect(lut).toContain('luts/cinematic<button');
      expect(lut).not.toContain('@luts/cinematic<button');
      expect(lut).toContain('aria-label="Remove luts/cinematic from the note"');
      expect(tagWith(lut, 'data-slot="library-chip"')).not.toContain('dir=');
      // A token after a hyphen is not LU8's: no chip.
      expect(composer('תשים ל-@luts/cinematic ', options)).not.toContain(
        'data-slot="library-uses"',
      );
    }
  });

  it('is LU8’s picker: LUTs and graphics only, the old placeholder, the old words', () => {
    const empty = composer('', { inEdits: true });
    expect(tagWith(empty, '<textarea')).toContain(
      'placeholder="Write a note… type @ to point at a LUT or a graphic"',
    );
    const at = composer('@he', { inEdits: true, fontList: true });
    expect(at).not.toContain('Fonts');
    expect(at).not.toContain('Heebo');
    expect(composer('@qqq', { inEdits: true, fontList: true })).toContain(
      'Nothing in LUTs or Graphics is called “qqq”.',
    );
    expect(composer('@qqq', { inEdits: true, fontList: true })).not.toContain('Open Fonts');
    expect(
      tagWith(composer('@qqq', { inEdits: true, fontList: true }), 'library-picker-none'),
    ).toContain('w-[300px]');
    // A name with a space is not a query to LU8: closed.
    expect(composer('Make it @Heebo Bold', { inEdits: true, fontList: true })).not.toContain(
      'data-slot="library-picker',
    );
    // The rows are LU8’s 30 px.
    expect(composer('@', { inEdits: true })).toContain('h-[30px]');
  });

  it('is the plain box when LUTs are off too: no wrapper, no picker, the old placeholder', () => {
    for (const draft of ['', '@he', 'Make it @Heebo Bold ']) {
      const html = composer(draft, { inEdits: false, fontsInNotes: false, fontList: true });
      expect(html, draft).toBe(
        composer(draft, { inEdits: false, fontsInNotes: false, fontList: false }),
      );
      const box = tagWith(html, '<textarea');
      expect(box).toContain('placeholder="Write a note… the video pauses while you type"');
      expect(box).not.toContain('data-picker');
      for (const attribute of [
        'aria-autocomplete',
        'aria-haspopup',
        'aria-controls',
        'aria-activedescendant',
      ]) {
        expect(box).not.toContain(attribute);
      }
      expect(html).not.toContain('role="status"');
    }
  });
});
