import type { ClientRow, Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { CLIENTS_KEY } from '@/data/clients-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { TEAM_KEY } from '@/data/team-query';
import { createEditorQueryClient, createTestQueryClient, makeTeam } from '@/data/test-utils';
import {
  CLIENT_BOARD_JOBS,
  clientRowsOf,
  makeEmptyClientRow,
} from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import { renderApp } from '@/lib/test-router';

/** The app at `path` with the job list loaded, and the client list the server would send for it. */
async function page(path: string, jobs?: readonly Job[], extraClients: readonly ClientRow[] = []) {
  const client = createTestQueryClient();
  if (jobs !== undefined) {
    client.setQueryData(JOBS_KEY, jobs);
    client.setQueryData(CLIENTS_KEY, clientRowsOf(jobs, extraClients));
  }
  return renderApp(path, client);
}

describe('/clients', () => {
  it('shows the title, then the search box, then the table of clients', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    const title = markup.indexOf('<h1');
    const search = markup.indexOf('type="search"');
    const table = markup.indexOf('<table');
    expect(markup).toMatch(/<h1[^>]*>Clients<\/h1>/);
    expect(title).toBeGreaterThanOrEqual(0);
    expect(title).toBeLessThan(search);
    expect(search).toBeLessThan(table);
    expect(markup).toContain('placeholder="Search clients"');
    expect(markup).toContain('>Search clients</label>');
  });

  it('lists the clients of the client list', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    for (const name of ['Arc Fitness', 'Kova Coffee', 'Noa Ceramics', 'מאפיית הצפון']) {
      expect(markup).toContain(name);
    }
    expect(markup).toContain('7 clients');
    // Not the jobs: the table is the clients'.
    expect(markup).not.toContain('Coach intro reel');
  });

  it('opens a client from its row', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    expect(markup).toContain(`href="/clients/${CLIENT_IDS['Arc Fitness']}"`);
  });

  it('has Clients as the current page in the sidebar and as the last step of the breadcrumb', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    const sidebarLink = markup.match(/<a [^>]*href="\/clients"[^>]*>/)?.[0] ?? '';
    expect(sidebarLink).toContain('aria-current="page"');
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Clients<\/span>/);
    // The only link back to Jobs is the sidebar's.
    expect(markup).not.toMatch(/<a [^>]*data-slot="breadcrumb-link"/);
  });

  it('keeps the engine summary in the header', async () => {
    expect(await page('/clients', CLIENT_BOARD_JOBS)).toContain('aria-label="Engine summary"');
  });

  it('has New client at the right of the toolbar: an outline button with a plus, after the search', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    const button =
      markup.match(/<button [^>]*data-slot="dialog-trigger"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('data-variant="outline"');
    expect(button).toContain('lucide-plus');
    expect(button).toMatch(/>\s*New client<\/button>$/);
    expect(button).toContain('aria-haspopup="dialog"');
    // In the row of the search box, which comes first, and above the table.
    expect(markup.indexOf('type="search"')).toBeLessThan(markup.indexOf(button));
    expect(markup.indexOf(button)).toBeLessThan(markup.indexOf('<table'));
    // The search box and the button are the two ends of one row.
    const toolbar = markup.indexOf('class="flex flex-wrap items-center justify-between gap-3"');
    expect(toolbar).toBeGreaterThan(-1);
    expect(toolbar).toBeLessThan(markup.indexOf('type="search"'));
  });

  it('does not show the dialog until the button is pressed', async () => {
    const markup = await page('/clients', CLIENT_BOARD_JOBS);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('Cancel');
  });

  it('lists a client with no jobs: 0 jobs, a dash for the last job, a link to its page', async () => {
    const fresh = makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' });
    const markup = await page('/clients', CLIENT_BOARD_JOBS, [fresh]);
    const row = markup.match(/<tr[^>]*data-client-id="e0e0e0e0e0e0"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(row).toContain('Fresh Co');
    expect(row).toMatch(/<div class="tabular-nums">0<\/div>/);
    expect(row).toContain('>—<');
    expect(row).toContain('href="/clients/e0e0e0e0e0e0"');
    expect(markup).toContain('8 clients');
  });

  it('shows a lone client with no jobs rather than "No clients yet."', async () => {
    const fresh = makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' });
    const markup = await page('/clients', [], [fresh]);
    expect(markup).toContain('Fresh Co');
    expect(markup).toContain('1 client');
    expect(markup).not.toContain('No clients yet.');
  });

  it('says "No clients yet." when the inbox holds no client folder, with New client still there', async () => {
    const markup = await page('/clients', []);
    expect(markup).toContain('No clients yet.');
    expect(markup).toContain('data-slot="dialog-trigger"');
  });

  it('waits for the list the way the Jobs page does: the frame and header, no rows', async () => {
    const markup = await page('/clients');
    expect(markup).toContain('<table');
    expect(markup).toContain('>Last job');
    expect(markup).not.toContain('data-client-id');
    expect(markup).not.toContain('No clients yet.');
  });
});

describe('/jobs and /', () => {
  it.each(['/', '/jobs'])('%s is the Jobs page', async (path) => {
    const markup = await page(path, CLIENT_BOARD_JOBS);
    expect(markup).toMatch(/<h1[^>]*>Jobs<\/h1>/);
    expect(markup).toContain('Coach intro reel');
    expect(markup).toContain('role="tablist"');
    const sidebarLink = markup.match(/<a [^>]*href="\/jobs"[^>]*>/)?.[0] ?? '';
    expect(sidebarLink).toContain('aria-current="page"');
  });
});

describe('an address that is no page', () => {
  it('says so, with a way back to Jobs, inside the app frame', async () => {
    const markup = await page('/nowhere', CLIENT_BOARD_JOBS);
    expect(markup).toContain('No such page.');
    expect(markup).toContain('href="/jobs"');
    expect(markup).toContain('aria-label="Main"');
    // Neither sidebar link is current; the breadcrumb says where the person is.
    expect(markup).not.toMatch(/<a [^>]*data-slot="sidebar-menu-button"[^>]*aria-current/);
    expect(markup).toContain('Page not found');
  });
});

describe('/clients: the Assigned to column (Team plan, TM5)', () => {
  const YAEL_ARC = makeTeam({
    assignments: {
      [CLIENT_IDS['Arc Fitness']]: { client: 'Arc Fitness', editors: ['yael@example.com'] },
    },
  });

  it('shows the admin the column, with who each client is assigned to and a muted Unassigned', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
    queryClient.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS, []));
    queryClient.setQueryData(TEAM_KEY, YAEL_ARC);
    const markup = await renderApp('/clients', queryClient);
    expect(markup).toContain('>Assigned to<');
    const arc =
      markup.match(
        new RegExp(`<tr[^>]*data-client-id="${CLIENT_IDS['Arc Fitness']}"[\\s\\S]*?</tr>`),
      )?.[0] ?? '';
    expect(arc).toContain('Yael');
    expect(arc).not.toContain('Unassigned');
    expect(markup).toContain('>Unassigned<');
  });

  /** The admin's Clients page with this team in the cache (`undefined`: the team is not known yet). */
  async function adminPage(team: ReturnType<typeof makeTeam> | undefined) {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
    queryClient.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS, []));
    if (team !== undefined) queryClient.setQueryData(TEAM_KEY, team);
    return renderApp('/clients', queryClient);
  }

  it('leaves the column out when the team has no editor and no client is assigned', async () => {
    const markup = await adminPage(
      makeTeam({
        users: [{ email: 'owner@example.com', name: 'The owner', role: 'admin' }],
        assignments: {},
      }),
    );
    expect(markup).not.toContain('Assigned to');
    expect(markup).not.toContain('Unassigned');
    // The page itself is there: the three columns of the Clients board.
    expect(markup).toContain('>Last job<');
  });

  it('keeps it when the team has an editor, even before any client is assigned to them', async () => {
    const markup = await adminPage(makeTeam({ assignments: {} }));
    expect(markup).toContain('>Assigned to<');
    expect(markup).toContain('>Unassigned<');
  });

  it('keeps it for a client assigned to a login that has left the team', async () => {
    const markup = await adminPage(
      makeTeam({
        users: [{ email: 'owner@example.com', name: 'The owner', role: 'admin' }],
        assignments: {
          [CLIENT_IDS['Arc Fitness']]: { client: 'Arc Fitness', editors: ['ghost@example.com'] },
        },
      }),
    );
    expect(markup).toContain('>Assigned to<');
    expect(markup).toContain('ghost@example.com');
  });

  it('holds the column’s place until the team has answered', async () => {
    expect(await adminPage(undefined)).toContain('>Assigned to<');
  });

  it('leaves it out when the team could not be read (an engine without the route, a failure)', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
    queryClient.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS, []));
    // A server render would try the failed team again on mount, which is a pending one.
    queryClient.setQueryDefaults(TEAM_KEY, { retryOnMount: false });
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: TEAM_KEY })
      .setState({
        status: 'error',
        fetchStatus: 'idle',
        error: new ApiError(404, 'No team here.'),
      });
    const markup = await renderApp('/clients', queryClient);
    expect(markup).not.toContain('Assigned to');
    expect(markup).not.toContain('Unassigned');
  });

  it('shows an editor no such column and no Unassigned, whatever the cache holds', async () => {
    const queryClient = createEditorQueryClient();
    queryClient.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
    queryClient.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS, []));
    queryClient.setQueryData(TEAM_KEY, YAEL_ARC);
    const markup = await renderApp('/clients', queryClient);
    expect(markup).not.toContain('Assigned to');
    expect(markup).not.toContain('Unassigned');
  });
});
