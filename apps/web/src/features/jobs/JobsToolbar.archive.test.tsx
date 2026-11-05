// CVP-197: Show archived in the toolbar: the tab counts follow the switch, and the View menu
// that holds it sits left of the search.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import type { JobsUiStore } from '@/stores/jobs-ui';
import { JobsToolbar } from './JobsToolbar';
import { CANVAS_JOBS, createTestStore } from './test-jobs';

const toolbar = (store: StoreApi<JobsUiStore>, jobs: Parameters<typeof JobsToolbar>[0]['jobs']) =>
  renderToStaticMarkup(<JobsToolbar jobs={jobs} store={store} />);

/** The count after each tab's name, in the order of the tabs. */
const countsOf = (markup: string) =>
  [...markup.matchAll(/data-slot="tabs-trigger-count"[^>]*>([^<]*)</g)].map((m) => m[1]);

const ARCHIVED_AT = '2026-10-23T08:00:00.000Z';
const paid = {
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
} as const;

/** A paid job, an approved one and a failed one, and a paid one and a failed one that are archived. */
const WITH_ARCHIVED = [
  makeJob({ id: 'paid', ...paid }),
  makeJob({ id: 'paid-archived', ...paid, archivedAt: ARCHIVED_AT }),
  makeJob({ id: 'approved', state: 'ready', placeInLine: null }),
  makeJob({ id: 'failed', state: 'failed', placeInLine: null, failedAt: 8, error: 'boom' }),
  makeJob({
    id: 'failed-archived',
    state: 'failed',
    placeInLine: null,
    failedAt: 8,
    error: 'boom',
    archivedAt: ARCHIVED_AT,
  }),
];

describe('<JobsToolbar>: Show archived and the tab counts', () => {
  // All, In progress, Review, Approved, Delivered, Uploaded, Paid, Needs attention
  it('leaves archived jobs out of every tab and out of All while the switch is off', () => {
    expect(countsOf(toolbar(createTestStore(), WITH_ARCHIVED))).toEqual([
      '3',
      '0',
      '0',
      '1',
      '0',
      '0',
      '1',
      '1',
    ]);
  });

  it('counts them in their usual tab, and in All, once the switch is on', () => {
    const store = createTestStore();
    store.getState().setShowArchived(true);
    expect(countsOf(toolbar(store, WITH_ARCHIVED))).toEqual([
      '5',
      '0',
      '0',
      '1',
      '0',
      '0',
      '2',
      '2',
    ]);
  });

  it('follows the switch when another part of the page turns it (the line under the list)', () => {
    const store = createTestStore();
    store.getState().setShowArchived(true);
    store.getState().setShowArchived(false);
    expect(countsOf(toolbar(store, WITH_ARCHIVED))).toEqual([
      '3',
      '0',
      '0',
      '1',
      '0',
      '0',
      '1',
      '1',
    ]);
  });

  it('does not change the counts of a list with nothing archived', () => {
    const off = countsOf(toolbar(createTestStore(), CANVAS_JOBS));
    const store = createTestStore();
    store.getState().setShowArchived(true);
    expect(countsOf(toolbar(store, CANVAS_JOBS))).toEqual(off);
  });
});

describe('<JobsToolbar>: the View menu', () => {
  const view = (markup: string) =>
    markup.match(/<button[^>]*aria-haspopup="menu"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

  it('is a ghost button named View, with the sliders icon, in the 32 px row of the tabs', () => {
    const button = view(toolbar(createTestStore(), CANVAS_JOBS));
    expect(button).toContain('data-variant="ghost"');
    expect(button).toContain('data-size="sm"');
    expect(button).toContain('lucide-settings-2');
    expect(button.replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '')).toBe('View');
  });

  it('keeps the icon out of the accessible name', () => {
    expect(view(toolbar(createTestStore(), CANVAS_JOBS))).toContain('aria-hidden="true"');
  });

  it('starts closed: the menu and its item are not in the page until it is opened', () => {
    const markup = toolbar(createTestStore(), CANVAS_JOBS);
    expect(view(markup)).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Show archived');
  });

  it('fades its background in and out like the other ghost buttons: 150 ms, ease-in-out', () => {
    const button = view(toolbar(createTestStore(), CANVAS_JOBS));
    expect(button).toContain('duration-150');
    expect(button).toContain('ease-in-out');
  });
});
