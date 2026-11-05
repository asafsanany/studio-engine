import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { type ClientSummary, summarizeClients } from '@/features/clients/clients';
import { makeClientRow } from '@/features/clients/test-clients';
import { createTestStore } from '@/features/jobs/test-jobs';
import { renderAt } from '@/lib/test-router';
import { PhoneClientView } from './PhoneClientPage';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function job(id: string, overrides: Partial<Job>): Job {
  return makeJob({
    id,
    clientId: 'rgm',
    client: 'RGM',
    name: `Job ${id}`,
    relPath: `RGM/Job ${id}`,
    state: 'ready',
    ...overrides,
  });
}

// RGM's board: a held job with a note and an effort level, a failed one, an approved one, a paid
// one and an archived paid one; plus another client's job that must not show.
const JOBS: readonly Job[] = [
  job('s1', {
    name: 'טורניר בחירות – הכרזה',
    state: 'held',
    note: 'Keep it short',
    effort: 'high',
    updatedAt: ago(3),
  }),
  job('s2', { name: 'ראיון עם המייסד', state: 'failed', failedAt: 8, updatedAt: ago(25) }),
  job('s3', {
    name: 'טורניר בחירות שש בש',
    approvedAt: ago(70),
    updatedAt: ago(60),
  }),
  job('s4', {
    name: 'ראיון עם השחקן',
    updatedAt: ago(2880),
    delivery: makeJobDelivery({ paidOn: '2026-10-20' }),
  }),
  job('s5', {
    name: 'הכרזת הזוכים',
    updatedAt: ago(11520),
    archivedAt: ago(11000),
    delivery: makeJobDelivery({ paidOn: '2026-10-14' }),
  }),
  job('d1', {
    clientId: 'lakeshore',
    client: 'LAKESHORE',
    name: 'Other client job',
    updatedAt: ago(1),
  }),
];

const RGM: ClientSummary = summarizeClients([
  makeClientRow({ clientId: 'rgm', client: 'RGM', jobs: 5, lastJobAt: ago(3) }),
])[0] as ClientSummary;

interface Options {
  client?: ClientSummary | undefined;
  clientsLoaded?: boolean;
  /** `null` is the list before its first answer. */
  jobs?: readonly Job[] | null;
  showArchived?: boolean;
  failed?: boolean;
  reconnecting?: boolean;
  assignment?: Parameters<typeof PhoneClientView>[0]['assignment'];
}

function render(options: Options = {}) {
  const {
    client = 'client' in options ? options.client : RGM,
    clientsLoaded = true,
    jobs = JOBS,
    showArchived = false,
    failed,
    reconnecting,
    assignment,
  } = options;
  const store = createTestStore();
  store.getState().setShowArchived(showArchived);
  // A static render reads the store's initial state; this one starts from what the test set.
  store.getInitialState = () => store.getState();
  return renderAt(
    '/clients/rgm',
    <PhoneClientView
      clientId="rgm"
      client={client}
      clientsLoaded={clientsLoaded}
      jobs={jobs ?? undefined}
      failed={failed}
      reconnecting={reconnecting}
      assignment={assignment}
      onOpenJob={() => {}}
      store={store}
      skeletonDelayMs={0}
    />,
  );
}

const rowTags = (html: string) => html.match(/<li [^>]*data-job-id="[^"]*"[^>]*>/g) ?? [];
const idsOf = (html: string) => rowTags(html).map((t) => /data-job-id="([^"]*)"/.exec(t)?.[1]);

describe('<PhoneClientView>', () => {
  describe('the header', () => {
    it('has the back link "‹ Clients", 44 px tall, to the list', async () => {
      const html = await render();
      const link = html.match(/<a [^>]*href="\/clients"[^>]*>/)?.[0] ?? '';
      expect(link).toContain('h-11');
      expect(html).toMatch(/lucide-chevron-left[^>]*>[\s\S]*?<\/svg>Clients<\/a>/);
      // 4 px inside on the left, as the board has it: the button's own padding for an icon (px-3)
      // would win over pl-1 unless the same variant carries it.
      expect(link).toContain('has-[&gt;svg]:pl-1');
      expect(link).toContain('has-[&gt;svg]:pr-2.5');
    });

    it('shows a 48 px avatar, the name, and "5 jobs · last job 3 min ago"', async () => {
      const html = await render();
      expect(html).toContain('data-slot="phone-client-header"');
      expect(html).toContain('size-12');
      expect(html).toMatch(/<h1[^>]*>(?:<bdi>)?RGM/);
      expect(html).toMatch(/5 jobs · last job <time[^>]*>3 min ago<\/time>/);
    });

    it('has an outlined Style button to the client’s style', async () => {
      const html = await render();
      const button = html.match(/<a [^>]*href="\/clients\/rgm\/style"[^>]*>/)?.[0] ?? '';
      expect(button).toContain('data-variant="outline"');
      expect(html).toMatch(/lucide-file-text[^>]*>[\s\S]*?<\/svg>Style<\/a>/);
    });
  });

  describe('the jobs', () => {
    it('lists only this client’s jobs, last updated first, archived ones hidden', async () => {
      const html = await render();
      expect(idsOf(html)).toEqual(['s1', 's2', 's3', 's4']);
      expect(html).not.toContain('Other client job');
    });

    it('draws the phone list’s flat rows, without the client in them', async () => {
      const html = await render();
      expect(html).toContain('aria-label="Jobs of RGM"');
      expect(rowTags(html)[0]).not.toContain('data-tree');
      // The second line starts with the detail, not the client's name.
      expect(html).not.toMatch(/<bdi>RGM<\/bdi> · /);
    });

    it('has no status tabs and no search field', async () => {
      const html = await render();
      expect(html).not.toContain('role="tablist"');
      expect(html).not.toContain('type="search"');
    });

    it('keeps the next-step buttons of the rows (Release on a held job, Retry on a failed one)', async () => {
      const html = await render();
      expect(html).toContain('aria-label="Release"');
      expect(html).toContain('aria-label="Retry from');
    });
  });

  describe('the archive line', () => {
    it('offers the archived jobs: "1 archived · Show"', async () => {
      const html = await render();
      expect(html).toMatch(/1 archived ·<button[^>]*>Show<\/button>/);
    });

    it('lists them with Show archived on, and offers "Hide archived"', async () => {
      const html = await render({ showArchived: true });
      expect(idsOf(html)).toEqual(['s1', 's2', 's3', 's4', 's5']);
      expect(html).toMatch(/1 archived shown ·<button[^>]*>Hide archived<\/button>/);
      expect(rowTags(html).at(-1)).toContain('data-archived');
    });

    it('is not there for a client with nothing archived', async () => {
      const html = await render({ jobs: JOBS.filter((j) => j.id !== 's5') });
      expect(html).not.toMatch(/\d+ archived/);
      expect(html).not.toContain('Hide archived');
    });
  });

  describe('states', () => {
    it('says "No jobs yet." for a client with no job at all', async () => {
      const html = await render({ jobs: JOBS.filter((j) => j.clientId !== 'rgm') });
      expect(html).toContain('No jobs yet.');
      expect(idsOf(html)).toEqual([]);
    });

    it('says "No matching jobs." when the only jobs are archived and hidden, and offers them', async () => {
      const html = await render({ jobs: JOBS.filter((j) => j.id === 's5') });
      expect(html).toContain('No matching jobs.');
      expect(html).toMatch(/1 archived ·<button[^>]*>Show<\/button>/);
    });

    it('draws a skeleton for the header and the rows while the lists are on their way', async () => {
      const html = await render({ client: undefined, clientsLoaded: false, jobs: null });
      expect(html).not.toContain('phone-client-header');
      expect(html).toContain('data-slot="skeleton"');
      expect(html).not.toContain('No such client');
    });

    it('draws the rows’ skeleton under the header while only the jobs are on their way', async () => {
      const html = await render({ jobs: null });
      expect(html).toContain('phone-client-header');
      expect(html).toContain('data-skeleton-row');
    });

    it('says "No such client." for an id the client list does not hold', async () => {
      const html = await render({ client: undefined });
      expect(html).toContain('No such client.');
      expect(html).toContain('Back to Clients');
      expect(html).not.toContain('phone-client-header');
    });

    it('says the engine is out of reach before anything has arrived', async () => {
      const html = await render({
        client: undefined,
        clientsLoaded: false,
        jobs: null,
        failed: true,
      });
      expect(html).toContain('Can&#x27;t reach the engine.');
      expect(html).toContain('Try again');
      expect(html).not.toContain('No such client');
    });

    it('shows the "Reconnecting to the engine…" line when asked', async () => {
      expect(await render({ reconnecting: true })).toContain('Reconnecting to the engine');
    });
  });
});

describe('<PhoneClientView>: Assign to… (Team plan, TM5)', () => {
  const assignRow = (html: string) =>
    html.match(/<button [^>]*data-slot="phone-client-assign"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  const text = (markup: string) => markup.replace(/<[^>]*>/g, '').replace(/<!-- -->/g, '');

  it('has no Assign to… row for an editor (no assignment)', async () => {
    const html = await render();
    expect(html).not.toContain('Assign to');
    expect(html).not.toContain('phone-client-assign');
  });

  it('gives the admin an Assign to… row under the header, 48 px tall, with who the client is assigned to', async () => {
    const html = await render({ assignment: { names: ['Yael', 'Amit'], onAssign: () => {} } });
    const row = assignRow(html);
    expect(row).toContain('min-h-12');
    expect(row).toContain('lucide-user-plus');
    expect(text(row)).toBe('Assign to…Yael, Amit');
    // After the header, before the jobs.
    expect(html.indexOf('phone-client-header')).toBeLessThan(html.indexOf('phone-client-assign'));
    expect(html.indexOf('phone-client-assign')).toBeLessThan(html.indexOf('data-job-id'));
  });

  it('says Unassigned for a client only the admin sees, and nothing until the team is known', async () => {
    expect(text(assignRow(await render({ assignment: { names: [], onAssign: () => {} } })))).toBe(
      'Assign to…Unassigned',
    );
    const waiting = assignRow(
      await render({ assignment: { names: undefined, onAssign: () => {} } }),
    );
    expect(text(waiting)).toBe('Assign to…');
  });

  it('shows no row for a client that is not known', async () => {
    const html = await render({
      client: undefined,
      assignment: { names: [], onAssign: () => {} },
    });
    expect(html).not.toContain('phone-client-assign');
  });
});
