import { describe, expect, it, vi } from 'vitest';
import { libraryClient } from '@/features/library-picker/test-helpers';
import { renderCell } from './test-helpers';

// FN20 (CVP-353): the "Note for the editor" dialog with fonts in the notes (`fontsInNotes`; the
// Brief's notes box). The box shares FN13's picker and FN14's chips with Review's, so this file is
// the dialog's own wiring: the placeholder, the 288 px position, the picker's attributes, the
// chips under the box, the phone's plain box, and the proof that with the switch off the dialog is
// what it was. Clicks, keys and Esc: e2e/fonts-notes-boxes.spec.ts.

// Radix renders a dialog in a portal, which does not exist on a server (as NoteDialog.test.tsx).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, showCloseButton, className }: Props) =>
      h(
        'div',
        { role: 'dialog', 'data-close-button': String(showCloseButton), class: className },
        children,
      ),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { NOTE_DIALOG_TEXT, NoteDialog, noteDialogPlaceholder } = await import('./NoteDialog');

const FONT_LINE =
  'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.';

type Options = Parameters<typeof libraryClient>[0];

function dialog(
  text: string,
  options: Options,
  props: Partial<React.ComponentProps<typeof NoteDialog>> = {},
): string {
  return renderCell(
    <NoteDialog
      open
      jobName="Class schedule"
      client="Arc Fitness"
      text={text}
      onTextChange={() => {}}
      held={false}
      saving={false}
      error={null}
      onSave={() => {}}
      onOpenChange={() => {}}
      {...props}
    />,
    libraryClient(options),
  );
}

/** The opening tag of the first element that has `marker` in it. */
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker}`);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('>', at) + 1);
}

const ON = { inEdits: true, fontsInNotes: true } as const;
const FONTS_ONLY = { inEdits: false, fontsInNotes: true } as const;

describe('<NoteDialog> with fonts in the notes (fontsInNotes)', () => {
  it('says "@" points at a font, a LUT or a graphic', () => {
    expect(tagWith(dialog('', ON), '<textarea')).toContain(
      'placeholder="e.g. Keep it under 30 seconds. Type @ to point at a font, a LUT or a graphic."',
    );
  });

  it('says a font alone when LUTs and graphics are off, and still has the picker', () => {
    const html = dialog('', FONTS_ONLY);
    const box = tagWith(html, '<textarea');
    expect(box).toContain(
      'placeholder="e.g. Keep it under 30 seconds. Type @ to point at a font."',
    );
    expect(box).toContain('aria-haspopup="listbox"');
    expect(box).toContain('aria-autocomplete="list"');
    expect(html).toMatch(/<div class="relative"><textarea[^>]*id="note-dialog-text"/);
    expect(html).toContain('role="status"');
  });

  it('keeps the LU12 words as they were for the LUT-only picker (the constant is the same sentence)', () => {
    expect(noteDialogPlaceholder('a LUT or a graphic')).toBe(
      NOTE_DIALOG_TEXT.placeholderWithPicker,
    );
    expect(tagWith(dialog('', { inEdits: true }), '<textarea')).toContain(
      `placeholder="${NOTE_DIALOG_TEXT.placeholderWithPicker}"`,
    );
  });

  it('sits 288 px from the top so the popover above the box clears the window, with fonts alone too', () => {
    for (const options of [ON, FONTS_ONLY]) {
      const html = dialog('', options);
      expect(html).toContain('sm:top-[288px]');
      expect(html).toContain('sm:translate-y-0');
    }
  });

  it('keeps the same box: auto direction, 168 px, the server’s length limit, the text as typed', () => {
    const html = dialog('Make the captions @Heebo Bold ', ON);
    const box = tagWith(html, '<textarea');
    expect(box).toContain('dir="auto"');
    expect(box).toContain('maxLength="4000"');
    expect(box).toContain('min-h-[168px]');
    expect(html).toMatch(/<textarea[^>]*>Make the captions @Heebo Bold <\/textarea>/);
  });

  it('shows no popover and no chips until the note asks for them', () => {
    const html = dialog('', ON);
    expect(html).not.toContain('data-slot="library-picker"');
    expect(html).not.toContain('data-slot="library-uses"');
    expect(tagWith(html, '<textarea')).not.toContain('data-picker');
  });

  it('"@" opens the picker above the box: the recent fonts, then 3 LUTs and 3 graphics', () => {
    const html = dialog('Warm and calm. @', ON);
    expect(html).toContain('data-slot="library-picker"');
    expect(html).toContain('absolute right-0 bottom-[calc(100%+6px)]');
    expect(html).toContain('>Fonts · recent<');
    expect(html.match(/role="option"/g)).toHaveLength(11);
    const box = tagWith(html, '<textarea');
    expect(box).toContain('data-picker="open"');
    expect(box).toMatch(/aria-activedescendant="[^"]+-opt-0"/);
    expect(html).toContain('11 results. Heebo Bold selected.');
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf('data-slot="library-picker"'));
  });

  it('"@he": three families, one row each', () => {
    const html = dialog('Make the captions @he', ON);
    expect(html).toContain('>Heebo</span>');
    expect(html).toContain('>Noto Sans Hebrew</span>');
    expect(html).toContain('>IBM Plex Sans Hebrew</span>');
    expect(html).toContain('3 results. Heebo selected.');
  });

  it('"@heebo": nine faces, Regular first, Bold second', () => {
    const html = dialog('@heebo', ON);
    expect(html.match(/role="option"/g)).toHaveLength(9);
    expect(html.indexOf('>Heebo</span>')).toBeLessThan(html.indexOf('>Heebo Bold</span>'));
  });

  it('opens in a Hebrew note after the hyphen: "ל-@he"', () => {
    const html = dialog('תשנה את הכתוביות ל-@he', ON);
    expect(html).toContain('3 results. Heebo selected.');
    expect(tagWith(html, '<textarea')).toContain('dir="auto"');
  });

  it('is closed once a face is complete: "Make it @Heebo Bold " and "@xyz abc"', () => {
    for (const text of ['Make it @Heebo Bold ', '@xyz abc']) {
      const html = dialog(text, ON);
      expect(html, text).not.toContain('data-slot="library-picker');
      expect(tagWith(html, '<textarea'), text).not.toContain('data-picker');
    }
  });

  it('opens the small panel for a name the library lacks, with the way to Fonts', () => {
    const html = dialog('Make the captions @Gotham', ON);
    expect(html).toContain('Nothing in Fonts, LUTs or Graphics is called “Gotham”.');
    expect(html).toContain('Open Fonts to import one');
    expect(html).not.toContain('role="listbox"');
    expect(tagWith(html, '<textarea')).toContain('data-picker="open"');
  });

  it('with fonts alone, “@xyz” says Nothing in Fonts', () => {
    const html = dialog('@qqq', FONTS_ONLY);
    expect(html).toContain('Nothing in Fonts is called “qqq”.');
    expect(html).not.toContain('LUTs');
  });

  it('shows one chip under the box for a note that names a font, above the buttons', () => {
    const html = dialog('Make the captions @Heebo Bold ', ON);
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    expect(html).toContain('@Heebo Bold<button');
    expect(html).toContain('aria-label="Remove @Heebo Bold from the note"');
    expect(html).toContain(FONT_LINE);
    expect(html).not.toContain('A LUT applies');
    expect(html.indexOf('</textarea>')).toBeLessThan(html.indexOf('data-slot="library-uses"'));
    expect(html.indexOf('data-slot="library-uses"')).toBeLessThan(html.indexOf('>Cancel<'));
  });

  it('shows two chips and one font line for two fonts, and a LUT beside a font', () => {
    const two = dialog('Titles in @Rubik Black and captions in @Heebo Medium ', ON);
    expect(two.match(/data-slot="library-chip"/g)).toHaveLength(2);
    expect(two.split(FONT_LINE)).toHaveLength(2);
    const mixed = dialog('Captions in @Heebo Bold, look @luts/cinematic ', ON);
    expect(mixed.match(/data-slot="library-chip"/g)).toHaveLength(2);
    expect(mixed).toContain('A LUT applies to the whole video.');
    expect(mixed).toContain(FONT_LINE);
  });

  it('shows the chip of a font in a Hebrew note, left to right, in a box that follows the text', () => {
    const html = dialog('תשנה את הכתוביות ל-@Heebo Bold ', ON);
    expect(tagWith(html, 'data-slot="library-chip"')).toContain('dir="ltr"');
    expect(tagWith(html, '<textarea')).toContain('dir="auto"');
  });

  it('shows no chip for a name the library does not have', () => {
    const html = dialog('Make the captions @Gotham Bold ', ON);
    expect(html).not.toContain('data-slot="library-chip"');
  });

  it('shows only the fonts’ chips with LUTs and graphics off', () => {
    const html = dialog('Captions @Heebo Bold and @luts/cinematic ', FONTS_ONLY);
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    expect(html).not.toContain('A LUT applies');
  });

  it('is the plain box on the phone (libraryPicker off) even with the switch on', () => {
    const html = dialog('Make it @Heebo Bold ', ON, { libraryPicker: false });
    expect(tagWith(html, '<textarea')).toContain(`placeholder="${NOTE_DIALOG_TEXT.placeholder}"`);
    expect(html).not.toContain('data-slot="library-uses"');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('sm:top-[288px]');
  });
});

describe('<NoteDialog> with the fonts switch off', () => {
  const TEXTS = [
    '',
    '@',
    'Make it @he',
    '@luts/ci',
    'Make it @Heebo Bold ',
    'Make it @Heebo Bold and @luts/cinematic ',
    '@qqq',
    'ל-@he',
  ];

  it('is the same dialog whether or not the font list is anywhere (it is never read)', () => {
    for (const inEdits of [true, false]) {
      for (const text of TEXTS) {
        expect(
          dialog(text, { inEdits, fontsInNotes: false, fontList: true }),
          `${inEdits} ${text}`,
        ).toBe(dialog(text, { inEdits, fontsInNotes: false, fontList: false }));
      }
    }
  });

  it('has LU12’s placeholder, position and chips, and no font word anywhere', () => {
    const html = dialog('Make it @Heebo Bold and @luts/cinematic ', { inEdits: true });
    expect(tagWith(html, '<textarea')).toContain(
      'placeholder="e.g. Keep it under 30 seconds. Type @ to point at a LUT or a graphic."',
    );
    // A font token is plain text; the LUT chip is written the old way, without the @.
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    expect(html).toContain('luts/cinematic<button');
    expect(html).not.toContain(FONT_LINE);
    expect(html).not.toContain('Remove @');
    const open = dialog('Make it @he', { inEdits: true });
    expect(open).toContain('Nothing in LUTs or Graphics is called “he”.');
    expect(open).not.toContain('Fonts');
  });

  it('is the plain box with no wrapper, no picker and no 288 px when LUTs are off too', () => {
    const html = dialog('Make it @Heebo Bold ', { inEdits: false, fontsInNotes: false });
    expect(tagWith(html, '<textarea')).toContain(`placeholder="${NOTE_DIALOG_TEXT.placeholder}"`);
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('data-slot="library-uses"');
    expect(html).not.toContain('sm:top-[288px]');
    expect(html).not.toContain('role="status"');
  });
});
