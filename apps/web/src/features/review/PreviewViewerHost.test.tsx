import type { JobVersion } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { jobVersionsKey } from '@/data/job-versions';
import { createTestQueryClient, makeJobVersion } from '@/data/test-utils';
import { jobSheetJobs } from '@/features/job-sheet/test-fixtures';
import { renderReview } from './test-helpers';

vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = { open?: boolean; children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', null, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
  };
});
vi.mock('./music/SwapPlayer', async () => {
  const { createElement: h } = await import('react');
  return {
    SwapPlayer: ({ src, videoWidth }: { src: string; videoWidth: number }) =>
      h('div', { 'data-player': '', 'data-src': src, 'data-width': videoWidth }),
  };
});
vi.mock('./music/use-review-music', () => ({
  useReviewMusic: () => ({ rev: undefined, settling: false }),
}));

const { PreviewViewerHost } = await import('./PreviewViewerHost');
const { createPreviewViewerStore } = await import('./preview-viewer');

describe('<PreviewViewerHost>', () => {
  it('plays an existing preview outside Review without review actions', () => {
    const job = jobSheetJobs.rendering;
    const store = createPreviewViewerStore({ jobId: job.id, session: 1 });
    const html = renderReview(<PreviewViewerHost jobs={[job]} store={store} />);
    expect(html).toContain('data-player=""');
    expect(html).toContain('Close preview');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Send notes');
  });

  it('shows nothing when the job has no preview', () => {
    const job = jobSheetJobs.editing;
    const store = createPreviewViewerStore({ jobId: job.id, session: 1 });
    expect(renderReview(<PreviewViewerHost jobs={[job]} store={store} />)).toBe('');
  });
});

// The cut on show (Plane VE3): Cut 3 is the current one, Cut 2 an earlier one with its own size.
const VERSIONS: JobVersion[] = [
  makeJobVersion(3, { current: true, round: 2 }),
  makeJobVersion(2, { round: 1, width: 1920, height: 1080 }),
  makeJobVersion(1),
];

/** The viewer of `job` on cut `version`, with the job's versions in the cache. */
function viewVersion(
  job: (typeof jobSheetJobs)[keyof typeof jobSheetJobs],
  version: number | null,
  versions: JobVersion[] | null = VERSIONS,
) {
  const queryClient = createTestQueryClient();
  if (versions !== null) queryClient.setQueryData(jobVersionsKey(job.id), { versions });
  const store = createPreviewViewerStore({ jobId: job.id, version, session: 1 });
  return renderReview(<PreviewViewerHost jobs={[job]} store={store} />, queryClient);
}

describe('the preview viewer’s store', () => {
  it('opens on the live preview, or on a cut; each open is a new session', () => {
    const store = createPreviewViewerStore();
    store.getState().open('a1');
    expect(store.getState()).toMatchObject({ jobId: 'a1', version: null, session: 1 });
    store.getState().open('a1', 2);
    expect(store.getState()).toMatchObject({ jobId: 'a1', version: 2, session: 2 });
    store.getState().close();
    expect(store.getState().jobId).toBeNull();
    store.getState().reset();
    expect(store.getState().version).toBeNull();
  });
});

describe('<PreviewViewerHost phone>: an earlier cut', () => {
  const job = jobSheetJobs.review;

  function viewOnPhone(version: number | null) {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(jobVersionsKey(job.id), { versions: VERSIONS });
    const store = createPreviewViewerStore({ jobId: job.id, version, session: 1 });
    return renderReview(<PreviewViewerHost jobs={[job]} store={store} phone />, queryClient);
  }

  it('plays the version’s own composition, with a 44 px Close', () => {
    const html = viewOnPhone(2);
    expect(html).toContain(`data-src="/api/jobs/${job.id}/versions/2/preview/index.html"`);
    expect(html).toMatch(/<button[^>]*\bsize-11\b[^>]*aria-label="Close preview"/);
  });

  it('has a full-width 44 px Go back to this version in a footer that clears the home indicator', () => {
    const html = viewOnPhone(2);
    const footer = html.match(/<footer[^>]*data-preview-viewer-footer[^>]*>/)?.[0] ?? '';
    expect(footer).toContain('var(--safe-bottom');
    expect(html).toMatch(
      /<button[^>]*\bh-11 w-full\b[^>]*>(?:(?!<\/button>).)*Go back to this version/,
    );
  });
});

describe('<PreviewViewerHost>: an earlier cut', () => {
  const job = jobSheetJobs.review;

  it('plays the version’s own composition (its music.mp3 loads from the same folder) and its size', () => {
    const html = viewVersion(job, 2);
    expect(html).toContain(`data-src="/api/jobs/${job.id}/versions/2/preview/index.html"`);
    expect(html).toContain('data-width="1920"');
  });

  it('says which cut it is in the title and in the description, the job’s name first', () => {
    const html = viewVersion(job, 2);
    expect(html).toMatch(/<h2>[^<]*סיור בפרויקט<span[^>]*> · Cut 2<\/span><\/h2>/);
    expect(html).toContain('Watch Cut 2 of this job');
  });

  it('has one Go back to this version button in its footer for a job in Review', () => {
    const html = viewVersion(job, 2);
    expect(html).toContain('data-preview-viewer-footer=""');
    expect(html.match(/Go back to this version/g)).toHaveLength(1);
    expect(html).toContain('lucide-undo-2');
  });

  it('has no Go back for a job that is not in Review: the cut is for looking at', () => {
    const rendering = jobSheetJobs.rendering;
    const html = viewVersion(rendering, 2);
    expect(html).toContain('data-src="/api/jobs/a912d4e4956f/versions/2/preview/index.html"');
    expect(html).not.toContain('Go back to this version');
    expect(html).not.toContain('data-preview-viewer-footer');
  });

  it('has no Go back for an archived job in Review', () => {
    const html = viewVersion({ ...job, archivedAt: '2026-10-22T09:00:00.000Z' }, 2);
    expect(html).not.toContain('Go back to this version');
  });

  it('shows the current cut like the normal preview: the live URL, no Go back', () => {
    const html = viewVersion(job, 3);
    expect(html).toContain(`data-src="/api/jobs/${job.id}/preview/index.html?r=${job.round}"`);
    expect(html).not.toContain('Go back to this version');
  });

  it('waits for the versions before it loads anything, so the live cut is not played first', () => {
    const html = viewVersion(job, 2, null);
    expect(html).not.toContain('data-player');
    expect(html).toContain('Close preview');
  });

  it('is the normal viewer, with no cut in the title and no footer, when no version is asked for', () => {
    const html = viewVersion(job, null);
    expect(html).toContain(`data-src="/api/jobs/${job.id}/preview/index.html?r=${job.round}"`);
    expect(html).not.toContain(' · Cut');
    expect(html).not.toContain('data-preview-viewer-footer');
  });
});
