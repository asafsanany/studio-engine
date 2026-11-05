import { type ClientRow, clientHue } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { renderAt } from '@/lib/test-router';
import type { ClientsUiStore } from '@/stores/clients-ui';
import { CLIENT_IDS } from '../jobs/test-jobs';
import { ClientsTable } from './ClientsTable';
import {
  CLIENT_BOARD_ROWS,
  CLIENT_DEFAULT_ORDER,
  createTestClientsStore,
  makeClientRow,
  makeEmptyClientRow,
  manyClientRows,
} from './test-clients';
import { useClientsTable } from './use-clients-table';

/** The table over `clients` (the board's by default; `null` is a list that has not arrived). */
const html = (
  store: StoreApi<ClientsUiStore>,
  clients: readonly ClientRow[] | null = CLIENT_BOARD_ROWS,
  props: Partial<Parameters<typeof ClientsTable>[0]> = {},
) => renderAt('/clients', <ClientsTable clients={clients ?? undefined} store={store} {...props} />);

/** The names in the order the rows are on the page (each row's link). */
const rowNames = (markup: string) =>
  [...markup.matchAll(/<tr[^>]*data-client-id="[^"]+"[\s\S]*?<\/tr>/g)].map((row) =>
    [...row[0].matchAll(/class="bidi"[^>]*>([^<]*)</g)]
      .map((m) => m[1])
      .join('')
      .trim(),
  );

/** The text of each header cell. */
const headers = (markup: string) =>
  (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).map((th) => th.replace(/<[^>]*>/g, '').trim());

/** The `<th>` of the column with this label. */
const headerOf = (markup: string, label: string) =>
  (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).find((th) => th.includes(`>${label}`)) ?? '';

/** The line under the table: the range of a paged table, or "7 clients". */
const footer = (markup: string) =>
  markup
    .slice(markup.indexOf('</table>'))
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A live table instance for the store, to click headers and drive the TanStack API without a DOM. */
function tableFor(
  store: StoreApi<ClientsUiStore>,
  clients: readonly ClientRow[] = CLIENT_BOARD_ROWS,
) {
  let captured: ReturnType<typeof useClientsTable>['table'] | undefined;
  function Probe() {
    captured = useClientsTable({ clients, store }).table;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error('the table did not render');
  return captured;
}

/** Click a header: what its button's onClick does. */
function clickHeader(store: StoreApi<ClientsUiStore>, columnId: string) {
  tableFor(store).getColumn(columnId)?.getToggleSortingHandler()?.({});
}

describe('<ClientsTable>: columns', () => {
  it('shows Client, Jobs and Last job', async () => {
    expect(headers(await html(createTestClientsStore()))).toEqual(['Client', 'Jobs', 'Last job']);
  });

  it('is a table named Clients, with a sort button on every header', async () => {
    const markup = await html(createTestClientsStore());
    expect(markup).toContain('aria-label="Clients"');
    expect((markup.match(/<th[\s\S]*?<button/g) ?? []).length).toBe(3);
  });

  it('gives the Jobs and Last job columns the board widths, and the Client column the rest', async () => {
    const markup = await html(createTestClientsStore());
    const cols = [...markup.matchAll(/<col\b(?!group)([^>]*)>/g)].map((m) => m[1]);
    expect(cols).toHaveLength(3);
    // 160 + 6 + 6 and 200 + 6 + 12 px: the content plus half a gap on each side, or the row padding.
    expect(cols[0]).not.toContain('width');
    expect(cols[1]).toContain('width:172px');
    expect(cols[2]).toContain('width:218px');
  });
});

describe('<ClientsTable>: rows', () => {
  it('lists every client once, newest last job first', async () => {
    expect(rowNames(await html(createTestClientsStore()))).toEqual([...CLIENT_DEFAULT_ORDER]);
  });

  it('shows the initials, the number of jobs and when the last job arrived', async () => {
    const markup = await html(createTestClientsStore());
    const arc = markup.match(/<tr[^>]*data-client-id="27ad66831f94"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(arc).toContain('>AF<');
    expect(arc).toContain('Arc Fitness');
    expect(arc).toMatch(/<td[^>]*>\s*<div class="tabular-nums">3<\/div>/);
    expect(arc).toContain('dateTime="2026-10-20T13:30:00.000Z"');
  });

  it("tints each avatar with the hue the Jobs table gives the client's name", async () => {
    const markup = await html(createTestClientsStore());
    for (const name of ['Arc Fitness', 'Kova Coffee', 'מאפיית הצפון']) {
      expect(markup).toContain(`--client-hue:${clientHue(name)}`);
    }
  });

  it('makes the name a link to the client, which stretches over the whole row', async () => {
    const markup = await html(createTestClientsStore());
    const link = markup.match(/<a [^>]*href="\/clients\/27ad66831f94"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('after:absolute');
    expect(link).toContain('after:inset-0');
    // The row is the box it stretches over.
    expect(markup).toMatch(
      /<tr[^>]*class="[^"]*\brelative\b[^"]*"[^>]*data-client-id="27ad66831f94"/,
    );
    // Every client has one.
    for (const id of Object.values(CLIENT_IDS)) expect(markup).toContain(`href="/clients/${id}"`);
  });

  it('reads Hebrew names right to left and flush left (dir="auto", one left edge)', async () => {
    const markup = await html(createTestClientsStore());
    const north = markup.match(/<tr[^>]*data-client-id="4d337086919d"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(north).toMatch(/<span[^>]*dir="auto"[^>]*class="bidi"[^>]*>מאפיית הצפון</);
    expect(north).toMatch(/dir="auto"[^>]*>מה</);
  });

  it('keeps each row on one line, 57 px high with its line', async () => {
    const markup = await html(createTestClientsStore());
    expect(markup).toContain('h-[57px]');
    expect(markup).toContain('whitespace-nowrap');
  });
});

describe('<ClientsTable>: a client with no jobs', () => {
  const withEmpty = [
    ...CLIENT_BOARD_ROWS,
    makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' }),
  ];
  const emptyRow = (markup: string) =>
    markup.match(/<tr[^>]*data-client-id="e0e0e0e0e0e0"[\s\S]*?<\/tr>/)?.[0] ?? '';

  it('is listed with 0 jobs and a dash for the last job', async () => {
    const row = emptyRow(await html(createTestClientsStore(), withEmpty));
    expect(row).toContain('Fresh Co');
    expect(row).toContain('>FC<');
    expect(row).toMatch(/<div class="tabular-nums">0<\/div>/);
    expect(row).toContain('<span class="text-muted-foreground">—</span>');
    expect(row).not.toContain('<time');
    expect(row).toContain('href="/clients/e0e0e0e0e0e0"');
  });

  it('comes after the clients that have jobs when the list is newest last job first', async () => {
    const names = rowNames(await html(createTestClientsStore(), withEmpty));
    expect(names).toEqual([...CLIENT_DEFAULT_ORDER, 'Fresh Co']);
  });

  it('comes first when Last job sorts oldest first, and last when Jobs sorts most first', async () => {
    const oldest = createTestClientsStore();
    clickHeader(oldest, 'last');
    expect(rowNames(await html(oldest, withEmpty))[0]).toBe('Fresh Co');
    const most = createTestClientsStore();
    clickHeader(most, 'jobs');
    expect(rowNames(await html(most, withEmpty)).at(-1)).toBe('Fresh Co');
  });

  it('is the only row of a list of one, and "No clients yet." is not said', async () => {
    const markup = await html(createTestClientsStore(), [
      makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' }),
    ]);
    expect(rowNames(markup)).toEqual(['Fresh Co']);
    expect(markup).not.toContain('No clients yet.');
    expect(footer(markup)).toBe('1 client');
  });

  it('is found by the search like any other', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('fresh');
    expect(rowNames(await html(store, withEmpty))).toEqual(['Fresh Co']);
  });

  it('shows the name of a client with a job and none apart: rows keep their own counts', async () => {
    const rows = [makeClientRow({ clientId: 'a1a1a1a1a1a1', client: 'Busy Co', jobs: 4 })];
    expect(await html(createTestClientsStore(), rows)).toMatch(
      /<div class="tabular-nums">4<\/div>/,
    );
  });
});

describe('<ClientsTable>: sorting', () => {
  it('starts on Last job, newest first, and shows the arrow on that column only', async () => {
    const markup = await html(createTestClientsStore());
    expect(headerOf(markup, 'Last job')).toContain('aria-sort="descending"');
    expect(headerOf(markup, 'Last job')).toContain('lucide-arrow-down');
    expect(headerOf(markup, 'Last job')).toContain('text-foreground');
    for (const label of ['Client', 'Jobs']) {
      expect(headerOf(markup, label)).toContain('aria-sort="none"');
      // The unsorted ones keep only the fading ArrowUpDown, hidden until the button is hovered.
      expect(headerOf(markup, label)).toContain('lucide-arrow-up-down');
      expect(headerOf(markup, label)).toContain('opacity-0');
      expect(headerOf(markup, label)).toContain('group-hover/sort:opacity-50');
      expect(headerOf(markup, label)).not.toContain('lucide-arrow-down');
    }
  });

  it('sorts by name A to Z on the first click on Client, then Z to A', async () => {
    const store = createTestClientsStore();
    clickHeader(store, 'client');
    expect(store.getState().sorting).toEqual([{ id: 'client', desc: false }]);
    const asc = rowNames(await html(store));
    expect(asc).toEqual([
      'Arc Fitness',
      'Kova Coffee',
      'Lumen Yoga',
      'Noa Ceramics',
      'טל נכסים',
      'מאפיית הצפון',
      'מרפאת מירה',
    ]);
    expect(headerOf(await html(store), 'Client')).toContain('aria-sort="ascending"');
    expect(headerOf(await html(store), 'Client')).toContain('lucide-arrow-up');

    clickHeader(store, 'client');
    expect(store.getState().sorting).toEqual([{ id: 'client', desc: true }]);
    expect(rowNames(await html(store))).toEqual([...asc].reverse());
  });

  it('sorts by the number of jobs, most first on the first click', async () => {
    const store = createTestClientsStore();
    clickHeader(store, 'jobs');
    expect(store.getState().sorting).toEqual([{ id: 'jobs', desc: true }]);
    const names = rowNames(await html(store));
    // 3, 3, 2, 2, 2, 1, 1; clients with the same count stay in their newest-last-job order.
    expect(names).toEqual([
      'מאפיית הצפון',
      'Arc Fitness',
      'מרפאת מירה',
      'Kova Coffee',
      'טל נכסים',
      'Noa Ceramics',
      'Lumen Yoga',
    ]);
    clickHeader(store, 'jobs');
    expect(rowNames(await html(store))).toEqual([
      'Noa Ceramics',
      'Lumen Yoga',
      'מרפאת מירה',
      'Kova Coffee',
      'טל נכסים',
      'מאפיית הצפון',
      'Arc Fitness',
    ]);
  });

  it('flips Last job to oldest first on a second click, and never back to unsorted', async () => {
    const store = createTestClientsStore();
    clickHeader(store, 'last');
    expect(store.getState().sorting).toEqual([{ id: 'last', desc: false }]);
    expect(rowNames(await html(store))).toEqual([...CLIENT_DEFAULT_ORDER].reverse());
    clickHeader(store, 'last');
    expect(store.getState().sorting).toEqual([{ id: 'last', desc: true }]);
  });

  it('sorts names the way a person would: case ignored, Latin before Hebrew', async () => {
    const clients = CLIENT_BOARD_ROWS.filter((row) =>
      ['Arc Fitness', 'טל נכסים'].includes(row.client),
    );
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'client', desc: false }]);
    expect(rowNames(await html(store, clients))).toEqual(['Arc Fitness', 'טל נכסים']);
  });
});

describe('<ClientsTable>: search', () => {
  it('shows only the clients whose name matches, in the sort order', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('a');
    // "a": Noa, Arc, Lumen Yoga, Kova, and the Hebrew names with no Latin a are out.
    expect(rowNames(await html(store))).toEqual([
      'Noa Ceramics',
      'Arc Fitness',
      'Lumen Yoga',
      'Kova Coffee',
    ]);
  });

  it('finds a Hebrew name', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('מרפאת');
    expect(rowNames(await html(store))).toEqual(['מרפאת מירה']);
  });

  it('says so when nothing matches, and counts what was left out', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('zzz');
    const markup = await html(store);
    expect(markup).toContain('No matching clients.');
    expect(rowNames(markup)).toEqual([]);
    expect(footer(markup)).toBe('0 of 7 clients');
  });

  it('counts "2 of 7 clients" while the search leaves some out', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('yoga');
    expect(footer(await html(store))).toBe('1 of 7 clients');
  });
});

describe('<ClientsTable>: count and pages', () => {
  it('says how many clients there are under the table', async () => {
    expect(footer(await html(createTestClientsStore()))).toBe('7 clients');
    expect(footer(await html(createTestClientsStore(), CLIENT_BOARD_ROWS.slice(0, 1)))).toBe(
      '1 client',
    );
  });

  it('has no page controls up to 25 clients', async () => {
    const markup = await html(createTestClientsStore(), manyClientRows(25));
    expect(rowNames(markup)).toHaveLength(25);
    expect(markup).not.toContain('Go to next page');
    expect(footer(markup)).toBe('25 clients');
  });

  it('pages from the 26th client on: 25 a page, with the range and the page buttons', async () => {
    const store = createTestClientsStore();
    const clients = manyClientRows(40);
    const first = await html(store, clients);
    expect(rowNames(first)).toHaveLength(25);
    expect(rowNames(first)[0]).toBe('Client 01');
    expect(first).toContain('1–25 of 40 clients');
    expect(first).toContain('Go to page 2');
    expect(first).toContain('aria-label="Go to previous page" disabled');

    store.getState().setPageIndex(1);
    const second = await html(store, clients);
    expect(rowNames(second)).toHaveLength(15);
    expect(rowNames(second)[0]).toBe('Client 26');
    expect(second).toContain('26–40 of 40 clients');
  });

  it('starts over from page 1 when the search or the sort changes', async () => {
    const store = createTestClientsStore();
    store.getState().setPageIndex(1);
    store.getState().setSearch('client');
    expect(store.getState().pageIndex).toBe(0);
    store.getState().setPageIndex(1);
    clickHeader(store, 'client');
    expect(store.getState().pageIndex).toBe(0);
  });

  it('pages the search result, not the whole list', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('Client 3');
    // Client 03, 13, 23 and 30 to 39: thirteen clients, one page.
    const markup = await html(store, manyClientRows(40));
    expect(rowNames(markup)).toHaveLength(13);
    expect(footer(markup)).toBe('13 of 40 clients');
  });
});

describe('<ClientsTable>: states', () => {
  it('shows "No clients yet." for an empty client list, and no count', async () => {
    const markup = await html(createTestClientsStore(), []);
    expect(markup).toContain('No clients yet.');
    expect(markup).toContain('Click New client, or make a folder for one in Studio Inbox');
    expect(markup).toContain('Studio Inbox/&lt;Client&gt;');
    expect(footer(markup)).not.toMatch(/clients?\b/i);
  });

  it('shows "Can\'t reach the engine." with a retry when the first load failed', async () => {
    const markup = await html(createTestClientsStore(), null, { failed: true });
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toContain('Try again');
  });

  it('keeps a list that is on screen even if a later load failed', async () => {
    const markup = await html(createTestClientsStore(), CLIENT_BOARD_ROWS, { failed: true });
    expect(rowNames(markup)).toHaveLength(7);
    expect(markup).not.toContain('Try again');
  });

  it('shows nothing in the body before the delay, then skeleton rows', async () => {
    const waiting = await html(createTestClientsStore(), null);
    expect(waiting).toContain('aria-busy="true"');
    expect(waiting).not.toContain('data-skeleton-row');

    const slow = await html(createTestClientsStore(), null, { skeletonDelayMs: 0 });
    expect((slow.match(/data-skeleton-row/g) ?? []).length).toBe(7);
    expect(slow).toContain('Loading clients…');
    expect(slow).not.toContain('<a ');
  });

  it('keeps the header in every state', async () => {
    for (const markup of [
      await html(createTestClientsStore(), []),
      await html(createTestClientsStore(), null),
      await html(createTestClientsStore(), null, { failed: true }),
    ]) {
      expect(headers(markup)).toEqual(['Client', 'Jobs', 'Last job']);
    }
  });
});

describe('<ClientsTable>: the admin’s Assigned to column (TM5)', () => {
  const arc = CLIENT_IDS['Arc Fitness'];
  const kova = CLIENT_IDS['Kova Coffee'];
  const lookup = (clientId: string) =>
    clientId === arc ? ['Yael', 'Amit'] : clientId === kova ? [] : undefined;

  it('has no such column for an editor (no lookup)', async () => {
    const markup = await html(createTestClientsStore());
    expect(headers(markup)).toEqual(['Client', 'Jobs', 'Last job']);
    expect(markup).not.toContain('Assigned to');
    expect(markup).not.toContain('Unassigned');
  });

  it('adds it at the end for the admin, as plain text with no sort button', async () => {
    const markup = await html(createTestClientsStore(), CLIENT_BOARD_ROWS, { assignedTo: lookup });
    expect(headers(markup)).toEqual(['Client', 'Jobs', 'Last job', 'Assigned to']);
    expect(headerOf(markup, 'Assigned to')).not.toContain('<button');
    expect(headerOf(markup, 'Assigned to')).not.toContain('aria-sort');
    // The other three still sort.
    expect((markup.match(/<th[\s\S]*?<button/g) ?? []).length).toBe(3);
  });

  it('lists the names of the editors a client is assigned to', async () => {
    const markup = await html(createTestClientsStore(), CLIENT_BOARD_ROWS, { assignedTo: lookup });
    const row =
      markup.match(new RegExp(`<tr[^>]*data-client-id="${arc}"[\\s\\S]*?</tr>`))?.[0] ?? '';
    expect(row.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).toContain('Yael, Amit');
  });

  it('says a muted "Unassigned" for a client only the admin sees', async () => {
    const markup = await html(createTestClientsStore(), CLIENT_BOARD_ROWS, { assignedTo: lookup });
    const row =
      markup.match(new RegExp(`<tr[^>]*data-client-id="${kova}"[\\s\\S]*?</tr>`))?.[0] ?? '';
    expect(row).toMatch(/<div class="text-muted-foreground">Unassigned<\/div>/);
  });

  it('shows nothing in the column until the team is known', async () => {
    const markup = await html(createTestClientsStore(), CLIENT_BOARD_ROWS, {
      assignedTo: () => undefined,
    });
    expect(headers(markup)).toContain('Assigned to');
    expect(markup).not.toContain('Unassigned');
  });

  it('gives its skeleton row a cell for the column too', async () => {
    const markup = await html(createTestClientsStore(), null, {
      assignedTo: lookup,
      skeletonDelayMs: 0,
    });
    const skeleton = markup.match(/<tr[^>]*data-skeleton-row[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect((skeleton.match(/<td/g) ?? []).length).toBe(4);
  });
});
