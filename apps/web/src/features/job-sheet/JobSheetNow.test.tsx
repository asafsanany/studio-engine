// CVP-216 (JS3): the sheet's Now part. There is no DOM, so a state is server-rendered and read as
// markup, and a click is made by calling the handler of the button in the element tree of the
// pure parts (`NowButtons`, `NowError`), which use no hooks. The shared-busy tests render the sheet
// and a row's Action cell on one query client, each with its own `useRowActions`.

import type { Job, ReviewNote } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, api, sentNotesKey, sentNotesQueryOptions } from '@/data';
import { JOBS_KEY } from '@/data/jobs-cache';
import { notesKey } from '@/data/notes-cache';
import { BASE_URL, createTestQueryClient, deferred } from '@/data/test-utils';
import { ActionCell } from '@/features/jobs/cells/ActionCell';
import { ActionError } from '@/features/jobs/cells/ActionError';
import { textOf } from '@/features/jobs/cells/test-helpers';
import {
  type RowActions,
  RowActionsContext,
  useRowActions,
} from '@/features/jobs/cells/use-row-actions';
import { markPaidRequestStore } from '@/features/jobs/mark-paid/request';
import { reviewDialogStore } from '@/features/review/review-dialog';
import { JobSheetNow, NowButtons, NowError } from './JobSheetNow';
import { sheetButtons, sheetError } from './sheet-now';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNotes,
  jobSheetNow,
} from './test-fixtures';

// The sheet reads the notes it sent through `useSentNotes`; a call-through spy shows what it asked.
const sentNotesHook = vi.hoisted(() => ({ useSentNotes: vi.fn() }));
vi.mock('@/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data')>();
  sentNotesHook.useSentNotes.mockImplementation(actual.useSentNotes);
  return { ...actual, useSentNotes: sentNotesHook.useSentNotes };
});

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

// The clock of the page is cached between renders and never runs backwards, so these tests read the
// (faked) time directly; the intervals asked for are written down.
const intervals = vi.hoisted(() => [] as (number | undefined)[]);
vi.mock('@/components/jobs/use-now', () => ({
  useNow: (intervalMs?: number) => {
    intervals.push(intervalMs);
    return Date.now();
  },
}));

const server = setupServer();
const realFetch = globalThis.fetch;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // The countdown and the bar read the clock; each render sets it to the moment of its board.
  vi.useFakeTimers({ now: new Date(jobSheetNow.review), toFake: ['Date'] });
});
beforeEach(() => {
  // The data layer's `api` asks for relative addresses; MSW answers absolute ones.
  const interceptedFetch = realFetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    interceptedFetch(
      typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input,
      init,
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.useRealTimers();
  server.close();
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, jobSheetList);
  for (const mock of [sonner.toast, sonner.toast.success, sonner.toast.error]) mock.mockClear();
  reviewDialogStore.getState().reset();
  markPaidRequestStore.getState().close();
});

// --- rendering ----------------------------------------------------------------------------------

/** The sheet's actions, as JS2's sheet makes them for its job: `useRowActions` into the context. */
function Sheet({ job, onActions }: { job: Job; onActions?: (actions: RowActions) => void }) {
  const actions = useRowActions(job);
  onActions?.(actions);
  return (
    <RowActionsContext.Provider value={actions}>
      <JobSheetNow job={job} timeZone="UTC" />
    </RowActionsContext.Provider>
  );
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The Now part of a job of the boards, drawn at the moment of its board. */
function sheetOf(state: JobSheetState): string {
  vi.setSystemTime(new Date(jobSheetNow[state]));
  return render(<Sheet job={jobSheetJobs[state]} />);
}

/** What the sheet's primary button looks like in markup: its kind, name, icon and whether it waits. */
function primaryOf(markup: string) {
  const open = /<button\b[^>]*\bdata-sheet-action="([\w-]+)"[^>]*>/.exec(markup);
  if (open === null) return null;
  const rest = markup.slice((open.index ?? 0) + open[0].length);
  const inner = rest.slice(0, rest.indexOf('</button>'));
  return {
    kind: open[1],
    label: textOf(inner),
    icon: /lucide-([\w-]+)/.exec(inner)?.[1],
    disabled: open[0].includes(' disabled=""'),
  };
}

/** The opening tag of the element that has `attribute` (`data-sheet-download`, `data-sheet-action="retry"`). */
function tagWith(markup: string, attribute: string): string {
  const found = new RegExp(`<[a-z]+\\b[^>]*${attribute}[^>]*>`).exec(markup);
  if (found === null) throw new Error(`no element with ${attribute}`);
  return found[0];
}

/** The row's Action button, by its accessible name. */
function rowButton(markup: string, label: string) {
  const open = new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>`).exec(markup);
  return open === null ? null : { disabled: open[0].includes(' disabled=""') };
}

// --- walking an element tree --------------------------------------------------------------------

type Element = ReactElement<Record<string, unknown>>;

/** Every element in `node`, children before siblings; components are not rendered. */
function elementsIn(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elementsIn(node.props.children as ReactNode)];
}

const withProp = (node: ReactNode, name: string): Element => {
  const found = elementsIn(node).find((element) => name in element.props);
  if (found === undefined) throw new Error(`no element with ${name}`);
  return found;
};

const click = (element: Element) => (element.props.onClick as () => void)();

/** The actions of a row that wrote down what it was asked to do. */
function fakeActions(overrides: Partial<RowActions> = {}): RowActions {
  return {
    run: vi.fn(),
    setEffort: vi.fn(),
    setReviewEffort: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    archiveAllPaid: vi.fn(),
    busy: false,
    refusal: null,
    dismissRefusal: vi.fn(),
    ...overrides,
  };
}

const buttonsOf = (state: JobSheetState, actions = fakeActions()) =>
  NowButtons({
    job: jobSheetJobs[state],
    buttons: sheetButtons(jobSheetJobs[state]),
    actions,
  });

// --- the sentence and the bar -------------------------------------------------------------------

describe('<JobSheetNow>: the sentence', () => {
  it.each([
    ['held', 'On hold since 11:20. It won’t start until you release it.'],
    [
      'failed',
      'Render stopped at 12:52. Steps 1 to 7 are kept, so Retry only makes the MP4 again.',
    ],
    ['cancelled', 'You stopped it during Cut at 10:41. Resume picks it up again at Cut.'],
    ['review', 'The first cut is ready, 0:44. The MP4 is made after you approve it.'],
    ['approved', 'The MP4 is ready: 0:30, 27 MB. It hasn’t been sent to RGM yet.'],
    ['delivered', 'Sent to LAKESHORE on 21 Oct. ₪40 isn’t paid yet.'],
    ['paid', 'Paid ₪40 on 21 Oct. Nothing left to do.'],
    [
      'archived',
      'Archived on 30 Sep, so it only shows with Show archived on. It still counts in income.',
    ],
  ] as const)('%s says %j', (state, sentence) => {
    expect(textOf(sheetOf(state))).toContain(sentence);
  });

  it('reads the job list for the job a queued job waits for', () => {
    expect(textOf(sheetOf('queued'))).toContain(
      '#1 in line. It starts when חנוכה 2026 is done, in about 1 minute.',
    );
    queryClient.setQueryData(JOBS_KEY, [jobSheetJobs.queued]);
    expect(textOf(sheetOf('queued'))).toContain('#1 in line. It starts next.');
  });

  it('puts the sentence in its own direction, flush left, so a Hebrew name does not flip it', () => {
    const markup = sheetOf('queued');
    expect(markup).toMatch(/<p dir="auto" class="[^"]*text-left[^"]*unicode-bidi:plaintext/);
  });

  it('counts the notes of the round when the sent notes have arrived, and leaves the count out otherwise', () => {
    expect(textOf(sheetOf('reviewRound2'))).toContain(
      'Round 2 is ready, 0:41. It has your notes from round 1.',
    );
    queryClient.setQueryData(sentNotesKey(jobSheetJobs.reviewRound2.id), {
      jobId: jobSheetJobs.reviewRound2.id,
      notes: jobSheetNotes.reviewRound2,
    });
    expect(textOf(sheetOf('reviewRound2'))).toContain(
      'Round 2 is ready, 0:41. It has your 3 notes from round 1.',
    );
  });

  it('shows its own countdown, one second at a time', () => {
    const at = (iso: string) => {
      vi.setSystemTime(new Date(iso));
      return textOf(render(<Sheet job={jobSheetJobs.arriving} />));
    };
    expect(at('2026-10-22T15:03:18.000Z')).toContain('starts in 0:42');
    expect(at('2026-10-22T15:03:19.000Z')).toContain('starts in 0:41');
  });

  it('asks for the one-second clock only while the job is arriving', () => {
    intervals.length = 0;
    sheetOf('arriving');
    expect(intervals).toEqual([1000]);
    intervals.length = 0;
    sheetOf('editing');
    expect(intervals).toEqual([undefined]);
  });
});

describe('<JobSheetNow>: the review sentence reads the notes they sent', () => {
  const round2 = jobSheetJobs.reviewRound2;
  let getSentNotes: MockInstance<typeof api.getSentNotes>;
  beforeEach(() => {
    sentNotesHook.useSentNotes.mockClear();
    getSentNotes = vi.spyOn(api, 'getSentNotes');
  });
  afterEach(() => getSentNotes.mockRestore());

  /** The engine's answer (or refusal) for a job's sent notes, loaded into the cache as the hook would. */
  async function load(job: Job, answer: ReviewNote[] | ApiError): Promise<void> {
    getSentNotes.mockImplementation(async (id) => {
      if (answer instanceof ApiError) throw answer;
      return { jobId: id, notes: answer };
    });
    await queryClient.prefetchQuery(sentNotesQueryOptions(api, job.id));
  }

  /** The sheet's sentence for a review job, at the moment of the "Ready to review · round 2" board. */
  const sentenceOf = (job: Job) => {
    vi.setSystemTime(new Date(jobSheetNow.reviewRound2));
    return textOf(render(<Sheet job={job} />));
  };

  it('says "It has your 3 notes from round 1" from what the engine lists as sent', async () => {
    await load(round2, jobSheetNotes.reviewRound2);
    expect(getSentNotes).toHaveBeenCalledWith(round2.id, expect.anything());
    expect(sentenceOf(round2)).toContain(
      'Round 2 is ready, 0:41. It has your 3 notes from round 1.',
    );
  });

  it('counts only the notes of the round this cut is the result of', async () => {
    const third = { ...round2, round: 2 };
    const sentIn = (round: number, id: string) =>
      ({ ...jobSheetNotes.reviewRound2[0], id, round }) as ReviewNote;
    await load(third, [...jobSheetNotes.reviewRound2, sentIn(2, 'r2-a'), sentIn(2, 'r2-b')]);
    expect(sentenceOf(third)).toContain(
      'Round 3 is ready, 0:41. It has your 2 notes from round 2.',
    );
  });

  it('says "1 note" for a single note', async () => {
    await load(round2, jobSheetNotes.reviewRound2.slice(0, 1));
    expect(sentenceOf(round2)).toContain('It has your 1 note from round 1.');
  });

  it('keeps the count-less wording when the sent notes could not be loaded', async () => {
    await load(round2, new ApiError(404, 'There is no such job.'));
    queryClient.setQueryDefaults(sentNotesKey(round2.id), { retryOnMount: false });
    expect(sentenceOf(round2)).toContain('Round 2 is ready, 0:41. It has your notes from round 1.');
  });

  it('keeps the count-less wording when no note was sent in that round', async () => {
    await load(round2, []);
    expect(sentenceOf(round2)).toContain('Round 2 is ready, 0:41. It has your notes from round 1.');
  });

  it('does not read the Review dialog’s notes any more', () => {
    const draft = { ...jobSheetNotes.reviewRound2[0], id: 'draft', round: 1 } as ReviewNote;
    queryClient.setQueryData(notesKey(round2.id), [draft, draft, draft]);
    expect(sentenceOf(round2)).toContain('It has your notes from round 1.');
  });

  it('asks for the sent notes only for a review job that has sent a round', () => {
    const enabledFor = (job: Job) => {
      sentNotesHook.useSentNotes.mockClear();
      sentenceOf(job);
      return sentNotesHook.useSentNotes.mock.calls.map(([id, options]) => [id, options]);
    };
    expect(enabledFor(round2)).toEqual([[round2.id, { enabled: true }]]);
    // The first cut (round 0) has no sent notes; neither does a job that is not in review.
    expect(enabledFor(jobSheetJobs.review)).toEqual([[jobSheetJobs.review.id, { enabled: false }]]);
    expect(enabledFor(jobSheetJobs.rendering)).toEqual([
      [jobSheetJobs.rendering.id, { enabled: false }],
    ]);
    expect(getSentNotes).not.toHaveBeenCalled();
  });
});

describe('<JobSheetNow>: the bar', () => {
  it('has a grey one while files arrive: a name on the left, the countdown on the right', () => {
    const markup = sheetOf('arriving');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="30"');
    expect(markup).toContain('aria-label="Waiting for the last files"');
    expect(markup).toContain('data-tone="grey"');
    expect(markup).toContain('zinc-500');
    expect(textOf(markup)).toContain('Waiting for the last files starts in 0:42');
  });

  it('has a blue one while it edits: the step and its count, and the time left', () => {
    const markup = sheetOf('editing');
    expect(markup).toContain('aria-valuenow="55"');
    expect(markup).toContain('data-tone="blue"');
    expect(markup).toContain('bg-status-editing');
    expect(textOf(markup)).toContain('Cut · graphics 2 of 5 ~4 min left');
  });

  it('has one called Render while it renders', () => {
    const markup = sheetOf('rendering');
    expect(markup).toContain('aria-label="Render"');
    expect(textOf(markup)).toContain('Render ~1 min left');
  });

  it('is a 6 px track in the muted colour', () => {
    expect(sheetOf('editing')).toMatch(
      /role="progressbar"[^>]*class="[^"]*\bh-1\.5\b[^"]*\bbg-muted\b/,
    );
  });

  it('has none in any other state', () => {
    for (const state of JOB_SHEET_STATES) {
      if (['arriving', 'editing', 'rendering'].includes(state)) continue;
      expect(sheetOf(state), state).not.toContain('role="progressbar"');
    }
  });
});

// --- the error ----------------------------------------------------------------------------------

describe('<JobSheetNow>: the error', () => {
  it('shows a failed job’s whole error in a red box, with its step and time', () => {
    const markup = sheetOf('failed');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('border-status-failed/30');
    expect(markup).toContain('bg-status-failed/8');
    expect(textOf(markup)).toContain('Failed at Render · 12:52');
    expect(markup).toContain(
      'ffmpeg exited with code 1:\nError writing trailer: No space left on device',
    );
  });

  it('writes it in mono, wrapping, keeping its line breaks', () => {
    expect(sheetOf('failed')).toMatch(
      /<code class="[^"]*font-mono[^"]*wrap-anywhere[^"]*whitespace-pre-wrap/,
    );
  });

  it('has a quiet Copy button beside the title', () => {
    expect(sheetOf('failed')).toMatch(
      /<button\b[^>]*data-variant="ghost"[^>]*data-sheet-copy[^>]*>Copy<\/button>/,
    );
  });

  it('is only on a failed job that has an error', () => {
    for (const state of JOB_SHEET_STATES.filter((s) => s !== 'failed')) {
      expect(sheetOf(state), state).not.toContain('role="alert"');
    }
    queryClient.setQueryData(JOBS_KEY, [{ ...jobSheetJobs.failed, error: null }]);
    vi.setSystemTime(new Date(jobSheetNow.failed));
    expect(render(<Sheet job={{ ...jobSheetJobs.failed, error: null }} />)).not.toContain(
      'role="alert"',
    );
  });

  it('Copy puts the error on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const error = sheetError(jobSheetJobs.failed, 'UTC');
    if (error === null) throw new Error('the failed job has an error');

    click(withProp(NowError({ error }), 'data-sheet-copy'));

    await vi.waitFor(() => expect(sonner.toast.success).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(jobSheetJobs.failed.error);
    expect(sonner.toast.success.mock.calls[0]?.[0]).toBe('Error copied');
  });

  it('Copy says so when the clipboard cannot be written', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    const error = sheetError(jobSheetJobs.failed, 'UTC');
    if (error === null) throw new Error('the failed job has an error');

    click(withProp(NowError({ error }), 'data-sheet-copy'));

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    expect(sonner.toast.error.mock.calls[0]?.[0]).toBe("Couldn't copy the error");
  });
});

// --- the buttons --------------------------------------------------------------------------------

describe('<JobSheetNow>: the buttons', () => {
  it.each([
    ['arriving', 'start', 'Start now', 'play'],
    ['held', 'release', 'Release', 'play'],
    ['failed', 'retry', 'Retry from Render', 'rotate-ccw'],
    ['cancelled', 'resume', 'Resume', 'play'],
    ['review', 'review', 'Review', 'play'],
    ['reviewRound2', 'review', 'Review', 'play'],
    ['approved', 'deliver', 'Mark delivered', 'send'],
    ['delivered', 'pay', 'Mark paid…', 'banknote'],
  ] as const)('%s: a button named %j, with the row’s icon', (state, kind, label, icon) => {
    expect(primaryOf(sheetOf(state))).toEqual({ kind, label, icon, disabled: false });
  });

  it.each(['queued', 'editing'] as const)('%s has no button: it moves by itself', (state) => {
    const markup = sheetOf(state);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
  });

  it('offers the preview during Render, after Review has ended', () => {
    expect(primaryOf(sheetOf('rendering'))).toEqual({
      kind: 'view-preview',
      label: 'View preview',
      icon: 'play',
      disabled: false,
    });
  });

  it('draws the next step as a full-width, 36 px, near-white button', () => {
    const tag = tagWith(sheetOf('failed'), 'data-sheet-action="retry"');
    for (const className of ['flex-1', 'h-9', 'bg-zinc-50']) {
      expect(tag).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
    }
    expect(tag).toContain('data-variant="default"');
  });

  it('gives a ready job Download MP4, an outline link to its export, beside the next step', () => {
    const markup = sheetOf('approved');
    expect(markup).toContain(`href="/api/jobs/${jobSheetJobs.approved.id}/download"`);
    const link = tagWith(markup, 'data-sheet-download');
    expect(link).toContain('data-variant="outline"');
    expect(link).toContain(' download=""');
    expect(markup).toContain('lucide-download');
    expect(textOf(markup)).toContain('Mark delivered View preview Download MP4');
    // Beside the next step it keeps its own width.
    expect(link).toMatch(/class="[^"]*\bshrink-0\b/);
  });

  it('gives a paid job View preview beside Download MP4', () => {
    const markup = sheetOf('paid');
    expect(primaryOf(markup)?.kind).toBe('view-preview');
    expect(markup).toContain('Download MP4');
    expect(tagWith(markup, 'data-sheet-download')).toMatch(/class="[^"]*\bshrink-0\b/);
  });

  it('gives an archived job its preview too: Unarchive is in the ⋯ menu', () => {
    const markup = sheetOf('archived');
    expect(primaryOf(markup)?.kind).toBe('view-preview');
    expect(markup).toContain('Download MP4');
  });

  it('makes its own actions when no sheet provides them', () => {
    vi.setSystemTime(new Date(jobSheetNow.failed));
    const markup = render(<JobSheetNow job={jobSheetJobs.failed} timeZone="UTC" />);
    expect(primaryOf(markup)).toMatchObject({ kind: 'retry', disabled: false });
  });
});

describe('<NowButtons>: what a press does', () => {
  const primary = (state: JobSheetState, actions = fakeActions()) =>
    withProp(buttonsOf(state, actions), 'data-sheet-action');

  it.each([
    ['arriving', 'start', 'Start now'],
    ['held', 'release', 'Release'],
    ['failed', 'retry', 'Retry from Render'],
    ['cancelled', 'resume', 'Resume'],
    ['approved', 'deliver', 'Mark delivered'],
  ] as const)('%s: sends %s through the row’s actions', (state, kind, label) => {
    const actions = fakeActions();
    click(primary(state, actions));
    expect(actions.run).toHaveBeenCalledExactlyOnceWith({ kind, label });
  });

  it('Review opens the review dialog for the job, and sends nothing', () => {
    const actions = fakeActions();
    click(primary('review', actions));
    expect(reviewDialogStore.getState().jobId).toBe(jobSheetJobs.review.id);
    expect(actions.run).not.toHaveBeenCalled();
  });

  it('Mark paid… asks the page for the payment dialog, and sends nothing', () => {
    const actions = fakeActions();
    click(primary('delivered', actions));
    expect(markPaidRequestStore.getState().request).toEqual({
      jobId: jobSheetJobs.delivered.id,
      clientId: jobSheetJobs.delivered.clientId,
      client: 'LAKESHORE',
    });
    expect(actions.run).not.toHaveBeenCalled();
  });

  it('waits while a request for the job is on its way, except Review and Mark paid…, which send none', () => {
    const busy = fakeActions({ busy: true });
    for (const state of ['arriving', 'held', 'failed', 'cancelled', 'approved'] as const) {
      expect(primary(state, busy).props.disabled, state).toBe(true);
    }
    for (const state of ['review', 'delivered'] as const) {
      expect(primary(state, busy).props.disabled, state).toBe(false);
    }
  });

  it('waits for the engine when it can’t be reached: every button, Review and Download too', () => {
    for (const state of ['arriving', 'held', 'failed', 'review', 'delivered'] as const) {
      const tree = NowButtons({
        job: jobSheetJobs[state],
        buttons: sheetButtons(jobSheetJobs[state]),
        actions: fakeActions(),
        waiting: true,
      });
      expect(withProp(tree, 'data-sheet-action').props.disabled, state).toBe(true);
    }
    const approved = NowButtons({
      job: jobSheetJobs.approved,
      buttons: sheetButtons(jobSheetJobs.approved),
      actions: fakeActions(),
      waiting: true,
    });
    const download = withProp(approved, 'data-sheet-download').props;
    expect(download.href).toBeUndefined();
    expect(download['aria-disabled']).toBe(true);
    expect(download.tabIndex).toBe(-1);
    // And not when it can.
    const reachable = withProp(buttonsOf('approved'), 'data-sheet-download').props;
    expect(reachable.href).toMatch(/\/download$/);
    expect(reachable['aria-disabled']).toBeUndefined();
  });

  it('explains a refusal under the buttons, as the row does, and lets it be dismissed', () => {
    const dismissRefusal = vi.fn();
    const tree = buttonsOf(
      'failed',
      fakeActions({ refusal: 'Only a failed job can be retried.', dismissRefusal }),
    );
    if (!isValidElement<Record<string, unknown>>(tree)) throw new Error('no buttons');
    expect(tree.type).toBe(ActionError);
    expect(tree.props.message).toBe('Only a failed job can be retried.');
    (tree.props.onDismiss as () => void)();
    expect(dismissRefusal).toHaveBeenCalledOnce();
  });

  it('draws nothing for a job with no buttons', () => {
    expect(buttonsOf('queued')).toBeNull();
    expect(buttonsOf('editing')).toBeNull();
  });
});

// --- one busy for the sheet and the row ---------------------------------------------------------

describe('a press in the sheet and in the row', () => {
  /** Answers a job action with the job, once the test lets it. */
  function holdRequest(path: string, job: Job) {
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}${path}`, async () => {
        await gate.promise;
        return HttpResponse.json(job);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([job])),
    );
    return gate;
  }

  /** The sheet and the row of `job`, each with its own `useRowActions`, side by side. */
  function both(job: Job): string {
    return render(
      <>
        <Sheet job={job} />
        <ActionCell job={job} />
      </>,
    );
  }

  /** The actions of a row's `useRowActions` for `job`: the sheet's, or the row’s own. */
  function actionsFor(job: Job): RowActions {
    let captured: RowActions | undefined;
    render(<Sheet job={job} onActions={(actions) => (captured = actions)} />);
    if (captured === undefined) throw new Error('the hook did not run');
    return captured;
  }

  const failed = jobSheetJobs.failed;
  const approved = jobSheetJobs.approved;

  it('starts with both buttons free', () => {
    queryClient.setQueryData(JOBS_KEY, [failed]);
    const markup = both(failed);
    expect(primaryOf(markup)?.disabled).toBe(false);
    expect(rowButton(markup, 'Retry from Render')?.disabled).toBe(false);
  });

  it('Retry pressed in the sheet disables the row’s Action button too, until the answer is in', async () => {
    queryClient.setQueryData(JOBS_KEY, [failed]);
    const gate = holdRequest(`/api/jobs/${failed.id}/retry`, {
      ...failed,
      state: 'queued',
      failedAt: null,
      error: null,
    });

    actionsFor(failed).run({ kind: 'retry', label: 'Retry from Render' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    // The jobs list moved on optimistically; both parts are drawn from the job they were given.
    const waiting = both(failed);
    expect(primaryOf(waiting)?.disabled).toBe(true);
    expect(rowButton(waiting, 'Retry from Render')?.disabled).toBe(true);

    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    const done = both(failed);
    expect(primaryOf(done)?.disabled).toBe(false);
    expect(rowButton(done, 'Retry from Render')?.disabled).toBe(false);
  });

  it('Mark delivered pressed in the row disables the sheet’s button too (the other way round)', async () => {
    queryClient.setQueryData(JOBS_KEY, [approved]);
    const delivered = {
      ...approved,
      delivery: {
        deliveredAt: '2026-10-22T14:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
      },
    };
    const gate = holdRequest(`/api/jobs/${approved.id}/deliver`, delivered);

    // The row's hook, not the sheet's: another `useRowActions` for the same job.
    let rowActions: RowActions | undefined;
    function Row() {
      rowActions = useRowActions(approved);
      return null;
    }
    render(<Row />);
    rowActions?.run({ kind: 'deliver', label: 'Mark delivered' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    // A stage change waits for the server: the job is still approved, so both buttons are there.
    const waiting = both(approved);
    expect(primaryOf(waiting)).toMatchObject({ kind: 'deliver', disabled: true });
    expect(rowButton(waiting, 'Mark delivered')?.disabled).toBe(true);

    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
  });

  it('leaves the buttons of other jobs alone', async () => {
    const other = jobSheetJobs.held;
    queryClient.setQueryData(JOBS_KEY, [failed, other]);
    const gate = holdRequest(`/api/jobs/${failed.id}/retry`, failed);

    actionsFor(failed).run({ kind: 'retry', label: 'Retry from Render' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    const markup = render(<Sheet job={other} />);
    expect(primaryOf(markup)).toMatchObject({ kind: 'release', disabled: false });

    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
  });

  it('keeps a refusal with the press: the row that did not send it shows none', async () => {
    queryClient.setQueryData(JOBS_KEY, [failed]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/${failed.id}/retry`, () =>
        HttpResponse.json({ error: 'Only a failed job can be retried.' }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([failed])),
    );

    actionsFor(failed).run({ kind: 'retry', label: 'Retry from Render' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));

    // The mutation that was refused has one observer: the hook that sent it. Any other hook for the
    // job (the row's) has no mutation of its own, so it has no error to show.
    const refused = queryClient
      .getMutationCache()
      .getAll()
      .filter((mutation) => mutation.state.error !== null);
    expect(refused).toHaveLength(1);
    let rowActions: RowActions | undefined;
    function Row() {
      rowActions = useRowActions(failed);
      return null;
    }
    render(<Row />);
    expect(rowActions?.refusal).toBeNull();
    expect(rowActions?.busy).toBe(false);
  });
});
