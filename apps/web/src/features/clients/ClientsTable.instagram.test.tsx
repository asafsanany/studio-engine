import type { ClientInstagramSummary, ClientRow } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { ClientPhotosContext } from '@/components/ClientAvatar';
import { photoKey } from '@/data/client-photos';
import { renderAt } from '@/lib/test-router';
import type { ClientsUiStore } from '@/stores/clients-ui';
import { ClientsTable } from './ClientsTable';
import { createTestClientsStore, makeClientRow, makeEmptyClientRow } from './test-clients';

// The Clients table while Clients × Instagram is on (board CLList, L1).

const account = (overrides: Partial<ClientInstagramSummary> = {}): ClientInstagramSummary => ({
  handle: 'falcon.fpv',
  followers: 12_480,
  weekChange: 312,
  oursVsTheirs: 3.6,
  photoAt: null,
  ...overrides,
});

const FALCON = makeClientRow({
  clientId: 'a00000000001',
  client: 'Falcon FPV',
  lastJobAt: '2026-10-20T10:00:00.000Z',
  instagram: account(),
});
const WINERY = makeClientRow({
  clientId: 'a00000000002',
  client: 'Valley Winery',
  lastJobAt: '2026-10-20T12:00:00.000Z',
  instagram: account({
    handle: 'valley.winery',
    followers: 3_200,
    weekChange: -42,
    oursVsTheirs: 0.8,
  }),
});
const PRIVATE = makeClientRow({
  clientId: 'a00000000003',
  client: 'Quiet Studio',
  lastJobAt: '2026-10-20T13:00:00.000Z',
  instagram: account({
    handle: 'quiet.studio',
    followers: null,
    weekChange: null,
    oursVsTheirs: null,
    private: true,
  }),
});
const NONE = makeClientRow({
  clientId: 'a00000000004',
  client: 'Noa Ceramics',
  lastJobAt: '2026-10-20T11:00:00.000Z',
  instagram: null,
});
const NO_JOBS = makeEmptyClientRow({
  clientId: 'a00000000005',
  client: 'Fresh Co',
  instagram: null,
});
const UNREAD = makeClientRow({
  clientId: 'a00000000006',
  client: 'Brand New Account',
  lastJobAt: '2026-10-20T09:00:00.000Z',
  instagram: account({
    handle: 'brand.new',
    followers: null,
    weekChange: null,
    oursVsTheirs: null,
  }),
});

const ROWS: readonly ClientRow[] = [FALCON, WINERY, PRIVATE, NONE, NO_JOBS, UNREAD];

/** The table over `clients` (`null` is a list that has not arrived). */
const html = (
  store: StoreApi<ClientsUiStore>,
  clients: readonly ClientRow[] | null = ROWS,
  props: Partial<Parameters<typeof ClientsTable>[0]> = {},
) => renderAt('/clients', <ClientsTable clients={clients ?? undefined} store={store} {...props} />);

const rowNames = (markup: string) =>
  [...markup.matchAll(/<tr[^>]*data-client-id="[^"]+"[\s\S]*?<\/tr>/g)].map((row) =>
    [...row[0].matchAll(/class="bidi"[^>]*>([^<]*)</g)]
      .map((m) => m[1])
      .join('')
      .trim(),
  );

const headers = (markup: string) =>
  (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).map((th) => th.replace(/<[^>]*>/g, '').trim());

const rowOf = (markup: string, clientId: string) =>
  markup.match(new RegExp(`<tr[^>]*data-client-id="${clientId}"[\\s\\S]*?</tr>`))?.[0] ?? '';

const textOf = (markup: string) =>
  markup
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cellCount = (row: string) => (row.match(/<td/g) ?? []).length;

describe('<ClientsTable instagram>: columns', () => {
  it('shows Client, Followers, This week and Ours vs theirs in place of Jobs and Last job', async () => {
    const markup = await html(createTestClientsStore(), ROWS, { instagram: true });
    expect(headers(markup)).toEqual(['Client', 'Followers', 'This week', 'Ours vs theirs']);
  });

  it('puts the admin’s Assigned to column after them', async () => {
    const markup = await html(createTestClientsStore(), ROWS, {
      instagram: true,
      assignedTo: () => [],
    });
    expect(headers(markup)).toEqual([
      'Client',
      'Followers',
      'This week',
      'Ours vs theirs',
      'Assigned to',
    ]);
  });

  it('has a sort button on each of the four', async () => {
    const markup = await html(createTestClientsStore(), ROWS, { instagram: true });
    expect((markup.match(/<th[\s\S]*?<button/g) ?? []).length).toBe(4);
  });

  it('right-aligns the three number headers', async () => {
    const markup = await html(createTestClientsStore(), ROWS, { instagram: true });
    const headerOf = (label: string) =>
      (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).find((th) => th.includes(`>${label}`)) ?? '';
    for (const label of ['Followers', 'This week', 'Ours vs theirs']) {
      expect(headerOf(label)).toContain('justify-end');
    }
    expect(headerOf('Client')).not.toContain('justify-end');
  });

  it('is today’s table while the switch is off, whatever the list carries', async () => {
    for (const props of [{}, { instagram: false }]) {
      const markup = await html(createTestClientsStore(), ROWS, props);
      expect(headers(markup)).toEqual(['Client', 'Jobs', 'Last job']);
      expect(markup).not.toContain('@falcon.fpv');
      expect(markup).not.toContain('12,480');
      expect(markup).not.toContain('No Instagram yet');
      expect(markup).not.toContain('Add Instagram');
    }
  });
});

describe('<ClientsTable instagram>: a client with an account', () => {
  it('shows the name with the @handle under it', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      FALCON.clientId,
    );
    expect(row).toContain('Falcon FPV');
    expect(row).toMatch(/data-slot="client-handle"[^>]*>@falcon\.fpv</);
    // The handle reads left to right whatever the name does.
    expect(row).toMatch(
      /<span[^>]*data-slot="client-handle"[^>]*dir="ltr"|dir="ltr"[^>]*data-slot="client-handle"/,
    );
  });

  it('shows followers, this week and ours vs theirs, one number to a cell', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      FALCON.clientId,
    );
    expect(cellCount(row)).toBe(4);
    expect(row).toMatch(/<div class="text-right tabular-nums">12,480<\/div>/);
    expect(row).toMatch(/<div class="text-right tabular-nums [^"]*">\+312<\/div>/);
    expect(row).toMatch(/<div class="text-right tabular-nums">3\.6×<\/div>/);
  });

  it('writes a rise in green, a fall in red', async () => {
    const markup = await html(createTestClientsStore(), ROWS, { instagram: true });
    expect(rowOf(markup, FALCON.clientId)).toMatch(/text-\[#4ADE80\][^>]*">\+312</);
    expect(rowOf(markup, WINERY.clientId)).toMatch(/text-\[#F87171\][^>]*">−42</);
  });

  it('shows dashes for numbers no scan has read yet, and still has no Add Instagram', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      UNREAD.clientId,
    );
    expect(cellCount(row)).toBe(4);
    expect((row.match(/>—</g) ?? []).length).toBe(3);
    expect(row).toContain('@brand.new');
    expect(row).not.toContain('Add Instagram');
    expect(row).not.toContain('No Instagram yet');
  });

  it('keeps the name a link to the client, over the whole row', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      FALCON.clientId,
    );
    expect(row).toMatch(/<a [^>]*after:inset-0[^>]*href="\/clients\/a00000000001"/);
  });

  it('draws the Instagram photo of an account in its row, and the initials of a private one', async () => {
    const photos = new Map([
      [photoKey('Falcon FPV'), '/api/clients/a00000000001/photo?v=1'],
      [photoKey('Quiet Studio'), '/api/clients/a00000000003/photo?v=1'],
    ]);
    const markup = await renderAt(
      '/clients',
      <ClientPhotosContext.Provider value={photos}>
        <ClientsTable clients={ROWS} store={createTestClientsStore()} instagram />
      </ClientPhotosContext.Provider>,
    );
    const falcon = rowOf(markup, FALCON.clientId);
    expect(falcon).toContain('data-slot="client-photo"');
    expect(falcon).toContain('src="/api/clients/a00000000001/photo?v=1"');
    // The scan saved Quiet Studio's photo, but the row says "Account is private" and keeps the circle.
    const quiet = rowOf(markup, PRIVATE.clientId);
    expect(quiet).not.toContain('<img');
    expect(quiet).toContain('>QS<');
  });

  it('gives the avatar the 28 px size of the board', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      FALCON.clientId,
    );
    expect(row).toMatch(/data-slot="avatar"[^>]*size-7|size-7[^>]*data-slot="avatar"/);
  });
});

describe('<ClientsTable instagram>: a client with no readable account', () => {
  it('says "No Instagram yet" over Followers and This week, with an Add Instagram button', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      NONE.clientId,
    );
    expect(textOf(row)).toContain('No Instagram yet');
    expect(textOf(row)).not.toContain('@');
    // Name, the sentence (two columns wide), and Add Instagram.
    expect(cellCount(row)).toBe(3);
    expect(row).toMatch(/<td[^>]*colSpan="2"[^>]*>[\s\S]*?No Instagram yet/);
    expect(row).toMatch(/<button[^>]*data-slot="add-instagram"[^>]*>Add Instagram<\/button>/);
    expect(row).toContain('aria-label="Add Instagram for Noa Ceramics"');
  });

  it('says "Account is private" for a private account, with Edit account', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      PRIVATE.clientId,
    );
    expect(textOf(row)).toContain('Account is private');
    expect(textOf(row)).not.toContain('No Instagram yet');
    expect(row).not.toContain('@quiet.studio');
    expect(cellCount(row)).toBe(3);
    expect(row).toMatch(/<button[^>]*data-slot="add-instagram"[^>]*>Edit account<\/button>/);
    expect(row).toContain('aria-label="Edit account for Quiet Studio"');
    expect(row).not.toContain('Add Instagram');
  });

  it('mutes the sentence', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      NONE.clientId,
    );
    expect(row).toMatch(/<div class="text-muted-foreground">No Instagram yet<\/div>/);
  });

  it('puts the Add Instagram button above the row’s stretched link, as its own click', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      NONE.clientId,
    );
    const button = row.match(/<button[^>]*data-slot="add-instagram"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('relative z-10');
    expect(button).toContain('cursor-pointer');
  });

  it('counts a client with no jobs the same way', async () => {
    const row = rowOf(
      await html(createTestClientsStore(), ROWS, { instagram: true }),
      NO_JOBS.clientId,
    );
    expect(textOf(row)).toContain('No Instagram yet');
    expect(row).toContain('Add Instagram');
  });
});

describe('<ClientsTable instagram>: the order', () => {
  it('starts with the clients that have an account, newest last job first, then the rest', async () => {
    const names = rowNames(await html(createTestClientsStore(), ROWS, { instagram: true }));
    expect(names).toEqual([
      // Accounts: Valley 12:00, Falcon 10:00, Brand New 09:00.
      'Valley Winery',
      'Falcon FPV',
      'Brand New Account',
      // No readable account: Quiet 13:00, Noa 11:00, then Fresh Co (no jobs).
      'Quiet Studio',
      'Noa Ceramics',
      'Fresh Co',
    ]);
  });

  it('is today’s order while the switch is off: last job, newest first, whatever the account', async () => {
    const names = rowNames(await html(createTestClientsStore(), ROWS));
    expect(names).toEqual([
      'Quiet Studio',
      'Valley Winery',
      'Noa Ceramics',
      'Falcon FPV',
      'Brand New Account',
      'Fresh Co',
    ]);
  });

  it('sorts Followers most first on the first click, with the clients without numbers last', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'followers', desc: true }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names.slice(0, 2)).toEqual(['Falcon FPV', 'Valley Winery']);
    expect(new Set(names.slice(2))).toEqual(
      new Set(['Brand New Account', 'Quiet Studio', 'Noa Ceramics', 'Fresh Co']),
    );
  });

  it('keeps the clients without numbers last when Followers sorts fewest first too', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'followers', desc: false }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names.slice(0, 2)).toEqual(['Valley Winery', 'Falcon FPV']);
    expect(new Set(names.slice(2))).toEqual(
      new Set(['Brand New Account', 'Quiet Studio', 'Noa Ceramics', 'Fresh Co']),
    );
  });

  it('sorts This week by the change, a fall below a rise', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'week', desc: true }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names.slice(0, 2)).toEqual(['Falcon FPV', 'Valley Winery']);
  });

  it('sorts Ours vs theirs by the multiple', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'ours', desc: true }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names.slice(0, 2)).toEqual(['Falcon FPV', 'Valley Winery']);
  });

  it('sorts the Client column by name', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'client', desc: false }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names).toEqual([
      'Brand New Account',
      'Falcon FPV',
      'Fresh Co',
      'Noa Ceramics',
      'Quiet Studio',
      'Valley Winery',
    ]);
  });

  it('survives a stored sort on a column this view does not have (Jobs)', async () => {
    const store = createTestClientsStore();
    store.getState().setSorting([{ id: 'jobs', desc: true }]);
    const names = rowNames(await html(store, ROWS, { instagram: true }));
    expect(names).toHaveLength(6);
    expect(names[0]).toBe('Valley Winery');
  });
});

describe('<ClientsTable instagram>: states and search', () => {
  it('finds a client by name, and keeps the count', async () => {
    const store = createTestClientsStore();
    store.getState().setSearch('falcon');
    const markup = await html(store, ROWS, { instagram: true });
    expect(rowNames(markup)).toEqual(['Falcon FPV']);
    expect(textOf(markup)).toContain('1 of 6 clients');
  });

  it('keeps the header and shows skeleton cells for the new columns while loading', async () => {
    const markup = await html(createTestClientsStore(), null, {
      instagram: true,
      skeletonDelayMs: 0,
    });
    expect(headers(markup)).toEqual(['Client', 'Followers', 'This week', 'Ours vs theirs']);
    const skeleton = markup.match(/<tr[^>]*data-skeleton-row[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(cellCount(skeleton)).toBe(4);
  });

  it('gives the empty and unreachable rows the width of four columns', async () => {
    const empty = await html(createTestClientsStore(), [], { instagram: true });
    expect(empty).toContain('colSpan="4"');
    const failed = await html(createTestClientsStore(), null, {
      instagram: true,
      failed: true,
    });
    expect(failed).toContain('colSpan="4"');
  });
});
