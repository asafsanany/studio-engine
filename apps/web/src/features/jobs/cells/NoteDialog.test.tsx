import { NOTE_MAX_LENGTH } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { libraryClient } from '@/features/library-picker/test-helpers';
import { renderCell } from './test-helpers';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces
// for plain elements that keep the props this test cares about (the close button, the width).
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

const { NOTE_DIALOG_TEXT, NoteDialog } = await import('./NoteDialog');

const dialog = (props: Partial<React.ComponentProps<typeof NoteDialog>> = {}) =>
  renderCell(
    <NoteDialog
      open
      jobName="Class schedule"
      client="Arc Fitness"
      text=""
      onTextChange={() => {}}
      held={false}
      saving={false}
      error={null}
      onSave={() => {}}
      onOpenChange={() => {}}
      {...props}
    />,
  );

describe('<NoteDialog>', () => {
  it('uses the words of the design canvas', () => {
    expect(NOTE_DIALOG_TEXT).toMatchObject({
      title: 'Note for the editor',
      description:
        'The brief comes from the files in the job folder. Add anything else the edit should follow: your note wins over everything the client sent.',
      placeholder: 'e.g. Keep it under 30 seconds. Use the second take of the intro.',
      held: 'This job waits while you write. Saving puts it back in line.',
      cancel: 'Cancel',
      save: 'Save',
    });
    const markup = dialog();
    expect(markup).toContain('<h2>Note for the editor</h2>');
    expect(markup).toContain(NOTE_DIALOG_TEXT.description);
    expect(markup).toContain(`placeholder="${NOTE_DIALOG_TEXT.placeholder}"`);
  });

  it('shows nothing while it is closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('has no close button (Cancel is the way out) and the board’s 520 px width', () => {
    const markup = dialog();
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('sm:max-w-[520px]');
  });

  it('puts the job name and the client under the title, each in its own direction', () => {
    const markup = dialog({ jobName: 'פרומו לסוף השבוע', client: 'מאפיית הצפון' });
    expect(markup).toMatch(
      /<span dir="auto" class="[^"]*\bbidi\b[^"]*font-medium[^"]*">פרומו לסוף השבוע<\/span>/,
    );
    expect(markup).toMatch(/<span dir="auto" class="[^"]*\bbidi\b[^"]*">מאפיית הצפון<\/span>/);
    expect(markup).toContain('aria-hidden="true">·</span>');
    expect(markup.indexOf('Note for the editor')).toBeLessThan(markup.indexOf('פרומו לסוף השבוע'));
    expect(markup.indexOf('מאפיית הצפון')).toBeLessThan(
      markup.indexOf(NOTE_DIALOG_TEXT.description),
    );
  });

  describe('the text box', () => {
    it('is a labelled, auto-direction textarea limited to the length the server stores', () => {
      const markup = dialog();
      expect(markup).toMatch(/<label for="note-dialog-text" class="sr-only">Note<\/label>/);
      expect(markup).toMatch(/<textarea[^>]*id="note-dialog-text"/);
      expect(markup).toMatch(/<textarea[^>]*dir="auto"/);
      expect(markup).toMatch(/<textarea[^>]*maxLength="4000"/);
      expect(NOTE_MAX_LENGTH).toBe(4000);
      expect(markup).toMatch(/<textarea[^>]*rows="7"/);
    });

    it('is the stock shadcn textarea, with a fixed 168 px box that scrolls rather than grows', () => {
      const markup = dialog();
      expect(markup).toContain('data-slot="textarea"');
      expect(markup).toContain('min-h-[168px]');
      expect(markup).toContain('resize-y');
      expect(markup).toContain('[unicode-bidi:plaintext]');
      expect(markup).not.toContain('field-sizing-content');
    });

    it('starts with the text it is given (the note the job already has)', () => {
      const markup = dialog({ text: 'הטייק השני של יוסי עדיף.' });
      expect(markup).toMatch(/<textarea[^>]*>הטייק השני של יוסי עדיף\.<\/textarea>/);
    });

    it('uses the app’s quiet zinc focus ring for the keyboard, never a blue one', () => {
      const markup = dialog();
      expect(markup).toContain('focus-visible:ring-ring/35');
      expect(markup).not.toMatch(/blue|focus:ring/);
    });
  });

  describe('the "waits while you write" line', () => {
    it('shows with a small pause icon while the dialog is holding the job', () => {
      const markup = dialog({ held: true });
      expect(markup).toContain(NOTE_DIALOG_TEXT.held);
      expect(markup).toContain('lucide-pause');
      expect(markup).toMatch(
        /<p class="[^"]*text-muted-foreground[^"]*"><svg[^>]*aria-hidden="true"/,
      );
    });

    it('is not there for a job the dialog did not hold', () => {
      const markup = dialog({ held: false });
      expect(markup).not.toContain('This job waits');
      expect(markup).not.toContain('lucide-pause');
    });
  });

  describe('the buttons', () => {
    it('has Cancel as the outline button, then Save as the primary one, in a footer', () => {
      const markup = dialog();
      const cancel = markup.indexOf('data-variant="outline"');
      const save = markup.indexOf('data-variant="default"');
      expect(cancel).toBeGreaterThan(-1);
      expect(save).toBeGreaterThan(cancel);
      expect(markup).toMatch(/<button[^>]*data-variant="outline"[^>]*>Cancel<\/button>/);
      expect(markup).toMatch(/<button[^>]*data-variant="default"[^>]*>Save<\/button>/);
      expect(markup.indexOf('<footer>')).toBeLessThan(cancel);
    });

    it('is enabled while the person writes', () => {
      expect(dialog()).not.toContain('disabled=""');
      expect(dialog()).not.toContain('aria-busy="true"');
    });

    it('turns Save into a spinner and disables both buttons while the note is on its way', () => {
      const markup = dialog({ saving: true });
      expect(markup.match(/disabled=""/g)).toHaveLength(2);
      expect(markup).toMatch(/<button[^>]*aria-busy="true"[^>]*><svg[^>]*lucide-loader-circle/);
      expect(markup).toContain('animate-spin');
      // The label does not change, so the button keeps its name.
      expect(markup).toMatch(/Save<\/button>/);
    });
  });

  describe('errors', () => {
    it('says the reason inline, as an alert, and ties it to the text box', () => {
      const message = 'Cannot edit the note of a job that is editing.';
      const markup = dialog({ error: message });
      expect(markup).toMatch(
        /<p id="note-dialog-error" role="alert" class="[^"]*text-destructive[^"]*">/,
      );
      expect(markup).toContain(message);
      expect(markup).toMatch(/<textarea[^>]*aria-describedby="note-dialog-error"/);
    });

    it('shows no alert when nothing went wrong', () => {
      const markup = dialog({ error: null });
      expect(markup).not.toContain('role="alert"');
      expect(markup).not.toContain('aria-describedby');
    });

    it('keeps the text next to the error', () => {
      const markup = dialog({ text: 'Keep it short.', error: 'The engine didn’t answer.' });
      expect(markup).toContain('Keep it short.</textarea>');
      expect(markup).toContain('The engine didn’t answer.');
    });
  });

  // CVP-313 (LU12): the @ picker in the box (`lutsInEdits`). Clicks and keys: e2e/note-picker.spec.ts.
  describe('with notes allowed to name a LUT or a graphic (lutsInEdits)', () => {
    const on = () => libraryClient({ inEdits: true });
    const off = () => libraryClient({ inEdits: false });

    it('is the box exactly as it was while the switch is off', () => {
      const plain = dialog({ text: 'Make it @luts/film-contrast' });
      const markup = renderCell(
        <NoteDialog
          open
          jobName="Class schedule"
          client="Arc Fitness"
          text="Make it @luts/film-contrast"
          onTextChange={() => {}}
          held={false}
          saving={false}
          error={null}
          onSave={() => {}}
          onOpenChange={() => {}}
        />,
        off(),
      );
      expect(markup).toBe(plain);
      expect(markup).toContain(`placeholder="${NOTE_DIALOG_TEXT.placeholder}"`);
      expect(markup).not.toContain('library-uses');
      expect(markup).not.toContain('aria-haspopup');
      expect(markup).not.toContain('sm:top-[288px]');
    });

    const withPicker = (
      props: Partial<React.ComponentProps<typeof NoteDialog>> = {},
      client = on(),
    ) =>
      renderCell(
        <NoteDialog
          open
          jobName="Class schedule"
          client="Arc Fitness"
          text=""
          onTextChange={() => {}}
          held={false}
          saving={false}
          error={null}
          onSave={() => {}}
          onOpenChange={() => {}}
          {...props}
        />,
        client,
      );

    it('wraps the box for the popover, says how to point at one, and has the picker’s attributes', () => {
      const markup = withPicker();
      expect(markup).toContain(
        'placeholder="e.g. Keep it under 30 seconds. Type @ to point at a LUT or a graphic."',
      );
      expect(markup).toMatch(/<div class="relative"><textarea[^>]*id="note-dialog-text"/);
      expect(markup).toMatch(/<textarea[^>]*aria-haspopup="listbox"/);
      expect(markup).toMatch(/<textarea[^>]*aria-autocomplete="list"/);
      // Still the same box: auto direction, 168 px, the server's length limit.
      expect(markup).toMatch(/<textarea[^>]*maxLength="4000"/);
      expect(markup).toContain('min-h-[168px]');
      expect(markup).toContain('role="status"');
      // No popover and no chips until the note asks for them.
      expect(markup).not.toContain('data-slot="library-picker"');
      expect(markup).not.toContain('data-slot="library-uses"');
    });

    it('sits 288 px from the top so the popover above the box clears the window', () => {
      expect(withPicker()).toContain('sm:top-[288px]');
      expect(withPicker()).toContain('sm:translate-y-0');
    });

    it('shows a chip for each LUT or graphic the note names, and says a graphic goes where it fits', () => {
      const markup = withPicker({
        text: 'Warm it up: @luts/film-contrast and @graphics/name-on-a-white-pill, not @luts/zzz',
      });
      expect(markup.match(/data-slot="library-chip"/g)).toHaveLength(2);
      expect(markup).toContain('data-token="luts/film-contrast"');
      expect(markup).toContain('data-token="graphics/name-on-a-white-pill"');
      expect(markup).toContain('Remove luts/film-contrast from the note');
      expect(markup).toContain('A LUT applies to the whole video.');
      expect(markup).toContain('A graphic is placed where it fits.');
      expect(markup).not.toMatch(/placed at/i);
      // The uses row is under the box and above the error and the buttons.
      expect(markup.indexOf('</textarea>')).toBeLessThan(
        markup.indexOf('data-slot="library-uses"'),
      );
      expect(markup.indexOf('data-slot="library-uses"')).toBeLessThan(markup.indexOf('>Cancel<'));
    });

    it('keeps the note as the text of the box (it is stored as typed)', () => {
      expect(withPicker({ text: 'Warm it @luts/film-contrast' })).toMatch(
        /<textarea[^>]*>Warm it @luts\/film-contrast<\/textarea>/,
      );
    });

    it('opens the popover above the box for a note that ends in @, and no graphic has a time in it', () => {
      const luts = withPicker({ text: 'Make it @' });
      expect(luts).toContain('data-slot="library-picker"');
      expect(luts).toContain('data-picker="open"');
      expect(luts).toContain('absolute right-0 bottom-[calc(100%+6px)]');
      // The LUT's picture is the test frame: there is no paused video here.
      expect(luts).toContain('Before and after: Cinematic on the test frame');
      const graphics = withPicker({ text: 'Make it @graphics/' });
      expect(graphics).toContain('Name on a white pill');
      expect(graphics).toContain('Placed where it fits.');
      expect(graphics).not.toContain('Placed at');
    });

    // CVP-346 (FN13): the picker has a fonts group behind `fontsInNotes`. Off, this dialog is what it was.
    it('is the same dialog whether or not the font list is in the cache while fontsInNotes is off', () => {
      for (const inEdits of [true, false]) {
        for (const text of ['', 'Make it @', 'Make it @he', 'Make it @Heebo Bold ']) {
          const dialogWith = (fontList: boolean) =>
            withPicker({ text }, libraryClient({ inEdits, fontsInNotes: false, fontList }));
          expect(dialogWith(true), `${inEdits} ${text}`).toBe(dialogWith(false));
        }
      }
      const markup = withPicker({ text: 'Make it @he' }, libraryClient({ fontList: true }));
      expect(markup).not.toContain('Fonts');
      expect(markup).toContain(
        'placeholder="e.g. Keep it under 30 seconds. Type @ to point at a LUT or a graphic."',
      );
    });

    it('is the plain box on the phone (libraryPicker off) even with the switch on', () => {
      const markup = withPicker({ text: 'Make it @luts/film-contrast', libraryPicker: false });
      expect(markup).toContain(`placeholder="${NOTE_DIALOG_TEXT.placeholder}"`);
      expect(markup).not.toContain('data-slot="library-uses"');
      expect(markup).not.toContain('aria-haspopup');
      expect(markup).not.toContain('sm:top-[288px]');
    });
  });
});
