import { describe, expect, it, vi } from 'vitest';
import { fontPickerCatalog } from '@/features/library-picker/font-picker';
import { FONT_LIST, libraryClient } from '@/features/library-picker/test-helpers';
import { renderCell } from './test-helpers';

// A tooltip's content only exists while it is open, in a portal: neither exists on a server. Swap
// the tooltip pieces for plain elements that always show their content, with the props it was given.
vi.mock('@/components/ui/tooltip', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    TooltipProvider: ({ children }: Props) => h(Fragment, null, children),
    Tooltip: ({ children }: Props) => h(Fragment, null, children),
    TooltipTrigger: ({ children }: Props) => h(Fragment, null, children),
    TooltipContent: ({ children, className, dir, side, align, sideOffset }: Props) =>
      h(
        'div',
        {
          role: 'tooltip',
          class: className,
          dir,
          'data-side': side,
          'data-align': align,
          'data-offset': sideOffset,
        },
        children,
      ),
  };
});

const { NoteMarker } = await import('./NoteMarker');
const { JobNoteMarker } = await import('./JobNoteMarker');

const NOTE = 'לפתוח על הצוות, לא על המבנה.\nעד דקה.';

describe('<NoteMarker>', () => {
  it('is a muted 14 px message-with-text icon', () => {
    const markup = renderCell(<NoteMarker note={NOTE} />);
    expect(markup).toContain('lucide-message-square-text');
    expect(markup).toMatch(/<svg[^>]*width="14"[^>]*height="14"/);
    expect(markup).toContain('text-muted-foreground');
  });

  it('is named "Your note" and reachable with the keyboard, and the icon itself is decoration', () => {
    const markup = renderCell(<NoteMarker note={NOTE} />);
    expect(markup).toMatch(/<span[^>]*aria-label="Your note"/);
    expect(markup).toMatch(/<span[^>]*tabindex="0"/);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('never shrinks, so a long name gives way to it', () => {
    expect(renderCell(<NoteMarker note={NOTE} />)).toMatch(/<span[^>]*class="[^"]*\bshrink-0\b/);
  });

  it('shows no blue ring when focused: only the app’s quiet zinc one, for the keyboard', () => {
    const markup = renderCell(<NoteMarker note={NOTE} />);
    expect(markup).toContain('outline-none');
    expect(markup).toContain('focus-visible:ring-ring/35');
    expect(markup).not.toMatch(/blue|focus:ring/);
  });

  describe('its tooltip', () => {
    const tip = () =>
      renderCell(<NoteMarker note={NOTE} />).match(/<div role="tooltip"[^>]*>/)?.[0] ?? '';

    it('holds the note, word for word', () => {
      const markup = renderCell(<NoteMarker note={NOTE} />);
      expect(markup).toContain(`${NOTE}</div>`);
    });

    it('keeps the line breaks of the note and is at most 280 px wide', () => {
      expect(tip()).toContain('whitespace-pre-line');
      expect(tip()).toContain('max-w-[280px]');
    });

    it('reads the note in its own direction (Hebrew, Latin or mixed)', () => {
      expect(tip()).toContain('dir="auto"');
    });

    it('opens above the icon, centred, 6 px away, as on the Jobs board', () => {
      expect(tip()).toContain('data-side="top"');
      expect(tip()).toContain('data-align="center"');
      expect(tip()).toContain('data-offset="6"');
    });

    it('cuts a very long note off at half the screen instead of growing past it', () => {
      expect(tip()).toContain('max-h-[50vh]');
      expect(tip()).toContain('overflow-hidden');
    });
  });
});

// FN20 (CVP-353): with fonts in the notes (`fontsInNotes`) a font token in the note is a pill in
// the tooltip, as in Review; with the switch off the tooltip is the note's text, as it was.
describe('<NoteMarker> with fonts in the notes', () => {
  const FONT_NOTE = 'Make the captions @Heebo Bold, the titles @Rubik Black.\nUntil 0:30.';
  const FONTS = fontPickerCatalog(FONT_LIST);
  const pills = (markup: string) =>
    [...markup.matchAll(/data-slot="library-token"[^>]*>([^<]*)</g)].map((m) => m[1]);

  it('shows each font token as a pill, left to right, and keeps the words and the line break', () => {
    const markup = renderCell(<NoteMarker note={FONT_NOTE} fonts={FONTS} />);
    expect(pills(markup)).toEqual(['@Heebo Bold', '@Rubik Black']);
    expect(markup).toMatch(/data-slot="library-token"[^>]*dir="ltr"/);
    expect(markup).toContain('Make the captions');
    expect(markup).toContain('Until 0:30.');
    expect(markup).toContain('whitespace-pre-line');
    expect(markup).toContain('dir="auto"');
  });

  it('is the note’s text when no font library is given (the switch is off)', () => {
    const markup = renderCell(<NoteMarker note={FONT_NOTE} />);
    expect(markup).not.toContain('library-token');
    expect(markup).toContain(`${FONT_NOTE}</div>`);
  });

  it('leaves a note with no token as it was', () => {
    expect(renderCell(<NoteMarker note={NOTE} fonts={FONTS} />)).toContain(`${NOTE}</div>`);
  });

  describe('JobNoteMarker (the Jobs list)', () => {
    const ON = { inEdits: false, fontsInNotes: true } as const;

    it('shows the pills while notes can name a font', () => {
      const markup = renderCell(<JobNoteMarker note={FONT_NOTE} />, libraryClient(ON));
      expect(pills(markup)).toEqual(['@Heebo Bold', '@Rubik Black']);
    });

    it('shows a LUT token as a pill too when notes can name LUTs', () => {
      const markup = renderCell(
        <JobNoteMarker note="Look @luts/cinematic, captions @Heebo Bold" />,
        libraryClient({ inEdits: true, fontsInNotes: true }),
      );
      expect(pills(markup)).toEqual(['@luts/cinematic', '@Heebo Bold']);
    });

    it('is the plain marker while the switch is off, whether or not the font list is in the cache', () => {
      for (const inEdits of [true, false]) {
        for (const fontList of [true, false]) {
          const client = () => libraryClient({ inEdits, fontsInNotes: false, fontList });
          const markup = renderCell(<JobNoteMarker note={FONT_NOTE} />, client());
          expect(markup).toBe(renderCell(<NoteMarker note={FONT_NOTE} />, client()));
          expect(markup).not.toContain('library-token');
        }
      }
    });
  });
});
