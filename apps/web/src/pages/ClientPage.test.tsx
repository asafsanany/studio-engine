import { type ClientRow, clientHue, type Job } from '@studio/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS_KEY } from '@/data/clients-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { ORPHANS_KEY } from '@/data/orphan-deliveries';
import {
  createTestQueryClient,
  makeJob,
  makeJobDelivery,
  makeOrphanDelivery,
} from '@/data/test-utils';
import {
  CLIENT_BOARD_JOBS,
  clientRowsOf,
  makeEmptyClientRow,
} from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import { renderApp } from '@/lib/test-router';
import { defaultJobsUiState, jobsUiStore } from '@/stores/jobs-ui';

/** The app at `path` with the job list loaded, and the client list the server would send for it. */
async function page(path: string, jobs?: readonly Job[], extraClients: readonly ClientRow[] = []) {
  const client = createTestQueryClient();
  if (jobs !== undefined) {
    client.setQueryData(JOBS_KEY, jobs);
    client.setQueryData(CLIENTS_KEY, clientRowsOf(jobs, extraClients));
  }
  return renderApp(path, client);
}

const clientPage = (name: keyof typeof CLIENT_IDS, jobs: readonly Job[] = CLIENT_BOARD_JOBS) =>
  page(`/clients/${CLIENT_IDS[name]}`, jobs);

/** The job ids in the order the rows are on the page. */
const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The page's own part: what is inside <main>. */
const main = (markup: string) => markup.slice(markup.indexOf('<main'));

/** The opening tag of the jobs list. */
const LIST = '<ul aria-label="Jobs"';

/** How many rows show a client's name (the muted 13 px text after the job's name). */
const clientNames = (markup: string, name: string) =>
  markup
    .split(`text-[13px] text-muted-foreground`)
    .filter((part) => part.includes(`<span dir="auto" class="bidi">${name}</span></a>`)).length;

describe("a client's page: the header", () => {
  it('shows the avatar, the name and how many jobs, with when the last arrived', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    expect(markup).toMatch(/<h1[^>]*>Arc Fitness<\/h1>/);
    expect(markup).toContain('data-size="lg"');
    expect(markup).toMatch(/data-size="lg"[^>]*aria-hidden="true"[^>]*><span[^>]*>AF<\/span>/);
    expect(markup).toContain('3 jobs · last job <time dateTime="2026-10-20T13:30:00.000Z"');
  });

  it('tints the avatar like the same client in the Jobs table', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    expect(markup).toContain(`--client-hue:${clientHue('Arc Fitness')}`);
  });

  it('puts the avatar first, then the name above the line about the jobs', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    const avatar = markup.indexOf('data-size="lg"');
    const name = markup.indexOf('<h1');
    const meta = markup.indexOf('3 jobs');
    const list = markup.indexOf(LIST);
    expect(avatar).toBeLessThan(name);
    expect(name).toBeLessThan(meta);
    expect(meta).toBeLessThan(list);
  });

  it('says "1 job" for a client with one', async () => {
    const markup = main(await clientPage('Noa Ceramics'));
    expect(markup).toContain('1 job · last job');
    expect(markup).not.toContain('1 jobs');
  });

  it('lets a Hebrew name read right to left and sit flush left', async () => {
    const markup = main(await clientPage('מאפיית הצפון'));
    expect(markup).toMatch(/<h1[^>]*dir="auto"[^>]*class="[^"]*bidi[^"]*"[^>]*>מאפיית הצפון<\/h1>/);
    expect(markup).toMatch(/dir="auto"[^>]*>מה<\/span>/);
  });

  it('has a Style button on the right: an outline link with the file-text icon', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    const button = markup.match(/<a [^>]*data-slot="button"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(button).toContain(`href="/clients/${CLIENT_IDS['Arc Fitness']}/style"`);
    expect(button).toContain('data-variant="outline"');
    expect(button).toContain('lucide-file-text');
    expect(button).toMatch(/>\s*Style<\/a>$/);
    // After the name, before the list.
    expect(markup.indexOf('Arc Fitness</h1>')).toBeLessThan(markup.indexOf(button));
    expect(markup.indexOf(button)).toBeLessThan(markup.indexOf(LIST));
  });

  it('has the ⋯ menu button right after the Style button, 8 px to its right (C93)', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    const style = markup.indexOf(`href="/clients/${CLIENT_IDS['Arc Fitness']}/style"`);
    const more = markup.indexOf('aria-label="More for Arc Fitness"');
    expect(style).toBeGreaterThan(-1);
    expect(more).toBeGreaterThan(style);
    expect(more).toBeLessThan(markup.indexOf(LIST));
    // The two sit in one row with 8 px between them.
    expect(markup).toMatch(
      /<div class="flex shrink-0 items-center gap-2"><a [^>]*href="[^"]*\/style"/,
    );
  });

  it('keeps the Style button when the name is Hebrew', async () => {
    const markup = main(await clientPage('מאפיית הצפון'));
    expect(markup).toContain(`href="/clients/${CLIENT_IDS['מאפיית הצפון']}/style"`);
  });
});

describe("a client's page: the jobs list", () => {
  it("lists only this client's jobs, in the Jobs list's order", async () => {
    expect(rowIds(await clientPage('Arc Fitness'))).toEqual(['j5', 'j2', 'j10']);
    expect(rowIds(await clientPage('Kova Coffee'))).toEqual(['j6', 'j8']);
    expect(rowIds(await clientPage('מאפיית הצפון'))).toEqual(['j1', 'j3', 'j12']);
  });

  it('shows the same rows as the Jobs page, without the client’s name in them', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    expect(markup).toContain(LIST);
    expect(markup).not.toContain('<table');
    expect(markup).toContain('data-status="editing" data-done="4"');
    expect(markup).toContain('<span data-step-label="">Cut · graphics 2/5</span> · ~4 min left');
    // Not a row of the three carries it; the header's name is the only one.
    expect(clientNames(markup, 'Arc Fitness')).toBe(0);
    // The Jobs page, over the same jobs, shows it in the rows.
    expect(
      clientNames(main(await page('/jobs', CLIENT_BOARD_JOBS)), 'Arc Fitness'),
    ).toBeGreaterThan(0);
  });

  it('keeps the row actions, the right-click menu and the note dialog of the Jobs page', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    // Studio tour is approved: its button marks it delivered. Every row is the Jobs list's row (a
    // menu trigger).
    expect(markup).toContain('aria-label="Mark delivered"');
    expect(markup).toMatch(/<li[^>]*data-job-id="j10"[^>]*data-state="closed"/);
    expect(markup).toContain('aria-label="Notifications');
  });

  it('has no status tabs and no search', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('type="search"');
  });

  it('has no Columns menu: the one menu button is the header’s ⋯', async () => {
    const markup = main(await clientPage('Arc Fitness'));
    expect(markup.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="More for Arc Fitness"');
    expect(markup).not.toContain('Columns');
  });

  it('pages the jobs like the Jobs page: ten a page', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeJob({
        id: `big${i}`,
        client: 'Big Co',
        clientId: 'b1b1b1b1b1b1',
        name: `Promo ${i}`,
        relPath: `Big Co/Promo ${i}`,
        addedAt: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
      }),
    );
    const markup = main(await page('/clients/b1b1b1b1b1b1', [...many, ...CLIENT_BOARD_JOBS]));
    expect(rowIds(markup)).toHaveLength(10);
    expect(markup).toContain('1–10 of 12');
    expect(markup).toContain('12 jobs');
  });
});

describe("a client's page: in the Jobs page's state", () => {
  beforeAll(() => {
    // zustand's server render reads the store's initial state; point it at the current one.
    jobsUiStore.getInitialState = () => jobsUiStore.getState();
  });
  afterEach(() => {
    const fresh = defaultJobsUiState();
    jobsUiStore.getState().setStatusTab(fresh.statusTab);
    jobsUiStore.getState().setSearch(fresh.search);
  });

  it('ignores the status tab and the search left on the Jobs page', async () => {
    jobsUiStore.getState().setStatusTab('attention');
    jobsUiStore.getState().setSearch('zzz');
    // The Jobs page would show nothing; the client page does not read either.
    expect(rowIds(await clientPage('Arc Fitness'))).toEqual(['j5', 'j2', 'j10']);
    expect(rowIds(await page('/jobs', CLIENT_BOARD_JOBS))).toEqual([]);
  });
});

describe("a client's page: the way around", () => {
  it('has Clients › <name> in the breadcrumb, Clients linking back', async () => {
    const markup = await clientPage('Arc Fitness');
    const crumbs = markup.slice(
      markup.indexOf('data-slot="breadcrumb"'),
      markup.indexOf('</nav>', markup.indexOf('data-slot="breadcrumb"')),
    );
    expect(crumbs).toMatch(
      /<a[^>]*href="\/clients"[^>]*data-slot="breadcrumb-link"|<a[^>]*data-slot="breadcrumb-link"[^>]*href="\/clients"/,
    );
    expect(crumbs).toMatch(/<a[^>]*>Clients<\/a>/);
    expect(crumbs).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Arc Fitness<\/span>/);
    // Only Clients is a link; the root and the page that is open are not.
    expect(crumbs.match(/<a /g)).toHaveLength(1);
  });

  it('has Clients as the current page in the sidebar', async () => {
    const markup = await clientPage('Arc Fitness');
    const clients =
      markup.match(
        /<a [^>]*href="\/clients"[^>]*data-slot="sidebar-menu-button"[^>]*>|<a [^>]*data-slot="sidebar-menu-button"[^>]*href="\/clients"[^>]*>/,
      )?.[0] ?? '';
    expect(clients).toContain('data-active="true"');
    expect(clients).toContain('aria-current="page"');
  });

  it('reloads on its own address: the page is built from the path alone', async () => {
    const markup = await clientPage('Kova Coffee');
    expect(markup).toMatch(/<h1[^>]*>Kova Coffee<\/h1>/);
  });
});

describe("an address that is no client's", () => {
  it('says "No such client." with a link back to Clients', async () => {
    const markup = main(await page('/clients/nosuchclient', CLIENT_BOARD_JOBS));
    expect(markup).toContain('No such client.');
    expect(markup).toMatch(/<a[^>]*href="\/clients"[^>]*>Back to Clients<\/a>/);
    expect(markup).not.toContain('<ul aria-label="Jobs"');
    expect(markup).not.toContain('<h1');
  });

  it('keeps the breadcrumb on Clients › Client, with Clients a link', async () => {
    const markup = await page('/clients/nosuchclient', CLIENT_BOARD_JOBS);
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Client<\/span>/);
    expect(markup).toMatch(/<a[^>]*data-slot="breadcrumb-link"[^>]*>Clients<\/a>/);
  });

  it('does not say it before the job list has loaded: it cannot tell yet', async () => {
    const markup = main(await page(`/clients/${CLIENT_IDS['Arc Fitness']}`));
    expect(markup).not.toContain('No such client.');
    expect(markup).toContain('<ul aria-label="Jobs"');
    expect(rowIds(markup)).toEqual([]);
  });

  it('says it once the client is not in the client list any more', async () => {
    const withoutArc = CLIENT_BOARD_JOBS.filter((job) => job.client !== 'Arc Fitness');
    expect(main(await clientPage('Arc Fitness', withoutArc))).toContain('No such client.');
  });
});

describe('a client with no jobs yet', () => {
  const FRESH = 'e0e0e0e0e0e0';
  const fresh = makeEmptyClientRow({ clientId: FRESH, client: 'Fresh Co' });
  const freshPage = () => page(`/clients/${FRESH}`, CLIENT_BOARD_JOBS, [fresh]);

  it('has a page: the name, "0 jobs" with no last job, and the Style button', async () => {
    const markup = main(await freshPage());
    expect(markup).toMatch(/<h1[^>]*>Fresh Co<\/h1>/);
    expect(markup).toContain('0 jobs');
    expect(markup).not.toContain('last job');
    expect(markup).not.toContain('<time');
    const button = markup.match(/<a [^>]*data-slot="button"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(button).toContain(`href="/clients/${FRESH}/style"`);
    expect(button).toMatch(/>\s*Style<\/a>$/);
  });

  it('shows "No jobs yet." and where to drop a job, in place of the table', async () => {
    const markup = main(await freshPage());
    expect(markup).toContain('No jobs yet.');
    expect(markup).toContain('Drop a job folder into');
    expect(markup).toContain('Studio Inbox/&lt;client&gt;/&lt;job&gt;');
    expect(markup).toContain('You can set up the style first.');
    expect(markup).not.toContain('<ul aria-label="Jobs"');
    // Nor the Columns menu, which the list no longer has: the header's ⋯ is the one menu button.
    expect(markup.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(markup).not.toContain('Columns');
  });

  it('puts the empty state below the header, after the Style button', async () => {
    const markup = main(await freshPage());
    expect(markup.indexOf('Fresh Co</h1>')).toBeLessThan(markup.indexOf('Style</a>'));
    expect(markup.indexOf('Style</a>')).toBeLessThan(markup.indexOf('No jobs yet.'));
  });

  it('names the client in the breadcrumb, which links back to Clients', async () => {
    const markup = await freshPage();
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Fresh Co<\/span>/);
  });

  it('is not "No such client."', async () => {
    expect(main(await freshPage())).not.toContain('No such client.');
  });

  it('does not show the empty state for a client that has jobs', async () => {
    expect(main(await clientPage('Arc Fitness'))).not.toContain('No jobs yet.');
  });

  describe('that has a delivered video whose folder was deleted (CVP-204)', () => {
    const gone = (paidOn: string | null = null) =>
      makeOrphanDelivery({
        id: 'gone1',
        clientId: FRESH,
        client: 'Fresh Co',
        name: 'History check',
        delivery: makeJobDelivery({ paidOn }),
      });
    const withGone = async (orphans: ReturnType<typeof makeOrphanDelivery>[]) => {
      const client = createTestQueryClient();
      client.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
      client.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS, [fresh]));
      client.setQueryData(ORPHANS_KEY, orphans);
      return main(await renderApp(`/clients/${FRESH}`, client));
    };

    it('lists it, as it is still payable, instead of "No jobs yet."', async () => {
      const markup = await withGone([gone()]);
      expect(rowIds(markup)).toEqual(['gone1']);
      expect(markup).toContain('Folder deleted · Delivered 21 Oct · ₪40 not paid');
      expect(markup).not.toContain('No jobs yet.');
      // Its job count counts folders.
      expect(markup).toContain('0 jobs');
    });

    it('still says "No jobs yet." once it is paid, or when it is another client’s', async () => {
      expect(await withGone([gone('2026-10-23')])).toContain('No jobs yet.');
      const other = makeOrphanDelivery({ id: 'other', clientId: 'someone-else' });
      expect(await withGone([other])).toContain('No jobs yet.');
    });
  });

  it('lets a Hebrew name read right to left', async () => {
    const hebrew = makeEmptyClientRow({ clientId: 'f1f1f1f1f1f1', client: 'לקוח חדש' });
    const markup = main(await page('/clients/f1f1f1f1f1f1', [], [hebrew]));
    expect(markup).toMatch(/<h1[^>]*dir="auto"[^>]*>לקוח חדש<\/h1>/);
    expect(markup).toContain('No jobs yet.');
  });
});
