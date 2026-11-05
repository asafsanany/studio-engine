import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import type { JobsUiStore } from '@/stores/jobs-ui';
import { textOf } from './cells/test-helpers';
import { JobsList } from './JobsList';
import { noteDialogStore } from './note-dialog';
import {
  CANVAS_JOBS,
  CLIENT_IDS,
  createTestStore,
  DEFAULT_ORDER,
  DELIVERY_ROW_JOBS,
  NOW,
  REVIEW_ROW_JOBS,
} from './test-jobs';

// Rows link the client's name to its page; these tests render without a router, so a link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

// The arriving countdown and the times read the clock; hold it at the canvas's "now". This runs
// before anything is rendered (the shared clocks take `Date.now` when they are first asked for).
vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
afterAll(() => {
  vi.useRealTimers();
});

/** Every row has its actions (for the button and the right-click menu), so the list needs a query client. */
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>{node}</QueryClientProvider>,
  );

const newStore = createTestStore;
const html = (store: StoreApi<JobsUiStore>, jobs: readonly Job[] | undefined = CANVAS_JOBS) =>
  render(<JobsList jobs={jobs} store={store} />);

/** Job ids in the order the rows are on the page. */
const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The `<li>` of one job's row. */
function rowOf(markup: string, id: string): string {
  const row = markup.match(new RegExp(`<li [^>]*data-job-id="${id}"[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

/** The detail text of a row: what is after the name, before the time. */
const detailOf = (row: string) => {
  const start = row.lastIndexOf('<', row.indexOf('data-slot="job-detail"'));
  const end = row.indexOf('<div class="text-right text-[13px] whitespace-nowrap"><time', start);
  return textOf(row.slice(start, end));
};

const rangeText = (markup: string) => markup.match(/aria-live="polite">([^<]*)</)?.[1];
const hasPager = (markup: string) => markup.includes('aria-label="pagination"');

/** The attribute of the icon of a row. */
const iconAttr = (row: string, name: string) =>
  row.match(/<svg[^>]*>/)?.[0].match(new RegExp(` ${name}="([^"]*)"`))?.[1];

describe('<JobsList>: the list', () => {
  const markup = html(newStore());

  it('is a plain list of jobs: a ul named Jobs, 2 px between the rows', () => {
    expect(markup).toMatch(/<ul aria-label="Jobs" class="flex flex-col gap-0\.5">/);
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('<tr');
    expect(markup).not.toContain('<td');
  });

  it('has no header row, no sort button, no resize handle, no Columns menu', () => {
    expect(markup).not.toContain('<th');
    expect(markup).not.toContain('columnheader');
    expect(markup).not.toContain('aria-sort');
    expect(markup).not.toContain('cursor-col-resize');
    expect(markup).not.toContain('Columns');
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  it('has no border around the list and no line between the rows', () => {
    const list = markup.match(/<ul[^>]*>/)?.[0] ?? '';
    expect(list).not.toContain('border');
    expect(markup).not.toContain('rounded-md border');
    for (const id of ['j5', 'j1']) expect(rowOf(markup, id)).not.toMatch(/\bborder-b\b/);
  });

  it('has a row for each job on the page, as a list item', () => {
    expect(rowIds(markup)).toHaveLength(10);
    // The pager under the list has list items of its own: count the ones inside the list.
    const list = markup.slice(markup.indexOf('<ul aria-label="Jobs"'), markup.indexOf('</ul>'));
    expect(list.match(/<li /g)).toHaveLength(10);
  });

  it('puts the five cells in a row in order: icon, name, detail, time, next step', () => {
    const row = rowOf(markup, 'j6');
    const at = (needle: string) => row.indexOf(needle);
    const order = [
      at('data-status="ready"'),
      at('השקת תפריט חדש'),
      at('Kova Coffee'),
      at('data-slot="job-detail"'),
      at('<time'),
      at('data-row-actions="j6"'),
    ];
    expect(order.every((position) => position > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('shows the time as "1 h ago", muted, in a <time> with the exact moment for the tooltip', () => {
    const row = rowOf(markup, 'j6');
    expect(row).toContain('<time dateTime="2026-10-20T11:58:00.000Z"');
    expect(textOf(row.match(/<time[\s\S]*?<\/time>/)?.[0] ?? '')).toBe('1 h ago');
    expect(row).toMatch(/<div class="text-right text-\[13px\] whitespace-nowrap"><time/);
  });

  it('has no avatar, no status badge and no segment bar', () => {
    expect(markup).not.toContain('data-slot="avatar"');
    expect(markup).not.toContain('data-slot="badge"');
    expect(markup).not.toContain('data-segment');
  });

  it('has no Inputs, Size, Added or resolution anywhere', () => {
    expect(markup).not.toContain('data-input=');
    expect(markup).not.toContain('2.2 GB');
    expect(markup).not.toMatch(/1080|1920|×/);
  });
});

describe('<JobsList>: order', () => {
  it('starts with the most recently updated job first', () => {
    expect(rowIds(html(newStore()))).toEqual(DEFAULT_ORDER.slice(0, 10));
  });

  it('puts the job updated last first no matter what order the data arrives in', () => {
    const shuffled = [...CANVAS_JOBS].reverse();
    expect(rowIds(html(newStore(), shuffled))).toEqual(DEFAULT_ORDER.slice(0, 10));
  });

  it('keeps jobs updated at the same moment in a stable order (the one added last first)', () => {
    const same = '2026-10-20T11:00:00.000Z';
    const jobs = [
      makeJob({
        id: 'x1',
        name: 'A',
        client: 'Same',
        addedAt: '2026-10-20T09:00:00.000Z',
        updatedAt: same,
      }),
      makeJob({
        id: 'x2',
        name: 'B',
        client: 'Same',
        addedAt: '2026-10-20T10:00:00.000Z',
        updatedAt: same,
      }),
      makeJob({
        id: 'x3',
        name: 'C',
        client: 'Same',
        addedAt: '2026-10-20T08:00:00.000Z',
        updatedAt: same,
      }),
    ];
    expect(rowIds(html(newStore(), jobs))).toEqual(['x2', 'x1', 'x3']);
    expect(rowIds(html(newStore(), [...jobs].reverse()))).toEqual(['x2', 'x1', 'x3']);
  });

  it('has no way to change the order', () => {
    const markup = html(newStore());
    expect(markup).not.toContain('aria-sort');
    expect(markup).not.toContain('lucide-arrow');
  });
});

describe('<JobsList>: each state, with the canvas data', () => {
  const cases: Array<
    [id: string, name: string, status: string, done: string | undefined, text: string]
  > = [
    ['j1', 'Arriving', 'arriving', undefined, 'Arriving · settles in 0:42'],
    ['j2', 'Queued', 'queued', undefined, 'Queued · #2 in line'],
    ['j4', 'Queued', 'queued', undefined, 'Queued · #1 in line'],
    ['j3', 'Held', 'held', undefined, 'Held'],
    ['j5', 'Editing', 'editing', '4', 'Cut · graphics 2/5 · ~4 min left'],
    ['j6', 'Approved', 'ready', undefined, '0:45 · 62 MB'],
    ['j9', 'Approved', 'ready', undefined, 'Approved'],
    ['j7', 'Failed', 'failed', undefined, 'Failed at Render'],
    ['j8', 'Cancelled', 'cancelled', undefined, 'Cancelled at Plan'],
  ];

  it.each(cases)(
    '%s: the icon is named %s, data-status %s, data-done %s, and the detail reads "%s"',
    (id, name, status, done, text) => {
      const row = rowOf(html(newStore()), id);
      expect(iconAttr(row, 'role')).toBe('img');
      expect(iconAttr(row, 'aria-label')).toBe(name);
      expect(iconAttr(row, 'data-status')).toBe(status);
      expect(iconAttr(row, 'data-done')).toBe(done);
      expect(detailOf(row)).toBe(text);
    },
  );

  it('review and the editing runs of the review board: "Ready to review", the round, "approved"', () => {
    const markup = render(<JobsList jobs={REVIEW_ROW_JOBS} store={newStore()} />);
    const review = rowOf(markup, 'r1');
    expect(iconAttr(review, 'aria-label')).toBe('Review');
    expect(iconAttr(review, 'data-status')).toBe('review');
    expect(iconAttr(review, 'data-done')).toBeUndefined();
    expect(detailOf(review)).toBe('Ready to review · 0:28');

    const revise = rowOf(markup, 'r2');
    expect(iconAttr(revise, 'data-done')).toBe('4');
    expect(detailOf(revise)).toBe('Cut · graphics 2/5 · round 2 · ~4 min left');

    const renderRun = rowOf(markup, 'r3');
    expect(iconAttr(renderRun, 'data-done')).toBe('7');
    expect(detailOf(renderRun)).toBe('Render · approved · ~3 min left');
  });

  it('reads the step of an editing row from the data-step-label span', () => {
    const row = rowOf(html(newStore()), 'j5');
    expect(row).toContain('<span data-step-label="">Cut · graphics 2/5</span>');
  });

  it('shows a failed row’s detail as a button with the error behind it, in red', () => {
    const row = rowOf(html(newStore()), 'j7');
    expect(row).toMatch(/<button type="button" data-slot="job-detail"[^>]*cursor-help/);
    expect(row).toContain('text-status-failed-foreground');
    expect(row).not.toContain('not enough disk space');
  });

  it('says "while you write a note" for the job the note dialog holds', () => {
    const initialState = noteDialogStore.getInitialState;
    noteDialogStore.getInitialState = () => noteDialogStore.getState();
    try {
      noteDialogStore.setState({
        phase: 'writing',
        job: { id: 'j3', name: 'x', client: 'y' },
        held: true,
      });
      const markup = html(newStore());
      expect(detailOf(rowOf(markup, 'j3'))).toBe('Held · while you write a note');
      expect(detailOf(rowOf(markup, 'j2'))).toBe('Queued · #2 in line');
    } finally {
      noteDialogStore.getState().reset();
      noteDialogStore.getInitialState = initialState;
    }
  });

  it('counts the arriving job down with the clock', () => {
    vi.setSystemTime(new Date('2026-10-20T13:42:10.000Z'));
    expect(detailOf(rowOf(html(newStore()), 'j1'))).toBe('Arriving · settles in 0:32');
    vi.setSystemTime(new Date(NOW));
  });
});

describe('<JobsList>: the next step of each row', () => {
  const markup = html(newStore());
  /** The accessible names of the buttons and links in a row's last cell, the next-step one. */
  const nextStep = (row: string) =>
    [...row.slice(row.indexOf('data-row-actions')).matchAll(/aria-label="([^"]+)"/g)].map(
      (m) => m[1],
    );

  it.each([
    ['j1', ['Start now']],
    ['j2', []],
    ['j3', ['Release']],
    ['j5', []],
    ['j6', ['Mark delivered']],
    ['j7', ['Retry from Render']],
    ['j8', ['Resume']],
  ] as const)('%s has %j', (id, expected) => {
    expect(nextStep(rowOf(markup, id))).toEqual(expected);
  });

  it('puts the Review button on a job in review', () => {
    const review = rowOf(render(<JobsList jobs={REVIEW_ROW_JOBS} store={newStore()} />), 'r1');
    expect(review).toContain('aria-label="Review"');
    expect(review).toContain('data-row-actions="r1"');
  });

  it('keeps Hold, Cancel and Copy error out of the row: they are in the right-click menu', () => {
    expect(markup).not.toContain('aria-label="Hold"');
    expect(markup).not.toContain('aria-label="Cancel…"');
    expect(markup).not.toContain('aria-label="Copy error"');
  });

  it('makes every row the trigger of its right-click menu, closed until it is used', () => {
    const rows = markup.match(/<li [^>]*data-job-id="[^"]+"[^>]*>/g) ?? [];
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row).toContain('data-state="closed"');
    expect(markup).not.toContain('role="menu"');
  });
});

describe('<JobsList>: Approved, Delivered and Paid rows (DPJobs)', () => {
  const markup = render(<JobsList jobs={DELIVERY_ROW_JOBS} store={newStore()} />);

  it.each([
    ['d3', 'Approved', 'approved', '0:30 · 27 MB'],
    ['d4', 'Approved', 'approved', '0:52 · 31 MB'],
    ['d6', 'Delivered', 'delivered', 'Delivered 19 Oct · ₪40 not paid'],
    ['d7', 'Delivered', 'delivered', 'Delivered 16 Oct · ₪40 not paid'],
    ['d9', 'Paid', 'paid', 'Paid 14 Oct · ₪40'],
    ['d10', 'Paid', 'paid', 'Paid 12 Oct · ₪40'],
  ] as const)(
    '%s: the icon is %s (data-stage %s) and the detail reads "%s"',
    (id, name, stage, text) => {
      const row = rowOf(markup, id);
      expect(iconAttr(row, 'aria-label')).toBe(name);
      expect(iconAttr(row, 'data-status')).toBe('ready');
      expect(iconAttr(row, 'data-stage')).toBe(stage);
      expect(detailOf(row)).toBe(text);
    },
  );

  it.each([
    ['d3', ['Mark delivered']],
    ['d5', ['Mark delivered']],
    ['d6', ['Mark paid…']],
    ['d8', ['Mark paid…']],
    ['d9', []],
    ['d10', []],
  ] as const)('%s has the next step %j, and never Download MP4', (id, expected) => {
    const row = rowOf(markup, id);
    const buttons = [
      ...row.slice(row.indexOf('data-row-actions')).matchAll(/aria-label="([^"]+)"/g),
    ];
    expect(buttons.map((m) => m[1])).toEqual(expected);
    expect(row).not.toContain('Download MP4');
  });

  it('mutes the name of a paid row, and only of a paid row', () => {
    /** The classes of the span that holds the job's name. */
    const nameClasses = (id: string) => {
      const job = DELIVERY_ROW_JOBS.find((candidate) => candidate.id === id);
      return rowOf(markup, id).match(
        new RegExp(`<span dir="auto" class="([^"]*)">${job?.name}<`),
      )?.[1];
    };
    expect(nameClasses('d9')).toContain('text-muted-foreground');
    expect(nameClasses('d10')).toContain('text-muted-foreground');
    for (const id of ['d1', 'd3', 'd6']) {
      expect(nameClasses(id), id).toBeDefined();
      expect(nameClasses(id), id).not.toContain('text-muted-foreground');
    }
  });

  it('keeps every row 44 px high on the same grid, whatever the stage', () => {
    for (const id of ['d3', 'd6', 'd9']) {
      expect(rowOf(markup, id)).toContain(
        'grid h-11 grid-cols-[16px_minmax(0,1fr)_auto_80px_32px]',
      );
    }
  });
});

describe('<JobsList>: the note marker', () => {
  const withNote = (id: string, note: string | null) =>
    CANVAS_JOBS.map((job) => (job.id === id ? { ...job, note } : job));

  it('is not there while the job has no note', () => {
    const markup = html(newStore());
    expect(markup).not.toContain('Your note');
    expect(markup).not.toContain('lucide-message-square-text');
  });

  it('sits right after the name once the job has a note, and before the client', () => {
    const jobs = withNote('j3', 'לפתוח על הצוות, לא על המבנה. עד דקה.');
    const row = rowOf(html(newStore(), jobs), 'j3');
    expect(row).toContain('aria-label="Your note"');
    expect(row).toContain('lucide-message-square-text');
    const name = row.indexOf('סרטון גיוס – Hiring video');
    const marker = row.indexOf('aria-label="Your note"');
    const client = row.indexOf('מאפיית הצפון');
    expect(name).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(name);
    expect(client).toBeGreaterThan(marker);
    // The note itself is in the tooltip, which is not on the page until it opens.
    expect(row).not.toContain('לפתוח על הצוות');
  });

  it('marks only the job that has one', () => {
    const markup = html(newStore(), withNote('j3', 'A note'));
    expect(markup.match(/aria-label="Your note"/g)).toHaveLength(1);
    expect(rowOf(markup, 'j2')).not.toContain('Your note');
  });
});

describe('<JobsList>: names on one left edge', () => {
  const markup = html(newStore());
  const names = [
    ...markup.matchAll(
      /<span dir="auto" class="([^"]*\bbidi\b[^"]*font-medium[^"]*)">([^<]*)<\/span>/g,
    ),
  ];

  it('puts every job name, Hebrew, mixed or English, in the same left-aligned ellipsis Bidi span', () => {
    const texts = names.map((m) => m[2]);
    expect(texts).toContain('פרומו לסוף השבוע');
    expect(texts).toContain('סרטון גיוס – Hiring video');
    expect(texts).toContain('Coach intro reel');
    expect(names).toHaveLength(10);
    expect(new Set(names.map((m) => m[1])).size).toBe(1);
  });

  it('gives every name the same container, which cuts it short before anything else', () => {
    expect(markup.match(/<div class="flex min-w-0 items-center gap-1\.5">/g)).toHaveLength(10);
    // A tooltip with the full name opens while the name is cut off.
    expect(
      markup.match(
        /<div class="min-w-0" data-state="closed" data-slot="tooltip-trigger"><span dir="auto" class="bidi font-medium">/g,
      ),
    ).toHaveLength(10);
  });

  it('puts the client after the name: 13 px, muted, its own direction, never shrunk before the name', () => {
    const clients = [
      ...markup.matchAll(
        /<a [^>]*class="([^"]*)"[^>]*><span dir="auto" class="bidi">([^<]*)<\/span><\/a><\/div><(?:span|button)[^>]*data-slot="job-detail"/g,
      ),
    ];
    expect(clients).toHaveLength(10);
    for (const [, className] of clients) {
      expect(className).toContain('shrink-0');
      expect(className).toContain('text-[13px]');
      expect(className).toContain('text-muted-foreground');
    }
    expect(clients.map((m) => m[2])).toContain('מאפיית הצפון');
    expect(clients.map((m) => m[2])).toContain('Arc Fitness');
  });

  it('lines the name and the client up on one baseline, 10 px apart', () => {
    expect(markup.match(/<div class="flex min-w-0 items-baseline gap-2\.5">/g)).toHaveLength(10);
  });
});

describe('<JobsList>: paging', () => {
  it('shows 10 rows and "1–10 of 12" on the first page', () => {
    const markup = html(newStore());
    expect(rowIds(markup)).toHaveLength(10);
    expect(rangeText(markup)).toBe('1–10 of 12');
  });

  it('page 2 shows rows 11–12 of 12', () => {
    const store = newStore();
    store.getState().setPageIndex(1);
    const markup = html(store);
    expect(rowIds(markup)).toEqual(['j11', 'j12']);
    expect(rowIds(markup)).toEqual(DEFAULT_ORDER.slice(10, 12));
    expect(rangeText(markup)).toBe('11–12 of 12');
  });

  it('disables Previous on the first page and Next on the last', () => {
    const first = html(newStore());
    expect(first).toMatch(/aria-label="Go to previous page" disabled=""/);
    expect(first).not.toMatch(/aria-label="Go to next page" disabled=""/);
    const store = newStore();
    store.getState().setPageIndex(1);
    const last = html(store);
    expect(last).toMatch(/aria-label="Go to next page" disabled=""/);
    expect(last).not.toMatch(/aria-label="Go to previous page" disabled=""/);
  });

  it('marks the current page button', () => {
    const store = newStore();
    store.getState().setPageIndex(1);
    expect(html(store)).toMatch(/aria-label="Go to page 2" aria-current="page"/);
    expect(html(store)).not.toMatch(/aria-label="Go to page 1" aria-current="page"/);
  });

  it('shows the last page when the saved page is past the end (jobs were removed)', () => {
    const store = newStore();
    store.getState().setPageIndex(7);
    const markup = html(store);
    expect(rowIds(markup)).toEqual(['j11', 'j12']);
    expect(rangeText(markup)).toBe('11–12 of 12');
  });

  it('has no pager when 10 jobs or fewer fit on the page', () => {
    for (const count of [1, 5, 10]) {
      const markup = html(newStore(), CANVAS_JOBS.slice(0, count));
      expect(rowIds(markup), `${count} jobs`).toHaveLength(count);
      expect(hasPager(markup), `${count} jobs`).toBe(false);
      expect(rangeText(markup), `${count} jobs`).toBeUndefined();
    }
  });

  it('shows the pager from the 11th job on', () => {
    const markup = html(newStore(), CANVAS_JOBS.slice(0, 11));
    expect(rowIds(markup)).toHaveLength(10);
    expect(hasPager(markup)).toBe(true);
    expect(rangeText(markup)).toBe('1–10 of 11');
  });

  it('has no pager when the tab or the search leave 10 jobs or fewer, however many there are', () => {
    const store = newStore();
    store.getState().setStatusTab('approved');
    const markup = html(store);
    expect(rowIds(markup)).toEqual(['j6', 'j9', 'j10', 'j11', 'j12']);
    expect(hasPager(markup)).toBe(false);
  });

  it('has no pager at all when there are no jobs', () => {
    const markup = html(newStore(), []);
    expect(rowIds(markup)).toEqual([]);
    expect(hasPager(markup)).toBe(false);
    expect(rangeText(markup)).toBeUndefined();
  });
});

describe('<JobsList>: filtering', () => {
  it('shows only the jobs under the status tab', () => {
    const store = newStore();
    store.getState().setStatusTab('attention');
    expect(rowIds(html(store))).toEqual(['j3', 'j7', 'j8']);
    store.getState().setStatusTab('progress');
    expect(rowIds(html(store))).toEqual(['j5', 'j1', 'j2', 'j4']);
    store.getState().setStatusTab('approved');
    expect(rowIds(html(store))).toEqual(['j6', 'j9', 'j10', 'j11', 'j12']);
    // Nothing is delivered or paid on this board.
    store.getState().setStatusTab('delivered');
    expect(rowIds(html(store))).toEqual([]);
    store.getState().setStatusTab('paid');
    expect(rowIds(html(store))).toEqual([]);
  });

  it('puts a ready job under the tab of its stage', () => {
    const store = newStore();
    const board = (tab: 'approved' | 'delivered' | 'paid') => {
      store.getState().setStatusTab(tab);
      // The rows share their time, so their order is not what is under test.
      return rowIds(render(<JobsList jobs={DELIVERY_ROW_JOBS} store={store} />)).sort();
    };
    expect(board('approved')).toEqual(['d3', 'd4', 'd5']);
    expect(board('delivered')).toEqual(['d6', 'd7', 'd8']);
    expect(board('paid')).toEqual(['d10', 'd9']);
  });

  it('filters by job name and client, case-insensitively', () => {
    const store = newStore();
    store.getState().setSearch('ARC');
    expect(rowIds(html(store))).toEqual(['j5', 'j2', 'j10']);
    store.getState().setSearch('tour');
    expect(rowIds(html(store))).toEqual(['j7', 'j10']);
  });

  it('filters Hebrew names and clients', () => {
    const store = newStore();
    store.getState().setSearch('מאפיית');
    expect(rowIds(html(store))).toEqual(['j1', 'j3', 'j12']);
    store.getState().setSearch('גיוס');
    expect(rowIds(html(store))).toEqual(['j3']);
  });

  it('combines the tab and the search', () => {
    const store = newStore();
    store.getState().setStatusTab('approved');
    store.getState().setSearch('arc');
    expect(rowIds(html(store))).toEqual(['j10']);
  });

  it('says so when nothing matches', () => {
    const store = newStore();
    store.getState().setSearch('no such job');
    const markup = html(store);
    expect(rowIds(markup)).toEqual([]);
    expect(markup).toContain('No matching jobs.');
    expect(markup).not.toContain('<ul');
    expect(markup).not.toContain('No jobs yet.');
    expect(hasPager(markup)).toBe(false);
  });

  it('also says so when a tab holds nothing', () => {
    const store = newStore();
    store.getState().setStatusTab('attention');
    const onlyReady = CANVAS_JOBS.filter((job) => job.state === 'ready');
    const markup = html(store, onlyReady);
    expect(markup).toContain('No matching jobs.');
    expect(markup).not.toContain('No jobs yet.');
  });

  it('does not say it for a Hebrew search that finds a job', () => {
    const store = newStore();
    store.getState().setSearch('גיוס');
    const markup = html(store);
    expect(markup).not.toContain('No matching jobs.');
    expect(rowIds(markup)).toEqual(['j3']);
  });
});

describe('<JobsList>: no jobs at all', () => {
  const markup = html(newStore(), []);

  it('says "No jobs yet." and where to drop a folder, in a 160 px block with no border', () => {
    expect(markup).toContain('No jobs yet.');
    expect(markup).toContain('Drop a folder into');
    expect(markup).toContain('Studio Inbox/&lt;Client&gt;/&lt;Job&gt;');
    expect(markup).toContain('to start.');
    expect(markup).toContain('h-40');
    expect(markup).not.toContain('border');
    expect(markup).not.toContain('No matching jobs.');
  });

  it('has no list, no skeleton and no pager', () => {
    expect(rowIds(markup)).toEqual([]);
    expect(markup).not.toContain('<ul');
    expect(markup).not.toContain('data-skeleton-row');
    expect(hasPager(markup)).toBe(false);
  });

  it('stays "No jobs yet." whatever the tab and the search say', () => {
    const store = newStore();
    store.getState().setStatusTab('approved');
    store.getState().setSearch('סרטון');
    const filtered = html(store, []);
    expect(filtered).toContain('No jobs yet.');
    expect(filtered).not.toContain('No matching jobs.');
  });

  it('is not an error even if the query is marked failed', () => {
    const failed = render(<JobsList jobs={[]} failed store={newStore()} />);
    expect(failed).toContain('No jobs yet.');
    expect(failed).not.toContain('Can&#x27;t reach the engine.');
  });
});

describe('<JobsList>: loading', () => {
  // `skeletonDelayMs={0}` draws the skeleton at once: the delay itself is tested below.
  const markup = render(<JobsList jobs={undefined} store={newStore()} skeletonDelayMs={0} />);

  it('shows ten skeleton rows, 44 px high, in the list', () => {
    expect(markup.match(/data-skeleton-row/g)).toHaveLength(10);
    expect(markup).toMatch(/<ul aria-label="Jobs" aria-busy="true"/);
    const rows = markup.match(/<li [\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row).toContain('h-11');
      expect(row).toContain('motion-reduce:animate-none');
    }
    expect(rowIds(markup)).toEqual([]);
  });

  it('tells screen readers once', () => {
    expect((markup.match(/Loading jobs…/g) ?? []).length).toBe(1);
    expect(markup).toContain('role="status"');
  });

  it('has no pager yet, and no empty-state words', () => {
    expect(hasPager(markup)).toBe(false);
    expect(markup).not.toContain('No jobs yet.');
    expect(markup).not.toContain('No matching jobs.');
  });

  it('is not busy once there are jobs', () => {
    expect(html(newStore())).not.toContain('aria-busy');
  });
});

describe('<JobsList>: loading, before the skeleton is due', () => {
  // A fast reload answers before the delay is up, so these first paints are all anyone sees of it.
  const markup = render(<JobsList jobs={undefined} store={newStore()} />);

  it('draws nothing in the list: no skeleton rows, no flash', () => {
    expect(markup).not.toContain('data-skeleton-row');
    expect(markup).not.toContain('data-slot="skeleton"');
    expect(rowIds(markup)).toEqual([]);
  });

  it('still marks the list busy, and has no empty-state words or pager', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('No jobs yet.');
    expect(markup).not.toContain('No matching jobs.');
    expect(hasPager(markup)).toBe(false);
  });
});

describe('<JobsList>: the server cannot be reached', () => {
  const markup = render(<JobsList jobs={undefined} failed store={newStore()} />);

  it('says "Can\'t reach the engine." with a Try again button', () => {
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
  });

  it('is a single 96 px block: no skeletons, no job rows, no pager, no border', () => {
    expect(markup).toContain('h-24');
    expect(markup).not.toContain('data-skeleton-row');
    expect(rowIds(markup)).toEqual([]);
    expect(hasPager(markup)).toBe(false);
    expect(markup).not.toContain('Loading jobs…');
    expect(markup.match(/^<div class="([^"]*)"/)?.[1]).not.toContain('border');
  });

  it('announces itself as an alert', () => {
    expect(markup).toMatch(/<span role="alert">Can&#x27;t reach the engine\.<\/span>/);
  });

  it('leaves a list that has already loaded alone, even if a later fetch failed', () => {
    const loaded = render(<JobsList jobs={CANVAS_JOBS} failed store={newStore()} />);
    expect(rowIds(loaded)).toEqual(DEFAULT_ORDER.slice(0, 10));
    expect(loaded).not.toContain('reach the engine');
    expect(rangeText(loaded)).toBe('1–10 of 12');
  });
});

describe("<JobsList>: one client's jobs (clientId)", () => {
  const ARC = CLIENT_IDS['Arc Fitness'];
  /** `null` is a list that has not arrived. */
  const arcHtml = (store = newStore(), jobs: readonly Job[] | null = CANVAS_JOBS) =>
    render(<JobsList jobs={jobs ?? undefined} store={store} clientId={ARC} skeletonDelayMs={0} />);

  it("lists only that client's jobs, in the list's own order", () => {
    expect(rowIds(arcHtml())).toEqual(['j5', 'j2', 'j10']);
  });

  it("leaves the client's name out of the rows", () => {
    const markup = arcHtml();
    expect(markup).not.toContain('Arc Fitness');
    expect(markup).not.toContain('text-[13px] text-muted-foreground">');
    // The job names are still there, and the Jobs page, over the same jobs, shows the client.
    expect(markup).toContain('Coach intro reel');
    expect(html(newStore())).toContain('Arc Fitness');
  });

  it("does not read the store's status tab or search, which that page has no control for", () => {
    const store = newStore();
    store.getState().setStatusTab('approved');
    store.getState().setSearch('zzz');
    expect(rowIds(arcHtml(store))).toEqual(['j5', 'j2', 'j10']);
    expect(rowIds(html(store))).toEqual([]);
  });

  it('has the same rows, icons and details as the Jobs page', () => {
    const row = rowOf(arcHtml(), 'j5');
    expect(iconAttr(row, 'data-status')).toBe('editing');
    expect(detailOf(row)).toBe('Cut · graphics 2/5 · ~4 min left');
  });

  it('has no pager for three jobs', () => {
    expect(hasPager(arcHtml())).toBe(false);
  });

  it('pages its own jobs, ten a page', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeJob({
        id: `big${i}`,
        client: 'Big Co',
        clientId: 'b1b1b1b1b1b1',
        name: `Promo ${i}`,
        relPath: `Big Co/Promo ${i}`,
        updatedAt: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
      }),
    );
    const markup = render(
      <JobsList jobs={[...many, ...CANVAS_JOBS]} store={newStore()} clientId="b1b1b1b1b1b1" />,
    );
    expect(rowIds(markup)).toHaveLength(10);
    expect(rangeText(markup)).toBe('1–10 of 12');
  });

  it('says "No jobs yet." for a client the list has no job of', () => {
    const others = CANVAS_JOBS.filter((job) => job.client !== 'Arc Fitness');
    const markup = arcHtml(newStore(), others);
    expect(markup).toContain('No jobs yet.');
    expect(markup).not.toContain('No matching jobs.');
  });

  it('draws skeleton rows while the list loads', () => {
    const markup = arcHtml(newStore(), null);
    expect(markup.match(/data-skeleton-row/g)).toHaveLength(10);
  });
});
