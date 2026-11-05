// CVP-197: archived jobs in the list. Off (how it starts), they are in no tab and no page; on, they
// sit in the list, faded, with the small box after the client. Under the list, a quiet line offers
// them: after a search on the Jobs page, and always on a client's page.

import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { createTestQueryClient } from '@/data/test-utils';
import type { JobsUiStore, StatusTab } from '@/stores/jobs-ui';
import { textOf } from './cells/test-helpers';
import { JobsList } from './JobsList';
import { ARCHIVE_CLIENT_IDS, ARCHIVE_JOBS } from './test-archive-jobs';
import { createTestStore } from './test-jobs';

// Rows link the client's name to its page; these tests render without a router, so a link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const render = (
  store: StoreApi<JobsUiStore>,
  jobs: readonly Job[] | undefined = ARCHIVE_JOBS,
  clientId?: string,
) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <JobsList jobs={jobs} store={store} clientId={clientId} />
    </QueryClientProvider>,
  );

const storeWith = (state: { showArchived?: boolean; search?: string; tab?: StatusTab }) => {
  const store = createTestStore();
  if (state.showArchived) store.getState().setShowArchived(true);
  if (state.search) store.getState().setSearch(state.search);
  if (state.tab) store.getState().setStatusTab(state.tab);
  return store;
};

const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);
const hasPager = (markup: string) => markup.includes('aria-label="pagination"');

/** The `<li>` of one job's row. */
function rowOf(markup: string, id: string): string {
  const row = markup.match(new RegExp(`<li [^>]*data-job-id="${id}"[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

/** The button under the list that offers or hides the archive, or `undefined`. */
const archivedLine = (markup: string) => {
  const button = markup
    .match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g)
    ?.find((b) => /archived/i.test(textOf(b)));
  return button === undefined ? undefined : textOf(button);
};

describe('<JobsList>: Show archived off', () => {
  it('lists only the jobs that are not archived', () => {
    const ids = rowIds(render(storeWith({})));
    expect(ids).toHaveLength(7);
    expect(ids.some((id) => id?.startsWith('archived'))).toBe(false);
  });

  it('keeps archived jobs out of the tab as well: Paid shows the two paid jobs, not the five', () => {
    expect(rowIds(render(storeWith({ tab: 'paid' })))).toEqual(['paid-1', 'paid-2']);
  });

  it('has no pager for seven jobs, and no mark and no faded row anywhere', () => {
    const markup = render(storeWith({}));
    expect(markup).not.toContain('aria-label="pagination"');
    expect(markup).not.toContain('aria-label="Archived"');
    expect(markup).not.toContain('data-archived=""');
  });

  it('pages without them: twelve jobs, but two pages only when the archived ones count', () => {
    expect(hasPager(render(storeWith({})))).toBe(false);
    const on = render(storeWith({ showArchived: true }));
    expect(hasPager(on)).toBe(true);
    expect(on).toContain('1–10 of 12');
  });

  it('says "No matching jobs." for a list of only archived jobs, not "No jobs yet."', () => {
    const onlyArchived = ARCHIVE_JOBS.filter((job) => job.archivedAt !== null);
    const markup = render(storeWith({}), onlyArchived);
    expect(markup).toContain('No matching jobs.');
    expect(markup).not.toContain('No jobs yet.');
  });

  it('still says "No jobs yet." for a list with nothing in it', () => {
    expect(render(storeWith({}), [])).toContain('No jobs yet.');
  });
});

describe('<JobsList>: Show archived on', () => {
  const markup = render(storeWith({ showArchived: true }));

  it('puts the archived jobs in the list with the others, in the order of the last update', () => {
    expect(rowIds(markup)).toEqual([
      'editing-1',
      'review-1',
      'failed-1',
      'approved-1',
      'delivered-1',
      'paid-1',
      'paid-2',
      'archived-cancelled',
      'archived-paid-1',
      'archived-paid-2',
    ]);
  });

  it('puts them in their usual tab: Paid shows all five', () => {
    expect(rowIds(render(storeWith({ showArchived: true, tab: 'paid' })))).toEqual([
      'paid-1',
      'paid-2',
      'archived-paid-1',
      'archived-paid-2',
      'archived-paid-3',
    ]);
  });

  it('marks an archived row (data-archived) and no other', () => {
    expect(rowOf(markup, 'archived-paid-1')).toContain('data-archived=""');
    expect(rowOf(markup, 'archived-cancelled')).toContain('data-archived=""');
    expect(rowOf(markup, 'paid-1')).not.toContain('data-archived=""');
    expect(rowOf(markup, 'editing-1')).not.toContain('data-archived=""');
  });

  it('fades everything in an archived row but its last cell, the next-step button, to 55%', () => {
    const row = rowOf(markup, 'archived-paid-1');
    // The tree line of the By client view is not a cell and keeps its colour.
    expect(row).toContain(
      '[&amp;[data-archived]:not([data-sheet-open])&gt;:not(:last-child):not([data-tree-line])]:opacity-55',
    );
    // The next-step cell is the last child of the row, so it is the one that is not faded.
    expect(row.lastIndexOf('data-row-actions=')).toBeGreaterThan(row.indexOf('<time'));
    expect(row.trimEnd().endsWith('</div></li>')).toBe(true);
    expect(row.slice(row.lastIndexOf('<div'))).toContain('data-row-actions="archived-paid-1"');
  });

  it('has the 14 px box after the client, named "Archived"', () => {
    const row = rowOf(markup, 'archived-paid-1');
    const marker = row.match(/<span[^>]*aria-label="Archived"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? '';
    expect(marker).toContain('role="img"');
    expect(marker).toContain('lucide-archive');
    expect(marker).toContain('width="14"');
    expect(marker).toContain('height="14"');
    // The client's name comes first; the box is after it.
    expect(row.indexOf('עו״ד דוד לוי')).toBeGreaterThan(0);
    expect(row.indexOf('עו״ד דוד לוי')).toBeLessThan(row.indexOf('aria-label="Archived"'));
  });

  it('puts the box on the archived rows only: the three of the first page', () => {
    expect(markup.match(/aria-label="Archived"/g)).toHaveLength(3);
    expect(rowOf(markup, 'paid-1')).not.toContain('aria-label="Archived"');
  });

  it('offers no Mark paid… on an archived delivered video (archived means paid or not needed)', () => {
    const delivered = render(storeWith({ showArchived: true, tab: 'delivered' }));
    expect(rowIds(delivered)).toEqual(['delivered-1', 'archived-delivered']);
    expect(rowOf(delivered, 'delivered-1')).toContain('aria-label="Mark paid…"');
    expect(rowOf(delivered, 'archived-delivered')).not.toContain('aria-label="Mark paid…"');
  });

  it('keeps its detail: an archived paid video still says when it was paid', () => {
    expect(textOf(rowOf(markup, 'archived-paid-1'))).toContain('Paid 6 Oct · ₪40');
  });
});

describe('<JobsList>: the search hint', () => {
  it('offers the archive after a search that archived jobs match: "2 more archived · Show"', () => {
    const markup = render(storeWith({ search: 'rgm' }));
    expect(rowIds(markup)).toEqual(['approved-1', 'delivered-1', 'paid-1']);
    expect(archivedLine(markup)).toBe('2 more archived · Show');
  });

  it('says "N archived · Show" when the search matched nothing else', () => {
    const markup = render(storeWith({ search: 'טיוטה' }));
    expect(rowIds(markup)).toEqual([]);
    expect(markup).toContain('No matching jobs.');
    expect(archivedLine(markup)).toBe('1 archived · Show');
  });

  it('counts the archived jobs of the current tab only', () => {
    expect(archivedLine(render(storeWith({ search: 'rgm', tab: 'paid' })))).toBe(
      '1 more archived · Show',
    );
  });

  it('is under the list and before the pager', () => {
    const markup = render(storeWith({ search: 'מיתוס' }));
    expect(markup.indexOf('</ul>')).toBeLessThan(markup.indexOf('archived · Show'));
  });

  it('is a ghost button with the box icon, muted 13 px text, at the left', () => {
    const markup = render(storeWith({ search: 'rgm' }));
    const button =
      markup.match(
        /<button[^>]*data-slot="button"[^>]*>(?:(?!<\/button>)[\s\S])*archived · Show<\/button>/,
      )?.[0] ?? '';
    expect(button).toContain('data-variant="ghost"');
    expect(button).toContain('lucide-archive');
    expect(button).toContain('text-[13px]');
    expect(button).toContain('text-muted-foreground');
    expect(button).toContain('self-start');
    expect(button).toContain('type="button"');
  });

  it('is not there without a word typed', () => {
    expect(archivedLine(render(storeWith({})))).toBeUndefined();
    expect(archivedLine(render(storeWith({ search: '   ' })))).toBeUndefined();
  });

  it('is not there when no archived job matches', () => {
    expect(archivedLine(render(storeWith({ search: 'סיור' })))).toBeUndefined();
  });

  it('is not there once Show archived is on: the archived rows are in the list', () => {
    const markup = render(storeWith({ search: 'rgm', showArchived: true }));
    expect(archivedLine(markup)).toBeUndefined();
    expect(rowIds(markup)).toContain('archived-paid-2');
  });
});

describe('<JobsList>: a client’s page', () => {
  const MOSHE = ARCHIVE_CLIENT_IDS['עו״ד דוד לוי'];
  const MOSHE_LIVE = ['editing-1', 'paid-2'];

  it('lists only the client’s jobs that are not archived, with a quiet "3 archived · Show"', () => {
    const markup = render(storeWith({}), ARCHIVE_JOBS, MOSHE);
    expect(rowIds(markup)).toEqual(MOSHE_LIVE);
    expect(archivedLine(markup)).toBe('2 archived · Show');
  });

  it('adds the archived rows, faded, once the switch is on, and the line reads "Hide archived"', () => {
    const markup = render(storeWith({ showArchived: true }), ARCHIVE_JOBS, MOSHE);
    expect(rowIds(markup)).toEqual([
      'editing-1',
      'paid-2',
      'archived-paid-1',
      'archived-delivered',
    ]);
    expect(rowOf(markup, 'archived-paid-1')).toContain('data-archived=""');
    expect(archivedLine(markup)).toBe('Hide archived');
  });

  it('leaves the client’s name out of the rows, as before', () => {
    const markup = render(storeWith({ showArchived: true }), ARCHIVE_JOBS, ARCHIVE_CLIENT_IDS.RGM);
    expect(rowOf(markup, 'archived-cancelled')).not.toContain('>RGM<');
  });

  it('says nothing for a client with nothing archived, switch on or off', () => {
    const lakeshoreOnly = ARCHIVE_JOBS.filter(
      (job) => job.client === 'LAKESHORE' && job.archivedAt !== null,
    );
    const clean = ARCHIVE_JOBS.filter((job) => job.archivedAt === null);
    expect(archivedLine(render(storeWith({}), clean, MOSHE))).toBeUndefined();
    expect(archivedLine(render(storeWith({ showArchived: true }), clean, MOSHE))).toBeUndefined();
    expect(lakeshoreOnly).toHaveLength(1);
  });

  it('ignores the status tab and the search, like the rest of the page', () => {
    const markup = render(storeWith({ search: 'zzz', tab: 'paid' }), ARCHIVE_JOBS, MOSHE);
    expect(rowIds(markup)).toEqual(MOSHE_LIVE);
    expect(archivedLine(markup)).toBe('2 archived · Show');
  });

  it('is the same switch as the Jobs page’s: turn it on in the store and the client’s page follows', () => {
    const store = storeWith({});
    expect(archivedLine(render(store, ARCHIVE_JOBS, MOSHE))).toBe('2 archived · Show');
    store.getState().setShowArchived(true);
    expect(archivedLine(render(store, ARCHIVE_JOBS, MOSHE))).toBe('Hide archived');
  });
});
