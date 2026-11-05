// A job's menu is drawn from one list of entries (`rowMenuEntries`) in two places: the row's
// right-click menu and the job sheet's ⋯ menu. These tests draw the ⋯ menu (the DropdownMenu
// pieces, opened) for jobs of every kind and check it holds exactly what the row's menu does,
// item for item: the same words, lines, submenus and disabled states.

import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { jobSheetJobs } from '@/features/job-sheet/test-fixtures';
import type { RowActions } from './cells/use-row-actions';
import { type JobMenuEntry, rowMenuEntries } from './row-menu';
import { DROPDOWN_MENU_PARTS, RowMenuEntries } from './row-menu-views';

const actions: RowActions = {
  run: () => {},
  setEffort: () => {},
  setReviewEffort: () => {},
  archive: () => {},
  unarchive: () => {},
  archiveAllPaid: () => {},
  busy: false,
  refusal: null,
  dismissRefusal: () => {},
};

/** A second paid job, so a paid job's menu offers "Archive all paid · 2". */
const OTHER_PAID: Job = { ...jobSheetJobs.paid, id: 'other-paid', name: 'עוד אחד' };

const JOBS: readonly Job[] = [
  jobSheetJobs.review,
  jobSheetJobs.failed,
  jobSheetJobs.approved,
  jobSheetJobs.paid,
  OTHER_PAID,
];

/** The ⋯ menu of `job`, open, as the sheet draws it (its content is not portaled here). */
function sheetMenu(job: Job): string {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, JOBS);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DropdownMenu.Root open>
        <DropdownMenu.Trigger>⋯</DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <RowMenuEntries job={job} actions={actions} parts={DROPDOWN_MENU_PARTS} />
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </QueryClientProvider>,
  );
}

/** What the menu is made of, in order: items and submenus with their words and state, and the lines. */
interface Drawn {
  text: string;
  kind: 'item' | 'submenu' | 'line';
  disabled: boolean;
}

function drawn(markup: string): Drawn[] {
  const entries = markup.matchAll(
    /<(?:div|a)\b[^>]*data-slot="dropdown-menu-(item|separator|sub-trigger)"[^>]*>(.*?)(?=<(?:div|a)\b[^>]*data-slot="dropdown-menu-|$)/gs,
  );
  return [...entries].map((match) => {
    const [whole = '', kind = '', inner = ''] = match;
    const opening = whole.slice(0, whole.indexOf('>') + 1);
    return {
      kind: kind === 'separator' ? 'line' : kind === 'item' ? 'item' : 'submenu',
      text: inner
        .replace(/<[^>]*>/g, '')
        .replace(/&#x27;|&#39;/g, "'")
        .trim(),
      disabled: opening.includes('data-disabled'),
    };
  });
}

/** The same, from the entries the row's own menu is drawn from. */
function expected(job: Job): Drawn[] {
  const archive = {
    paidIds: JOBS.filter((j) => j.delivery?.paidOn != null && j.archivedAt === null).map(
      (j) => j.id,
    ),
  };
  const entries: JobMenuEntry[] = rowMenuEntries(job, actions, null, undefined, archive);
  return entries.map((entry) => {
    if (entry.type === 'separator') return { kind: 'line', text: '', disabled: false };
    if (entry.type === 'submenu') {
      return {
        kind: 'submenu',
        text: `${entry.label}${entry.trailing ?? ''}`,
        disabled: entry.disabled === true,
      };
    }
    return { kind: 'item', text: entry.label, disabled: entry.disabled === true };
  });
}

describe('the job sheet’s ⋯ menu', () => {
  const CASES = [
    ['a review job', jobSheetJobs.review],
    ['a failed job', jobSheetJobs.failed],
    ['an approved job', jobSheetJobs.approved],
    ['a paid job', jobSheetJobs.paid],
    ['an archived job', jobSheetJobs.archived],
    ['a queued job', jobSheetJobs.queued],
    ['an editing job', jobSheetJobs.editing],
    ['a delivered job', jobSheetJobs.delivered],
  ] as const;

  for (const [name, job] of CASES) {
    it(`has exactly the row menu’s items for ${name}`, () => {
      expect(drawn(sheetMenu(job))).toEqual(expected(job));
    });
  }

  it('has the review job’s Review…, then its note and Effort ▸, both disabled in review', () => {
    const menu = drawn(sheetMenu(jobSheetJobs.review));
    expect(menu[0]).toEqual({ kind: 'item', text: 'Review…', disabled: false });
    expect(menu.map((entry) => entry.text)).toContain('Edit note…');
    expect(menu.find((entry) => entry.kind === 'submenu')).toMatchObject({ text: 'Effort' });
  });

  it('has Retry and Copy error for a failed job, and Archive last, after a line', () => {
    const menu = drawn(sheetMenu(jobSheetJobs.failed));
    const words = menu.map((entry) => entry.text);
    expect(words.some((word) => word.startsWith('Retry from'))).toBe(true);
    expect(words).toContain('Copy error');
    expect(menu.at(-1)).toMatchObject({ text: 'Archive', kind: 'item' });
    expect(menu.at(-2)).toMatchObject({ kind: 'line' });
  });

  it('has Use this look for the approved job’s client, in the client’s own words', () => {
    const menu = drawn(sheetMenu(jobSheetJobs.approved));
    expect(menu.map((entry) => entry.text)).toContain(
      `Use this look for ${jobSheetJobs.approved.client}…`,
    );
  });

  it('has Archive all paid · 2 for a paid job when another job is paid too', () => {
    const words = drawn(sheetMenu(jobSheetJobs.paid)).map((entry) => entry.text);
    expect(words).toContain('Archive all paid · 2');
    expect(words).toContain('Not paid yet');
  });

  it('has Unarchive in place of Archive for an archived job', () => {
    const words = drawn(sheetMenu(jobSheetJobs.archived)).map((entry) => entry.text);
    expect(words).toContain('Unarchive');
    expect(words).not.toContain('Archive');
  });

  it('draws the lines of the row’s menu, and none at its start or end', () => {
    for (const [, job] of CASES) {
      const menu = drawn(sheetMenu(job));
      expect(menu[0]?.kind).not.toBe('line');
      expect(menu.at(-1)?.kind).not.toBe('line');
      for (const [i, entry] of menu.entries()) {
        if (entry.kind === 'line') expect(menu[i + 1]?.kind).not.toBe('line');
      }
    }
  });

  it('draws it with the dropdown’s items, not the right-click menu’s', () => {
    const markup = sheetMenu(jobSheetJobs.review);
    expect(markup).toContain('data-slot="dropdown-menu-item"');
    expect(markup).not.toContain('context-menu');
  });
});

// Team plan, TM4: the menu of an editor has no money items, no "Archive all paid" and no Delete….
describe('the row menu for the admin and for an editor', () => {
  function rowMenu(job: Job, editor: boolean): string {
    const queryClient = editor ? createEditorQueryClient() : createTestQueryClient();
    queryClient.setQueryData(JOBS_KEY, JOBS);
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <DropdownMenu.Root open>
          <DropdownMenu.Trigger>⋯</DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <RowMenuEntries job={job} actions={actions} parts={DROPDOWN_MENU_PARTS} withDelete />
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </QueryClientProvider>,
    );
  }

  it('gives the admin Not paid yet, Archive all paid · 2 and Delete… on a paid job', () => {
    const texts = drawn(rowMenu(jobSheetJobs.paid, false)).map((entry) => entry.text);
    expect(texts).toEqual(expect.arrayContaining(['Not paid yet', 'Archive all paid · 2']));
    expect(texts.at(-1)).toBe('Delete…');
  });

  it('gives an editor none of the three, and Archive and Download MP4 stay', () => {
    const texts = drawn(rowMenu(jobSheetJobs.paid, true)).map((entry) => entry.text);
    expect(texts.join('|')).not.toMatch(/Not paid yet|Archive all paid|Delete/);
    expect(texts).toEqual(expect.arrayContaining(['Archive', 'Download MP4']));
  });

  it('gives an editor no Mark delivered on an approved job', () => {
    expect(drawn(rowMenu(jobSheetJobs.approved, false)).map((e) => e.text)).toContain(
      'Mark delivered',
    );
    expect(
      drawn(rowMenu(jobSheetJobs.approved, true))
        .map((e) => e.text)
        .join('|'),
    ).not.toContain('Mark delivered');
  });
});
