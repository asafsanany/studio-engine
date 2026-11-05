import { type ClientStyleResponse, noClientStyle } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { clientStyleKey } from '@/data/client-style';
import { CLIENTS_KEY } from '@/data/clients-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createTestQueryClient } from '@/data/test-utils';
import {
  CLIENT_BOARD_JOBS,
  CLIENT_BOARD_ROWS,
  makeEmptyClientRow,
} from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import { renderApp } from '@/lib/test-router';

const KOVA = CLIENT_IDS['Kova Coffee'];
const NOA = CLIENT_IDS['Noa Ceramics'];

const MARKDOWN = `# Style: Kova Coffee
Learned from השקת תפריט חדש (20 Oct 2026).
## Look
- Colours: orange #EA580C (accent)
- Fonts: Rubik 700 for titles
## Don’t
- Show prices
`;

/** The server's answer for a client whose style is `ready`, with `overrides` on top. */
function style(
  clientId: string,
  client: string,
  overrides: Partial<ClientStyleResponse> = {},
): ClientStyleResponse {
  return {
    ...noClientStyle(clientId, client),
    state: 'ready',
    version: 3,
    updatedAt: '2026-10-20T13:30:00.000Z',
    markdown: MARKDOWN,
    ...overrides,
  };
}

/** A client folder with no jobs: the one "New client" has just made. */
const FRESH_CLIENT = makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' });

/** The Style page at `path`, over a job list and the cached style (when there is one). */
async function page(
  clientId: string,
  cached?: ClientStyleResponse,
  path = `/clients/${clientId}/style`,
) {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
  client.setQueryData(CLIENTS_KEY, [...CLIENT_BOARD_ROWS, FRESH_CLIENT]);
  if (cached !== undefined) client.setQueryData(clientStyleKey(clientId), cached);
  return renderApp(path, client);
}

/** The page's own part: what is inside <main>. */
const main = (markup: string) => markup.slice(markup.indexOf('<main'));

describe('the Style page: a client with a style.md', () => {
  it('draws style.md in a 680 px column, flush left', async () => {
    const markup = main(await page(KOVA, style(KOVA, 'Kova Coffee')));
    expect(markup).toMatch(/<article[^>]*class="[^"]*max-w-\[680px\]/);
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
    expect(markup).toMatch(/<h2[^>]*>Look<\/h2>/);
    expect(markup).toContain('Rubik 700 for titles');
    // It is the rendered document, not its Markdown source.
    expect(markup).not.toContain('# Style: Kova Coffee');
  });

  it('says when it was updated, above the document, with the exact time in a tooltip', async () => {
    const markup = main(await page(KOVA, style(KOVA, 'Kova Coffee')));
    expect(markup).toContain('style.md');
    expect(markup).toContain(' · updated ');
    expect(markup).toContain('<time dateTime="2026-10-20T13:30:00.000Z"');
    expect(markup).toContain('first-letter:lowercase');
    expect(markup.indexOf('· updated')).toBeLessThan(markup.indexOf('<h1'));
  });

  it('leaves "updated" out for a style.md that no run has written (a hand-made one)', async () => {
    const markup = main(
      await page(KOVA, style(KOVA, 'Kova Coffee', { updatedAt: null, state: 'none', version: 0 })),
    );
    expect(markup).toContain('style.md');
    expect(markup).not.toContain('updated');
  });

  it('has the Add style files button on the right of that line, a label around a file input', async () => {
    const markup = main(await page(KOVA, style(KOVA, 'Kova Coffee')));
    expect(markup).toMatch(
      /<label[^>]*data-variant="outline"[^>]*>[\s\S]*lucide-upload[\s\S]*Add style files<input[^>]*type="file"[^>]*multiple/,
    );
    expect(markup.indexOf('· updated')).toBeLessThan(markup.indexOf('Add style files'));
    expect(markup.indexOf('Add style files')).toBeLessThan(markup.indexOf('<h1'));
  });

  it('shows no status line when nothing is going on, no dialog and no overlay', async () => {
    const markup = main(await page(KOVA, style(KOVA, 'Kova Coffee')));
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('Drop files to add them to the style');
    expect(markup).not.toContain('No style yet');
  });

  it('keeps a Hebrew client’s style readable: the title and lines pick their own direction', async () => {
    const markup = main(
      await page(
        CLIENT_IDS['מאפיית הצפון'],
        style(CLIENT_IDS['מאפיית הצפון'], 'מאפיית הצפון', {
          markdown: '# Style: מאפיית הצפון\n## Look\n- צבעים: חום\n',
        }),
      ),
    );
    expect(markup).toMatch(/<h1 dir="auto"[^>]*>Style: מאפיית הצפון<\/h1>/);
    expect(markup).toMatch(/<li dir="auto"[^>]*>צבעים: חום<\/li>/);
  });
});

describe('the Style page: the status line', () => {
  it('says the files are being analysed, with their number, over the document', async () => {
    const markup = main(
      await page(
        KOVA,
        style(KOVA, 'Kova Coffee', {
          state: 'analysing',
          pass: { kind: 'read', mode: 'add', fileCount: 3, jobId: null, job: null },
        }),
      ),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Analysing 3 files. style.md updates when it’s done.');
    expect(markup).toContain('lucide-loader-circle');
    // The old style.md stays until the new one is written.
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
    expect(markup.indexOf('Analysing 3 files')).toBeLessThan(markup.indexOf('<h1'));
  });

  it('says which job the style is being learned from, for a Learn pass', async () => {
    const markup = main(
      await page(
        KOVA,
        style(KOVA, 'Kova Coffee', {
          state: 'analysing',
          pass: { kind: 'learn', mode: 'replace', fileCount: 0, jobId: 'j6', job: 'Spring promo' },
        }),
      ),
    );
    expect(markup).toContain('Learning the style from <bdi>Spring promo</bdi>.');
  });

  it('shows the error of a failed run, with Retry', async () => {
    const markup = main(
      await page(
        KOVA,
        style(KOVA, 'Kova Coffee', {
          state: 'failed',
          error: 'Style stopped: the first line is wrong.',
        }),
      ),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Style stopped: the first line is wrong.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
  });
});

describe('the Style page: a client with no style.md', () => {
  const none = style(NOA, 'Noa Ceramics', {
    state: 'none',
    version: 0,
    updatedAt: null,
    markdown: null,
  });

  it('is the centred drop zone with Browse files, and no document', async () => {
    const markup = main(await page(NOA, none));
    expect(markup).toContain('data-slot="style-drop-zone"');
    expect(markup).toMatch(/<h2[^>]*>No style yet<\/h2>/);
    expect(markup).toMatch(/<label[^>]*>Browse files<input[^>]*type="file"[^>]*multiple/);
    expect(markup).toContain('or drop files here');
    expect(markup).not.toContain('<article');
    expect(markup).not.toContain('Add style files');
  });

  it('shows the analysis in the drop zone in place of its invitation', async () => {
    const markup = main(
      await page(NOA, {
        ...none,
        state: 'analysing',
        pass: { kind: 'read', mode: 'create', fileCount: 2, jobId: null, job: null },
      }),
    );
    expect(markup).toContain('data-slot="style-drop-zone"');
    expect(markup).toMatch(
      /<div role="status"><h2[^>]*>Analysing 2 files\. style\.md updates when it’s done\.<\/h2><\/div>/,
    );
    expect(markup).toContain('style.md appears here when it’s done.');
    expect(markup).not.toContain('No style yet');
    expect(markup).not.toContain('Browse files');
    // The words are in the box, not in a line above it.
    expect(markup.match(/Analysing 2 files/g)).toHaveLength(1);
  });

  it('shows the first job’s Learn pass in the drop zone too', async () => {
    const markup = main(
      await page(NOA, {
        ...none,
        state: 'analysing',
        pass: { kind: 'learn', mode: 'create', fileCount: 0, jobId: 'j13', job: 'Kiln opening' },
      }),
    );
    expect(markup).toContain('Learning the style from <bdi>Kiln opening</bdi>.');
    expect(markup).not.toContain('Browse files');
  });

  it('keeps the drop zone, with the error above it, when the first style run failed', async () => {
    const markup = main(
      await page(NOA, { ...none, state: 'failed', error: 'Style stopped: it timed out.' }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Style stopped: it timed out.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(markup).toContain('Browse files');
    expect(markup.indexOf('Style stopped')).toBeLessThan(markup.indexOf('No style yet'));
  });

  it('treats a missing style.md as none whatever the state says', async () => {
    const markup = main(await page(NOA, { ...none, state: 'ready', version: 2 }));
    expect(markup).toContain('No style yet');
  });
});

describe('the Style page: the way around', () => {
  it('has Clients › <client> › Style in the breadcrumb: the first two link, the last is the page', async () => {
    const markup = await page(KOVA, style(KOVA, 'Kova Coffee'));
    const start = markup.indexOf('data-slot="breadcrumb"');
    const crumbs = markup.slice(start, markup.indexOf('</nav>', start));

    expect(crumbs).toMatch(/<a[^>]*href="\/clients"[^>]*>Clients<\/a>/);
    expect(crumbs).toMatch(new RegExp(`<a[^>]*href="/clients/${KOVA}"[^>]*>Kova Coffee</a>`));
    expect(crumbs).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Style<\/span>/);
    expect(crumbs.match(/<a /g)).toHaveLength(2);
  });

  it('has Clients as the current page in the sidebar', async () => {
    const markup = await page(KOVA, style(KOVA, 'Kova Coffee'));
    const clients =
      markup.match(
        /<a [^>]*href="\/clients"[^>]*data-slot="sidebar-menu-button"[^>]*>|<a [^>]*data-slot="sidebar-menu-button"[^>]*href="\/clients"[^>]*>/,
      )?.[0] ?? '';
    expect(clients).toContain('aria-current="page"');
  });

  it('is built from the address alone, so a reload comes back to the same page', async () => {
    const markup = main(await page(KOVA, style(KOVA, 'Kova Coffee'), `/clients/${KOVA}/style`));
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
  });
});

/**
 * A query client in which the style of `clientId` has been asked for and failed with `error`. A
 * query that failed is asked again when a page mounts (and looks "loading" meanwhile); this one is
 * left as it is, which is how it looks once the second try has failed too.
 */
function failed(clientId: string, error: ApiError) {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
  client.setQueryData(CLIENTS_KEY, CLIENT_BOARD_ROWS);
  client.setQueryDefaults(clientStyleKey(clientId), { retryOnMount: false });
  client
    .getQueryCache()
    .build(client, { queryKey: clientStyleKey(clientId) })
    .setState({
      status: 'error',
      fetchStatus: 'idle',
      error,
      data: undefined,
    });
  return client;
}

describe('the Style page: before and without an answer', () => {
  it('shows nothing until the style has loaded, then a skeleton only after a moment', async () => {
    const markup = main(await page(KOVA));
    expect(markup).not.toContain('<article');
    expect(markup).not.toContain('No style yet');
    expect(markup).not.toContain('No such client.');
    expect(markup).not.toContain('data-slot="skeleton"');
  });

  it('says "No such client." with a link back to Clients for an id the engine does not know', async () => {
    const client = failed('nosuchclient', new ApiError(404, 'Client nosuchclient not found'));
    const markup = main(await renderApp('/clients/nosuchclient/style', client));
    expect(markup).toContain('No such client.');
    expect(markup).toMatch(/<a[^>]*href="\/clients"[^>]*>Back to Clients<\/a>/);
    expect(markup).not.toContain('<article');
  });

  it('says "Can’t reach the engine." when the style cannot be fetched', async () => {
    const client = failed(KOVA, new ApiError(0, 'Cannot reach the Studio Engine server.'));
    const markup = main(await renderApp(`/clients/${KOVA}/style`, client));
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>Can&#x27;t reach the engine\.<\/p>/);
    expect(markup).not.toContain('No such client.');
  });
});

describe('the Style page: a client with no jobs yet', () => {
  const FRESH = FRESH_CLIENT.clientId;

  it('shows the drop zone, ready for the first files', async () => {
    const markup = main(await page(FRESH, { ...noClientStyle(FRESH, 'Fresh Co'), markdown: null }));
    expect(markup).toContain('No style yet');
    expect(markup).toContain('Browse files');
    expect(markup).toContain('or drop files here');
    expect(markup).not.toContain('No such client.');
  });

  it('has Clients › <client> › Style in the breadcrumb, naming a client that has no jobs', async () => {
    const markup = await page(FRESH, { ...noClientStyle(FRESH, 'Fresh Co'), markdown: null });
    const start = markup.indexOf('data-slot="breadcrumb"');
    const crumbs = markup.slice(start, markup.indexOf('</nav>', start));
    expect(crumbs).toContain('>Fresh Co</a>');
    expect(crumbs).toContain(`href="/clients/${FRESH}"`);
    expect(crumbs).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Style<\/span>/);
  });

  it('shows the style.md once the first files have been read into one', async () => {
    const markup = main(
      await page(FRESH, style(FRESH, 'Fresh Co', { markdown: '# Style: Fresh Co\n' })),
    );
    expect(markup).toMatch(/<h1[^>]*>Style: Fresh Co<\/h1>/);
  });
});
