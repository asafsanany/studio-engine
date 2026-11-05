import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { createTestStore } from '@/features/jobs/test-jobs';
import { renderAt } from '@/lib/test-router';
import { createMemoryStorage, type StatusTab } from '@/stores/jobs-ui';
import { PhoneJobsView } from './PhoneJobsPage';
import { createPhoneUiStore } from './phone-ui';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function job(id: string, overrides: Partial<Job>): Job {
  return makeJob({
    id,
    clientId: 'acme',
    client: 'Acme',
    name: `Job ${id}`,
    relPath: `Acme/Job ${id}`,
    state: 'ready',
    ...overrides,
  });
}

// Three clients, in order of their latest activity: RGM (3 min ago), Acme (10 min) and a Hebrew one
// (20 min). Acme has an archived paid video; the Hebrew client has a video in Review (no
// next-step icon until Mobile 2) and a delivered one (Mark paid…).
const JOBS: readonly Job[] = [
  job('s1', {
    clientId: 'rgm',
    client: 'RGM',
    name: 'Election promo',
    state: 'held',
    note: 'Keep it short',
    effort: 'high',
    updatedAt: ago(3),
  }),
  job('a1', { name: 'Spring promo', updatedAt: ago(10) }),
  job('a2', {
    name: 'Broken render',
    state: 'failed',
    failedAt: 8,
    updatedAt: ago(30),
  }),
  job('a3', {
    name: 'Old reel',
    updatedAt: ago(600),
    archivedAt: ago(500),
    delivery: makeJobDelivery({ paidOn: '2026-10-14' }),
  }),
  job('h1', {
    clientId: 'heb',
    client: 'עו״ד דוד לוי',
    name: 'מיתוס או אמת 6',
    state: 'review',
    updatedAt: ago(20),
  }),
  job('h2', {
    clientId: 'heb',
    client: 'עו״ד דוד לוי',
    name: 'מיתוס או אמת 5',
    updatedAt: ago(60),
    delivery: makeJobDelivery({ deliveredAt: '2026-10-21T09:00:00.000Z' }),
  }),
];

interface Options {
  /** `null` is the list before its first answer. */
  jobs?: readonly Job[] | null;
  byClient?: boolean;
  tab?: StatusTab;
  search?: string;
  showArchived?: boolean;
  reconnecting?: boolean;
  failed?: boolean;
}

async function render({
  jobs = JOBS,
  byClient = true,
  tab,
  search = '',
  showArchived = false,
  reconnecting,
  failed,
}: Options = {}) {
  const store = createTestStore();
  if (tab !== undefined) store.getState().setStatusTab(tab);
  store.getState().setSearch(search);
  store.getState().setShowArchived(showArchived);
  const phoneStore = createPhoneUiStore(createMemoryStorage());
  phoneStore.getState().setByClient(byClient);
  phoneStore.getInitialState = () => phoneStore.getState();
  return renderAt(
    '/jobs',
    <PhoneJobsView
      jobs={jobs ?? undefined}
      failed={failed}
      reconnecting={reconnecting}
      onOpenJob={() => {}}
      store={store}
      phoneStore={phoneStore}
      skeletonDelayMs={0}
    />,
  );
}

/** The `<li>` tags of the job rows, in order. */
const rowTags = (html: string) => html.match(/<li [^>]*data-job-id="[^"]*"[^>]*>/g) ?? [];
const idsOf = (html: string) => rowTags(html).map((tag) => /data-job-id="([^"]*)"/.exec(tag)?.[1]);

describe('<PhoneJobsView>', () => {
  describe('the header', () => {
    it('is "Jobs" with the View, Search and Settings buttons, each 44 px', async () => {
      const html = await render();
      expect(html).toContain('data-slot="phone-jobs-page"');
      expect(html).toMatch(/<h1[^>]*>Jobs<\/h1>/);
      for (const name of ['View', 'Search jobs and clients', 'Settings']) {
        const tag = html.match(new RegExp(`<(?:button|a)[^>]*aria-label="${name}"[^>]*>`))?.[0];
        expect(tag, name).toBeDefined();
        expect(tag, name).toContain('size-11');
      }
    });

    it('sends the gear to the phone Settings page', async () => {
      const html = await render();
      const gear = html.match(/<a[^>]*aria-label="Settings"[^>]*>/)?.[0];
      expect(gear).toContain('href="/settings"');
    });

    it('says "Reconnecting to the engine…" once the engine has been out of reach', async () => {
      expect(await render({ reconnecting: true })).toContain('Reconnecting to the engine…');
      expect(await render()).not.toContain('Reconnecting to the engine…');
    });
  });

  describe('the status tabs', () => {
    /** Each tab's words and count ("Review 1"), in order. A tab's text follows its last attribute. */
    const tabTexts = (html: string) =>
      html
        .split('data-radix-collection-item="">')
        .slice(1)
        .map((part) =>
          (part.split('</button>')[0] ?? '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        );

    it('are the Mac’s eight, with their counts', async () => {
      expect(tabTexts(await render())).toEqual([
        'All 5',
        'In progress 0',
        'Review 1',
        'Approved 1',
        'Delivered 1',
        'Uploaded 0',
        'Paid 0',
        'Needs attention 2',
      ]);
    });

    it('count the archived videos only with Show archived on', async () => {
      const texts = tabTexts(await render({ showArchived: true }));
      expect(texts).toContain('Paid 1');
      expect(texts).toContain('All 6');
    });

    it('leave the counts out until the list has loaded', async () => {
      const html = await render({ jobs: null });
      expect(html).not.toContain('tabs-trigger-count');
    });

    it('scroll sideways', async () => {
      expect(await render()).toContain('overflow-x-auto');
    });
  });

  describe('By client', () => {
    it('puts each client’s jobs under its name, clients in order of latest activity', async () => {
      const html = await render();
      const sections = html.match(/<section aria-label="[^"]*"/g);
      expect(sections).toEqual([
        '<section aria-label="RGM"',
        '<section aria-label="Acme"',
        '<section aria-label="עו״ד דוד לוי"',
      ]);
      expect(idsOf(html)).toEqual(['s1', 'a1', 'a2', 'h1', 'h2']);
    });

    it('gives each client a header: the avatar, a link to its page and how many jobs', async () => {
      const html = await render();
      expect(html).toContain('href="/clients/acme"');
      expect(html).toContain('href="/clients/heb"');
      expect(html).toContain('data-size="sm"');
      expect(html).toMatch(
        /href="\/clients\/acme"[^>]*>.*?<bdi[^>]*>Acme<\/bdi><\/a><span[^>]*>2<\/span>/,
      );
      expect(html).toMatch(
        /href="\/clients\/rgm"[^>]*>.*?<bdi[^>]*>RGM<\/bdi><\/a><span[^>]*>1<\/span>/,
      );
    });

    it('sets the name and the count as text in the room left of the avatar, so a short name never splits', async () => {
      const html = await render();
      // A box sized to the name (an inline-flex link) split a short Hebrew name in Safari.
      const link = /<a [^>]*href="\/clients\/heb"[^>]*>/.exec(html)?.[0] ?? '';
      expect(link).not.toContain('inline-flex');
      expect(link).not.toContain('min-w-0');
      expect(html).toMatch(/<div class="min-w-0 flex-1 break-words"><a [^>]*href="\/clients\/heb"/);
      expect(html).not.toMatch(/<bdi class="break-words"/);
    });

    it('marks the rows first, middle and last, and a lone row only', async () => {
      const html = await render({ showArchived: true });
      // Acme has three jobs with the archived one shown; RGM and the Hebrew client are 1 and 2.
      const positions = rowTags(html).map((tag) => /data-tree="([^"]*)"/.exec(tag)?.[1]);
      expect(positions).toEqual(['only', 'first', 'middle', 'last', 'first', 'last']);
    });

    it('draws an elbow into every row and carries the line on to the next job only', async () => {
      const html = await render({ showArchived: true });
      const rows = html.split(/(?=<li [^>]*data-job-id=)/).slice(1);
      const elbows = rows.map((row) => (row.match(/rounded-bl-\[7px\]/g) ?? []).length);
      const carried = rows.map((row) => /top-1\/2 bottom-0 left-\[27\.5px\]/.test(row));
      expect(elbows).toEqual([1, 1, 1, 1, 1, 1]);
      // s1 is alone; a1 and a2 are followed by another; a3 is the last; h1 is followed; h2 is last.
      expect(carried).toEqual([false, true, true, false, true, false]);
    });

    it('runs the client’s line from the header, 2 px below the avatar', async () => {
      const html = await render();
      expect((html.match(/top-\[34px\] bottom-0 left-\[27\.5px\]/g) ?? []).length).toBe(3);
    });

    it('indents the rows 44 px and leaves the client out of the second line', async () => {
      const html = await render();
      for (const tag of rowTags(html)) expect(tag).toContain('pl-11');
      const row = html
        .split(/(?=<li [^>]*data-job-id=)/)
        .find((part) => part.includes('data-job-id="a1"'));
      expect(row).toBeDefined();
      expect(row).not.toContain('<bdi>Acme</bdi>');
    });
  });

  describe('the flat list', () => {
    it('lists every job, last updated first, with no client headers and no tree', async () => {
      const html = await render({ byClient: false });
      expect(idsOf(html)).toEqual(['s1', 'a1', 'h1', 'a2', 'h2']);
      expect(html).not.toContain('<section');
      expect(html).not.toContain('data-tree');
      expect(html).not.toContain('rounded-bl-[7px]');
      for (const tag of rowTags(html)) expect(tag).toContain('pl-4');
    });

    it('starts the second line with the client: "client · detail · time"', async () => {
      const html = await render({ byClient: false });
      const row = html
        .split(/(?=<li [^>]*data-job-id=)/)
        .find((part) => part.includes('data-job-id="a1"'));
      expect(row).toContain('<bdi>Acme</bdi> · <span data-slot="job-detail"');
      expect(row).toContain(`<time dateTime="${ago(10)}" class="whitespace-nowrap">`);
    });

    it('wraps a long name and the second line instead of cutting them off', async () => {
      const html = await render({ byClient: false });
      const row =
        html.split(/(?=<li [^>]*data-job-id=)/).find((part) => part.includes('data-job-id="a1"')) ??
        '';
      expect(row).not.toContain('truncate');
      expect(row).toContain('whitespace-normal');
    });

    it('has no pager, however many jobs there are', async () => {
      const many = Array.from({ length: 25 }, (_, index) =>
        job(`m${index}`, { name: `Many ${index}`, updatedAt: ago(index + 1) }),
      );
      const html = await render({ jobs: many, byClient: false });
      expect(rowTags(html)).toHaveLength(25);
      expect(html).not.toContain('Previous');
      expect(html).not.toContain('Next');
    });
  });

  describe('a row', () => {
    const rowOf = async (id: string, options?: Options) => {
      const html = await render({ byClient: false, ...options });
      const row = html
        .split(/(?=<li [^>]*data-job-id=)/)
        .find((part) => part.includes(`data-job-id="${id}"`));
      if (row === undefined) throw new Error(`no row ${id}`);
      return row;
    };

    it('is at least 58 px tall, on a grid of icon, job and a 44 px next step', async () => {
      const row = await rowOf('a1');
      expect(row).toContain('min-h-[58px]');
      expect(row).toContain('grid-cols-[24px_minmax(0,1fr)_44px]');
    });

    it('opens the job’s sheet from a button laid over it, named for screen readers', async () => {
      expect(await rowOf('a1')).toContain('aria-label="Open Spring promo"');
    });

    it('draws the job’s status icon', async () => {
      expect(await rowOf('a2')).toContain('data-status="failed"');
      expect(await rowOf('h1')).toContain('data-status="review"');
    });

    it('shows the note and effort marks after the name, and a Hebrew name in its own direction', async () => {
      const held = await rowOf('s1');
      expect(held).toContain('aria-label="Your note"');
      expect(held).toContain('aria-label="Effort: High"');
      const hebrew = await rowOf('h1');
      expect(hebrew).toMatch(/<span dir="auto" class="bidi[^"]*"[^>]*>מיתוס או אמת 6<\/span>/);
    });

    it('says the detail in red when the job failed', async () => {
      const failed = await rowOf('a2');
      expect(failed).toContain('text-status-failed-foreground');
      expect(failed).toContain('Failed at Render');
    });

    it('mutes the name of a paid video', async () => {
      const paid = await rowOf('a3', { showArchived: true });
      expect(paid).toMatch(
        /<span dir="auto" class="bidi[^"]*text-muted-foreground[^"]*"[^>]*>Old reel</,
      );
      expect(paid).toContain('Paid 14 Oct · ₪40');
    });

    it('fades an archived video to 55% and marks it with the box', async () => {
      const archived = await rowOf('a3', { showArchived: true });
      expect(archived).toMatch(/<li [^>]*data-archived=""/);
      expect(archived).toContain('group-data-[archived]/row:opacity-55');
      expect(archived).toContain('aria-label="Archived"');
    });

    it('offers the next step as a 44 px ghost button, with the Mac’s names', async () => {
      const label = async (id: string) =>
        (await rowOf(id)).match(/<button[^>]*data-slot="button"[^>]*aria-label="([^"]*)"/)?.[1];
      expect(await label('h2')).toBe('Mark paid…');
      expect(await label('a2')).toBe('Retry from Render');
      expect(await label('s1')).toBe('Release');
      const button = (await rowOf('h2')).match(/<button[^>]*aria-label="Mark paid…"[^>]*>/)?.[0];
      expect(button).toContain('size-11');
      expect(button).toContain('data-variant="ghost"');
    });

    it('offers Share on an approved video (Mobile 4), the lucide Share icon, never disabled', async () => {
      const approved = await rowOf('a1');
      const button = approved.match(/<button[^>]*aria-label="Share video"[^>]*>/)?.[0];
      expect(button).toContain('size-11');
      expect(button).toContain('data-variant="ghost"');
      expect(button).not.toMatch(/\sdisabled=""/);
      expect(approved).toContain('lucide-share');
      expect(approved).not.toContain('aria-label="Mark delivered"');
    });

    it('has the Play icon on a job in Review, and no next step on a paid one', async () => {
      const review = await rowOf('h1');
      const play = review.match(/<button[^>]*aria-label="Review"[^>]*>/)?.[0];
      expect(play).toContain('size-11');
      expect(play).toContain('data-variant="ghost"');
      expect(review).toContain('lucide-play');
      const paid = await rowOf('a3', { showArchived: true });
      expect(paid.match(/<button/g)).toHaveLength(1);
    });

    it('offers Play while a preview is available during rendering', async () => {
      const rendering = job('rendering', {
        state: 'editing',
        runKind: 'render',
        step: 8,
        preview: { durationSec: 30, width: 1080, height: 1920 },
      });
      const html = await render({ jobs: [rendering], byClient: false });
      expect(html).toContain('aria-label="View preview"');
      expect(html).toContain('lucide-play');
    });
  });

  describe('the archive line', () => {
    it('ends the list with "1 archived · Show" while Show archived is off', async () => {
      const html = await render();
      expect(html).not.toContain('data-job-id="a3"');
      expect(html).toContain('1 archived ·');
      expect(html).toMatch(/1 archived ·<button[^>]*>Show<\/button>/);
    });

    it('says "1 more archived · Show" under a search that found rows', async () => {
      const html = await render({ search: 'acme' });
      expect(idsOf(html)).toEqual(['a1', 'a2']);
      expect(html).toContain('1 more archived ·');
    });

    it('is gone with Show archived on', async () => {
      const html = await render({ showArchived: true });
      expect(html).not.toContain('archived ·');
      expect(html).toContain('data-job-id="a3"');
    });
  });

  describe('search', () => {
    it('is closed until the Search button is pressed', async () => {
      const html = await render();
      expect(html).not.toContain('type="search"');
      expect(html).toContain('aria-expanded="false"');
    });

    it('is open under the header when a search is kept: 40 px, 16 px text, direction by content', async () => {
      const html = await render({ search: 'spring' });
      const input = html.match(/<input[^>]*type="search"[^>]*>/)?.[0];
      expect(input).toBeDefined();
      expect(input).toContain('value="spring"');
      expect(input).toContain('dir="auto"');
      expect(input).toContain('h-10');
      expect(input).toContain('text-base');
      expect(html).toContain('Search jobs and clients</label>');
    });

    it('filters as the Mac does, in the name or the client, Hebrew too', async () => {
      expect(idsOf(await render({ search: 'spring' }))).toEqual(['a1']);
      expect(idsOf(await render({ search: 'RGM promo' }))).toEqual(['s1']);
      expect(idsOf(await render({ search: 'מיתוס' }))).toEqual(['h1', 'h2']);
    });
  });

  describe('when there is nothing to list', () => {
    it('says "No jobs match." for a tab or search that leaves none', async () => {
      const html = await render({ search: 'zzz' });
      expect(html).toContain('No jobs match.');
      expect(rowTags(html)).toHaveLength(0);
    });

    it('says "No jobs yet." for an empty list', async () => {
      expect(await render({ jobs: [] })).toContain('No jobs yet.');
    });

    it('says it cannot reach the engine before the first list', async () => {
      const html = await render({ jobs: null, failed: true });
      expect(html).toContain('Can&#x27;t reach the engine.');
      expect(html).toContain('Try again');
    });

    it('draws placeholder rows while the first list is on its way', async () => {
      const html = await render({ jobs: null });
      expect(html).toContain('Loading jobs…');
      expect(html.match(/data-skeleton-row/g)).toHaveLength(8);
    });
  });
});
