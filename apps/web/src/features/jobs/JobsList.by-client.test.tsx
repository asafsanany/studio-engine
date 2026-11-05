// View › By client on the Jobs page: each client's jobs sit one step in under a header with its
// name, the count and a link to its page, joined to the rows by a tree line. All of the jobs are on
// one page, so there is no pager; the client's name is left out of the rows; a client's own page
// stays flat.
//
// The board's twelve jobs, by client: Arc Fitness j5 j2 j10, מאפיית הצפון j1 j3 j12, מרפאת מירה
// j4 j9, טל נכסים j7 j11 and Kova Coffee j6 j8, the clients by their newest job.

import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { createTestQueryClient } from '@/data/test-utils';
import type { JobsUiStore } from '@/stores/jobs-ui';
import { byClientOrder } from './by-client';
import { JobsList } from './JobsList';
import { lastUpdatedOrder } from './sorting';
import { CANVAS_JOBS, CLIENT_IDS, createTestStore } from './test-jobs';

// Links are plain anchors: these tests render without a router.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const render = (store: StoreApi<JobsUiStore>, clientId?: string, jobs = CANVAS_JOBS) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <JobsList jobs={jobs} store={store} clientId={clientId} />
    </QueryClientProvider>,
  );

const storeWith = (state: { byClient?: boolean; search?: string; showArchived?: boolean }) => {
  const store = createTestStore();
  if (state.byClient) store.getState().setByClient(true);
  if (state.search) store.getState().setSearch(state.search);
  if (state.showArchived) store.getState().setShowArchived(true);
  return store;
};

/** The board's jobs in the order of the list, then client by client. */
const BY_CLIENT = byClientOrder(lastUpdatedOrder(CANVAS_JOBS));

const rowIds = (markup: string) =>
  [...markup.matchAll(/<li [^>]*data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The sections (one per client) of the markup: the client's name and its markup. */
function sectionsOf(markup: string) {
  return [...markup.matchAll(/<section aria-label="([^"]*)">([\s\S]*?)<\/section>/g)].map((m) => ({
    client: m[1] ?? '',
    markup: m[2] ?? '',
  }));
}

/** The `<li>` of one job's row. */
function rowOf(markup: string, id: string): string {
  const row = markup.match(new RegExp(`<li [^>]*data-job-id="${id}"[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

const classOf = (tag: string) => tag.match(/class="([^"]*)"/)?.[1] ?? '';
const treeLines = (row: string) => row.match(/<span [^>]*data-tree-line=""[^>]*>/g) ?? [];

describe('<JobsList>: By client off', () => {
  it('is the flat list: one ul, no sections, the client in each row', () => {
    const markup = render(storeWith({}));
    expect(sectionsOf(markup)).toEqual([]);
    expect(markup).toContain('<ul aria-label="Jobs"');
    expect(markup).not.toContain('data-tree=');
    expect(markup).toContain('מאפיית הצפון');
  });
});

describe('<JobsList>: By client on', () => {
  const store = () => storeWith({ byClient: true });

  it('has a section for each client, in order of their latest activity', () => {
    const markup = render(store());
    expect(sectionsOf(markup).map((section) => section.client)).toEqual([
      'Arc Fitness',
      'מאפיית הצפון',
      'מרפאת מירה',
      'טל נכסים',
      'Kova Coffee',
    ]);
  });

  it('lists the rows client by client', () => {
    expect(rowIds(render(store()))).toEqual(BY_CLIENT.map((job) => job.id));
  });

  it('puts all of the jobs on one page: all 12 rows, no pager', () => {
    const markup = render(store());
    expect(rowIds(markup)).toHaveLength(12);
    expect(markup).not.toContain('aria-label="pagination"');
  });

  it('names each list after its client and puts the jobs of the client in it', () => {
    const markup = render(store());
    const arc = sectionsOf(markup).find((section) => section.client === 'Arc Fitness');
    expect(arc?.markup).toContain('<ul aria-label="Jobs of Arc Fitness"');
    expect(rowIds(arc?.markup ?? '')).toEqual(['j5', 'j2', 'j10']);
  });

  it('draws a header per client with its name, a link to its page and how many jobs it has', () => {
    const markup = render(store());
    const mirra = sectionsOf(markup).find((section) => section.client === 'מאפיית הצפון');
    const header = mirra?.markup.match(/^[\s\S]*?<ul /)?.[0] ?? '';
    expect(header).toContain('<a href="/"');
    expect(header).toContain('<bdi>מאפיית הצפון</bdi>');
    expect(header).toMatch(/tabular-nums[^>]*>3<\/span>/);
    expect(classOf(header.match(/<div class="[^"]*">/)?.[0] ?? '')).toContain('h-10');
  });

  it('leaves the client out of the rows: the header says it', () => {
    const markup = render(store());
    for (const section of sectionsOf(markup)) {
      const rows = section.markup.slice(section.markup.indexOf('<ul '));
      expect(rows, section.client).not.toContain('<a href="/"');
      expect(rows, section.client).not.toContain(`<bdi>${section.client}</bdi>`);
    }
  });

  it('marks the rows of a client as first, middle and last, or only', () => {
    const markup = render(store());
    expect(rowOf(markup, 'j5')).toContain('data-tree="first"');
    expect(rowOf(markup, 'j2')).toContain('data-tree="middle"');
    expect(rowOf(markup, 'j10')).toContain('data-tree="last"');
    // A search that leaves Arc Fitness one job.
    const alone = render(storeWith({ byClient: true, search: 'coach' }));
    expect(rowOf(alone, 'j5')).toContain('data-tree="only"');
  });

  it('sets a row one step in and joins it to its client with an elbow', () => {
    const markup = render(store());
    const row = rowOf(markup, 'j5');
    const li = row.match(/<li [^>]*>/)?.[0] ?? '';
    expect(classOf(li)).toContain('pl-10');
    expect(classOf(li)).not.toContain('pl-3');
    expect(classOf(li)).toContain('relative');
    expect(classOf(li)).toContain('h-11');
    expect(classOf(treeLines(row)[0] ?? '')).toContain('rounded-bl-[7px]');
  });

  it('carries the line on below every row but the last of a client', () => {
    const markup = render(store());
    // The first and the middle: an elbow and the line on. The last, and the only: the elbow alone.
    expect(treeLines(rowOf(markup, 'j5'))).toHaveLength(2);
    expect(treeLines(rowOf(markup, 'j2'))).toHaveLength(2);
    expect(treeLines(rowOf(markup, 'j10'))).toHaveLength(1);
    const alone = render(storeWith({ byClient: true, search: 'coach' }));
    expect(treeLines(rowOf(alone, 'j5'))).toHaveLength(1);
  });

  it('bridges the 2 px between two rows with the line', () => {
    const markup = render(store());
    expect(classOf(treeLines(rowOf(markup, 'j5'))[1] ?? '')).toContain('-bottom-0.5');
  });

  it('draws the line under the avatar down to the first row, only when the client has a job', () => {
    const markup = render(store());
    for (const section of sectionsOf(markup)) {
      const header = section.markup.match(/^[\s\S]*?<ul /)?.[0] ?? '';
      expect(header, section.client).toContain('border-l');
      expect(header, section.client).toContain('left-[23.5px]');
    }
  });

  it('does not fade the tree line of an archived row with the rest of it', () => {
    const markup = render(storeWith({ byClient: true, showArchived: true }), undefined, [
      ...CANVAS_JOBS,
      { ...(CANVAS_JOBS[0] as Job), id: 'old', archivedAt: '2026-10-21T12:00:00.000Z' },
    ]);
    const li = rowOf(markup, 'old').match(/<li [^>]*>/)?.[0] ?? '';
    expect(li).toContain('data-archived');
    expect(classOf(li)).toContain(':not([data-tree-line])');
  });

  it('groups the jobs the search leaves, and a client with none has no section', () => {
    const markup = render(storeWith({ byClient: true, search: 'coach' }));
    expect(sectionsOf(markup).map((section) => section.client)).toEqual(['Arc Fitness']);
    expect(rowIds(markup)).toEqual(['j5']);
  });

  it('says so when nothing matches, with no section', () => {
    const markup = render(storeWith({ byClient: true, search: 'zzzz' }));
    expect(markup).toContain('No matching jobs.');
    expect(sectionsOf(markup)).toEqual([]);
  });

  it('says "No jobs yet." with no jobs at all', () => {
    const markup = render(store(), undefined, []);
    expect(markup).toContain('No jobs yet.');
    expect(sectionsOf(markup)).toEqual([]);
  });

  it("keeps a client's own page flat, with the 'By client' switch on", () => {
    const markup = render(store(), CLIENT_IDS['Arc Fitness']);
    expect(sectionsOf(markup)).toEqual([]);
    expect(markup).not.toContain('data-tree=');
    expect(rowIds(markup)).toEqual(['j5', 'j2', 'j10']);
  });
});
