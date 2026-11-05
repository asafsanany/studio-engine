import type { Job, ReviewNote } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { sentNotesKey } from '@/data';
import { fontPickerCatalog } from '@/features/library-picker/font-picker';
import { FONT_LIST, libraryClient, libraryItems } from '@/features/library-picker/test-helpers';
import { RowActionsContext } from '../jobs/cells/use-row-actions';
import { jobSheetJobs, jobSheetNotes, jobSheetNow } from './test-fixtures';

// FN20 (CVP-353): the job sheet's Notes part with fonts in the notes (`fontsInNotes`): the note for
// the editor and the notes they sent show a font token as a pill, as Review's posted notes do. With
// the switch off the part is what it was (a font token is plain text).

// A menu's list only exists while it is open, in a portal (as JobSheetNotes.test.tsx).
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    DropdownMenu: ({ children }: Props) => h(Fragment, null, children),
    DropdownMenuTrigger: ({ children }: Props) => h(Fragment, null, children),
    DropdownMenuContent: ({ children }: Props) => h('div', { role: 'menu' }, children),
    DropdownMenuRadioGroup: ({ children }: Props) => h('div', { role: 'group' }, children),
    DropdownMenuRadioItem: ({ children }: Props) => h('div', { role: 'menuitemradio' }, children),
    DropdownMenuSeparator: () => h('hr'),
  };
});

const { JobSheetNotes, NotesView } = await import('./JobSheetNotes');

const FONTS = fontPickerCatalog(FONT_LIST);
type View = Parameters<typeof NotesView>[0];

const view = (job: Job, overrides: Partial<View> = {}): View => ({
  job,
  rounds: [],
  loading: false,
  onAskNote: () => {},
  onSetEffort: () => {},
  ...overrides,
});

const markupOf = (job: Job, overrides: Partial<View> = {}) =>
  renderToStaticMarkup(<NotesView {...view(job, overrides)} />);

const NOTE = 'Make the captions @Heebo Bold and the titles in @Rubik Black.';
const noted = { ...jobSheetJobs.queued, note: NOTE } satisfies Job;

/** The text of each pill, in order. */
function pillsOf(markup: string): string[] {
  return [...markup.matchAll(/data-slot="library-token"[^>]*>([^<]*)</g)].map((m) => m[1] ?? '');
}

describe('<NotesView>: a font in the note for the editor', () => {
  it('draws each font token as a pill, written with its @, and keeps the rest as text', () => {
    const markup = markupOf(noted, { fonts: FONTS });
    expect(pillsOf(markup)).toEqual(['@Heebo Bold', '@Rubik Black']);
    expect(markup).toContain('data-token="@Heebo Bold"');
    // The pills sit in the note row, left to right, inside the note's own direction.
    expect(markup).toMatch(/data-slot="library-token"[^>]*dir="ltr"/);
    const row = markup.slice(
      markup.indexOf('data-slot="note-row"'),
      markup.indexOf('data-slot="effort-row"'),
    );
    expect(row).toContain('Make the captions');
    expect(row).toContain('and the titles in');
    expect(row).not.toContain('@Heebo Bold and');
  });

  it('is a font in a Hebrew note, after the hyphen', () => {
    const hebrew = { ...noted, note: 'תשנה את הכתוביות ל-@Secular One' };
    expect(pillsOf(markupOf(hebrew, { fonts: FONTS }))).toEqual(['@Secular One']);
  });

  it('leaves a name the library does not have as text', () => {
    const unknown = { ...noted, note: 'Use @Gotham Bold for the captions' };
    const markup = markupOf(unknown, { fonts: FONTS });
    expect(pillsOf(markup)).toEqual([]);
    expect(markup).toContain('Use @Gotham Bold for the captions');
  });

  it('draws a font beside a LUT, both written with the @, when notes can name LUTs too', () => {
    const both = { ...noted, note: 'Captions in @Heebo Bold, look @luts/cinematic' };
    expect(pillsOf(markupOf(both, { fonts: FONTS, libraryItems: libraryItems() }))).toEqual([
      '@Heebo Bold',
      '@luts/cinematic',
    ]);
    // Without the LUT library the LUT token stays text.
    expect(pillsOf(markupOf(both, { fonts: FONTS }))).toEqual(['@Heebo Bold']);
  });

  it('leaves a note with no token, and "No note", exactly as they were', () => {
    const plain = { ...jobSheetJobs.queued, note: 'Use the new logo' };
    expect(markupOf(plain, { fonts: FONTS })).toBe(markupOf(plain));
    const none = { ...jobSheetJobs.queued, note: null };
    expect(markupOf(none, { fonts: FONTS })).toBe(markupOf(none));
  });

  it('is the note’s text, as it always was, without the font library', () => {
    const plain = markupOf(noted);
    expect(plain).not.toContain('library-token');
    expect(plain).toContain(NOTE);
    // With the LUT library alone (LU12) a font token is still text.
    const lutsOnly = markupOf(noted, { libraryItems: libraryItems() });
    expect(lutsOnly).not.toContain('library-token');
    expect(lutsOnly).toContain(NOTE);
  });
});

describe('<NotesView>: a font in the notes they sent', () => {
  const round2 = jobSheetJobs.reviewRound2;
  const sent: ReviewNote[] = [
    {
      ...(jobSheetNotes.reviewRound2[0] as ReviewNote),
      text: 'Captions in @Heebo Bold please',
    },
    ...jobSheetNotes.reviewRound2.slice(1),
  ];

  function live(client = libraryClient({ inEdits: true, fontsInNotes: true }), job = round2) {
    client.setQueryData(sentNotesKey(job.id), { jobId: job.id, notes: sent });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RowActionsContext.Provider value={null}>
          <JobSheetNotes job={job} timeZone="UTC" now={jobSheetNow.reviewRound2} />
        </RowActionsContext.Provider>
      </QueryClientProvider>,
    );
  }

  it('shows the font as a pill in the sent note, in its own direction', () => {
    const markup = live();
    expect(pillsOf(markup)).toEqual(['@Heebo Bold']);
    expect(markup).toContain('Captions in');
    expect(markup).toContain('please');
  });

  it('shows the note’s text, as it was, while the switch is off', () => {
    const markup = live(libraryClient({ inEdits: true, fontsInNotes: false, fontList: true }));
    expect(markup).not.toContain('library-token');
    expect(markup).toContain('Captions in @Heebo Bold please');
  });

  it('is the same part whether or not the font list is anywhere while the switch is off', () => {
    for (const inEdits of [true, false]) {
      expect(live(libraryClient({ inEdits, fontsInNotes: false, fontList: true }))).toBe(
        live(libraryClient({ inEdits, fontsInNotes: false, fontList: false })),
      );
    }
  });
});

describe('JobSheetNotes with the live font library', () => {
  const live = (
    variant: 'mac' | 'phone',
    client = libraryClient({ inEdits: true, fontsInNotes: true }),
  ) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RowActionsContext.Provider value={null}>
          <JobSheetNotes job={noted} variant={variant} />
        </RowActionsContext.Provider>
      </QueryClientProvider>,
    );

  it('shows the pills while notes can name a font (fontsInNotes on)', () => {
    expect(pillsOf(live('mac'))).toEqual(['@Heebo Bold', '@Rubik Black']);
  });

  it('shows the pills with LUTs and graphics off too', () => {
    expect(pillsOf(live('mac', libraryClient({ inEdits: false, fontsInNotes: true })))).toEqual([
      '@Heebo Bold',
      '@Rubik Black',
    ]);
  });

  it('shows none while the switch is off, whether or not the font list is in the cache', () => {
    for (const fontList of [true, false]) {
      const markup = live('mac', libraryClient({ inEdits: false, fontsInNotes: false, fontList }));
      expect(markup).not.toContain('library-token');
      expect(markup).toContain(NOTE);
    }
  });

  it('shows none on the phone, which has no pills (Fonts is desktop first)', () => {
    const markup = live('phone');
    expect(markup).not.toContain('library-token');
    expect(markup).toContain(NOTE);
  });
});
