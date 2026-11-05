import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { makeJob } from '@/data/test-utils';
import type { JobsUiStore } from '@/stores/jobs-ui';
import { JobsToolbar, TAB_LABELS } from './JobsToolbar';
import { CANVAS_JOBS, createTestStore, DELIVERY_ROW_JOBS } from './test-jobs';

const toolbar = (store: StoreApi<JobsUiStore>, jobs: Parameters<typeof JobsToolbar>[0]['jobs']) =>
  renderToStaticMarkup(<JobsToolbar jobs={jobs} store={store} />);

interface RenderedTab {
  label: string;
  count: string | undefined;
  selected: string | undefined;
  attrs: string;
}

/** The status tabs of the markup: name, count and aria-selected. */
function tabsOf(markup: string): RenderedTab[] {
  return [...markup.matchAll(/<button([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const count = inner.match(/data-slot="tabs-trigger-count"[^>]*>([^<]*)</)?.[1];
    return {
      label: inner.replace(/<span[\s\S]*$/, '').trim(),
      count,
      selected: attrs.match(/aria-selected="([^"]*)"/)?.[1],
      attrs,
    };
  });
}

describe('<JobsToolbar>: status tabs', () => {
  it('shows All, In progress, Review, Approved, Delivered, Uploaded, Paid and Needs attention, in that order', () => {
    const tabs = tabsOf(toolbar(createTestStore(), CANVAS_JOBS));
    expect(tabs.map((t) => t.label)).toEqual([
      'All',
      'In progress',
      'Review',
      'Approved',
      'Delivered',
      'Uploaded',
      'Paid',
      'Needs attention',
    ]);
    expect(Object.values(TAB_LABELS)).toEqual(tabs.map((t) => t.label));
  });

  it('puts the count of each tab after its name', () => {
    const tabs = tabsOf(toolbar(createTestStore(), CANVAS_JOBS));
    // 12 jobs: arriving + 2 queued + editing in progress; none in review; 5 ready (all approved);
    // held, failed, cancelled.
    expect(tabs.map((t) => t.count)).toEqual(['12', '4', '0', '5', '0', '0', '0', '3']);
  });

  it('counts the Approved, Delivered, Uploaded and Paid tabs by the stage of the ready jobs', () => {
    const tabs = tabsOf(toolbar(createTestStore(), DELIVERY_ROW_JOBS));
    expect(tabs.map((t) => t.count)).toEqual(['10', '1', '1', '3', '3', '0', '2', '0']);
  });

  it('counts the whole list: neither the search nor the selected tab changes the numbers', () => {
    const store = createTestStore();
    store.getState().setSearch('coach');
    store.getState().setStatusTab('approved');
    expect(tabsOf(toolbar(store, CANVAS_JOBS)).map((t) => t.count)).toEqual([
      '12',
      '4',
      '0',
      '5',
      '0',
      '0',
      '0',
      '3',
    ]);
  });

  it('counts the jobs it is given', () => {
    const jobs = [makeJob({ id: 'a', state: 'ready' }), makeJob({ id: 'b', state: 'failed' })];
    expect(tabsOf(toolbar(createTestStore(), jobs)).map((t) => t.count)).toEqual([
      '2',
      '0',
      '0',
      '1',
      '0',
      '0',
      '0',
      '1',
    ]);
  });

  it('counts a job in review on the Review tab', () => {
    const jobs = [makeJob({ id: 'a', state: 'review', step: 7, placeInLine: null })];
    expect(tabsOf(toolbar(createTestStore(), jobs)).map((t) => t.count)).toEqual([
      '1',
      '0',
      '1',
      '0',
      '0',
      '0',
      '0',
      '0',
    ]);
  });

  it('leaves the counts out until the list has loaded, rather than showing zeros', () => {
    const tabs = tabsOf(toolbar(createTestStore(), undefined));
    expect(tabs.map((t) => t.label)).toEqual([
      'All',
      'In progress',
      'Review',
      'Approved',
      'Delivered',
      'Uploaded',
      'Paid',
      'Needs attention',
    ]);
    expect(tabs.map((t) => t.count)).toEqual(Array(8).fill(undefined));
  });

  it('marks the store’s tab as selected: All at first', () => {
    expect(tabsOf(toolbar(createTestStore(), CANVAS_JOBS)).map((t) => t.selected)).toEqual([
      'true',
      ...Array(7).fill('false'),
    ]);
  });

  it('follows the store when another part of the page changes the tab (the header summary)', () => {
    const store = createTestStore();
    store.getState().setStatusTab('attention');
    const selected = () => tabsOf(toolbar(store, CANVAS_JOBS)).map((t) => t.selected);
    const only = (index: number) => Array.from({ length: 8 }, (_, i) => String(i === index));
    expect(selected()).toEqual(only(7));
    store.getState().setStatusTab('review');
    expect(selected()).toEqual(only(2));
    store.getState().setStatusTab('progress');
    expect(selected()).toEqual(only(1));
    store.getState().setStatusTab('delivered');
    expect(selected()).toEqual(only(4));
    store.getState().setStatusTab('uploaded');
    expect(selected()).toEqual(only(5));
  });

  it('names the tab list for screen readers', () => {
    expect(toolbar(createTestStore(), CANVAS_JOBS)).toMatch(
      /<div[^>]*role="tablist"[^>]*aria-label="Filter by status"/,
    );
  });

  it('does not point the tabs at a panel that does not exist', () => {
    for (const tab of tabsOf(toolbar(createTestStore(), CANVAS_JOBS))) {
      expect(tab.attrs).not.toContain('aria-controls');
    }
  });
});

describe('<JobsToolbar>: search', () => {
  const searchInput = (markup: string) => markup.match(/<input[^>]*type="search"[^>]*>/)?.[0] ?? '';

  it('is a search input with the placeholder "Search"', () => {
    const input = searchInput(toolbar(createTestStore(), CANVAS_JOBS));
    expect(input).toContain('type="search"');
    expect(input).toContain('placeholder="Search"');
  });

  it('has a label for screen readers that points at the input', () => {
    const markup = toolbar(createTestStore(), CANVAS_JOBS);
    const id = searchInput(markup).match(/ id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`<label for="${id}" class="sr-only">Search</label>`);
  });

  it('is 200 px wide and has the magnifier inside it, on the left', () => {
    const markup = toolbar(createTestStore(), CANVAS_JOBS);
    expect(markup).toMatch(
      /<div class="relative w-50"><svg[^>]*lucide-search[^>]*aria-hidden="true"/,
    );
    expect(markup).toMatch(/<svg[^>]*class="[^"]*lucide-search[^"]*\bleft-2\.5\b/);
  });

  it('is a quiet 32 px field: transparent, a 1 px border in the border colour, no shadow', () => {
    const className = searchInput(toolbar(createTestStore(), CANVAS_JOBS)).match(
      /class="([^"]*)"/,
    )?.[1];
    expect(className).toContain('h-8');
    expect(className).toContain('border-border');
    expect(className).toContain('bg-transparent');
    expect(className).toContain('dark:bg-transparent');
    expect(className).toContain('shadow-none');
    expect(className).toContain('pl-8.5');
    // The stock input is 36 px with a shadow and a tinted fill in the dark theme.
    expect(className).not.toMatch(/\bh-9\b|shadow-xs|dark:bg-input/);
  });

  it('shows what the store holds, Hebrew included', () => {
    const store = createTestStore();
    store.getState().setSearch('מאפיית');
    expect(searchInput(toolbar(store, CANVAS_JOBS))).toContain('value="מאפיית"');
  });

  it('is empty when the store has no search', () => {
    expect(searchInput(toolbar(createTestStore(), CANVAS_JOBS))).toContain('value=""');
  });
});

describe('<JobsToolbar>: layout', () => {
  it('has no Columns button: the tabs on the left; on the right the View menu, then the search', () => {
    const markup = toolbar(createTestStore(), CANVAS_JOBS);
    expect(markup).not.toContain('Columns');
    expect(markup).not.toContain('lucide-chevron-down');
    const tabs = markup.indexOf('role="tablist"');
    const view = markup.indexOf('aria-haspopup="menu"');
    const search = markup.indexOf('type="search"');
    expect(tabs).toBeGreaterThanOrEqual(0);
    expect(tabs).toBeLessThan(view);
    expect(view).toBeLessThan(search);
    // The View menu is the only menu.
    expect(markup.match(/aria-haspopup/g)).toHaveLength(1);
    // The eight tab buttons and the View button, besides the search box: no other button.
    expect(markup.match(/<button/g)).toHaveLength(9);
  });

  it('is one row that wraps onto a second line on a narrow window', () => {
    expect(toolbar(createTestStore(), CANVAS_JOBS)).toMatch(
      /^<div class="flex flex-wrap items-center justify-between gap-3">/,
    );
  });
});

describe('<JobsToolbar>: quiet tabs', () => {
  const markup = toolbar(createTestStore(), CANVAS_JOBS);
  const list = markup.match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? '';

  it('is a ghost tab list: no track, no padding, a 2 px gap, a 32 px row', () => {
    expect(list).toContain('data-variant="ghost"');
    const className = list.match(/class="([^"]*)"/)?.[1] ?? '';
    expect(className).toContain('bg-transparent');
    expect(className).toContain('gap-0.5');
    expect(className).toContain('p-0');
    expect(className).not.toContain('bg-muted');
    expect(className).not.toContain('p-[3px]');
  });

  it('keeps the tab semantics: a tab list of eight tabs, one selected', () => {
    expect(list).toContain('role="tablist"');
    expect(tabsOf(markup)).toHaveLength(8);
    expect(tabsOf(markup).filter((t) => t.selected === 'true')).toHaveLength(1);
  });

  it('writes each count after its name as plain text, with no pill of its own', () => {
    const counts = [...markup.matchAll(/<span data-slot="tabs-trigger-count" class="([^"]*)"/g)];
    expect(counts).toHaveLength(8);
    for (const [, className] of counts) {
      expect(className).toContain('tabular-nums');
      expect(className).toContain('group-data-[variant=ghost]/tabs-list:bg-transparent');
      expect(className).toContain('group-data-[variant=ghost]/tabs-list:text-muted-foreground');
    }
  });
});
