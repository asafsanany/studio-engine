// The Jobs list with the job sheet on and off: what its rows do about it. A row's click, Enter and
// the arrow keys act on the page (they are covered by row-open.test.ts, row-focus.test.ts and
// the browser); here is what the rows are made of, which is all a server render can show.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { setOpenJobSheetId } from '@/features/job-sheet/job-sheet-open';
import { JobsList } from './JobsList';
import { CANVAS_JOBS, createTestStore } from './test-jobs';

afterEach(() => {
  setOpenJobSheetId(null);
});

/** The list on a page of the app, with the Job sheet switch (and Draft & chat) as asked. */
async function listWith(sheet: boolean, draftChat = false): Promise<string> {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.0.0',
    settleMs: 60_000,
    series: false,
    jobSheet: sheet,
    draftChat,
  });
  const store = createTestStore();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <JobsList jobs={CANVAS_JOBS} store={store} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/jobs', '/clients/$clientId'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/jobs'] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The `<li>` tags of the rows, in order. */
const rowTags = (markup: string) => markup.match(/<li [^>]*data-job-id="[^"]*"[^>]*>/g) ?? [];
const tabIndexOf = (tag: string) => tag.match(/tabindex="(-?\d+)"/)?.[1];
const idOf = (tag: string) => tag.match(/data-job-id="([^"]*)"/)?.[1];

describe('the list with the job sheet off', () => {
  it('is today’s: every row is -1 (not reached by Tab), none is a pointer, none is marked open', async () => {
    const tags = rowTags(await listWith(false));
    expect(tags).toHaveLength(10);
    for (const tag of tags) {
      expect(tabIndexOf(tag), tag).toBe('-1');
      expect(tag).not.toContain('cursor-pointer');
      expect(tag).not.toContain('data-sheet-open=');
    }
  });

  it('leaves a row marked open alone: nothing is open without the switch', async () => {
    setOpenJobSheetId('j5');
    for (const tag of rowTags(await listWith(false))) {
      expect(tag).not.toContain('cursor-pointer');
    }
  });
});

describe('the list with the job sheet on', () => {
  it('is one Tab stop: the first row is 0 and the others -1', async () => {
    const tags = rowTags(await listWith(true));
    expect(tags).toHaveLength(10);
    expect(tags.map(tabIndexOf)).toEqual(['0', ...Array(9).fill('-1')]);
  });

  it('shows the pointer on every row', async () => {
    for (const tag of rowTags(await listWith(true))) expect(tag).toContain('cursor-pointer');
  });

  it('opens the open job under its row: a card with the panel on a second line of its grid', async () => {
    const markup = await listWith(true);
    const first = idOf(rowTags(markup)[0] ?? '') ?? '';
    setOpenJobSheetId(first);
    const opened = await listWith(true);
    const open = rowTags(opened).filter((tag) => tag.includes('data-sheet-open=""'));
    expect(open.map(idOf)).toEqual([first]);
    expect(open[0]).toContain('grid-rows-[44px_auto]');
    expect(open[0]).toContain('shadow-[0_0_0_1px_rgba(255,255,255,0.1)]');
    expect(open[0]).toContain('my-1.5');
    // No hover background of its own: the card's fill stays.
    expect(open[0]).toContain('hover:bg-[#111113]');
    expect(opened.match(/data-slot="job-row-panel"/g)).toHaveLength(1);
    const row = opened.slice(opened.indexOf(`data-job-id="${first}"`));
    expect(row.indexOf('data-slot="job-row-panel"')).toBeLessThan(row.indexOf('</li>'));
  });

  it('marks no row when no sheet is open', async () => {
    for (const tag of rowTags(await listWith(true))) {
      expect(tag).not.toContain('data-sheet-open=""');
    }
  });

  it('keeps the rows’ right-click menus and everything else in the row', async () => {
    const markup = await listWith(true);
    expect(markup.match(/data-slot="context-menu-trigger"/g)).toHaveLength(10);
    expect(markup.match(/data-row-actions=/g)).toHaveLength(10);
  });
});

describe('the list with Draft & chat on', () => {
  it('opens the chat from a row in Review, waiting in line or running, even with the sheet off', async () => {
    const chatRows = CANVAS_JOBS.filter((job) =>
      ['review', 'queued', 'editing'].includes(job.state),
    );
    expect(chatRows.length).toBeGreaterThan(0);
    const pointers = rowTags(await listWith(false, true)).filter((tag) =>
      tag.includes('cursor-pointer'),
    );
    expect(pointers.map(idOf).sort()).toEqual(chatRows.map((job) => job.id).sort());
  });
});
