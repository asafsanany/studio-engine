import type { Job, JobVersion, MusicView } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import {
  createEditorQueryClient,
  createTestQueryClient,
  makeJobVersion,
  makeMusicView,
  makeSeriesSummary,
} from '@/data/test-utils';
import { type RowActions, useRowActionsContext } from '@/features/jobs/cells/use-row-actions';
import { previewViewerStore } from '@/features/review/preview-viewer';
import { JobPanelTools, revealLabel } from './JobPanelTools';
import { JobRowPanel } from './JobRowPanel';
import { jobSheetJobs } from './test-fixtures';

// The parts are other items' files; here they only say where they are and whether the panel gave
// them the job's actions.
vi.mock('./JobSheetNow', () => ({
  JobSheetNow: () => (
    <i data-section={`now-${useRowActionsContext() === null ? 'bare' : 'actions'}`} />
  ),
}));
vi.mock('./JobSheetSteps', () => ({ JobSheetSteps: () => <i data-section="steps" /> }));
vi.mock('./JobSheetNotes', () => ({ JobSheetNotes: () => <i data-section="notes" /> }));
vi.mock('./JobSheetDetails', () => ({
  JobSheetDetails: ({ music }: { music?: MusicView | null }) => (
    <i data-section="details" data-music={music ? music.picked : 'none'} />
  ),
}));
// The View button of a Versions row is the part's; here the panel's `onView` is kept to be pressed.
const viewing = vi.hoisted(() => ({
  onView: undefined as ((version: JobVersion) => void) | undefined,
}));
vi.mock('./JobSheetVersions', () => ({
  JobSheetVersions: ({ onView }: { onView?: (version: JobVersion) => void }) => {
    viewing.onView = onView;
    return <i data-section="versions" />;
  },
}));
vi.mock('./JobSheetHistory', () => ({ JobSheetHistory: () => <i data-section="history" /> }));

interface Options {
  /** Where the router stands. */
  path?: string;
  series?: boolean;
  /** The job's music in the query cache, with the Soundtrack switch on. */
  music?: MusicView | null;
  /** The viewer is an editor (Team plan), not the admin. */
  editor?: boolean;
}

/** `node` on a page of the app (the parts' links need one), in the list's tooltip provider. */
async function onPage(
  node: ReactNode,
  { path = '/jobs', series = false, music, editor = false }: Options = {},
) {
  const queryClient = editor ? createEditorQueryClient() : createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.0.0',
    settleMs: 60_000,
    series,
    jobSheet: true,
    music: music !== undefined,
  });
  if (music !== undefined) {
    queryClient.setQueryData(musicKey(jobSheetJobs.review.id), music);
  }
  if (series) {
    queryClient.setQueryData(clientSeriesKey(jobSheetJobs.editing.clientId), [makeSeriesSummary()]);
  }
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/jobs', '/clients/$clientId', '/clients/$clientId/series/$seriesId'].map((routePath) =>
        createRoute({ getParentRoute: () => rootRoute, path: routePath }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The row's set of requests, as the row hands it to the panel; the parts only pass it on here. */
const ACTIONS = { pending: null } as unknown as RowActions;

const panelOf = (job: Job, options?: Options) =>
  onPage(<JobRowPanel job={job} actions={ACTIONS} />, options);

/** The attribute of the first element of the markup that has `attr`'s value. */
const tag = (markup: string, needle: string) =>
  markup.match(new RegExp(`<[^>]*${needle}[^>]*>`))?.[0] ?? '';

describe('<JobRowPanel>: the tools', () => {
  it('has Show in Finder and ⋯, at the top right', async () => {
    const markup = await panelOf(jobSheetJobs.review);
    const labels = [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels).toEqual([jobSheetJobs.review.name, 'Show the folder in Finder', 'More actions']);
    expect(markup).toContain('absolute -top-1 right-0');
  });

  it('has no ↑ ↓, no × and no status: the row above says the status, and a click on it closes', async () => {
    const markup = await panelOf(jobSheetJobs.review);
    expect(markup).not.toContain('Previous job');
    expect(markup).not.toContain('Next job');
    expect(markup).not.toContain('aria-label="Close"');
    expect(markup).not.toContain('job-sheet-status');
  });

  it('shows the MP4 in Finder once the job has an output and the folder before', () => {
    expect(revealLabel(jobSheetJobs.approved)).toBe('Show the MP4 in Finder');
    expect(revealLabel(jobSheetJobs.paid)).toBe('Show the MP4 in Finder');
    for (const state of ['arriving', 'queued', 'editing', 'failed', 'review'] as const) {
      expect(revealLabel(jobSheetJobs[state]), state).toBe('Show the folder in Finder');
    }
  });

  it('puts the same words on the button and in its tooltip', async () => {
    const approved = await panelOf(jobSheetJobs.approved);
    expect(approved).toContain('aria-label="Show the MP4 in Finder"');
    const failed = await panelOf(jobSheetJobs.failed);
    expect(failed).toContain('aria-label="Show the folder in Finder"');
  });

  it('has no Show in Finder for an editor (Finder is the Mac’s), and keeps ⋯', async () => {
    const markup = await onPage(<JobPanelTools job={jobSheetJobs.approved} actions={ACTIONS} />, {
      editor: true,
    });
    expect(markup).not.toContain('in Finder');
    expect([...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'More actions',
    ]);
  });

  it('has no Show in Finder for a video whose folder was deleted, and keeps ⋯', async () => {
    const orphan = { ...jobSheetJobs.delivered, folderDeleted: true } as Job;
    const markup = await panelOf(orphan);
    expect(markup).not.toContain('in Finder');
    expect(markup).toContain('aria-label="More actions"');
  });

  it('is a menu button: the ⋯ button opens the row’s menu (a dropdown menu, closed until pressed)', async () => {
    const markup = await panelOf(jobSheetJobs.approved);
    const more = tag(markup, 'aria-label="More actions"');
    expect(more).toContain('aria-haspopup="menu"');
    expect(more).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="menu"');
  });

  it('shows no keyboard shortcut anywhere', async () => {
    const markup = await panelOf(jobSheetJobs.review);
    expect(markup).not.toMatch(/\bJ\b|\bK\b|⌘|⇧|kbd|shortcut/);
  });
});

describe('<JobRowPanel>: the parts', () => {
  const sections = (markup: string) =>
    [...markup.matchAll(/data-section="([^"]*)"/g)].map((m) => m[1]);
  const column = (markup: string, slot: string) =>
    markup.slice(markup.indexOf(`data-slot="${slot}"`));

  it('is a region named by the job, with no title of its own: the row above has the name', async () => {
    const markup = await panelOf(jobSheetJobs.review);
    expect(tag(markup, 'data-slot="job-row-panel"')).toMatch(/^<section [^>]*aria-label="/);
    expect(markup).not.toContain('<h2');
  });

  it('puts Now, Steps and Notes on the left, and Details, Versions and History on the right', async () => {
    const markup = await panelOf(jobSheetJobs.review);
    expect(sections(markup)).toEqual([
      'now-actions',
      'steps',
      'notes',
      'details',
      'versions',
      'history',
    ]);
    const left = column(markup, 'job-row-panel-now');
    const right = column(markup, 'job-row-panel-about');
    expect(sections(left.slice(0, left.indexOf('job-row-panel-about')))).toEqual([
      'now-actions',
      'steps',
      'notes',
    ]);
    expect(sections(right)).toEqual(['details', 'versions', 'history']);
  });

  it('is two columns from 1024 px up and one below, fading in over 200 ms with ease-in-out', async () => {
    const panel = tag(await panelOf(jobSheetJobs.review), 'data-slot="job-row-panel"');
    expect(panel).toContain('grid-cols-1');
    expect(panel).toContain('lg:grid-cols-2');
    expect(panel).toContain('duration-200');
    expect(panel).toContain('ease-in-out');
  });

  it('gives Details the job’s music, for its Music row, while Soundtrack is on', async () => {
    const markup = await panelOf(jobSheetJobs.review, { music: makeMusicView({ picked: 'v1' }) });
    expect(tag(markup, 'data-section="details"')).toContain('data-music="v1"');
    expect(
      tag(await panelOf(jobSheetJobs.review, { music: null }), 'data-section="details"'),
    ).toContain('data-music="none"');
    expect(tag(await panelOf(jobSheetJobs.review), 'data-section="details"')).toContain(
      'data-music="none"',
    );
  });

  it('leaves Versions out for a video whose folder was deleted, and keeps the rest', async () => {
    const orphan = { ...jobSheetJobs.delivered, folderDeleted: true } as Job;
    const order = sections(await panelOf(orphan));
    expect(order).not.toContain('versions');
    expect(order).toContain('history');
  });

  it('opens the preview viewer on a cut when Versions’ View is pressed, and on the live preview for the current cut', async () => {
    const job = jobSheetJobs.review;
    await panelOf(job);
    previewViewerStore.getState().reset();
    viewing.onView?.(makeJobVersion(2));
    expect(previewViewerStore.getState()).toMatchObject({ jobId: job.id, version: 2 });
    viewing.onView?.(makeJobVersion(3, { current: true }));
    expect(previewViewerStore.getState()).toMatchObject({ jobId: job.id, version: null });
    previewViewerStore.getState().reset();
  });

  it('gives the parts the row’s actions, shared through the row actions context', async () => {
    expect(await panelOf(jobSheetJobs.failed)).toContain('data-section="now-actions"');
  });
});
