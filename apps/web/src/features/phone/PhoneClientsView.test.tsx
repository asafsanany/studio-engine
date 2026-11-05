import type { ClientRow } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeClientRow, makeEmptyClientRow } from '@/features/clients/test-clients';
import { renderAt } from '@/lib/test-router';
import { createClientsUiStore } from '@/stores/clients-ui';
import { createMemoryStorage } from '@/stores/jobs-ui';
import { PhoneClientsView } from './PhoneClientsPage';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

// The board's three clients, newest last job first: a Hebrew one just now, RGM 3 min ago, LAKESHORE
// 9 min ago.
const CLIENTS: readonly ClientRow[] = [
  makeClientRow({ clientId: 'lakeshore', client: 'LAKESHORE', jobs: 3, lastJobAt: ago(9) }),
  makeClientRow({ clientId: 'rgm', client: 'RGM', jobs: 5, lastJobAt: ago(3) }),
  makeClientRow({ clientId: 'heb', client: 'עו״ד דוד לוי', jobs: 5, lastJobAt: ago(0.2) }),
];

interface Options {
  /** `null` is the list before its first answer. */
  clients?: readonly ClientRow[] | null;
  search?: string;
  failed?: boolean;
  reconnecting?: boolean;
}

function render({ clients = CLIENTS, search = '', failed, reconnecting }: Options = {}) {
  const store = createClientsUiStore(createMemoryStorage());
  store.getState().setSearch(search);
  // A static render reads the store's initial state; this one starts from what the test set.
  store.getInitialState = () => store.getState();
  return renderAt(
    '/clients',
    <PhoneClientsView
      clients={clients ?? undefined}
      failed={failed}
      reconnecting={reconnecting}
      store={store}
      skeletonDelayMs={0}
    />,
  );
}

const rowTags = (html: string) => html.match(/<li [^>]*data-client-id="[^"]*"[^>]*>/g) ?? [];
const idsOf = (html: string) => rowTags(html).map((t) => /data-client-id="([^"]*)"/.exec(t)?.[1]);

describe('<PhoneClientsView>', () => {
  it('has the title "Clients" and a 44 px Search button', async () => {
    const html = await render();
    expect(html).toContain('data-slot="phone-clients-page"');
    expect(html).toMatch(/<h1[^>]*>Clients<\/h1>/);
    const search = html.match(/<button[^>]*aria-label="Search clients"[^>]*>/)?.[0];
    expect(search).toContain('size-11');
    expect(search).toContain('aria-expanded="false"');
  });

  it('lists the clients newest last job first, each a link to its page', async () => {
    const html = await render();
    expect(idsOf(html)).toEqual(['heb', 'rgm', 'lakeshore']);
    for (const id of ['heb', 'rgm', 'lakeshore']) {
      expect(html).toContain(`href="/clients/${id}"`);
    }
  });

  it('draws each row at least 64 px tall with a 40 px avatar, the name and a chevron', async () => {
    const html = await render();
    const link = html.match(/<a [^>]*href="\/clients\/rgm"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('min-h-16');
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('lucide-chevron-right');
    expect(html).toContain('>RGM<');
  });

  it('says "5 jobs · last job 3 min ago" under the name', async () => {
    const html = await render();
    expect(html).toMatch(/5 jobs · last job <time[^>]*>3 min ago<\/time>/);
    expect(html).toMatch(/3 jobs · last job <time[^>]*>9 min ago<\/time>/);
  });

  it('says "last job just now" for a client whose job arrived a moment ago', async () => {
    const html = await render();
    expect(html).toMatch(/5 jobs · last job <time[^>]*>just now<\/time>/);
  });

  it('says "1 job" for one, and only "0 jobs" for a client with none yet', async () => {
    const html = await render({
      clients: [
        makeClientRow({ clientId: 'one', client: 'One', jobs: 1, lastJobAt: ago(5) }),
        makeEmptyClientRow({ clientId: 'none', client: 'None' }),
      ],
    });
    expect(html).toMatch(/1 job · last job/);
    expect(html).toContain('0 jobs<');
    expect(html).not.toMatch(/0 jobs · last job/);
  });

  it('reads a Hebrew name right to left', async () => {
    const html = await render();
    expect(html).toMatch(/dir="auto"[^>]*>עו״ד דוד לוי</);
  });

  it('ends with the footer "3 clients"', async () => {
    expect(await render()).toMatch(/>3 clients<\/p>/);
  });

  describe('the search', () => {
    it('is closed unless a search is already typed, and then shows the field with it', async () => {
      expect(await render()).not.toContain('type="search"');
      const open = await render({ search: 'rgm' });
      expect(open).toContain('type="search"');
      expect(open).toContain('value="rgm"');
      expect(open).toContain('aria-expanded="true"');
    });

    it('uses a 16 px field, so iOS does not zoom', async () => {
      const field = (await render({ search: 'x' })).match(/<input[^>]*type="search"[^>]*>/)?.[0];
      expect(field).toContain('text-base');
      expect(field).toContain('placeholder="Search clients"');
    });

    it('narrows the list and the footer says "1 of 3 clients"', async () => {
      const html = await render({ search: 'rgm' });
      expect(idsOf(html)).toEqual(['rgm']);
      expect(html).toMatch(/>1 of 3 clients<\/p>/);
    });

    it('finds a Hebrew name', async () => {
      expect(idsOf(await render({ search: 'דוד' }))).toEqual(['heb']);
    });

    it('says "No matching clients." when none match, with the footer "0 of 3 clients"', async () => {
      const html = await render({ search: 'zzz' });
      expect(idsOf(html)).toEqual([]);
      expect(html).toContain('No matching clients.');
      expect(html).toMatch(/>0 of 3 clients<\/p>/);
    });
  });

  describe('states', () => {
    it('draws skeleton rows while the first answer is on its way, and no footer', async () => {
      const html = await render({ clients: null });
      expect(html.match(/data-skeleton-row/g)).toHaveLength(6);
      expect(html).toContain('Loading clients…');
      expect(html).not.toContain(' clients</p>');
    });

    it('says the engine is out of reach, with a way to try again', async () => {
      const html = await render({ clients: null, failed: true });
      expect(html).toContain('Can&#x27;t reach the engine.');
      expect(html).toContain('Try again');
      expect(html).not.toContain('data-skeleton-row');
    });

    it('keeps a list that has arrived even when the engine is failing again', async () => {
      const html = await render({ failed: true });
      expect(idsOf(html)).toHaveLength(3);
      expect(html).not.toContain('Try again');
    });

    it('says there is no client yet, and where one comes from (New client stays on the Mac)', async () => {
      const html = await render({ clients: [] });
      expect(html).toContain('No clients yet.');
      expect(html).toContain('Studio Inbox/&lt;Client&gt;');
      expect(html).not.toContain('New client');
    });

    it('shows the "Reconnecting to the engine…" line when asked', async () => {
      expect(await render({ reconnecting: true })).toContain('Reconnecting to the engine');
      expect(await render()).not.toContain('Reconnecting to the engine');
    });
  });

  it('has no Add or New client button: that stays on the Mac', async () => {
    const html = await render();
    expect(html).not.toContain('New client');
  });
});
