import type { Job, JobVersion } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/data/api';
import { jobVersionsKey } from '@/data/job-versions';
import { createTestQueryClient, makeJob, makeJobVersion } from '@/data/test-utils';
import { DROPDOWN_MENU_PARTS, RowMenuItemView } from '@/features/jobs/row-menu-views';
import { goBackItem, JobSheetVersions } from './JobSheetVersions';
import type { SheetVariant } from './sheet-variant';
import { versionRows } from './sheet-versions';

// 22 Oct 2026, 15:30 UTC.
const NOW = '2026-10-22T15:30:00.000Z';

const VERSIONS: JobVersion[] = [
  makeJobVersion(3, { current: true, createdAt: '2026-10-22T14:58:00.000Z', durationSec: 42 }),
  makeJobVersion(2, { createdAt: '2026-10-21T16:19:00.000Z', durationSec: 61 }),
  makeJobVersion(1, { createdAt: '2026-10-12T10:01:00.000Z', durationSec: 38 }),
];

const inReview = makeJob({ state: 'review', round: 2 });

interface Options {
  defaultOpen?: boolean;
  /** The versions in the cache; `undefined` leaves the query unanswered. */
  versions?: JobVersion[];
  variant?: SheetVariant;
  onView?: (version: JobVersion) => void;
  skeletonDelayMs?: number;
}

function render(job: Job, { versions, ...rest }: Options = {}) {
  const queryClient = createTestQueryClient();
  if (versions !== undefined) queryClient.setQueryData(jobVersionsKey(job.id), { versions });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <JobSheetVersions job={job} now={NOW} timeZone="UTC" {...rest} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The text of every row of the open list. */
function rowTexts(html: string): string[] {
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, inner = '']) =>
    // The Current / Approved badges and the buttons are not the row's words.
    inner
      .replace(/<button.*?<\/button>/g, '')
      .replace(/<span[^>]*data-slot="badge".*?<\/span>/g, '')
      .replace(/<[^>]*>/g, '')
      .trim(),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('<JobSheetVersions>: closed', () => {
  it('is a closed full-width ghost button with a chevron, like History', () => {
    const html = render(inReview, { versions: VERSIONS });
    expect(html).toContain('aria-label="Versions"');
    expect(html).toContain('data-section="versions"');
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*aria-expanded="false"/);
    expect(html).toContain('w-[calc(100%+1rem)]');
    expect(html).toContain('>Versions<');
    expect(html).toContain('lucide-chevron-down');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<li');
  });

  it('asks the engine for nothing until it is open', () => {
    const getJobVersions = vi.spyOn(api, 'getJobVersions');
    render(inReview);
    expect(getJobVersions).not.toHaveBeenCalled();
  });

  it('keeps the chevron still while closed, and turns it over (ease-in-out) when open', () => {
    const closed = render(inReview, { versions: VERSIONS });
    expect(closed).toContain('transition-transform');
    expect(closed).toContain('ease-in-out');
    expect(closed).not.toContain('rotate-180');
    const open = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(open).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(open).toContain('rotate-180');
  });

  it('is 30 px tall on the Mac and a 44 px touch target on the phone', () => {
    expect(render(inReview, { variant: 'mac' })).toContain('h-[30px]');
    const phone = render(inReview, { variant: 'phone' });
    expect(phone).toContain('h-11');
    expect(phone).not.toContain('h-[30px]');
  });
});

describe('<JobSheetVersions>: the list', () => {
  it('has a single-line row per version, newest first: "Cut 3 · today 14:58 · 0:42"', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(html).toContain('<ol');
    expect(rowTexts(html)).toEqual([
      'Cut 3 · today 14:58 · 0:42',
      'Cut 2 · yesterday 16:19 · 1:01',
      'Cut 1 · 12 Oct 10:01 · 0:38',
    ]);
    expect(html).toContain('truncate');
  });

  it('puts the Current badge on the current row only', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(html.match(/>Current</g)).toHaveLength(1);
    const currentRow = html.match(/<li[^>]*data-version="3"[^>]*>.*?<\/li>/)?.[0] ?? '';
    expect(currentRow).toContain('>Current<');
    expect(html).not.toContain('>Approved<');
  });

  it('adds the Approved badge to the current row once the job is approved', () => {
    const approved = makeJob({
      state: 'ready',
      round: 2,
      approvedAt: '2026-10-22T15:00:00.000Z',
    });
    const html = render(approved, { versions: VERSIONS, defaultOpen: true });
    const currentRow = html.match(/<li[^>]*data-version="3"[^>]*>.*?<\/li>/)?.[0] ?? '';
    expect(currentRow).toContain('>Current<');
    expect(currentRow).toContain('>Approved<');
    expect(html.match(/>Approved</g)).toHaveLength(1);
  });

  it('says there are none yet for a job from before versions', () => {
    const html = render(inReview, { versions: [], defaultOpen: true });
    expect(html).toContain('No versions yet');
    expect(html).not.toContain('<ol');
  });

  it('lists the versions so far for a job that is editing', () => {
    const editing = makeJob({ state: 'editing', round: 1 });
    const html = render(editing, { versions: VERSIONS.slice(1), defaultOpen: true });
    expect(rowTexts(html)).toHaveLength(2);
  });

  it('shows nothing, not even a skeleton, before the wait is long enough to see', () => {
    const html = render(inReview, { defaultOpen: true });
    expect(html).not.toContain('data-slot="versions-skeleton"');
    expect(html).not.toContain('No versions yet');
  });

  it('draws placeholder rows once the wait has lasted (no delay here)', () => {
    const html = render(inReview, { defaultOpen: true, skeletonDelayMs: 0 });
    expect(html).toContain('data-slot="versions-skeleton"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('<JobSheetVersions>: a row’s controls', () => {
  it('has a ⋯ button that shows on hover or focus, and no View until the viewer gives one', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(html.match(/aria-label="More · Cut \d"/g)).toHaveLength(3);
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
    expect(html).toContain('group-focus-within:opacity-100');
    expect(html).toContain('ease-in-out');
    expect(html).not.toContain('aria-label="View Cut');
  });

  it('has a ghost View icon button on each row when the viewer is given', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true, onView: () => {} });
    const views = html.match(/<button[^>]*aria-label="View Cut \d"[^>]*>/g) ?? [];
    expect(views).toHaveLength(3);
    for (const view of views) expect(view).toContain('data-variant="ghost"');
    expect(html).toContain('lucide-play');
  });

  it('is a menu button: the ⋯ opens a dropdown, closed until pressed, and the row takes a right-click', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    const more = html.match(/<button[^>]*aria-label="More · Cut 2"[^>]*>/)?.[0] ?? '';
    expect(more).toContain('aria-haspopup="menu"');
    expect(more).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).toContain('data-slot="context-menu-trigger"');
  });

  it('on the phone: a 48 px row, 44 px View and ⋯ that are always there, and no tooltip', () => {
    const html = render(inReview, {
      versions: VERSIONS,
      defaultOpen: true,
      variant: 'phone',
      onView: () => {},
    });
    expect(html.match(/<li[^>]*min-h-12/g)).toHaveLength(3);
    const views = html.match(/<button[^>]*aria-label="View Cut \d"[^>]*>/g) ?? [];
    expect(views).toHaveLength(3);
    for (const view of views) {
      expect(view).toContain('size-11');
      expect(view).not.toContain('data-slot="tooltip-trigger"');
    }
    const mores = html.match(/<button[^>]*aria-label="More · Cut \d"[^>]*>/g) ?? [];
    expect(mores).toHaveLength(3);
    for (const more of mores) {
      expect(more).toContain('size-11');
      expect(more).not.toContain('opacity-0');
    }
  });

  it('on the Mac: a 32 px row with a hover-only ⋯', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(html).toContain('min-h-8');
    expect(html).not.toContain('min-h-12');
  });

  it('uses no blue ring: the focus ring is the Button’s own neutral one', () => {
    const html = render(inReview, { versions: VERSIONS, defaultOpen: true });
    expect(html).not.toMatch(/ring-blue|ring-sky|ring-primary/);
  });
});

/** The "Go back to this version…" item of version `n`, drawn in an open menu as the ⋯ draws it. */
function goBackMenu(job: Job, n: number, onGoBack: (n: number) => void = () => {}): string {
  const row = versionRows(job, VERSIONS, NOW, 'UTC').find((candidate) => candidate.n === n);
  if (row === undefined) throw new Error(`no version ${n}`);
  return renderToStaticMarkup(
    <DropdownMenu.Root open>
      <DropdownMenu.Trigger>⋯</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <RowMenuItemView item={goBackItem(row, onGoBack)} parts={DROPDOWN_MENU_PARTS} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>,
  );
}

describe('<JobSheetVersions>: Go back to this version…', () => {
  it('is on for a cut that is not current while the job is in Review', () => {
    const html = goBackMenu(inReview, 2);
    expect(html).toContain('Go back to this version…');
    expect(html).not.toContain('data-disabled');
    expect(html).not.toContain('title=');
    expect(html).toContain('lucide-undo-2');
  });

  it('is off, with the reason as its tooltip, outside Review', () => {
    for (const state of ['editing', 'ready', 'failed', 'held', 'cancelled'] as const) {
      const html = goBackMenu(makeJob({ state }), 2);
      expect(html, state).toContain('data-disabled');
      expect(html, state).toContain('title="Only a job in Review can go back to an earlier cut."');
      // The default cursor, and the pointer so the tooltip can show.
      expect(html, state).toContain('data-[disabled]:pointer-events-auto');
    }
  });

  it('is off for an archived job, and says so', () => {
    const archived = makeJob({ state: 'review', archivedAt: '2026-10-22T10:00:00.000Z' });
    expect(goBackMenu(archived, 2)).toContain(
      'title="An archived job cannot go back to an earlier cut."',
    );
  });

  it('is off on the current cut', () => {
    const html = goBackMenu(inReview, 3);
    expect(html).toContain('data-disabled');
    expect(html).toContain('title="This is the current cut"');
  });

  it('asks which cut when chosen', () => {
    const chosen: number[] = [];
    const row = versionRows(inReview, VERSIONS, NOW, 'UTC')[1];
    if (row === undefined) throw new Error('no row');
    goBackItem(row, (n) => chosen.push(n)).onSelect();
    expect(chosen).toEqual([2]);
  });
});
