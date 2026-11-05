import { describe, expect, it } from 'vitest';
import { libraryClient } from '../library-picker/test-helpers';
import { ReviewComposer } from './ReviewComposer';
import { renderReview, tagWith } from './test-helpers';

function composer(props: Partial<React.ComponentProps<typeof ReviewComposer>> = {}): string {
  return renderReview(
    <ReviewComposer
      timeLabel="0:03"
      draft=""
      onDraftChange={() => {}}
      onAdd={() => {}}
      onFocus={() => {}}
      adding={false}
      error={null}
      composerRef={null}
      {...props}
    />,
  );
}

/** The opening tag of the button whose label is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`${label}</button>`);
  expect(at, label).toBeGreaterThan(-1);
  return html.slice(
    html.lastIndexOf('<button', at),
    html.indexOf('>', html.lastIndexOf('<button', at)) + 1,
  );
}

describe('<ReviewComposer>', () => {
  it('is a bordered block under the list, with the board’s padding and gap', () => {
    const tag = tagWith(composer(), 'data-slot="review-composer"');
    for (const className of ['border-t', 'p-3', 'gap-2', 'shrink-0']) {
      expect(tag).toContain(className);
    }
  });

  it('labels the box "New note at" the playhead’s time', () => {
    const html = composer({ timeLabel: '0:03' });
    expect(html).toMatch(
      /<label[^>]* for="[^"]+"[^>]*>New note at <span[^>]*>0:03<\/span><\/label>/,
    );
    const forId = /<label[^>]* for="([^"]+)"/.exec(html)?.[1];
    expect(tagWith(html, '<textarea')).toContain(`id="${forId}"`);
  });

  it('has a three-row textarea in its own direction, with the placeholder and the length limit', () => {
    const tag = tagWith(composer(), '<textarea');
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('rows="3"');
    expect(tag).toContain('maxLength="2000"');
    expect(tag).toContain('placeholder="Write a note… the video pauses while you type"');
    expect(tag).toContain('[unicode-bidi:plaintext]');
    expect(tag).toContain('resize-none');
  });

  it('shows the draft', () => {
    expect(composer({ draft: 'שלום' })).toMatch(/<textarea[^>]*>שלום<\/textarea>/);
  });

  it('lays out Record on the left and Comment on the right', () => {
    const html = composer();
    expect(html.indexOf('Record</button>')).toBeGreaterThan(-1);
    expect(html.indexOf('Record</button>')).toBeLessThan(html.indexOf('Comment</button>'));
    expect(html).toContain('lucide-mic');
    expect(html).toContain('lucide-message-square-plus');
  });

  it('gives Record and Comment the board’s 12 px sides and 8 px gap, not shadcn’s small 10 and 6', () => {
    const html = composer();
    for (const label of ['Record', 'Comment']) {
      const button = buttonLabelled(html, label);
      expect(button).toContain('data-size="sm"');
      expect(button).toContain('gap-2');
      expect(button).toContain('has-[&gt;svg]:px-3');
    }
  });

  it('keeps Record off until a recorder is given', () => {
    expect(buttonLabelled(composer(), 'Record')).toContain('disabled=""');
    expect(buttonLabelled(composer({ onRecord: () => {} }), 'Record')).not.toContain('disabled=""');
  });

  it('keeps Comment off for a blank or whitespace draft, and on for text', () => {
    expect(buttonLabelled(composer({ draft: '' }), 'Comment')).toContain('disabled=""');
    expect(buttonLabelled(composer({ draft: '  \n ' }), 'Comment')).toContain('disabled=""');
    expect(buttonLabelled(composer({ draft: 'x' }), 'Comment')).not.toContain('disabled=""');
  });

  it('shows a spinner and turns Comment off while the note is on its way', () => {
    const html = composer({ draft: 'x', adding: true });
    const button = buttonLabelled(html, 'Comment');
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-busy="true"');
    expect(html).toContain('lucide-loader-circle');
    expect(html).not.toContain('lucide-message-square-plus');
  });

  it('shows no error normally', () => {
    const html = composer();
    expect(html).not.toContain('role="alert"');
    expect(tagWith(html, '<textarea')).not.toContain('aria-describedby');
  });

  it('shows the server’s reason as an alert the textarea points to', () => {
    const html = composer({ draft: 'x', error: 'The note is empty.' });
    const alert = tagWith(html, 'role="alert"');
    expect(alert).toContain('text-destructive');
    expect(html).toContain('The note is empty.</p>');
    const id = /id="([^"]+)" role="alert"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(tagWith(html, '<textarea')).toContain(`aria-describedby="${id}"`);
  });
});

// --- @ in the box (LU8; board LUReview) -------------------------------------------------------

function withLibrary(
  props: Partial<React.ComponentProps<typeof ReviewComposer>> = {},
  inEdits = true,
): string {
  return renderReview(
    <ReviewComposer
      timeLabel="0:12"
      draft=""
      onDraftChange={() => {}}
      onAdd={() => {}}
      onFocus={() => {}}
      adding={false}
      error={null}
      composerRef={null}
      {...props}
    />,
    libraryClient({ inEdits }),
  );
}

describe('<ReviewComposer> with notes allowed to name LUTs (lutsInEdits)', () => {
  it('is the board’s empty state: the new placeholder, a relative wrapper, no popover, no Uses row', () => {
    const html = withLibrary();
    expect(tagWith(html, '<textarea')).toContain(
      'placeholder="Write a note… type @ to point at a LUT or a graphic"',
    );
    expect(html).toContain('<div class="relative"><textarea');
    expect(html).not.toContain('data-slot="library-picker');
    expect(html).not.toContain('data-slot="library-uses"');
    expect(html).toContain('role="status"');
  });

  it('opens the picker above the box for "@", with the textarea wired to the list', () => {
    const html = withLibrary({ draft: '@' });
    expect(html).toContain('data-slot="library-picker"');
    const box = tagWith(html, '<textarea');
    expect(box).toContain('aria-autocomplete="list"');
    expect(box).toContain('aria-haspopup="listbox"');
    expect(box).toContain('data-picker="open"');
    const list = /aria-controls="([^"]+)"/.exec(box)?.[1];
    expect(tagWith(html, 'role="listbox"')).toContain(`id="${list}"`);
    expect(box).toContain(`aria-activedescendant="${list}-opt-0"`);
    // The popover sits in the wrapper, after the box.
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf('data-slot="library-picker"'));
  });

  it('says what is highlighted to a screen reader', () => {
    expect(withLibrary({ draft: '@' })).toContain('8 results. Cinematic selected.');
  });

  it('narrows to the LUTs for "Make it @luts/ci"', () => {
    const html = withLibrary({ draft: 'Make it @luts/ci' });
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).not.toContain('>Graphics<');
  });

  it('shows the small panel for "Make it @luts/zzz", and no activedescendant', () => {
    const html = withLibrary({ draft: 'Make it @luts/zzz' });
    expect(html).toContain('No LUT called “zzz”.');
    expect(html).toContain('Open LUTs to import one');
    expect(html).not.toContain('role="listbox"');
    expect(tagWith(html, '<textarea')).not.toContain('aria-activedescendant');
    expect(tagWith(html, '<textarea')).toContain('data-picker="open"');
  });

  it('closes when the text no longer ends in a query', () => {
    const html = withLibrary({ draft: 'Make it @luts/cinematic ' });
    expect(html).not.toContain('data-slot="library-picker"');
    expect(tagWith(html, '<textarea')).not.toContain('data-picker');
  });

  it('shows a chip for a token in the text, under the box, with the line for a LUT', () => {
    const html = withLibrary({ draft: 'Make it @luts/cinematic ' });
    expect(html).toContain('data-slot="library-uses"');
    expect(html).toContain('aria-label="Remove luts/cinematic from the note"');
    expect(html).toContain('A LUT applies to the whole video.');
    // Under the box, above the buttons.
    expect(html.indexOf('</textarea>')).toBeLessThan(html.indexOf('data-slot="library-uses"'));
    expect(html.indexOf('data-slot="library-uses"')).toBeLessThan(html.indexOf('Record</button>'));
  });

  it('puts the time of the note in the graphic line', () => {
    const html = withLibrary({ draft: 'Add @graphics/follow-card ', timeLabel: '1:05' });
    expect(html).toContain('A graphic is placed at 1:05.');
  });

  it('shows no chip for a token that points at nothing', () => {
    const html = withLibrary({ draft: 'Make it @luts/zzz ' });
    expect(html).not.toContain('data-slot="library-uses"');
  });

  it('shows one chip for a token written twice', () => {
    const html = withLibrary({ draft: '@luts/cinematic and @luts/cinematic ' });
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
  });
});

describe('<ReviewComposer> with the switch off (the default)', () => {
  it('is exactly the box it was: the old placeholder, no wrapper, no popover, no picker attributes', () => {
    for (const draft of ['', '@', 'Make it @luts/cinematic ']) {
      const html = withLibrary({ draft }, false);
      const box = tagWith(html, '<textarea');
      expect(box).toContain('placeholder="Write a note… the video pauses while you type"');
      expect(box).not.toContain('aria-autocomplete');
      expect(box).not.toContain('aria-activedescendant');
      expect(box).not.toContain('data-picker');
      expect(html).not.toContain('<div class="relative">');
      expect(html).not.toContain('library-');
      expect(html).not.toContain('role="status"');
    }
  });

  it('renders the same for a client that has not heard from the server at all', () => {
    for (const draft of ['', '@', 'Make it @luts/cinematic ']) {
      expect(withLibrary({ draft }, false)).toBe(composer({ draft, timeLabel: '0:12' }));
    }
  });
});
