import type { Job, ReviewNote } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { ApiError, api, sentNotesKey, sentNotesQueryOptions } from '@/data';
import { notesKey } from '@/data/notes-cache';
import { createTestQueryClient } from '@/data/test-utils';
import { libraryClient, libraryItems } from '@/features/library-picker/test-helpers';
import { type RowActions, RowActionsContext } from '../jobs/cells/use-row-actions';
import { noteDialogStore } from '../jobs/note-dialog';
import { realJob, realNotes, realNow } from './real-job-fixture';
import { jobSheetJobs, jobSheetNotes, jobSheetNow } from './test-fixtures';

// The part reads the notes they sent through `useSentNotes`; a call-through spy shows what it asked.
const sentNotesHook = vi.hoisted(() => ({ useSentNotes: vi.fn() }));
vi.mock('@/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data')>();
  sentNotesHook.useSentNotes.mockImplementation(actual.useSentNotes);
  return { ...actual, useSentNotes: sentNotesHook.useSentNotes };
});

// A menu's list only exists while it is open, in a portal: neither exists on a server. Swap the
// pieces for plain elements that always show their content, with the props the list gave them.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    DropdownMenu: ({ children }: Props) => h(Fragment, null, children),
    DropdownMenuTrigger: ({ children }: Props) => h(Fragment, null, children),
    DropdownMenuContent: ({ children }: Props) => h('div', { role: 'menu' }, children),
    DropdownMenuRadioGroup: ({ children, value }: Props) =>
      h('div', { role: 'group', 'data-value': value }, children),
    DropdownMenuRadioItem: ({ children, value }: Props) =>
      h('div', { role: 'menuitemradio', 'data-value': value }, children),
    DropdownMenuSeparator: () => h('hr'),
  };
});

const { JobSheetNotes, NotesView, useJobSheetNotes } = await import('./JobSheetNotes');

afterEach(() => noteDialogStore.getState().reset());

// --- helpers ------------------------------------------------------------------------------------

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

/** The visible text of some markup, tags removed. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first element in a (not yet rendered) React tree for which `match` is true. */
function find(
  node: ReactNode,
  match: (props: Record<string, unknown>) => boolean,
): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (match(node.props)) return node;
  return find(node.props.children as ReactNode, match);
}

/** A note of the "Ready to review · round 2" board's round 1. */
function round2Note(index: number): ReviewNote {
  const note = jobSheetNotes.reviewRound2[index];
  if (note === undefined) throw new Error(`no note ${index}`);
  return note;
}

/** `GET /api/jobs/:id/sent-notes` for a job, as it sits in the cache. */
const sentResponse = (subject: Job, notes: ReviewNote[]) => ({ jobId: subject.id, notes });

const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => void)(...args);

function rowActions(overrides: Partial<RowActions> = {}): RowActions {
  return {
    run: () => {},
    setEffort: () => {},
    setReviewEffort: () => {},
    archive: () => {},
    unarchive: () => {},
    archiveAllPaid: () => {},
    busy: false,
    refusal: null,
    dismissRefusal: () => {},
    ...overrides,
  };
}

/** A job whose note and effort are set to what a test is about. */
const job = (base: Job, overrides: Partial<Job> = {}): Job => ({ ...base, ...overrides });

// --- the note for the editor --------------------------------------------------------------------

describe('<NotesView>: the note for the editor', () => {
  const noNote = job(jobSheetJobs.queued, { note: null });
  const withNote = job(jobSheetJobs.queued, {
    note: 'Use the new logo, not the one from last year',
  });

  it('is a "Notes" part with the label "For the editor"', () => {
    const markup = markupOf(noNote);
    expect(markup).toMatch(/<section[^>]*aria-label="Notes"/);
    expect(markup).toMatch(/<h3[^>]*>Notes<\/h3>/);
    expect(markup).toContain('For the editor');
  });

  it('says "No note", muted, with an Add button, when there is none', () => {
    const markup = markupOf(noNote);
    expect(textOf(markup)).toContain('For the editor No note Add');
    expect(markup).toMatch(/<span[^>]*text-zinc-500[^>]*>No note<\/span>/);
    expect(markup).not.toContain('>Edit<');
  });

  it('shows the note, with an Edit button, once there is one', () => {
    const markup = markupOf(withNote);
    expect(textOf(markup)).toContain(
      'For the editor Use the new logo, not the one from last year Edit',
    );
    expect(markup).not.toContain('No note');
    expect(markup).not.toContain('>Add<');
  });

  it('draws the note in its own direction, wrapped, with its line breaks', () => {
    const hebrew = job(jobSheetJobs.queued, { note: 'לפתוח על הצוות, לא על המבנה.\nעד דקה.' });
    const markup = markupOf(hebrew);
    const tag = markup.match(/<span dir="auto"[^>]*>לפתוח/)?.[0] ?? '';
    expect(tag).toContain('bidi');
    for (const className of ['whitespace-pre-wrap', 'break-words', 'overflow-visible']) {
      expect(tag).toContain(className);
    }
    expect(markup).toContain('לפתוח על הצוות, לא על המבנה.\nעד דקה.');
  });

  it('draws the button as a small ghost text button', () => {
    const markup = markupOf(noNote);
    const button = markup.match(/<button[^>]*>Add<\/button>/)?.[0] ?? '';
    expect(button).toContain('data-variant="ghost"');
    expect(button).toContain('data-size="xs"');
    expect(button).toContain('type="button"');
  });

  it('asks for the note dialog when Add or Edit is pressed', () => {
    for (const subject of [noNote, withNote]) {
      const onAskNote = vi.fn();
      const tree = NotesView(view(subject, { onAskNote }));
      const button = find(tree, (props) => 'onClick' in props);
      call(button?.props.onClick);
      expect(onAskNote).toHaveBeenCalledTimes(1);
    }
  });

  it.each([['arriving'], ['queued'], ['held'], ['failed'], ['cancelled']] as const)(
    'works on a %s job',
    (state) => {
      const markup = markupOf(job(jobSheetJobs[state], { note: null }));
      expect(markup.match(/<button[^>]*>Add<\/button>/)?.[0]).not.toContain('disabled=""');
    },
  );

  it.each([['editing'], ['review'], ['rendering'], ['approved'], ['paid']] as const)(
    'is off on a %s job, like the row’s Add note…',
    (state) => {
      const markup = markupOf(job(jobSheetJobs[state], { note: null }));
      expect(markup.match(/<button[^>]*>Add<\/button>/)?.[0]).toContain('disabled=""');
    },
  );
});

// CVP-313 (LU12): a note for the editor that names a LUT or a graphic shows it as a chip.
describe('<NotesView>: library tokens in the note for the editor', () => {
  const NOTE = 'Warm it up: @luts/film-contrast, then @graphics/name-on-a-white-pill and @luts/zzz';
  const named = job(jobSheetJobs.queued, { note: NOTE });

  it('draws each token that points at an item as a pill, and keeps the rest as text', () => {
    const markup = markupOf(named, { libraryItems: libraryItems() });
    expect(markup.match(/data-slot="library-token"/g)).toHaveLength(2);
    expect(markup).toContain('data-token="luts/film-contrast"');
    expect(markup).toContain('data-token="graphics/name-on-a-white-pill"');
    // A token that points at nothing stays text, so the whole note still reads as typed.
    expect(textOf(markup)).toContain(
      'For the editor Warm it up: luts/film-contrast , then graphics/name-on-a-white-pill and @luts/zzz Edit',
    );
  });

  it('is the note’s text, as it always was, without the library', () => {
    const plain = markupOf(named);
    expect(plain).not.toContain('library-token');
    expect(plain).toContain(NOTE);
  });

  it('leaves a note with no token alone even with the library', () => {
    const noTokens = job(jobSheetJobs.queued, { note: 'Use the new logo' });
    expect(markupOf(noTokens, { libraryItems: libraryItems() })).toBe(markupOf(noTokens));
  });

  it('says "No note" the same way with the library', () => {
    const none = job(jobSheetJobs.queued, { note: null });
    expect(markupOf(none, { libraryItems: libraryItems() })).toBe(markupOf(none));
  });

  describe('JobSheetNotes with the live library', () => {
    const live = (variant: 'mac' | 'phone', client = libraryClient({ inEdits: true })) =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RowActionsContext.Provider value={null}>
            <JobSheetNotes job={named} variant={variant} />
          </RowActionsContext.Provider>
        </QueryClientProvider>,
      );

    it('shows the chips while notes can name things (lutsInEdits on)', () => {
      expect(live('mac').match(/data-slot="library-token"/g)).toHaveLength(2);
    });

    it('shows none while the switch is off', () => {
      const markup = live('mac', libraryClient({ inEdits: false }));
      expect(markup).not.toContain('library-token');
      expect(markup).toContain(NOTE);
    });

    it('shows none on the phone, which has no chips', () => {
      const markup = live('phone');
      expect(markup).not.toContain('library-token');
      expect(markup).toContain(NOTE);
    });
  });
});

// --- effort -------------------------------------------------------------------------------------

describe('<NotesView>: effort', () => {
  const queued = (effort: Job['effort']) => job(jobSheetJobs.queued, { effort });

  it('names the level, and for Default the level it runs at', () => {
    expect(textOf(markupOf(queued('high')))).toContain('Effort High Change');
    expect(textOf(markupOf(queued('medium')))).toContain('Effort Medium Change');
    expect(textOf(markupOf(queued('xhigh')))).toContain('Effort Extra high Change');
    expect(textOf(markupOf(queued(null)))).toContain('Effort Extra high Change');
  });

  it('has a Change button that opens the row’s Effort list: the same choices, with their hints', () => {
    const markup = markupOf(queued('high'));
    expect(markup).toMatch(/<button[^>]*data-variant="ghost"[^>]*>Change<\/button>/);
    const items = [
      ...markup.matchAll(/<div role="menuitemradio" data-value="([^"]+)">(.*?)<\/div>/g),
    ].map((match) => [match[1], textOf(match[2] ?? '')]);
    expect(items).toEqual([
      ['default', 'Default Extra high'],
      ['medium', 'Medium quickest'],
      ['high', 'High slower'],
      ['xhigh', 'Extra high slowest'],
    ]);
    // A line under Default, like the row’s list.
    expect(markup).toMatch(/data-value="default">.*?<\/div><hr\/>/);
  });

  it('checks the choice in use: a level, or Default', () => {
    expect(markupOf(queued('high'))).toContain('role="group" data-value="high"');
    expect(markupOf(queued('xhigh'))).toContain('role="group" data-value="xhigh"');
    expect(markupOf(queued(null))).toContain('role="group" data-value="default"');
  });

  it('saves the level that was chosen, Default as none', () => {
    const onSetEffort = vi.fn();
    const tree = NotesView(view(queued('high'), { onSetEffort }));
    const list = find(tree, (props) => 'onValueChange' in props);
    call(list?.props.onValueChange, 'medium');
    call(list?.props.onValueChange, 'xhigh');
    call(list?.props.onValueChange, 'default');
    expect(onSetEffort.mock.calls).toEqual([['medium'], ['xhigh'], [null]]);
  });

  it.each([
    ['editing'],
    ['rendering'],
    ['approved'],
    ['delivered'],
    ['paid'],
    ['archived'],
  ] as const)('is locked on a %s job: "used for this run" instead of Change', (state) => {
    const markup = markupOf(jobSheetJobs[state]);
    expect(textOf(markup)).toContain('used for this run');
    expect(markup).not.toContain('Change');
    expect(markup).not.toContain('role="menu"');
  });

  it.each([
    ['arriving'],
    ['queued'],
    ['held'],
    ['review'],
    ['reviewRound2'],
    ['failed'],
    ['cancelled'],
  ] as const)('can be changed on a %s job, like the row’s Effort ▸', (state) => {
    const markup = markupOf(jobSheetJobs[state]);
    expect(markup).toContain('>Change</button>');
    expect(markup).not.toContain('used for this run');
  });

  it('shows the level but no Change where the sheet has no way to save it', () => {
    const markup = markupOf(queued('high'), { onSetEffort: null });
    expect(textOf(markup)).toContain('Effort High');
    expect(markup).not.toContain('Change');
    expect(markup).not.toContain('used for this run');
  });
});

// --- effort in Review with Quick fixes on ---------------------------------------------------------

describe('<NotesView>: effort of a job in Review, Quick fixes on', () => {
  const inReview = (reviewEffort: Job['reviewEffort'], effort: Job['effort'] = 'high') =>
    job(jobSheetJobs.review, { effort, reviewEffort });
  const on = (subject: Job, overrides: Partial<View> = {}) =>
    markupOf(subject, { quickFixes: true, onSetReviewEffort: () => {}, ...overrides });

  it('says Auto, with sparkles, for a job on Auto, not the first edit’s level', () => {
    const markup = on(inReview(null, 'medium'));
    expect(textOf(markup)).toContain('Effort Auto Change');
    expect(markup).toMatch(/data-slot="review-effort"[^>]*>\s*<svg[^>]*lucide-sparkles/);
  });

  it('says the level of the review rounds for a level, without sparkles', () => {
    for (const [reviewEffort, words] of [
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ] as const) {
      const markup = on(inReview(reviewEffort, 'medium' === reviewEffort ? 'xhigh' : 'medium'));
      expect(textOf(markup)).toContain(`Effort ${words} Change`);
      expect(markup).not.toContain('lucide-sparkles');
    }
  });

  it('lists Auto, a line and the three levels behind Change, with the one in use checked', () => {
    const markup = on(inReview('high'));
    const items = [
      ...markup.matchAll(/<div role="menuitemradio" data-value="([^"]+)">(.*?)<\/div>/g),
    ].map((match) => [match[1], textOf(match[2] ?? '')]);
    expect(items).toEqual([
      ['auto', 'Auto Default'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ]);
    expect(markup).toMatch(/data-value="auto">.*?<\/div><hr\/>/);
    expect(markup).toContain('role="group" data-value="high"');
    expect(on(inReview(null))).toContain('role="group" data-value="auto"');
  });

  it('saves the review effort that was chosen, Auto as none, and never the first edit’s', () => {
    const onSetEffort = vi.fn();
    const onSetReviewEffort = vi.fn();
    const tree = NotesView(
      view(inReview('high'), { quickFixes: true, onSetEffort, onSetReviewEffort }),
    );
    const list = find(tree, (props) => 'onValueChange' in props);
    call(list?.props.onValueChange, 'medium');
    call(list?.props.onValueChange, 'auto');
    expect(onSetReviewEffort.mock.calls).toEqual([['medium'], [null]]);
    expect(onSetEffort).not.toHaveBeenCalled();
  });

  it('shows the level but no Change where the sheet has no way to save it', () => {
    const markup = on(inReview('high'), { onSetReviewEffort: null });
    expect(textOf(markup)).toContain('Effort High');
    expect(markup).not.toContain('Change');
    expect(markup).not.toContain('used for this run');
  });

  it('is not locked: a job in Review can always change it', () => {
    expect(on(inReview(null))).not.toContain('used for this run');
  });

  it('leaves every other state as it was: the edit’s effort', () => {
    const queued = job(jobSheetJobs.queued, { effort: 'high', reviewEffort: null });
    expect(textOf(on(queued))).toContain('Effort High Change');
    expect(on(queued)).not.toContain('lucide-sparkles');
    expect(on(queued)).toContain('role="group" data-value="high"');
    const editing = job(jobSheetJobs.editing, { effort: 'high', reviewEffort: null });
    expect(textOf(on(editing))).toContain('Effort High');
    expect(textOf(on(editing))).toContain('used for this run');
    expect(textOf(on(jobSheetJobs.approved))).toContain('used for this run');
  });

  it('is today’s row with the switch off, even for a job that carries a review effort', () => {
    const subject = inReview('xhigh', 'medium');
    const markup = markupOf(subject);
    expect(textOf(markup)).toContain('Effort Medium Change');
    expect(markup).not.toContain('lucide-sparkles');
    expect(markup).toContain('role="group" data-value="medium"');
  });
});

describe('useJobSheetNotes: effort', () => {
  it('saves the review effort through the sheet’s row actions', () => {
    const setReviewEffort = vi.fn();
    let captured: View | undefined;
    function Capture() {
      captured = useJobSheetNotes(jobSheetJobs.review);
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <RowActionsContext.Provider value={rowActions({ setReviewEffort })}>
          <Capture />
        </RowActionsContext.Provider>
      </QueryClientProvider>,
    );
    captured?.onSetReviewEffort?.('high');
    captured?.onSetReviewEffort?.(null);
    expect(setReviewEffort.mock.calls).toEqual([['high'], [null]]);
    // The switch is read from /api/health, which has not answered: off, as before.
    expect(captured?.quickFixes).toBe(false);
  });
});

// --- the notes they sent --------------------------------------------------------------------------

describe('<NotesView>: the review notes they sent', () => {
  const round2 = jobSheetJobs.reviewRound2;
  const sentMarkup = (notes: ReviewNote[]) => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(sentNotesKey(round2.id), sentResponse(round2, notes));
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={round2} timeZone="UTC" now={jobSheetNow.reviewRound2} />
      </QueryClientProvider>,
    );
  };

  it('has no rounds, and no thin line, when nothing was sent', () => {
    const markup = markupOf(jobSheetJobs.queued);
    expect(markup).not.toContain('data-slot="sent-round"');
    expect(markup).not.toContain('Your notes in round');
    expect(markup).not.toContain('border-t');
  });

  it('shows round 1 on the "Ready to review · round 2" board: a thin line, when it was sent, the notes', () => {
    const markup = sentMarkup(jobSheetNotes.reviewRound2);
    expect(markup).toContain('data-slot="sent-round"');
    expect(markup).toMatch(/<div data-slot="sent-round" class="[^"]*\bborder-t\b/);
    expect(textOf(markup)).toContain('Your notes in round 1 · sent 12:10');
    const times = [...markup.matchAll(/data-slot="sent-note-time"[^>]*>([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(times).toEqual(['0:04', '0:19', '0:33']);
  });

  it('draws each time as a small light-blue chip with tabular digits', () => {
    const chip = sentMarkup(jobSheetNotes.reviewRound2).match(
      /<span data-slot="sent-note-time"[^>]*>/,
    )?.[0];
    for (const className of ['text-blue-300', 'tabular-nums', 'h-5', 'rounded-[5px]']) {
      expect(chip).toContain(className);
    }
  });

  it('shows the words of a typed note in their own direction', () => {
    const markup = sentMarkup(jobSheetNotes.reviewRound2);
    expect(markup).toMatch(
      /<span dir="auto"[^>]*>Make the WhatsApp question card come in faster<\/span>/,
    );
    expect(markup).toMatch(/<span dir="auto"[^>]*>Cut the second “אממ”<\/span>/);
  });

  it('shows a voice note with its mic, its length and its transcript', () => {
    const markup = sentMarkup(jobSheetNotes.reviewRound2);
    expect(markup).toContain('lucide-mic');
    expect(markup).toMatch(/<svg[^>]*lucide-mic[^>]*aria-hidden="true"/);
    expect(textOf(markup)).toContain(
      'Voice note · 0:07 תוריד פה את המוזיקה, היא חזקה מדי על הדיבור',
    );
    expect(markup.match(/lucide-mic/g)).toHaveLength(1);
  });

  it('tags a note Style, Series, or neither, as small outline tags', () => {
    const markup = sentMarkup(jobSheetNotes.reviewRound2);
    const tags = [
      ...markup.matchAll(/<span data-slot="badge" data-variant="outline"[^>]*>(\w+)</g),
    ];
    expect(tags.map((match) => match[1])).toEqual(['Series', 'Style']);
    expect(markup.match(/data-slot="badge"/g)).toHaveLength(2);
  });

  it('says "Transcribing…" while a transcript is on its way and "No transcript" when there is none', () => {
    const voice = (id: string, overrides: Partial<ReviewNote>): ReviewNote => ({
      ...round2Note(1),
      id,
      ...overrides,
    });
    const markup = sentMarkup([
      voice('a', { atSec: 1, transcriptStatus: 'pending', text: null }),
      voice('b', { atSec: 2, transcriptStatus: 'failed', text: null }),
    ]);
    const text = textOf(markup);
    expect(text).toContain('Voice note · 0:07 Transcribing…');
    expect(text).toContain('Voice note · 0:07 No transcript');
    expect(text).not.toContain('תוריד פה');
  });

  it('keeps every round on a job that had several, oldest first', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider
        client={(() => {
          const queryClient = createTestQueryClient();
          queryClient.setQueryData(
            sentNotesKey(jobSheetJobs.archived.id),
            sentResponse(jobSheetJobs.archived, [...jobSheetNotes.archived].reverse()),
          );
          return queryClient;
        })()}
      >
        <JobSheetNotes job={jobSheetJobs.archived} timeZone="UTC" now={jobSheetNow.archived} />
      </QueryClientProvider>,
    );
    const titles = [...markup.matchAll(/Your notes in round (\d) · sent (\d+ \w+)/g)].map(
      (match) => `${match[1]} ${match[2]}`,
    );
    // Both rounds went on earlier days, so they say the day.
    expect(titles).toEqual(['1 10 Sep', '2 11 Sep']);
  });

  it('names the day of a round sent before today, as the History part does (the real job)', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(sentNotesKey(realJob.id), sentResponse(realJob, [...realNotes]));
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={realJob} timeZone="UTC" now={realNow} />
      </QueryClientProvider>,
    );
    // Sent on the evening of 21 Oct, looked at on 22 Oct.
    expect(textOf(markup)).toContain('Your notes in round 1 · sent 21 Oct');
    expect(textOf(markup)).not.toContain('sent 21:54');
  });

  it('shows the round-1 notes of an approved job that had one round', () => {
    const approved = job(jobSheetJobs.approved, { round: 1 });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      sentNotesKey(approved.id),
      sentResponse(approved, jobSheetNotes.reviewRound2),
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={approved} timeZone="UTC" now={jobSheetNow.approved} />
      </QueryClientProvider>,
    );
    expect(textOf(markup)).toContain('Your notes in round 1 · sent 12:10');
    expect(markup.match(/data-slot="sent-note"/g)).toHaveLength(3);
    expect(textOf(markup)).toContain('Voice note · 0:07 תוריד פה את המוזיקה');
  });

  it('does not read the Review dialog’s notes: its drafts are not shown, in Review or after', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(notesKey(jobSheetJobs.reviewRound2.id), jobSheetNotes.reviewRound2);
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes
          job={jobSheetJobs.reviewRound2}
          timeZone="UTC"
          now={jobSheetNow.reviewRound2}
        />
      </QueryClientProvider>,
    );
    expect(markup).not.toContain('Your notes in round');
    expect(markup).not.toContain('data-slot="sent-note"');
  });

  it('leaves drafts out, even in Review where they are the only notes there are', () => {
    const draft = (id: string): ReviewNote => ({
      ...round2Note(0),
      id,
      round: null,
      sentAt: null,
      text: 'A draft nobody sent',
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      sentNotesKey(jobSheetJobs.review.id),
      sentResponse(jobSheetJobs.review, [draft('d1'), draft('d2')]),
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={jobSheetJobs.review} />
      </QueryClientProvider>,
    );
    expect(markup).not.toContain('A draft nobody sent');
    expect(markup).not.toContain('Your notes in round');
    // The note and effort rows are still there.
    expect(markup).toContain('For the editor');
    expect(markup).toContain('Effort');
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('the notes while they load', () => {
  it('draws placeholders in the place of a round, once the wait is long enough to see', () => {
    const markup = markupOf(jobSheetJobs.queued, { loading: true });
    expect(markup).toContain('data-slot="sent-notes-skeleton"');
    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it('draws no placeholders otherwise, and none beside notes that are there', () => {
    expect(markupOf(jobSheetJobs.queued, { loading: false })).not.toContain('skeleton');
    const rounds = [{ round: 1, title: 'Your notes in round 1 · sent 12:10', notes: [] }];
    expect(markupOf(jobSheetJobs.queued, { loading: true, rounds })).not.toContain('skeleton');
  });

  it('waits before drawing them: not on the first render of a load', () => {
    const queryClient = createTestQueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={jobSheetJobs.reviewRound2} />
      </QueryClientProvider>,
    );
    expect(markup).not.toContain('skeleton');
    expect(markup).toContain('For the editor');
    expect(markup).toContain('Effort');
  });

  it('leaves the rounds out quietly when the notes could not be loaded', async () => {
    const queryClient = createTestQueryClient();
    const getSentNotes = vi
      .spyOn(api, 'getSentNotes')
      .mockRejectedValue(new ApiError(404, 'There is no such job.'));
    try {
      await queryClient.prefetchQuery(sentNotesQueryOptions(api, jobSheetJobs.reviewRound2.id));
    } finally {
      getSentNotes.mockRestore();
    }
    // A server render would show the failed query as fetching again (it would retry on mount); the
    // browser shows it as failed once that retry has failed too.
    queryClient.setQueryDefaults(sentNotesKey(jobSheetJobs.reviewRound2.id), {
      retryOnMount: false,
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobSheetNotes job={jobSheetJobs.reviewRound2} />
      </QueryClientProvider>,
    );
    expect(markup).not.toContain('Your notes in round');
    expect(markup).not.toContain('skeleton');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('There is no such job');
    expect(textOf(markup)).toContain('For the editor No note');
    expect(textOf(markup)).toContain('Effort High');
  });
});

// --- what the part does with the live app -------------------------------------------------------

describe('useJobSheetNotes', () => {
  let getSentNotes: MockInstance<typeof api.getSentNotes>;
  beforeEach(() => {
    sentNotesHook.useSentNotes.mockClear();
    getSentNotes = vi.spyOn(api, 'getSentNotes');
  });
  afterEach(() => getSentNotes.mockRestore());

  /** The props the part is drawn with, as the hook makes them, inside the providers of the sheet. */
  function propsFor(subject: Job, actions: RowActions | null, notes?: ReviewNote[]): View {
    const queryClient = createTestQueryClient();
    if (notes !== undefined) {
      queryClient.setQueryData(sentNotesKey(subject.id), sentResponse(subject, notes));
    }
    let captured: View | undefined;
    function Capture() {
      captured = useJobSheetNotes(subject, 'UTC', jobSheetNow.reviewRound2);
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RowActionsContext.Provider value={actions}>
          <Capture />
        </RowActionsContext.Provider>
      </QueryClientProvider>,
    );
    if (captured === undefined) throw new Error('the hook did not run');
    return captured;
  }

  it('opens the note dialog for the job when Add or Edit is pressed', () => {
    const subject = jobSheetJobs.queued;
    const props = propsFor(subject, rowActions());
    expect(noteDialogStore.getState().asked).toBeNull();
    props.onAskNote();
    expect(noteDialogStore.getState().asked).toEqual(subject);
  });

  it('saves the effort through the sheet’s row actions', () => {
    const setEffort = vi.fn();
    const props = propsFor(jobSheetJobs.queued, rowActions({ setEffort }));
    props.onSetEffort?.('medium');
    props.onSetEffort?.(null);
    expect(setEffort.mock.calls).toEqual([['medium'], [null]]);
  });

  it('has no way to save the effort outside a sheet', () => {
    expect(propsFor(jobSheetJobs.queued, null).onSetEffort).toBeNull();
  });

  it('reads the sent rounds from the job’s sent notes', () => {
    const props = propsFor(jobSheetJobs.reviewRound2, rowActions(), jobSheetNotes.reviewRound2);
    expect(props.rounds.map((round) => round.title)).toEqual([
      'Your notes in round 1 · sent 12:10',
    ]);
    expect(props.rounds[0]?.notes).toHaveLength(3);
  });

  it('has no rounds while the notes have not arrived, and shows no placeholders yet', () => {
    const props = propsFor(jobSheetJobs.reviewRound2, rowActions());
    expect(props.rounds).toEqual([]);
    expect(props.loading).toBe(false);
  });

  it('asks for the sent notes once a round was sent, and not before', () => {
    const enabledFor = (subject: Job) => {
      sentNotesHook.useSentNotes.mockClear();
      propsFor(subject, rowActions());
      return sentNotesHook.useSentNotes.mock.calls;
    };
    expect(enabledFor(jobSheetJobs.reviewRound2)).toEqual([
      [jobSheetJobs.reviewRound2.id, { enabled: true }],
    ]);
    expect(enabledFor(job(jobSheetJobs.approved, { round: 1 }))).toEqual([
      [jobSheetJobs.approved.id, { enabled: true }],
    ]);
    // A first cut, a queued job, a job in the middle of its first edit: nothing was sent.
    for (const subject of [jobSheetJobs.review, jobSheetJobs.queued, jobSheetJobs.editing]) {
      expect(subject.round).toBe(0);
      expect(enabledFor(subject)).toEqual([[subject.id, { enabled: false }]]);
    }
    expect(getSentNotes).not.toHaveBeenCalled();
  });

  it('has no rounds, and no placeholders, for a job that has sent nothing', () => {
    const props = propsFor(jobSheetJobs.review, rowActions());
    expect(props.rounds).toEqual([]);
    expect(props.loading).toBe(false);
  });

  it('keeps the note and effort rows when the sent notes could not be loaded', async () => {
    const queryClient = createTestQueryClient();
    getSentNotes.mockRejectedValue(new ApiError(404, 'There is no such job.'));
    await queryClient.prefetchQuery(sentNotesQueryOptions(api, jobSheetJobs.reviewRound2.id));
    queryClient.setQueryDefaults(sentNotesKey(jobSheetJobs.reviewRound2.id), {
      retryOnMount: false,
    });
    let captured: View | undefined;
    function Capture() {
      captured = useJobSheetNotes(jobSheetJobs.reviewRound2, 'UTC', jobSheetNow.reviewRound2);
      return <NotesView {...captured} />;
    }
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Capture />
      </QueryClientProvider>,
    );
    expect(captured?.rounds).toEqual([]);
    expect(captured?.loading).toBe(false);
    expect(textOf(markup)).toContain('For the editor No note');
    expect(textOf(markup)).toContain('Effort High');
  });
});
